// Second-round independent adversarial audit probe.
// Self-written NEW counterexamples and blind-spot probes (never just replaying D-98).
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const REPO = "D:/AegisPi/aegis-pi";
const NODE = "D:/AegisPi/tools/node-v22.23.5/node.exe";
const ws = join(REPO, ".audit/second-audit/probes/ws-sec");
try { rmSync(ws, { recursive: true, force: true }); } catch {}
mkdirSync(join(ws, "db"), { recursive: true });
process.chdir(REPO);

const imp = (rel) => import(`file:///D:/AegisPi/aegis-pi/${rel}`);
const { openDatabase } = await imp("apps/daemon/src/db/connect.mjs");
const { migrate, loadCanonicalSchema, ensureModelRequestsTable } = await imp("apps/daemon/src/db/migrate.mjs");
const { ensurePrincipal, ensureScope } = await imp("apps/daemon/src/ingress.mjs");
const { grantPermission } = await imp("apps/daemon/src/acl.mjs");
const { insertObjectRow } = await imp("apps/daemon/src/objects.mjs");
const { proposeMailReplyEffect, buildMailSendIntent } = await imp("apps/daemon/src/mail-triage.mjs");
const { proposeEffect, dispatchEffect } = await imp("apps/daemon/src/effects.mjs");
const { runDreamingLoop } = await imp("apps/daemon/src/dreaming.mjs");
const { proposeMemoryFact } = await imp("apps/daemon/src/memory.mjs");
const { parseIcsEvents } = await imp("apps/daemon/src/calendar-ics.mjs");

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

function freshDb(tag) {
  mkdirSync(join(ws, tag, "db"), { recursive: true });
  const db = openDatabase(join(ws, tag, "db", "t.sqlite"));
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
  const origin = insertObjectRow(db, {
    scopeId, kind: "event_payload", sourceUri: "probe://origin", sourceActor: OWNER,
    content: `origin-${tag}`, observedAt: NOW, requiredScopeIds: [scopeId],
  });
  const inbId = `inb:${tag}`;
  db.prepare(`INSERT INTO inbox(id, source, source_event_id, principal_id, scope_id, payload_object_id, thread_key, priority, policy_version, verdict, state, received_at)
    VALUES (?, 'probe', ?, ?, ?, ?, ?, 5, ?, 'ADMIT', 'DONE', ?)`).run(inbId, `p-${tag}`, OWNER, scopeId, origin.id, `t:${tag}`, epoch.policy_version, NOW);
  const taskId = `task:${tag}`;
  db.prepare(`INSERT INTO tasks(id, scope_id, principal_id, origin_event_id, dispatch_key, policy_version, scope_epoch, state, priority,
      available_at, deadline_at, attempt_no, fence, max_steps, skill_set_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'RUNNING', 5, ?, ?, 1, 1, 25, 'probe', ?, ?)`)
    .run(taskId, scopeId, OWNER, inbId, `dk:${tag}`, epoch.policy_version, NOW, NOW + 3600_000, NOW, NOW);
  const attemptId = `att:${tag}`;
  db.prepare(`INSERT INTO attempts(id, task_id, attempt_no, fence, state, started_at) VALUES (?, ?, 1, 1, 'ACTIVE', ?)`).run(attemptId, taskId, NOW);
  return { taskId, attemptId, OWNER };
}

