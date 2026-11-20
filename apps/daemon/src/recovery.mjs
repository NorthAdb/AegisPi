// Startup recovery per 06 section 9. The order is fixed by the protocol and
// each step appends to the action log that the recovery diagnostics surface:
// integrity -> schema verify -> object references -> scope config ->
// lost attempts/jobs -> SUBMITTING->UNKNOWN -> budget calibration ->
// Timer/Outbox/inbox state -> only then is Agent execution opened. Any hard
// failure stops at that step and the daemon opens READ-ONLY diagnostics; it
// never "fixes" state by guessing and never auto-starts execution.
//
// The exclusive lock and the (backup + migrate) steps belong to the daemon
// entry BEFORE this module runs; recovery starts at integrity.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkDatabaseIntegrity } from "./db/connect.mjs";
import { verifySchema } from "./db/migrate.mjs";
import { reapExpiredLeases } from "./scheduler.mjs";
import { markSubmittingEffectsUnknown } from "./effects.mjs";
import { reapLostJobs } from "./execution-jobs.mjs";
import { createBudgetLedger } from "./budget.mjs";

export function scanMissingObjectFiles(db, stateDir) {
  const rows = db
    .prepare("SELECT id, storage_ref FROM objects WHERE storage_ref IS NOT NULL")
    .all();
  const missing = [];
  for (const r of rows) {
    const p = join(stateDir, ...r.storage_ref.split("/"));
    if (!existsSync(p)) {
      missing.push({ objectId: r.id, storageRef: r.storage_ref });
    }
  }
  return missing;
}

export function startupRecovery(db, {
  stateDir,
  canonical,
  now,
  maxAttempts = 3,
  unknownUsageTimeoutMs = 15 * 60 * 1000,
  killOrphans = true,
}) {
  const actions = [];
  const step = (name, ok, detail) => {
    actions.push({ step: name, ok, detail });
    return ok;
  };
  const readonly = (name, detail) => ({ mode: "read-only", failedStep: name, actions });

  // 1. Disk and database integrity.
  const integrity = checkDatabaseIntegrity(db);
  if (!step("integrity", integrity.ok, integrity.detail)) {
    return readonly("integrity", integrity.detail);
  }

  // 2. Schema matches the pinned canonical DDL.
  const schema = verifySchema(db, canonical);
  if (!step("schema-verify", schema.ok, schema.reason)) {
    return readonly("schema-verify", schema.reason);
  }

  // 3. Object references: every activated object file must be on disk.
  const missingFiles = scanMissingObjectFiles(db, stateDir);
  if (!step("object-references", missingFiles.length === 0,
    missingFiles.length === 0 ? "all activated object files present" : `missing: ${JSON.stringify(missingFiles.slice(0, 5))}`)) {
    return readonly("object-references", `${missingFiles.length} missing object file(s)`);
  }

  // 4. Scope configuration and revocation versions are restorable from the
  // database alone (nothing depends on memory).
  const scopes = db
    .prepare("SELECT count(*) c, sum(paused) p FROM scopes")
    .get();
  const grants = db.prepare("SELECT count(*) c FROM acl_grants WHERE revoked_at IS NOT NULL").get().c;
  const authRev = db
    .prepare("SELECT value FROM system_state WHERE key='authorization_revision'")
    .get().value;
  step("scope-config", true,
    `scopes=${scopes.c} paused=${scopes.p ?? 0} revoked_grants=${grants} authorization_revision=${authRev}`);

  // 5. Lost attempts: leases that died with the process are LOST; their tasks
  // requeue (or DEAD at exhaustion).
  const reapedAttempts = reapExpiredLeases(db, { now, maxAttempts });
  step("lost-attempts", true,
    reapedAttempts.length === 0
      ? "no expired leases to reap"
      : reapedAttempts.map((r) => `${r.taskId}#${r.attemptNo}->${r.finalState}`).join(", "));

  // 6. Lost jobs: RUNNING jobs have no trusted completion record; orphans die.
  const reapedJobs = reapLostJobs(db, { stateDir, now, killOrphans });
  step("lost-jobs", true,
    reapedJobs.length === 0
      ? "no running jobs to recover"
      : reapedJobs.map((r) => `${r.jobId}->LOST${r.killedOrphan ? ` (orphan pid ${r.pid} killed)` : ""}`).join(", "));

  // 7. SUBMITTING effects are UNKNOWN: the CAS committed, the outcome is not
  // knowable from here (06 section 9, the flagship window).
  const unknownEffects = markSubmittingEffectsUnknown(db, { now });
  step("submitting-to-unknown", true,
    unknownEffects.length === 0 ? "no SUBMITTING effects" : `${unknownEffects.join(", ")} -> UNKNOWN (per retry_mode or human)`);

  // 8. Budget calibration: HELD reservations whose usage never arrived past
  // the settle timeout become CHARGED_BOUND (conservative, never released).
  // Pre-call model_requests (state='RESERVED', call not yet issued) stay
  // HELD across restarts without entering CHARGED_BOUND (ADR-0001 §7).
  const ledger = createBudgetLedger(db, {});
  const hasModelRequests =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_requests'").get() !== undefined;
  const staleHeld = hasModelRequests
    ? db
        .prepare(
          `SELECT r.id FROM budget_reservations r
           WHERE r.state='HELD' AND r.created_at<=?
             AND NOT EXISTS (
               SELECT 1 FROM model_requests mr
               WHERE mr.reservation_id = r.id AND mr.state = 'RESERVED'
             )`,
        )
        .all(now - unknownUsageTimeoutMs)
    : db
        .prepare("SELECT id FROM budget_reservations WHERE state='HELD' AND created_at<=?")
        .all(now - unknownUsageTimeoutMs);
  const charged = [];
  for (const r of staleHeld) {
    ledger.chargeBound({ reservationId: r.id, now });
    charged.push(r.id);
  }
  step("budget-calibrate", true,
    charged.length === 0 ? "no stale HELD reservations" : `${charged.join(", ")} -> CHARGED_BOUND`);

  // 9. Timer, Outbox and inbox state is durable; the loop resumes from these
  // counts without any in-memory wakeup.
  const dueTimers = db
    .prepare("SELECT count(*) c FROM timers WHERE state='SCHEDULED' AND due_at<=?")
    .get(now).c;
  const readyOutbox = db
    .prepare("SELECT count(*) c FROM outbox o JOIN effects e ON e.id=o.effect_id WHERE e.state='READY' AND o.not_before<=?")
    .get(now).c;
  const pendingInbox = db.prepare("SELECT count(*) c FROM inbox WHERE state='PENDING'").get().c;
  const routedInbox = db.prepare("SELECT count(*) c FROM inbox WHERE state='ROUTED'").get().c;
  const unknownUsage = db.prepare("SELECT count(*) c FROM budget_reservations WHERE state='HELD'").get().c;
  step("timers-outbox-inbox", true,
    `due_timers=${dueTimers} ready_outbox=${readyOutbox} inbox pending/routed=${pendingInbox}/${routedInbox} held_reservations=${unknownUsage}`);

  // 10. Everything verified: Agent execution may open.
  step("open-execution", true, "recovery complete; scheduler, dispatcher and timers may run");
  return { mode: "open", actions };
}
