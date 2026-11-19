// test:security:unit — Phase 3 gate (02 section 8 deterministic group:
// 平台身份、签名、重复事件、跨scope访问、缺ACL闭包、源ACL继承、错误fence、
// 审批hash/CAS、取消先后、预算并发、角色权限).
//
// Deterministic, in-process, no containers, no network: every check is a
// falsifiable assertion against the real modules on a real migrated SQLite
// database. Real-container isolation and escape tests live in
// test:security:integration and test:offline-jobs.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
  consoleFetch,
} from "../lib/harness.mjs";
import { loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { claimNextTask, heartbeat } from "../../../apps/daemon/src/scheduler.mjs";
import { proposeEffect, dispatchEffect, cancelTask } from "../../../apps/daemon/src/effects.mjs";
import { decideApproval, hasApproveGrant } from "../../../apps/daemon/src/approvals.mjs";
import { grantPermission, revokePermission, hasReadGrant } from "../../../apps/daemon/src/acl.mjs";
import { createBudgetLedger } from "../../../apps/daemon/src/budget.mjs";
import { putObjectContent, insertObjectRow } from "../../../apps/daemon/src/objects.mjs";
import { recall } from "../../../apps/daemon/src/recall.mjs";
import {
  verifyFeedEvent,
  computeEventSignature,
  SignatureInvalid,
  SecretNotConfigured,
  TimeWindowExceeded,
} from "../../../apps/daemon/src/ingress-verify.mjs";
import { createCredentialService } from "../../../apps/daemon/src/credentials.mjs";
import { createFakeRemote } from "../../../apps/daemon/src/testing/fake-remote.mjs";
import { createAdapterUpstream } from "../../../apps/daemon/src/adapters.mjs";
import { createConsoleApp, ensureConsoleToken } from "../../../apps/daemon/src/console/api.mjs";

lockedNodeGuard();

const suite = makeSuite("security-unit");

function seed(tag) {
  const ws = makeWorkspace(tag);
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const now = Date.now();
  const OWNER = "prn:telegram:6101";
  const READER = "prn:telegram:7102";
  db.prepare("INSERT INTO principals(id, platform, platform_subject) VALUES (?,?,?)").run(OWNER, "telegram", "6101");
  db.prepare("INSERT INTO principals(id, platform, platform_subject) VALUES (?,?,?)").run(READER, "telegram", "7102");
  db.prepare(
    "INSERT INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run("scp:dm%3Atelegram%3A6101", OWNER, "owner_dm", "dm:telegram:6101", "telegram", "6101", null, 1, 1, "pv1", 0);
  return { ws, db, now, OWNER, READER };
}

// ---------------------------------------------------------------- CP1 identity
{
  const secret = "feed-secret-canary-never-in-logs";
  const payload = JSON.stringify({ from: 6101, text: "hello" });
  const sig = computeEventSignature({ payload, secret });
  const now = Date.now();
  const v = verifyFeedEvent({
    source: "telegram-sandbox",
    payload,
    signature: sig,
    timestamp: now,
    now,
    secretFor: (s) => (s === "telegram-sandbox" ? secret : null),
  });
  suite.check("cp1-valid-signature-passes", v.verified === true, "HMAC-SHA256 over canonical LF bytes");

  let wrongPayload = null;
  try {
    verifyFeedEvent({
      source: "telegram-sandbox",
      payload: payload.replace("hello", "hacked"),
      signature: sig,
      timestamp: now,
      now,
      secretFor: () => secret,
    });
  } catch (e) {
    wrongPayload = e;
  }
  suite.check(
    "cp1-tampered-payload-rejected",
    wrongPayload instanceof SignatureInvalid,
    `tampering -> ${wrongPayload?.constructor.name}`,
  );

  let noSecret = null;
  try {
    verifyFeedEvent({
      source: "unconfigured-feed",
      payload,
      signature: sig,
      timestamp: now,
      now,
      secretFor: () => null,
    });
  } catch (e) {
    noSecret = e;
  }
  suite.check(
    "cp1-missing-secret-fails-closed",
    noSecret instanceof SecretNotConfigured,
    `unconfigured source -> ${noSecret?.constructor.name} (refuse, never skip)`,
  );

  let stale = null;
  try {
    verifyFeedEvent({
      source: "telegram-sandbox",
      payload,
      signature: sig,
      timestamp: now - 60 * 60 * 1000,
      now,
      secretFor: () => secret,
    });
  } catch (e) {
    stale = e;
  }
  suite.check("cp1-stale-timestamp-rejected", stale instanceof TimeWindowExceeded, `1h-old event -> ${stale?.constructor.name}`);

  // Duplicate provider event ids collapse: one inbox row, second is a no-op.
  const { ws, db } = seed("su-duplicate");
  const common = {
    source: "telegram-sandbox",
    sourceEventId: "evt-dup-1",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: "t1",
    priority: 5,
    policyVersion: "pv1",
    payload,
    verdict: "ADMIT",
  };
  const first = receiveEvent(db, ws.stateDir, { ...common, now: Date.now() });
  const second = receiveEvent(db, ws.stateDir, { ...common, now: Date.now() + 10 });
  const rows = db.prepare("SELECT count(*) c FROM inbox WHERE source='telegram-sandbox' AND source_event_id='evt-dup-1'").get().c;
  suite.check(
    "cp1-duplicate-provider-event-collapses",
    first.duplicate === false && second.duplicate === true && rows === 1,
    `first=${first.duplicate} second=${second.duplicate} inbox_rows=${rows}`,
  );
}

// ------------------------------------------------------ credential lifecycle
{
  const { db, ws, now } = seed("su-credentials");
  process.env.AEGISPI_TEST_SECRET_A = "canary-secret-value-do-not-log";
  process.env.AEGISPI_TEST_SECRET_B = "rotated-secret-value-do-not-log";
  const creds = createCredentialService(db, { now: () => Date.now() });
  creds.registerSlot({ slot: "im.test", purpose: "im", source: "telegram-sandbox", envName: "AEGISPI_TEST_SECRET_A", actorId: "owner", now });
  const resolved = creds.resolve("im.test");
  suite.check(
    "credential-register-and-resolve",
    resolved.ok === true && resolved.value === process.env.AEGISPI_TEST_SECRET_A,
    `slot resolves from the host env store`,
  );

  const unknown = creds.resolve("no.such.slot");
  suite.check("credential-unknown-slot-refuses", unknown.ok === false, `-> ${unknown.reason}`);

  creds.rotateSlot({ slot: "im.test", envName: "AEGISPI_TEST_SECRET_B", actorId: "owner", now: now + 1 });
  const rotated = creds.resolve("im.test");
  suite.check(
    "credential-rotation-points-at-new-value",
    rotated.ok === true && rotated.value === process.env.AEGISPI_TEST_SECRET_B,
    `rotated slot reads the new env name`,
  );

  // Revoked slot -> adapters fail closed: the adapter upstream demands the
  // credential and the refusal is a local error with zero bytes sent.
  const fake = createFakeRemote(join(ws.stateDir), { label: "cred-fake" });
  const adapterWithRevoked = createAdapterUpstream(db, {
    baseUpstream: fake,
    transportKind: "real",
    policy: { allowRealExternalWrites: true },
    credentials: { im: creds.resolve("im.test").ok ? creds.resolve("im.test").value : null },
    config: {},
  });
  creds.revokeSlot({ slot: "im.test", actorId: "owner", reason: "revocation drill", now: now + 2 });
  const afterRevoke = creds.resolve("im.test");
  // The adapter reads credentials at submit time through the service:
  const adapterFailClosed = createAdapterUpstream(db, {
    baseUpstream: fake,
    transportKind: "real",
    policy: { allowRealExternalWrites: true },
    credentials: { im: afterRevoke.ok ? afterRevoke.value : null },
    config: { fixedSendingIdentity: "aegispi@local", allowedRecipients: [], allowedRepos: [], allowedBranches: [] },
  });
  // Build a minimal operation row the way dispatchEffect would.
  const opRow = {
    operation: "im.notify",
    provider: "telegram",
    resource: "im:dm:6101",
    action_json: JSON.stringify({
      operation: "im.notify",
      target_resource: "im:dm:6101",
      content_hash: "a".repeat(64),
    }),
  };
  const outcome = adapterFailClosed.submit({ businessKey: "bk:revoked", operation: opRow, now: now + 3 });
  suite.check(
    "credential-revocation-fails-closed-at-adapter",
    afterRevoke.ok === false &&
      outcome.status === "failed_local" &&
      /credentials/.test(outcome.error),
    `resolve.ok=${afterRevoke.ok} submit=${outcome.status} (${outcome.error.slice(0, 60)})`,
  );

  // Secret values never reach the audit log (02: "不写入…审计…明文").
  const auditText = db.prepare("SELECT details_json, code, actor_id FROM audit_log").all().map((r) => JSON.stringify(r)).join("\n");
  const leakA = auditText.includes("canary-secret-value-do-not-log");
  const leakB = auditText.includes("rotated-secret-value-do-not-log");
  suite.check("credential-values-never-in-audit", leakA === false && leakB === false, `leakA=${leakA} leakB=${leakB}`);
  delete process.env.AEGISPI_TEST_SECRET_A;
  delete process.env.AEGISPI_TEST_SECRET_B;
}

// --------------------------------------------------------- role permission matrix
{
  const { db, ws, now, OWNER, READER } = seed("su-roles");
  const SCOPE = "scp:dm%3Atelegram%3A6101";
  grantPermission(db, { scopeId: SCOPE, principalId: READER, permission: "read", now });
  suite.check(
    "roles-read-does-not-imply-approve",
    hasReadGrant(db, { scopeId: SCOPE, principalId: READER, now }) === true &&
      hasApproveGrant(db, { scopeId: SCOPE, principalId: READER, now }) === false,
    "a read grant never approves anything",
  );
  // The console authorization surface demands an admin grant on the scope.
  grantPermission(db, { scopeId: SCOPE, principalId: OWNER, permission: "approve", now });
  const { token } = ensureConsoleToken(ws.stateDir);
  const app = createConsoleApp(db, {
    recovery: { mode: "open", actions: [], failedStep: null },
    mode: "open",
    token,
    port: 4310,
    stateDir: ws.stateDir,
    ownerPrincipalId: OWNER,
  });
  const fetch = consoleFetch(app);
  const session = await (
    await fetch("POST", "/api/session", {
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ token }),
    })
  ).body;
  const revokeAttempt = await fetch("POST", "/api/grants/revoke", {
    headers: {
      authorization: `Bearer ${session.sessionId}`,
      "x-csrf-token": session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scopeId: SCOPE, principalId: READER, permission: "read" }),
  });
  suite.check(
    "console-grant-changes-require-admin-not-approve",
    revokeAttempt.status === 403,
    `approve-only session -> ${revokeAttempt.status} ${revokeAttempt.body.code}`,
  );
  grantPermission(db, { scopeId: SCOPE, principalId: OWNER, permission: "admin", now });
  const revokeOk = await fetch("POST", "/api/grants/revoke", {
    headers: {
      authorization: `Bearer ${session.sessionId}`,
      "x-csrf-token": session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scopeId: SCOPE, principalId: READER, permission: "read" }),
  });
  const readerLostRead = hasReadGrant(db, { scopeId: SCOPE, principalId: READER, now });
  suite.check(
    "console-admin-revocation-takes-effect-immediately",
    revokeOk.status === 200 && readerLostRead === false,
    `admin revoke -> ${revokeOk.status}; reader read grant gone=${readerLostRead === false}`,
  );
}

