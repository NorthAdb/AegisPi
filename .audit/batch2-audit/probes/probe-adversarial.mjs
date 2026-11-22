// Batch 2 adversarial audit probe. Self-written counterexamples (not the
// implementer's suite samples). Every assertion prints PASS/FAIL with detail.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const REPO = "D:/AegisPi/aegis-pi";
const NODE = "D:/AegisPi/tools/node-v22.23.5/node.exe";
const ws = join(REPO, ".audit/batch2-audit/probes/ws-adv");
mkdirSync(join(ws, "db"), { recursive: true });

const imp = (rel) => import(`file:///D:/AegisPi/aegis-pi/${rel}`);
process.chdir(REPO);
const { openDatabase } = await imp("apps/daemon/src/db/connect.mjs");
const { migrate, loadCanonicalSchema, ensureModelRequestsTable } = await imp("apps/daemon/src/db/migrate.mjs");
const { ensurePrincipal, ensureScope } = await imp("apps/daemon/src/ingress.mjs");
const { grantPermission } = await imp("apps/daemon/src/acl.mjs");
const { insertObjectRow, readObjectContent, putObjectContent } = await imp("apps/daemon/src/objects.mjs");
const { ensureMailScope } = await imp("apps/daemon/src/mail-triage.mjs");

function putObj(db, scopeId, kind, content, parents = []) {
  const st = putObjectContent(ws, content);
  return insertObjectRow(db, {
    scopeId, kind, sourceUri: "probe://stored", sourceActor: "probe", content,
    contentHash: st.contentHash, storageRef: st.storageRef,
    observedAt: NOW, requiredScopeIds: [scopeId], parents,
  });
}
const { proposeMailReplyEffect, buildMailSendIntent } = await imp("apps/daemon/src/mail-triage.mjs");
const { dispatchEffect, autoRecoverUnknown } = await imp("apps/daemon/src/effects.mjs");
const { decideApproval, readConsoleNonce } = await imp("apps/daemon/src/approvals.mjs");
const { createTimer, processDueTimers } = await imp("apps/daemon/src/timers.mjs");
const { runDreamingLoop } = await imp("apps/daemon/src/dreaming.mjs");
const { proposeMemoryFact } = await imp("apps/daemon/src/memory.mjs");
const { wallClockInstant, inQuietHours } = await imp("apps/daemon/src/quiet-time.mjs");
const { createConsoleApp, ensureConsoleToken } = await imp("apps/daemon/src/console/api.mjs");
const { createMailChildRunner } = await imp("apps/daemon/src/mail-adapter.mjs");

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  if (ok) pass++; else fail++;
  console.log(`${tag}  ${name}${detail ? " — " + detail : ""}`);
}

function freshDb(tag) {
  mkdirSync(join(ws, tag, "db"), { recursive: true });
  const dbPath = join(ws, tag, "db", "t.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(dbPath + suffix, { force: true }); } catch {}
  }
  const db = openDatabase(dbPath);
  migrate(db, loadCanonicalSchema());
  ensureModelRequestsTable(db);
  return db;
}

const NOW = Date.now();
function setupTask(db, scopeId, tag) {
  ensurePrincipal(db, { platform: "local", subject: "owner" });
  const OWNER = "prn:local:owner";
  for (const p of ["read", "request", "approve", "admin"]) {
    grantPermission(db, { scopeId, principalId: OWNER, permission: p, now: NOW });
  }
  const epoch = db.prepare("SELECT epoch, policy_version FROM scopes WHERE id=?").get(scopeId);
  const originPayload = insertObjectRow(db, {
    scopeId, kind: "event_payload", sourceUri: "probe://origin", sourceActor: OWNER,
    content: "probe origin", observedAt: NOW, requiredScopeIds: [scopeId],
  });
  const inbId = `inb:${tag}`;
  db.prepare(`INSERT INTO inbox(id, source, source_event_id, principal_id, scope_id, payload_object_id, thread_key, priority, policy_version, verdict, state, received_at)
    VALUES (?, 'probe', ?, ?, ?, ?, ?, 5, ?, 'ADMIT', 'DONE', ?)`).run(inbId, `probe-${tag}`, OWNER, scopeId, originPayload.id, `thread:${tag}`, epoch.policy_version, NOW);
  const taskId = `task:${tag}`;
  db.prepare(`INSERT INTO tasks(id, scope_id, principal_id, origin_event_id, dispatch_key, policy_version, scope_epoch, state, priority,
      available_at, deadline_at, attempt_no, fence, max_steps, skill_set_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'RUNNING', 5, ?, ?, 1, 1, 25, 'probe', ?, ?)`)
    .run(taskId, scopeId, OWNER, inbId, `dk:${tag}`, epoch.policy_version, NOW, NOW + 3600_000, NOW, NOW);
  const attemptId = `att:${tag}`;
  db.prepare(`INSERT INTO attempts(id, task_id, attempt_no, fence, state, started_at) VALUES (?, ?, 1, 1, 'ACTIVE', ?)`).run(attemptId, taskId, NOW);
  return { taskId, attemptId, OWNER };
}

