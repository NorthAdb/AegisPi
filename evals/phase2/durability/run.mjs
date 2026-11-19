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
import { receiveEvent } from "../../../apps/daemon/src/ingress.mjs";
import { putObjectContent, gcUnreferencedContent } from "../../../apps/daemon/src/objects.mjs";

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
