// Audit E2E seed: fixtures + seeded daemon (approval card, UNKNOWN effect,
// XSS memory candidate) — leaves daemon+fixture RUNNING and writes e2e-state.json
// with everything the browser phase needs. Run probe-e2e-finalize.mjs after.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

process.chdir("D:/AegisPi/aegis-pi");
const REPO = "D:/AegisPi/aegis-pi";
const NODE = "D:/AegisPi/tools/node-v22.23.5/node.exe";
const ws = join(REPO, ".audit/batch2-audit/probes/ws-e2e");
try { rmSync(ws, { recursive: true, force: true }); } catch {}
const dataDir = join(ws, "daemon");
mkdirSync(join(dataDir, "db"), { recursive: true });

const portsFile = join(ws, "ports.json");
const fx = spawn(NODE, [join(REPO, "evals/phase5/scenarios/fixtures/serve-fixtures.mjs"), portsFile], { stdio: "ignore" });
let ports = null;
for (let i = 0; i < 50 && !ports; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if (existsSync(portsFile)) ports = JSON.parse(readFileSync(portsFile, "utf8"));
}
if (!ports) { console.error("fixture failed"); process.exit(9); }

const imp = (rel) => import(`file:///D:/AegisPi/aegis-pi/${rel}`);
const defaults = JSON.parse(readFileSync(join(REPO, "apps/daemon/config/defaults.json"), "utf8"));
defaults.mail = {
  imapHost: null, imapPort: 993, imapTls: true,
  smtpHost: "127.0.0.1", smtpPort: ports.smtpPort, smtpTls: true,
  allowRealMailRead: false, allowRealMailSend: true,
  allowedFolders: ["INBOX"], allowedSenders: [], allowedRecipients: ["victim@example.test"],
  approvalTtlMs: 2 * 3600_000, maxAttachmentBytes: 4194304,
};
defaults.policy.allowRealExternalWrites = true;
defaults.credentials = { mail: "AEGISPI_AUDIT_MAIL_CRED", repo: null, im: null, calendar: null };
defaults.adapters.allowedRecipients = ["victim@example.test"];
writeFileSync(join(ws, "daemon-config.json"), JSON.stringify(defaults, null, 2));

const { openDatabase } = await imp("apps/daemon/src/db/connect.mjs");
const { migrate, loadCanonicalSchema, ensureModelRequestsTable } = await imp("apps/daemon/src/db/migrate.mjs");
const { ensurePrincipal, ensureScope } = await imp("apps/daemon/src/ingress.mjs");
const { grantPermission } = await imp("apps/daemon/src/acl.mjs");
const { putObjectContent, insertObjectRow } = await imp("apps/daemon/src/objects.mjs");
const { proposeMailReplyEffect, buildMailSendIntent } = await imp("apps/daemon/src/mail-triage.mjs");
const { proposeMemoryFact } = await imp("apps/daemon/src/memory.mjs");
const { createCredentialService } = await imp("apps/daemon/src/credentials.mjs");

const dbPath = join(dataDir, "db", "aegis.db");
const db = openDatabase(dbPath);
migrate(db, loadCanonicalSchema());
ensureModelRequestsTable(db);
const NOW = Date.now();
ensurePrincipal(db, { platform: "local", subject: "owner" });
const OWNER = "prn:local:owner";
const scopeA = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:mail:owner@example.test", channel: "mail", conversationId: "owner@example.test", policyVersion: "pv1" });
for (const p of ["read", "request", "approve", "admin"]) grantPermission(db, { scopeId: scopeA.id, principalId: OWNER, permission: p, now: NOW });
createCredentialService(db).registerSlot({ slot: "mail", envName: "AEGISPI_AUDIT_MAIL_CRED", purpose: "mail", now: NOW });

