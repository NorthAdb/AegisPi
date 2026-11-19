// The daemon entry. Phase 2 runs a single daemon against a local SQLite file
// with fake/recorded inputs only — there is no real ingress adapter and no
// real upstream submitter here (Phase 3 concerns), and the loop says so rather
// than pretending. The startup order is fixed by 06 section 9 and the
// recovery module owns its action log:
//   lock -> integrity -> pre-migration backup -> migrate -> startup recovery
//   -> console (always; read-only mode keeps only diagnostics) -> loop.
// Holding the lock fails -> exit non-zero immediately.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadDaemonConfig } from "./config.mjs";
import { acquireDaemonLock } from "./db/lock.mjs";
import { openDatabase, checkDatabaseIntegrity } from "./db/connect.mjs";
import { loadCanonicalSchema, migrate } from "./db/migrate.mjs";
import { migrationPending, preMigrationBackup } from "./db/backup.mjs";
import { startupRecovery } from "./recovery.mjs";
import { createBudgetLedger } from "./budget.mjs";
import { dispatchEventToTask } from "./router.mjs";
import { dispatchKeyForInbox } from "./ingress.mjs";
import {
  claimNextTask,
  completeTask,
  heartbeat,
  workerStep,
  reapExpiredLeases,
  deliveryAckCheckpoint,
  deliveryDone,
} from "./scheduler.mjs";
import { processDueTimers, cancelSatisfiedFollowUpReminders } from "./timers.mjs";
import { expireApprovals } from "./approvals.mjs";
import { expireStaleNotifications, dueNotifications } from "./outbox.mjs";
import { insertObjectRow } from "./objects.mjs";
import { createFakeRemote } from "./testing/fake-remote.mjs";
import { dispatchEffect, autoRecoverUnknown } from "./effects.mjs";
import {
  createConsoleApp,
  serveConsole,
  ensureConsoleToken,
  CONSOLE_DEFAULT_PORT,
} from "./console/api.mjs";

