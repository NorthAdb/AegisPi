// Debug: inspect the raw decisionMaterials responses in the F-section setup.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
process.chdir("D:/AegisPi/aegis-pi");
const ws = "D:/AegisPi/aegis-pi/.audit/batch2-audit/probes/ws-nonce-debug";
try { rmSync(ws, { recursive: true, force: true }); } catch {}
mkdirSync(join(ws, "db"), { recursive: true });

const imp = (rel) => import(`file:///D:/AegisPi/aegis-pi/${rel}`);
const { openDatabase } = await imp("apps/daemon/src/db/connect.mjs");
const { migrate, loadCanonicalSchema, ensureModelRequestsTable } = await imp("apps/daemon/src/db/migrate.mjs");
const { ensurePrincipal, ensureScope } = await imp("apps/daemon/src/ingress.mjs");
const { grantPermission } = await imp("apps/daemon/src/acl.mjs");
const { insertObjectRow, putObjectContent } = await imp("apps/daemon/src/objects.mjs");
const { proposeMailReplyEffect, buildMailSendIntent, ensureMailScope } = await imp("apps/daemon/src/mail-triage.mjs");
const { readConsoleNonce } = await imp("apps/daemon/src/approvals.mjs");
const { createConsoleApp, ensureConsoleToken } = await imp("apps/daemon/src/console/api.mjs");

const dbPath = join(ws, "db", "t.sqlite");
const db = openDatabase(dbPath);
migrate(db, loadCanonicalSchema());
ensureModelRequestsTable(db);
const NOW = Date.now();
ensurePrincipal(db, { platform: "local", subject: "owner" });
const OWNER = "prn:local:owner";
const scopeA = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:mail:owner@example.test", channel: "mail", conversationId: "owner@example.test", policyVersion: "pv1" });
for (const p of ["read", "request", "approve", "admin"]) grantPermission(db, { scopeId: scopeA.id, principalId: OWNER, permission: p, now: NOW });
const originPayload = putObjectContent(ws, "probe origin"); 
const obj = await imp("apps/daemon/src/objects.mjs");
const row = obj.insertObjectRow(db, { scopeId: scopeA.id, kind: "event_payload", sourceUri: "probe://origin", sourceActor: OWNER, contentHash: originPayload.contentHash, storageRef: originPayload.storageRef, observedAt: NOW, requiredScopeIds: [scopeA.id] });
db.prepare(`INSERT INTO inbox(id, source, source_event_id, principal_id, scope_id, payload_object_id, thread_key, priority, policy_version, verdict, state, received_at)
  VALUES ('inb:dbg', 'probe', 'probe-dbg', ?, ?, ?, 'thread:dbg', 5, 'pv1', 'ADMIT', 'DONE', ?)`).run(OWNER, scopeA.id, row.id, NOW);
db.prepare(`INSERT INTO tasks(id, scope_id, principal_id, origin_event_id, dispatch_key, policy_version, scope_epoch, state, priority,
    available_at, deadline_at, attempt_no, fence, max_steps, skill_set_hash, created_at, updated_at)
  VALUES ('task:dbg', ?, ?, 'inb:dbg', 'dk:dbg', 'pv1', 1, 'RUNNING', 5, ?, ?, 1, 1, 25, 'probe', ?, ?)`)
  .run(scopeA.id, OWNER, NOW, NOW + 3600_000, NOW, NOW);
db.prepare(`INSERT INTO attempts(id, task_id, attempt_no, fence, state, started_at) VALUES ('att:dbg', 'task:dbg', 1, 1, 'ACTIVE', ?)`).run(NOW);

const card = proposeMailReplyEffect(db, ws, {
  now: NOW, taskId: "task:dbg", attemptId: "att:dbg", account: "owner@example.test",
  intent: buildMailSendIntent({ to: ["dest@example.test"], subject: "n", bodyText: "nonce debug", sendingIdentity: "aegispi@local", threadKey: "mail:t5" }),
  mailConfig: { allowedRecipients: ["dest@example.test"], approvalTtlMs: 3600_000 }, adaptersConfig: { fixedSendingIdentity: "aegispi@local" }, evidenceManifestHash: null,
});
console.log("card keys:", Object.keys(card));
const approvalId = card.approvalId ?? `apr:${card.effectId}`;
const nonce = readConsoleNonce(db, approvalId);
console.log("approvalId:", approvalId, "nonce:", nonce);
const approverRow = db.prepare("SELECT approver_id, state FROM approvals WHERE id=?").get(approvalId);
console.log("approver row:", approverRow);

const token = ensureConsoleToken(ws).token;
const app = createConsoleApp(db, { recovery: { failedStep: null, actions: [] }, mode: "open", token, port: 4310, stateDir: ws, ownerPrincipalId: OWNER });
const H = { host: "127.0.0.1:4310" };
const boot = await app.fetch(new Request("http://127.0.0.1:4310/api/approvals/" + approvalId, { headers: { ...H, authorization: "Bearer " + token } }));
const bootJson = await boot.json();
console.log("BOOT FULL:", JSON.stringify(bootJson).slice(0,400));
const mint = await app.fetch(new Request("http://127.0.0.1:4310/api/session", { method: "POST", headers: { ...H, "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ token }) }));
const sess = await mint.json();
console.log("session principal:", sess.principalId);
const own = await app.fetch(new Request("http://127.0.0.1:4310/api/approvals/" + approvalId, { headers: { ...H, authorization: "Bearer " + sess.sessionId } }));
const ownJson = await own.json();
console.log("SESSION FULL:", JSON.stringify(ownJson).slice(0,400));
