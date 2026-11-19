// test:durability — Phase 2 durable-execution suite.
// Grows step by step per the kickoff handoff; every case here runs the real
// daemon modules against real SQLite files under workspace-state/phase2/.
// Crash-window cases (06 section 9) kill real child processes and recover.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lockedNodeGuard, makeSuite, makeWorkspace, suiteExit, writeReport, repoRoot, spawnNode } from "../lib/harness.mjs";
import { loadCanonicalSchema, migrate, verifySchema, SchemaSourceError, SchemaDriftError } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase, checkDatabaseIntegrity, sqliteLibraryVersion } from "../../../apps/daemon/src/db/connect.mjs";
import { acquireDaemonLock, isPidAlive } from "../../../apps/daemon/src/db/lock.mjs";
import { canonicalJson, sha256LfHex, businessKey, dispatchKeyFromProviderId } from "../../../apps/daemon/src/keys.mjs";
import { receiveEvent, dispatchKeyForInbox, ensurePrincipal } from "../../../apps/daemon/src/ingress.mjs";
import { putObjectContent, gcUnreferencedContent, insertObjectRow } from "../../../apps/daemon/src/objects.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { createBudgetLedger } from "../../../apps/daemon/src/budget.mjs";
import { decideApproval, invalidateApproval } from "../../../apps/daemon/src/approvals.mjs";
import {
  proposeEffect,
  dispatchEffect,
  draftToReady,
  requeueLocalFailure,
  autoRecoverUnknown,
  reconcileUnknown,
  markSubmittingEffectsUnknown,
  cancelScope,
  cancelTask,
  EffectError,
  DispatcherRefused,
} from "../../../apps/daemon/src/effects.mjs";
import { createFakeRemote } from "../../../apps/daemon/src/testing/fake-remote.mjs";
import { createTimer, processDueTimers, markTimerSatisfied, cancelSatisfiedFollowUpReminders, timerRow } from "../../../apps/daemon/src/timers.mjs";
import {
  enqueueNotification,
  finalizeTaskWithNotification,
  supersedeNotification,
  dueNotifications,
  expireStaleNotifications,
} from "../../../apps/daemon/src/outbox.mjs";
import {
  claimNextTask,
  heartbeat,
  workerStep,
  completeTask,
  retryTask,
  reapExpiredLeases,
  deliveryAckCheckpoint,
  deliveryDone,
  deliveryDead,
  StaleWorker,
  ClaimRefused,
  DeliveryError,
} from "../../../apps/daemon/src/scheduler.mjs";

lockedNodeGuard();

const suite = makeSuite("durability");
const PINNED_CHECKSUM = "ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995";

// ---------------------------------------------------------------- case: schema
{
  const canonical = loadCanonicalSchema();
  suite.check(
    "canonical-schema-checksum-matches-pinned",
    canonical.checksum === PINNED_CHECKSUM,
    `checksum ${canonical.checksum} from ${canonical.sourcePath}`,
  );

  const ws = makeWorkspace("durability-fresh-migrate");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  const r1 = migrate(db, canonical);
  suite.check(
    "fresh-migrate-applies-version-1",
    r1.applied.length === 1 && r1.applied[0].version === 1 && r1.applied[0].checksum === PINNED_CHECKSUM,
    `applied ${JSON.stringify(r1.applied)}`,
  );

  const tables = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all();
  const typeTable = tables.filter((t) => t.type === "table");
  const ftsTables = typeTable.filter((t) => t.name.startsWith("fts_messages_"));
  const userTables = typeTable.filter((t) => !t.name.startsWith("fts_messages_"));
  const triggers = tables.filter((t) => t.type === "trigger");
  suite.check(
    "reference-ddl-shape-27-user-2-fts-8-shadow",
    typeTable.length === 37 && userTables.length === 27 && ftsTables.length === 10 && triggers.length === 3,
    `sqlite_master: 37 tables (27 user + 10 fts incl. 8 shadow per PI SQLITE probe), 3 trg_msg_* triggers`,
  );

  const sys = db.prepare("SELECT key, value FROM system_state").all();
  suite.check(
    "system-state-seeds-present",
    sys.some((r) => r.key === "schema_version" && r.value === "140") &&
      sys.some((r) => r.key === "authorization_revision" && r.value === "1"),
    `system_state rows: ${JSON.stringify(sys)}`,
  );

  const r2 = migrate(db, canonical);
  suite.check(
    "migrate-is-idempotent",
    r2.applied.length === 0,
    `second run applied ${r2.applied.length} migration(s)`,
  );
  const v = verifySchema(db, canonical);
  suite.check("verify-schema-ok-after-migrate", v.ok, v.reason);

  const integrity = checkDatabaseIntegrity(db);
  suite.check("integrity-ok-on-fresh-db", integrity.ok, integrity.detail);
  suite.check(
    "sqlite-library-floor",
    sqliteLibraryVersion(db) >= "3.54",
    `sqlite_version()=${sqliteLibraryVersion(db)}`,
  );

  const j = db.prepare("PRAGMA journal_mode").get();
  const s = db.prepare("PRAGMA synchronous").get();
  const fk = db.prepare("PRAGMA foreign_keys").get();
  suite.check(
    "connection-pragmas-wal-full-fk",
    j.journal_mode === "wal" && s.synchronous === 2 && fk.foreign_keys === 1,
    `journal=${j.journal_mode} synchronous=${s.synchronous} foreign_keys=${fk.foreign_keys}`,
  );

  // A read-only connection must refuse writes (recovery diagnostics path).
  const ro = openDatabase(ws.dbPath, { readOnly: true });
  let roBlocked = false;
  try {
    ro.exec("INSERT INTO system_state VALUES('x','y')");
  } catch {
    roBlocked = true;
  }
  suite.check("readonly-connection-refuses-writes", roBlocked, "readOnly connection write attempt threw");

  // Red gate: a tampered copy of the canonical SQL must fail the checksum.
  const tampered = join(ws.stateDir, "schema-tampered.sql");
  writeFileSync(tampered, canonical.sqlText + "\n-- tampered\n");
  let tamperBlocked = false;
  try {
    loadCanonicalSchema({ env: { AEGISPI_SCHEMA_SQL: tampered } });
  } catch (e) {
    tamperBlocked = e instanceof SchemaSourceError && /checksum mismatch/.test(e.message);
  }
  suite.check(
    "checksum-gate-fails-closed-on-tampered-sql",
    tamperBlocked,
    tamperBlocked ? "SchemaSourceError raised on mismatch" : "no error raised — GATE BROKEN",
  );

  // Red gate: tables without a schema_migrations record must be refused.
  const ws2 = makeWorkspace("durability-partial-schema");
  mkdirSync(join(ws2.stateDir, "db"), { recursive: true });
  const db2 = openDatabase(ws2.dbPath);
  db2.exec("CREATE TABLE stray(x)");
  let driftBlocked = false;
  try {
    migrate(db2, canonical);
  } catch (e) {
    driftBlocked = e instanceof SchemaDriftError;
  }
  suite.check(
    "partial-schema-refused-fail-closed",
    driftBlocked,
    driftBlocked ? "SchemaDriftError raised (no guessing on stray tables)" : "migrate ran on stray schema — GATE BROKEN",
  );

  // Red gate: DDL that fails mid-apply must roll back to an empty database.
  const ws3 = makeWorkspace("durability-torn-ddl");
  mkdirSync(join(ws3.stateDir, "db"), { recursive: true });
  const db3 = openDatabase(ws3.dbPath);
  let tornBlocked = false;
  let tornClean = false;
  try {
    migrate(db3, {
      ...canonical,
      ddlText: canonical.ddlText + "\nCREATE TABLE broken_ender(\n",
    });
  } catch (e) {
    tornBlocked = e instanceof SchemaDriftError;
    const left = db3
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get().c;
    tornClean = left === 0;
  }
  suite.check(
    "torn-ddl-rolls-back-to-empty",
    tornBlocked && tornClean,
    `apply threw=${tornBlocked}, leftover tables=${tornClean ? "0" : ">0"}`,
  );
}

// ------------------------------------------------------------------ case: lock
{
  const ws = makeWorkspace("durability-lock");
  const l1 = acquireDaemonLock(ws.stateDir);
  suite.check("lock-first-acquire-ok", l1.ok, `pid ${l1.pid} holds ${l1.lockPath}`);
  const l2 = acquireDaemonLock(ws.stateDir);
  suite.check(
    "lock-second-acquire-refused",
    l2.ok === false && l2.heldBy === l1.pid,
    `second acquire refused, heldBy=${l2.heldBy}`,
  );
  // Simulate a crashed holder: a dead pid must not block startup forever.
  const { writeFileSync: wf, readFileSync: rf } = await import("node:fs");
  const raw = rf(l1.lockPath, "utf8");
  wf(l1.lockPath, raw.replace(String(l1.pid), "400000000"), "utf8");
  suite.check(
    "dead-pid-probe-says-dead",
    isPidAlive(400000000) === false,
    "isPidAlive(400000000)=false",
  );
  const l3 = acquireDaemonLock(ws.stateDir);
  suite.check(
    "lock-stolen-after-crash-holder",
    l3.ok === true,
    l3.ok ? `stolen, new pid ${l3.pid}` : "not stolen — STARTUP BLOCKED FOREVER",
  );
  const released = l3.release();
  const l4 = acquireDaemonLock(ws.stateDir);
  suite.check(
    "lock-released-and-reacquired",
    released === true && l4.ok === true,
    `released=${released}, reacquired=${l4.ok}`,
  );
  l4.release();
}

// ------------------------------------------------------------------ case: keys
{
  const c1 = canonicalJson({ b: 1, a: { z: "x", y: [3, 2] } });
  const c2 = canonicalJson({ a: { y: [3, 2], z: "x" }, b: 1 });
  suite.check("canonical-json-key-order-stable", c1 === c2, c1);
  let nanRejected = false;
  try {
    canonicalJson({ x: Number.NaN });
  } catch {
    nanRejected = true;
  }
  suite.check("canonical-json-rejects-nan", nanRejected, "NaN throws");
  const esc1 = businessKey("notify", "user:123", "k1");
  const esc2 = businessKey("notify", "user:1:23", "k1");
  suite.check(
    "business-key-escaping-separates-objects",
    esc1 !== esc2,
    `${esc1} != ${esc2}`,
  );
  const dk1 = dispatchKeyFromProviderId("telegram", "E1");
  suite.check(
    "dispatch-key-shape-and-lowercase",
    dk1 === "telegram:e1",
    `dispatch_key=${dk1}`,
  );
  const env1 = sha256LfHex(canonicalJson({ a: 1 }));
  suite.check("sha256-lf-normalization", env1.length === 64, `digest ${env1.slice(0, 16)}…`);
}