console.log("== 1. NEW CP4 Counterexamples ==");
{
  const db = freshDb("cp4-new");
  ensurePrincipal(db, { platform: "local", subject: "owner" });
  const OWNER = "prn:local:owner";
  const scopeA = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:mail:a@example.test", channel: "mail", conversationId: "a@example.test", policyVersion: "pv1" });
  const scopeB = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:999", channel: "telegram", conversationId: "999", policyVersion: "pv1" });

  // 2-hop transitive parent chain: privB -> midA (labeled scopeA, but derived from privB) -> mail.send
  const privB = insertObjectRow(db, {
    scopeId: scopeB.id, kind: "memory_fact", sourceUri: "probe://privB", sourceActor: "probe",
    content: "secret-in-B", observedAt: NOW, requiredScopeIds: [scopeB.id],
  });
  const midA = insertObjectRow(db, {
    scopeId: scopeA.id, kind: "summary", sourceUri: "probe://midA", sourceActor: "probe",
    content: "summary-in-A-from-B", observedAt: NOW, requiredScopeIds: [scopeA.id],
    parents: [{ parentId: privB.id, relation: "derived_from" }],
  });
  const { taskId, attemptId } = setupTask(db, scopeA.id, "cp4-2hop");
  const mailConfig = { allowedRecipients: ["dest@example.com"], approvalTtlMs: 3600_000, maxAttachmentBytes: 4194304 };
  const adaptersConfig = { fixedSendingIdentity: "aegispi@local" };

  let threw2Hop = false;
  try {
    proposeMailReplyEffect(db, ws, {
      now: NOW, taskId, attemptId, account: "a@example.test",
      intent: buildMailSendIntent({ to: ["dest@example.com"], subject: "s", bodyText: "b", sendingIdentity: "aegispi@local", threadKey: "m:1" }),
      mailConfig, adaptersConfig, parentObjectIds: [midA.id], evidenceManifestHash: null,
    });
  } catch { threw2Hop = true; }
  check("CP4-NEW-1 2-hop transitive parent chain (scopeA->scopeB) blocked on mail.send proposal",
    threw2Hop && db.prepare("SELECT count(*) c FROM effects").get().c === 0,
    `threw=${threw2Hop}`);

  // CP4-NEW-2: calendar.write cross-scope parent chain at proposal & dispatch
  const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:u1\r\nSUMMARY:s\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const icsHash = createHash("sha256").update(ics).digest("hex");
  let calThrew = false;
  try {
    proposeEffect(db, {
      taskId, attemptId, operation: "calendar.write",
      intent: {
        principalId: OWNER, scopeId: scopeA.id, domainKey: "dm:mail:a@example.test",
        targetResource: "caldav:/cal/u1.ics", contentHash: icsHash, expectedHead: "etag-1",
        extra: { href: "/cal/u1.ics", method: "PUT", ics },
      },
      payloadContent: ics, payloadObjectId: midA.id,
      provider: "caldav", resource: "caldav:/cal/u1.ics",
      retryMode: "IDEMPOTENT", naturalKey: "cal-cross-1", expiresAt: NOW + 3600_000,
      approverId: OWNER, now: NOW, stateDir: ws,
    });
  } catch { calThrew = true; }
  check("CP4-NEW-2a calendar.write cross-scope parent blocked at proposal", calThrew, `threw=${calThrew}`);

  // Dispatch-level calendar.write CP4 block
  const calPayload = insertObjectRow(db, {
    scopeId: scopeA.id, kind: "effect_payload", sourceUri: "probe://cal", sourceActor: OWNER,
    content: ics, observedAt: NOW, requiredScopeIds: [scopeA.id, scopeB.id], parents: [{ parentId: privB.id }],
  });
  const calActionJson = JSON.stringify({
    schemaVersion: 1, principalId: OWNER, sendingIdentity: "aegispi@local", scopeId: scopeA.id,
    domainKey: "dm:mail:a@example.test", target_resource: "caldav:/cal/u1.ics", operation: "calendar.write",
    content_hash: icsHash, attachment_hash: null, expected_head: "etag-1",
    attempt_id: attemptId, proposal_fence: 1, scope_epoch: 1, authorization_revision: 0,
    policy_version: "pv1", expires_at: NOW + 3600_000, evidence_manifest_hash: null,
    extra: { href: "/cal/u1.ics", method: "PUT", ics },
  });
  db.prepare(`INSERT INTO effects(id, task_id, attempt_id, proposal_fence, scope_id, principal_id, scope_epoch, authorization_revision,
      policy_version, action_json, action_hash, payload_object_id, provider, resource, operation, expires_at, retry_mode,
      business_key, state, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
    VALUES ('efx:cal-cp4', ?, ?, 1, ?, ?, 1, 0, 'pv1', ?, ?, ?, 'caldav', 'caldav:/cal/u1.ics', 'calendar.write', ?, 'IDEMPOTENCY_KEY', 'bk:cal-cp4', 'READY', 0, 3, 0, ?, ?)`)
    .run(taskId, attemptId, scopeA.id, OWNER, calActionJson, createHash("sha256").update(calActionJson).digest("hex"), calPayload.id, NOW + 3600_000, NOW, NOW);
  let calDispCalls = 0;
  let calDispBlocked = false;
  try {
    dispatchEffect(db, { submit() { calDispCalls++; return { status: "succeeded", externalId: "x" }; } }, { effectId: "efx:cal-cp4", now: NOW });
  } catch { calDispBlocked = true; }
  const calEfx = db.prepare("SELECT state FROM effects WHERE id='efx:cal-cp4'").get();
  check("CP4-NEW-2b calendar.write cross-scope closure blocked at dispatch -> DEAD, 0 submits",
    calDispBlocked && calEfx.state === "DEAD" && calDispCalls === 0,
    `blocked=${calDispBlocked} state=${calEfx.state} calls=${calDispCalls}`);
}