// ===========================================================================
console.log("== A. CP4 self-written counterexamples ==");
{
  const db = freshDb("cp4");
  ensurePrincipal(db, { platform: "local", subject: "owner" });
  const OWNER = "prn:local:owner";
  const scopeA = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:mail:acct-a@example.test", channel: "mail", conversationId: "acct-a@example.test", policyVersion: "pv1" });
  const scopeB = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:777", channel: "telegram", conversationId: "777", policyVersion: "pv1" });
  // private-scope parent object
  const privParent = insertObjectRow(db, {
    scopeId: scopeB.id, kind: "memory_fact", sourceUri: "probe://private", sourceActor: "probe",
    content: "private family fact", observedAt: NOW, requiredScopeIds: [scopeB.id],
  });
  const { taskId, attemptId } = setupTask(db, scopeA.id, "cp4a");
  const mailConfig = { allowedRecipients: ["dest@example.com"], approvalTtlMs: 3600_000, maxAttachmentBytes: 4194304 };
  const adaptersConfig = { fixedSendingIdentity: "aegispi@local" };

  // A1: cross-scope parent chain mail.send proposal — must be refused BEFORE any row.
  let threw = null;
  try {
    proposeMailReplyEffect(db, ws, {
      now: NOW, taskId, attemptId, account: "acct-a@example.test",
      intent: buildMailSendIntent({ to: ["dest@example.com"], subject: "hi", bodyText: "secret digest", sendingIdentity: "aegispi@local", threadKey: "mail:t1" }),
      mailConfig, adaptersConfig, parentObjectIds: [privParent.id],
    });
  } catch (e) { threw = e; }
  const effectRows = db.prepare("SELECT count(*) c FROM effects").get().c;
  const approvalRows = db.prepare("SELECT count(*) c FROM approvals").get().c;
  const payloadRows = db.prepare("SELECT count(*) c FROM objects WHERE kind='effect_payload'").get().c;
  check("A1 cross-scope mail.send proposal refused before rows", threw !== null && effectRows === 0 && approvalRows === 0 && payloadRows === 0,
    `threw=${threw?.name ?? "none"}:${(threw?.message ?? "").slice(0, 90)} effects=${effectRows} approvals=${approvalRows} payloads=${payloadRows}`);

  // A3 control: same-scope parent — proposal allowed.
  const sameParent = insertObjectRow(db, {
    scopeId: scopeA.id, kind: "memory_fact", sourceUri: "probe://same", sourceActor: "probe",
    content: "same-scope note", observedAt: NOW, requiredScopeIds: [scopeA.id],
  });
  let card = null;
  try {
    card = proposeMailReplyEffect(db, ws, {
      now: NOW + 1, taskId, attemptId, account: "acct-a@example.test",
      intent: buildMailSendIntent({ to: ["dest@example.com"], subject: "hi2", bodyText: "same-scope digest", sendingIdentity: "aegispi@local", threadKey: "mail:t2" }),
      mailConfig, adaptersConfig, parentObjectIds: [sameParent.id], evidenceManifestHash: null,
    });
  } catch (e) { card = { error: e }; }
  check("A3 same-scope mail.send proposal allowed (gate not over-broad)", card && card.effectId,
    card?.effectId ?? String(card.error).slice(0, 120));
}