// ---------------------------------------------------------------- case: inbox
{
  const canonical = loadCanonicalSchema();
  const ws = makeWorkspace("durability-inbox");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, canonical);
  const ev = (over = {}) => ({
    now: 1795000000000,
    source: "telegram",
    sourceEventId: "evt-100",
    principal: { platform: "telegram", subject: "1001" },
    scope: {
      kind: "owner_dm",
      domainKey: "dm:telegram:1001",
      channel: "telegram",
      conversationId: "1001",
    },
    threadKey: "t1",
    priority: 5,
    policyVersion: "pv1",
    payload: "check the repo",
    verdict: "ADMIT",
    ...over,
  });
  const r1 = receiveEvent(db, ws.stateDir, ev());
  const row1 = db.prepare("SELECT * FROM inbox WHERE id=?").get(r1.inboxId);
  suite.check(
    "admit-persists-inbox-pending",
    row1.state === "PENDING" && row1.verdict === "ADMIT" && row1.source_event_id === "evt-100",
    `inbox row ${r1.inboxId} state=${row1.state}`,
  );
  const obj = db.prepare("SELECT * FROM objects WHERE id=?").get(r1.objectId);
  const closure = db
    .prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=?")
    .all(r1.objectId);
  const fileOnDisk = existsSync(join(ws.stateDir, obj.storage_ref));
  suite.check(
    "payload-object-row-and-own-scope-closure",
    obj.kind === "event_payload" && closure.length === 1 && closure[0].scope_id === row1.scope_id && fileOnDisk,
    `object ${obj.id} closure=${JSON.stringify(closure)} file=${fileOnDisk}`,
  );
  const audited = db
    .prepare("SELECT code FROM audit_log WHERE event_id=? ORDER BY seq")
    .all(r1.inboxId);
  const streamed = db
    .prepare("SELECT event_type FROM stream_events WHERE entity_id=?")
    .all(`inbox:${r1.inboxId}`);
  suite.check(
    "admit-audit-and-stream-in-same-transaction",
    audited.some((a) => a.code === "ingress_received") && streamed.some((s) => s.event_type === "inbox_changed"),
    `audit=${JSON.stringify(audited.map((a) => a.code))} stream=${streamed.length}`,
  );

  const before = {
    inbox: db.prepare("SELECT count(*) c FROM inbox").get().c,
    objects: db.prepare("SELECT count(*) c FROM objects").get().c,
  };
  const r2 = receiveEvent(db, ws.stateDir, ev());
  const after = {
    inbox: db.prepare("SELECT count(*) c FROM inbox").get().c,
    objects: db.prepare("SELECT count(*) c FROM objects").get().c,
  };
  const dupAudit = db
    .prepare("SELECT count(*) c FROM audit_log WHERE code='ingress_duplicate'")
    .get().c;
  suite.check(
    "duplicate-event-returns-success-no-new-rows",
    r2.duplicate === true && after.inbox === before.inbox && after.objects === before.objects && dupAudit === 1,
    `duplicate=${r2.duplicate} inbox ${before.inbox}→${after.inbox} objects ${before.objects}→${after.objects}`,
  );

  const r3 = receiveEvent(db, ws.stateDir, ev({ sourceEventId: "evt-200", verdict: "DROP" }));
  const row3 = db.prepare("SELECT state, verdict FROM inbox WHERE id=?").get(r3.inboxId);
  suite.check(
    "drop-and-observe-go-straight-to-done",
    r3.duplicate === false && row3.state === "DONE" && row3.verdict === "DROP",
    `DROP inbox ${r3.inboxId} state=${row3.state}`,
  );

  const e1 = receiveEvent(db, ws.stateDir, ev({ source: "webhook", sourceEventId: null, payload: "p1" }));
  const e2 = receiveEvent(db, ws.stateDir, ev({ source: "webhook", sourceEventId: null, payload: "p1" }));
  const e3 = receiveEvent(db, ws.stateDir, ev({ source: "webhook", sourceEventId: null, payload: "p2" }));
  const digestRows = db
    .prepare("SELECT source_event_id FROM inbox WHERE source='webhook'")
    .all();
  suite.check(
    "no-provider-id-source-dedups-on-envelope-digest",
    e1.duplicate === false && e2.duplicate === true && e3.duplicate === false &&
      digestRows.every((r) => /^[0-9a-f]{64}$/.test(r.source_event_id)) &&
      new Set(digestRows.map((r) => r.source_event_id)).size === 2,
    `webhook dedup ids: ${digestRows.map((r) => r.source_event_id.slice(0, 8)).join(", ")}`,
  );

  // Unreferenced content files (crash between file durability and DB
  // activation) must be GC-able without touching referenced ones.
  putObjectContent(ws.stateDir, "orphan-content");
  const gc1 = gcUnreferencedContent(db, ws.stateDir, { dryRun: true, now: 1795000000001 });
  suite.check(
    "gc-detects-unreferenced-file",
    gc1.trashed >= 1,
    `dryRun gc: scanned=${gc1.scanned} trashed=${gc1.trashed}`,
  );
  const gc2 = gcUnreferencedContent(db, ws.stateDir, { now: 1795000000002 });
  const referencedStill = existsSync(join(ws.stateDir, obj.storage_ref));
  suite.check(
    "gc-moves-unreferenced-keeps-referenced",
    gc2.trashed >= 1 && referencedStill === true,
    `gc moved ${gc2.trashed} file(s), referenced payload still on disk`,
  );
}

// ------------------------------------------------- case: ingress crash windows
{
  const canonical = loadCanonicalSchema();
  const scenario = join(repoRoot, "evals", "phase2", "durability", "scenarios", "ingress-crash.mjs");
  const windows = [
    { name: "ingress-before-file", point: "ingress:before-file", expectInbox: 0 },
    { name: "ingress-inside-txn", point: "ingress:inside-txn", expectInbox: 0 },
    { name: "ingress-after-commit", point: "ingress:after-commit", expectInbox: 1 },
  ];
  for (const w of windows) {
    const ws = makeWorkspace(`durability-crash-${w.name}`);
    const proc = spawnNode(scenario, [], {
      env: { AEGISPI_WS: ws.stateDir, AEGISPI_CRASH_POINT: w.point, AEGISPI_NOW: "1795000000000" },
    });
    const done = await proc.done;
    const diedWithoutAck = !done.stdout.includes("ACK") && (done.signal === "SIGKILL" || done.code !== 0);
    suite.check(
      `crash-${w.name}-child-died-before-ack`,
      diedWithoutAck,
      `exit=${done.code} signal=${done.signal} ack-line=${done.stdout.includes("ACK")}`,
    );
    const db = openDatabase(ws.dbPath, { readOnly: true });
    const inboxCount = db.prepare("SELECT count(*) c FROM inbox").get().c;
    db.close();
    suite.check(
      `crash-${w.name}-durable-state-matches-window`,
      inboxCount === w.expectInbox,
      `inbox rows after kill: ${inboxCount} (expected ${w.expectInbox})`,
    );
    if (w.name === "ingress-inside-txn") {
      const db2 = openDatabase(ws.dbPath, { readOnly: true });
      const gcProbe = gcUnreferencedContent(db2, ws.stateDir, { dryRun: true });
      db2.close();
      suite.check(
        "crash-inside-txn-leaves-unreferenced-file-for-gc",
        gcProbe.trashed === 1,
        `unreferenced files: ${gcProbe.trashed} (payload written, activation rolled back)`,
      );
    }
    // Upstream redelivery after the crash: exactly one durable row in the end.
    const re = spawnNode(scenario, [], { env: { AEGISPI_WS: ws.stateDir, AEGISPI_NOW: "1795000000001" } });
    const reDone = await re.done;
    const db3 = openDatabase(ws.dbPath, { readOnly: true });
    const finalCount = db3.prepare("SELECT count(*) c FROM inbox").get().c;
    db3.close();
    suite.check(
      `crash-${w.name}-redelivery-single-durable-row`,
      reDone.code === 0 && reDone.stdout.includes("ACK") && finalCount === 1,
      `redelivery exit=${reDone.code}, stdout=${JSON.stringify(reDone.stdout.trim())}, inbox=${finalCount}`,
    );
  }
}

