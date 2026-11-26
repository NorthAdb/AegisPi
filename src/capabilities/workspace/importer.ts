import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { mintId } from "../../governance/canonical.ts";
import { withImmediateTx, writeAuditEvent } from "../../governance/db.ts";
import {
  checkSourceReadAuthorized,
  listConversationSources,
  recordConversationSource,
} from "../../governance/policy.ts";
import {
  exportRegularFilesFromVolumeReadOnly,
  verifyAllVolumeWritersExited,
  type VolumeWriterCheck,
} from "./docker-sandbox.ts";
import { validateAndResolveWorkspacePath } from "./path-jail.ts";

export interface ManagedFileImportRow {
  import_id: string;
  logical_key: string;
  runtime_epoch: string;
  conversation_id: string;
  principal_id: string;
  scope_id: string;
  target_rel_path: string;
  base_sha256: string | null;
  artifact_sha256: string;
  artifact_bytes: number;
  volume_name: string;
  container_id: string | null;
  state: "PREPARED" | "INSTALLED" | "CONFLICT_SAVED" | "REJECTED" | "PENDING_RECONCILE";
  conflict_rel_path: string | null;
  install_count: number;
  reason: string | null;
  parent_source_ids_json: string;
  created_at: number;
  updated_at: number;
}

export interface ManagedImportOutcome {
  ok: boolean;
  code: string;
  message: string;
  importId: string;
  state: ManagedFileImportRow["state"];
  targetRelPath: string;
  baseSha256: string | null;
  currentTargetSha256Before: string | null;
  currentTargetSha256After: string | null;
  artifactSha256: string | null;
  conflictRelPath: string | null;
  installCount: number;
  writerCheck?: VolumeWriterCheck;
}

