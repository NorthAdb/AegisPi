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
  conversation_id TEXT PRIMARY KEY NOT NULL,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  principal_id TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL REFERENCES runtime_epochs(runtime_epoch),
  created_at INTEGER NOT NULL
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