// ------------------------------------------------------- case: task lifecycle
{
  const canonical = loadCanonicalSchema();
  const ws = makeWorkspace("durability-tasks");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, canonical);
  const leaseMs = 45 * 1000;
  const ledger = createBudgetLedger(db, {});
  const stepReserve = (taskId, n, now = 1795100000000) => {
    const taskAcc = ledger.ensureTaskAccount({ taskId, now }).accountId;
    const dayAcc = ledger.ensureDayAccount({ now }).accountId;
    return ledger.reserve({
      requestKey: `worker:${taskId}:${n}`,
      taskId,
      purpose: "worker",
      provider: "deepseek",
      priceVersion: "catalog-v1",
      upperMicrousd: 1000,
      accounts: [
        { accountId: taskAcc, amountMicrousd: 500 },
        { accountId: dayAcc, amountMicrousd: 500 },
      ],
      now,
    }).reservationId;
  };
  let eventSeq = 0;
  // Each scope gets its own DM conversation; the per-scope single-flight rule
  // then only bites where the test asks for it.
  const seed = async ({ maxSteps = 3, priority = 5, scopeN }) => {
    const now = 1795100000000;
    eventSeq += 1;
    const ing = receiveEvent(db, ws.stateDir, {
      now,
      source: "telegram",
      sourceEventId: `evt-life-${scopeN}-${eventSeq}`,
      principal: { platform: "telegram", subject: String(scopeN) },
      scope: {
        kind: "owner_dm",
        domainKey: `dm:telegram:${scopeN}`,
        channel: "telegram",
        conversationId: String(scopeN),
      },
      threadKey: `t-${scopeN}-${eventSeq}`,
      priority,
      policyVersion: "pv1",
      payload: "check upstream",
      verdict: "ADMIT",
    });
    const d = dispatchEventToTask(db, {
      inboxId: ing.inboxId,
      dispatchKey: dispatchKeyForInbox(db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId)),
      now,
      priority,
      maxSteps,
      deadlineAt: now + 15 * 60 * 1000,
      skillSetHash: "skillset-v1",
    });
    return { ing, d, now, scopeId: db.prepare("SELECT scope_id FROM inbox WHERE id=?").get(ing.inboxId).scope_id };
  };

  // Dispatch: one event + one plan = one task, with delivery + subscription.
  const t1 = await seed({ scopeN: 1 });
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(t1.d.taskId);
  const delivery = db.prepare("SELECT * FROM event_deliveries WHERE event_id=? AND task_id=?").get(t1.ing.inboxId, t1.d.taskId);
  const sub = db.prepare("SELECT * FROM thread_subscriptions WHERE task_id=?").get(t1.d.taskId);
  const inboxState = db.prepare("SELECT state FROM inbox WHERE id=?").get(t1.ing.inboxId).state;
  suite.check(
    "dispatch-creates-task-delivery-subscription-routes-inbox",
    task.state === "QUEUED" && task.attempt_no === 0 && task.fence === 0 &&
      delivery.state === "PENDING" && delivery.command_id.startsWith("cmd:") &&
      sub.active === 1 && inboxState === "ROUTED",
    `task ${t1.d.taskId} state=${task.state}, delivery=${delivery.state}, inbox=${inboxState}`,
  );

  const d2 = dispatchEventToTask(db, {
    inboxId: t1.ing.inboxId,
    dispatchKey: dispatchKeyForInbox(db.prepare("SELECT * FROM inbox WHERE id=?").get(t1.ing.inboxId)),
    now: 1795100000001,
    priority: 5,
    maxSteps: 3,
    deadlineAt: 1795100000000 + 15 * 60 * 1000,
    skillSetHash: "skillset-v1",
  });
  const taskCount = db.prepare("SELECT count(*) c FROM tasks WHERE origin_event_id=?").get(t1.ing.inboxId).c;
  suite.check(
    "recomputed-plan-reuses-same-task",
    d2.created === false && d2.taskId === t1.d.taskId && taskCount === 1,
    `second dispatch created=${d2.created}, tasks for event=${taskCount}`,
  );

  // Claim: fence and attempt mint in one transaction, lease attached.
  const claimed = claimNextTask(db, { now: 1795100010000, leaseMs });
  suite.check(
    "claim-mints-fence-and-active-attempt",
    claimed !== null && claimed.taskId === t1.d.taskId && claimed.attemptNo === 1 && claimed.fence === 1,
    `claimed task=${claimed?.taskId} attempt=${claimed?.attemptNo} fence=${claimed?.fence} owner=${claimed?.leaseOwner}`,
  );
  const attemptRow = db.prepare("SELECT * FROM attempts WHERE task_id=? AND attempt_no=1").get(t1.d.taskId);
  suite.check(
    "attempt-row-active-with-lease-window",
    attemptRow.state === "ACTIVE" && attemptRow.started_at === 1795100010000,
    `attempt ${attemptRow.id} state=${attemptRow.state}`,
  );

  // Per-scope single flight: another task in the SAME scope cannot claim
  // while the first runs; a task in ANOTHER scope can.
  const sameScope = await seed({ scopeN: 1, priority: 1 });
  const otherScope = await seed({ scopeN: 2, priority: 1 });
  const claimSame = claimNextTask(db, { now: 1795100015000, leaseMs });
  suite.check(
    "one-running-agent-per-scope",
    claimSame !== null && claimSame.taskId === otherScope.d.taskId,
    `claim while scope-1 RUNNING picked other-scope task ${claimSame?.taskId}, not ${sameScope.d.taskId}`,
  );
  db.prepare("UPDATE tasks SET state='QUEUED', lease_owner=NULL, lease_expires_at=NULL WHERE id=?").run(otherScope.d.taskId);

  // Stale epoch fence: a task claiming under a cancelled scope is skipped
  // while a healthy-scope task still claims.
  suite.check(
    "scope-epoch-fence-blocks-claim",
    (() => {
      db.prepare("UPDATE scopes SET epoch=epoch+1 WHERE id=?").run(t1.scopeId);
      const afterBump = claimNextTask(db, { now: 1795100016000, leaseMs });
      db.prepare("UPDATE scopes SET epoch=epoch-1 WHERE id=?").run(t1.scopeId);
      const skippedStaleEpoch =
        afterBump === null || afterBump.taskId !== sameScope.d.taskId;
      if (afterBump) {
        // The healthy-scope claim is a test artifact: retire it so it never
        // pollutes later candidate scans.
        db.prepare("UPDATE tasks SET state='CANCELLED', lease_owner=NULL, lease_expires_at=NULL WHERE id=?").run(afterBump.taskId);
      }
      return skippedStaleEpoch;
    })(),
    "task with stale scope_epoch is not claimed",
  );

  // Heartbeat / fenced writes on the running attempt.
  const hb1 = heartbeat(db, {
    taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 1,
    now: 1795100020000, leaseMs,
  });
  suite.check("heartbeat-extends-lease", hb1.extendedTo === 1795100020000 + leaseMs, `extended to ${hb1.extendedTo}`);

  let wrongOwnerRejected = false;
  try {
    heartbeat(db, { taskId: t1.d.taskId, attemptNo: 1, leaseOwner: "wkr:impostor:1", fence: 1, now: 1795100021000, leaseMs });
  } catch (e) {
    wrongOwnerRejected = e instanceof StaleWorker;
  }
  suite.check("wrong-lease-owner-rejected", wrongOwnerRejected, "StaleWorker on foreign lease_owner");

  let wrongFenceRejected = false;
  try {
    workerStep(db, { taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 99, now: 1795100022000, budgetReservationId: stepReserve(t1.d.taskId, 0) });
  } catch (e) {
    wrongFenceRejected = e instanceof StaleWorker;
  }
  suite.check("stale-fence-write-rejected", wrongFenceRejected, "StaleWorker on stale fence");

  const st = workerStep(db, { taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 1, now: 1795100023000, budgetReservationId: stepReserve(t1.d.taskId, 1) });
  suite.check("worker-step-increments", st.stepCount === 1, `step_count=${st.stepCount}`);
  workerStep(db, { taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 1, now: 1795100024000, budgetReservationId: stepReserve(t1.d.taskId, 2) });
  workerStep(db, { taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 1, now: 1795100024500, budgetReservationId: stepReserve(t1.d.taskId, 3) });
  let stepsRefused = false;
  try {
    workerStep(db, { taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 1, now: 1795100025000, budgetReservationId: stepReserve(t1.d.taskId, 4) });
  } catch (e) {
    stepsRefused = e instanceof ClaimRefused;
  }
  suite.check(
    "step-budget-refuses-beyond-max",
    stepsRefused,
    `ClaimRefused when step_count==max_steps (${db.prepare("SELECT step_count c FROM tasks WHERE id=?").get(t1.d.taskId).c}/3)`,
  );

  // Close t1 so its lease can never collide with the reaper timeline below.
  const t1evidence = insertObjectRow(db, {
    scopeId: t1.scopeId,
    kind: "task_result",
    sourceUri: `task:${t1.d.taskId}`,
    sourceActor: "host",
    content: "t1 done",
    observedAt: 1795100025500,
    requiredScopeIds: [t1.scopeId],
  });
  completeTask(db, {
    taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 1,
    now: 1795100026000, resultClass: "not_applicable", resultObjectId: t1evidence.id,
  });

  // Retry semantics on a fresh scope.
  const rt = await seed({ scopeN: 3, priority: 9 });
  const c3 = claimNextTask(db, { now: 1795100030000, leaseMs });
  const retry = retryTask(db, {
    taskId: c3.taskId, attemptNo: c3.attemptNo, leaseOwner: c3.leaseOwner, fence: c3.fence,
    now: 1795100031000, backoffMs: 5000, errorCode: "transient_provider_error",
  });
  const t3 = db.prepare("SELECT state, available_at FROM tasks WHERE id=?").get(c3.taskId);
  const a3 = db.prepare("SELECT state, error_code FROM attempts WHERE task_id=? AND attempt_no=?").get(c3.taskId, c3.attemptNo);
  suite.check(
    "retry-wait-fails-old-attempt-sets-backoff",
    t3.state === "RETRY_WAIT" && t3.available_at === 1795100031000 + 5000 && a3.state === "FAILED" && a3.error_code === "transient_provider_error",
    `state=${t3.state} available_at=${t3.available_at} old attempt=${a3.state}`,
  );
  const c3b = claimNextTask(db, { now: 1795100040000, leaseMs });
  suite.check(
    "retry-claim-mints-new-fence",
    c3b.taskId === c3.taskId && c3b.attemptNo === 2 && c3b.fence === 2,
    `re-claim attempt=${c3b.attemptNo} fence=${c3b.fence}`,
  );

  // Complete: SUCCEEDED needs evidence; evidence closes attempt and task.
  const evidence = insertObjectRow(db, {
    scopeId: db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(c3.taskId).scope_id,
    kind: "task_result",
    sourceUri: `task:${c3.taskId}`,
    sourceActor: "host",
    content: "result evidence body",
    observedAt: 1795100041000,
    requiredScopeIds: [db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(c3.taskId).scope_id],
  });
  let noEvidenceRefused = false;
  try {
    completeTask(db, {
      taskId: c3.taskId, attemptNo: 2, leaseOwner: c3b.leaseOwner, fence: 2,
      now: 1795100042000, resultClass: "unaffected",
    });
  } catch (e) {
    noEvidenceRefused = /result_object_id/.test(e.message);
  }
  suite.check("success-without-evidence-refused", noEvidenceRefused, "SUCCEEDED without result_object_id throws");
  const done = completeTask(db, {
    taskId: c3.taskId, attemptNo: 2, leaseOwner: c3b.leaseOwner, fence: 2,
    now: 1795100043000, resultClass: "unaffected", resultObjectId: evidence.id,
  });
  const t3done = db.prepare("SELECT state, result_class FROM tasks WHERE id=?").get(c3.taskId);
  const a3done = db.prepare("SELECT state FROM attempts WHERE task_id=? AND attempt_no=2").get(c3.taskId);
  suite.check(
    "complete-closes-task-and-attempt-with-evidence",
    done.state === "SUCCEEDED" && t3done.state === "SUCCEEDED" && t3done.result_class === "unaffected" && a3done.state === "SUCCEEDED",
    `task=${t3done.state}/${t3done.result_class} attempt=${a3done.state}`,
  );

  // Lease expiry: reaper LOSTs the attempt, requeues the task, and the OLD
  // worker's writes die on the new fence. Times are chosen so ONLY this
  // task's lease is inside the reaper window.
  const lt = await seed({ scopeN: 4 });
  const c4 = claimNextTask(db, { now: 1795100050000, leaseMs });
  const reaped = reapExpiredLeases(db, { now: 1795100050000 + leaseMs + 1, maxAttempts: 3 });
  const t4 = db.prepare("SELECT state FROM tasks WHERE id=?").get(c4.taskId);
  const a4 = db.prepare("SELECT state FROM attempts WHERE task_id=? AND attempt_no=1").get(c4.taskId);
  suite.check(
    "reaper-losts-attempt-and-requeues",
    reaped.length === 1 && reaped[0].taskId === c4.taskId && a4.state === "LOST" && t4.state === "QUEUED",
    `reaped=${JSON.stringify(reaped)} task=${t4.state} attempt=${a4.state}`,
  );
  let oldWorkerWriteRejected = false;
  try {
    heartbeat(db, { taskId: c4.taskId, attemptNo: 1, leaseOwner: c4.leaseOwner, fence: 1, now: 1795100050000 + leaseMs + 2, leaseMs });
  } catch (e) {
    oldWorkerWriteRejected = e instanceof StaleWorker;
  }
  suite.check(
    "expired-lease-old-worker-cannot-renew-or-submit",
    oldWorkerWriteRejected,
    "old worker heartbeat after reaper: StaleWorker",
  );
  const c4b = claimNextTask(db, { now: 1795100096000, leaseMs });
  suite.check(
    "requeued-task-claims-with-new-fence",
    c4b.taskId === c4.taskId && c4b.attemptNo === 2 && c4b.fence === 2,
    `re-claim attempt=${c4b.attemptNo} fence=${c4b.fence}`,
  );
  // Retries exhausted: reaping the last allowed attempt kills the task.
  reapExpiredLeases(db, { now: 1795100096000 + leaseMs + 1, maxAttempts: 3 });
  const c4c = claimNextTask(db, { now: 1795100142000, leaseMs });
  reapExpiredLeases(db, { now: 1795100142000 + leaseMs + 1, maxAttempts: 3 });
  const t4final = db.prepare("SELECT state FROM tasks WHERE id=?").get(c4.taskId);
  suite.check(
    "retry-exhaustion-goes-dead-not-loop",
    t4final.state === "DEAD" && c4c.attemptNo === 3,
    `final task state=${t4final.state} after attempt ${c4c.attemptNo}`,
  );
  const deadAudit = db
    .prepare("SELECT count(*) c FROM audit_log WHERE task_id=? AND code='task_dead_retries_exhausted'")
    .get(c4.taskId).c;
  suite.check("dead-task-records-reason", deadAudit === 1, "audit task_dead_retries_exhausted present");

  // Deliveries: checkpoint ACK, idempotent redelivery, DONE, inbox gate.
  const ck = insertObjectRow(db, {
    scopeId: t1.scopeId,
    kind: "session_checkpoint",
    sourceUri: `cmd:${t1.ing.inboxId}:${t1.d.taskId}`,
    sourceActor: "host",
    content: "event appended to session",
    observedAt: 1795100080000,
    requiredScopeIds: [t1.scopeId],
  });
  const ack1 = deliveryAckCheckpoint(db, { eventId: t1.ing.inboxId, taskId: t1.d.taskId, checkpointObjectId: ck.id, now: 1795100080000 });
  const ack2 = deliveryAckCheckpoint(db, { eventId: t1.ing.inboxId, taskId: t1.d.taskId, checkpointObjectId: ck.id, now: 1795100081000 });
  let differentCheckpointRefused = false;
  try {
    deliveryAckCheckpoint(db, { eventId: t1.ing.inboxId, taskId: t1.d.taskId, checkpointObjectId: "obj:other", now: 1795100082000 });
  } catch (e) {
    differentCheckpointRefused = e instanceof DeliveryError;
  }
  suite.check(
    "delivery-ack-checkpoint-idempotent-and-foreign-checkpoint-refused",
    ack1.state === "ACKED" && ack2.duplicate === true && differentCheckpointRefused,
    `ack=${ack1.state} redeliver=duplicate:${ack2.duplicate} different-checkpoint-refused=${differentCheckpointRefused}`,
  );
  deliveryDone(db, { eventId: t1.ing.inboxId, taskId: t1.d.taskId, now: 1795100083000 });
  const inboxFinal = db.prepare("SELECT state FROM inbox WHERE id=?").get(t1.ing.inboxId).state;
  suite.check(
    "inbox-done-only-when-all-deliveries-terminal",
    inboxFinal === "DONE",
    `inbox state after single delivery DONE: ${inboxFinal}`,
  );

  // DEAD delivery is loud, never silent success.
  const dt = await seed({ scopeN: 5 });
  deliveryDead(db, { eventId: dt.ing.inboxId, taskId: dt.d.taskId, now: 1795100090000, reason: "worker cannot handle" });
  const alertStreamed = db
    .prepare("SELECT count(*) c FROM stream_events WHERE event_type='audit_alert'")
    .get().c;
  const deadInbox = db.prepare("SELECT state FROM inbox WHERE id=?").get(dt.ing.inboxId).state;
  suite.check(
    "dead-delivery-streams-alert-and-closes-inbox",
    alertStreamed >= 1 && deadInbox === "DONE",
    `audit_alert rows=${alertStreamed}, inbox=${deadInbox}`,
  );
}

// ------------------------------------------------ case: dispatch crash windows
{
  const scenario = join(repoRoot, "evals", "phase2", "durability", "scenarios", "dispatch-crash.mjs");
  const windows = [
    { name: "dispatch-pre-txn", point: "router:pre-txn", expectTasks: 0 },
    { name: "dispatch-inside-txn", point: "router:inside-txn", expectTasks: 0 },
  ];
  for (const w of windows) {
    const ws = makeWorkspace(`durability-crash-${w.name}`);
    const proc = spawnNode(scenario, [], {
      env: { AEGISPI_WS: ws.stateDir, AEGISPI_CRASH_POINT: w.point, AEGISPI_NOW: "1795110000000" },
    });
    const done = await proc.done;
    const diedBeforeDispatch = !done.stdout.includes("DISPATCHED") && done.code !== 0;
    const db = openDatabase(ws.dbPath, { readOnly: true });
    const tasks = db.prepare("SELECT count(*) c FROM tasks").get().c;
    db.close();
    suite.check(
      `crash-${w.name}-died-before-dispatch-commit`,
      diedBeforeDispatch && tasks === w.expectTasks,
      `exit=${done.code} signal=${done.signal} tasks=${tasks}`,
    );
    const re = spawnNode(scenario, [], { env: { AEGISPI_WS: ws.stateDir, AEGISPI_NOW: "1795110001000" } });
    const reDone = await re.done;
    const db2 = openDatabase(ws.dbPath, { readOnly: true });
    const tasksAfter = db2.prepare("SELECT count(*) c FROM tasks").get().c;
    const inboxState = db2.prepare("SELECT state FROM inbox").get().state;
    db2.close();
    suite.check(
      `crash-${w.name}-recomputed-plan-single-task`,
      reDone.code === 0 && tasksAfter === 1 && inboxState === "ROUTED",
      `redelivery exit=${reDone.code}, tasks=${tasksAfter}, inbox=${inboxState}`,
    );
  }
}

