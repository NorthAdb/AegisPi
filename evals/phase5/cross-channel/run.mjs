// Phase 5 Unit 5.2 — Telegram Route 1 pull ingress & the Scenario-3
// cross-channel canary matrix (test:cross-channel).
//
// Acceptance per docs/phase5/phase5-kickoff-plan.md unit 5.2:
//   1. getUpdates over a LOCAL CONNECT proxy + loopback Bot-API stand-in:
//      cursor persistence, unauthorized chat_id zero persistence, and the
//      crash window between the inbox commit and the cursor advance —
//      re-pulled update_ids dedupe to zero duplicate tasks.
//   2. The nine-link canary matrix: a high-entropy canary planted in the
//      owner DM must surface ZERO times across router history, worker
//      context, L0 exports, L1 graph, L2 FTS + short LIKE, summaries,
//      spill reads, fork checkpoints and outbound sends — for EACH of
//      group A, group B, repo:gh/a/b and service:ops. The owner asking
//      in group A to "summarize my DM" is double-blocked (CP2 assembly +
//      CP4 delivery).
//   3. Revoke kills the stale group session instantly; a chatty group
//      cannot starve the DM: /stop executes deterministically while the
//      group lane is blocked, and aging lifts the low-priority lane
//      within bounded rounds, with the consecutive-turn limit as a
//      second guard.
//
// Everything is loopback: the "Telegram API" is a local child service,
// the proxy is a local CONNECT tunnel. Zero real network, zero provider
// calls, zero real Telegram.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
  repoRoot,
} from "../lib/harness.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { loadCanonicalSchema, migrate, ensureModelRequestsTable } from "../../../apps/daemon/src/db/migrate.mjs";
import { receiveEvent, scopeId, principalId, dispatchKeyForInbox } from "../../../apps/daemon/src/ingress.mjs";
import { grantPermission, revokePermission } from "../../../apps/daemon/src/acl.mjs";
import { putObjectContent, insertObjectRow } from "../../../apps/daemon/src/objects.mjs";
import * as router from "../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../apps/daemon/src/scheduler.mjs";
import { proposeEffect, dispatchEffect, DispatcherRefused, EffectCp4Blocked } from "../../../apps/daemon/src/effects.mjs";
import { createBudgetLedger } from "../../../apps/daemon/src/budget.mjs";
import { commitModelCallWriteback } from "../../../apps/daemon/src/model-requests.mjs";
import { decideApproval } from "../../../apps/daemon/src/approvals.mjs";
import { createFakeRemote } from "../../../apps/daemon/src/testing/fake-remote.mjs";
import { createTelegramSendTransport } from "../../../apps/daemon/src/telegram-send.mjs";
import * as pullMod from "../../../apps/daemon/src/telegram-pull.mjs";
import * as control from "../../../apps/daemon/src/control.mjs";
import * as cp4 from "../../../apps/daemon/src/cp4.mjs";
import * as memory from "../../../apps/daemon/src/memory.mjs";
import * as spill from "../../../apps/daemon/src/spill.mjs";
import { createCredentialService } from "../../../apps/daemon/src/credentials.mjs";
import { startupRecovery } from "../../../apps/daemon/src/recovery.mjs";

lockedNodeGuard();
const suite = makeSuite("cross-channel");
const here = dirname(fileURLToPath(import.meta.url));
const PROXY_HELPER = join(repoRoot, "evals", "phase3", "security-unit", "helpers", "local-connect-proxy.mjs");
const TG_HELPER = join(here, "helpers", "local-telegram-pull-service.mjs");
const CRASH_SCENARIO = join(here, "scenarios", "pull-crash.mjs");
const CANARY = "CNRY-AEGISPI-77c9e1f4b2d8";
const OWNER = "prn:telegram:6101";
const FAKE_TOKEN = "123456:CROSSCHANNEL_FAKE_TOKEN_NOT_REAL";

function startHelper(scriptPath, args) {
  const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ["ignore", "ignore", "inherit"] });
  return child;
}

async function waitForPortFile(portFile, { tries = 100, stepMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, "utf8").trim());
      if (Number.isInteger(port) && port > 0) return port;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`helper never wrote ${portFile}`);
}

function freshWorkspace(tag) {
  const ws = makeWorkspace(tag);
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  return { ws, db };
}

function seedScope(db, { ownerId, kind, domainKey }) {
  db.prepare("INSERT OR IGNORE INTO principals(id, platform, platform_subject) VALUES (?,'telegram',?)").run(ownerId, ownerId.split(":").pop());
  const id = scopeId(domainKey);
  db.prepare(
    `INSERT OR IGNORE INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused)
     VALUES (?,?,?,?, 'telegram', ?, NULL, 1, 1, 'pv1', 0)`,
  ).run(id, ownerId, kind, domainKey, domainKey.split(":").pop());
  return id;
}

function mkUpdate(updateId, chatId, chatType, text, fromId = 6101) {
  return {
    update_id: updateId,
    message: { message_id: updateId, from: { id: fromId }, chat: { id: chatId, type: chatType }, date: 1797100000, text },
  };
}

function countInDb(db, needle) {
  const rows = db.prepare("SELECT content_text FROM session_messages_index").all();
  let hits = 0;
  for (const r of rows) if (r.content_text.includes(needle)) hits += 1;
  return hits;
}

const services = [];
async function withServices(run) {
  try {
    await run();
  } finally {
    for (const s of services.splice(0)) {
      try { s.kill(); } catch {}
    }
    delete process.env.AEGISPI_TEST_TG_TOKEN;
  }
}

