import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export interface GovDbPragmas {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  busyTimeout: number;
  sqliteVersion: string;
}

export const GOV_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runtime_epochs (
  runtime_epoch TEXT PRIMARY KEY NOT NULL,
  trace_identity TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','RETIRED')),
  created_at INTEGER NOT NULL DEFAULT 0,
  retired_at INTEGER,
  retire_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_epoch
  ON runtime_epochs(status) WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS paired_manifest (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK(singleton_id = 1),
  runtime_epoch TEXT NOT NULL REFERENCES runtime_epochs(runtime_epoch),
  trace_identity TEXT NOT NULL,
  anchor_conversation_id TEXT NOT NULL,
  last_trace_watermark INTEGER NOT NULL DEFAULT 0 CHECK(last_trace_watermark >= 0),
  last_change_counter INTEGER NOT NULL DEFAULT 0 CHECK(last_change_counter >= 0),
  known_pi_task_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scopes (
  scope_id TEXT PRIMARY KEY NOT NULL,
  scope_epoch INTEGER NOT NULL CHECK(scope_epoch > 0),
  policy_version INTEGER NOT NULL CHECK(policy_version > 0),
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),
  allowed_principals_json TEXT NOT NULL DEFAULT '[]',
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  allowed_targets_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS sessions (
  token_digest TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY NOT NULL,
  runtime_epoch TEXT NOT NULL REFERENCES runtime_epochs(runtime_epoch),
  conversation_id TEXT NOT NULL,
  tool_task_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  tool_name TEXT NOT NULL,
  target TEXT NOT NULL,
  head_rev INTEGER NOT NULL CHECK(head_rev > 0),
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),
  created_at INTEGER NOT NULL,
  UNIQUE(runtime_epoch, conversation_id, tool_task_id, call_id)
);

CREATE TABLE IF NOT EXISTS draft_revisions (
  proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  canonical_snapshot TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  scope_epoch INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(proposal_id, revision)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  nonce_digest TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED','REJECTED','EXPIRED','SUPERSEDED')),
  principal_id TEXT,
  decision_key TEXT,
  decision_digest TEXT,
  receipt TEXT,
  decided_at INTEGER,
  UNIQUE(proposal_id, revision),
  UNIQUE(principal_id, decision_key),
  FOREIGN KEY(proposal_id, revision) REFERENCES draft_revisions(proposal_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_approval
  ON approvals(proposal_id) WHERE state='PENDING';

CREATE TABLE IF NOT EXISTS approval_challenges (
  approval_id TEXT PRIMARY KEY NOT NULL REFERENCES approvals(approval_id),
  nonce_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS effects (
  effect_id TEXT PRIMARY KEY NOT NULL,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(approval_id),
  state TEXT NOT NULL CHECK(state IN ('READY','SUBMITTING','SUCCEEDED','FAILED','UNKNOWN','QUARANTINED')),
  claimed_at INTEGER,
  receipt_ref TEXT,
  reason TEXT,
  reconciled_by TEXT,
  reconciled_at INTEGER,
  reconcile_evidence TEXT
);

CREATE TABLE IF NOT EXISTS signal_outbox (
  approval_id TEXT PRIMARY KEY NOT NULL REFERENCES approvals(approval_id),
  signal_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('PENDING','ACKED','ISOLATED')),
  sdk_result TEXT,
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budget_accounts (
  account_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('TASK','DAY')),
  limit_mu INTEGER NOT NULL CHECK(limit_mu >= 0),
  held_mu INTEGER NOT NULL CHECK(held_mu >= 0),
  charged_mu INTEGER NOT NULL CHECK(charged_mu >= 0),
  frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen IN (0,1))
);

CREATE TABLE IF NOT EXISTS budget_reservations (
  request_id TEXT PRIMARY KEY NOT NULL,
  runtime_epoch TEXT NOT NULL REFERENCES runtime_epochs(runtime_epoch),
  conversation_id TEXT NOT NULL,
  owner_task_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  task_account TEXT NOT NULL REFERENCES budget_accounts(account_id),
  day_account TEXT NOT NULL REFERENCES budget_accounts(account_id),
  charge_day TEXT NOT NULL,
  zone TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  upper_mu INTEGER NOT NULL CHECK(upper_mu >= 0),
  actual_mu INTEGER CHECK(actual_mu >= 0),
  reserved_at INTEGER NOT NULL,
  settle_due_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('HELD','SETTLED','RELEASED','CHARGED_BOUND')),
  CHECK(task_account <> day_account)
);

CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  evidence_ref TEXT,
  delta_mu INTEGER,
  details_json TEXT,
  UNIQUE(entity_type, entity_id, event_key)
);

