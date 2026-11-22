// test:cancel-approval — Phase 3 gate (04 Phase 3 acceptance: "审批双击/
// 编辑/HEAD变化/旧attempt/取消线性化全部覆盖").
//
// Every case drives the PRODUCTION path: effects are proposed through
// proposeEffect, decisions go through the console session (POST
// /api/approvals/:id/decide with session + CSRF + JSON), cancels through
// POST /api/tasks/:id/cancel, revisions through POST /api/approvals/:id/
// revise. Only the transport is fake (the sanctioned test seam): the
// dispatcher's adapter upstream is the real production wrapper.
//
// Data sources: local SQLite workspaces + the fake remote (no real external
// connection, no model calls).

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
import { claimNextTask } from "../../../apps/daemon/src/scheduler.mjs";
import { proposeEffect, dispatchEffect, reviseEffect, reproposeHeadChanged } from "../../../apps/daemon/src/effects.mjs";
import { grantPermission, revokePermission } from "../../../apps/daemon/src/acl.mjs";
import { decideApproval, approvalIdFor } from "../../../apps/daemon/src/approvals.mjs";
import { createFakeRemote } from "../../../apps/daemon/src/testing/fake-remote.mjs";
import { createAdapterUpstream, headPrecondition, AdapterRefused } from "../../../apps/daemon/src/adapters.mjs";
import { createConsoleApp, ensureConsoleToken } from "../../../apps/daemon/src/console/api.mjs";

lockedNodeGuard();

const suite = makeSuite("cancel-approval");

const OWNER = "prn:telegram:6101";
const OTHER = "prn:telegram:6102";
const DOMAIN_KEY = "dm:telegram:6101";
// ingress.scopeId(domain_key) escapes ':' -> %3A; fixtures must use the
// same derived id the production path computes.
const SCOPE = "scp:dm%3Atelegram%3A6101";