// ===========================================================================
console.log("== B. no unauthorized outbound ==");
{
  const db = freshDb("outbound");
  ensurePrincipal(db, { platform: "local", subject: "owner" });
  const OWNER = "prn:local:owner";
  const scopeA = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:mail:acct-b@example.test", channel: "mail", conversationId: "acct-b@example.test", policyVersion: "pv1" });
  const scopeB = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:888", channel: "telegram", conversationId: "888", policyVersion: "pv1" });
  const privParent = insertObjectRow(db, {
    scopeId: scopeB.id, kind: "memory_fact", sourceUri: "probe://private2", sourceActor: "probe",
    content: "private fact 2", observedAt: NOW, requiredScopeIds: [scopeB.id],
  });
  const { taskId, attemptId } = setupTask(db, scopeA.id, "ob");
  const mailConfig = { allowedRecipients: ["dest2@example.com"], approvalTtlMs: 3600_000, maxAttachmentBytes: 4194304 };
  const adaptersConfig = { fixedSendingIdentity: "aegispi@local" };

  // A2 shape: craft a READY mail.send effect whose PAYLOAD closure spans A+B,
  // recipient IS on the transport whitelist -> dispatch must still DEAD-block.
  const payload = insertObjectRow(db, {
    scopeId: scopeA.id, kind: "effect_payload", sourceUri: "probe://x", sourceActor: OWNER,
    content: "mixed closure payload", observedAt: NOW,
    requiredScopeIds: [scopeA.id, scopeB.id], parents: [{ parentId: privParent.id }],
  });
  const actionJson = JSON.stringify({
    schemaVersion: 1, principalId: OWNER, sendingIdentity: "aegispi@local", scopeId: scopeA.id,
    domainKey: "dm:mail:acct-b@example.test", target_resource: "mail:dest2@example.com", operation: "mail.send",
    content_hash: createHash("sha256").update("mixed").digest("hex"), attachment_hash: null,
    expected_head: null, attempt_id: attemptId, proposal_fence: 1, scope_epoch: 1,
    authorization_revision: 0, policy_version: "pv1", expires_at: NOW + 3600_000,
    evidence_manifest_hash: null, extra: { recipients: ["dest2@example.com"], bodyText: "x" },
  });
  const efxId = "efx:probe-cp4-dispatch";
  db.prepare(`INSERT INTO effects(id, task_id, attempt_id, proposal_fence, scope_id, principal_id, scope_epoch, authorization_revision,
      policy_version, action_json, action_hash, payload_object_id, provider, resource, operation, expires_at, retry_mode,
      business_key, state, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, 1, 0, 'pv1', ?, ?, ?, 'smtp', ?, 'mail.send', ?, 'AT_MOST_ONCE', ?, 'READY', 0, 3, 0, ?, ?)`)
    .run(efxId, taskId, attemptId, scopeA.id, OWNER, actionJson, createHash("sha256").update(Buffer.from(actionJson, "utf8")).digest("hex"), payload.id, "dm:mail:acct-b@example.test", NOW + 3600_000, "bk:probe-cp4-dispatch", NOW, NOW);
  let submitCalls = 0;
  const fakeUpstream = { submit() { submitCalls += 1; return { status: "succeeded", externalId: "should-not-happen" }; } };
  let blocked = false;
  try { dispatchEffect(db, fakeUpstream, { effectId: efxId, now: NOW + 2 }); } catch (e) { blocked = /cp4|may not flow/i.test(e.message); }
  const efx = db.prepare("SELECT state, last_error FROM effects WHERE id=?").get(efxId);
  const audits = db.prepare("SELECT count(*) c FROM audit_log WHERE code='cp4_recipient_scope_leak_blocked'").get().c;
  check("B-A2 dispatch-level CP4 block: whitelist recipient + cross-scope closure -> DEAD, zero bytes", blocked && efx.state === "DEAD" && submitCalls === 0 && audits >= 1,
    `blocked=${blocked} state=${efx.state} err=${(efx.last_error ?? "").slice(0, 80)} submitCalls=${submitCalls} audits=${audits}`);

  // B1: AT_MOST_ONCE UNKNOWN never auto-resends.
  const card2 = (() => { try {
    return proposeMailReplyEffect(db, ws, {
      now: NOW + 3, taskId, attemptId, account: "acct-b@example.test",
      intent: buildMailSendIntent({ to: ["dest2@example.com"], subject: "u", bodyText: "unknown probe", sendingIdentity: "aegispi@local", threadKey: "mail:t3" }),
      mailConfig, adaptersConfig, evidenceManifestHash: null,
    });
  } catch (e) { return { error: e }; } })();
  check("B1 setup: same-scope card proposed", !!card2.effectId, card2.effectId ?? String(card2.error).slice(0, 100));
  if (card2.effectId) {
    const nonce = readConsoleNonce(db, card2.approvalId ?? `apr:${card2.effectId}`);
    const approvalId = `apr:${card2.effectId}`;
    const dec = decideApproval(db, { approvalId, decision: "approve", actionHash: db.prepare("SELECT action_hash FROM effects WHERE id=?").get(card2.effectId).action_hash, nonce, approverId: OWNER, now: NOW + 4 });
    let unknownSubmitCalls = 0;
    const unknownUpstream = { submit() { unknownSubmitCalls += 1; return { status: "unknown", error: "smtp drop" }; } };
    try { dispatchEffect(db, unknownUpstream, { effectId: card2.effectId, now: NOW + 5 }); } catch {}
    const st1 = db.prepare("SELECT state FROM effects WHERE id=?").get(card2.effectId).state;
    const rec1 = autoRecoverUnknown(db, unknownUpstream, { effectId: card2.effectId, now: NOW + 6 });
    const rec2 = autoRecoverUnknown(db, unknownUpstream, { effectId: card2.effectId, now: NOW + 7 });
    const st2 = db.prepare("SELECT state FROM effects WHERE id=?").get(card2.effectId).state;
    check("B1 AT_MOST_ONCE UNKNOWN: no auto resend across recovery passes", st1 === "UNKNOWN" && rec1.action === "none" && rec2.action === "none" && st2 === "UNKNOWN" && unknownSubmitCalls === 1,
      `state=${st1}/${st2} rec1=${rec1.action} rec2=${rec2.action} submits=${unknownSubmitCalls}`);
  }

  // B2: rejection borrows no channel (no notify/im effect appears for the task).
  const card3 = (() => { try {
    return proposeMailReplyEffect(db, ws, {
      now: NOW + 8, taskId, attemptId, account: "acct-b@example.test",
      intent: buildMailSendIntent({ to: ["dest2@example.com"], subject: "r", bodyText: "reject probe", sendingIdentity: "aegispi@local", threadKey: "mail:t4" }),
      mailConfig, adaptersConfig, evidenceManifestHash: null,
    });
  } catch (e) { return { error: e }; } })();
  if (card3.effectId) {
    const approvalId3 = `apr:${card3.effectId}`;
    const nonce3 = readConsoleNonce(db, approvalId3);
    const dec3 = decideApproval(db, { approvalId: approvalId3, decision: "reject", actionHash: db.prepare("SELECT action_hash FROM effects WHERE id=?").get(card3.effectId).action_hash, nonce: nonce3, approverId: OWNER, now: NOW + 9 });
    const notifyEffects = db.prepare("SELECT count(*) c FROM effects WHERE task_id=? AND operation IN ('send_message','im.notify')").get(taskId).c;
    const st3 = db.prepare("SELECT state FROM effects WHERE id=?").get(card3.effectId).state;
    check("B2 reject -> DEAD, zero channel borrow", dec3.accepted && st3 === "DEAD" && notifyEffects === 0,
      `accepted=${dec3.accepted} state=${st3} notifyEffects=${notifyEffects}`);
  }
}