console.log("\n== 2. Blind-Spot: upstream-calendar-child CDATA parsing ==");
{
  const icsBody = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:cdata-1\r\nDTSTART:20261123T090000Z\r\nSUMMARY:CDATA Event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/cal/cdata-1.ics</D:href>
    <D:propstat><D:prop><D:getetag>"e1"</D:getetag><C:calendar-data><![CDATA[${icsBody}]]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`;
  const srv = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(207, { "content-type": "application/xml", "connection": "close" });
      res.end(xml);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const childOut = await new Promise((resolve) => {
    const ch = spawn(NODE, [join(REPO, "apps/daemon/src/upstream-calendar-child.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    ch.stdout.on("data", (d) => { out += d; });
    ch.on("close", () => resolve(out));
    ch.stdin.end(JSON.stringify({ mode: "calendar.read", url: `http://127.0.0.1:${port}/cal/`, username: "caluser", password: "calpassword", timeoutMs: 5000 }));
  });
  srv.close();
  const parsed = JSON.parse(childOut || "{}");
  const events = parsed.ok && parsed.entries?.[0] ? parseIcsEvents(parsed.entries[0].ics) : [];
  check("BLIND-1 CalDAV CDATA calendar-data parses VEVENTs", events.length === 1,
    `parsed=${JSON.stringify(parsed).slice(0, 140)} events=${events.length}`);
}

console.log("\n== 3. Blind-Spot: dreaming.mjs expired suggestion re-proposal ==");
{
  const db = freshDb("dream-dupe");
  ensurePrincipal(db, { platform: "local", subject: "owner" });
  const OWNER = "prn:local:owner";
  const scopeA = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:555", channel: "telegram", conversationId: "555", policyVersion: "pv1" });
  const srcObj = insertObjectRow(db, {
    scopeId: scopeA.id, kind: "event_payload", sourceUri: "probe://d", sourceActor: OWNER,
    content: "src", observedAt: NOW, requiredScopeIds: [scopeA.id],
  });
  proposeMemoryFact(db, ws, {
    scopeId: scopeA.id, factKey: "food:lunch", factText: "likes ramen", sourceUri: "probe://1",
    sourceActor: OWNER, parentObjectIds: [srcObj.id], observedAt: NOW, now: NOW,
  });
  proposeMemoryFact(db, ws, {
    scopeId: scopeA.id, factKey: "food:dinner", factText: "likes udon", sourceUri: "probe://2",
    sourceActor: OWNER, parentObjectIds: [srcObj.id], observedAt: NOW + 1, now: NOW + 1,
  });
  const quiet = { start: "23:00", end: "07:00", timezone: "Asia/Hong_Kong" };
  // 2026-11-22T23:30:00+08:00
  const quietNow = Date.parse("2026-11-22T23:30:00+08:00");
  const r1 = runDreamingLoop(db, ws, { now: quietNow, quietHours: quiet, ledger: null });
  // Simulate suggestion being expired/rejected
  db.prepare("UPDATE objects SET status='expired' WHERE kind='dreaming_suggestion'").run();
  const r2 = runDreamingLoop(db, ws, { now: quietNow + 60_000, quietHours: quiet, ledger: null });
  const audits = db.prepare("SELECT count(*) c FROM audit_log WHERE code='memory_dreaming_merge_proposed'").get().c;
  check("BLIND-2 dreaming does not emit phantom merge_proposed audit when suggestion already expired",
    r2.mergeSuggestions.length === 0 && audits === 1,
    `r1=${r1.mergeSuggestions.length} r2=${r2.mergeSuggestions.length} audits=${audits}`);
}

console.log("\n== 4. Blind-Spot: ui.mjs static injection & column check ==");
{
  const uiSrc = readFileSync(join(REPO, "apps/daemon/src/console/ui.mjs"), "utf8");
  const uiNoComments = uiSrc.replace(/\/\/.*$/gm, "");
  const dangerous = /\b(innerHTML|outerHTML|document\.write|eval\s*\(|new\s+Function|insertAdjacentHTML)\b/.test(uiNoComments);
  const hasActionHashBug = uiSrc.includes('el("td", { text: a.id }),\r\n      el("td", { text: (a.scope_id || "")') ||
    (uiSrc.match(/el\("td", \{ text: a\.id \}\)/g) || []).length === 2;
  check("BLIND-3a ui.mjs zero innerHTML/eval/document.write", !dangerous, `dangerous=${dangerous}`);
  check("BLIND-3b ui.mjs renderApprovals renders a.action_hash in action_hash column (not duplicate a.id)", !hasActionHashBug,
    `duplicate_a_id_count=${(uiSrc.match(/el\("td", \{ text: a\.id \}\)/g) || []).length}`);
}

console.log(`\n== second-audit probe summary: ${pass} pass, ${fail} fail ==`);
process.exit(fail === 0 ? 0 : 1);