export function sha256FileIfExists(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  const buf = readFileSync(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

function writeFileAtomically(targetAbsPath: string, bytes: Buffer): void {
  const dir = path.dirname(targetAbsPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.aegis-tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetAbsPath);
}

function buildConflictRelPath(normalizedRelPath: string, importId: string): string {
  const ext = path.posix.extname(normalizedRelPath);
  const base = ext ? normalizedRelPath.slice(0, -ext.length) : normalizedRelPath;
  const shortId = importId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-10);
  return `${base}.conflict-${shortId}${ext}`;
}

export class ManagedWorkspaceImporter {
  readonly #workspaceRoot: string;
  readonly #targetLocks = new Map<string, Promise<unknown>>();

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = path.resolve(workspaceRoot);
    mkdirSync(this.#workspaceRoot, { recursive: true });
  }

  get workspaceRoot(): string {
    return this.#workspaceRoot;
  }

  async #withTargetLock<T>(normalizedRelPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#targetLocks.get(normalizedRelPath) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    this.#targetLocks.set(normalizedRelPath, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#targetLocks.get(normalizedRelPath) === chained) {
        this.#targetLocks.delete(normalizedRelPath);
      }
    }
  }

  /**
   * Imports a verified regular file from a zero-network Docker task volume into the host's
   * authoritative workspace under serialized per-target checking, Tier 1 write grant verification,
   * writer-exit proof, conflict preservation, and crash-after-install idempotent reconciliation.
   */
  async importFileFromTaskVolume(params: {
    govDb: DatabaseSync;
    runtimeEpoch: string;
    conversationId: string;
    principalId: string;
    scopeId: string;
    logicalKey: string;
    volumeName: string;
    containerId?: string | null;
    targetRelPath: string;
    /** Base target SHA-256 captured at task snapshot time; null means target did NOT exist at snapshot time. */
    baseSha256: string | null;
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    now?: number;
    /** Test seam for V03: simulates process crash strictly AFTER atomic file install and BEFORE gov receipt commit! */
    onAfterAtomicInstallBeforeReceipt?: (info: { importId: string; targetAbsPath: string; artifactSha256: string }) => void;
  }): Promise<ManagedImportOutcome> {
    const now = params.now ?? Date.now();
    const pathCheck = validateAndResolveWorkspacePath(this.#workspaceRoot, params.targetRelPath);
    if (!pathCheck.ok) {
      const importId = mintId("imp");
      this.#recordRejectedImport(params.govDb, {
        importId,
        logicalKey: `${params.logicalKey}:rej:${importId}`,
        runtimeEpoch: params.runtimeEpoch,
        conversationId: params.conversationId,
        principalId: params.principalId,
        scopeId: params.scopeId,
        targetRelPath: params.targetRelPath,
        baseSha256: params.baseSha256,
        volumeName: params.volumeName,
        containerId: params.containerId ?? null,
        reason: `${pathCheck.code}: ${pathCheck.reason}`,
        now,
      });
      return {
        ok: false,
        code: pathCheck.code,
        message: pathCheck.reason,
        importId,
        state: "REJECTED",
        targetRelPath: params.targetRelPath,
        baseSha256: params.baseSha256,
        currentTargetSha256Before: null,
        currentTargetSha256After: null,
        artifactSha256: null,
        conflictRelPath: null,
        installCount: 0,
      };
    }

    const { normalizedRelPath, absolutePath } = pathCheck;

    return await this.#withTargetLock(normalizedRelPath, async () => {
      const beforeSha = sha256FileIfExists(absolutePath);

      // 0. Check idempotent retry / crash-after-install recovery FIRST for existing logicalKey!
      const existing = params.govDb
        .prepare("SELECT * FROM managed_file_imports WHERE logical_key = ?")
        .get(params.logicalKey) as ManagedFileImportRow | undefined;

      if (existing) {
        if (existing.state === "INSTALLED") {
          return {
            ok: true,
            code: "idempotent_already_installed",
            message: `Logical import ${params.logicalKey} already installed`,
            importId: existing.import_id,
            state: "INSTALLED",
            targetRelPath: existing.target_rel_path,
            baseSha256: existing.base_sha256,
            currentTargetSha256Before: beforeSha,
            currentTargetSha256After: beforeSha,
            artifactSha256: existing.artifact_sha256,
            conflictRelPath: existing.conflict_rel_path,
            installCount: existing.install_count,
          };
        }
        if (existing.state === "PREPARED") {
          // Crash happened after PREPARED was persisted (possibly after atomic rename, before receipt commit!)
          if (beforeSha !== null && beforeSha === existing.artifact_sha256) {
            // Provably already installed with exact artifact digest -> backfill receipt WITHOUT rewriting disk!
            withImmediateTx(params.govDb, () => {
              params.govDb
                .prepare(
                  `UPDATE managed_file_imports
                      SET state = 'INSTALLED',
                          install_count = CASE WHEN install_count < 1 THEN 1 ELSE install_count END,
                          reason = 'reconciled_installed_after_receipt_loss',
                          updated_at = ?
                    WHERE import_id = ? AND state = 'PREPARED'`,
                )
                .run(now, existing.import_id);
              writeAuditEvent(params.govDb, {
                entityType: "file_import",
                entityId: existing.import_id,
                eventKey: `reconcile_installed:${existing.import_id}`,
                eventType: "file_import_reconciled_installed",
                occurredAt: now,
                details: {
                  targetRelPath: existing.target_rel_path,
                  artifactSha256: existing.artifact_sha256,
                  rewrittenDisk: false,
                },
              });
            });
            const updated = params.govDb
              .prepare("SELECT * FROM managed_file_imports WHERE import_id = ?")
              .get(existing.import_id) as unknown as ManagedFileImportRow;
            return {
              ok: true,
              code: "reconciled_after_receipt_loss",
              message: "Verified installed artifact SHA-256 on disk; backfilled receipt without second write",
              importId: updated.import_id,
              state: "INSTALLED",
              targetRelPath: updated.target_rel_path,
              baseSha256: updated.base_sha256,
              currentTargetSha256Before: beforeSha,
              currentTargetSha256After: beforeSha,
              artifactSha256: updated.artifact_sha256,
              conflictRelPath: null,
              installCount: updated.install_count,
            };
          }
          if (beforeSha !== existing.base_sha256) {
            // Cannot prove installed state -> stop rewriting and mark PENDING_RECONCILE!
            withImmediateTx(params.govDb, () => {
              params.govDb
                .prepare(
                  `UPDATE managed_file_imports
                      SET state = 'PENDING_RECONCILE',
                          reason = 'unprovable_target_state_after_crash',
                          updated_at = ?
                    WHERE import_id = ?`,
                )
                .run(now, existing.import_id);
            });
            return {
              ok: false,
              code: "pending_reconcile",
              message: "Cannot prove prior install outcome; stopped rewriting target",
              importId: existing.import_id,
              state: "PENDING_RECONCILE",
              targetRelPath: existing.target_rel_path,
              baseSha256: existing.base_sha256,
              currentTargetSha256Before: beforeSha,
              currentTargetSha256After: beforeSha,
              artifactSha256: existing.artifact_sha256,
              conflictRelPath: null,
              installCount: existing.install_count,
            };
          }
        }
      }

      const importId = existing?.import_id ?? mintId("imp");

      // 1. Re-verify Tier 1 session write authorization for target relative path
      const writeAuth = checkSourceReadAuthorized(params.govDb, {
        principalId: params.principalId,
        scopeId: params.scopeId,
        sourceType: "workspace_write",
        resourceId: "workspace",
        operation: "write",
        path: normalizedRelPath,
      });
      if (!writeAuth.ok) {
        this.#recordRejectedImport(params.govDb, {
          importId,
          logicalKey: `${params.logicalKey}:denied:${importId}`,
          runtimeEpoch: params.runtimeEpoch,
          conversationId: params.conversationId,
          principalId: params.principalId,
          scopeId: params.scopeId,
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          volumeName: params.volumeName,
          containerId: params.containerId ?? null,
          reason: `${writeAuth.code}: ${writeAuth.reason}`,
          now,
        });
        return {
          ok: false,
          code: "workspace_write_denied",
          message: writeAuth.reason,
          importId,
          state: "REJECTED",
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          currentTargetSha256Before: beforeSha,
          currentTargetSha256After: sha256FileIfExists(absolutePath),
          artifactSha256: null,
          conflictRelPath: null,
          installCount: 0,
        };
      }

      // 2. Verify ALL writers on task volume have completely exited BEFORE opening read-only export!
      const writerCheck = verifyAllVolumeWritersExited(params.volumeName);
      if (!writerCheck.allExited) {
        const reason = `Active writers still attached to volume ${params.volumeName}: ${writerCheck.activeWriters.map((w) => `${w.name}(${w.state})`).join(",")}`;
        this.#recordRejectedImport(params.govDb, {
          importId,
          logicalKey: `${params.logicalKey}:writers:${importId}`,
          runtimeEpoch: params.runtimeEpoch,
          conversationId: params.conversationId,
          principalId: params.principalId,
          scopeId: params.scopeId,
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          volumeName: params.volumeName,
          containerId: params.containerId ?? null,
          reason,
          now,
        });
        return {
          ok: false,
          code: "active_volume_writers",
          message: reason,
          importId,
          state: "REJECTED",
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          currentTargetSha256Before: beforeSha,
          currentTargetSha256After: sha256FileIfExists(absolutePath),
          artifactSha256: null,
          conflictRelPath: null,
          installCount: 0,
          writerCheck,
        };
      }

      // 3. Controlled read-only export of verified regular file bytes from volume
      const exported = exportRegularFilesFromVolumeReadOnly({
        volumeName: params.volumeName,
        maxFiles: params.maxFiles,
        maxFileBytes: params.maxFileBytes,
        maxTotalBytes: params.maxTotalBytes,
      });
      if (!exported.ok) {
        this.#recordRejectedImport(params.govDb, {
          importId,
          logicalKey: `${params.logicalKey}:exp:${importId}`,
          runtimeEpoch: params.runtimeEpoch,
          conversationId: params.conversationId,
          principalId: params.principalId,
          scopeId: params.scopeId,
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          volumeName: params.volumeName,
          containerId: params.containerId ?? null,
          reason: `${exported.code}: ${exported.reason}`,
          now,
        });
        return {
          ok: false,
          code: exported.code,
          message: exported.reason,
          importId,
          state: "REJECTED",
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          currentTargetSha256Before: beforeSha,
          currentTargetSha256After: sha256FileIfExists(absolutePath),
          artifactSha256: null,
          conflictRelPath: null,
          installCount: 0,
          writerCheck,
        };
      }

      const targetFile = exported.files.find((f) => f.relPath === normalizedRelPath);
      if (!targetFile) {
        const reason = `Expected artifact '${normalizedRelPath}' not found in exported volume`;
        this.#recordRejectedImport(params.govDb, {
          importId,
          logicalKey: `${params.logicalKey}:missing:${importId}`,
          runtimeEpoch: params.runtimeEpoch,
          conversationId: params.conversationId,
          principalId: params.principalId,
          scopeId: params.scopeId,
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          volumeName: params.volumeName,
          containerId: params.containerId ?? null,
          reason,
          now,
        });
        return {
          ok: false,
          code: "artifact_missing",
          message: reason,
          importId,
          state: "REJECTED",
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          currentTargetSha256Before: beforeSha,
          currentTargetSha256After: sha256FileIfExists(absolutePath),
          artifactSha256: null,
          conflictRelPath: null,
          installCount: 0,
          writerCheck,
        };
      }

      // Collect parent conversation source IDs so report inherits ALL parent provenance permissions!
      const parentSources = listConversationSources(params.govDb, params.runtimeEpoch, params.conversationId);
      const parentSourceIds = parentSources.map((s) => s.record_id);

      // 4. Re-check current target version against baseSha256 (conflict detection!)
      const currentSha = sha256FileIfExists(absolutePath);
      if (currentSha !== params.baseSha256) {
        const conflictRel = buildConflictRelPath(normalizedRelPath, importId);
        const conflictCheck = validateAndResolveWorkspacePath(this.#workspaceRoot, conflictRel);
        if (!conflictCheck.ok) {
          throw new Error(`Invalid conflict path generated: ${conflictCheck.reason}`);
        }
        writeFileAtomically(conflictCheck.absolutePath, targetFile.bytes);

        withImmediateTx(params.govDb, () => {
          params.govDb
            .prepare(
              `INSERT INTO managed_file_imports(
                 import_id, logical_key, runtime_epoch, conversation_id, principal_id, scope_id,
                 target_rel_path, base_sha256, artifact_sha256, artifact_bytes, volume_name, container_id,
                 state, conflict_rel_path, install_count, reason, parent_source_ids_json, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFLICT_SAVED', ?, 0, ?, ?, ?, ?)
               ON CONFLICT(logical_key) DO UPDATE SET
                 state = 'CONFLICT_SAVED',
                 conflict_rel_path = excluded.conflict_rel_path,
                 reason = excluded.reason,
                 updated_at = excluded.updated_at`,
            )
            .run(
              importId,
              params.logicalKey,
              params.runtimeEpoch,
              params.conversationId,
              params.principalId,
              params.scopeId,
              normalizedRelPath,
              params.baseSha256,
              targetFile.sha256,
              targetFile.sizeBytes,
              params.volumeName,
              params.containerId ?? null,
              conflictCheck.normalizedRelPath,
              `version_conflict: expected_base=${params.baseSha256 ?? "absent"}, actual=${currentSha ?? "absent"}`,
              JSON.stringify(parentSourceIds),
              now,
              now,
            );
          writeAuditEvent(params.govDb, {
            entityType: "file_import",
            entityId: importId,
            eventKey: `conflict:${importId}`,
            eventType: "file_import_conflict_preserved",
            occurredAt: now,
            details: {
              targetRelPath: normalizedRelPath,
              conflictRelPath: conflictCheck.normalizedRelPath,
              baseSha256: params.baseSha256,
              userCurrentSha256: currentSha,
              candidateSha256: targetFile.sha256,
            },
          });
        });

        return {
          ok: false,
          code: "version_conflict",
          message: `Target ${normalizedRelPath} changed after snapshot; preserved user version and saved candidate to ${conflictCheck.normalizedRelPath}`,
          importId,
          state: "CONFLICT_SAVED",
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          currentTargetSha256Before: beforeSha,
          currentTargetSha256After: sha256FileIfExists(absolutePath),
          artifactSha256: targetFile.sha256,
          conflictRelPath: conflictCheck.normalizedRelPath,
          installCount: 0,
          writerCheck,
        };
      }

      // 5. Persist PREPARED durable intent BEFORE atomic install (enables crash-after-install recovery!)
      withImmediateTx(params.govDb, () => {
        params.govDb
          .prepare(
            `INSERT INTO managed_file_imports(
               import_id, logical_key, runtime_epoch, conversation_id, principal_id, scope_id,
               target_rel_path, base_sha256, artifact_sha256, artifact_bytes, volume_name, container_id,
               state, conflict_rel_path, install_count, reason, parent_source_ids_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', NULL, 0, NULL, ?, ?, ?)
             ON CONFLICT(logical_key) DO UPDATE SET
               artifact_sha256 = excluded.artifact_sha256,
               artifact_bytes = excluded.artifact_bytes,
               updated_at = excluded.updated_at`,
          )
          .run(
            importId,
            params.logicalKey,
            params.runtimeEpoch,
            params.conversationId,
            params.principalId,
            params.scopeId,
            normalizedRelPath,
            params.baseSha256,
            targetFile.sha256,
            targetFile.sizeBytes,
            params.volumeName,
            params.containerId ?? null,
            JSON.stringify(parentSourceIds),
            now,
            now,
          );
      });

      // 6. Atomic host workspace installation (temp file + fsync + rename)
      writeFileAtomically(absolutePath, targetFile.bytes);

      // Optional V03 test seam: crash right AFTER atomic install and BEFORE governance receipt commit!
      if (params.onAfterAtomicInstallBeforeReceipt) {
        params.onAfterAtomicInstallBeforeReceipt({
          importId,
          targetAbsPath: absolutePath,
          artifactSha256: targetFile.sha256,
        });
      }

      // 7. Commit durable INSTALLED receipt & record derived file provenance inheriting all parent sources!
      withImmediateTx(params.govDb, () => {
        params.govDb
          .prepare(
            `UPDATE managed_file_imports
                SET state = 'INSTALLED',
                    install_count = install_count + 1,
                    updated_at = ?
              WHERE import_id = ?`,
          )
          .run(now, importId);
        writeAuditEvent(params.govDb, {
          entityType: "file_import",
          entityId: importId,
          eventKey: `installed:${importId}`,
          eventType: "file_import_installed",
          occurredAt: now,
          details: {
            targetRelPath: normalizedRelPath,
            baseSha256: params.baseSha256,
            artifactSha256: targetFile.sha256,
            artifactBytes: targetFile.sizeBytes,
            volumeName: params.volumeName,
            parentSourceIds,
          },
        });
      });

      // Record report in conversation_sources inheriting parent source IDs
      recordConversationSource(params.govDb, {
        runtimeEpoch: params.runtimeEpoch,
        conversationId: params.conversationId,
        principalId: params.principalId,
        sourceType: "workspace_file",
        sourceId: `workspace:${normalizedRelPath}`,
        versionRef: `sha256:${targetFile.sha256.slice(0, 16)}`,
        title: normalizedRelPath,
        contentDigest: targetFile.sha256,
        metadata: { importId, bytes: targetFile.sizeBytes, volumeName: params.volumeName },
        parentSourceIds,
        now,
      });

      const finalRow = params.govDb
        .prepare("SELECT * FROM managed_file_imports WHERE import_id = ?")
        .get(importId) as unknown as ManagedFileImportRow;

      return {
        ok: true,
        code: "installed",
        message: `Installed ${normalizedRelPath} (${targetFile.sizeBytes} bytes, sha256=${targetFile.sha256.slice(0, 12)})`,
        importId,
        state: "INSTALLED",
        targetRelPath: normalizedRelPath,
        baseSha256: params.baseSha256,
        currentTargetSha256Before: beforeSha,
        currentTargetSha256After: sha256FileIfExists(absolutePath),
        artifactSha256: targetFile.sha256,
        conflictRelPath: null,
        installCount: finalRow.install_count,
        writerCheck,
      };
    });
  }

  #recordRejectedImport(
    govDb: DatabaseSync,
    params: {
      importId: string;
      logicalKey: string;
      runtimeEpoch: string;
      conversationId: string;
      principalId: string;
      scopeId: string;
      targetRelPath: string;
      baseSha256: string | null;
      volumeName: string;
      containerId: string | null;
      reason: string;
      now: number;
    },
  ): void {
    withImmediateTx(govDb, () => {
      govDb
        .prepare(
          `INSERT INTO managed_file_imports(
             import_id, logical_key, runtime_epoch, conversation_id, principal_id, scope_id,
             target_rel_path, base_sha256, artifact_sha256, artifact_bytes, volume_name, container_id,
             state, conflict_rel_path, install_count, reason, parent_source_ids_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, 'REJECTED', NULL, 0, ?, '[]', ?, ?)`,
        )
        .run(
          params.importId,
          params.logicalKey,
          params.runtimeEpoch,
          params.conversationId,
          params.principalId,
          params.scopeId,
          params.targetRelPath,
          params.baseSha256,
          params.volumeName,
          params.containerId,
          params.reason,
          params.now,
          params.now,
        );
      writeAuditEvent(govDb, {
        entityType: "file_import",
        entityId: params.importId,
        eventKey: `rejected:${params.importId}`,
        eventType: "file_import_rejected",
        occurredAt: params.now,
        details: {
          targetRelPath: params.targetRelPath,
          volumeName: params.volumeName,
          reason: params.reason,
        },
      });
    });
  }
}

export function listManagedFileImportsForConversation(
  db: DatabaseSync,
  runtimeEpoch: string,
  conversationIds: string | string[],
): ManagedFileImportRow[] {
  const ids = Array.isArray(conversationIds) ? conversationIds : [conversationIds];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM managed_file_imports
        WHERE runtime_epoch = ? AND conversation_id IN (${placeholders})
        ORDER BY created_at ASC`,
    )
    .all(runtimeEpoch, ...ids) as unknown as ManagedFileImportRow[];
}
