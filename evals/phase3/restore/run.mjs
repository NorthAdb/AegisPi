// test:restore — Phase 3 gate (04 Phase 3: "从备份恢复待审/待发/Timer任务；
// 迁移中断可重跑"; 06 section 9/10).
//
// The drill, end to end on a real workspace:
//   1. Seed live work: a WAITING approval card, a READY effect, a SCHEDULED
//      timer, and an object that was deleted with its intent recorded in the
//      deletion ledger.
//   2. A consistency backup INSIDE the maintenance window, with the manifest
//      key configured; the manifest is AES-256-GCM sealed and embeds the
//      deletion ledger.
//   3. Backups OUTSIDE the window and without a key are refused.
//   4. "Catastrophe": the live database is deleted.
//   5. Restore from the backup: the pending approval is decidable again, the
//      READY effect dispatchable, the timer fires; the deleted object does
//      NOT resurrect (the ledger applies after restore).
//   6. The restored database passes migration idempotence.

import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
} from "../lib/harness.mjs";
import { loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../apps/daemon/src/scheduler.mjs";
import { proposeEffect, dispatchEffect } from "../../../apps/daemon/src/effects.mjs";
import { decideApproval } from "../../../apps/daemon/src/approvals.mjs";
import { grantPermission } from "../../../apps/daemon/src/acl.mjs";
import { createTimer, processDueTimers } from "../../../apps/daemon/src/timers.mjs";
import { insertObjectRow, putObjectContent } from "../../../apps/daemon/src/objects.mjs";
import { createFakeRemote } from "../../../apps/daemon/src/testing/fake-remote.mjs";
import { createAdapterUpstream } from "../../../apps/daemon/src/adapters.mjs";
import {
  appendDeletionEntries,
  consistencyBackup,
  decryptManifest,
  insideMaintenanceWindow,
  pruneExpiredBackups,
  restoreFromBackup,
  OutsideMaintenanceWindow,
  ManifestKeyMissing,
} from "../../../apps/daemon/src/db/backup-window.mjs";

lockedNodeGuard();

const suite = makeSuite("restore");
const OWNER = "prn:telegram:6101";
const KEY_HEX = randomBytes(32).toString("hex");

// A maintenance window that surely contains "now" (the operator's real window
// is narrower; the drill runs inside an explicitly granted one).
function windowContainingNow(now) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", hour12: false }).format(new Date(now)),
  );
  return { windowStartHour: hour, windowEndHour: (hour + 1) % 24, timeZone: "Asia/Hong_Kong" };
}

// ---------------------------------------------------------------------------
// Seed the live workspace.
const ws = makeWorkspace("restore-drill");
mkdirSync(join(ws.stateDir, "db"), { recursive: true });
const db = openDatabase(ws.dbPath);
migrate(db, loadCanonicalSchema());
const now = Date.now();
db.prepare("INSERT INTO principals(id, platform, platform_subject) VALUES (?,?,?)").run(OWNER, "telegram", "6101");
db.prepare(
  "INSERT INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
).run("scp:dm%3Atelegram%3A6101", OWNER, "owner_dm", "dm:telegram:6101", "telegram", "6101", null, 1, 1, "pv1", 0);
grantPermission(db, { scopeId: "scp:dm%3Atelegram%3A6101", principalId: OWNER, permission: "approve", now });

const ing = receiveEvent(db, ws.stateDir, {
  now, source: "telegram", sourceEventId: "evt-restore-1",
  principal: { platform: "telegram", subject: "6101" },
  scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
  threadKey: "t1", priority: 5, policyVersion: "pv1", payload: "restore drill", verdict: "ADMIT",
});
const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
dispatchEventToTask(db, { inboxId: inbox.id, dispatchKey: dispatchKeyForInbox(inbox), now, priority: 5, maxSteps: 25, deadlineAt: now + 900000, skillSetHash: "ss" });
const claim = claimNextTask(db, { now, leaseMs: 45000 });
const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(claim.taskId);

// Pending-approval card (待审).
const card = proposeEffect(db, ws.stateDir, {
  now, taskId: task.id,
  attemptId: db.prepare("SELECT id FROM attempts WHERE task_id=? AND attempt_no=?").get(task.id, task.attempt_no).id,
  effectType: "notify", domainKey: "dm:telegram:6101", naturalKey: "restore-card",
  operationIntent: { targetResource: "im:dm:6101", operation: "im.notify", contentHash: "a".repeat(64), evidenceManifestHash: "b".repeat(64) },
  retryMode: "AT_MOST_ONCE", provider: "telegram", resource: "im:dm:6101",
  requiresApproval: true, approverPrincipalId: OWNER, expiresAt: now + 3600000,
});