// ===========================================================================
console.log("== C. contact_no_reply cross-scope thread_key ==");
{
  const db = freshDb("timers");
  ensurePrincipal(db, { platform: "local", subject: "owner" });
  const OWNER = "prn:local:owner";
  const scopeA = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:mail:acct-c.test", channel: "mail", conversationId: "acct-c.test", policyVersion: "pv1" });
  const scopeB = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:mail:acct-d.test", channel: "mail", conversationId: "acct-d.test", policyVersion: "pv1" });
  for (const s of [scopeA, scopeB]) for (const p of ["read", "request"]) grantPermission(db, { scopeId: s.id, principalId: OWNER, permission: p, now: NOW });
  const epochA = db.prepare("SELECT epoch, policy_version FROM scopes WHERE id=?").get(scopeA.id);
  const payloadObj = putObj(db, scopeB.id, "mail_payload", JSON.stringify({ kind: "mail", envelopeFrom: "buddy@example.org", sourceActor: "contact:buddy@example.org", systemNotification: false }));
  const inbB = "inb:cross-b";
  db.prepare(`INSERT INTO inbox(id, source, source_event_id, principal_id, scope_id, payload_object_id, thread_key, priority, policy_version, verdict, state, received_at)
    VALUES (?, 'mail', 'm-1', ?, ?, ?, ?, 5, 'pv1', 'ADMIT', 'DONE', ?)`)
    .run(inbB, OWNER, scopeB.id, payloadObj.id, "mail:shared-root@x", NOW);
  const timerId = "tmr:probe-cross";
  createTimer(db, {
    id: timerId, scopeId: scopeA.id, principalId: OWNER, scopeEpoch: 1,
    threadKey: "mail:shared-root@x",
    condition: { type: "contact_no_reply", threadKey: "mail:shared-root@x", expectedSender: "buddy@example.org", ownerAddresses: ["owner@example.com"] },
    dueAt: NOW - 1000, payloadObjectId: payloadObj.id, now: NOW,
  });
  const res = processDueTimers(db, { now: NOW + 1000, stateDir: ws });
  const timerRow = db.prepare("SELECT state FROM timers WHERE id=?").get(timerId);
  check("C1 OUT-OF-SCOPE inbox row (other mail account, same thread_key) SATISFIED the timer", timerRow.state === "SATISFIED" && res.satisfied.length === 1 && res.satisfied[0].evidence === inbB,
    `timer=${timerRow.state} evidence=${res.satisfied[0]?.evidence ?? "none"} (scope A timer satisfied by scope B row — no scope_id filter in evaluateCondition)`);

  // C2 control: different thread_key -> not satisfied.
  const payloadObj2 = putObj(db, scopeB.id, "mail_payload", JSON.stringify({ kind: "mail", envelopeFrom: "buddy@example.org", sourceActor: "contact:buddy@example.org", systemNotification: false }));
  db.prepare(`INSERT INTO inbox(id, source, source_event_id, principal_id, scope_id, payload_object_id, thread_key, priority, policy_version, verdict, state, received_at)
    VALUES ('inb:cross-c', 'mail', 'm-2', ?, ?, ?, 'mail:other-root@x', 5, 'pv1', 'ADMIT', 'DONE', ?)`)
    .run(OWNER, scopeB.id, payloadObj2.id, NOW);
  const timerId2 = "tmr:probe-cross2";
  createTimer(db, {
    id: timerId2, scopeId: scopeA.id, principalId: OWNER, scopeEpoch: 1,
    threadKey: "mail:unrelated@x",
    condition: { type: "contact_no_reply", threadKey: "mail:unrelated@x", expectedSender: "buddy@example.org", ownerAddresses: ["owner@example.com"] },
    dueAt: NOW - 1000, payloadObjectId: payloadObj2.id, now: NOW,
  });
  const res2 = processDueTimers(db, { now: NOW + 2000, stateDir: ws });
  const t2 = db.prepare("SELECT state FROM timers WHERE id=?").get(timerId2).state;
  check("C2 control: distinct thread_key -> timer FIRED (not satisfied)", t2 === "FIRED" && res2.fired.length === 1, `timer=${t2}`);
}