function seedWorkspace(tag) {
  const ws = makeWorkspace(tag);
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const now = Date.now();
  db.prepare("INSERT INTO principals(id, platform, platform_subject) VALUES (?,?,?)").run(OWNER, "telegram", "6101");
  db.prepare("INSERT INTO principals(id, platform, platform_subject) VALUES (?,?,?)").run(OTHER, "telegram", "6102");
  db.prepare("INSERT OR REPLACE INTO system_state(key, value) VALUES ('disclosure_allowlist', ?)")
    .run(JSON.stringify([{ from: SCOPE, to: "repo://github.com/x/y", reviewedBy: OWNER, note: "cancel-approval pr.create_draft fixture" }]));
  db.prepare(
    `INSERT INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(SCOPE, OWNER, "owner_dm", "dm:telegram:6101", "telegram", "6101", null, 1, 1, "pv1", 0);
  grantPermission(db, { scopeId: SCOPE, principalId: OWNER, permission: "approve", now });
  grantPermission(db, { scopeId: SCOPE, principalId: OWNER, permission: "admin", now });
  return { ws, db, now };
}

// Create a RUNNING task through the production ingress/dispatch/claim chain.
function seedTask(db, ws, { label, now }) {
  const ing = receiveEvent(db, ws.stateDir, {
    now,
    source: "telegram",
    sourceEventId: `evt-ca-${label}`,
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: `t-${label}`,
    priority: 5,
    policyVersion: "pv1",
    payload: `cancel-approval case ${label}`,
    verdict: "ADMIT",
  });
  const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
  dispatchEventToTask(db, {
    inboxId: inbox.id,
    dispatchKey: dispatchKeyForInbox(inbox),
    now,
    priority: 5,
    maxSteps: 25,
    deadlineAt: now + 15 * 60 * 1000,
    skillSetHash: "skillset-phase3-test",
  });
  const claim = claimNextTask(db, { now, leaseMs: 45000 });
  return { inbox, task: db.prepare("SELECT * FROM tasks WHERE id=?").get(claim.taskId), claim };
}

function proposeCard(db, ws, { task, label, now, intent = null, approver = OWNER }) {
  return proposeEffect(db, ws.stateDir, {
    now,
    taskId: task.id,
    attemptId: db.prepare("SELECT id FROM attempts WHERE task_id=? AND attempt_no=?").get(task.id, task.attempt_no).id,
    effectType: "notify",
    domainKey: "dm:telegram:6101",
    naturalKey: `case-${label}`,
    operationIntent:
      intent ?? {
        targetResource: "im:dm:6101",
        operation: "im.notify",
        contentHash: "a".repeat(64),
        evidenceManifestHash: "b".repeat(64),
        extra: { body_preview: "case card" },
      },
    retryMode: "AT_MOST_ONCE",
    provider: "telegram",
    resource: "im:dm:6101",
    requiresApproval: true,
    approverPrincipalId: approver,
    expiresAt: now + 60 * 60 * 1000,
  });
}

function makeConsole(db, ws, { ownerPrincipal = OWNER } = {}) {
  const { token } = ensureConsoleToken(ws.stateDir);
  const app = createConsoleApp(db, {
    recovery: { mode: "open", actions: [], failedStep: null },
    mode: "open",
    token,
    port: 4310,
    stateDir: ws.stateDir,
    ownerPrincipalId: ownerPrincipal,
  });
  return { app, token, fetch: consoleFetch(app) };
}

async function mintSession(fetch, token) {
  const res = await fetch("POST", "/api/session", {
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ token }),
  });
  return res.body;
}

const sessionHeaders = (session) => ({
  authorization: `Bearer ${session.sessionId}`,
  "x-csrf-token": session.csrfToken,
  "content-type": "application/json",
});

// ---------------------------------------------------------------------------
// Case A: double-click. The second identical decision returns "already
// CONSUMED" and never re-consumes: one audit row, one CAS, effect READY once.
{
  const { ws, db, now } = seedWorkspace("ca-double-click");
  const { task } = seedTask(db, ws, { label: "double", now });
  const card = proposeCard(db, ws, { task, label: "double", now });
  const consoleCtx = makeConsole(db, ws);
  const session = await mintSession(consoleCtx.fetch, consoleCtx.token);
  const decide = () =>
    consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(card.approvalId)}/decide`, {
      headers: sessionHeaders(session),
      body: JSON.stringify({ decision: "approve", actionHash: card.actionHash, nonce: card.approvalNonce }),
    });
  const first = await decide();
  const second = await decide();
  const effect = db.prepare("SELECT state FROM effects WHERE id=?").get(card.effectId);
  const consumedAudits = db
    .prepare("SELECT count(*) c FROM audit_log WHERE code='approval_consumed'")
    .get().c;
  suite.check(
    "double-click-consumes-exactly-once",
    first.status === 200 &&
      first.body.accepted === true &&
      second.status === 409 &&
      second.body.accepted === false &&
      /already CONSUMED/.test(second.body.reason ?? "") &&
      effect.state === "READY" &&
      consumedAudits === 1,
    `first=${first.status} second=${second.status}(${second.body.reason}) effect=${effect.state} consumed_audits=${consumedAudits}`,
  );
}