// Ready-to-send effect on a second task (待发).
const ing2 = receiveEvent(db, ws.stateDir, {
  now, source: "telegram", sourceEventId: "evt-restore-2",
  principal: { platform: "telegram", subject: "6101" },
  scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
  threadKey: "t2", priority: 5, policyVersion: "pv1", payload: "restore drill 2", verdict: "ADMIT",
});
const inbox2 = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing2.inboxId);
dispatchEventToTask(db, { inboxId: inbox2.id, dispatchKey: dispatchKeyForInbox(inbox2), now, priority: 5, maxSteps: 25, deadlineAt: now + 900000, skillSetHash: "ss" });
const claim2 = claimNextTask(db, { now, leaseMs: 45000 });
const task2 = db.prepare("SELECT * FROM tasks WHERE id=?").get(claim2.taskId);
const readyCard = proposeEffect(db, ws.stateDir, {
  now, taskId: task2.id,
  attemptId: db.prepare("SELECT id FROM attempts WHERE task_id=? AND attempt_no=?").get(task2.id, task2.attempt_no).id,
  effectType: "notify", domainKey: "dm:telegram:6101", naturalKey: "restore-ready",
  operationIntent: { targetResource: "im:dm:6101", operation: "im.notify", contentHash: "c".repeat(64), evidenceManifestHash: "b".repeat(64) },
  retryMode: "AT_MOST_ONCE", provider: "telegram", resource: "im:dm:6101",
  requiresApproval: false,
  expiresAt: now + 3600000,
});
db.prepare("UPDATE effects SET state='READY', next_attempt_at=? WHERE id=?").run(now, readyCard.effectId);

// Scheduled timer (Timer 任务).
createTimer(db, {
  id: "tmr:restore:1",
  scopeId: "scp:dm%3Atelegram%3A6101",
  principalId: OWNER,
  scopeEpoch: 1,
  threadKey: "t1",
  condition: { type: "none" },
  dueAt: now + 60 * 1000,
  recurrence: null,
  payloadObjectId: inbox.payload_object_id,
  now,
});

// A forgotten object: deleted, with the intent ledgered BEFORE the backup.
const stored = putObjectContent(ws.stateDir, "the forgotten restore secret");
const forgotten = insertObjectRow(db, {
  scopeId: "scp:dm%3Atelegram%3A6101", kind: "task_result", sourceUri: "drill",
  sourceActor: OWNER, content: "the forgotten restore secret",
  contentHash: stored.contentHash, storageRef: stored.storageRef, observedAt: now,
  requiredScopeIds: ["scp:dm%3Atelegram%3A6101"],
});
db.prepare("UPDATE objects SET status='deleted', deleted_at=? WHERE id=?").run(now, forgotten.id);
appendDeletionEntries(db, { entries: [{ objectId: forgotten.id, reason: "forgotten before backup", deletedAt: now }], now, stateDir: ws.stateDir });

// ---------------------------------------------------------------------------
// The backup, inside its window, with the manifest key.
const window = windowContainingNow(now);
const backup = consistencyBackup(db, {
  stateDir: ws.stateDir,
  backupsDir: ws.backupsDir,
  now,
  manifestKeyHex: KEY_HEX,
  window,
  label: "drill",
});
suite.check(
  "consistency-backup-seals-manifest-with-ledger",
  existsSync(backup.path) && existsSync(backup.manifestPath) && backup.entries === 1,
  `image=${join("workspace-state", "phase3", "restore-drill", "backups", basename(backup.path))} entries=${backup.entries}`,
);

// The manifest is really encrypted: the plaintext marker is absent at rest.
const rawManifest = readFileSync(backup.manifestPath, "utf8");
suite.check(
  "manifest-is-encrypted-at-rest",
  rawManifest.includes("aes-256-gcm") && !rawManifest.includes("deletionLedger") && !rawManifest.includes(forgotten.id),
  `alg=aes-256-gcm; plaintext fields absent=${!rawManifest.includes("deletionLedger")}`,
);

// Outside the window: refused.
let outside = null;
try {
  consistencyBackup(db, {
    stateDir: ws.stateDir, backupsDir: ws.backupsDir, now,
    manifestKeyHex: KEY_HEX,
    window: { windowStartHour: (window.windowStartHour + 2) % 24, windowEndHour: (window.windowStartHour + 3) % 24, timeZone: "Asia/Hong_Kong" },
  });
} catch (e) {
  outside = e;
}
suite.check(
  "backup-outside-window-refused",
  outside instanceof OutsideMaintenanceWindow,
  `-> ${outside?.constructor.name}`,
);

