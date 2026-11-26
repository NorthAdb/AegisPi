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
 * Verifies that EVERY provenance source attached to a conversation (and any derived artifact)
 * has an active, non-revoked model_disclosure_grant for the exact target destination
 * (provider, modelId, baseUrl, slotName).
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
  | { ok: false; code: "disclosure_denied"; blockedSource: { sourceType: string; sourceId: string; title: string }; reason: string } {
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