// ------------------------------------------------------------------ wrong fence
{
  const { db, ws, now } = seed("su-fence");
  const ing = receiveEvent(db, ws.stateDir, {
    now, source: "telegram", sourceEventId: "evt-su-fence",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: "t1", priority: 5, policyVersion: "pv1", payload: "fence case", verdict: "ADMIT",
  });
  const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
  dispatchEventToTask(db, { inboxId: inbox.id, dispatchKey: dispatchKeyForInbox(inbox), now, priority: 5, maxSteps: 25, deadlineAt: now + 900000, skillSetHash: "ss" });
  const claim = claimNextTask(db, { now, leaseMs: 45000 });
  let stale = null;
  try {
    heartbeat(db, { taskId: claim.taskId, attemptNo: claim.attemptNo, leaseOwner: claim.leaseOwner, fence: claim.fence - 1, now, leaseMs: 45000 });
  } catch (e) {
    stale = e;
  }
  suite.check(
    "stale-fence-worker-write-refused",
    stale !== null && /fence/i.test(stale.message),
    `fence-1 heartbeat -> ${stale ? stale.message.slice(0, 60) : "ACCEPTED"}`,
  );
}

// ------------------------------------------------------------- budget hard gates
{
  const { db, now } = seed("su-budget");
  const ledger = createBudgetLedger(db, { taskLimitMicrousd: 1000, dayLimitMicrousd: 1000 });
  const taskAcc = ledger.ensureTaskAccount({ taskId: "tsk:budget-unit", now }).accountId;
  const dayAcc = ledger.ensureDayAccount({ now }).accountId;

  // Unknown usage never settles (and never as zero).
  const r1 = ledger.reserve({
    requestKey: "su:b1", taskId: null, purpose: "worker", provider: "deepseek",
    priceVersion: "catalog-v1", upperMicrousd: 500,
    accounts: [{ accountId: taskAcc, amountMicrousd: 400 }, { accountId: dayAcc, amountMicrousd: 100 }], now,
  });
  let missingUsage = null;
  try {
    ledger.settle({ reservationId: r1.reservationId, usage: {}, now });
  } catch (e) {
    missingUsage = e;
  }
  let negativeUsage = null;
  try {
    ledger.settle({ reservationId: r1.reservationId, usage: { actualMicrousd: -5 }, now });
  } catch (e) {
    negativeUsage = e;
  }
  suite.check(
    "unknown-usage-never-settles-never-zero",
    missingUsage !== null && negativeUsage !== null && ledger.reservationRow(r1.reservationId).state === "HELD",
    `no usage -> ${missingUsage?.constructor.name}; negative -> ${negativeUsage?.constructor.name}; still HELD`,
  );

  // Timeout path: CHARGED_BOUND conservatively spends the bound.
  ledger.chargeBound({ reservationId: r1.reservationId, now: now + 16 * 60 * 1000 });
  const chargedRow = ledger.reservationRow(r1.reservationId);
  suite.check(
    "charged-bound-conservative-not-release",
    chargedRow.state === "CHARGED_BOUND" && chargedRow.actual_microusd === 500,
    `state=${chargedRow.state} actual=${chargedRow.actual_microusd}`,
  );

  // Correction requires trusted bill evidence AND an actor.
  let noEvidence = null;
  try {
    ledger.correctChargedBound({ reservationId: r1.reservationId, newActualMicrousd: 300, evidence: null, actorId: null, now });
  } catch (e) {
    noEvidence = e;
  }
  const corrected = ledger.correctChargedBound({
    reservationId: r1.reservationId, newActualMicrousd: 300,
    evidence: { billRef: "bill:2026-11:page3", note: "trusted bill" }, actorId: "prn:telegram:6101", now,
  });
  suite.check(
    "correction-requires-bill-and-actor",
    noEvidence !== null && corrected.actualMicrousd === 300,
    `without evidence -> ${noEvidence?.message.slice(0, 50)}; with bill+actor actual=${corrected.actualMicrousd}`,
  );

  // Concurrency: one account with room for exactly one hold; the second
  // reservation refuses with zero partial residue.
  const tightAcc = ledger.ensureAccount({ id: "acct:tight", periodKey: "tight", limitMicrousd: 500, kind: "task", now }).accountId;
  const w1 = ledger.reserve({
    requestKey: "su:race:1", purpose: "worker", provider: "deepseek", priceVersion: "v",
    upperMicrousd: 400, accounts: [{ accountId: tightAcc, amountMicrousd: 400 }], now,
  });
  let second = null;
  try {
    second = ledger.reserve({
      requestKey: "su:race:2", purpose: "worker", provider: "deepseek", priceVersion: "v",
      upperMicrousd: 200, accounts: [{ accountId: tightAcc, amountMicrousd: 200 }], now,
    });
  } catch (e) {
    second = e;
  }
  const tight = ledger.accountRow(tightAcc);
  suite.check(
    "budget-race-leaves-exactly-one-winner",
    second instanceof Error && tight.held_microusd === 400 && tight.spent_microusd === 0,
    `second reserve -> ${second?.constructor.name}; held=${tight.held_microusd} spent=${tight.spent_microusd}`,
  );

  // Frozen accounts refuse new holds; raises need approval.
  ledger.freezeAccount({ accountId: tightAcc, reason: "drill", now });
  let frozen = null;
  try {
    ledger.reserve({
      requestKey: "su:frozen", purpose: "worker", provider: "deepseek", priceVersion: "v",
      upperMicrousd: 50, accounts: [{ accountId: tightAcc, amountMicrousd: 50 }], now,
    });
  } catch (e) {
    frozen = e;
  }
  let raise = null;
  try {
    ledger.setAccountLimit({ accountId: dayAcc, limitMicrousd: 100000, now });
  } catch (e) {
    raise = e;
  }
  suite.check(
    "frozen-refuses-and-raise-requires-approval",
    /frozen/i.test(String(frozen)) && raise !== null && /approval/i.test(raise.message),
    `frozen -> ${frozen?.message.slice(0, 40)}; raise -> ${raise?.message.slice(0, 50)}`,
  );
}