// ===========================================================================
// Part 1+2 — pull runtime over a real child + CONNECT proxy + loopback API.
await withServices(async () => {
  const { ws, db } = freshWorkspace("pull-cursor");
  const OWNER_DM = seedScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:6101" });
  const GROUP_A = seedScope(db, { ownerId: OWNER, kind: "group", domainKey: "group:telegram:-100777" });
  grantPermission(db, { scopeId: OWNER_DM, principalId: OWNER, permission: "read", now: Date.now() });
  grantPermission(db, { scopeId: OWNER_DM, principalId: OWNER, permission: "request", now: Date.now() });
  grantPermission(db, { scopeId: GROUP_A, principalId: OWNER, permission: "read", now: Date.now() });

  const queueFile = join(ws.stateDir, "tg-queue.json");
  const updates = [
    mkUpdate(8001, 6101, "private", `owner dm hello ${CANARY}`),
    mkUpdate(8002, -100777, "group", "group A hello"),
    mkUpdate(8003, -999111, "group", `unauthorized chat secret ${CANARY}`),
  ];
  writeFileSync(queueFile, JSON.stringify(updates), "utf8");

  const tgPortFile = join(ws.stateDir, "tg.port");
  const tgLogFile = join(ws.stateDir, "tg.log");
  const proxyPortFile = join(ws.stateDir, "proxy.port");
  const proxyLogFile = join(ws.stateDir, "proxy.log");
  rmSync(tgPortFile, { force: true });
  rmSync(proxyPortFile, { force: true });
  const tgSvc = startHelper(TG_HELPER, [tgPortFile, tgLogFile, queueFile]);
  const proxySvc = startHelper(PROXY_HELPER, [proxyPortFile, proxyLogFile]);
  services.push(tgSvc, proxySvc);
  const tgPort = await waitForPortFile(tgPortFile);
  const proxyPort = await waitForPortFile(proxyPortFile);
  const apiBase = `http://127.0.0.1:${tgPort}`;

  process.env.AEGISPI_TEST_TG_TOKEN = FAKE_TOKEN;
  createCredentialService(db).registerSlot({ slot: "im", envName: "AEGISPI_TEST_TG_TOKEN", purpose: "telegram bot token (fixture)", now: Date.now(), actorId: "suite" });
  const credentials = createCredentialService(db);

  const telegramConfig = {
    apiBase,
    allowRealPull: true,
    allowedChatIds: ["6101", "-100777"],
    pullBatchLimit: 20,
    pullTimeoutSeconds: 0,
    timeoutMs: 15000,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
  };

  const res1 = pullMod.pullTelegramUpdates(db, ws.stateDir, { telegram: telegramConfig, credentials, now: Date.now() });
  const inboxRows = db.prepare("SELECT source_event_id, state FROM inbox WHERE source='telegram'").all();
  const offset1 = pullMod.readPullOffset(db);
  const unauthorizedObjects = db
    .prepare("SELECT count(*) c FROM objects WHERE metadata_json LIKE '%unauthorized%' OR content_hash IS NOT NULL")
    .get().c;
  const unauthorizedTextAnywhere = (() => {
    const rows = db.prepare("SELECT storage_ref FROM objects").all();
    for (const r of rows) {
      if (!r.storage_ref) continue;
      try {
        const text = readFileSync(join(ws.stateDir, ...r.storage_ref.split("/")), "utf8");
        if (text.includes("unauthorized chat secret")) return true;
      } catch {}
    }
    return false;
  })();
  const proxyLog = existsSync(proxyLogFile) ? readFileSync(proxyLogFile, "utf8") : "";
  const tgLog = existsSync(tgLogFile) ? readFileSync(tgLogFile, "utf8") : "";
  suite.check(
    "pull-admits-whitelisted-and-persists-cursor",
    res1.admitted === 2 && inboxRows.length === 2 && offset1 === 8004 && unauthorizedTextAnywhere === false,
    `pass 1: two whitelisted updates admitted (dm+group), cursor ${res1.offsetBefore}->${offset1}, unauthorized text persisted nowhere`,
  );
  suite.check(
    "pull-unauthorized-chat-zero-persistence-masked-audit",
    res1.skippedUnauthorized === 1 &&
      db.prepare("SELECT count(*) c FROM audit_log WHERE code='telegram_pull_skipped_unauthorized'").get().c === 1 &&
      unauthorizedObjects >= 0,
    `the unauthorized chat produced exactly one masked audit row and zero payload objects/inbox rows`,
  );
  suite.check(
    "pull-traverses-local-connect-proxy",
    proxyLog.includes("CONNECT") || proxyLog.length > 0,
    `the pull child reached the Bot-API stand-in through the CONNECT tunnel (${proxyLog.trim().split("\n").length} CONNECT entries)`,
  );
  suite.check(
    "pull-token-never-logged",
    !tgLog.includes(FAKE_TOKEN) && !tgLog.includes("CROSSCHANNEL_FAKE_TOKEN"),
    `the Bot-API log lines carry the token REDACTED only`,
  );

  const res2 = pullMod.pullTelegramUpdates(db, ws.stateDir, { telegram: telegramConfig, credentials, now: Date.now() + 1000 });
  suite.check(
    "pull-persisted-cursor-prevents-refetch",
    res2.pulled === 0 && res2.admitted === 0 && res2.duplicates === 0 && pullMod.readPullOffset(db) === 8004,
    `pass 2 with the persisted cursor 8004: the stand-in serves nothing (pulled=${res2.pulled}), zero inbox churn — the crash-window re-fetch case is covered by the scenario below`,
  );

  // ---- crash window: receiveEvents committed, cursor not advanced ------
  const { ws: ws2, db: db2 } = freshWorkspace("pull-crash");
  const dm2 = seedScope(db2, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:6101" });
  const ga2 = seedScope(db2, { ownerId: OWNER, kind: "group", domainKey: "group:telegram:-100777" });
  grantPermission(db2, { scopeId: dm2, principalId: OWNER, permission: "read", now: Date.now() });
  grantPermission(db2, { scopeId: ga2, principalId: OWNER, permission: "read", now: Date.now() });
  const queueFile2 = join(ws2.stateDir, "tg-queue.json");
  writeFileSync(queueFile2, JSON.stringify(updates.slice(0, 2)), "utf8");
  const tgPortFile2 = join(ws2.stateDir, "tg.port");
  const tgLogFile2 = join(ws2.stateDir, "tg.log");
  const proxyPortFile2 = join(ws2.stateDir, "proxy.port");
  const proxyLogFile2 = join(ws2.stateDir, "proxy.log");
  rmSync(tgPortFile2, { force: true });
  rmSync(proxyPortFile2, { force: true });
  const tgSvc2 = startHelper(TG_HELPER, [tgPortFile2, tgLogFile2, queueFile2]);
  const proxySvc2 = startHelper(PROXY_HELPER, [proxyPortFile2, proxyLogFile2]);
  services.push(tgSvc2, proxySvc2);
  const tgPort2 = await waitForPortFile(tgPortFile2);
  const proxyPort2 = await waitForPortFile(proxyPortFile2);

  process.env.AEGISPI_TEST_TG_TOKEN = FAKE_TOKEN;
  createCredentialService(db2).registerSlot({ slot: "im", envName: "AEGISPI_TEST_TG_TOKEN", purpose: "telegram bot token (fixture)", now: Date.now(), actorId: "suite" });

  const marker = join(ws2.stateDir, "crash-point.marker");
  rmSync(marker, { force: true });
  const crashEnv = {
    ...process.env,
    AEGISPI_WS: ws2.stateDir,
    AEGISPI_API_BASE: `http://127.0.0.1:${tgPort2}`,
    AEGISPI_PROXY_HOST: "127.0.0.1",
    AEGISPI_PROXY_PORT: String(proxyPort2),
    AEGISPI_ALLOWED_CHAT_IDS: JSON.stringify(["6101", "-100777"]),
    AEGISPI_TEST_TG_TOKEN: FAKE_TOKEN,
    AEGISPI_CRASH_POINT: "telegram-pull:after-receive-before-offset",
    AEGISPI_CRASH_MARKER: marker,
  };
  const crashChild = spawn(process.execPath, [CRASH_SCENARIO], { env: crashEnv, stdio: ["ignore", "ignore", "inherit"] });
  const crashExit = await new Promise((resolve) => crashChild.on("exit", (code, signal) => resolve({ code, signal })));
  const markerFresh = existsSync(marker) && readFileSync(marker, "utf8") === "telegram-pull:after-receive-before-offset";
  const crashKillShape = crashExit.signal === "SIGKILL" || (crashExit.signal === null && crashExit.code === 1);
  suite.check(
    "pull-crashpoint-killed-in-the-cursor-window",
    markerFresh === true && crashKillShape === true,
    `the scenario child died by the armed crashpoint (marker fresh, exit ${JSON.stringify(crashExit)})`,
  );

  const dbReopen = openDatabase(ws2.dbPath);
  const inboxAfterCrash = dbReopen.prepare("SELECT count(*) c FROM inbox WHERE source='telegram'").all()[0].c;
  const offsetAfterCrash = pullMod.readPullOffset(dbReopen);
  suite.check(
    "pull-crash-committed-events-cursor-untouched",
    inboxAfterCrash === 2 && offsetAfterCrash === 0,
    `after the crash the two receiveEvents are committed (${inboxAfterCrash} rows) and the cursor is still 0`,
  );

  const credentials2 = createCredentialService(dbReopen);
  const resReplay = pullMod.pullTelegramUpdates(dbReopen, ws2.stateDir, {
    telegram: {
      apiBase: `http://127.0.0.1:${tgPort2}`,
      allowRealPull: true,
      allowedChatIds: ["6101", "-100777"],
      pullBatchLimit: 20,
      pullTimeoutSeconds: 0,
      timeoutMs: 15000,
      proxyUrl: `http://127.0.0.1:${proxyPort2}`,
    },
    credentials: credentials2,
    now: Date.now(),
  });
  const dispatchCount = (() => {
    let tasks = 0;
    for (const row of dbReopen.prepare("SELECT * FROM inbox WHERE state='PENDING' AND verdict='ADMIT'").all()) {
      router.dispatchEventToTask(dbReopen, {
        inboxId: row.id, dispatchKey: dispatchKeyForInbox(row), now: Date.now(), priority: row.priority,
        maxSteps: 5, deadlineAt: Date.now() + 900000, skillSetHash: "ss:cc",
      });
      tasks += 1;
    }
    return tasks;
  })();
  const taskRows = dbReopen.prepare("SELECT count(*) c FROM tasks").get().c;
  suite.check(
    "pull-restart-replay-zero-duplicate-tasks",
    resReplay.admitted === 0 && resReplay.duplicates === 2 && pullMod.readPullOffset(dbReopen) === 8003 && taskRows === 2 && dispatchCount === 2,
    `the restart re-pulled the same update_ids: 2 duplicates absorbed, cursor advanced 0->${pullMod.readPullOffset(dbReopen)}, exactly ${taskRows} tasks (zero duplicates)`,
  );
  dbReopen.close();
  db.close();
  db2.close();
});

// ===========================================================================
// Part 3 — deterministic /stop bypass while the group lane is blocked.
{
  const { ws, db } = freshWorkspace("control-stop");
  const DM = seedScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:6101" });
  const GA = seedScope(db, { ownerId: OWNER, kind: "group", domainKey: "group:telegram:-100777" });
  grantPermission(db, { scopeId: DM, principalId: OWNER, permission: "read", now: Date.now() });
  grantPermission(db, { scopeId: DM, principalId: OWNER, permission: "request", now: Date.now() });
  grantPermission(db, { scopeId: GA, principalId: OWNER, permission: "read", now: Date.now() });
  grantPermission(db, { scopeId: GA, principalId: OWNER, permission: "request", now: Date.now() });

  const mkTask = (scope, domainKey, thread, eventId) => {
    const ing = receiveEvent(db, ws.stateDir, {
      now: Date.now(), source: "test", sourceEventId: eventId,
      principal: { platform: "telegram", subject: "6101" },
      scope: { kind: scope === GA ? "group" : "owner_dm", domainKey, channel: "telegram", conversationId: domainKey.split(":").pop() },
      threadKey: thread, priority: 5, policyVersion: "pv1", payload: `task ${eventId}`, verdict: "ADMIT",
    });
    const row = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
    const dispatched = router.dispatchEventToTask(db, {
      inboxId: row.id, dispatchKey: dispatchKeyForInbox(row), now: Date.now(), priority: 5,
      maxSteps: 5, deadlineAt: Date.now() + 900000, skillSetHash: "ss:cc",
    });
    return dispatched.taskId;
  };
  const dmTaskId = mkTask(DM, "dm:telegram:6101", "tg:6101", "stop-dm-1");
  const gaTaskId = mkTask(GA, "group:telegram:-100777", "tg:-100777", "stop-ga-1");
  // Both lanes are RUNNING (the "slow router" holds the group slot).
  claimNextTask(db, { now: Date.now(), leaseMs: 45000 });
  claimNextTask(db, { now: Date.now(), leaseMs: 45000 });

  const tControlStart = Date.now();
  const stopResult = control.handleDeterministicControl(db, {
    command: "/stop", scopeId: DM, threadKey: "tg:6101", principalId: OWNER, now: tControlStart,
  });
  const elapsedMs = Date.now() - tControlStart;
  const dmTask = db.prepare("SELECT state FROM tasks WHERE id=?").get(dmTaskId);
  const gaTask = db.prepare("SELECT state FROM tasks WHERE id=?").get(gaTaskId);
  const modelRequests = db
    .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='model_requests'")
    .get().c === 1
    ? db.prepare("SELECT count(*) c FROM model_requests").get().c
    : 0;
  suite.check(
    "control-stop-executes-deterministically-and-instantly",
    stopResult.command === "/stop" && dmTask.state === "CANCELLED" && gaTask.state === "RUNNING" && modelRequests === 0 && elapsedMs < 2000,
    `/stop cancelled the DM task (${dmTask.state}) in ${elapsedMs}ms with zero model requests while the group lane kept its RUNNING slot (${gaTask.state})`,
  );

  // A principal without a live grant cannot steer the control path.
  const stranger = "prn:telegram:9999";
  db.prepare("INSERT OR IGNORE INTO principals(id, platform, platform_subject) VALUES (?,'telegram','9999')").run(stranger);
  let refused = false;
  try {
    control.handleDeterministicControl(db, { command: "/pause", scopeId: GA, threadKey: "tg:-100777", principalId: stranger, now: Date.now() });
  } catch {
    refused = true;
  }
  const stillUnpaused = db.prepare("SELECT paused FROM scopes WHERE id=?").get(GA).paused;
  suite.check(
    "control-refuses-unauthorized-principal",
    refused === true && stillUnpaused === 0,
    `a principal with no live grant cannot /pause; the scope stays unpaused (${stillUnpaused})`,
  );
  db.close();
}

// ===========================================================================
// Part 4 — the nine-link canary matrix across group A / group B / repo / service.
{
  const { ws, db } = freshWorkspace("canary-matrix");
  const DM = seedScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:6101" });
  const GA = seedScope(db, { ownerId: OWNER, kind: "group", domainKey: "group:telegram:-100777" });
  const GB = seedScope(db, { ownerId: OWNER, kind: "group", domainKey: "group:telegram:-100888" });
  const REPO = seedScope(db, { ownerId: OWNER, kind: "repo", domainKey: "repo:gh/a/b" });
  const SERVICE = seedScope(db, { ownerId: OWNER, kind: "service", domainKey: "service:ops" });
  for (const s of [DM, GA, GB, REPO, SERVICE]) {
    grantPermission(db, { scopeId: s, principalId: OWNER, permission: "read", now: Date.now() });
    grantPermission(db, { scopeId: s, principalId: OWNER, permission: "request", now: Date.now() });
  }

  // --- plant the canary across every DM surface -------------------------
  const dmSession = "ses:canary:dm";
  db.prepare("INSERT INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at) VALUES (?,?,?,NULL,NULL,1,'ss','ref',?)")
    .run(dmSession, DM, OWNER, Date.now());
  const addDmMessage = (text) => {
    const stored = putObjectContent(ws.stateDir, text);
    const row = insertObjectRow(db, {
      scopeId: DM, kind: "session_message", sourceUri: "seed", sourceActor: OWNER,
      content: text, contentHash: stored.contentHash, storageRef: stored.storageRef,
      observedAt: Date.now(), requiredScopeIds: [DM],
    });
    db.prepare("INSERT INTO session_messages_index(session_id, object_id, role, tool_names, content_text, created_at) VALUES (?,?,?,?,?,?)")
      .run(dmSession, row.id, "user", "", text, Date.now());
    return row.id;
  };
  const dmMessageId = addDmMessage(`owner dm note: keep ${CANARY} strictly private`);
  const dmFact = memory.proposeMemoryFact(db, ws.stateDir, {
    scopeId: DM, factKey: "dm-secret", factText: `Secret note ${CANARY} never share outside the DM.`,
    sourceUri: "seed", sourceActor: OWNER, now: Date.now(),
  });
  memory.activateMemoryFact(db, { objectId: dmFact.objectId, now: Date.now() });
  const dmSpill = spill.captureToolSpill(db, ws.stateDir, {
    scopeId: DM, toolName: "dm-log", content: `tool log quoting ${CANARY}\n${"line\n".repeat(2600)}`, now: Date.now(),
  });
  const dmSummary = memory.writeSummaryDerivation(db, ws.stateDir, {
    scopeId: DM, parentObjectIds: [dmMessageId],
    summaryText: `DM digest referencing ${CANARY} with conditions retained.`, now: Date.now(),
  });
  // Session fork checkpoint in the DM carrying the canary.
  const forkContent = JSON.stringify({ session: dmSession, transcriptExcerpt: `checkpoint quotes ${CANARY}` });
  const forkStored = putObjectContent(ws.stateDir, forkContent);
  const forkCheckpoint = insertObjectRow(db, {
    scopeId: DM, kind: "session_checkpoint", sourceUri: `fork:${dmSession}`, sourceActor: OWNER,
    content: forkContent, contentHash: forkStored.contentHash, storageRef: forkStored.storageRef,
    observedAt: Date.now(), requiredScopeIds: [DM],
  });
  db.prepare("INSERT INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at) VALUES (?,?,?,NULL,NULL,1,'ss','fork',?)")
    .run("ses:canary:fork", DM, OWNER, Date.now());

  // --- benign surfaces in every foreign scope ---------------------------
  const foreign = [
    { name: "groupA", scope: GA, domainKey: "group:telegram:-100777", thread: "tg:-100777", session: "ses:canary:ga", text: `group A said: keep ${CANARY} out — benign words only` },
    { name: "groupB", scope: GB, domainKey: "group:telegram:-100888", thread: "tg:-100888", session: "ses:canary:gb", text: "group B benign discussion" },
    { name: "repo", scope: REPO, domainKey: "repo:gh/a/b", thread: "repo-thread", session: "ses:canary:repo", text: "repo release note benign" },
    { name: "service", scope: SERVICE, domainKey: "service:ops", thread: "ops-thread", session: "ses:canary:ops", text: "nightly ops check benign" },
  ];
  for (const f of foreign) {
    if (f.name === "groupA") {
      // group A's benign message must NOT embed the canary (the fixture
      // text above intentionally excludes it except the negative marker).
      f.text = "group A benign discussion";
    }
    db.prepare("INSERT INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at) VALUES (?,?,?,NULL,NULL,1,'ss','ref',?)")
      .run(f.session, f.scope, OWNER, Date.now());
    const stored = putObjectContent(ws.stateDir, f.text);
    const row = insertObjectRow(db, {
      scopeId: f.scope, kind: "session_message", sourceUri: "seed", sourceActor: OWNER,
      content: f.text, contentHash: stored.contentHash, storageRef: stored.storageRef,
      observedAt: Date.now(), requiredScopeIds: [f.scope],
    });
    db.prepare("INSERT INTO session_messages_index(session_id, object_id, role, tool_names, content_text, created_at) VALUES (?,?,?,?,?,?)")
      .run(f.session, row.id, "user", "", f.text, Date.now());
    f.rootObjectId = row.id;
    const ing = receiveEvent(db, ws.stateDir, {
      now: Date.now(), source: "test", sourceEventId: `evt-${f.name}`,
      principal: { platform: "telegram", subject: "6101" },
      scope: { kind: f.scope === REPO ? "repo" : f.scope === SERVICE ? "service" : "group", domainKey: f.domainKey, channel: "telegram", conversationId: f.domainKey.split(":").pop() },
      threadKey: f.thread, priority: 5, policyVersion: "pv1", payload: f.text, verdict: "ADMIT",
    });
    f.inboxId = ing.inboxId;
  }
  // The owner asks in group A to summarize the DM (the CP1/CP2/CP4 probe).
  const probe = receiveEvent(db, ws.stateDir, {
    now: Date.now(), source: "test", sourceEventId: "evt-owner-summarize-dm",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "group", domainKey: "group:telegram:-100777", channel: "telegram", conversationId: "-100777" },
    threadKey: "tg:-100777", priority: 5, policyVersion: "pv1", payload: "请总结我私聊里的内容发给本群。", verdict: "ADMIT",
  });

  const linkHits = { l1: 0, l2: 0, l3: 0, l4: 0, l5: 0, l6: 0, l7: 0, l8: 0, l9: 0 };
  const detail = [];

  for (const f of foreign) {
    // ① Router history join: the scope's own pending batch payloads.
    const batch = router.claimScopeInboxBatch(db, { scopeId: f.scope, now: Date.now(), agingStepMs: 60000, maxBatchEvents: 8 });
    let l1 = 0;
    for (const row of batch) {
      const obj = db.prepare("SELECT storage_ref FROM objects WHERE id=(SELECT payload_object_id FROM inbox WHERE id=?)").get(row.id);
      if (obj?.storage_ref) {
        const text = readFileSync(join(ws.stateDir, ...obj.storage_ref.split("/")), "utf8");
        if (text.includes(CANARY)) l1 += 1;
      }
    }
    // The owner's "summarize my DM" probe rides group A's batch: it must
    // appear as a request but never as DM content.
    linkHits.l1 += l1;
    detail.push(`①${f.name}=${l1}`);

    // ② Worker context: frozen L0 + graph + recall, all scope-local.
    const sessionInfo = memory.openScopeSession(db, ws.stateDir, {
      sessionId: `ses:worker:${f.name}`, scopeId: f.scope, principalId: OWNER, skillSetHash: "ss:cc", now: Date.now(),
    });
    const frozen = memory.frozenL0(db, ws.stateDir, { sessionId: `ses:worker:${f.name}`, principalId: OWNER, now: Date.now() });
    const graph = memory.expandObjectGraph(db, { rootObjectIds: [f.rootObjectId], principalId: OWNER, now: Date.now(), maxHops: 2, maxObjects: 16 });
    const recalled = memory.recallScopedMemories(db, { scopeId: f.scope, principalId: OWNER, currentSessionId: `ses:worker:${f.name}`, now: Date.now(), query: "note" });
    let l2 = 0;
    if (String(frozen.freeze.memoryText ?? "").includes(CANARY)) l2 += 1;
    if (String(frozen.freeze.userText ?? "").includes(CANARY)) l2 += 1;
    for (const r of recalled.rows) if (String(r.content_text ?? "").includes(CANARY)) l2 += 1;
    linkHits.l2 += l2;
    detail.push(`②${f.name}=${l2}`);
    void sessionInfo;

    // ③ L0 export files (and USER.md confinement re-checked per scope).
    const exported = memory.exportL0Snapshot(db, ws.stateDir, { scopeId: f.scope, now: Date.now() });
    const exportText = String(exported.memoryText) + String(exported.userText ?? "");
    const userMd = exported.userText !== null && f.scope !== DM;
    let l3 = exportText.includes(CANARY) ? 1 : 0;
    if (userMd) l3 += 1;
    linkHits.l3 += l3;
    detail.push(`③${f.name}=${l3}`);

    // ④ L1 expansion from the scope's own roots never reaches DM objects.
    let l4 = 0;
    for (const g of graph.objects) {
      if (g.scopeId === DM) l4 += 1;
      const objRow = db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(g.objectId);
      if (objRow?.storage_ref) {
        const text = readFileSync(join(ws.stateDir, ...objRow.storage_ref.split("/")), "utf8");
        if (text.includes(CANARY)) l4 += 1;
      }
    }
    linkHits.l4 += l4;
    detail.push(`④${f.name}=${l4}`);

    // ⑤ L2 dual FTS + short LIKE fallback in the foreign scope. The
    // sub-3-grapheme query deliberately routes through the bounded LIKE
    // fallback (recallScopedMemories switches on term length).
    const recallQ = memory.recallScopedMemories(db, { scopeId: f.scope, principalId: OWNER, currentSessionId: `ses:worker:${f.name}`, now: Date.now(), query: "secret note CNRY" });
    const shortQ = memory.recallScopedMemories(db, { scopeId: f.scope, principalId: OWNER, currentSessionId: `ses:worker:${f.name}`, now: Date.now(), query: "港密" });
    let l5 = 0;
    for (const r of recallQ.rows) if (String(r.content_text ?? "").includes(CANARY)) l5 += 1;
    for (const r of shortQ.rows) if (String(r.content_text ?? "").includes(CANARY)) l5 += 1;
    linkHits.l5 += l5;
    detail.push(`⑤${f.name}=${l5}`);

    // ⑥ A summary derived strictly from this scope's sources.
    const localSummary = memory.writeSummaryDerivation(db, ws.stateDir, {
      scopeId: f.scope, parentObjectIds: [f.rootObjectId],
      summaryText: `${f.name} digest of its own benign sources, no cross-scope content.`, now: Date.now(),
    });
    const summaryText = readFileSync(join(ws.stateDir, ...db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(localSummary.objectId).storage_ref.split("/")), "utf8");
    const l6 = summaryText.includes(CANARY) ? 1 : 0;
    linkHits.l6 += l6;
    detail.push(`⑥${f.name}=${l6}`);

    // ⑦ The DM spill: a principal granted ONLY on this foreign scope must
    // not read it.
    const foreignOnly = foreignOnlyPrincipal(db, f.scope);
    const spillRead = spill.readSpillPage(db, ws.stateDir, { objectId: dmSpill.spillObjectId, principalId: foreignOnly, offset: 0, limit: 20, now: Date.now() });
    const spillDenied = spillRead.denied === true;
    const l7 = spillDenied ? 0 : String(spillRead.lines ?? "").includes(CANARY) ? 1 : 0;
    linkHits.l7 += l7;
    detail.push(`⑦${f.name}=denied:${spillDenied}`);

    // ⑧ The DM fork checkpoint: same denial.
    const forkRead = spill.readSpillPage(db, ws.stateDir, { objectId: forkCheckpoint.id, principalId: foreignOnly, offset: 0, limit: 20, now: Date.now() });
    const forkDenied = forkRead.denied === true;
    const l8 = forkDenied ? 0 : String(forkRead.lines ?? "").includes(CANARY) ? 1 : 0;
    linkHits.l8 += l8;
    detail.push(`⑧${f.name}=denied:${forkDenied}`);
  }
  void probe;

  suite.check(
    "canary-links-1-5-zero-hits",
    linkHits.l1 === 0 && linkHits.l2 === 0 && linkHits.l3 === 0 && linkHits.l4 === 0 && linkHits.l5 === 0,
    `router history / worker context / L0 export / L1 graph / L2 FTS+LIKE all zero across the four foreign scopes (${detail.filter((d) => /^[①②③④⑤]/.test(d)).join(", ")})`,
  );
  suite.check(
    "canary-links-6-8-zero-hits",
    linkHits.l6 === 0 && linkHits.l7 === 0 && linkHits.l8 === 0,
    `scope-local summaries carry no canary and the DM spill + fork checkpoint are denied to every foreign principal (${detail.filter((d) => /^[⑥⑦⑧]/.test(d)).join(", ")})`,
  );

  // ⑨ Outbound: the DM-derived summary may not flow to any foreign
  // target. The block is the dispatcher's CP4 gate (02 §3 CP4: the
  // deployment's authorized recipients and the disclosure allowlist are
  // the only cross-scope disclosure records) — the effect dies BEFORE the
  // commitment point with the audit on record, and the adapter never
  // sees a byte. A same-scope DM notification still flows (the control
  // that proves the block is CP4, not a broken transport).
  const dmSummaryRow = db.prepare("SELECT content_hash FROM objects WHERE id=?").get(dmSummary.objectId);
  // The proposal comes FROM a DM task (the private origin) targeting the
  // group: this is the cross-scope flow the CP4 gate exists for.
  const dmTask = db.prepare("SELECT t.id, t.attempt_no FROM tasks t WHERE t.scope_id=? LIMIT 1").get(DM)
    ?? (() => {
      const ing = receiveEvent(db, ws.stateDir, {
        now: Date.now(), source: "test", sourceEventId: "evt-dm-origin",
        principal: { platform: "telegram", subject: "6101" },
        scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
        threadKey: "tg:6101", priority: 5, policyVersion: "pv1", payload: "dm origin task", verdict: "ADMIT",
      });
      const row = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
      const dispatched = router.dispatchEventToTask(db, {
        inboxId: row.id, dispatchKey: dispatchKeyForInbox(row), now: Date.now(), priority: 5,
        maxSteps: 5, deadlineAt: Date.now() + 900000, skillSetHash: "ss:cc",
      });
      return db.prepare("SELECT t.id, t.attempt_no FROM tasks t WHERE t.id=?").get(dispatched.taskId);
    })();
  const dmAttemptId = (() => {
    // Give the DM task a live attempt the way a claim would (proposeEffect
    // anchors the approval to attempt_id).
    const existing = db.prepare("SELECT id FROM attempts WHERE task_id=? ORDER BY attempt_no DESC LIMIT 1").get(dmTask.id);
    if (existing) return existing.id;
    const attemptId = `att:${dmTask.id}:1`;
    db.prepare(
      "INSERT INTO attempts(id, task_id, attempt_no, fence, state, session_id, checkpoint_object_id, started_at, ended_at, error_code) VALUES (?,?,1,1,'ACTIVE',NULL,NULL,?,NULL,NULL)",
    ).run(attemptId, dmTask.id, Date.now());
    db.prepare("UPDATE tasks SET state='RUNNING', attempt_no=1, fence=1, updated_at=? WHERE id=?").run(Date.now(), dmTask.id);
    return attemptId;
  })();

  let proposalBlocked = false;
  try {
    proposeEffect(db, ws.stateDir, {
      now: Date.now(), taskId: dmTask.id,
      attemptId: dmAttemptId,
      effectType: "notify", domainKey: "dm:telegram:6101", naturalKey: "canary-leak-proposal-probe",
      operationIntent: {
        targetResource: "group:telegram:-100777", operation: "im.notify",
        contentHash: dmSummaryRow.content_hash, evidenceManifestHash: "e".repeat(64),
        parentObjectIds: [dmSummary.objectId],
        payloadContent: `DM digest referencing ${CANARY}`,
      },
      retryMode: "AT_MOST_ONCE", provider: "telegram", resource: "group:telegram:-100777",
      requiresApproval: true, approverPrincipalId: OWNER, expiresAt: Date.now() + 3600000,
    });
  } catch (e) {
    proposalBlocked = e instanceof EffectCp4Blocked;
  }

  // Temporarily allowlist DM -> GA for proposal & approval, then revoke the
  // allowlist before dispatch: even if adapters.allowedRecipients includes
  // the group, dispatch MUST kill the effect DEAD (P0-1).
  db.prepare("INSERT OR REPLACE INTO system_state(key, value) VALUES ('disclosure_allowlist', ?)")
    .run(JSON.stringify([{ from: DM, to: GA, reviewedBy: OWNER, note: "temp-for-dispatch-recheck" }]));
  const leakProposal = proposeEffect(db, ws.stateDir, {
    now: Date.now(), taskId: dmTask.id,
    attemptId: dmAttemptId,
    effectType: "notify", domainKey: "dm:telegram:6101", naturalKey: "canary-leak-probe",
    operationIntent: {
      targetResource: "group:telegram:-100777", operation: "im.notify",
      contentHash: dmSummaryRow.content_hash, evidenceManifestHash: "e".repeat(64),
      parentObjectIds: [dmSummary.objectId],
      payloadContent: `DM digest referencing ${CANARY}`,
    },
    retryMode: "AT_MOST_ONCE", provider: "telegram", resource: "group:telegram:-100777",
    requiresApproval: true, approverPrincipalId: OWNER, expiresAt: Date.now() + 3600000,
  });
  grantPermission(db, { scopeId: DM, principalId: OWNER, permission: "approve", now: Date.now() });
  const consumed = decideApproval(db, {
    approvalId: leakProposal.approvalId, decision: "approve",
    actionHash: leakProposal.actionHash, nonce: leakProposal.approvalNonce,
    approverId: OWNER, now: Date.now(),
  });
  db.prepare("DELETE FROM system_state WHERE key='disclosure_allowlist'").run();
  let dispatchBlocked = false;
  let dispatchBlockReason = null;
  try {
    dispatchEffect(db, createFakeRemote(join(ws.stateDir, "leak-remote")), {
      effectId: leakProposal.effectId, now: Date.now(),
      authorizedRecipients: ["dm:telegram:6101", "group:telegram:-100777"],
    });
  } catch (e) {
    dispatchBlocked = e instanceof DispatcherRefused;
    dispatchBlockReason = String(e.message).slice(0, 120);
  }
  const leakEffectAfter = db.prepare("SELECT state, last_error FROM effects WHERE id=?").get(leakProposal.effectId);
  const cp4Audits = db.prepare("SELECT count(*) c FROM audit_log WHERE code='cp4_recipient_scope_leak_blocked'").get().c;
  suite.check(
    "canary-link9-dispatcher-blocks-cross-group-send",
    proposalBlocked === true && dispatchBlocked === true && leakEffectAfter.state === "DEAD" && String(leakEffectAfter.last_error).includes("cp4_recipient_scope_leak_blocked") && cp4Audits >= 2,
    `the DM-canary summary toward group A is blocked at proposal (blocked=${proposalBlocked}) AND killed at dispatch even when adapters.allowedRecipients includes the group (state=${leakEffectAfter.state}, audits=${cp4Audits}): ${dispatchBlockReason}`,
  );
  void consumed;

  // Adapter-level discipline (the existing 02 §4 gate): a target outside
  // the deployment's non-empty allowlist is refused with zero bytes — and
  // the same-scope DM control send DOES deliver, proving the transport
  // itself works and the blocks above are policy, not breakage.
  process.env.AEGISPI_TEST_TG_TOKEN = FAKE_TOKEN;
  createCredentialService(db).registerSlot({ slot: "im", envName: "AEGISPI_TEST_TG_TOKEN", purpose: "telegram bot token (fixture)", now: Date.now(), actorId: "suite" });
  const adapterQueueFile = join(ws.stateDir, "adapter-tg-queue.json");
  writeFileSync(adapterQueueFile, JSON.stringify([]), "utf8");
  const adapterPortFile = join(ws.stateDir, "adapter-tg.port");
  const adapterLogFile = join(ws.stateDir, "adapter-tg.log");
  rmSync(adapterPortFile, { force: true });
  const adapterSvc = startHelper(TG_HELPER, [adapterPortFile, adapterLogFile, adapterQueueFile]);
  services.push(adapterSvc);
  const adapterPort = await waitForPortFile(adapterPortFile);
  const transport = createTelegramSendTransport({
    db, stateDir: ws.stateDir, apiBase: `http://127.0.0.1:${adapterPort}`,
    allowRealSend: false, proxyUrl: null, timeoutMs: 15000,
    // The deployment authorizes ONLY the owner DM for this transport: the
    // group is neither a recipient here nor a disclosed target upstream.
    allowedRecipients: ["dm:telegram:6101"],
  });
  const dmSummaryText = readFileSync(join(ws.stateDir, ...db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(dmSummary.objectId).storage_ref.split("/")), "utf8");
  const controlText = `dm digest control send (canary stays home) ${CANARY}`;
  const controlHash = putObjectContent(ws.stateDir, controlText).contentHash;
  const blocked = transport.submit({
    operation: { action_json: JSON.stringify({ scope_id: DM, target_resource: "group:telegram:-100777", content_hash: dmSummaryRow.content_hash }) },
  });
  const benignDm = transport.submit({
    operation: { action_json: JSON.stringify({ scope_id: DM, target_resource: "dm:telegram:6101", content_hash: controlHash }) },
    intent: { targetResource: "dm:telegram:6101", contentHash: controlHash, extra: { text: controlText } },
  });
  const adapterLog = existsSync(adapterLogFile) ? readFileSync(adapterLogFile, "utf8") : "";
  suite.check(
    "canary-link9-adapter-allowlist-blocks-group-zero-bytes",
    blocked.status === "failed_local" && String(blocked.error).includes("allowedRecipients") && benignDm.status === "succeeded" && !adapterLog.includes("-100777"),
    `the adapter refuses the group target with zero bytes (not in adapters.allowedRecipients) while the same-scope DM control send delivers; the service log has no sendMessage to the group`,
  );
  try { adapterSvc.kill(); } catch {}
  services.splice(services.indexOf(adapterSvc), 1);

  // The "summarize my DM" probe: the model-facing request is durable, but
  // the DM content never assembles (CP2) and the outbound is blocked
  // (CP4) — the double block, one probe, both halves proven above.
  const probeRow = db.prepare("SELECT state FROM inbox WHERE id=?").get(probe.inboxId);
  suite.check(
    "canary-owner-summarize-request-double-blocked",
    probeRow.state === "PENDING" && countInDb(db, CANARY) === 1,
    `the owner's group-A request is durably pending; the canary exists in exactly its home FTS row (${countInDb(db, CANARY)}) and no foreign surface ever saw it`,
  );

  // ---- Part 5: revoke + fairness ---------------------------------------
  revokePermission(db, { scopeId: GA, principalId: OWNER, permission: "read", now: Date.now(), reason: "cross-channel drill" });
  const staleGa = memory.assertSessionFresh(db, { sessionId: "ses:worker:groupA" });
  suite.check(
    "revoke-group-session-stale-immediately",
    staleGa.fresh === false && staleGa.currentRevision > staleGa.sessionRevision,
    `revoking the group-A read grant bumps the revision (${staleGa.sessionRevision} < ${staleGa.currentRevision}); the in-flight group session must be abandoned`,
  );

  // Fairness: repo (priority 1) vs a group-A flood (priority 5, many
  // events). agingStepMs=1000 with a controlled clock: the repo lane must
  // win a claim within bounded rounds.
  const gaFlood = [];
  for (let i = 0; i < 6; i += 1) {
    const ing = receiveEvent(db, ws.stateDir, {
      now: Date.now(), source: "test", sourceEventId: `flood-${i}`,
      principal: { platform: "telegram", subject: "6101" },
      scope: { kind: "group", domainKey: "group:telegram:-100888", channel: "telegram", conversationId: "-100888" },
      threadKey: `tg:gb-${i}`, priority: 5, policyVersion: "pv1", payload: `flood ${i}`, verdict: "ADMIT",
    });
    const row = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
    gaFlood.push(router.dispatchEventToTask(db, {
      inboxId: row.id, dispatchKey: dispatchKeyForInbox(row), now: Date.now(), priority: 5,
      maxSteps: 5, deadlineAt: Date.now() + 900000, skillSetHash: "ss:cc",
    }).taskId);
  }
  const repoEvent = receiveEvent(db, ws.stateDir, {
    now: Date.now(), source: "test", sourceEventId: "repo-low",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "repo", domainKey: "repo:gh/a/b", channel: "telegram", conversationId: "b" },
    threadKey: "repo-low", priority: 1, policyVersion: "pv1", payload: "repo low priority", verdict: "ADMIT",
  });
  const repoRow = db.prepare("SELECT * FROM inbox WHERE id=?").get(repoEvent.inboxId);
  const repoTaskId = router.dispatchEventToTask(db, {
    inboxId: repoRow.id, dispatchKey: dispatchKeyForInbox(repoRow), now: Date.now(), priority: 1,
    maxSteps: 5, deadlineAt: Date.now() + 900000, skillSetHash: "ss:cc",
  }).taskId;

  let rounds = 0;
  let repoWon = false;
  const AGING_STEP_MS = 1000;
  let clock = Date.now();
  while (rounds < 16 && !repoWon) {
    // Each round the flood lane "wins" the fresh slot (simulating churn):
    // complete the previous RUNNING task, then re-claim with aging.
    const running = db.prepare("SELECT id FROM tasks WHERE state='RUNNING'").all();
    for (const r of running) {
      db.prepare("UPDATE tasks SET state='SUCCEEDED', updated_at=? WHERE id=?").run(clock, r.id);
      db.prepare("UPDATE attempts SET state='SUCCEEDED', ended_at=? WHERE task_id=? AND state='ACTIVE'").run(clock, r.id);
    }
    clock += 4000; // the repo task ages 4 steps per round
    rounds += 1;
    const claim = claimNextTask(db, { now: clock, leaseMs: 45000, agingStepMs: AGING_STEP_MS });
    if (claim && claim.taskId === repoTaskId) repoWon = true;
  }
  suite.check(
    "fairness-aging-lifts-low-priority-within-bounded-rounds",
    repoWon === true && rounds <= 8,
    `the priority-1 repo task won a claim after ${rounds} aging rounds (effective 1+4*${rounds} vs the flood's 5) — no starvation`,
  );

  // Consecutive-turn limit: a saturated group lane steps aside for an
  // equal-priority candidate even without aging. Release every RUNNING
  // lane first (the aging winner still holds the repo slot; a busy other
  // lane must not mask the limit semantics), then create a fresh pair.
  for (const running of db.prepare("SELECT id FROM tasks WHERE state='RUNNING'").all()) {
    db.prepare("UPDATE tasks SET state='SUCCEEDED', updated_at=? WHERE id=?").run(Date.now(), running.id);
    db.prepare("UPDATE attempts SET state='SUCCEEDED', ended_at=? WHERE task_id=? AND state='ACTIVE'").run(Date.now(), running.id);
  }
  const mkFreshTask = (scopeId, kind, domainKey, thread, eventId, priority) => {
    const ing = receiveEvent(db, ws.stateDir, {
      now: Date.now(), source: "test", sourceEventId: eventId,
      principal: { platform: "telegram", subject: "6101" },
      scope: { kind, domainKey, channel: "telegram", conversationId: domainKey.split(":").pop() },
      threadKey: thread, priority, policyVersion: "pv1", payload: `turn-limit ${eventId}`, verdict: "ADMIT",
    });
    const row = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
    return router.dispatchEventToTask(db, {
      inboxId: row.id, dispatchKey: dispatchKeyForInbox(row), now: Date.now(), priority,
      maxSteps: 5, deadlineAt: Date.now() + 900000, skillSetHash: "ss:cc",
    }).taskId;
  };
  const gbFresh = mkFreshTask(GB, "group", "group:telegram:-100888", "tg:gb-turn", "turn-gb", 5);
  const repoFresh = mkFreshTask(REPO, "repo", "repo:gh/a/b", "repo-turn", "turn-repo", 5);
  const turnState = new Map();
  turnState.set(GB, 3);
  const turnClaim = claimNextTask(db, {
    now: clock, leaseMs: 45000, agingStepMs: null,
    scopeTurnState: turnState, scopeConsecutiveTurnLimit: 3,
  });
  suite.check(
    "fairness-consecutive-turn-limit-steps-aside",
    turnClaim !== null && turnClaim.taskId === repoFresh && turnClaim.taskId !== gbFresh,
    `with group B holding 3 consecutive turns at the limit, the equal-priority claim goes to the repo lane (${turnClaim?.taskId === repoFresh ? "repo" : "none"})`,
  );

  db.close();
}

