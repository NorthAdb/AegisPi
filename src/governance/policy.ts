import type { DatabaseSync } from "node:sqlite";
import { mintId } from "./canonical.ts";
import { withImmediateTx, writeAuditEvent } from "./db.ts";

export type SourceType = "memory" | "imap" | "github_mcp" | "workspace_write";

export interface SourceReadGrantRow {
  grant_id: string;
  principal_id: string;
  scope_id: string;
  source_type: SourceType;
  resource_id: string;
  operations_json: string;
  constraints_json: string;
  created_at: number;
  revoked_at: number | null;
}

export interface ModelDisclosureGrantRow {
  grant_id: string;
  principal_id: string;
  scope_id: string;
  source_type: string;
  source_id: string;
  provider: string;
  model_id: string;
  base_url: string;
  slot_name: string;
  created_at: number;
  revoked_at: number | null;
}

export interface ConversationSourceRow {
  record_id: string;
  runtime_epoch: string;
  conversation_id: string;
  principal_id: string;
  source_type: string;
  source_id: string;
  version_ref: string;
  title: string;
  content_digest: string;
  metadata_json: string;
  parent_source_ids_json: string;
  created_at: number;
}

export function grantSourceRead(
  db: DatabaseSync,
  params: {
    principalId: string;
    scopeId: string;
    sourceType: SourceType;
    resourceId: string;
    operations: string[];
    constraints?: Record<string, unknown>;
    now: number;
  },
): SourceReadGrantRow {
  return withImmediateTx(db, () => {
    const grantId = mintId("srg");
    db.prepare(
      `INSERT INTO source_read_grants(
         grant_id, principal_id, scope_id, source_type, resource_id,
         operations_json, constraints_json, created_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      grantId,
      params.principalId,
      params.scopeId,
      params.sourceType,
      params.resourceId,
      JSON.stringify(params.operations),
      JSON.stringify(params.constraints ?? {}),
      params.now,
    );
    writeAuditEvent(db, {
      entityType: "source_read_grant",
      entityId: grantId,
      eventKey: `grant:${grantId}`,
      eventType: "source_read_granted",
      occurredAt: params.now,
      details: {
        principalId: params.principalId,
        scopeId: params.scopeId,
        sourceType: params.sourceType,
        resourceId: params.resourceId,
        operations: params.operations,
        constraints: params.constraints ?? {},
      },
    });
    return db
      .prepare("SELECT * FROM source_read_grants WHERE grant_id = ?")
      .get(grantId) as unknown as SourceReadGrantRow;
  });
}

export function revokeSourceReadGrant(
  db: DatabaseSync,
  params: { grantId: string; reason: string; now: number },
): boolean {
  return withImmediateTx(db, () => {
    const res = db
      .prepare("UPDATE source_read_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL")
      .run(params.now, params.grantId);
    if (Number(res.changes) === 1) {
      writeAuditEvent(db, {
        entityType: "source_read_grant",
        entityId: params.grantId,
        eventKey: `revoke:${params.grantId}`,
        eventType: "source_read_revoked",
        occurredAt: params.now,
        details: { reason: params.reason },
      });
      return true;
    }
    return false;
  });
}

export function checkSourceReadAuthorized(
  db: DatabaseSync,
  params: {
    principalId: string;
    scopeId: string;
    sourceType: SourceType;
    resourceId: string;
    operation: string;
    ref?: string;
    path?: string;
  },
): { ok: true; grant: SourceReadGrantRow } | { ok: false; code: string; reason: string } {
  const wildcardPrefix = `${params.sourceType}:*`;
  const rows = db
    .prepare(
      `SELECT * FROM source_read_grants
        WHERE principal_id = ?
          AND scope_id = ?
          AND source_type = ?
          AND revoked_at IS NULL
          AND (resource_id = ? OR resource_id = '*' OR resource_id = ?)`,
    )
    .all(
      params.principalId,
      params.scopeId,
      params.sourceType,
      params.resourceId,
      wildcardPrefix,
    ) as unknown as SourceReadGrantRow[];

  for (const row of rows) {
    const ops = JSON.parse(row.operations_json) as string[];
    if (!ops.includes(params.operation) && !ops.includes("*")) continue;
    const constraints = JSON.parse(row.constraints_json) as {
      allowedRefs?: string[];
      allowedPaths?: string[];
      allowedRelPaths?: string[];
    };
    if (params.ref && Array.isArray(constraints.allowedRefs)) {
      if (!constraints.allowedRefs.includes(params.ref) && !constraints.allowedRefs.includes("*")) {
        continue;
      }
    }
    if (params.path && Array.isArray(constraints.allowedPaths)) {
      if (!constraints.allowedPaths.includes(params.path) && !constraints.allowedPaths.includes("*")) {
        continue;
      }
    }
    if (params.path && Array.isArray(constraints.allowedRelPaths)) {
      if (!constraints.allowedRelPaths.includes(params.path) && !constraints.allowedRelPaths.includes("*")) {
        continue;
      }
    }
    return { ok: true, grant: row };
  }

  return {
    ok: false,
    code: "source_read_denied",
    reason: `No active ${params.sourceType} grant for principal=${params.principalId} scope=${params.scopeId} resource=${params.resourceId} op=${params.operation}${params.ref ? ` ref=${params.ref}` : ""}${params.path ? ` path=${params.path}` : ""}`,
  };
}

export function grantModelDisclosure(
  db: DatabaseSync,
  params: {
    principalId: string;
    scopeId: string;
    sourceType: string;
    sourceId: string;
    provider: string;
    modelId: string;
    baseUrl: string;
    slotName: string;
    now: number;
  },
): ModelDisclosureGrantRow {
  const normalizedUrl = params.baseUrl.replace(/\/+$/, "");
  return withImmediateTx(db, () => {
    const grantId = mintId("mdg");
    db.prepare(
      `INSERT INTO model_disclosure_grants(
         grant_id, principal_id, scope_id, source_type, source_id,
         provider, model_id, base_url, slot_name, created_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      grantId,
      params.principalId,
      params.scopeId,
      params.sourceType,
      params.sourceId,
      params.provider,
      params.modelId,
      normalizedUrl,
      params.slotName,
      params.now,
    );
    writeAuditEvent(db, {
      entityType: "model_disclosure_grant",
      entityId: grantId,
      eventKey: `grant:${grantId}`,
      eventType: "model_disclosure_granted",
      occurredAt: params.now,
      details: {
        principalId: params.principalId,
        scopeId: params.scopeId,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        provider: params.provider,
        modelId: params.modelId,
        baseUrl: normalizedUrl,
        slotName: params.slotName,
      },
    });
    return db
      .prepare("SELECT * FROM model_disclosure_grants WHERE grant_id = ?")
      .get(grantId) as unknown as ModelDisclosureGrantRow;
  });
}

export function revokeModelDisclosureGrant(
  db: DatabaseSync,
  params: { grantId?: string; principalId?: string; sourceType?: string; sourceId?: string; reason: string; now: number },
): number {
  return withImmediateTx(db, () => {
    let rows: Array<{ grant_id: string }>;
    if (params.grantId) {
      rows = db
        .prepare("SELECT grant_id FROM model_disclosure_grants WHERE grant_id = ? AND revoked_at IS NULL")
        .all(params.grantId) as Array<{ grant_id: string }>;
    } else {
      rows = db
        .prepare(
          `SELECT grant_id FROM model_disclosure_grants
            WHERE revoked_at IS NULL
              AND (? IS NULL OR principal_id = ?)
              AND (? IS NULL OR source_type = ?)
              AND (? IS NULL OR source_id = ?)`,
        )
        .all(
          params.principalId ?? null,
          params.principalId ?? null,
          params.sourceType ?? null,
          params.sourceType ?? null,
          params.sourceId ?? null,
          params.sourceId ?? null,
        ) as Array<{ grant_id: string }>;
    }
    let revoked = 0;
    for (const r of rows) {
      const ch = db
        .prepare("UPDATE model_disclosure_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL")
        .run(params.now, r.grant_id);
      if (Number(ch.changes) === 1) {
        revoked++;
        writeAuditEvent(db, {
          entityType: "model_disclosure_grant",
          entityId: r.grant_id,
          eventKey: `revoke:${r.grant_id}`,
          eventType: "model_disclosure_revoked",
          occurredAt: params.now,
          details: { reason: params.reason },
        });
      }
    }
    return revoked;
  });
}

export function recordConversationSource(
  db: DatabaseSync,
  params: {
    runtimeEpoch: string;
    conversationId: string;
    principalId: string;
    sourceType: string;
    sourceId: string;
    versionRef: string;
    title: string;
    contentDigest: string;
    metadata?: Record<string, unknown>;
    parentSourceIds?: string[];
    now: number;
  },
): ConversationSourceRow {
  return withImmediateTx(db, () => {
    const existing = db
      .prepare(
        `SELECT * FROM conversation_sources
          WHERE runtime_epoch = ? AND conversation_id = ? AND source_type = ? AND source_id = ? AND version_ref = ?`,
      )
      .get(
        params.runtimeEpoch,
        params.conversationId,
        params.sourceType,
        params.sourceId,
        params.versionRef,
      ) as ConversationSourceRow | undefined;
    if (existing) return existing;

    const recordId = mintId("src");
    db.prepare(
      `INSERT INTO conversation_sources(
         record_id, runtime_epoch, conversation_id, principal_id,
         source_type, source_id, version_ref, title, content_digest,
         metadata_json, parent_source_ids_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      recordId,
      params.runtimeEpoch,
      params.conversationId,
      params.principalId,
      params.sourceType,
      params.sourceId,
      params.versionRef,
      params.title,
      params.contentDigest,
      JSON.stringify(params.metadata ?? {}),
      JSON.stringify(params.parentSourceIds ?? []),
      params.now,
    );
    return db
      .prepare("SELECT * FROM conversation_sources WHERE record_id = ?")
      .get(recordId) as unknown as ConversationSourceRow;
  });
}

export function listConversationSources(
  db: DatabaseSync,
  runtimeEpoch: string,
  conversationId: string,
): ConversationSourceRow[] {
  return db
    .prepare(
      `SELECT * FROM conversation_sources
        WHERE runtime_epoch = ? AND conversation_id = ?
        ORDER BY created_at ASC`,
    )
    .all(runtimeEpoch, conversationId) as unknown as ConversationSourceRow[];
}

export function inheritConversationSources(
  db: DatabaseSync,
  params: {
    runtimeEpoch: string;
    fromConversationId: string;
    toConversationId: string;
    principalId: string;
    now: number;
  },
): number {
  const sources = listConversationSources(db, params.runtimeEpoch, params.fromConversationId);
  let count = 0;
  for (const s of sources) {
    recordConversationSource(db, {
      runtimeEpoch: params.runtimeEpoch,
      conversationId: params.toConversationId,
      principalId: params.principalId,
      sourceType: s.source_type,
      sourceId: s.source_id,
      versionRef: s.version_ref,
      title: s.title,
      contentDigest: s.content_digest,
      metadata: JSON.parse(s.metadata_json) as Record<string, unknown>,
      parentSourceIds: [...(JSON.parse(s.parent_source_ids_json) as string[]), s.record_id],
      now: params.now,
    });
    count++;
  }
  return count;
}

/**
 * W2-S2: Verifies that a recorded conversation_sources row (and recursively all its parent sources)
 * STILL holds an active, non-revoked source_read_grant in the governance DB.
 */
export function checkRecordedSourceReadStillAuthorized(
  db: DatabaseSync,
  params: {
    principalId: string;
    scopeId: string;
    source: ConversationSourceRow;
    visited?: Set<string>;
  },
): { ok: true } | { ok: false; code: "source_read_revoked"; blockedSource: { sourceType: string; sourceId: string; title: string }; reason: string } {
  const visited = params.visited ?? new Set<string>();
  if (visited.has(params.source.record_id)) {
    return { ok: true };
  }
  visited.add(params.source.record_id);

  const src = params.source;
  const meta = JSON.parse(src.metadata_json || "{}") as Record<string, unknown>;

  if (src.source_type === "memory") {
    const domain = typeof meta["domain"] === "string" && meta["domain"].length > 0 ? meta["domain"] : null;
    const resourceId = domain ? `memory:${domain}` : src.source_id;
    const chk = checkSourceReadAuthorized(db, {
      principalId: params.principalId,
      scopeId: params.scopeId,
      sourceType: "memory",
      resourceId,
      operation: "read",
    });
    if (!chk.ok) {
      return {
        ok: false,
        code: "source_read_revoked",
        blockedSource: { sourceType: src.source_type, sourceId: src.source_id, title: src.title },
        reason: `Source read grant revoked or missing for ${src.source_type} (${resourceId}): ${chk.reason}`,
      };
    }
  } else if (src.source_type === "imap") {
    let mailbox = typeof meta["mailbox"] === "string" ? meta["mailbox"] : "";
    if (!mailbox) {
      const m = /^imap:([^:]+)/.exec(src.source_id);
      mailbox = m ? m[1]! : "";
    }
    const resourceId = mailbox ? `imap:${mailbox}` : src.source_id;
    const chk = checkSourceReadAuthorized(db, {
      principalId: params.principalId,
      scopeId: params.scopeId,
      sourceType: "imap",
      resourceId,
      operation: "read",
    });
    if (!chk.ok) {
      return {
        ok: false,
        code: "source_read_revoked",
        blockedSource: { sourceType: src.source_type, sourceId: src.source_id, title: src.title },
        reason: `Source read grant revoked or missing for ${src.source_type} (${resourceId}): ${chk.reason}`,
      };
    }
  } else if (src.source_type === "github_mcp") {
    const repoId = typeof meta["repoId"] === "string" ? meta["repoId"] : "";
    const ref = typeof meta["ref"] === "string" ? meta["ref"] : undefined;
    const filePath = typeof meta["path"] === "string" ? meta["path"] : undefined;
    const resourceId = repoId ? `github:${repoId}` : src.source_id;
    const chk = checkSourceReadAuthorized(db, {
      principalId: params.principalId,
      scopeId: params.scopeId,
      sourceType: "github_mcp",
      resourceId,
      operation: "read_file",
      ref,
      path: filePath,
    });
    if (!chk.ok) {
      return {
        ok: false,
        code: "source_read_revoked",
        blockedSource: { sourceType: src.source_type, sourceId: src.source_id, title: src.title },
        reason: `Source read grant revoked or missing for ${src.source_type} (${resourceId}): ${chk.reason}`,
      };
    }
  } else if (src.source_type === "workspace_file") {
    const relPath = src.source_id.startsWith("workspace:") ? src.source_id.slice("workspace:".length) : src.title;
    const chk = checkSourceReadAuthorized(db, {
      principalId: params.principalId,
      scopeId: params.scopeId,
      sourceType: "workspace_write",
      resourceId: "workspace",
      operation: "write",
      path: relPath,
    });
    if (!chk.ok) {
      return {
        ok: false,
        code: "source_read_revoked",
        blockedSource: { sourceType: src.source_type, sourceId: src.source_id, title: src.title },
        reason: `Workspace grant revoked for derived file ${relPath}: ${chk.reason}`,
      };
    }
  }

  // Recursively verify ALL parent sources!
  const parentIds = JSON.parse(src.parent_source_ids_json || "[]") as string[];
  for (const pid of parentIds) {
    const parentRow = db
      .prepare("SELECT * FROM conversation_sources WHERE record_id = ?")
      .get(pid) as ConversationSourceRow | undefined;
    if (!parentRow) continue;
    const parentCheck = checkRecordedSourceReadStillAuthorized(db, {
      principalId: params.principalId,
      scopeId: params.scopeId,
      source: parentRow,
      visited,
    });
    if (!parentCheck.ok) {
      return parentCheck;
    }
  }

  return { ok: true };
}

export function verifyAllConversationSourcesReadAuthorized(
  db: DatabaseSync,
  params: {
    runtimeEpoch: string;
    conversationIds: string[];
    principalId: string;
    scopeId: string;
  },
): { ok: true; checkedSources: number } | { ok: false; code: "source_read_revoked"; blockedSource: { sourceType: string; sourceId: string; title: string }; reason: string } {
  const seen = new Set<string>();
  let checked = 0;
  for (const cid of params.conversationIds) {
    const sources = listConversationSources(db, params.runtimeEpoch, cid);
    for (const src of sources) {
      if (seen.has(src.record_id)) continue;
      seen.add(src.record_id);
      checked++;
      const res = checkRecordedSourceReadStillAuthorized(db, {
        principalId: params.principalId,
        scopeId: params.scopeId,
        source: src,
      });
      if (!res.ok) return res;
    }
  }
  return { ok: true, checkedSources: checked };
}

export function persistWorkerExecutionRoot(
  db: DatabaseSync,
  params: {
    runtimeEpoch: string;
    workerConversationId: string;
    parentConversationId: string;
    executionRootTaskId: string;
    now: number;
  },
): void {
  withImmediateTx(db, () => {
    db.prepare(
      `INSERT OR IGNORE INTO worker_execution_roots(
         runtime_epoch, worker_conversation_id, parent_conversation_id, execution_root_task_id, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      params.runtimeEpoch,
      params.workerConversationId,
      params.parentConversationId,
      params.executionRootTaskId,
      params.now,
    );
  });
}

export function getWorkerExecutionRoot(
  db: DatabaseSync,
  runtimeEpoch: string,
  workerConversationId: string,
): { parent_conversation_id: string; execution_root_task_id: string } | undefined {
  return db
    .prepare(
      `SELECT parent_conversation_id, execution_root_task_id
         FROM worker_execution_roots
        WHERE runtime_epoch = ? AND worker_conversation_id = ?`,
    )
    .get(runtimeEpoch, workerConversationId) as
    | { parent_conversation_id: string; execution_root_task_id: string }
    | undefined;
}

export function listWorkerExecutionRoots(
  db: DatabaseSync,
  runtimeEpoch: string,
): Array<{ worker_conversation_id: string; parent_conversation_id: string; execution_root_task_id: string }> {
  return db
    .prepare(
      `SELECT worker_conversation_id, parent_conversation_id, execution_root_task_id
         FROM worker_execution_roots
        WHERE runtime_epoch = ?`,
    )
    .all(runtimeEpoch) as Array<{
    worker_conversation_id: string;
    parent_conversation_id: string;
    execution_root_task_id: string;
  }>;
}

/**
 * W2-S2 / W2-S3: Collects the conversation itself and any co-owned parent/worker conversations sharing
 * the same durable budget owner_task_id OR worker_execution_roots lineage for the runtime epoch.
 */
export function findRelatedConversationIdsByOwnerTask(
  db: DatabaseSync,
  runtimeEpoch: string,
  conversationId: string,
): string[] {
  const related = new Set<string>([conversationId]);
  const ownerRow = db
    .prepare(
      `SELECT owner_task_id FROM budget_task_bindings
        WHERE runtime_epoch = ? AND binding_kind = 'CONVERSATION' AND binding_key = ?
        LIMIT 1`,
    )
    .get(runtimeEpoch, conversationId) as { owner_task_id: string } | undefined;
  if (ownerRow?.owner_task_id) {
    const peerRows = db
      .prepare(
        `SELECT DISTINCT conversation_id FROM budget_task_bindings
          WHERE runtime_epoch = ? AND owner_task_id = ?`,
      )
      .all(runtimeEpoch, ownerRow.owner_task_id) as Array<{ conversation_id: string }>;
    for (const r of peerRows) {
      if (r.conversation_id) related.add(r.conversation_id);
    }
  }
  const lineageRows = db
    .prepare(
      `SELECT worker_conversation_id, parent_conversation_id FROM worker_execution_roots
        WHERE runtime_epoch = ? AND (worker_conversation_id = ? OR parent_conversation_id = ?)`,
    )
    .all(runtimeEpoch, conversationId, conversationId) as Array<{
    worker_conversation_id: string;
    parent_conversation_id: string;
  }>;
  for (const r of lineageRows) {
    if (r.worker_conversation_id) related.add(r.worker_conversation_id);
    if (r.parent_conversation_id) related.add(r.parent_conversation_id);
  }
  return [...related];
}

/**
 * W2-S2: Verifies that every recorded source across a conversation AND its co-owned
 * parent/worker conversations STILL holds an active source_read_grant.
 */
export function verifyProposalSourcesReadAuthorized(
  db: DatabaseSync,
  params: {
    runtimeEpoch: string;
    conversationId: string;
    principalId: string;
    scopeId: string;
  },
): { ok: true; checkedSources: number } | { ok: false; code: "source_read_revoked"; blockedSource: { sourceType: string; sourceId: string; title: string }; reason: string } {
  const convIds = findRelatedConversationIdsByOwnerTask(db, params.runtimeEpoch, params.conversationId);
  return verifyAllConversationSourcesReadAuthorized(db, {
    runtimeEpoch: params.runtimeEpoch,
    conversationIds: convIds,
    principalId: params.principalId,
    scopeId: params.scopeId,
  });
}

/**
 * W2-S3: Enumerates explicit authorized workspace relative paths (excluding wildcard "*")
 * from active, non-revoked workspace_write grants for (principalId, scopeId).
 */
export function listAuthorizedWorkspaceRelPaths(
  db: DatabaseSync,
  params: { principalId: string; scopeId: string },
): string[] {
  const rows = db
    .prepare(
      `SELECT operations_json, constraints_json FROM source_read_grants
        WHERE principal_id = ?
          AND scope_id = ?
          AND source_type = 'workspace_write'
          AND revoked_at IS NULL
          AND (resource_id = 'workspace' OR resource_id = 'workspace_write:*' OR resource_id = '*')`,
    )
    .all(params.principalId, params.scopeId) as Array<{ operations_json: string; constraints_json: string }>;

  const out = new Set<string>();
  for (const row of rows) {
    const ops = JSON.parse(row.operations_json || "[]") as string[];
    if (!ops.includes("write") && !ops.includes("*")) continue;
    const constraints = JSON.parse(row.constraints_json || "{}") as { allowedRelPaths?: unknown };
    if (Array.isArray(constraints.allowedRelPaths)) {
      for (const p of constraints.allowedRelPaths) {
        if (typeof p === "string" && p.trim().length > 0 && p.trim() !== "*") {
          out.add(p.trim());
        }
      }
    }
  }
  return [...out];
}

export function getSourceReadRevocationWatermark(
  db: DatabaseSync,
  principalId: string,
  scopeId: string,
): string {
  const row = db
    .prepare(
      `SELECT count(*) AS revoked_count, COALESCE(MAX(revoked_at), 0) AS max_revoked_at
         FROM source_read_grants
        WHERE principal_id = ? AND scope_id = ? AND revoked_at IS NOT NULL`,
    )
    .get(principalId, scopeId) as { revoked_count: number; max_revoked_at: number };
  return `${row.revoked_count}:${row.max_revoked_at}`;
}

/**
 * Verifies that EVERY provenance source attached to a conversation (and any derived artifact / parent source)
 * STILL holds BOTH:
 * 1. An active, non-revoked source_read_grant (W2-S2: live read revocation blocks generation/delegation/compaction/retry!)
 * 2. An active, non-revoked model_disclosure_grant for the exact target destination (provider, modelId, baseUrl, slotName).
 */
export function checkConversationModelDisclosure(
  db: DatabaseSync,
  params: {
    runtimeEpoch: string;
    conversationId: string;
    principalId: string;
    scopeId: string;
    provider: string;
    modelId: string;
    baseUrl: string;
    slotName: string;
  },
):
  | { ok: true; checkedSources: number }
  | { ok: false; code: "disclosure_denied" | "source_read_revoked"; blockedSource: { sourceType: string; sourceId: string; title: string }; reason: string } {
  const sources = listConversationSources(db, params.runtimeEpoch, params.conversationId);
  if (sources.length === 0) {
    return { ok: true, checkedSources: 0 };
  }
  const normalizedUrl = params.baseUrl.replace(/\/+$/, "");

  const grants = db
    .prepare(
      `SELECT * FROM model_disclosure_grants
        WHERE principal_id = ?
          AND scope_id = ?
          AND revoked_at IS NULL
          AND (provider = ? OR provider = '*')
          AND (model_id = ? OR model_id = '*')
          AND (base_url = ? OR base_url = '*')
          AND (slot_name = ? OR slot_name = '*')`,
    )
    .all(
      params.principalId,
      params.scopeId,
      params.provider,
      params.modelId,
      normalizedUrl,
      params.slotName,
    ) as unknown as ModelDisclosureGrantRow[];

  for (const src of sources) {
    // 1. Live source read grant check (including recursive parent sources)
    const readStillActive = checkRecordedSourceReadStillAuthorized(db, {
      principalId: params.principalId,
      scopeId: params.scopeId,
      source: src,
    });
    if (!readStillActive.ok) {
      return readStillActive;
    }

    // 2. Live model disclosure grant check for target model destination
    const allowed = grants.some(
      (g) =>
        (g.source_type === src.source_type || g.source_type === "*") &&
        (g.source_id === src.source_id || g.source_id === "*"),
    );
    if (!allowed) {
      return {
        ok: false,
        code: "disclosure_denied",
        blockedSource: {
          sourceType: src.source_type,
          sourceId: src.source_id,
          title: src.title,
        },
        reason: `Model disclosure denied for ${src.source_type}:${src.source_id} to ${params.provider}/${params.modelId} (${normalizedUrl}, slot=${params.slotName})`,
      };
    }
  }
  return { ok: true, checkedSources: sources.length };
}