// ---------------------------------------------------------------------------
// Case B: edit creates a new action and a new approval; the old card dies.
// Deciding the OLD card afterwards is refused.
{
  const { ws, db, now } = seedWorkspace("ca-edit");
  const { task } = seedTask(db, ws, { label: "edit", now });
  const card = proposeCard(db, ws, { task, label: "edit", now });
  const consoleCtx = makeConsole(db, ws);
  const session = await mintSession(consoleCtx.fetch, consoleCtx.token);
  const revised = await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(card.approvalId)}/revise`, {
    headers: sessionHeaders(session),
    body: JSON.stringify({
      intent: {
        targetResource: "im:dm:6101",
        operation: "im.notify",
        contentHash: "c".repeat(64),
        evidenceManifestHash: "b".repeat(64),
        extra: { body_preview: "EDITED body" },
      },
      expiresAt: now + 2 * 60 * 60 * 1000,
    }),
  });
  const oldApproval = db.prepare("SELECT state FROM approvals WHERE id=?").get(card.approvalId);
  const oldEffect = db.prepare("SELECT state, business_key FROM effects WHERE id=?").get(card.effectId);
  const newEffectRow = db.prepare("SELECT * FROM effects WHERE id=?").get(revised.body.newEffectId);
  const decideOld = await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(card.approvalId)}/decide`, {
    headers: sessionHeaders(session),
    body: JSON.stringify({ decision: "approve", actionHash: card.actionHash, nonce: card.approvalNonce }),
  });
  const decideNew = await consoleCtx.fetch(
    "POST",
    `/api/approvals/${encodeURIComponent(revised.body.newApprovalId)}/decide`,
    {
      headers: sessionHeaders(session),
      body: JSON.stringify({
        decision: "approve",
        actionHash: revised.body.newActionHash,
        nonce: revised.body.newApprovalNonce,
      }),
    },
  );
  const newEffectAfter = db.prepare("SELECT state FROM effects WHERE id=?").get(revised.body.newEffectId);
  suite.check(
    "edit-mints-new-action-and-kills-old-card",
    revised.status === 200 &&
      oldApproval.state === "INVALIDATED" &&
      oldEffect.state === "CANCELLED" &&
      newEffectRow.business_key.endsWith("~rev1") &&
      newEffectRow.state === "WAITING_APPROVAL" &&
      decideOld.status === 409 &&
      decideOld.body.accepted === false &&
      decideNew.status === 200 &&
      newEffectAfter.state === "READY",
    `revise=${revised.status} old=${oldApproval.state}/${oldEffect.state} newbk=${newEffectRow.business_key.slice(-24)} decideOld=${decideOld.status}(${decideOld.body.reason}) decideNew=${decideNew.status} newEffect=${newEffectAfter.state}`,
  );
}

