import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { mintId } from "../../governance/canonical.ts";
import { withImmediateTx, writeAuditEvent } from "../../governance/db.ts";
import {
  checkSourceReadAuthorized,
  listConversationSources,
  verifyAllConversationSourcesReadAuthorized,
} from "../../governance/policy.ts";
import {
  exportRegularFilesFromVolumeReadOnlyAsync,
  verifyAllVolumeWritersExitedAsync,
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
  exporterImageId?: string | null;
  writerCheck?: VolumeWriterCheck;
}

function insertWorkspaceFileSourceInTx(
  govDb: DatabaseSync,
  params: {
    runtimeEpoch: string;
    conversationId: string;
    principalId: string;
    normalizedRelPath: string;
    artifactSha256: string;
    artifactBytes: number;
    importId: string;
    volumeName: string;
    parentSourceIds: string[];
    now: number;
  },
): void {
  const sourceId = `workspace:${params.normalizedRelPath}`;
  const versionRef = `sha256:${params.artifactSha256.slice(0, 16)}`;
  const existing = govDb
    .prepare(
      `SELECT 1 AS ok FROM conversation_sources
        WHERE runtime_epoch = ? AND conversation_id = ? AND source_type = 'workspace_file' AND source_id = ? AND version_ref = ?`,
    )
    .get(params.runtimeEpoch, params.conversationId, sourceId, versionRef);
  if (existing) return;
  govDb
    .prepare(
      `INSERT INTO conversation_sources(
         record_id, runtime_epoch, conversation_id, principal_id,
         source_type, source_id, version_ref, title, content_digest,
         metadata_json, parent_source_ids_json, created_at
       ) VALUES (?, ?, ?, ?, 'workspace_file', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mintId("src"),
      params.runtimeEpoch,
      params.conversationId,
      params.principalId,
      sourceId,
      versionRef,
      params.normalizedRelPath,
      params.artifactSha256,
      JSON.stringify({
        importId: params.importId,
        bytes: params.artifactBytes,
        volumeName: params.volumeName,
      }),
      JSON.stringify(params.parentSourceIds),
      params.now,
    );
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

export interface TaskFrozenWorkspaceSnapshot {
  snapshotId: string;
  snapshotDir: string;
  baselines: Map<string, string | null>;
  getBaseline: (normalizedRelPath: string) => string | null;
  cleanup: () => void;
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

  /**
   * W2-S3: Host-side authoritative baseline capture at task/snapshot preparation time.
   * Model-supplied baseSha256 is NEVER trusted.
   */
  captureHostBaseline(targetRelPath: string): { ok: true; normalizedRelPath: string; baseSha256: string | null } | { ok: false; code: string; reason: string } {
    const check = validateAndResolveWorkspacePath(this.#workspaceRoot, targetRelPath);
    if (!check.ok) return check;
    return {
      ok: true,
      normalizedRelPath: check.normalizedRelPath,
      baseSha256: sha256FileIfExists(check.absolutePath),
    };
  }

  /**
   * W2-S3: Creates an isolated per-task frozen read-only input directory copy AND immutable
   * baseline SHA-256 map captured strictly at task snapshot time. Concurrent tasks targeting
   * the same file each hold their own frozen snapshot & baseline and never advance each other.
   */
  createTaskFrozenSnapshot(
    snapshotRootDir: string,
    extraTrackedRelPaths: string[] = [],
  ): TaskFrozenWorkspaceSnapshot {
    const snapshotId = `snap_${randomUUID().slice(0, 12)}`;
    const snapshotDir = path.join(path.resolve(snapshotRootDir), snapshotId);
    mkdirSync(snapshotDir, { recursive: true });
    const baselines = new Map<string, string | null>();

    const walkAndCopy = (srcDir: string, relPrefix: string): void => {
      if (!existsSync(srcDir)) return;
      const entries = readdirSync(srcDir).sort();
      for (const name of entries) {
        if (name.startsWith(".aegis-tmp-")) continue;
        const srcFull = path.join(srcDir, name);
        const st = lstatSync(srcFull);
        if (st.isSymbolicLink()) continue;
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        if (st.isDirectory()) {
          mkdirSync(path.join(snapshotDir, ...rel.split("/")), { recursive: true });
          walkAndCopy(srcFull, rel);
        } else if (st.isFile()) {
          const check = validateAndResolveWorkspacePath(this.#workspaceRoot, rel);
          if (!check.ok) continue;
          const destFull = path.join(snapshotDir, ...check.normalizedRelPath.split("/"));
          mkdirSync(path.dirname(destFull), { recursive: true });
          copyFileSync(srcFull, destFull);
          const sha = sha256FileIfExists(destFull);
          baselines.set(check.normalizedRelPath, sha);
        }
      }
    };

    walkAndCopy(this.#workspaceRoot, "");
    for (const rel of extraTrackedRelPaths) {
      const check = validateAndResolveWorkspacePath(this.#workspaceRoot, rel);
      if (check.ok && !baselines.has(check.normalizedRelPath)) {
        baselines.set(check.normalizedRelPath, null);
      }
    }

    return {
      snapshotId,
      snapshotDir,
      baselines,
      getBaseline: (normalizedRelPath: string) => baselines.get(normalizedRelPath) ?? null,
      cleanup: () => {
        try {
          rmSync(snapshotDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup race
        }
      },
    };
  }

  /**
   * W2-S3: Host startup recovery Step 5c — reconciles any PREPARED managed_file_imports rows
   * left behind by a crash between atomic disk install and governance receipt commit.
   * Atomically commits INSTALLED receipt + workspace_file provenance WITHOUT rewriting disk!
   */
  reconcilePendingImportsOnStartup(
    govDb: DatabaseSync,
    runtimeEpoch: string,
    now: number,
  ): Array<{
    importId: string;
    logicalKey: string;
    conversationId: string;
    targetRelPath: string;
    outcome: "reconciled_installed" | "pending_reconcile";
    installCount: number;
    diskRewritten: false;
  }> {
    const rows = govDb
      .prepare(
        `SELECT * FROM managed_file_imports
          WHERE runtime_epoch = ? AND state = 'PREPARED'
          ORDER BY created_at ASC`,
      )
      .all(runtimeEpoch) as unknown as ManagedFileImportRow[];

    const results: Array<{
      importId: string;
      logicalKey: string;
      conversationId: string;
      targetRelPath: string;
      outcome: "reconciled_installed" | "pending_reconcile";
      installCount: number;
      diskRewritten: false;
    }> = [];

    for (const row of rows) {
      const pathCheck = validateAndResolveWorkspacePath(this.#workspaceRoot, row.target_rel_path);
      if (!pathCheck.ok) {
        withImmediateTx(govDb, () => {
          govDb
            .prepare(
              `UPDATE managed_file_imports
                  SET state = 'PENDING_RECONCILE',
                      reason = ?,
                      updated_at = ?
                WHERE import_id = ? AND state = 'PREPARED'`,
            )
            .run(`startup_reconcile_invalid_path:${pathCheck.code}`, now, row.import_id);
        });
        results.push({
          importId: row.import_id,
          logicalKey: row.logical_key,
          conversationId: row.conversation_id,
          targetRelPath: row.target_rel_path,
          outcome: "pending_reconcile",
          installCount: row.install_count,
          diskRewritten: false,
        });
        continue;
      }

      const diskSha = sha256FileIfExists(pathCheck.absolutePath);
      const isAmbiguousSameHash =
        row.base_sha256 !== null && row.base_sha256 === row.artifact_sha256;
      if (isAmbiguousSameHash) {
        // W2-S3: When base_sha256 === artifact_sha256, disk hash alone cannot prove whether atomic install
        // occurred before crash without independent install proof -> conservatively mark PENDING_RECONCILE!
        withImmediateTx(govDb, () => {
          govDb
            .prepare(
              `UPDATE managed_file_imports
                  SET state = 'PENDING_RECONCILE',
                      reason = 'ambiguous_same_hash_without_install_proof',
                      updated_at = ?
                WHERE import_id = ? AND state = 'PREPARED'`,
            )
            .run(now, row.import_id);
        });
        results.push({
          importId: row.import_id,
          logicalKey: row.logical_key,
          conversationId: row.conversation_id,
          targetRelPath: row.target_rel_path,
          outcome: "pending_reconcile",
          installCount: row.install_count,
          diskRewritten: false,
        });
      } else if (diskSha !== null && diskSha === row.artifact_sha256) {
        const parentSourceIds = JSON.parse(row.parent_source_ids_json || "[]") as string[];
        withImmediateTx(govDb, () => {
          govDb
            .prepare(
              `UPDATE managed_file_imports
                  SET state = 'INSTALLED',
                      install_count = CASE WHEN install_count < 1 THEN 1 ELSE install_count END,
                      reason = 'reconciled_installed_after_receipt_loss',
                      updated_at = ?
                WHERE import_id = ? AND state = 'PREPARED'`,
            )
            .run(now, row.import_id);
          writeAuditEvent(govDb, {
            entityType: "file_import",
            entityId: row.import_id,
            eventKey: `reconcile_installed:${row.import_id}`,
            eventType: "file_import_reconciled_installed",
            occurredAt: now,
            details: {
              targetRelPath: row.target_rel_path,
              artifactSha256: row.artifact_sha256,
              rewrittenDisk: false,
              recoveredOnStartup: true,
            },
          });
          insertWorkspaceFileSourceInTx(govDb, {
            runtimeEpoch: row.runtime_epoch,
            conversationId: row.conversation_id,
            principalId: row.principal_id,
            normalizedRelPath: row.target_rel_path,
            artifactSha256: row.artifact_sha256,
            artifactBytes: row.artifact_bytes,
            importId: row.import_id,
            volumeName: row.volume_name,
            parentSourceIds,
            now,
          });
        });
        const updated = govDb
          .prepare("SELECT install_count FROM managed_file_imports WHERE import_id = ?")
          .get(row.import_id) as { install_count: number };
        results.push({
          importId: row.import_id,
          logicalKey: row.logical_key,
          conversationId: row.conversation_id,
          targetRelPath: row.target_rel_path,
          outcome: "reconciled_installed",
          installCount: updated.install_count,
          diskRewritten: false,
        });
      } else {
        withImmediateTx(govDb, () => {
          govDb
            .prepare(
              `UPDATE managed_file_imports
                  SET state = 'PENDING_RECONCILE',
                      reason = ?,
                      updated_at = ?
                WHERE import_id = ? AND state = 'PREPARED'`,
            )
            .run(
              diskSha === row.base_sha256
                ? "prepared_without_disk_install"
                : "unprovable_target_state_after_crash",
              now,
              row.import_id,
            );
        });
        results.push({
          importId: row.import_id,
          logicalKey: row.logical_key,
          conversationId: row.conversation_id,
          targetRelPath: row.target_rel_path,
          outcome: "pending_reconcile",
          installCount: row.install_count,
          diskRewritten: false,
        });
      }
    }

    return results;
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
    /** Optional additional conversation IDs (e.g. parent conversation of a delegated worker) whose sources must also be checked and inherited. */
    relatedConversationIds?: string[];
    principalId: string;
    scopeId: string;
    logicalKey: string;
    volumeName: string;
    /** W2-G2: Approved immutable Docker image digest required BEFORE launching read-only exporter. */
    approvedImageId: string;
    containerId?: string | null;
    targetRelPath: string;
    /** Base target SHA-256 captured by HOST at task snapshot time (NEVER from model args); null means target did NOT exist. */
    baseSha256: string | null;
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    now?: number;
    /** Test seam for V03: fires AFTER async writer-exit & read-only export, right BEFORE final commit auth check & write! */
    onBeforeCommitWrite?: () => Promise<void> | void;
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
          const isAmbiguousSameHash =
            existing.base_sha256 !== null && existing.base_sha256 === existing.artifact_sha256;
          if (isAmbiguousSameHash) {
            withImmediateTx(params.govDb, () => {
              params.govDb
                .prepare(
                  `UPDATE managed_file_imports
                      SET state = 'PENDING_RECONCILE',
                          reason = 'ambiguous_same_hash_without_install_proof',
                          updated_at = ?
                    WHERE import_id = ? AND state = 'PREPARED'`,
                )
                .run(now, existing.import_id);
            });
            return {
              ok: false,
              code: "pending_reconcile",
              message: "Base and artifact SHA-256 are identical without independent install proof; marked PENDING_RECONCILE",
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
          if (beforeSha !== null && beforeSha === existing.artifact_sha256) {
            // Provably already installed with exact artifact digest -> backfill receipt + source atomically WITHOUT rewriting disk!
            const parentSourceIds = JSON.parse(existing.parent_source_ids_json || "[]") as string[];
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
              insertWorkspaceFileSourceInTx(params.govDb, {
                runtimeEpoch: existing.runtime_epoch,
                conversationId: existing.conversation_id,
                principalId: existing.principal_id,
                normalizedRelPath: existing.target_rel_path,
                artifactSha256: existing.artifact_sha256,
                artifactBytes: existing.artifact_bytes,
                importId: existing.import_id,
                volumeName: existing.volume_name,
                parentSourceIds,
                now,
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

      // 1b. W2-S2: Re-verify ALL parent/conversation source read grants BEFORE writing target OR conflict candidate!
      const checkConvIds = [
        ...new Set([params.conversationId, ...(params.relatedConversationIds ?? [])]),
      ];
      const sourceAuthCheck = verifyAllConversationSourcesReadAuthorized(params.govDb, {
        runtimeEpoch: params.runtimeEpoch,
        conversationIds: checkConvIds,
        principalId: params.principalId,
        scopeId: params.scopeId,
      });
      if (!sourceAuthCheck.ok) {
        this.#recordRejectedImport(params.govDb, {
          importId,
          logicalKey: `${params.logicalKey}:srcrev:${importId}`,
          runtimeEpoch: params.runtimeEpoch,
          conversationId: params.conversationId,
          principalId: params.principalId,
          scopeId: params.scopeId,
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          volumeName: params.volumeName,
          containerId: params.containerId ?? null,
          reason: `${sourceAuthCheck.code}: ${sourceAuthCheck.reason}`,
          now,
        });
        return {
          ok: false,
          code: "source_read_revoked",
          message: sourceAuthCheck.reason,
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
      const writerCheck = await verifyAllVolumeWritersExitedAsync(params.volumeName);
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

      // 3. Controlled read-only export of verified regular file bytes from volume (strictly by approved immutable image digest)
      const exported = await exportRegularFilesFromVolumeReadOnlyAsync({
        volumeName: params.volumeName,
        approvedImageId: params.approvedImageId,
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

      // 3b. W2-S3 / W2-S2: Re-verify live workspace_write AND parent/conversation source read grants
      // STRICTLY AFTER async writer-exit + export and IMMEDIATELY BEFORE writing target OR conflict candidate!
      if (params.onBeforeCommitWrite) {
        await params.onBeforeCommitWrite();
      }
      const postExportWriteAuth = checkSourceReadAuthorized(params.govDb, {
        principalId: params.principalId,
        scopeId: params.scopeId,
        sourceType: "workspace_write",
        resourceId: "workspace",
        operation: "write",
        path: normalizedRelPath,
      });
      if (!postExportWriteAuth.ok) {
        this.#recordRejectedImport(params.govDb, {
          importId,
          logicalKey: `${params.logicalKey}:postexp_denied:${importId}`,
          runtimeEpoch: params.runtimeEpoch,
          conversationId: params.conversationId,
          principalId: params.principalId,
          scopeId: params.scopeId,
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          volumeName: params.volumeName,
          containerId: params.containerId ?? null,
          reason: `post_export_${postExportWriteAuth.code}: ${postExportWriteAuth.reason}`,
          now,
        });
        return {
          ok: false,
          code: "workspace_write_denied",
          message: postExportWriteAuth.reason,
          importId,
          state: "REJECTED",
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          currentTargetSha256Before: beforeSha,
          currentTargetSha256After: sha256FileIfExists(absolutePath),
          artifactSha256: null,
          conflictRelPath: null,
          installCount: 0,
          exporterImageId: exported.exporterImageId,
          writerCheck,
        };
      }
      const postExportSourceAuth = verifyAllConversationSourcesReadAuthorized(params.govDb, {
        runtimeEpoch: params.runtimeEpoch,
        conversationIds: checkConvIds,
        principalId: params.principalId,
        scopeId: params.scopeId,
      });
      if (!postExportSourceAuth.ok) {
        this.#recordRejectedImport(params.govDb, {
          importId,
          logicalKey: `${params.logicalKey}:postexp_srcrev:${importId}`,
          runtimeEpoch: params.runtimeEpoch,
          conversationId: params.conversationId,
          principalId: params.principalId,
          scopeId: params.scopeId,
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          volumeName: params.volumeName,
          containerId: params.containerId ?? null,
          reason: `post_export_${postExportSourceAuth.code}: ${postExportSourceAuth.reason}`,
          now,
        });
        return {
          ok: false,
          code: "source_read_revoked",
          message: postExportSourceAuth.reason,
          importId,
          state: "REJECTED",
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          currentTargetSha256Before: beforeSha,
          currentTargetSha256After: sha256FileIfExists(absolutePath),
          artifactSha256: null,
          conflictRelPath: null,
          installCount: 0,
          exporterImageId: exported.exporterImageId,
          writerCheck,
        };
      }

      // Collect parent conversation source IDs across conversation + related conversations
      const parentSourceIdSet = new Set<string>();
      for (const cid of checkConvIds) {
        for (const s of listConversationSources(params.govDb, params.runtimeEpoch, cid)) {
          parentSourceIdSet.add(s.record_id);
        }
      }
      const parentSourceIds = [...parentSourceIdSet];

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
          exporterImageId: exported.exporterImageId,
          writerCheck,
        };
      }

      // 4b. W2-S3: When exported artifact bytes are identical to authoritative baseline, settle cleanly
      // as a zero-write no-op (never writing PREPARED or rewriting disk)!
      if (params.baseSha256 !== null && targetFile.sha256 === params.baseSha256) {
        withImmediateTx(params.govDb, () => {
          params.govDb
            .prepare(
              `INSERT INTO managed_file_imports(
                 import_id, logical_key, runtime_epoch, conversation_id, principal_id, scope_id,
                 target_rel_path, base_sha256, artifact_sha256, artifact_bytes, volume_name, container_id,
                 state, conflict_rel_path, install_count, reason, parent_source_ids_json, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INSTALLED', NULL, 0, 'noop_identical_to_baseline', ?, ?, ?)
               ON CONFLICT(logical_key) DO UPDATE SET
                 state = 'INSTALLED',
                 reason = 'noop_identical_to_baseline',
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
          writeAuditEvent(params.govDb, {
            entityType: "file_import",
            entityId: importId,
            eventKey: `noop:${importId}`,
            eventType: "file_import_noop_unchanged",
            occurredAt: now,
            details: {
              targetRelPath: normalizedRelPath,
              baseSha256: params.baseSha256,
              artifactSha256: targetFile.sha256,
              diskWritten: false,
            },
          });
          insertWorkspaceFileSourceInTx(params.govDb, {
            runtimeEpoch: params.runtimeEpoch,
            conversationId: params.conversationId,
            principalId: params.principalId,
            normalizedRelPath,
            artifactSha256: targetFile.sha256,
            artifactBytes: targetFile.sizeBytes,
            importId,
            volumeName: params.volumeName,
            parentSourceIds,
            now,
          });
        });

        return {
          ok: true,
          code: "noop_unchanged",
          message: `Artifact matches authoritative baseline SHA-256; settled without disk write`,
          importId,
          state: "INSTALLED",
          targetRelPath: normalizedRelPath,
          baseSha256: params.baseSha256,
          currentTargetSha256Before: beforeSha,
          currentTargetSha256After: currentSha,
          artifactSha256: targetFile.sha256,
          conflictRelPath: null,
          installCount: 0,
          exporterImageId: exported.exporterImageId,
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

      // 7. Commit durable INSTALLED receipt & record derived file provenance ATOMICALLY in the SAME transaction!
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
            exporterImageId: exported.exporterImageId,
            parentSourceIds,
          },
        });
        insertWorkspaceFileSourceInTx(params.govDb, {
          runtimeEpoch: params.runtimeEpoch,
          conversationId: params.conversationId,
          principalId: params.principalId,
          normalizedRelPath,
          artifactSha256: targetFile.sha256,
          artifactBytes: targetFile.sizeBytes,
          importId,
          volumeName: params.volumeName,
          parentSourceIds,
          now,
        });
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
        exporterImageId: exported.exporterImageId,
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