export async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv.filter((a) => a.startsWith("--")));
  const dataDirFlag = argv.find((a) => a.startsWith("--data-dir="));
  const dataDir = dataDirFlag ? dataDirFlag.slice("--data-dir=".length) : join(process.cwd(), "workspace-state");
  const fakeUpstream = args.has("--fake-upstream");

  const config = loadDaemonConfig();
  const portFlag = argv.find((a) => a.startsWith("--port="));
  const consolePort = portFlag ? Number(portFlag.slice("--port=".length)) : CONSOLE_DEFAULT_PORT;

  mkdirSync(join(dataDir, "db"), { recursive: true });
  const lock = acquireDaemonLock(dataDir);
  if (!lock.ok) {
    console.error(`another daemon (pid ${lock.heldBy}) holds ${lock.lockPath}; refusing to start`);
    process.exit(1);
  }

  const dbPath = join(dataDir, "db", "aegis.db");
  const db = openDatabase(dbPath);
  const canonical = loadCanonicalSchema();

  // Integrity before anything else. The PRE-migration snapshot comes strictly
  // BEFORE migrate() — it must hold the pre-apply state so a failed apply can
  // be rolled back (06 section 9 startup order). No snapshot is minted when
  // the schema is already current, because nothing will be applied.
  const integrity = checkDatabaseIntegrity(db);
  if (!integrity.ok) {
    console.error(`integrity check failed: ${integrity.detail}; opening read-only diagnostics only`);
    process.exit(2);
  }
  if (migrationPending(db)) {
    const backup = preMigrationBackup(db, { backupsDir: join(dataDir, "backups"), now: Date.now() });
    console.log(`backup: pre-migration snapshot ${backup.path} (${backup.bytes} bytes, integrity ${backup.integrity})`);
  }
  migrate(db, canonical);

  const recovery = startupRecovery(db, {
    stateDir: dataDir,
    canonical,
    now: Date.now(),
    maxAttempts: 3,
    unknownUsageTimeoutMs: 15 * 60 * 1000,
  });
  for (const a of recovery.actions) {
    console.log(`recovery ${a.ok ? "ok " : "FAIL"} ${a.step}: ${a.detail}`);
  }
  if (recovery.mode !== "open") {
    console.error(`recovery failed at ${recovery.failedStep}; read-only diagnostics only`);
  }

  // The console (Phase 2 minimal diagnostics) starts in EVERY mode: open
  // mode serves the full read-only surface, read-only mode keeps exactly the
  // diagnostics reachable and everything else answers 503.
  const { token } = ensureConsoleToken(dataDir);
  const consoleApp = createConsoleApp(db, { recovery, mode: recovery.mode, token, port: consolePort });
  const served = await serveConsole(consoleApp, { port: consolePort });
  console.log(`console: ${served.bind}:${served.port} (auth: local bearer token; diagnostics${recovery.mode === "open" ? "" : " only"})`);

  if (args.has("--check")) {
    console.log(`check: mode=${recovery.mode} steps=${recovery.actions.length} ${recovery.mode === "open" ? "GREEN" : "RED"}`);
    served.server.close();
    lock.release();
    process.exit(recovery.mode === "open" ? 0 : 3);
  }

  if (recovery.mode !== "open") {
    console.error("daemon loop not started: recovery is read-only, the console serves diagnostics only");
    let staying = true;
    process.on("SIGINT", () => {
      staying = false;
    });
    const hold = () => {
      if (!staying) {
        served.server.close();
        lock.release();
        process.exit(3);
      }
      setTimeout(hold, 1000);
    };
    hold();
    return 3;
  }

  const ledger = createBudgetLedger(db, {
    taskLimitMicrousd: config.budget.taskLimitMicrousd,
    dayLimitMicrousd: config.budget.dayLimitMicrousd,
    warmingEnabled: config.budget.warmingEnabled,
    timeZone: config.timezone,
  });
  const upstream = fakeUpstream ? createFakeRemote(dataDir, { label: "daemon-fake-upstream" }) : null;

  const tick = () => {
    const now = Date.now();
    // 1. Sweeps: leases, approvals, stale reminders, expired notifications.
    reapExpiredLeases(db, { now, maxAttempts: 3 });
    expireApprovals(db, { now });
    cancelSatisfiedFollowUpReminders(db, { now });
    expireStaleNotifications(db, { now });
    // 2. Timers generate durable inbox events.
    const timers = processDueTimers(db, { now });
    // 3. Pending inbox rows get their default dispatch plan — recovery from
    //    any crash never depends on an in-memory wakeup.
    const pending = db.prepare("SELECT * FROM inbox WHERE state='PENDING' AND verdict='ADMIT'").all();
    for (const row of pending) {
      dispatchEventToTask(db, {
        inboxId: row.id,
        dispatchKey: dispatchKeyForInbox(row),
        now,
        priority: row.priority,
        maxSteps: config.budget.taskMaxSteps,
        deadlineAt: now + config.budget.taskMaxWallClockMs,
        skillSetHash: "skillset-phase2-default",
      });
    }
    // 4. Claim and run the Phase 2 fake worker: heartbeat, one budgeted step
    //    (the chargeable-path gate refuses without the reservation), then a
    //    completion with evidence. Real agent execution is Phase 3+.
    const claim = claimNextTask(db, { now, leaseMs: config.leases.leaseMs });
    if (claim) {
      heartbeat(db, { ...claim, now, leaseMs: config.leases.leaseMs });
      const taskAcc = ledger.ensureTaskAccount({ taskId: claim.taskId, now }).accountId;
      const dayAcc = ledger.ensureDayAccount({ now }).accountId;
      const res = ledger.reserve({
        requestKey: `worker:${claim.taskId}:${claim.attemptNo}`,
        taskId: claim.taskId,
        purpose: "worker",
        provider: config.model.provider,
        priceVersion: "catalog-v1",
        upperMicrousd: 1000,
        accounts: [
          { accountId: taskAcc, amountMicrousd: 500 },
          { accountId: dayAcc, amountMicrousd: 500 },
        ],
        now,
      });
      workerStep(db, { ...claim, now, budgetReservationId: res.reservationId });
      ledger.settle({ reservationId: res.reservationId, usage: { actualMicrousd: 300 }, now });
      const scopeId = db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(claim.taskId).scope_id;
      const evidence = insertObjectRow(db, {
        scopeId,
        kind: "task_result",
        sourceUri: `task:${claim.taskId}`,
        sourceActor: "fake-worker",
        content: JSON.stringify({ done: true, at: now, worker: "phase2-fake" }),
        observedAt: now,
        requiredScopeIds: [scopeId],
      });
      completeTask(db, {
        taskId: claim.taskId,
        attemptNo: claim.attemptNo,
        leaseOwner: claim.leaseOwner,
        fence: claim.fence,
        now,
        resultClass: "not_applicable",
        resultObjectId: evidence.id,
      });
      const delivery = db
        .prepare("SELECT event_id FROM event_deliveries WHERE task_id=? AND state='PENDING'")
        .get(claim.taskId);
      if (delivery) {
        const ck = insertObjectRow(db, {
          scopeId,
          kind: "session_checkpoint",
          sourceUri: `cmd:${delivery.event_id}:${claim.taskId}`,
          sourceActor: "host",
          content: "fake worker consumed the event",
          observedAt: now,
          requiredScopeIds: [scopeId],
        });
        deliveryAckCheckpoint(db, { eventId: delivery.event_id, taskId: claim.taskId, checkpointObjectId: ck.id, now });
        deliveryDone(db, { eventId: delivery.event_id, taskId: claim.taskId, now });
      }
    }
    // 5. Effect dispatch only with an explicitly fake upstream; there is no
    //    real submitter in Phase 2 and the loop says so instead of pretending.
    if (upstream) {
      // Per-mode reconciliation of UNKNOWN effects (06 section 6 table) runs
      // IN the daemon: IDEMPOTENCY_KEY requeues for a same-key resend,
      // LOOKUP_THEN_RETRY records a strong-consistency hit or requeues only
      // a definitive not-found, AT_LEAST_ONCE requeues within its bounded
      // backoff, and AT_MOST_ONCE plus weak-visibility lookups stay UNKNOWN —
      // no blind retry ever leaves this loop.
      const unknowns = db
        .prepare("SELECT id, retry_mode FROM effects WHERE state='UNKNOWN'")
        .all();
      for (const u of unknowns) {
        try {
          const action = autoRecoverUnknown(db, upstream, { effectId: u.id, now, backoffMs: 0 });
          if (action.action !== "none") {
            console.log(`reconcile: ${u.id} (${u.retry_mode}) -> ${action.action}`);
          }
        } catch (err) {
          console.error(`reconcile refused ${u.id}: ${err.message}`);
        }
      }
      const ready = db
        .prepare("SELECT id FROM effects WHERE state='READY' AND next_attempt_at<=? ORDER BY next_attempt_at")
        .all(now);
      for (const e of ready) {
        try {
          dispatchEffect(db, upstream, { effectId: e.id, now, precondition: () => true });
        } catch (err) {
          console.error(`dispatcher refused ${e.id}: ${err.message}`);
        }
      }
    } else if (db.prepare("SELECT count(*) c FROM effects WHERE state='READY'").get().c > 0) {
      console.error("dispatcher: READY effects exist but no upstream adapter is wired (Phase 3); they stay durable and dispatched later");
    } else if (db.prepare("SELECT count(*) c FROM effects WHERE state='UNKNOWN'").get().c > 0) {
      // UNKNOWN without an upstream stays UNKNOWN, on the record: the daemon
      // never converts uncertainty into a success or a blind resend.
      console.error("reconcile: UNKNOWN effects present but no upstream adapter is wired; they stay UNKNOWN for a human or a later phase");
    }
    // 6. Outbox: only a report — delivery status lives in effects.state.
    const due = dueNotifications(db, { now });
    if (timers.fired.length > 0 || pending.length > 0 || claim || due.length > 0) {
      console.log(
        `tick: timers=${timers.fired.length} dispatched_pending=${pending.length} claimed=${claim ? claim.taskId : "none"} due_notifications=${due.length}`,
      );
    }
    return timers.fired.length + pending.length + (claim ? 1 : 0) + due.length;
  };

  if (args.has("--once")) {
    let rounds = 0;
    while (tick() > 0 && rounds < 20) {
      rounds += 1;
    }
    console.log(`once: ${rounds + 1} tick(s) to drain the durable backlog`);
    lock.release();
    process.exit(0);
  }

  // Continuous mode: drain until idle, then keep a slow heartbeat loop.
  console.log(`daemon: open (pid ${process.pid}) on ${dbPath}; fake upstream=${fakeUpstream}; loop every ${Math.max(config.leases.heartbeatMs, 1000)}ms`);
  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });
  const loop = () => {
    if (!running) {
      console.log("daemon: shutting down, releasing lock");
      lock.release();
      process.exit(0);
    }
    try {
      tick();
    } catch (e) {
      console.error(`tick error: ${e.message}`);
    }
    setTimeout(loop, Math.max(config.leases.heartbeatMs, 1000));
  };
  loop();
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("daemon.mjs")) {
  main();
}