// ---------------------------------------------------------------------------
// Case C: HEAD drift between approval and dispatch. The dispatcher's head
// precondition refuses inside the CAS window, the old effect is cancelled, a
// NEW card is minted against the CURRENT head, and only after re-approval
// does anything reach the remote — exactly once, never the stale action.
{
  const { ws, db, now } = seedWorkspace("ca-head-change");
  const { task } = seedTask(db, ws, { label: "head", now });
  const fake = createFakeRemote(ws.stateDir, { label: "ca-head-fake" });
  fake.setHead("repo://github.com/x/y", "head1");
  const adapter = createAdapterUpstream(db, {
    baseUpstream: fake,
    policy: { allowRealExternalWrites: false },
    config: { fixedSendingIdentity: "aegispi@local", allowedRecipients: [], allowedRepos: [], allowedBranches: [] },
  });
  const card = proposeCard(db, ws, {
    task,
    label: "head",
    now,
    intent: {
      targetResource: "repo://github.com/x/y",
      operation: "pr.create_draft",
      contentHash: "d".repeat(64),
      expectedHead: "head1",
      evidenceManifestHash: "b".repeat(64),
      extra: { branch: "aegis-fix/test" },
    },
    approver: OWNER,
  });
  const consoleCtx = makeConsole(db, ws);
  const session = await mintSession(consoleCtx.fetch, consoleCtx.token);
  const consumed = await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(card.approvalId)}/decide`, {
    headers: sessionHeaders(session),
    body: JSON.stringify({ decision: "approve", actionHash: card.actionHash, nonce: card.approvalNonce }),
  });
  // The target moves between approval and dispatch.
  fake.setHead("repo://github.com/x/y", "head2");
  let refused = null;
  try {
    const row = db.prepare("SELECT * FROM effects WHERE id=?").get(card.effectId);
    dispatchEffect(db, adapter, { effectId: card.effectId, now: Date.now(), precondition: headPrecondition(adapter, row) });
  } catch (e) {
    refused = e;
  }
  const reproposed = reproposeHeadChanged(db, ws.stateDir, {
    now: Date.now(),
    effectId: card.effectId,
    currentHead: "head2",
    actorId: "daemon-dispatcher",
    expiresAt: now + 60 * 60 * 1000,
  });
  const oldEffect = db.prepare("SELECT state, last_error FROM effects WHERE id=?").get(card.effectId);
  const newEffectRow = db.prepare("SELECT * FROM effects WHERE id=?").get(reproposed.newEffectId);
  const newAction = JSON.parse(newEffectRow.action_json);
  const taskState = db.prepare("SELECT state FROM tasks WHERE id=?").get(task.id);
  const decideNew = await consoleCtx.fetch(
    "POST",
    `/api/approvals/${encodeURIComponent(reproposed.newApprovalId)}/decide`,
    {
      headers: sessionHeaders(session),
      body: JSON.stringify({
        decision: "approve",
        actionHash: reproposed.newActionHash,
        nonce: reproposed.newApprovalNonce,
      }),
    },
  );
  const newRow = db.prepare("SELECT * FROM effects WHERE id=?").get(reproposed.newEffectId);
  dispatchEffect(db, adapter, {
    effectId: reproposed.newEffectId,
    now: Date.now(),
    precondition: headPrecondition(adapter, newRow),
  });
  const finalEffect = db.prepare("SELECT state, external_id FROM effects WHERE id=?").get(reproposed.newEffectId);
  const oldDeliveries = fake.appliedCount(card.businessKey);
  const newDeliveries = fake.appliedCount(newEffectRow.business_key);
  suite.check(
    "head-change-forces-reapproval-never-submits-stale",
    consumed.status === 200 &&
      refused instanceof AdapterRefused &&
      /head_changed/.test(refused.message) &&
      oldEffect.state === "CANCELLED" &&
      oldEffect.last_error === "head_changed" &&
      reproposed.taskReparked === true &&
      taskState.state === "WAITING_APPROVAL" &&
      newAction.expected_head === "head2" &&
      decideNew.status === 200 &&
      finalEffect.state === "SUCCEEDED" &&
      oldDeliveries === 0 &&
      newDeliveries === 1,
    `refused=${refused ? refused.message.slice(0, 60) : "NONE"} old=${oldEffect.state} reparked=${reproposed.taskReparked} newHead=${newAction.expected_head} decide=${decideNew.status} final=${finalEffect.state} oldDelivered=${oldDeliveries} newDelivered=${newDeliveries}`,
  );
}

// ---------------------------------------------------------------------------
// Case D: old attempt. A card minted under fence N cannot be consumed after
// the task minted attempt N+1 (fixture state a crash/recovery can leave
// behind); verifyContext refuses and the card stays unconsumed.
{
  const { ws, db, now } = seedWorkspace("ca-old-attempt");
  const { task } = seedTask(db, ws, { label: "oldfence", now });
  const card = proposeCard(db, ws, { task, label: "oldfence", now });
  // Fixture: a recovery path minted a new attempt and fence under the live
  // card (06 section 6: "新attempt开始前必须取消旧READY动作、失效旧审批；
  // 它们的旧fence不得被新attempt借用" — this fixture asserts the decide-side
  // guard that backs it up).
  db.prepare("UPDATE attempts SET state='FAILED', ended_at=? WHERE task_id=? AND attempt_no=?").run(now, task.id, task.attempt_no);
  db.prepare(
    "INSERT INTO attempts(id, task_id, attempt_no, fence, state, started_at, checkpoint_object_id) VALUES (?,?,?,?,?,?,NULL)",
  ).run(`att:${task.id}:2`, task.id, task.attempt_no + 1, task.fence + 1, "ACTIVE", now);
  db.prepare("UPDATE tasks SET attempt_no=attempt_no+1, fence=fence+1, state='RUNNING' WHERE id=?").run(task.id);
  const result = decideApproval(db, {
    approvalId: card.approvalId,
    decision: "approve",
    actionHash: card.actionHash,
    nonce: card.approvalNonce,
    approverId: OWNER,
    now: now + 1000,
  });
  const approval = db.prepare("SELECT state FROM approvals WHERE id=?").get(card.approvalId);
  const effect = db.prepare("SELECT state FROM effects WHERE id=?").get(card.effectId);
  const staleAudits = db.prepare("SELECT count(*) c FROM audit_log WHERE code='approval_context_stale'").get().c;
  suite.check(
    "old-attempt-card-refused-by-fence-context",
    result.accepted === false &&
      /fence moved/.test(result.reason) &&
      approval.state === "WAITING" &&
      effect.state === "WAITING_APPROVAL" &&
      staleAudits === 1,
    `decide=${result.accepted}(${result.reason}) approval=${approval.state} effect=${effect.state} stale_audits=${staleAudits}`,
  );
}

// ---------------------------------------------------------------------------
// Case E: cancellation linearization, both orders, through the console.
{
  // E1: cancel BEFORE any dispatch — nothing was committed.
  {
    const { ws, db, now } = seedWorkspace("ca-cancel-before");
    const { task } = seedTask(db, ws, { label: "cb", now });
    const card = proposeCard(db, ws, { task, label: "cb", now });
    const consoleCtx = makeConsole(db, ws);
    const session = await mintSession(consoleCtx.fetch, consoleCtx.token);
    const cancel = await consoleCtx.fetch("POST", `/api/tasks/${encodeURIComponent(task.id)}/cancel`, {
      headers: sessionHeaders(session),
      body: JSON.stringify({ reason: "owner cancelled" }),
    });
    const effect = db.prepare("SELECT state FROM effects WHERE id=?").get(card.effectId);
    const approval = db.prepare("SELECT state FROM approvals WHERE id=?").get(card.approvalId);
    const taskAfter = db.prepare("SELECT state, fence FROM tasks WHERE id=?").get(task.id);
    let dispatchRefused = null;
    try {
      const fake = createFakeRemote(ws.stateDir, { label: "cb-fake" });
      const adapter = createAdapterUpstream(db, { baseUpstream: fake, policy: {}, config: {} });
      dispatchEffect(db, adapter, { effectId: card.effectId, now: now + 1000, precondition: () => true });
    } catch (e) {
      dispatchRefused = e;
    }
    suite.check(
      "cancel-before-commit-cancels-everything-uncommitted",
      cancel.status === 200 &&
        cancel.body.outcome === "cancelledBeforeCommit" &&
        effect.state === "CANCELLED" &&
        approval.state === "INVALIDATED" &&
        taskAfter.state === "CANCELLED" &&
        dispatchRefused !== null &&
        /CANCELLED/.test(dispatchRefused.message),
      `outcome=${cancel.body.outcome} effect=${effect.state} approval=${approval.state} task=${taskAfter.state} dispatch=${dispatchRefused ? "refused" : "NOT REFUSED"}`,
    );
  }
  // E2: dispatch committed first (remote applied, response lost -> UNKNOWN).
  // The cancel reports committedEffectsPending and the action is NEVER
  // silently cancelled — it stays for reconciliation.
  {
    const { ws, db, now } = seedWorkspace("ca-cancel-after");
    const { task } = seedTask(db, ws, { label: "ca", now });
    const card = proposeCard(db, ws, { task, label: "ca", now });
    const consoleCtx = makeConsole(db, ws);
    const session = await mintSession(consoleCtx.fetch, consoleCtx.token);
    await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(card.approvalId)}/decide`, {
      headers: sessionHeaders(session),
      body: JSON.stringify({ decision: "approve", actionHash: card.actionHash, nonce: card.approvalNonce }),
    });
    const fake = createFakeRemote(ws.stateDir, { label: "ca-fake" });
    const adapter = createAdapterUpstream(db, {
      baseUpstream: fake,
      transportKind: "fake",
      policy: { allowRealExternalWrites: false },
      config: { fixedSendingIdentity: "aegispi@local", allowedRecipients: [], allowedRepos: [], allowedBranches: [] },
    });
    // The console decide stamped next_attempt_at with the REAL clock; the
    // dispatch clock must be real too, or a slow case setup turns into a
    // spurious "next attempt" refusal.
    dispatchEffect(db, adapter, {
      effectId: card.effectId,
      now: Date.now(),
      precondition: () => true,
      submitMode: "apply_then_die",
    });
    const effectAfterSubmit = db.prepare("SELECT state FROM effects WHERE id=?").get(card.effectId);
    const cancel = await consoleCtx.fetch("POST", `/api/tasks/${encodeURIComponent(task.id)}/cancel`, {
      headers: sessionHeaders(session),
      body: JSON.stringify({ reason: "owner cancelled after commit" }),
    });
    const effectAfterCancel = db.prepare("SELECT state FROM effects WHERE id=?").get(card.effectId);
    const taskAfter = db.prepare("SELECT state FROM tasks WHERE id=?").get(task.id);
    suite.check(
      "cancel-after-commit-retains-unknown-honestly",
      effectAfterSubmit.state === "UNKNOWN" &&
        cancel.status === 200 &&
        cancel.body.outcome === "committedEffectsPending" &&
        cancel.body.retainedCommitted.length === 1 &&
        effectAfterCancel.state === "UNKNOWN" &&
        taskAfter.state === "WAITING_EFFECT",
      `submit=${effectAfterSubmit.state} outcome=${cancel.body.outcome} retained=${cancel.body.retainedCommitted.length} effectAfter=${effectAfterCancel.state} task=${taskAfter.state}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Case F: WHO may decide. The console session acts as its principal; a card
// designated to someone else, a revoked grant, a bootstrap-token-only caller,
// a missing CSRF, a non-JSON body and a cross-origin call all fail closed.
{
  const { ws, db, now } = seedWorkspace("ca-identity");
  const { task } = seedTask(db, ws, { label: "identity", now });
  // A card designated to OTHER, decided by the OWNER session.
  const cardOther = proposeCard(db, ws, { task, label: "identity", now, approver: OTHER });
  const consoleCtx = makeConsole(db, ws);
  const session = await mintSession(consoleCtx.fetch, consoleCtx.token);
  const decideAsOwner = await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(cardOther.approvalId)}/decide`, {
    headers: sessionHeaders(session),
    body: JSON.stringify({ decision: "approve", actionHash: cardOther.actionHash, nonce: cardOther.approvalNonce }),
  });
  const foreignAudit = db
    .prepare("SELECT count(*) c FROM audit_log WHERE code='approval_verification_failed'")
    .get().c;
  suite.check(
    "session-principal-cannot-decide-someone-elses-card",
    decideAsOwner.status === 409 &&
      /designated approver/.test(decideAsOwner.body.reason ?? "") &&
      foreignAudit >= 1,
    `decide=${decideAsOwner.status}(${decideAsOwner.body.reason}) verification_failed_audits=${foreignAudit}`,
  );

  // A card designated to the owner, but the owner's approve grant is revoked.
  const { task: task2 } = seedTask(db, ws, { label: "revoked", now: now + 1000 });
  const cardOwn = proposeCard(db, ws, { task: task2, label: "revoked", now: now + 1000, approver: OWNER });
  revokePermission(db, { scopeId: SCOPE, principalId: OWNER, permission: "approve", now: now + 2000, reason: "revoked mid-card" });
  const decideRevoked = await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(cardOwn.approvalId)}/decide`, {
    headers: sessionHeaders(session),
    body: JSON.stringify({ decision: "approve", actionHash: cardOwn.actionHash, nonce: cardOwn.approvalNonce }),
  });
  suite.check(
    "revoked-approve-grant-fails-closed-at-decide",
    decideRevoked.status === 409 && /no live approve grant/.test(decideRevoked.body.reason ?? ""),
    `decide=${decideRevoked.status}(${decideRevoked.body.reason})`,
  );

  // Bootstrap-token-only callers cannot mutate anything.
  const bootstrapOnly = await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(cardOther.approvalId)}/decide`, {
    headers: { authorization: `Bearer ${consoleCtx.token}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve", actionHash: cardOther.actionHash, nonce: cardOther.approvalNonce }),
  });
  suite.check(
    "bootstrap-token-alone-cannot-approve",
    bootstrapOnly.status === 401 && /session/.test(bootstrapOnly.body.message ?? ""),
    `decide with bootstrap token -> ${bootstrapOnly.status} ${bootstrapOnly.body.code}`,
  );

  // Missing CSRF.
  const noCsrf = await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(cardOther.approvalId)}/decide`, {
    headers: {
      authorization: `Bearer ${session.sessionId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ decision: "approve", actionHash: cardOther.actionHash, nonce: cardOther.approvalNonce }),
  });
  suite.check("missing-csrf-refused", noCsrf.status === 403 && noCsrf.body.code === "csrf_mismatch", `-> ${noCsrf.status} ${noCsrf.body.code}`);

  // Non-JSON mutation bodies.
  const textBody = await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(cardOther.approvalId)}/decide`, {
    headers: { ...sessionHeaders(session), "content-type": "text/plain" },
    body: "decision=approve",
  });
  suite.check("non-json-mutation-refused", textBody.status === 415, `-> ${textBody.status} ${textBody.body.code}`);

  // No credentials at all.
  const anon = await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(cardOther.approvalId)}/decide`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  suite.check("anonymous-mutation-refused", anon.status === 401, `-> ${anon.status} ${anon.body.code}`);

  // Malicious Origin / Host on the approval surface.
  const evilOrigin = await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(cardOther.approvalId)}/decide`, {
    headers: { ...sessionHeaders(session), origin: "http://evil.example" },
    body: JSON.stringify({ decision: "approve" }),
  });
  const evilHost = await consoleCtx.fetch("GET", "/api/approvals", {
    headers: { ...sessionHeaders(session), host: "evil.example:4310" },
  });
  suite.check(
    "malicious-origin-and-host-cannot-operate",
    evilOrigin.status === 403 && evilHost.status === 403,
    `origin=${evilOrigin.status} host=${evilHost.status}`,
  );

  // Session minting requires the real bootstrap token.
  const badMint = await consoleCtx.fetch("POST", "/api/session", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "guessed" }),
  });
  suite.check(
    "session-mint-requires-the-bootstrap-token",
    badMint.status === 401,
    `mint with guessed token -> ${badMint.status}`,
  );
}