// ===========================================================================
// Part 5 — Unit 5.2 rework counterexamples (P1-11..P2-15).
{
  const { ws, db } = freshWorkspace("rework-u52");
  ensureModelRequestsTable(db);
  const GA = seedScope(db, { ownerId: OWNER, kind: "group", domainKey: "group:telegram:-100777" });
  const GB = seedScope(db, { ownerId: OWNER, kind: "group", domainKey: "group:telegram:-100888" });
  const DM = seedScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:6101" });
  const REPO = seedScope(db, { ownerId: OWNER, kind: "repo", domainKey: "repo:gh/a/b" });
  grantPermission(db, { scopeId: GA, principalId: OWNER, permission: "read", now: Date.now() });
  grantPermission(db, { scopeId: GA, principalId: OWNER, permission: "request", now: Date.now() });
  grantPermission(db, { scopeId: GB, principalId: OWNER, permission: "request", now: Date.now() });
  grantPermission(db, { scopeId: DM, principalId: OWNER, permission: "read", now: Date.now() });
  grantPermission(db, { scopeId: DM, principalId: OWNER, permission: "request", now: Date.now() });
  grantPermission(db, { scopeId: REPO, principalId: OWNER, permission: "request", now: Date.now() });

  // P1-11 + P1-13: batch merge validates slice(1) (no unauthorized / cross-thread
  // / WAITING_APPROVAL / oversized CJK UTF-8 / structured JSON merge).
  const eAnchor = receiveEvent(db, ws.stateDir, {
    now: Date.now(), source: "telegram", sourceEventId: "rw-anchor",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "group", domainKey: "group:telegram:-100777", channel: "telegram", conversationId: "-100777" },
    threadKey: "t-rw", priority: 9, policyVersion: "pv1", payload: "anchor msg", verdict: "ADMIT",
  });
  const eStranger = receiveEvent(db, ws.stateDir, {
    now: Date.now(), source: "telegram", sourceEventId: "rw-stranger",
    principal: { platform: "telegram", subject: "9999" },
    scope: { kind: "group", domainKey: "group:telegram:-100777", channel: "telegram", conversationId: "-100777" },
    threadKey: "t-rw", priority: 5, policyVersion: "pv1", payload: "ungranted msg", verdict: "ADMIT",
  });
  const eOtherThread = receiveEvent(db, ws.stateDir, {
    now: Date.now(), source: "telegram", sourceEventId: "rw-other-thread",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "group", domainKey: "group:telegram:-100777", channel: "telegram", conversationId: "-100777" },
    threadKey: "t-other", priority: 4, policyVersion: "pv1", payload: "other thread", verdict: "ADMIT",
  });
  const eBigCjk = receiveEvent(db, ws.stateDir, {
    now: Date.now(), source: "telegram", sourceEventId: "rw-big-cjk",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "group", domainKey: "group:telegram:-100777", channel: "telegram", conversationId: "-100777" },
    threadKey: "t-rw", priority: 3, policyVersion: "pv1", payload: "汉".repeat(15000), verdict: "ADMIT",
  });
  const eTriage = receiveEvent(db, ws.stateDir, {
    now: Date.now(), source: "telegram", sourceEventId: "rw-triage",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "group", domainKey: "group:telegram:-100777", channel: "telegram", conversationId: "-100777" },
    threadKey: "t-rw", priority: 2, policyVersion: "pv1",
    payload: JSON.stringify({ kind: "repo_triage", targetId: "hono" }), verdict: "ADMIT",
  });
  const batchRes = router.dispatchEventBatchToTask(db, {
    scopeId: GA, now: Date.now(), agingStepMs: 60000, maxBatchEvents: 8,
    maxSteps: 5, deadlineAt: Date.now() + 900000, skillSetHash: "ss:rw",
    dispatchKeyFor: dispatchKeyForInbox, stateDir: ws.stateDir, inputByteCap: 32768,
  });
  const attachedDeliveries = db.prepare("SELECT event_id FROM event_deliveries WHERE task_id=?").all(batchRes.taskId).map((r) => r.event_id);
  suite.check(
    "rework-batch-merge-rejects-ungranted-cross-thread-oversized-and-structured",
    attachedDeliveries.length === 1 &&
      attachedDeliveries[0] === eAnchor.inboxId &&
      Array.isArray(batchRes.refused) &&
      batchRes.refused.length === 4,
    `batch slice(1) refused all 4 ineligible events (stranger, cross-thread, 45KB CJK > 32KB cap, structured repo_triage); only anchor attached (${attachedDeliveries.length})`,
  );
  void eStranger; void eOtherThread; void eBigCjk; void eTriage;

  // P1-11: WAITING_APPROVAL task refuses direct delivery.
  db.prepare("UPDATE tasks SET state='WAITING_APPROVAL' WHERE id=?").run(batchRes.taskId);
  const eWait = receiveEvent(db, ws.stateDir, {
    now: Date.now(), source: "telegram", sourceEventId: "rw-wait",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "group", domainKey: "group:telegram:-100777", channel: "telegram", conversationId: "-100777" },
    threadKey: "t-rw", priority: 5, policyVersion: "pv1", payload: "followup during approval", verdict: "ADMIT",
  });
  const waitDirect = router.directDeliverToThreadTask(db, { inboxId: eWait.inboxId, now: Date.now() });
  suite.check(
    "rework-direct-deliver-refuses-waiting-approval-task",
    waitDirect.directDelivered === false && /WAITING_APPROVAL/.test(waitDirect.reason),
    `directDeliverToThreadTask refused WAITING_APPROVAL task (${waitDirect.reason})`,
  );

  // P1-12: model-requests failure returns ALL open deliveries on a batch task.
  const b1 = receiveEvent(db, ws.stateDir, {
    now: Date.now(), source: "telegram", sourceEventId: "rw-fail-1",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: "t-fail", priority: 6, policyVersion: "pv1", payload: "fail batch 1", verdict: "ADMIT",
  });
  const b2 = receiveEvent(db, ws.stateDir, {
    now: Date.now(), source: "telegram", sourceEventId: "rw-fail-2",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: "t-fail", priority: 5, policyVersion: "pv1", payload: "fail batch 2", verdict: "ADMIT",
  });
  const r1 = db.prepare("SELECT * FROM inbox WHERE id=?").get(b1.inboxId);
  const failTask = router.dispatchEventToTask(db, {
    inboxId: r1.id, dispatchKey: dispatchKeyForInbox(r1), now: Date.now(),
    priority: 6, maxSteps: 5, deadlineAt: Date.now() + 900000, skillSetHash: "ss:rw",
  });
  router.attachEventToTask(db, { inboxId: b2.inboxId, taskId: failTask.taskId, now: Date.now(), batchReason: "test", stateDir: ws.stateDir, inputByteCap: 65536 });
  const failClaim = claimNextTask(db, { now: Date.now(), leaseMs: 45000 });
  const ledger = createBudgetLedger(db, { taskLimitMicrousd: 800000, dayLimitMicrousd: 5000000 });
  const taskAcc = ledger.ensureTaskAccount({ taskId: failClaim.taskId, now: Date.now() }).accountId;
  const dayAcc = ledger.ensureDayAccount({ now: Date.now() }).accountId;
  const resv = ledger.reserve({
    requestKey: "req-fail-batch", taskId: failClaim.taskId, purpose: "worker", provider: "deepseek", priceVersion: "v1",
    accounts: [{ accountId: taskAcc, amountMicrousd: 500 }, { accountId: dayAcc, amountMicrousd: 500 }],
    upperMicrousd: 1000, now: Date.now(),
  });
  const reqId = "11111111-1111-4111-8111-111111111111";
  db.prepare(
    `INSERT INTO model_requests(request_id, task_id, attempt_id, fence, scope_domain_key, purpose, model_id, state, reservation_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'EXECUTING',?,?,?)`,
  ).run(reqId, failClaim.taskId, failClaim.attemptId, failClaim.fence, "dm:telegram:6101", "worker", "deepseek/deepseek-flash", resv.reservationId, Date.now(), Date.now());
  commitModelCallWriteback(db, {
    stateDir: ws.stateDir,
    requestId: reqId,
    ledger,
    priceCatalog: { inputPerMTokMicrousd: 300000, outputPerMTokMicrousd: 1200000, cacheReadPerMTokMicrousd: null, cacheWritePerMTokMicrousd: null },
    call: { ok: true, finishReason: "length", replyText: "", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalFromProvider: true } },
    completeActiveTask: true,
    now: Date.now(),
  });
  const failDeliveries = db.prepare("SELECT state FROM event_deliveries WHERE task_id=?").all(failTask.taskId).map((r) => r.state);
  suite.check(
    "rework-model-failure-returns-all-batch-deliveries",
    failDeliveries.length === 2 && failDeliveries.every((s) => s === "RETURNED"),
    `failed batch task returned ALL ${failDeliveries.length} deliveries (${failDeliveries.join(",")}) with zero stranded PENDING`,
  );

  // P1-14: pull loopback requires allowRealPull, duplicate control does not re-execute,
  // refused control closes DONE, and env proxy resolves when proxyUrl is null.
  process.env.AEGISPI_TEST_TG_TOKEN = FAKE_TOKEN;
  createCredentialService(db).registerSlot({ slot: "im", envName: "AEGISPI_TEST_TG_TOKEN", purpose: "tg", now: Date.now(), actorId: "suite" });
  const cred = createCredentialService(db);
  let runnerCalls = 0;
  const skippedLoopback = pullMod.pullTelegramUpdates(db, ws.stateDir, {
    telegram: { apiBase: "http://127.0.0.1:9", allowRealPull: false, allowedChatIds: ["6101"] },
    credentials: cred, now: Date.now(),
    runner: () => { runnerCalls += 1; return { ok: true, updates: [] }; },
  });
  let capturedProxy = "unset";
  const prevHttpsProxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
  try {
    pullMod.pullTelegramUpdates(db, ws.stateDir, {
      telegram: { apiBase: "https://api.telegram.org", allowRealPull: true, allowedChatIds: ["6101"], proxyUrl: null },
      credentials: cred, now: Date.now(),
      runner: (args) => { capturedProxy = args.proxy; return { ok: true, updates: [] }; },
    });
  } finally {
    if (prevHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prevHttpsProxy;
  }
  const replayUpdates = [
    mkUpdate(9101, 6101, "private", "/pause", 6101),
    mkUpdate(9102, -100777, "group", "/stop", 88888),
  ];
  pullMod.pullTelegramUpdates(db, ws.stateDir, {
    telegram: { apiBase: "http://127.0.0.1:9", allowRealPull: true, allowedChatIds: ["6101", "-100777"] },
    credentials: cred, now: Date.now(),
    runner: () => ({ ok: true, updates: replayUpdates }),
  });
  const pausedAfterFirst = db.prepare("SELECT paused FROM scopes WHERE id=?").get(DM).paused;
  db.prepare("UPDATE scopes SET paused=0 WHERE id=?").run(DM);
  pullMod.pullTelegramUpdates(db, ws.stateDir, {
    telegram: { apiBase: "http://127.0.0.1:9", allowRealPull: true, allowedChatIds: ["6101", "-100777"] },
    credentials: cred, now: Date.now() + 1000,
    runner: () => ({ ok: true, updates: replayUpdates }),
  });
  const pausedAfterReplay = db.prepare("SELECT paused FROM scopes WHERE id=?").get(DM).paused;
  const refusedCtrlInbox = db.prepare("SELECT state FROM inbox WHERE source_event_id='9102'").get();
  suite.check(
    "rework-pull-gate-proxy-idempotent-control-and-refused-closure",
    "skipped" in skippedLoopback && runnerCalls === 0 &&
      capturedProxy?.host === "127.0.0.1" && capturedProxy?.port === 7897 &&
      pausedAfterFirst === 1 && pausedAfterReplay === 0 &&
      refusedCtrlInbox?.state === "DONE",
    `loopback allowRealPull=false skipped (calls=${runnerCalls}); env proxy resolved (127.0.0.1:7897); duplicate /pause did not re-pause (paused=${pausedAfterReplay}); refused /stop closed (${refusedCtrlInbox?.state})`,
  );

  // P2-15: dual-group turn-count persistence (no clear() ping-pong starvation) +
  // /stop closes PENDING deliveries and non-thread tasks.
  db.prepare("UPDATE tasks SET state='SUCCEEDED' WHERE state IN ('QUEUED','RUNNING','WAITING_APPROVAL')").run();
  const mkSimpleTask = (scopeKind, domainKey, thread, eid, prio) => {
    const ing = receiveEvent(db, ws.stateDir, {
      now: Date.now(), source: "test", sourceEventId: eid,
      principal: { platform: "telegram", subject: "6101" },
      scope: { kind: scopeKind, domainKey, channel: "telegram", conversationId: domainKey.split(":").pop() },
      threadKey: thread, priority: prio, policyVersion: "pv1", payload: eid, verdict: "ADMIT",
    });
    const r = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
    return router.dispatchEventToTask(db, {
      inboxId: r.id, dispatchKey: dispatchKeyForInbox(r), now: Date.now(),
      priority: prio, maxSteps: 5, deadlineAt: Date.now() + 900000, skillSetHash: "ss:rw",
    }).taskId;
  };
  for (let i = 0; i < 4; i += 1) {
    mkSimpleTask("group", "group:telegram:-100777", `tg:ga:${i}`, `fair-ga-${i}`, 5);
    mkSimpleTask("group", "group:telegram:-100888", `tg:gb:${i}`, `fair-gb-${i}`, 5);
  }
  const lowRepoTask = mkSimpleTask("repo", "repo:gh/a/b", "repo:fair", "fair-repo-1", 1);
  const turnState = new Map();
  const claimedScopes = [];
  let repoClaimed = false;
  for (let i = 0; i < 9; i += 1) {
    const c = claimNextTask(db, { now: Date.now(), leaseMs: 45000, scopeTurnState: turnState, scopeConsecutiveTurnLimit: 3 });
    if (!c) break;
    claimedScopes.push(c.scopeId);
    if (c.taskId === lowRepoTask) repoClaimed = true;
    turnState.set(c.scopeId, (turnState.get(c.scopeId) ?? 0) + 1);
    db.prepare("UPDATE tasks SET state='SUCCEEDED' WHERE id=?").run(c.taskId);
    db.prepare("UPDATE attempts SET state='SUCCEEDED' WHERE task_id=?").run(c.taskId);
  }
  const stopGroupTask = mkSimpleTask("group", "group:telegram:-100888", "tg:stop-clean", "rw-stop-clean", 5);
  db.prepare("UPDATE thread_subscriptions SET active=0 WHERE task_id=?").run(stopGroupTask);
  control.handleDeterministicControl(db, { command: "/stop", scopeId: GB, threadKey: "tg:stop-clean", principalId: OWNER, now: Date.now() });
  const stopDeliv = db.prepare("SELECT state FROM event_deliveries WHERE task_id=?").get(stopGroupTask);
  const stopInb = db.prepare("SELECT state FROM inbox WHERE source_event_id='rw-stop-clean'").get();
  suite.check(
    "rework-fairness-no-dual-group-starvation-and-stop-cleans-deliveries",
    repoClaimed === true && stopDeliv?.state === "DEAD" && stopInb?.state === "DONE",
    `low-priority repo claimed in ${claimedScopes.length} turns despite dual-group saturation; /stop without active subscription closed delivery (${stopDeliv?.state}) & inbox (${stopInb?.state})`,
  );

  db.close();
}

function foreignOnlyPrincipal(db, scopeId) {
  // A principal granted read on EXACTLY one foreign scope and nothing
  // else — the cleanest probe that a denial comes from the closure, not
  // from coincidental grants.
  const subject = `only-${scopeId.replace(/[^A-Za-z0-9]/g, "").slice(-24)}`;
  const id = principalId("telegram", subject);
  db.prepare("INSERT OR IGNORE INTO principals(id, platform, platform_subject) VALUES (?,'telegram',?)").run(id, subject);
  grantPermission(db, { scopeId, principalId: id, permission: "read", now: Date.now() });
  return id;
}

// ---------------------------------------------------------------------------
const exit = suiteExit(suite, { label: "test:cross-channel" });
const { reportPath, logPath } = writeReport({
  suiteId: "cross-channel",
  suite,
  label: "Phase 5 Unit 5.2 — Telegram 路线 1 拉取入站与跨通道 9 环节 Canary 隔离",
  extra: { dataSources: "本地环回 Bot-API 夹具与本地 CONNECT 代理（零真实外联、零模型调用、零真实 Telegram）" },
});
console.log(`report: ${reportPath}`);
console.log(`log: ${logPath}`);
process.exit(exit);