// Without a key: refused (fail closed), no plaintext manifest ever written.
let noKey = null;
try {
  consistencyBackup(db, { stateDir: ws.stateDir, backupsDir: ws.backupsDir, now, manifestKeyHex: null, window });
} catch (e) {
  noKey = e;
}
suite.check(
  "backup-without-manifest-key-refused",
  noKey instanceof ManifestKeyMissing,
  `-> ${noKey?.constructor.name}`,
);

// A wrong key cannot unseal the manifest.
let wrongKey = null;
try {
  const envelope = JSON.parse(readFileSync(backup.manifestPath, "utf8"));
  decryptManifest(envelope, randomBytes(32).toString("hex"));
} catch (e) {
  wrongKey = e;
}
suite.check("manifest-rejects-wrong-key", wrongKey !== null, `-> ${wrongKey?.message?.slice(0, 60)}`);

// ---------------------------------------------------------------------------
// Catastrophe: the live database is gone. Restore to a new workspace.
db.close();
rmSync(ws.dbPath, { force: true });
rmSync(ws.dbPath + "-wal", { force: true });
rmSync(ws.dbPath + "-shm", { force: true });
const targetDir = join(ws.stateDir, "restored");
mkdirSync(join(targetDir, "db"), { recursive: true });
const restoredDbPath = join(targetDir, "db", "aegis.db");
const restoredRes = restoreFromBackup({
  backupPath: backup.path,
  manifestPath: backup.manifestPath,
  manifestKeyHex: KEY_HEX,
  targetDbPath: restoredDbPath,
  now: now + 1000,
});
suite.check(
  "restore-reports-pending-ready-timer-work",
  restoredRes.restored.waitingApprovals === 1 &&
    restoredRes.restored.readyEffects === 1 &&
    restoredRes.restored.scheduledTimers === 1,
  `approvals=${restoredRes.restored.waitingApprovals} ready=${restoredRes.restored.readyEffects} timers=${restoredRes.restored.scheduledTimers}`,
);
suite.check(
  "restore-applies-deletion-ledger-forgotten-stays-forgotten",
  restoredRes.appliedDeletions.includes(forgotten.id),
  `applied deletions=${JSON.stringify(restoredRes.appliedDeletions)}`,
);

// The restored database is LIVE: decide the card, dispatch the effect, fire
// the timer — the actual Phase 3 acceptance.
const db2 = openDatabase(restoredDbPath);
const decide = decideApproval(db2, {
  approvalId: card.approvalId,
  decision: "approve",
  actionHash: card.actionHash,
  nonce: card.approvalNonce,
  approverId: OWNER,
  now: now + 2000,
});
const decidedEffect = db2.prepare("SELECT state FROM effects WHERE id=?").get(card.effectId);
const fake = createFakeRemote(join(targetDir, "fake"), { label: "restore-fake" });
const adapter = createAdapterUpstream(db2, { baseUpstream: fake, transportKind: "fake", policy: {}, config: {} });
const dispatched = dispatchEffect(db2, adapter, { effectId: card.effectId, now: now + 3000, precondition: () => true });
const dispatchedReady = dispatchEffect(db2, adapter, { effectId: readyCard.effectId, now: now + 3000, precondition: () => true });
const fired = processDueTimers(db2, { now: now + 120 * 1000 });
const timerRow = db2.prepare("SELECT state FROM timers WHERE id=?").get("tmr:restore:1");
const timerInbox = db2.prepare("SELECT count(*) c FROM inbox WHERE source='timer' AND source_event_id LIKE 'tmr:restore:1:%'").get().c;
suite.check(
  "restored-work-is-actionable-again",
  decide.accepted === true &&
    decidedEffect.state === "READY" &&
    dispatched.state === "SUCCEEDED" &&
    dispatchedReady.state === "SUCCEEDED" &&
    fired.fired.length === 1 &&
    timerRow.state === "FIRED" &&
    timerInbox === 1,
  `decide=${decide.accepted} effect=${decidedEffect.state} dispatch=${dispatched.state}/${dispatchedReady.state} timers fired=${fired.fired.length} inbox_events=${timerInbox}`,
);