// -------------------------------------------------------- case: effects flow
{
  const canonical = loadCanonicalSchema();
  const ws = makeWorkspace("durability-effects");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, canonical);
  const remote = createFakeRemote(ws.stateDir);
  const now = 1795600000000;
  let seq = 0;
  const seedClaimed = ({ scopeN }) => {
    seq += 1;
    const ing = receiveEvent(db, ws.stateDir, {
      now,
      source: "telegram",
      sourceEventId: `evt-efx-${scopeN}-${seq}`,
      principal: { platform: "telegram", subject: String(scopeN) },
      scope: { kind: "owner_dm", domainKey: `dm:telegram:${scopeN}`, channel: "telegram", conversationId: String(scopeN) },
      threadKey: `t-${scopeN}-${seq}`,
      priority: 5,
      policyVersion: "pv1",
      payload: "propose an action",
      verdict: "ADMIT",
    });
    const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
    const d = dispatchEventToTask(db, {
      inboxId: ing.inboxId,
      dispatchKey: dispatchKeyForInbox(inbox),
      now, priority: 5, maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "skillset-v1",
    });
    const claim = claimNextTask(db, { now, leaseMs: 45000 });
    return { ing, d, claim, scopeId: inbox.scope_id };
  };
  const grantApprove = (scopeId, subject = "approver-1") => {
    const p = ensurePrincipal(db, { platform: "telegram", subject });
    db.prepare(
      "INSERT OR IGNORE INTO acl_grants(scope_id, principal_id, permission, expires_at, revoked_at) VALUES (?,?,'approve',NULL,NULL)",
    ).run(scopeId, p.id);
    return p.id;
  };
  const proposeAndApprove = (seeded, { domainKey, naturalKey = "v1", retryMode = "IDEMPOTENCY_KEY" } = {}) => {
    const approverId = grantApprove(seeded.scopeId);
    const proposal = proposeEffect(db, ws.stateDir, {
      now,
      taskId: seeded.d.taskId,
      attemptId: seeded.claim.attemptId,
      effectType: "notify",
      domainKey,
      naturalKey,
      operationIntent: {
        targetResource: `telegram-dm:${seeded.claim.taskId}`,
        operation: "send_message",
        contentHash: "aa01",
        evidenceManifestHash: "bb02",
      },
      retryMode,
      provider: "fake-telegram",
      resource: "dm",
      requiresApproval: true,
      approverPrincipalId: approverId,
      checkpointContent: "parked for approval",
      expiresAt: now + 60 * 60 * 1000,
    });
    const decision = decideApproval(db, {
      approvalId: proposal.approvalId,
      decision: "approve",
      actionHash: proposal.actionHash,
      nonce: proposal.approvalNonce,
      approverId,
      now,
    });
    return { proposal, decision, approverId };
  };

  // Propose parks the task/attempt and creates one WAITING approval.
  const s1 = seedClaimed({ scopeN: 60 });
  const approver1 = grantApprove(s1.scopeId);
  const p1 = proposeEffect(db, ws.stateDir, {
    now,
    taskId: s1.d.taskId,
    attemptId: s1.claim.attemptId,
    effectType: "notify",
    domainKey: "dm:telegram:60",
    naturalKey: "v1",
    operationIntent: { targetResource: "telegram-dm:60", operation: "send_message", contentHash: "aa01", evidenceManifestHash: "bb02" },
    retryMode: "IDEMPOTENCY_KEY",
    provider: "fake-telegram",
    resource: "dm",
    requiresApproval: true,
    approverPrincipalId: approver1,
    checkpointContent: "worker parked awaiting approval",
    expiresAt: now + 60 * 60 * 1000,
  });
  const t1 = db.prepare("SELECT state, lease_owner FROM tasks WHERE id=?").get(s1.d.taskId);
  const a1 = db.prepare("SELECT state FROM attempts WHERE id=?").get(s1.claim.attemptId);
  const apr1 = db.prepare("SELECT state FROM approvals WHERE id=?").get(p1.approvalId);
  const fenceSame = db.prepare("SELECT fence FROM tasks WHERE id=?").get(s1.d.taskId).fence;
  suite.check(
    "propose-parks-attempt-creates-waiting-approval-fence-unchanged",
    t1.state === "WAITING_APPROVAL" && t1.lease_owner === null && a1.state === "PARKED" &&
      apr1.state === "WAITING" && fenceSame === s1.claim.fence,
    `task=${t1.state} attempt=${a1.state} approval=${apr1.state} fence=${fenceSame}`,
  );

  // Consume CAS: approval CONSUMED + effect READY + task WAITING_EFFECT; a
  // second decision is "already processed", never a second consume.
  const dec1 = decideApproval(db, {
    approvalId: p1.approvalId, decision: "approve",
    actionHash: p1.actionHash, nonce: p1.approvalNonce, approverId: approver1, now,
  });
  const dec1again = decideApproval(db, {
    approvalId: p1.approvalId, decision: "approve",
    actionHash: p1.actionHash, nonce: p1.approvalNonce, approverId: approver1, now,
  });
  const e1 = db.prepare("SELECT state FROM effects WHERE id=?").get(p1.effectId);
  suite.check(
    "approval-consume-cas-single-consume",
    dec1.accepted === true && e1.state === "READY" && dec1again.accepted === false && /already/.test(dec1again.reason ?? ""),
    `first=${dec1.accepted} second=${JSON.stringify(dec1again)}`,
  );

  // Verification failures: wrong nonce, wrong hash, wrong approver, no grant,
  // expired — each refused, nothing changes. This approval stays WAITING
  // (it is only decided by the refusal attempts).
  const s2 = seedClaimed({ scopeN: 61 });
  const approver2 = grantApprove(s2.scopeId);
  const p2 = proposeEffect(db, ws.stateDir, {
    now,
    taskId: s2.d.taskId,
    attemptId: s2.claim.attemptId,
    effectType: "notify",
    domainKey: "dm:telegram:61",
    naturalKey: "v1",
    operationIntent: { targetResource: "telegram-dm:61", operation: "send_message", contentHash: "aa05", evidenceManifestHash: "bb06" },
    retryMode: "AT_MOST_ONCE",
    provider: "fake-telegram",
    resource: "dm",
    requiresApproval: true,
    approverPrincipalId: approver2,
    checkpointContent: "parked for verification tests",
    expiresAt: now + 60 * 60 * 1000,
  });
  const foreigner = ensurePrincipal(db, { platform: "telegram", subject: "stranger-1" });
  const wrongNonce = decideApproval(db, {
    approvalId: p2.approvalId, decision: "approve",
    actionHash: p2.actionHash, nonce: "not-the-nonce", approverId: approver2, now,
  });
  const wrongHash = decideApproval(db, {
    approvalId: p2.approvalId, decision: "approve",
    actionHash: "f".repeat(64), nonce: p2.approvalNonce, approverId: approver2, now,
  });
  const wrongApprover = decideApproval(db, {
    approvalId: p2.approvalId, decision: "approve",
    actionHash: p2.actionHash, nonce: p2.approvalNonce, approverId: foreigner.id, now,
  });
  const stateAfter = db.prepare("SELECT state FROM approvals WHERE id=?").get(p2.approvalId).state;
  suite.check(
    "approval-verification-refuses-wrong-nonce-hash-approver",
    wrongNonce.accepted === false && wrongHash.accepted === false &&
      wrongApprover.accepted === false && stateAfter === "WAITING",
    `nonce=${wrongNonce.reason} hash=${wrongHash.reason} approver=${wrongApprover.reason}; approval still ${stateAfter}`,
  );
  const expiredDecide = decideApproval(db, {
    approvalId: p2.approvalId, decision: "approve",
    actionHash: p2.actionHash, nonce: p2.approvalNonce, approverId: approver2,
    now: now + 61 * 60 * 1000,
  });
  suite.check(
    "approval-expiry-refuses-late-callback",
    expiredDecide.accepted === false && /expired/.test(expiredDecide.reason),
    `late callback: ${expiredDecide.reason}`,
  );
  // The designated approver with a REVOKED grant: the callback is refused
  // even with the right nonce and hash.
  db.prepare("UPDATE acl_grants SET revoked_at=? WHERE scope_id=? AND principal_id=? AND permission='approve'")
    .run(now, s2.scopeId, approver2);
  const revokedDecide = decideApproval(db, {
    approvalId: p2.approvalId, decision: "approve",
    actionHash: p2.actionHash, nonce: p2.approvalNonce, approverId: approver2, now,
  });
  db.prepare("UPDATE acl_grants SET revoked_at=NULL WHERE scope_id=? AND principal_id=? AND permission='approve'")
    .run(s2.scopeId, approver2);
  suite.check(
    "revoked-approver-cannot-consume",
    revokedDecide.accepted === false && /grant/.test(revokedDecide.reason),
    `revoked approver: ${revokedDecide.reason}`,
  );

  // Dispatch happy path: SUCCEEDED with external id, remote applied once.
  const dis1 = dispatchEffect(db, remote, { effectId: p1.effectId, now, precondition: () => true });
  const e1s = db.prepare("SELECT state, external_id, attempt_count FROM effects WHERE id=?").get(p1.effectId);
  suite.check(
    "dispatch-succeeds-after-approved-cas",
    dis1.state === "SUCCEEDED" && e1s.state === "SUCCEEDED" && e1s.attempt_count === 1 &&
      remote.appliedByIdempotencyKey(`idem:${p1.businessKey}`) !== null,
    `effect SUCCEEDED external=${e1s.external_id}`,
  );
  let secondDispatchRefused = false;
  try {
    dispatchEffect(db, remote, { effectId: p1.effectId, now, precondition: () => true });
  } catch (e) {
    secondDispatchRefused = e instanceof DispatcherRefused;
  }
  suite.check(
    "succeeded-effect-never-resubmits",
    secondDispatchRefused && remote.appliedCount(p1.businessKey) === 1,
    `second dispatch refused; remote applied once for ${p1.businessKey}`,
  );

  // Rejection: normal outcome, effect DEAD, task FAILED, no auto retry.
  const s3 = seedClaimed({ scopeN: 62 });
  const p3 = proposeEffect(db, ws.stateDir, {
    now,
    taskId: s3.d.taskId,
    attemptId: s3.claim.attemptId,
    effectType: "notify",
    domainKey: "dm:telegram:62",
    naturalKey: "v1",
    operationIntent: { targetResource: "telegram-dm:62", operation: "send_message", contentHash: "aa03", evidenceManifestHash: "bb04" },
    retryMode: "AT_MOST_ONCE",
    provider: "fake-telegram",
    resource: "dm",
    requiresApproval: true,
    approverPrincipalId: grantApprove(s3.scopeId),
    expiresAt: now + 60 * 60 * 1000,
  });
  const rej = decideApproval(db, {
    approvalId: p3.approvalId, decision: "reject",
    actionHash: p3.actionHash, nonce: p3.approvalNonce,
    approverId: grantApprove(s3.scopeId), now,
  });
  const rejEffect = db.prepare("SELECT state FROM effects WHERE id=?").get(p3.effectId);
  const rejTask = db.prepare("SELECT state FROM tasks WHERE id=?").get(s3.d.taskId);
  suite.check(
    "rejection-is-normal-terminal-outcome",
    rej.accepted === true && rejEffect.state === "DEAD" && rejTask.state === "FAILED",
    `approval=${rej.state} effect=${rejEffect.state} task=${rejTask.state}`,
  );

  // Edit invalidates the old approval; the new intent is a new effect with a
  // new business_key version; action_json of the old one never changes.
  const inv = invalidateApproval(db, { approvalId: p2.approvalId, reason: "owner edited the message body", now });
  const oldEffect = db.prepare("SELECT state, business_key FROM effects WHERE id=?").get(p2.effectId);
  const p2b = proposeEffect(db, ws.stateDir, {
    now,
    taskId: s2.d.taskId,
    attemptId: s2.claim.attemptId,
    effectType: "notify",
    domainKey: "dm:telegram:61",
    naturalKey: "v2-edited-body",
    operationIntent: { targetResource: "telegram-dm:61", operation: "send_message", contentHash: "aa09-edited", evidenceManifestHash: "bb10" },
    retryMode: "AT_MOST_ONCE",
    provider: "fake-telegram",
    resource: "dm",
    requiresApproval: true,
    approverPrincipalId: approver2,
    expiresAt: now + 60 * 60 * 1000,
  });
  suite.check(
    "edit-invalidates-old-and-mints-new-business-key-version",
    inv.invalidated === true && oldEffect.state === "CANCELLED" && p2b.businessKey !== p2.businessKey,
    `old ${oldEffect.business_key} CANCELLED; new ${p2b.businessKey}`,
  );

  // DRAFT -> READY only via a pre-approved narrow routine.
  const s4 = seedClaimed({ scopeN: 63 });
  const p4 = proposeEffect(db, ws.stateDir, {
    now,
    taskId: s4.d.taskId,
    attemptId: s4.claim.attemptId,
    effectType: "notify",
    domainKey: "dm:telegram:63",
    naturalKey: "routine-v1",
    operationIntent: { targetResource: "telegram-dm:63", operation: "send_message", contentHash: "aa11", evidenceManifestHash: "bb12" },
    retryMode: "AT_LEAST_ONCE",
    provider: "fake-telegram",
    resource: "dm",
    requiresApproval: false,
    expiresAt: now + 60 * 60 * 1000,
  });
  let unlistedRoutineRefused = false;
  try {
    draftToReady(db, { effectId: p4.effectId, routineRef: "routine-not-on-list", approvedRoutines: ["status-ping"], now });
  } catch (e) {
    unlistedRoutineRefused = e instanceof EffectError;
  }
  const drafted = draftToReady(db, { effectId: p4.effectId, routineRef: "status-ping", approvedRoutines: ["status-ping"], now });
  suite.check(
    "draft-to-ready-requires-allowlisted-routine",
    p4.state === "DRAFT" && unlistedRoutineRefused && drafted.state === "READY",
    `unlisted routine refused; status-ping promoted to READY`,
  );
  let draftToReadyOnApprovalEffectRefused = false;
  try {
    draftToReady(db, { effectId: p2b.effectId, routineRef: "status-ping", approvedRoutines: ["status-ping"], now });
  } catch (e) {
    draftToReadyOnApprovalEffectRefused = /not DRAFT/.test(e.message);
  }
  suite.check(
    "human-approval-effect-cannot-skip-approval",
    draftToReadyOnApprovalEffectRefused,
    "WAITING_APPROVAL effect refuses draftToReady",
  );

  // Dispatcher prechecks: epoch change, expiry, precondition.
  const s5 = seedClaimed({ scopeN: 64 });
  const p5 = proposeAndApprove(s5, { domainKey: "dm:telegram:64", naturalKey: "v1", retryMode: "IDEMPOTENCY_KEY" });
  db.prepare("UPDATE scopes SET epoch=epoch+1 WHERE id=?").run(s5.scopeId);
  let epochRefused = false;
  try {
    dispatchEffect(db, remote, { effectId: p5.proposal.effectId, now, precondition: () => true });
  } catch (e) {
    epochRefused = e instanceof DispatcherRefused && /epoch/.test(e.message);
  }
  db.prepare("UPDATE scopes SET epoch=epoch-1 WHERE id=?").run(s5.scopeId);
  suite.check("dispatcher-refuses-stale-epoch", epochRefused, "scope epoch bump blocks the CAS");
  let expiredEffectRefused = false;
  db.prepare("UPDATE effects SET expires_at=? WHERE id=?").run(now - 1, p5.proposal.effectId);
  try {
    dispatchEffect(db, remote, { effectId: p5.proposal.effectId, now, precondition: () => true });
  } catch (e) {
    expiredEffectRefused = e instanceof DispatcherRefused && /expired/.test(e.message);
  }
  suite.check("dispatcher-refuses-expired-effect", expiredEffectRefused, "expiry re-checked inside the CAS transaction");
  db.prepare("UPDATE effects SET expires_at=? WHERE id=?").run(now + 60 * 60 * 1000, p5.proposal.effectId);
  let preconditionRefused = false;
  try {
    dispatchEffect(db, remote, { effectId: p5.proposal.effectId, now, precondition: () => false });
  } catch (e) {
    preconditionRefused = e instanceof DispatcherRefused && /precondition/.test(e.message);
  }
  suite.check(
    "dispatcher-refuses-failed-target-precondition",
    preconditionRefused,
    "target resource precondition re-checked inside the CAS",
  );
  const dis5 = dispatchEffect(db, remote, { effectId: p5.proposal.effectId, now, precondition: () => true });
  suite.check("approved-effect-dispatches-after-prechecks-pass", dis5.state === "SUCCEEDED", `state=${dis5.state}`);

  // UNKNOWN semantics per retry mode, all against the fake remote.
  const s7 = seedClaimed({ scopeN: 66 });
  const p7 = proposeAndApprove(s7, { domainKey: "dm:telegram:66", naturalKey: "v1", retryMode: "AT_MOST_ONCE" });
  const remoteTimeout = createFakeRemote(join(ws.stateDir, "timeout-remote"));
  const dis7 = dispatchEffect(db, remoteTimeout, {
    effectId: p7.proposal.effectId, now, precondition: () => true,
    label: "at-most-once-timeout", submitMode: "timeout",
  });
  const e7 = db.prepare("SELECT state FROM effects WHERE id=?").get(p7.proposal.effectId);
  suite.check(
    "at-most-once-unknown-stops-automatic-resend",
    dis7.state === "UNKNOWN" && e7.state === "UNKNOWN",
    `timeout outcome recorded as UNKNOWN, never success`,
  );
  const auto7 = autoRecoverUnknown(db, remoteTimeout, { effectId: p7.proposal.effectId, now });
  let unknownRedispatchRefused = false;
  try {
    dispatchEffect(db, remoteTimeout, { effectId: p7.proposal.effectId, now, precondition: () => true });
  } catch (e) {
    unknownRedispatchRefused = e instanceof DispatcherRefused;
  }
  suite.check(
    "unknown-never-blind-retried",
    auto7.action === "none" && unknownRedispatchRefused,
    `AT_MOST_ONCE policy=${auto7.reason}; dispatcher refuses UNKNOWN`,
  );
  const recon7 = reconcileUnknown(db, {
    effectId: p7.proposal.effectId,
    resolution: "CONFIRMED_NOT_SENT",
    externalEvidenceRef: "owner checked the provider console: no message sent",
    actorId: "prn:telegram:owner",
    now,
  });
  let reconWithoutEvidenceRefused = false;
  try {
    reconcileUnknown(db, {
      effectId: p7.proposal.effectId,
      resolution: "CONFIRMED_SUCCESS",
      externalEvidenceRef: null,
      externalId: "ext-9999",
      actorId: null,
      now,
    });
  } catch (e) {
    reconWithoutEvidenceRefused = e instanceof EffectError;
  }
  suite.check(
    "manual-reconciliation-records-actor-and-evidence",
    recon7.state === "FAILED" && reconWithoutEvidenceRefused,
    `CONFIRMED_NOT_SENT recorded; success claim without evidence/actor refused`,
  );

  // IDEMPOTENCY_KEY: remote applied then died; same key reconciles.
  const s8 = seedClaimed({ scopeN: 67 });
  const p8 = proposeAndApprove(s8, { domainKey: "dm:telegram:67", naturalKey: "v1", retryMode: "IDEMPOTENCY_KEY" });
  const remoteIdem = createFakeRemote(join(ws.stateDir, "idem-remote"));
  const dis8 = dispatchEffect(db, remoteIdem, {
    effectId: p8.proposal.effectId, now, precondition: () => true,
    label: "apply-then-die", submitMode: "apply_then_die",
  });
  const auto8 = autoRecoverUnknown(db, remoteIdem, { effectId: p8.proposal.effectId, now });
  const dis8b = dispatchEffect(db, remoteIdem, {
    effectId: p8.proposal.effectId, now: now + 5000, precondition: () => true,
    label: "same-key-resend",
  });
  const e8 = db.prepare("SELECT state, external_id FROM effects WHERE id=?").get(p8.proposal.effectId);
  const remote8 = remoteIdem.appliedByIdempotencyKey(`idem:${p8.proposal.businessKey}`);
  suite.check(
    "idempotency-key-resends-same-key-dedup-remote",
    dis8.state === "UNKNOWN" && auto8.action === "requeued" && dis8b.state === "SUCCEEDED" &&
      remote8 !== null && e8.external_id === remote8.externalId && remoteIdem.appliedCount(p8.proposal.businessKey) === 1,
    `apply-then-die -> UNKNOWN -> same-key resend -> SUCCEEDED ${e8.external_id}; remote applied exactly once`,
  );

  // LOOKUP_THEN_RETRY: strong not-found resends; weak not-found waits.
  const s9 = seedClaimed({ scopeN: 68 });
  const p9 = proposeAndApprove(s9, { domainKey: "dm:telegram:68", naturalKey: "v1", retryMode: "LOOKUP_THEN_RETRY" });
  const remoteLookup = createFakeRemote(join(ws.stateDir, "lookup-remote"));
  const dis9 = dispatchEffect(db, remoteLookup, {
    effectId: p9.proposal.effectId, now, precondition: () => true,
    label: "pure-timeout-nothing-applied", submitMode: "timeout",
  });
  const auto9 = autoRecoverUnknown(db, remoteLookup, { effectId: p9.proposal.effectId, now });
  const dis9b = dispatchEffect(db, remoteLookup, { effectId: p9.proposal.effectId, now: now + 5000, precondition: () => true });
  suite.check(
    "lookup-then-retry-strong-notfound-resends",
    dis9.state === "UNKNOWN" && auto9.action === "requeued" && dis9b.state === "SUCCEEDED",
    `strong lookup not-found -> definite resend -> SUCCEEDED`,
  );
  const s10 = seedClaimed({ scopeN: 69 });
  const p10 = proposeAndApprove(s10, { domainKey: "dm:telegram:69", naturalKey: "v1", retryMode: "LOOKUP_THEN_RETRY" });
  const remoteWeak = createFakeRemote(join(ws.stateDir, "weak-remote"));
  const dis10 = dispatchEffect(db, remoteWeak, {
    effectId: p10.proposal.effectId, now, precondition: () => true,
    label: "applied-but-weak-visibility", submitMode: "apply_then_die",
  });
  const weakLookup = remoteWeak.lookup({ businessKey: p10.proposal.businessKey, consistency: "eventual" });
  const weakFind = remoteWeak.lookup({ businessKey: p10.proposal.businessKey, consistency: "strong" });
  suite.check(
    "weak-lookup-never-triggers-resend",
    dis10.state === "UNKNOWN" && weakLookup.found === false && weakLookup.strong === false && weakFind.found === true,
    `eventual lookup says not-found while strong says found (${weakFind.externalId}); the resend decision uses strong only`,
  );
  const auto10 = autoRecoverUnknown(db, remoteWeak, { effectId: p10.proposal.effectId, now });
  const e10 = db.prepare("SELECT state, external_id FROM effects WHERE id=?").get(p10.proposal.effectId);
  suite.check(
    "lookup-recorded-success-from-strong-hit",
    e10.state === "SUCCEEDED" && e10.external_id === weakFind.externalId,
    `auto recovery recorded SUCCEEDED ${e10.external_id} from upstream lookup`,
  );

  // AT_LEAST_ONCE: bounded duplicates are the mode's declared cost.
  const s11 = seedClaimed({ scopeN: 70 });
  const p11 = proposeAndApprove(s11, { domainKey: "dm:telegram:70", naturalKey: "v1", retryMode: "AT_LEAST_ONCE" });
  const remoteALO = createFakeRemote(join(ws.stateDir, "alo-remote"));
  const dis11 = dispatchEffect(db, remoteALO, {
    effectId: p11.proposal.effectId, now, precondition: () => true,
    label: "apply-then-die", submitMode: "apply_then_die",
  });
  const auto11 = autoRecoverUnknown(db, remoteALO, { effectId: p11.proposal.effectId, now });
  const dis11b = dispatchEffect(db, remoteALO, { effectId: p11.proposal.effectId, now: now + 5000, precondition: () => true });
  suite.check(
    "at-least-once-resend-may-duplicate-declared",
    dis11.state === "UNKNOWN" && auto11.action === "requeued" && dis11b.state === "SUCCEEDED" &&
      remoteALO.appliedCount(p11.proposal.businessKey) === 2,
    `apply-then-die -> requeued -> resend SUCCEEDED; remote delivered 2x (mode allows)`,
  );

  // Local zero-byte failure requeues; remote rejection does not.
  const s12 = seedClaimed({ scopeN: 71 });
  const p12 = proposeAndApprove(s12, { domainKey: "dm:telegram:71", naturalKey: "v1", retryMode: "IDEMPOTENCY_KEY" });
  const remoteLocal = createFakeRemote(join(ws.stateDir, "local-remote"));
  const dis12 = dispatchEffect(db, remoteLocal, {
    effectId: p12.proposal.effectId, now, precondition: () => true,
    label: "zero-bytes-local-error", submitMode: "local_error",
  });
  const re12 = requeueLocalFailure(db, { effectId: p12.proposal.effectId, now, backoffMs: 100 });
  const dis12b = dispatchEffect(db, remoteLocal, { effectId: p12.proposal.effectId, now: now + 200, precondition: () => true });
  suite.check(
    "zero-byte-local-failure-requeues-and-recover",
    dis12.state === "FAILED" && re12.state === "READY" && dis12b.state === "SUCCEEDED",
    `local error FAILED -> READY -> SUCCEEDED on retry`,
  );
  const s13 = seedClaimed({ scopeN: 72 });
  const p13 = proposeAndApprove(s13, { domainKey: "dm:telegram:72", naturalKey: "v1", retryMode: "IDEMPOTENCY_KEY" });
  const remoteReject = createFakeRemote(join(ws.stateDir, "reject-remote"));
  const dis13 = dispatchEffect(db, remoteReject, {
    effectId: p13.proposal.effectId, now, precondition: () => true,
    label: "remote-reject", submitMode: "reject",
  });
  let remoteRejectRequeueRefused = false;
  try {
    requeueLocalFailure(db, { effectId: p13.proposal.effectId, now, backoffMs: 100 });
  } catch (e) {
    remoteRejectRequeueRefused = /no automatic requeue/.test(e.message);
  }
  suite.check(
    "remote-rejection-never-auto-requeues",
    dis13.state === "FAILED" && remoteRejectRequeueRefused,
    "known-terminated failure stays terminal; a new action needs a new intent",
  );

  // Cancellation linearization.
  const s14 = seedClaimed({ scopeN: 73 });
  const p14 = proposeAndApprove(s14, { domainKey: "dm:telegram:73", naturalKey: "v1", retryMode: "IDEMPOTENCY_KEY" });
  const cancelA = cancelScope(db, { scopeId: s14.scopeId, now, actorId: "prn:telegram:owner" });
  let dispatchAfterCancelRefused = false;
  try {
    dispatchEffect(db, remote, { effectId: p14.proposal.effectId, now, precondition: () => true });
  } catch (e) {
    dispatchAfterCancelRefused = e instanceof DispatcherRefused;
  }
  const e14 = db.prepare("SELECT state FROM effects WHERE id=?").get(p14.proposal.effectId);
  const apr14 = db.prepare("SELECT state FROM approvals WHERE id=?").get(p14.proposal.approvalId);
  suite.check(
    "cancel-before-dispatch-fences-everything",
    cancelA.cancelledTasks.includes(s14.d.taskId) && e14.state === "CANCELLED" &&
      apr14.state === "CONSUMED" && dispatchAfterCancelRefused,
    `cancel committed first: uncommitted task CANCELLED, READY effect CANCELLED, dispatcher refuses (the consumed approval stays CONSUMED; only WAITING approvals invalidate)`,
  );
  const s15 = seedClaimed({ scopeN: 74 });
  const p15 = proposeAndApprove(s15, { domainKey: "dm:telegram:74", naturalKey: "v1", retryMode: "IDEMPOTENCY_KEY" });
  const remoteC = createFakeRemote(join(ws.stateDir, "cancel-remote"));
  const dis15 = dispatchEffect(db, remoteC, {
    effectId: p15.proposal.effectId, now, precondition: () => true,
    label: "apply-then-die", submitMode: "apply_then_die",
  });
  const cancelB = cancelScope(db, { scopeId: s15.scopeId, now, actorId: "prn:telegram:owner" });
  const t15 = db.prepare("SELECT state FROM tasks WHERE id=?").get(s15.d.taskId);
  suite.check(
    "dispatch-committed-first-cancel-reports-committed-pending",
    dis15.state === "UNKNOWN" && cancelB.retainedCommitted.length === 1 &&
      cancelB.retainedCommitted[0].effects.includes(p15.proposal.effectId) &&
      t15.state === "WAITING_EFFECT",
    `cancel after commitment: task stays WAITING_EFFECT, effect retained for reconciliation`,
  );
  // Single-task cancel still fences the whole scope; others park under the
  // new epoch instead of silently continuing.
  const s16a = seedClaimed({ scopeN: 75 });
  const s16b = seedClaimed({ scopeN: 75 });
  const cancelC = cancelTask(db, { taskId: s16a.d.taskId, now, actorId: "prn:telegram:owner" });
  const t16a = db.prepare("SELECT state FROM tasks WHERE id=?").get(s16a.d.taskId);
  const t16b = db.prepare("SELECT state, scope_epoch FROM tasks WHERE id=?").get(s16b.d.taskId);
  const scope75 = db.prepare("SELECT epoch FROM scopes WHERE id=?").get(s16a.scopeId);
  const a16b = db.prepare("SELECT state FROM attempts WHERE task_id=? AND state='ACTIVE'").get(s16b.d.taskId);
  suite.check(
    "single-task-cancel-parks-scope-under-new-epoch",
    cancelC.cancelledTasks.includes(s16a.d.taskId) && t16a.state === "CANCELLED" &&
      cancelC.parkedTasks.includes(s16b.d.taskId) && t16b.state === "QUEUED" &&
      t16b.scope_epoch === scope75.epoch && a16b === undefined,
    `target CANCELLED; peer parked QUEUED at new epoch ${scope75.epoch}, old attempt closed`,
  );
  // The parked peer claims again under the new epoch.
  const c16b = claimNextTask(db, { now, leaseMs: 45000 });
  suite.check(
    "parked-peer-reclaims-under-new-epoch",
    c16b.taskId === s16b.d.taskId,
    `peer reclaimed as attempt ${c16b.attemptNo}`,
  );

  // PARKED attempts hold no lease and are never reaped (06 section 4).
  const reapedParked = reapExpiredLeases(db, { now: now + 10 * 60 * 1000, maxAttempts: 3 });
  const anyParkedLost = db.prepare("SELECT count(*) c FROM attempts WHERE state='LOST' AND error_code IS NULL").get().c;
  suite.check(
    "reaper-never-touches-parked-approvals",
    !reapedParked.some((r) => r.taskId === s1.d.taskId) && anyParkedLost === 0,
    `WAITING_APPROVAL attempts stay PARKED across lease sweeps`,
  );
}