const st0 = putObjectContent(dataDir, "e2e origin");
const op = insertObjectRow(db, { scopeId: scopeA.id, kind: "event_payload", sourceUri: "probe://origin", sourceActor: OWNER, contentHash: st0.contentHash, storageRef: st0.storageRef, observedAt: NOW, requiredScopeIds: [scopeA.id] });
db.prepare(`INSERT INTO inbox(id, source, source_event_id, principal_id, scope_id, payload_object_id, thread_key, priority, policy_version, verdict, state, received_at)
  VALUES ('inb:e2e', 'probe', 'probe-e2e', ?, ?, ?, 'thread:e2e', 5, 'pv1', 'ADMIT', 'DONE', ?)`).run(OWNER, scopeA.id, op.id, NOW);
db.prepare(`INSERT INTO tasks(id, scope_id, principal_id, origin_event_id, dispatch_key, policy_version, scope_epoch, state, priority,
    available_at, deadline_at, attempt_no, fence, max_steps, skill_set_hash, created_at, updated_at)
  VALUES ('task:e2e', ?, ?, 'inb:e2e', 'dk:e2e', 'pv1', 1, 'RUNNING', 5, ?, ?, 1, 3, 25, 'probe', ?, ?)`)
  .run(scopeA.id, OWNER, NOW, NOW + 3600_000, NOW, NOW);
db.prepare(`INSERT INTO attempts(id, task_id, attempt_no, fence, state, started_at) VALUES ('att:e2e', 'task:e2e', 1, 3, 'ACTIVE', ?)`).run(NOW);
const card = proposeMailReplyEffect(db, dataDir, {
  now: NOW, taskId: "task:e2e", attemptId: "att:e2e", account: "owner@example.test",
  intent: buildMailSendIntent({ to: ["victim@example.test"], subject: "browser e2e draft", bodyText: "approved via browser", sendingIdentity: "aegispi@local", threadKey: "mail:e2e" }),
  mailConfig: { allowedRecipients: ["victim@example.test"], approvalTtlMs: 2 * 3600_000, maxAttachmentBytes: 4194304 },
  adaptersConfig: { fixedSendingIdentity: "aegispi@local" }, evidenceManifestHash: null,
});

// UNKNOWN mail.send effect on its own task (for the reconcile tab).
const stU = putObjectContent(dataDir, "unknown payload");
const opU = insertObjectRow(db, { scopeId: scopeA.id, kind: "event_payload", sourceUri: "probe://u", sourceActor: OWNER, contentHash: stU.contentHash, storageRef: stU.storageRef, observedAt: NOW, requiredScopeIds: [scopeA.id] });
db.prepare(`INSERT INTO inbox(id, source, source_event_id, principal_id, scope_id, payload_object_id, thread_key, priority, policy_version, verdict, state, received_at)
  VALUES ('inb:e2e-u', 'probe', 'probe-e2e-u', ?, ?, ?, 'thread:e2e-u', 5, 'pv1', 'ADMIT', 'DONE', ?)`).run(OWNER, scopeA.id, opU.id, NOW);
db.prepare(`INSERT INTO tasks(id, scope_id, principal_id, origin_event_id, dispatch_key, policy_version, scope_epoch, state, priority,
    available_at, deadline_at, attempt_no, fence, max_steps, skill_set_hash, created_at, updated_at)
  VALUES ('task:e2e-u', ?, ?, 'inb:e2e-u', 'dk:e2e-u', 'pv1', 1, 'SUCCEEDED', 5, ?, ?, 1, 4, 25, 'probe', ?, ?)`)
  .run(scopeA.id, OWNER, NOW, NOW + 3600_000, NOW, NOW);