// Migration idempotence on the restored database (迁移中断可重跑：迁移器对同
// 一 schema 幂等，恢复后的库再跑一次不产生第二套状态).
const migrateAgain = migrate(db2, loadCanonicalSchema());
const migrationsRecorded = db2.prepare("SELECT count(*) c FROM schema_migrations").get().c;
suite.check(
  "restored-db-migration-idempotent",
  migrationsRecorded === 1,
  `schema_migrations rows=${migrationsRecorded} (a restored database is not re-applied)`,
);
db2.close();

// ---------------------------------------------------------------------------
// Audit F3: a backup image tampered at EQUAL LENGTH must be REFUSED. The
// manifest's sealed dbSha256 authenticates the image bytes; the size check
// alone accepted exactly this substitution before the fix.
{
  const ws3 = makeWorkspace("restore-tamper");
  mkdirSync(join(ws3.stateDir, "db"), { recursive: true });
  const db3 = openDatabase(ws3.dbPath);
  migrate(db3, loadCanonicalSchema());
  db3.prepare("INSERT INTO system_state(key, value) VALUES ('restore:canary','AUDITTOKEN-AAAA')").run();
  const now3 = Date.now();
  const window3 = windowContainingNow(now3);
  const backup3 = consistencyBackup(db3, {
    stateDir: ws3.stateDir, backupsDir: ws3.backupsDir, now: now3, manifestKeyHex: KEY_HEX, window: window3,
  });
  db3.close();
  // Equal-length byte substitution: same size, valid SQLite, different bytes.
  const raw = readFileSync(backup3.path);
  const needle = "AUDITTOKEN-AAAA";
  const idx = raw.indexOf(needle);
  const tampered = Buffer.concat([
    raw.subarray(0, idx),
    Buffer.from("AUDITTOKEN-BBBB", "utf8"),
    raw.subarray(idx + needle.length),
  ]);
  writeFileSync(backup3.path, tampered);
  let tamperAccepted = false;
  let tamperError = null;
  try {
    restoreFromBackup({
      backupPath: backup3.path,
      manifestPath: backup3.manifestPath,
      manifestKeyHex: KEY_HEX,
      targetDbPath: join(ws3.stateDir, "db", "restored-tampered.db"),
      now: now3 + 1000,
    });
    tamperAccepted = true;
  } catch (e) {
    tamperError = e;
  }
  suite.check(
    "restore-rejects-equal-length-db-tampering",
    tamperAccepted === false && /dbSha256|hash to/.test(tamperError?.message ?? ""),
    `tampered image size unchanged=${tampered.length === raw.length} -> ${tamperError?.message?.slice(0, 80)}`,
  );
}

// ---------------------------------------------------------------------------
// Audit F8: retentionDays is real. A pair older than the retention window
// is pruned when a fresh backup exists; the fresh backup stays.
{
  const now4 = Date.now();
  const oldStamp = now4 - 20 * 24 * 60 * 60 * 1000;
  const oldDb = join(ws.backupsDir, `consistency-${oldStamp}.db`);
  const oldManifest = join(ws.backupsDir, `consistency-${oldStamp}.manifest.json`);
  writeFileSync(oldDb, "stale-image");
  writeFileSync(oldManifest, "stale-manifest");
  utimesSync(oldDb, new Date(oldStamp), new Date(oldStamp));
  utimesSync(oldManifest, new Date(oldStamp), new Date(oldStamp));
  const before = readdirSync(ws.backupsDir).filter((n) => /^consistency-.*\.db$/.test(n)).length;
  const prunedRes = pruneExpiredBackups(ws.backupsDir, { retentionDays: 14, now: now4 });
  const oldGone = !existsSync(oldDb) && !existsSync(oldManifest);
  const freshKept = existsSync(backup.path) && existsSync(backup.manifestPath);
  suite.check(
    "backup-retention-prunes-expired-pairs",
    before >= 2 && oldGone && freshKept && prunedRes.pruned.includes(`consistency-${oldStamp}.db`),
    `before=${before} pruned=${JSON.stringify(prunedRes.pruned)} fresh-kept=${freshKept}`,
  );
}

writeReport({
  suiteId: "restore",
  suite,
  label: "test:restore — 一致性备份维护窗口 + 加密 manifest（含 dbSha256 字节认证）+ 删除清单 + 恢复演练 + 保留期清理",
  extra: {
    dataSources: "本地 SQLite 与真实备份/恢复路径（VACUUM INTO + AES-256-GCM manifest，dbSha256 拒等长篡改）；无外部连接",
  },
});
process.exit(suiteExit(suite, { label: "test:restore" }));