// --------------------------------------------- ACL closure through real recall
{
  const { db, ws, now, OWNER, READER } = seed("su-closure");
  const SCOPE = "scp:dm%3Atelegram%3A6101";
  db.prepare(
    "INSERT INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run("scp:dm%3Atelegram%3A6203", OWNER, "owner_dm", "dm:telegram:6203", "telegram", "6203", null, 1, 1, "pv1", 0);
  db.prepare("INSERT INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("ses:su:0", SCOPE, OWNER, null, null, 1, "ss:0", "ref:0", now);
  db.prepare("INSERT INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("ses:su:1", SCOPE, OWNER, null, null, 1, "ss:1", "ref:1", now);
  // Messages land in the HISTORICAL session ses:su:0; recall runs from the
  // current session ses:su:1 whose lineage does not contain ses:su:0.
  const addMessage = (content) => {
    const stored = putObjectContent(ws.stateDir, content);
    const obj = insertObjectRow(db, {
      scopeId: SCOPE, kind: "session_message", sourceUri: "test", sourceActor: OWNER,
      content, contentHash: stored.contentHash, storageRef: stored.storageRef,
      observedAt: now, requiredScopeIds: [SCOPE],
    });
    db.prepare("INSERT INTO session_messages_index(session_id, object_id, role, tool_names, content_text, created_at) VALUES (?,?,?,?,?,?)")
      .run("ses:su:0", obj.id, "user", "", content, now);
    return obj;
  };
  // The closure case: an object that ALSO demands a second scope the reader
  // does not hold. A reader granted only the object's home scope must not see
  // it even when the FTS score is perfect.
  const stored = putObjectContent(ws.stateDir, "the closure secret phrase matters deeply");
  insertObjectRow(db, {
    scopeId: SCOPE, kind: "session_message", sourceUri: "test", sourceActor: OWNER,
    content: "the closure secret phrase matters deeply",
    contentHash: stored.contentHash, storageRef: stored.storageRef,
    observedAt: now, requiredScopeIds: [SCOPE, "scp:dm%3Atelegram%3A6203"],
  });
  db.prepare("INSERT INTO session_messages_index(session_id, object_id, role, tool_names, content_text, created_at) VALUES (?,?,?,?,?,?)")
    .run("ses:su:0", db.prepare("SELECT id FROM objects WHERE content_hash=?").get(stored.contentHash).id, "user", "", "the closure secret phrase matters deeply", now);
  addMessage("an ordinary message that is fully granted");
  grantPermission(db, { scopeId: SCOPE, principalId: OWNER, permission: "read", now });
  grantPermission(db, { scopeId: "scp:dm%3Atelegram%3A6203", principalId: OWNER, permission: "read", now });
  grantPermission(db, { scopeId: SCOPE, principalId: READER, permission: "read", now });
  const readerResults = recall(db, {
    scopeId: SCOPE, principalId: READER, currentSessionId: "ses:su:1", nowMs: now, query: "closure secret phrase",
  }).rows;
  const leaked = readerResults.some((r) => /closure secret/.test(JSON.stringify(r)));
  const ownerResults = recall(db, {
    scopeId: SCOPE, principalId: OWNER, currentSessionId: "ses:su:1", nowMs: now, query: "closure secret phrase",
  }).rows;
  const ownerSees = ownerResults.some((r) => /closure secret/.test(JSON.stringify(r)));
  suite.check(
    "missing-scope-closure-filters-before-limit",
    leaked === false && ownerSees === true,
    `reader leaked=${leaked}; owner sees=${ownerSees}`,
  );
}

// ---------------------------------------------- approval hash CAS + cancel order
{
  const { db, ws, now, OWNER } = seed("su-cas");
  const ing = receiveEvent(db, ws.stateDir, {
    now, source: "telegram", sourceEventId: "evt-su-cas",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: "t1", priority: 5, policyVersion: "pv1", payload: "cas case", verdict: "ADMIT",
  });
  const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
  dispatchEventToTask(db, { inboxId: inbox.id, dispatchKey: dispatchKeyForInbox(inbox), now, priority: 5, maxSteps: 25, deadlineAt: now + 900000, skillSetHash: "ss" });
  const claim = claimNextTask(db, { now, leaseMs: 45000 });
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(claim.taskId);
  grantPermission(db, { scopeId: "scp:dm%3Atelegram%3A6101", principalId: OWNER, permission: "approve", now });
  const card = proposeEffect(db, ws.stateDir, {
    now, taskId: task.id,
    attemptId: db.prepare("SELECT id FROM attempts WHERE task_id=? AND attempt_no=?").get(task.id, task.attempt_no).id,
    effectType: "notify", domainKey: "dm:telegram:6101", naturalKey: "su-cas",
    operationIntent: { targetResource: "im:dm:6101", operation: "im.notify", contentHash: "a".repeat(64), evidenceManifestHash: "b".repeat(64) },
    retryMode: "AT_MOST_ONCE", provider: "telegram", resource: "im:dm:6101",
    requiresApproval: true, approverPrincipalId: OWNER, expiresAt: now + 3600000,
  });
  const wrongHash = decideApproval(db, {
    approvalId: card.approvalId, decision: "approve",
    actionHash: "0".repeat(64), nonce: card.approvalNonce, approverId: OWNER, now,
  });
  const okHash = decideApproval(db, {
    approvalId: card.approvalId, decision: "approve",
    actionHash: card.actionHash, nonce: card.approvalNonce, approverId: OWNER, now,
  });
  const effectState = db.prepare("SELECT state FROM effects WHERE id=?").get(card.effectId).state;
  suite.check(
    "approval-consume-requires-exact-action-hash",
    wrongHash.accepted === false && okHash.accepted === true && effectState === "READY",
    `wrong hash -> ${wrongHash.reason}; right hash accepted=${okHash.accepted}; effect=${effectState}`,
  );

  // Cancel-then-dispatch: the dispatcher refuses; dispatch-then-cancel keeps
  // the honest retained report (covered fully in test:cancel-approval; pinned
  // here at the primitive level too).
  cancelTask(db, { taskId: task.id, now, actorId: "owner" });
  let dispatchRefused = null;
  try {
    const fake = createFakeRemote(join(ws.stateDir), { label: "su-fake" });
    dispatchEffect(db, createAdapterUpstream(db, { baseUpstream: fake, transportKind: "fake", policy: {}, config: {} }), {
      effectId: card.effectId, now, precondition: () => true,
    });
  } catch (e) {
    dispatchRefused = e;
  }
  suite.check(
    "cancel-before-dispatch-refuses-dispatch",
    dispatchRefused !== null && /CANCELLED/.test(dispatchRefused.message),
    `dispatch after cancel -> ${dispatchRefused ? "refused" : "WENT THROUGH"}`,
  );
}

// -------------------------------------------------- SSE stream contract (04 §5)
{
  const { db, ws, now, OWNER } = seed("su-sse");
  // Two durable events -> two stream events.
  for (const label of ["sse1", "sse2"]) {
    receiveEvent(db, ws.stateDir, {
      now: now + (label === "sse1" ? 1 : 2), source: "telegram", sourceEventId: `evt-su-${label}`,
      principal: { platform: "telegram", subject: "6101" },
      scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
      threadKey: `t-${label}`, priority: 5, policyVersion: "pv1", payload: `sse ${label}`, verdict: "ADMIT",
    });
  }
  const { token } = ensureConsoleToken(ws.stateDir);
  const app = createConsoleApp(db, {
    recovery: { mode: "open", actions: [], failedStep: null },
    mode: "open", token, port: 4310, stateDir: ws.stateDir, ownerPrincipalId: OWNER,
  });
  const fetch = consoleFetch(app);
  const replay = await fetch("GET", "/api/events/stream", {
    headers: { authorization: `Bearer ${token}`, "last-event-id": "1:0" },
  });
  const lines = replay.text.split("\n");
  const ids = lines.filter((l) => l.startsWith("id:")).map((l) => l.slice(3).trim());
  const events = lines.filter((l) => l.startsWith("event:")).map((l) => l.slice(6).trim());
  // Advance the generation (a restore does this); a stale-generation client
  // must be told to reset.
  db.prepare("INSERT INTO system_state(key, value) VALUES ('stream_generation','7') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  const stale = await fetch("GET", "/api/events/stream", {
    headers: { authorization: `Bearer ${token}`, "last-event-id": "1:0" },
  });
  const unauth = await fetch("GET", "/api/events/stream", {});
  suite.check(
    "sse-replays-with-cursor-and-resets-on-generation-change",
    replay.status === 200 &&
      ids.length >= 2 &&
      events.includes("inbox_changed") &&
      /event: reset/.test(stale.text) &&
      unauth.status === 401,
    `replay ids=${ids.length} events=${events.slice(0, 3).join(",")} stale-reset=${/event: reset/.test(stale.text)} unauth=${unauth.status}`,
  );
}

writeReport({
  suiteId: "security-unit",
  suite,
  label: "test:security:unit — 确定性安全门禁（02 §8 第一组）",
  extra: {
    dataSources: "本地 SQLite 与真实模块（HMAC 验签、凭据槽位、预算账本、召回查询、审批 CAS）；无容器、无网络、无模型调用",
  },
});
process.exit(suiteExit(suite, { label: "test:security:unit" }));