db.prepare(`INSERT INTO attempts(id, task_id, attempt_no, fence, state, started_at, ended_at) VALUES ('att:e2e-u', 'task:e2e-u', 1, 4, 'SUCCEEDED', ?, ?)`).run(NOW, NOW);
const stU2 = putObjectContent(dataDir, "unknown effect payload");
const opU2 = insertObjectRow(db, { scopeId: scopeA.id, kind: "effect_payload", sourceUri: "probe://u2", sourceActor: OWNER, contentHash: stU2.contentHash, storageRef: stU2.storageRef, observedAt: NOW, requiredScopeIds: [scopeA.id] });
const unknownAction = JSON.stringify({
  schemaVersion: 1, principalId: OWNER, sendingIdentity: "aegispi@local", scopeId: scopeA.id,
  domainKey: "dm:mail:owner@example.test", target_resource: "mail:victim@example.test", operation: "mail.send",
  content_hash: createHash("sha256").update("unknown payload").digest("hex"), attachment_hash: null,
  expected_head: null, attempt_id: "att:e2e-u", proposal_fence: 4, scope_epoch: 1,
  authorization_revision: 0, policy_version: "pv1", expires_at: NOW + 3600_000,
  evidence_manifest_hash: null, extra: { recipients: ["victim@example.test"], bodyText: "unknown probe" },
});
db.prepare(`INSERT INTO effects(id, task_id, attempt_id, proposal_fence, scope_id, principal_id, scope_epoch, authorization_revision,
    policy_version, action_json, action_hash, payload_object_id, provider, resource, operation, expires_at, retry_mode,
    business_key, state, attempt_count, max_attempts, next_attempt_at, created_at, updated_at, last_error)
  VALUES ('efx:e2e-unknown', 'task:e2e-u', 'att:e2e-u', 4, ?, ?, 1, 0, 'pv1', ?, ?, ?, 'smtp', 'dm:mail:owner@example.test', 'mail.send',
    ?, 'AT_MOST_ONCE', 'bk:e2e-unknown', 'UNKNOWN', 1, 3, 0, ?, ?, 'smtp data-accepted: connection closed mid-response')`)
  .run(scopeA.id, OWNER, unknownAction, createHash("sha256").update(Buffer.from(unknownAction, "utf8")).digest("hex"), opU2.id, NOW + 3600_000, NOW, NOW);

// XSS memory candidate (quarantined by the 13-class scanner, rendered in tab 3).
const xss = proposeMemoryFact(db, dataDir, {
  scopeId: scopeA.id, factKey: "note.xss.e2e", factText: "<script>alert(1)</script> hidden html e2e", category: "note",
  now: NOW, confidence: 0.9, expiresAt: null, sourceUri: "probe://xss", sourceActor: "contact:x",
});
db.close();

// daemon up
const ENV = { ...process.env, AEGISPI_AUDIT_MAIL_CRED: "audit-user:audit-password-not-a-real-secret" };
const daemon = spawn(NODE, [join(REPO, "apps/daemon/src/daemon.mjs"), `--data-dir=${dataDir}`, `--config=${join(ws, "daemon-config.json")}`, "--port=4310"], { env: ENV, stdio: "ignore", detached: true });
let healthy = false;
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 150));
  try {
    const res = await fetch("http://127.0.0.1:4310/api/health", { headers: { host: "127.0.0.1:4310" } });
    healthy = res.status === 401 || res.ok; // 401 proves the console is up and enforcing auth
    if (res.ok) break;
  } catch {}
}
if (!healthy) { console.error("daemon failed to start"); process.exit(9); }
const token = readFileSync(join(dataDir, "console", "token"), "utf8").trim();
writeFileSync(join(ws, "e2e-state.json"), JSON.stringify({
  approvalId: card.approvalId, effectId: card.effectId, unknownEffectId: "efx:e2e-unknown",
  xssObjectId: xss.objectId, token, dataDir, smtpControlPort: ports.controlPort,
}, null, 2));
console.log("E2E ENV READY");
console.log(JSON.stringify({ approvalId: card.approvalId, effectId: card.effectId, unknownEffectId: "efx:e2e-unknown", xssObjectId: xss.objectId }));
// keep alive with a marker file the finalize script deletes to shut down
writeFileSync(join(ws, "keep-alive"), "");
setInterval(() => {
  if (!existsSync(join(ws, "keep-alive"))) { try { process.kill(-daemon.pid); } catch {} try { fx.kill(); } catch {} process.exit(0); }
}, 1000);