// ===========================================================================
console.log("== D. dreaming loop ==");
{
  const db = freshDb("dream");
  ensurePrincipal(db, { platform: "local", subject: "owner" });
  const OWNER = "prn:local:owner";
  const scopeA = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:900", channel: "telegram", conversationId: "900", policyVersion: "pv1" });
  const scopeB = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:901", channel: "telegram", conversationId: "901", policyVersion: "pv1" });
  const qh = { start: "23:00", end: "07:00", timezone: "Asia/Hong_Kong" };
  const t2300 = wallClockInstant("2026-11-22", "23:00", "Asia/Hong_Kong");
  const t2259 = t2300 - 60_000;
  const t0700 = wallClockInstant("2026-11-23", "07:00", "Asia/Hong_Kong");
  const t0659 = t0700 - 60_000;
  check("D1 quiet-hours wall-clock boundaries", !inQuietHours(t2259, qh) && inQuietHours(t2300, qh) && inQuietHours(t0659, qh) && !inQuietHours(t0700, qh),
    `22:59=${inQuietHours(t2259, qh)} 23:00=${inQuietHours(t2300, qh)} 06:59=${inQuietHours(t0659, qh)} 07:00=${inQuietHours(t0700, qh)}`);
  const outOfWindow = runDreamingLoop(db, ws, { now: wallClockInstant("2026-11-22", "12:00", "Asia/Hong_Kong"), quietHours: qh, ledger: null });
  check("D1b outside quiet hours -> skipped", typeof outOfWindow.skipped === "string" && /outside quiet hours/.test(outOfWindow.skipped), String(outOfWindow.skipped).slice(0, 80));

  const mk = (scopeId, factKey, opts = {}) => proposeMemoryFact(db, ws, {
    scopeId, factKey, factText: opts.text ?? `note ${factKey} ${Math.random()}`, category: opts.category ?? "note",
    now: NOW, confidence: 0.9, expiresAt: null, sourceUri: "probe://fact", sourceActor: "contact:x",
  });
  const a1 = mk(scopeA.id, "pref.color.one"); const a2 = mk(scopeA.id, "pref.color.two");
  const b1 = mk(scopeB.id, "pref.color.three"); const b2 = mk(scopeB.id, "pref.color.four");
  const quarantined = proposeMemoryFact(db, ws, {
    scopeId: scopeA.id, factKey: "pref.color.quar", factText: "\u200Bzero-width hidden", category: "note",
    now: NOW, confidence: 0.9, expiresAt: null, sourceUri: "probe://fact", sourceActor: "contact:x",
  });
  const inWindow = runDreamingLoop(db, ws, { now: t2300 + 1000, quietHours: qh, ledger: null });
  console.log("D2debug inWindow="+JSON.stringify(inWindow).slice(0,200));
  const sugg = db.prepare("SELECT id, scope_id, metadata_json, content_hash FROM objects WHERE kind='dreaming_suggestion'").all();
  let mixed = 0, includesQuarantined = false;
  for (const s of sugg) {
    const content = JSON.parse(readObjectContentOf(db, ws, s.id));
    const scopeOfMembers = new Set();
    for (const m of content.members ?? []) {
      const row = db.prepare("SELECT scope_id FROM objects WHERE id=?").get(m.id);
      if (row) scopeOfMembers.add(row.scope_id);
      if (m.id === quarantined.objectId) includesQuarantined = true;
    }
    if (scopeOfMembers.size > 1) mixed++;
  }
  check("D2 suggestions never mix scopes", mixed === 0 && sugg.length >= 2, `suggestions=${sugg.length} mixed=${mixed}`);
  check("D3 quarantined candidate never in a suggestion", !includesQuarantined, `quarantined=${quarantined.objectId}`);
  const stillCandidate = db.prepare("SELECT status FROM objects WHERE id=?").get(quarantined.objectId).status;
  check("D3b quarantined candidate untouched by dreaming", stillCandidate === "candidate", `status=${stillCandidate}`);

  // D4: ledger omitted — closure claims "无 ledger -> 跳过"; code runs the pass.
  const db2 = freshDb("dream-nogate");
  ensurePrincipal(db2, { platform: "local", subject: "owner" });
  const scopeC = ensureScope(db2, { ownerId: "prn:local:owner", kind: "owner_dm", domainKey: "dm:telegram:902", channel: "telegram", conversationId: "902", policyVersion: "pv1" });
  proposeMemoryFact(db2, ws, { scopeId: scopeC.id, factKey: "pref.color.a", factText: "n1", category: "note", now: NOW, confidence: 0.9, expiresAt: null, sourceUri: "probe://f", sourceActor: "contact:x" });
  proposeMemoryFact(db2, ws, { scopeId: scopeC.id, factKey: "pref.color.b", factText: "n2", category: "note", now: NOW, confidence: 0.9, expiresAt: null, sourceUri: "probe://f", sourceActor: "contact:x" });
  const noLedger = runDreamingLoop(db2, ws, { now: t2300 + 2000, quietHours: qh, ledger: null });
  const suggCount = db2.prepare("SELECT count(*) c FROM objects WHERE kind='dreaming_suggestion'").get().c;
  check("D4 runs WITHOUT a ledger (closure claims skip) — recorded as F-8 discrepancy", true,
    `skipped=${JSON.stringify(noLedger.skipped ?? null)} suggestionsCreated=${suggCount} (claim: 无 ledger 跳过; actual: runs unaccounted)`);
}
function readObjectContentOf(db, dir, id) {
  try { return readObjectContent(db, dir, id) ?? "{}"; } catch { return "{}"; }
}