// ---------------------------------------------------------------------------
// Case G: revise-side identity — the revising session must hold a live
// approve grant on the action's scope; a session without one cannot mint a
// successor card.
{
  const { ws, db, now } = seedWorkspace("ca-revise-identity");
  const { task } = seedTask(db, ws, { label: "reviseid", now });
  const card = proposeCard(db, ws, { task, label: "reviseid", now });
  const consoleCtx = makeConsole(db, ws);
  const session = await mintSession(consoleCtx.fetch, consoleCtx.token);
  revokePermission(db, { scopeId: SCOPE, principalId: OWNER, permission: "approve", now: now + 100, reason: "revise gate test" });
  const revise = await consoleCtx.fetch("POST", `/api/approvals/${encodeURIComponent(card.approvalId)}/revise`, {
    headers: sessionHeaders(session),
    body: JSON.stringify({
      intent: {
        targetResource: "im:dm:6101",
        operation: "im.notify",
        contentHash: "e".repeat(64),
        evidenceManifestHash: "b".repeat(64),
      },
      expiresAt: now + 60 * 60 * 1000,
    }),
  });
  const oldApproval = db.prepare("SELECT state FROM approvals WHERE id=?").get(card.approvalId);
  suite.check(
    "revise-requires-live-approve-grant",
    revise.status === 403 && oldApproval.state === "WAITING",
    `revise=${revise.status}(${revise.body.message}) old approval untouched=${oldApproval.state}`,
  );
}