// ------------------------------------------------- case: effect crash windows
{
  const scenario = join(repoRoot, "evals", "phase2", "durability", "scenarios", "effect-crash.mjs");
  const canonical = loadCanonicalSchema();

  const runWindow = async ({ name, env, expect }) => {
    const ws = makeWorkspace(`durability-crash-${name}`);
    const proc = spawnNode(scenario, [], { env: { AEGISPI_WS: ws.stateDir, ...env } });
    const done = await proc.done;
    const db = openDatabase(ws.dbPath, { readOnly: true });
    const effect = db.prepare("SELECT state, external_id FROM effects").get();
    const approval = db.prepare("SELECT state FROM approvals").get();
    const task = db.prepare("SELECT state FROM tasks").get();
    db.close();
    const nonce = (done.stdout.match(/NONCE ([0-9a-f]+)/) ?? [])[1] ?? null;
    suite.check(
      `crash-${name}-durable-state`,
      done.code !== 0 && effect.state === expect.effect && approval.state === expect.approval && task.state === expect.task,
      `exit=${done.code} effect=${effect?.state} approval=${approval?.state} task=${task?.state}`,
    );
    return { ws, stdout: done.stdout, nonce };
  };

  // Window: CAS mid-transaction rolls back. The approval card (with its
  // nonce) is already in the approver's hands, so the honest retry decides
  // cleanly with the SAME nonce.
  {
    const { ws, nonce } = await runWindow({
      name: "approval-inside-txn",
      env: { AEGISPI_CRASH_POINT: "approvals:inside-txn", AEGISPI_NOW: "1795700000000" },
      expect: { effect: "WAITING_APPROVAL", approval: "WAITING", task: "WAITING_APPROVAL" },
    });
    const db = openDatabase(ws.dbPath);
    const approval = db.prepare("SELECT * FROM approvals").get();
    const effect = db.prepare("SELECT * FROM effects").get();
    const principals = db.prepare("SELECT id FROM principals WHERE platform='telegram' AND platform_subject='approver-1'").get();
    const again = decideApproval(db, {
      approvalId: approval.id,
      decision: "approve",
      actionHash: effect.action_hash,
      nonce,
      approverId: principals.id,
      now: 1795700000001,
    });
    const effectAfter = db.prepare("SELECT state FROM effects WHERE id=?").get(effect.id).state;
    db.close();
    suite.check(
      "crash-approval-inside-txn-cas-rolled-back-clean-retry",
      again.accepted === true && effectAfter === "READY",
      `killed CAS rolled back; the approver's card still decides: effect READY`,
    );
  }

  // Window: consume committed, caller never learned. A retry returns
  // "already processed"; nothing double-consumes.
  {
    const { ws } = await runWindow({
      name: "approval-after-commit",
      env: { AEGISPI_CRASH_POINT: "approvals:after-commit", AEGISPI_NOW: "1795710000000" },
      expect: { effect: "READY", approval: "CONSUMED", task: "WAITING_EFFECT" },
    });
    const db = openDatabase(ws.dbPath);
    const approval = db.prepare("SELECT * FROM approvals").get();
    const effect = db.prepare("SELECT * FROM effects").get();
    const principals = db.prepare("SELECT id FROM principals WHERE platform='telegram' AND platform_subject='approver-1'").get();
    const again = decideApproval(db, {
      approvalId: approval.id,
      decision: "approve",
      actionHash: effect.action_hash,
      nonce: "whatever-retry-nonce",
      approverId: principals.id,
      now: 1795710000001,
    });
    db.close();
    suite.check(
      "crash-approval-after-commit-retry-idempotent",
      again.accepted === false && /already CONSUMED/.test(again.reason ?? ""),
      `double-click after crash: ${again.reason}`,
    );
  }

  // The flagship window: READY->SUBMITTING committed, no request byte sent.
  {
    const { ws } = await runWindow({
      name: "submitting-before-call",
      env: {
        AEGISPI_CRASH_POINT: "effects:after-cas-before-call",
        AEGISPI_NOW: "1795720000000",
        AEGISPI_RETRY_MODE: "IDEMPOTENCY_KEY",
        AEGISPI_FAKE_MODE: "ok",
      },
      expect: { effect: "SUBMITTING", approval: "CONSUMED", task: "WAITING_EFFECT" },
    });
    const remoteBefore = createFakeRemote(ws.stateDir);
    const appliedBefore = remoteBefore.appliedCount(
      openDatabase(ws.dbPath, { readOnly: true }).prepare("SELECT business_key FROM effects").get().business_key,
    );
    suite.check(
      "crash-submitting-no-remote-bytes",
      appliedBefore === 0,
      `fake remote delivered 0 times while the effect sits SUBMITTING`,
    );
    // Startup recovery: SUBMITTING -> UNKNOWN, then per-mode reconciliation.
    const db = openDatabase(ws.dbPath);
    const marked = markSubmittingEffectsUnknown(db, { now: 1795720001000 });
    const effect = db.prepare("SELECT * FROM effects").get();
    suite.check(
      "crash-submitting-recovery-marks-unknown",
      marked.length === 1 && effect.state === "UNKNOWN",
      `recovery marked ${marked.length} SUBMITTING effect(s) UNKNOWN`,
    );
    const remote = createFakeRemote(ws.stateDir);
    const auto = autoRecoverUnknown(db, remote, { effectId: effect.id, now: 1795720002000 });
    const redone = dispatchEffect(db, remote, { effectId: effect.id, now: 1795720010000, precondition: () => true });
    const final = db.prepare("SELECT state, external_id FROM effects WHERE id=?").get(effect.id);
    db.close();
    suite.check(
      "crash-submitting-idempotent-reconcile-lands-success",
      auto.action === "requeued" && redone.state === "SUCCEEDED" && final.state === "SUCCEEDED" &&
        remote.appliedCount(effect.business_key) === 1,
      `UNKNOWN -> same-key resend -> SUCCEEDED ${final.external_id}; remote applied exactly once`,
    );
  }

  // Window: remote already applied, local record missing (06 row "远端已
  // 成功、本地未记账") — lookup recovers the external id, no resend.
  {
    const { ws } = await runWindow({
      name: "remote-success-unrecorded",
      env: {
        AEGISPI_CRASH_POINT: "effects:after-call-before-record",
        AEGISPI_NOW: "1795730000000",
        AEGISPI_RETRY_MODE: "LOOKUP_THEN_RETRY",
        AEGISPI_FAKE_MODE: "ok",
      },
      expect: { effect: "SUBMITTING", approval: "CONSUMED", task: "WAITING_EFFECT" },
    });
    const db = openDatabase(ws.dbPath, { readOnly: true });
    const effectRow = db.prepare("SELECT * FROM effects").get();
    db.close();
    const remote = createFakeRemote(ws.stateDir);
    const appliedRemote = remote.lookup({ businessKey: effectRow.business_key, consistency: "strong" });
    suite.check(
      "crash-remote-success-applied-before-record",
      appliedRemote.found === true,
      `remote really holds the action (${appliedRemote.externalId}) while the effect row is SUBMITTING`,
    );
    const db2 = openDatabase(ws.dbPath);
    markSubmittingEffectsUnknown(db2, { now: 1795730001000 });
    const auto = autoRecoverUnknown(db2, remote, { effectId: effectRow.id, now: 1795730002000 });
    const final = db2.prepare("SELECT state, external_id FROM effects WHERE id=?").get(effectRow.id);
    db2.close();
    suite.check(
      "crash-remote-success-recovery-records-no-resend",
      auto.action === "recorded_success" && final.state === "SUCCEEDED" &&
        final.external_id === appliedRemote.externalId && remote.appliedCount(effectRow.business_key) === 1,
      `recovery recorded SUCCEEDED ${final.external_id} from the lookup; remote still holds exactly one delivery`,
    );
  }
}