CREATE TABLE IF NOT EXISTS conversation_scopes (
  runtime_epoch TEXT NOT NULL REFERENCES runtime_epochs(runtime_epoch),
  conversation_id TEXT NOT NULL,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(runtime_epoch, conversation_id)
);

CREATE TABLE IF NOT EXISTS budget_task_bindings (
  runtime_epoch TEXT NOT NULL REFERENCES runtime_epochs(runtime_epoch),
  binding_kind TEXT NOT NULL CHECK(binding_kind IN ('PI_TASK','CONVERSATION')),
  binding_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_task_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('router','worker','compaction','summary','classify')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(runtime_epoch, binding_kind, binding_key)
);

CREATE TABLE IF NOT EXISTS chat_commands (
  command_id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL REFERENCES runtime_epochs(runtime_epoch),
  conversation_id TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  content_preview TEXT NOT NULL,
  pi_request_id TEXT NOT NULL UNIQUE,
  submission_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('REGISTERED','ADMITTED','PENDING_RECONCILE','FAILED')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(principal_id, runtime_epoch, conversation_id, chat_key)
);

CREATE TABLE IF NOT EXISTS source_read_grants (
  grant_id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  source_type TEXT NOT NULL CHECK(source_type IN ('memory','imap','github_mcp','workspace_write')),
  resource_id TEXT NOT NULL,
  operations_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS model_disclosure_grants (
  grant_id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  slot_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS conversation_sources (
  record_id TEXT PRIMARY KEY NOT NULL,
  runtime_epoch TEXT NOT NULL REFERENCES runtime_epochs(runtime_epoch),
  conversation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  version_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  parent_source_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_server_pins (
  server_id TEXT PRIMARY KEY NOT NULL,
  executable_path TEXT NOT NULL,
  executable_sha256 TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '',
  args_json TEXT NOT NULL DEFAULT '[]',
  read_only_mode INTEGER NOT NULL DEFAULT 1 CHECK(read_only_mode IN (0,1)),
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_tool_pins (
  server_id TEXT NOT NULL REFERENCES mcp_server_pins(server_id),
  tool_name TEXT NOT NULL,
  schema_sha256 TEXT NOT NULL,
  canonical_def_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('APPROVED','QUARANTINED','REVOKED')),
  reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(server_id, tool_name)
);

CREATE TABLE IF NOT EXISTS memory_notes (
  note_id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  domain TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('L0','L1','L2')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  content_digest TEXT NOT NULL,
  expires_at INTEGER,
  deleted_at INTEGER,
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK(quarantined IN (0,1)),
  quarantine_reasons_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  body
);

CREATE TABLE IF NOT EXISTS memory_refs (
  from_note_id TEXT NOT NULL REFERENCES memory_notes(note_id),
  to_note_id TEXT NOT NULL REFERENCES memory_notes(note_id),
  relation TEXT NOT NULL DEFAULT 'references',
  PRIMARY KEY(from_note_id, to_note_id)
);

CREATE TABLE IF NOT EXISTS memory_tombstones (
  note_id TEXT PRIMARY KEY NOT NULL,
  deleted_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_file_imports (
  import_id TEXT PRIMARY KEY NOT NULL,
  logical_key TEXT NOT NULL UNIQUE,
  runtime_epoch TEXT NOT NULL REFERENCES runtime_epochs(runtime_epoch),
  conversation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  target_rel_path TEXT NOT NULL,
  base_sha256 TEXT,
  artifact_sha256 TEXT NOT NULL,
  artifact_bytes INTEGER NOT NULL,
  volume_name TEXT NOT NULL,
  container_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','INSTALLED','CONFLICT_SAVED','REJECTED','PENDING_RECONCILE')),
  conflict_rel_path TEXT,
  install_count INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  parent_source_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function openGovernanceDb(dbPath: string): { db: DatabaseSync; pragmas: GovDbPragmas } {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  const isMemory = dbPath === ":memory:";

  if (!isMemory) {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  const journalRow = db.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
  const syncRow = db.prepare("PRAGMA synchronous;").get() as { synchronous: number };
  const fkRow = db.prepare("PRAGMA foreign_keys;").get() as { foreign_keys: number };
  const busyRow = db.prepare("PRAGMA busy_timeout;").get() as { timeout: number };
  const verRow = db.prepare("SELECT sqlite_version() AS v;").get() as { v: string };

  if (!isMemory && journalRow.journal_mode.toLowerCase() !== "wal") {
    db.close();
    throw new Error(`Governance DB failed WAL check: got ${journalRow.journal_mode}`);
  }
  if (syncRow.synchronous !== 2) {
    db.close();
    throw new Error(`Governance DB failed synchronous=FULL check: got ${syncRow.synchronous}`);
  }
  if (fkRow.foreign_keys !== 1) {
    db.close();
    throw new Error(`Governance DB failed foreign_keys=ON check: got ${fkRow.foreign_keys}`);
  }

  db.exec(GOV_SCHEMA_SQL);
  migrateGovernanceSchema(db);

  return {
    db,
    pragmas: {
      journalMode: journalRow.journal_mode,
      synchronous: syncRow.synchronous,
      foreignKeys: fkRow.foreign_keys,
      busyTimeout: busyRow.timeout,
      sqliteVersion: verRow.v,
    },
  };
}

function migrateGovernanceSchema(db: DatabaseSync): void {
  // Migration 1: Upgrade legacy conversation_scopes(conversation_id PK) -> PRIMARY KEY(runtime_epoch, conversation_id)
  const scopeCols = db.prepare("PRAGMA table_info(conversation_scopes);").all() as Array<{
    name: string;
    pk: number;
  }>;
  const pkCols = scopeCols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  const hasCompositeEpochPk =
    pkCols.length === 2 && pkCols[0] === "runtime_epoch" && pkCols[1] === "conversation_id";

  if (!hasCompositeEpochPk) {
    withImmediateTx(db, () => {
      // Re-check inside IMMEDIATE tx for concurrency safety
      const recheckCols = db.prepare("PRAGMA table_info(conversation_scopes);").all() as Array<{
        name: string;
        pk: number;
      }>;
      const recheckPk = recheckCols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      if (recheckPk.length === 2 && recheckPk[0] === "runtime_epoch" && recheckPk[1] === "conversation_id") {
        return;
      }

      db.exec(`
        CREATE TABLE conversation_scopes__migrated (
          runtime_epoch TEXT NOT NULL REFERENCES runtime_epochs(runtime_epoch),
          conversation_id TEXT NOT NULL,
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
          principal_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(runtime_epoch, conversation_id)
        );
        INSERT INTO conversation_scopes__migrated (
          runtime_epoch, conversation_id, scope_id, principal_id, created_at
        )
        SELECT runtime_epoch, conversation_id, scope_id, principal_id, created_at
          FROM conversation_scopes;
        DROP TABLE conversation_scopes;
        ALTER TABLE conversation_scopes__migrated RENAME TO conversation_scopes;
      `);

      const migratedRows = (
        db.prepare("SELECT count(*) AS n FROM conversation_scopes").get() as { n: number }
      ).n;

      writeAuditEvent(db, {
        entityType: "schema_migration",
        entityId: "conversation_scopes",
        eventKey: "migrate:conversation_scopes_epoch_pk:v2",
        eventType: "schema_migrated",
        occurredAt: Date.now(),
        details: {
          previousPk: recheckPk,
          newPk: ["runtime_epoch", "conversation_id"],
          migratedRows,
        },
      });
    });
  }

  // Migration 2: Provably backfill missing runtimeEpoch on legacy budget_denial audit rows.
  // Any row whose epoch cannot be uniquely proven is left untouched in audit_events (internal audit)
  // and strictly excluded from epoch-scoped snapshots and SSE streams.
  const denialRows = db
    .prepare(
      `SELECT seq, occurred_at, details_json
         FROM audit_events
        WHERE entity_type = 'budget_denial' AND event_type = 'budget_denied'
        ORDER BY seq ASC`,
    )
    .all() as Array<{ seq: number; occurred_at: number; details_json: string | null }>;

  const legacyDenials: Array<{ seq: number; occurredAt: number; parsed: Record<string, unknown> }> = [];
  for (const row of denialRows) {
    if (!row.details_json) continue;
    try {
      const parsed = JSON.parse(row.details_json) as Record<string, unknown>;
      if (typeof parsed["runtimeEpoch"] !== "string" || parsed["runtimeEpoch"].length === 0) {
        legacyDenials.push({ seq: row.seq, occurredAt: row.occurred_at, parsed });
      }
    } catch {
      // ignore malformed JSON
    }
  }

  if (legacyDenials.length === 0) {
    return;
  }

  withImmediateTx(db, () => {
    const epochs = db
      .prepare("SELECT runtime_epoch, created_at, retired_at, status FROM runtime_epochs")
      .all() as Array<{
      runtime_epoch: string;
      created_at: number;
      retired_at: number | null;
      status: string;
    }>;

    const backfilledSeqs: number[] = [];
    let skippedUnprovableCount = 0;

    for (const item of legacyDenials) {
      const convId =
        typeof item.parsed["conversationId"] === "string" && item.parsed["conversationId"].length > 0
          ? item.parsed["conversationId"]
          : null;
      if (!convId) {
        skippedUnprovableCount++;
        continue;
      }

      // 1. Conversation must map to a unique runtime_epoch in conversation_scopes
      const scopeEpochRows = db
        .prepare("SELECT DISTINCT runtime_epoch FROM conversation_scopes WHERE conversation_id = ?")
        .all(convId) as Array<{ runtime_epoch: string }>;
      if (scopeEpochRows.length !== 1) {
        skippedUnprovableCount++;
        continue;
      }
      const candidateEpoch = scopeEpochRows[0]!.runtime_epoch;

      // 2. Active epoch time window at occurred_at must uniquely match candidateEpoch
      const coveringEpochs = epochs.filter(
        (ep) =>
          ep.created_at <= item.occurredAt &&
          (ep.retired_at === null || item.occurredAt <= ep.retired_at),
      );
      if (coveringEpochs.length !== 1 || coveringEpochs[0]!.runtime_epoch !== candidateEpoch) {
        skippedUnprovableCount++;
        continue;
      }

      // 3. Existing budget_task_bindings / budget_reservations for (convId, ownerTaskId) must not contradict candidateEpoch
      const ownerTaskId =
        typeof item.parsed["ownerTaskId"] === "string" && item.parsed["ownerTaskId"].length > 0
          ? item.parsed["ownerTaskId"]
          : null;
      if (ownerTaskId) {
        const bindingEpochs = db
          .prepare(
            "SELECT DISTINCT runtime_epoch FROM budget_task_bindings WHERE conversation_id = ? AND owner_task_id = ?",
          )
          .all(convId, ownerTaskId) as Array<{ runtime_epoch: string }>;
        if (bindingEpochs.some((b) => b.runtime_epoch !== candidateEpoch)) {
          skippedUnprovableCount++;
          continue;
        }
        const reservationEpochs = db
          .prepare(
            "SELECT DISTINCT runtime_epoch FROM budget_reservations WHERE conversation_id = ? AND owner_task_id = ?",
          )
          .all(convId, ownerTaskId) as Array<{ runtime_epoch: string }>;
        if (reservationEpochs.some((r) => r.runtime_epoch !== candidateEpoch)) {
          skippedUnprovableCount++;
          continue;
        }
      }

      const updatedDetails: Record<string, unknown> = {
        ...item.parsed,
        runtimeEpoch: candidateEpoch,
        runtimeEpochBackfilled: true,
      };
      db.prepare("UPDATE audit_events SET details_json = ? WHERE seq = ?").run(
        JSON.stringify(updatedDetails),
        item.seq,
      );
      backfilledSeqs.push(item.seq);
    }

    if (backfilledSeqs.length > 0) {
      writeAuditEvent(db, {
        entityType: "schema_migration",
        entityId: "budget_denial_runtime_epoch",
        eventKey: `backfill:budget_denial_runtime_epoch:${backfilledSeqs.join(",")}`,
        eventType: "audit_backfilled",
        occurredAt: Date.now(),
        details: {
          backfilledCount: backfilledSeqs.length,
          backfilledSeqs,
          skippedUnprovableCount,
        },
      });
    }
  });

  // Migration 3: Idempotently add pinned launch command/args columns to older mcp_server_pins tables
  const mcpCols = db.prepare("PRAGMA table_info(mcp_server_pins);").all() as Array<{ name: string }>;
  const mcpColNames = new Set(mcpCols.map((c) => c.name));
  if (!mcpColNames.has("command")) {
    db.exec("ALTER TABLE mcp_server_pins ADD COLUMN command TEXT NOT NULL DEFAULT '';");
  }
  if (!mcpColNames.has("args_json")) {
    db.exec("ALTER TABLE mcp_server_pins ADD COLUMN args_json TEXT NOT NULL DEFAULT '[]';");
  }
}

export function withImmediateTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore secondary rollback failure
    }
    throw err;
  }
}

export function writeAuditEvent(
  db: DatabaseSync,
  params: {
    entityType: string;
    entityId: string;
    eventKey: string;
    eventType: string;
    occurredAt: number;
    evidenceRef?: string | null;
    deltaMu?: number | null;
    details?: Record<string, unknown> | null;
  },
): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO audit_events(
         entity_type, entity_id, event_key, event_type, occurred_at, evidence_ref, delta_mu, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.entityType,
      params.entityId,
      params.eventKey,
      params.eventType,
      params.occurredAt,
      params.evidenceRef ?? null,
      params.deltaMu ?? null,
      params.details ? JSON.stringify(params.details) : null,
    );
  return Number(res.changes) === 1;
}