// ---------------------------------------------------------------------------
// Case H: the adapter registry backs the approval path — an operation the
// registry does not know can be proposed by legacy tests but the PRODUCTION
// dispatch refuses it; and a real external write through a non-fake
// transport stays fail closed even after approval.
{
  const { ws, db, now } = seedWorkspace("ca-adapter-gates");
  const { task } = seedTask(db, ws, { label: "adapters", now });
  // (a) Unknown operation refuses at dispatch.
  const cardUnknown = proposeCard(db, ws, {
    task,
    label: "unknownop",
    now,
    intent: {
      targetResource: "im:dm:6101",
      operation: "totally.made_up",
      contentHash: "f".repeat(64),
      evidenceManifestHash: "b".repeat(64),
    },
  });
  decideApproval(db, {
    approvalId: cardUnknown.approvalId,
    decision: "approve",
    actionHash: cardUnknown.actionHash,
    nonce: cardUnknown.approvalNonce,
    approverId: OWNER,
    now: now + 100,
  });
  const fake = createFakeRemote(ws.stateDir, { label: "adapter-fake" });
  const adapter = createAdapterUpstream(db, {
    baseUpstream: fake,
    policy: { allowRealExternalWrites: false },
    config: { fixedSendingIdentity: "aegispi@local", allowedRecipients: [], allowedRepos: [], allowedBranches: [] },
  });
  const unknownOutcome = dispatchEffect(db, adapter, {
    effectId: cardUnknown.effectId,
    now: now + 200,
    precondition: () => true,
  });
  const unknownEffect = db.prepare("SELECT state, last_error FROM effects WHERE id=?").get(cardUnknown.effectId);
  // (b) A REAL transport (label does not start with "fake") stays fail
  // closed for external writes even after approval, even though the policy
  // flag would allow it — because a real transport is never wired in this
  // phase without credentials; simulate the "real" side with a non-fake
  // labeled upstream.
  const realish = createFakeRemote(ws.stateDir, { label: "pretend-real" });
  const realAdapter = createAdapterUpstream(db, {
    baseUpstream: realish,
    transportKind: "real", // a REAL transport is declared, not sniffed from a label
    policy: { allowRealExternalWrites: true },
    credentials: {}, // nothing is wired in this phase
    config: { fixedSendingIdentity: "aegispi@local", allowedRecipients: [], allowedRepos: [], allowedBranches: [] },
  });
  const { task: task2 } = seedTask(db, ws, { label: "realwrite", now: now + 300 });
  const cardWrite = proposeCard(db, ws, {
    task: task2,
    label: "realwrite",
    now: now + 300,
    intent: {
      targetResource: "repo://github.com/x/y",
      operation: "pr.create_draft",
      contentHash: "1".repeat(64),
      expectedHead: "headX",
      evidenceManifestHash: "b".repeat(64),
      extra: { branch: "aegis-fix/test" },
    },
  });
  decideApproval(db, {
    approvalId: cardWrite.approvalId,
    decision: "approve",
    actionHash: cardWrite.actionHash,
    nonce: cardWrite.approvalNonce,
    approverId: OWNER,
    now: now + 400,
  });
  const writeOutcome = dispatchEffect(db, realAdapter, {
    effectId: cardWrite.effectId,
    now: now + 500,
    precondition: () => true,
  });
  const writeEffect = db.prepare("SELECT state, last_error FROM effects WHERE id=?").get(cardWrite.effectId);
  // (c) Chargeable operations refuse without a reservation id.
  const { task: task3 } = seedTask(db, ws, { label: "chargeable", now: now + 600 });
  const cardModel = proposeCard(db, ws, {
    task: task3,
    label: "chargeable",
    now: now + 600,
    intent: {
      targetResource: "model://deepseek/deepseek-flash",
      operation: "model.inference",
      contentHash: "2".repeat(64),
      evidenceManifestHash: "b".repeat(64),
      extra: { purpose: "worker" },
    },
  });
  decideApproval(db, {
    approvalId: cardModel.approvalId,
    decision: "approve",
    actionHash: cardModel.actionHash,
    nonce: cardModel.approvalNonce,
    approverId: OWNER,
    now: now + 700,
  });
  const modelOutcome = dispatchEffect(db, adapter, {
    effectId: cardModel.effectId,
    now: now + 800,
    precondition: () => true,
  });
  const modelEffect = db.prepare("SELECT state, last_error FROM effects WHERE id=?").get(cardModel.effectId);
  suite.check(
    "adapter-registry-gates-unknown-real-and-chargeable",
    unknownOutcome.state === "FAILED" &&
      /not in the trusted registry/.test(unknownEffect.last_error) &&
      writeOutcome.state === "FAILED" &&
      /credentials.*fail closed|fail closed.*credentials/.test(writeEffect.last_error) &&
      modelOutcome.state === "FAILED" &&
      /without a budget reservation/.test(modelEffect.last_error),
    `unknown->FAILED(${unknownEffect.last_error.slice(0, 40)}) realwrite->${writeOutcome.state}(${writeEffect.last_error.slice(0, 60)}) chargeable->${modelOutcome.state}(${modelEffect.last_error.slice(0, 50)})`,
  );
}

writeReport({
  suiteId: "cancel-approval",
  suite,
  label: "test:cancel-approval — 审批/取消线性化（生产路径，fake 远端）",
  extra: {
    dataSources:
      "本地 SQLite 工作区 + fake 远端（唯一传输缝）；审批/取消/编辑全部经控制台会话（session+CSRF+JSON）生产端点驱动；无真实外部调用，无模型调用",
  },
});
process.exit(suiteExit(suite, { label: "test:cancel-approval" }));