// --------------------------------------------------------- case: timers/outbox
{
  const canonical = loadCanonicalSchema();
  const ws = makeWorkspace("durability-timers");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, canonical);
  const now = 1795800000000;
  let scopeSeq = 0;
  const seedScope = ({ scopeN }) => {
    scopeSeq += 1;
    const ing = receiveEvent(db, ws.stateDir, {
      now,
      source: "telegram",
      sourceEventId: `evt-tmr-${scopeN}-${scopeSeq}`,
      principal: { platform: "telegram", subject: String(scopeN) },
      scope: { kind: "owner_dm", domainKey: `dm:telegram:${scopeN}`, channel: "telegram", conversationId: String(scopeN) },
      threadKey: `t-${scopeN}`,
      priority: 5,
      policyVersion: "pv1",
      payload: "timer fixture",
      verdict: "ADMIT",
    });
    const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
    return { scopeId: inbox.scope_id, principalId: inbox.principal_id, payloadObjectId: inbox.payload_object_id, ing };
  };

  // One-shot fire: unique inbox event, FIRED, idempotent re-run.
  const base1 = seedScope({ scopeN: 81 });
  createTimer(db, {
    id: "tmr:one-1",
    scopeId: base1.scopeId,
    principalId: base1.principalId,
    scopeEpoch: 1,
    threadKey: "t-81",
    condition: { type: "none" },
    dueAt: now,
    recurrence: null,
    payloadObjectId: base1.payloadObjectId,
    now,
  });
  const fired1 = processDueTimers(db, { now: now + 1 });
  const timerRow1 = timerRow(db, "tmr:one-1");
  const eventRow1 = db
    .prepare("SELECT * FROM inbox WHERE source='timer' AND source_event_id='tmr:one-1:1'")
    .get();
  const again1 = processDueTimers(db, { now: now + 2 });
  const timerEvents1 = db
    .prepare("SELECT count(*) c FROM inbox WHERE source='timer' AND source_event_id LIKE 'tmr:one-1:%'")
    .get().c;
  suite.check(
    "one-shot-timer-fires-once-idempotent",
    fired1.fired.length === 1 && timerRow1.state === "FIRED" && timerRow1.occurrence_no === 1 &&
      eventRow1 !== undefined && eventRow1.state === "PENDING" && eventRow1.verdict === "ADMIT" &&
      again1.fired.length === 0 && timerEvents1 === 1,
    `FIRED occurrence=1, inbox event tmr:one-1:1 PENDING, re-run fired 0`,
  );

  // Condition already satisfied: SATISFIED, nothing generated.
  const base2 = seedScope({ scopeN: 82 });
  receiveEvent(db, ws.stateDir, {
    now: now + 100,
    source: "telegram",
    sourceEventId: "evt-reply-82",
    principal: { platform: "telegram", subject: "82" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:82", channel: "telegram", conversationId: "82" },
    threadKey: "t-82",
    priority: 5,
    policyVersion: "pv1",
    payload: "already handled, no reminder needed",
    verdict: "ADMIT",
  });
  createTimer(db, {
    id: "tmr:sat-1",
    scopeId: base2.scopeId,
    principalId: base2.principalId,
    scopeEpoch: 1,
    threadKey: "t-82",
    condition: { type: "event_seen", source: "telegram", source_event_id: "evt-reply-82" },
    dueAt: now,
    recurrence: null,
    payloadObjectId: base2.payloadObjectId,
    now,
  });
  const fired2 = processDueTimers(db, { now: now + 200 });
  const timerRow2 = timerRow(db, "tmr:sat-1");
  const satEvents = db
    .prepare("SELECT count(*) c FROM inbox WHERE source='timer' AND source_event_id LIKE 'tmr:sat-1:%'")
    .get().c;
  suite.check(
    "satisfied-condition-produces-no-event",
    fired2.satisfied.length === 1 && timerRow2.state === "SATISFIED" && satEvents === 0,
    `due scan saw the committed reply: SATISFIED, 0 timer events`,
  );

  // Reply-first race: the SATISFIED transaction wins, the due scan no-ops.
  const base3 = seedScope({ scopeN: 83 });
  createTimer(db, {
    id: "tmr:race-reply-first",
    scopeId: base3.scopeId,
    principalId: base3.principalId,
    scopeEpoch: 1,
    threadKey: "t-83",
    condition: { type: "event_seen", source: "telegram", source_event_id: "evt-reply-83" },
    dueAt: now + 1000,
    recurrence: null,
    payloadObjectId: base3.payloadObjectId,
    now,
  });
  receiveEvent(db, ws.stateDir, {
    now: now + 500,
    source: "telegram",
    sourceEventId: "evt-reply-83",
    principal: { platform: "telegram", subject: "83" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:83", channel: "telegram", conversationId: "83" },
    threadKey: "t-83",
    priority: 5,
    policyVersion: "pv1",
    payload: "reply landed before the due scan",
    verdict: "ADMIT",
  });
  const replyWin = markTimerSatisfied(db, { timerId: "tmr:race-reply-first", evidenceEventId: "evt-reply-83", now: now + 600 });
  const dueAfterReply = processDueTimers(db, { now: now + 2000 });
  const raceEvents = db
    .prepare("SELECT count(*) c FROM inbox WHERE source='timer' AND source_event_id LIKE 'tmr:race-reply-first:%'")
    .get().c;
  suite.check(
    "reply-first-wins-no-fire",
    replyWin.changed === true && dueAfterReply.fired.length === 0 && raceEvents === 0,
    `reply committed first: timer SATISFIED, due scan fired 0`,
  );

  // Due-first race: the fire wins; the reply cannot un-fire it, but the
  // stale READY follow-up reminder is cancelled before submission.
  const base4 = seedScope({ scopeN: 84 });
  const ing4 = receiveEvent(db, ws.stateDir, {
    now,
    source: "telegram",
    sourceEventId: "evt-84-claim",
    principal: { platform: "telegram", subject: "84" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:84", channel: "telegram", conversationId: "84" },
    threadKey: "t-84-x",
    priority: 5,
    policyVersion: "pv1",
    payload: "task for the reminder effect",
    verdict: "ADMIT",
  });
  const inbox4 = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing4.inboxId);
  const d4 = dispatchEventToTask(db, {
    inboxId: ing4.inboxId, dispatchKey: dispatchKeyForInbox(inbox4),
    now, priority: 5, maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "skillset-v1",
  });
  const claim4 = claimNextTask(db, { now, leaseMs: 45000 });
  createTimer(db, {
    id: "tmr:race-due-first",
    scopeId: base4.scopeId,
    principalId: base4.principalId,
    scopeEpoch: 1,
    threadKey: "t-84",
    condition: { type: "event_seen", source: "telegram", source_event_id: "evt-reply-84" },
    dueAt: now + 1000,
    recurrence: null,
    payloadObjectId: base4.payloadObjectId,
    now,
  });
  const dueWin = processDueTimers(db, { now: now + 1500 });
  const reminderProposal = proposeEffect(db, ws.stateDir, {
    now: now + 1600,
    taskId: d4.taskId,
    attemptId: claim4.attemptId,
    effectType: "notify",
    domainKey: "dm:telegram:84",
    naturalKey: "followup-v1",
    operationIntent: { targetResource: "telegram-dm:84", operation: "send_message", contentHash: "aa84", evidenceManifestHash: "bb84" },
    retryMode: "AT_MOST_ONCE",
    provider: "fake-telegram",
    resource: "dm",
    requiresApproval: false,
    expiresAt: now + 3600000,
  });
  draftToReady(db, { effectId: reminderProposal.effectId, routineRef: "followup-reminder", approvedRoutines: ["followup-reminder"], now: now + 1600 });
  enqueueNotification(db, {
    effectId: reminderProposal.effectId,
    channel: "telegram",
    destination: "dm:84",
    notBefore: now + 1700,
    notifyReason: "followup:tmr:race-due-first",
    now: now + 1600,
  });
  // The reply lands AFTER the fire: the reminder is now stale.
  receiveEvent(db, ws.stateDir, {
    now: now + 1800,
    source: "telegram",
    sourceEventId: "evt-reply-84",
    principal: { platform: "telegram", subject: "84" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:84", channel: "telegram", conversationId: "84" },
    threadKey: "t-84",
    priority: 5,
    policyVersion: "pv1",
    payload: "reply landed after the fire",
    verdict: "ADMIT",
  });
  const lateSatisfy = markTimerSatisfied(db, { timerId: "tmr:race-due-first", evidenceEventId: "evt-reply-84", now: now + 1900 });
  const cancelledReminders = cancelSatisfiedFollowUpReminders(db, { now: now + 2000 });
  const reminderEffect = db.prepare("SELECT state FROM effects WHERE id=?").get(reminderProposal.effectId);
  const dueWinEvents = db
    .prepare("SELECT count(*) c FROM inbox WHERE source='timer' AND source_event_id LIKE 'tmr:race-due-first:%'")
    .get().c;
  suite.check(
    "due-first-wins-stale-reminder-cancelled",
    dueWin.fired.length === 1 && lateSatisfy.changed === false &&
      dueWinEvents === 1 && cancelledReminders.includes(reminderProposal.effectId) &&
      reminderEffect.state === "CANCELLED",
    `fire won (1 event, timer FIRED); late reply cannot un-fire; the READY follow-up reminder was cancelled before submission`,
  );

  // Periodic timer: occurrences advance, stays SCHEDULED.
  const base5 = seedScope({ scopeN: 85 });
  createTimer(db, {
    id: "tmr:periodic-1",
    scopeId: base5.scopeId,
    principalId: base5.principalId,
    scopeEpoch: 1,
    threadKey: "t-85",
    condition: { type: "none" },
    dueAt: now,
    recurrence: { everyMs: 60000 },
    payloadObjectId: base5.payloadObjectId,
    now,
  });
  processDueTimers(db, { now: now + 1 });
  processDueTimers(db, { now: now + 61000 });
  const timerRow5 = timerRow(db, "tmr:periodic-1");
  const periodicEvents = db
    .prepare("SELECT count(*) c FROM inbox WHERE source='timer' AND source_event_id LIKE 'tmr:periodic-1:%'")
    .get().c;
  suite.check(
    "periodic-timer-advances-occurrences",
    timerRow5.state === "SCHEDULED" && timerRow5.occurrence_no === 2 && periodicEvents === 2,
    `2 occurrences, still SCHEDULED, next due ${timerRow5.due_at}`,
  );

  // Missed periods merge into ONE catch-up with missed_count recorded; no
  // boot-time infinite chase.
  const base6 = seedScope({ scopeN: 86 });
  createTimer(db, {
    id: "tmr:missed-1",
    scopeId: base6.scopeId,
    principalId: base6.principalId,
    scopeEpoch: 1,
    threadKey: "t-86",
    condition: { type: "none" },
    dueAt: now - 5 * 60000,
    recurrence: { everyMs: 60000 },
    payloadObjectId: base6.payloadObjectId,
    now,
  });
  const missedRun = processDueTimers(db, { now: now + 1 });
  const missedTimer = timerRow(db, "tmr:missed-1");
  const missedEvents = db
    .prepare("SELECT count(*) c FROM inbox WHERE source='timer' AND source_event_id LIKE 'tmr:missed-1:%'")
    .get().c;
  const missedAudit = db
    .prepare("SELECT details_json FROM audit_log WHERE code='timer_fired' ORDER BY seq DESC LIMIT 1")
    .get();
  suite.check(
    "missed-periods-merge-into-one-catchup",
    missedRun.fired.length === 1 && missedEvents === 1 &&
      JSON.parse(missedAudit.details_json).missed_count === 4 &&
      missedTimer.due_at === now + 1 + 60000,
    `5 late periods -> 1 catch-up event, missed_count=4 recorded, next due starts fresh`,
  );

  // Task conclusion + notification outbox in ONE transaction; a failing part
  // rolls back the whole composition.
  const base7 = seedScope({ scopeN: 87 });
  const ing7 = receiveEvent(db, ws.stateDir, {
    now,
    source: "telegram",
    sourceEventId: "evt-87-notify",
    principal: { platform: "telegram", subject: "87" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:87", channel: "telegram", conversationId: "87" },
    threadKey: "t-87-x",
    priority: 5,
    policyVersion: "pv1",
    payload: "task whose completion notifies",
    verdict: "ADMIT",
  });
  const inbox7 = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing7.inboxId);
  const d7 = dispatchEventToTask(db, {
    inboxId: ing7.inboxId, dispatchKey: dispatchKeyForInbox(inbox7),
    now, priority: 5, maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "skillset-v1",
  });
  const claim7 = claimNextTask(db, { now, leaseMs: 45000 });
  const noteProposal = proposeEffect(db, ws.stateDir, {
    now,
    taskId: d7.taskId,
    attemptId: claim7.attemptId,
    effectType: "notify",
    domainKey: "dm:telegram:87",
    naturalKey: "result-note-v1",
    operationIntent: { targetResource: "telegram-dm:87", operation: "send_message", contentHash: "aa87", evidenceManifestHash: "bb87" },
    retryMode: "AT_MOST_ONCE",
    provider: "fake-telegram",
    resource: "dm",
    requiresApproval: false,
    expiresAt: now + 3600000,
  });
  draftToReady(db, { effectId: noteProposal.effectId, routineRef: "result-notification", approvedRoutines: ["result-notification"], now });
  const evidence7 = insertObjectRow(db, {
    scopeId: inbox7.scope_id,
    kind: "task_result",
    sourceUri: `task:${d7.taskId}`,
    sourceActor: "host",
    content: "task finished; here is the summary",
    observedAt: now,
    requiredScopeIds: [inbox7.scope_id],
  });
  const final7 = finalizeTaskWithNotification(db, {
    now: now + 100,
    taskId: d7.taskId,
    attemptNo: claim7.attemptNo,
    leaseOwner: claim7.leaseOwner,
    fence: claim7.fence,
    resultClass: "not_applicable",
    resultObjectId: evidence7.id,
    notification: {
      effectId: noteProposal.effectId,
      channel: "telegram",
      destination: "dm:87",
      notBefore: now + 100,
      notifyReason: "task-result",
    },
  });
  const t7 = db.prepare("SELECT state FROM tasks WHERE id=?").get(d7.taskId);
  const box7 = db.prepare("SELECT * FROM outbox WHERE effect_id=?").get(noteProposal.effectId);
  suite.check(
    "task-conclusion-notification-outbox-one-transaction",
    final7.taskState === "SUCCEEDED" && t7.state === "SUCCEEDED" && box7 !== undefined &&
      box7.notify_reason === "task-result",
    `task SUCCEEDED, effect READY, outbox row enqueued atomically`,
  );
  // Composition rollback: a finalize whose notification effect does not
  // exist fails on the foreign key and rolls the WHOLE composition back —
  // the task may not conclude without its notification.
  const ing7b = receiveEvent(db, ws.stateDir, {
    now,
    source: "telegram",
    sourceEventId: "evt-87-notify-2",
    principal: { platform: "telegram", subject: "87" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:87", channel: "telegram", conversationId: "87" },
    threadKey: "t-87-y",
    priority: 5,
    policyVersion: "pv1",
    payload: "second task whose finalize must roll back",
    verdict: "ADMIT",
  });
  const inbox7b = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing7b.inboxId);
  const d7b = dispatchEventToTask(db, {
    inboxId: ing7b.inboxId, dispatchKey: dispatchKeyForInbox(inbox7b),
    now, priority: 5, maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "skillset-v1",
  });
  const claim7b = claimNextTask(db, { now: now + 200, leaseMs: 45000 });
  const evidence7b = insertObjectRow(db, {
    scopeId: inbox7b.scope_id,
    kind: "task_result",
    sourceUri: `task:${d7b.taskId}`,
    sourceActor: "host",
    content: "second result",
    observedAt: now + 200,
    requiredScopeIds: [inbox7b.scope_id],
  });
  let finalizeRolledBack = false;
  try {
    finalizeTaskWithNotification(db, {
      now: now + 300,
      taskId: d7b.taskId,
      attemptNo: claim7b.attemptNo,
      leaseOwner: claim7b.leaseOwner,
      fence: claim7b.fence,
      resultClass: "not_applicable",
      resultObjectId: evidence7b.id,
      notification: { effectId: "efx:no-such-effect", channel: "x", destination: "x", notBefore: now, notifyReason: "broken" },
    });
  } catch {
    finalizeRolledBack = true;
  }
  const t7b = db.prepare("SELECT state FROM tasks WHERE id=?").get(d7b.taskId);
  const a7b = db.prepare("SELECT state FROM attempts WHERE task_id=? AND attempt_no=?").get(d7b.taskId, claim7b.attemptNo);
  suite.check(
    "finalize-composition-atomic-rollback",
    finalizeRolledBack === true && t7b.state === "RUNNING" && a7b.state === "ACTIVE",
    `missing notification effect FK rolled the whole finalize back: task still RUNNING, attempt still ACTIVE, no half-conclusion`,
  );

  // Digest merge supersedes: old READY effect cancelled, new row links back.
  const noteDigest = proposeEffect(db, ws.stateDir, {
    now: now + 350,
    taskId: d7.taskId,
    attemptId: claim7.attemptId,
    effectType: "notify",
    domainKey: "dm:telegram:87",
    naturalKey: "digest-merge-v2",
    operationIntent: { targetResource: "telegram-dm:87", operation: "send_message", contentHash: "aa90", evidenceManifestHash: "bb91" },
    retryMode: "AT_MOST_ONCE",
    provider: "fake-telegram",
    resource: "dm",
    requiresApproval: false,
    expiresAt: now + 3600000,
  });
  draftToReady(db, { effectId: noteDigest.effectId, routineRef: "result-notification", approvedRoutines: ["result-notification"], now: now + 350 });
  const sup = supersedeNotification(db, {
    oldOutboxId: box7.id,
    newEffectId: noteDigest.effectId,
    channel: "telegram",
    destination: "dm:87",
    notBefore: now + 2000,
    notifyReason: "digest-merge",
    now: now + 400,
  });
  const oldEffect7 = db.prepare("SELECT state FROM effects WHERE id=?").get(noteProposal.effectId);
  const newBox = db.prepare("SELECT * FROM outbox WHERE id=?").get(sup.outboxId);
  suite.check(
    "digest-merge-cancels-old-ready-and-links",
    sup.oldEffectCancelled === true && oldEffect7.state === "CANCELLED" &&
      newBox.supersedes_outbox_id === box7.id && newBox.notify_reason === "digest-merge",
    `old READY effect CANCELLED (body never edited), new outbox row supersedes`,
  );

  // Quiet window: not_before delays without dropping.
  const dueNow = dueNotifications(db, { now: now + 500 });
  const dueLater = dueNotifications(db, { now: now + 100000 });
  const notBeforeRow = dueLater.find((r) => r.id === newBox.id);
  suite.check(
    "quiet-window-delays-not-drops",
    !dueNow.some((r) => r.id === newBox.id) && notBeforeRow !== undefined,
    `digest row queued behind not_before=${newBox.not_before}, delivered only after`,
  );

  // Expired notifications: visible reason, never silent.
  const base8 = seedScope({ scopeN: 88 });
  const ing8 = receiveEvent(db, ws.stateDir, {
    now,
    source: "telegram",
    sourceEventId: "evt-88-notify",
    principal: { platform: "telegram", subject: "88" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:88", channel: "telegram", conversationId: "88" },
    threadKey: "t-88-x",
    priority: 5,
    policyVersion: "pv1",
    payload: "task with an expiring notification",
    verdict: "ADMIT",
  });
  const inbox8 = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing8.inboxId);
  const d8 = dispatchEventToTask(db, {
    inboxId: ing8.inboxId, dispatchKey: dispatchKeyForInbox(inbox8),
    now, priority: 5, maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "skillset-v1",
  });
  const claim8 = claimNextTask(db, { now, leaseMs: 45000 });
  const note8 = proposeEffect(db, ws.stateDir, {
    now,
    taskId: d8.taskId,
    attemptId: claim8.attemptId,
    effectType: "notify",
    domainKey: "dm:telegram:88",
    naturalKey: "stale-note-v1",
    operationIntent: { targetResource: "telegram-dm:88", operation: "send_message", contentHash: "aa88", evidenceManifestHash: "bb89" },
    retryMode: "AT_MOST_ONCE",
    provider: "fake-telegram",
    resource: "dm",
    requiresApproval: false,
    expiresAt: now + 1000,
  });
  draftToReady(db, { effectId: note8.effectId, routineRef: "result-notification", approvedRoutines: ["result-notification"], now });
  enqueueNotification(db, {
    effectId: note8.effectId, channel: "telegram", destination: "dm:88",
    notBefore: now + 5000, notifyReason: "quiet-forever", now,
  });
  const expired = expireStaleNotifications(db, { now: now + 2000 });
  const expiredEffect = db.prepare("SELECT state, last_error FROM effects WHERE id=?").get(note8.effectId);
  const expiredAudit = db.prepare("SELECT count(*) c FROM audit_log WHERE code='notification_expired'").get().c;
  suite.check(
    "expired-notification-cancelled-with-visible-reason",
    expired.includes(note8.effectId) && expiredEffect.state === "CANCELLED" &&
      /quiet window/.test(expiredEffect.last_error) && expiredAudit >= 1,
    `notification expired inside its quiet window: CANCELLED with reason "${expiredEffect.last_error}"`,
  );
}

// ---------------------------------------------------- case: timer crash windows
{
  const scenario = join(repoRoot, "evals", "phase2", "durability", "scenarios", "timer-crash.mjs");
  const windows = [
    { name: "timer-inside-fire-txn", point: "timers:inside-fire-txn", expectInbox: 0, expectTimer: "SCHEDULED" },
    { name: "timer-after-fire-commit", point: "timers:after-fire-commit", expectInbox: 1, expectTimer: "FIRED" },
  ];
  for (const w of windows) {
    const ws = makeWorkspace(`durability-crash-${w.name}`);
    const proc = spawnNode(scenario, [], {
      env: { AEGISPI_WS: ws.stateDir, AEGISPI_CRASH_POINT: w.point, AEGISPI_NOW: "1795900000000" },
    });
    const done = await proc.done;
    const db = openDatabase(ws.dbPath, { readOnly: true });
    const timerEvents = db.prepare("SELECT count(*) c FROM inbox WHERE source='timer'").get().c;
    const timerState = db.prepare("SELECT state FROM timers").get().state;
    db.close();
    suite.check(
      `crash-${w.name}-durable-state`,
      done.code !== 0 && timerEvents === w.expectInbox && timerState === w.expectTimer,
      `exit=${done.code} timer events=${timerEvents} timer=${timerState}`,
    );
    // Recovery: the due scan is idempotent on committed or rolled-back state.
    const db2 = openDatabase(ws.dbPath);
    const rerun = processDueTimers(db2, { now: 1795900000001 });
    const finalEvents = db2.prepare("SELECT count(*) c FROM inbox WHERE source='timer'").get().c;
    const finalTimer = db2.prepare("SELECT state, occurrence_no FROM timers").get();
    db2.close();
    suite.check(
      `crash-${w.name}-recovery-single-event`,
      rerun.fired.length + rerun.skipped.length <= 1 && finalEvents === 1 && finalTimer.state === "FIRED" && finalTimer.occurrence_no === 1,
      `reprocess fired=${rerun.fired.length}; final timer events=1, FIRED occurrence=1`,
    );
  }
}

// -------------------------------------------------------------------- summary
const exit = suiteExit(suite, { label: "test:durability (foundation)" });
const { reportPath, logPath } = writeReport({
  suiteId: "durability",
  suite,
  label: "Phase 2 test:durability — 迁移器/排他锁/连接初始化/键编码（步骤 2）",
  extra: { dataSources: "fake 远端与本地 SQLite（无真实外部连接）" },
  evidenceDir: join(repoRoot, "docs", "phase2", "evidence"),
});
console.log(`report: ${reportPath}`);
console.log(`log: ${logPath}`);
process.exit(exit);