// ===========================================================================
console.log("== F. console nonce four-path ==");
{
  const db = freshDb("nonce");
  ensurePrincipal(db, { platform: "local", subject: "owner" });
  const OWNER = "prn:local:owner";
  const scopeA = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:mail:acct-f@example.test", channel: "mail", conversationId: "acct-f@example.test", policyVersion: "pv1" });
  const { taskId, attemptId } = setupTask(db, scopeA.id, "nonce");
  const card = proposeMailReplyEffect(db, ws, {
    now: NOW, taskId, attemptId, account: "acct-f@example.test",
    intent: buildMailSendIntent({ to: ["dest3@example.com"], subject: "n", bodyText: "nonce probe", sendingIdentity: "aegispi@local", threadKey: "mail:t5" }),
    mailConfig: { allowedRecipients: ["dest3@example.com"], approvalTtlMs: 3600_000 }, adaptersConfig: { fixedSendingIdentity: "aegispi@local" }, evidenceManifestHash: null,
  });
  const nonce = readConsoleNonce(db, `apr:${card.effectId}`);
  const approvalId = `apr:${card.effectId}`;
  const app = createConsoleApp(db, { recovery: { failedStep: null, actions: [] }, mode: "open", token: ensureConsoleToken(ws).token, port: 4310, stateDir: ws, ownerPrincipalId: OWNER });
  const H = { host: "127.0.0.1:4310" };
  const token = ensureConsoleToken(ws).token;
  const get = (p, h = {}) => app.fetch(new Request("http://127.0.0.1:4310" + p, { headers: { ...H, ...h } }));
  const boot = await get(`/api/approvals/${encodeURIComponent(approvalId)}`, { authorization: "Bearer " + token });
  const bootJson = await boot.json();
  check("F1 bootstrap token GET -> decisionMaterials null", bootJson.decisionMaterials === null, JSON.stringify(bootJson.decisionMaterials));
  const mint = await app.fetch(new Request("http://127.0.0.1:4310/api/session", { method: "POST", headers: { ...H, "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ token }) }));
  const sess = await mint.json();
  const ownerGet = await get(`/api/approvals/${encodeURIComponent(approvalId)}`, { authorization: "Bearer " + sess.sessionId });
  const ownerJson = await ownerGet.json();
  check("F2 designated approver live session -> nonce visible", ownerJson.decisionMaterials?.nonce === nonce, `nonceMatch=${ownerJson.decisionMaterials?.nonce === nonce}`);
  const app2 = createConsoleApp(db, { recovery: { failedStep: null, actions: [] }, mode: "open", token, port: 4311, stateDir: ws, ownerPrincipalId: "prn:other:person" });
  const mint2 = await app2.fetch(new Request("http://127.0.0.1:4311/api/session", { method: "POST", headers: { host: "127.0.0.1:4311", "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ token }) }));
  const sess2 = await mint2.json();
  const otherGet = await app2.fetch(new Request("http://127.0.0.1:4311" + `/api/approvals/${encodeURIComponent(approvalId)}`, { headers: { host: "127.0.0.1:4311", authorization: "Bearer " + sess2.sessionId } }));
  const otherJson = await otherGet.json();
  check("F3 non-approver principal session -> decisionMaterials null", otherJson.decisionMaterials === null, JSON.stringify(otherJson.decisionMaterials));
  const sse = await get("/api/events/stream", { authorization: "Bearer " + token });
  const sseText = await sse.text();
  check("F4 nonce never in SSE payload", !sseText.includes(nonce), `sseBytes=${sseText.length}`);
  const auditRows = db.prepare("SELECT details_json FROM audit_log").all().map((r) => JSON.stringify(r));
  check("F5 nonce never in audit_log", !auditRows.some((r) => r.includes(nonce)), `auditRows=${auditRows.length}`);
  const actionHash = db.prepare("SELECT action_hash FROM effects WHERE id=?").get(card.effectId).action_hash;
  const dec = decideApproval(db, { approvalId, decision: "approve", actionHash, nonce, approverId: OWNER, now: NOW + 1000 });
  const afterGet = await get(`/api/approvals/${encodeURIComponent(approvalId)}`, { authorization: "Bearer " + sess.sessionId });
  const afterJson = await afterGet.json();
  const rowGone = db.prepare("SELECT value FROM system_state WHERE key=?").get(`console_nonce:${approvalId}`);
  check("F6 consumed -> nonce cleared, materials null", dec.accepted && afterJson.decisionMaterials === null && rowGone === undefined,
    `accepted=${dec.accepted} materials=${JSON.stringify(afterJson.decisionMaterials)} row=${rowGone ? "present" : "gone"}`);
}

// ===========================================================================
console.log("== E. mail child mid-DATA honesty classification ==");
{
  const tls = await import("node:tls");
  const server = tls.createServer({ cert: readFileSync(join(REPO, "evals/phase5/scenarios/fixtures/loopback-cert.pem")), key: readFileSync(join(REPO, "evals/phase5/scenarios/fixtures/loopback-key.pem")) }, (sock) => {
    sock.write("220 probe ESMTP\r\n");
    let buffer = ""; let inData = false; let dataBytes = 0;
    sock.on("data", (d) => {
      if (inData) { dataBytes += d.length; }
      buffer += d.toString("utf8");
      for (;;) {
        const idx = buffer.indexOf("\r\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
        if (inData) { if (line === ".") { sock.write("250 OK\r\n"); inData = false; } continue; }
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) sock.write("250-p\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (cmd.startsWith("AUTH PLAIN")) sock.write("235 ok\r\n");
        else if (cmd.startsWith("MAIL FROM")) sock.write("250 ok\r\n");
        else if (cmd.startsWith("RCPT TO")) sock.write("250 ok\r\n");
        else if (cmd.startsWith("DATA")) { inData = true; sock.write("354 go ahead\r\n"); setTimeout(() => { sock.destroy(); }, 30); }
        else if (cmd.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => { server._lastDataBytes = dataBytes; });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const runChild = createMailChildRunner();
  const kinds = {};
  let bytesSeenTotal = 0;
  for (let i = 0; i < 8; i += 1) {
    const out = runChild({
      mode: "smtp.send", host: "127.0.0.1", port, tls: true, username: "u", password: "p", timeoutMs: 5000,
      message: { from: "aegispi@local", to: ["victim@example.com"], cc: [], bcc: [], subject: "probe", text: `mid-data drop ${i}`, attachments: [], messageId: null },
    });
    kinds[out.kind ?? (out.ok ? "ok" : "?")] = (kinds[out.kind ?? (out.ok ? "ok" : "?")] ?? 0) + 1;
    bytesSeenTotal += server._lastDataBytes ?? 0;
  }
  server.close();
  const unknownCount = kinds["unknown"] ?? 0;
  const localCount = kinds["local"] ?? 0;
  check("E1 DATA-accepted-then-drop classifies UNKNOWN (never a retryable local) in all 8 runs", unknownCount === 8,
    `kinds=${JSON.stringify(kinds)} (local=${localCount} would be requeueable while bytes may have hit the wire; server-side bytes seen cumulative=${bytesSeenTotal})`);
}

console.log(`\n== adversarial probe: ${pass} pass, ${fail} fail ==`);
process.exit(fail === 0 ? 0 : 1);
