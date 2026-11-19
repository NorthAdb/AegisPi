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
import { receiveEvent, dispatchKeyForInbox } from "../../../apps/daemon/src/ingress.mjs";
import { putObjectContent, gcUnreferencedContent, insertObjectRow } from "../../../apps/daemon/src/objects.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
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
    workerStep(db, { taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 99, now: 1795100022000 });
  } catch (e) {
    wrongFenceRejected = e instanceof StaleWorker;
  }
  suite.check("stale-fence-write-rejected", wrongFenceRejected, "StaleWorker on stale fence");

  const st = workerStep(db, { taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 1, now: 1795100023000 });
  suite.check("worker-step-increments", st.stepCount === 1, `step_count=${st.stepCount}`);
  workerStep(db, { taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 1, now: 1795100024000 });
  workerStep(db, { taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 1, now: 1795100024500 });
  let stepsRefused = false;
  try {
    workerStep(db, { taskId: t1.d.taskId, attemptNo: 1, leaseOwner: claimed.leaseOwner, fence: 1, now: 1795100025000 });
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
