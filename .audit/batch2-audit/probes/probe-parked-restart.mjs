// Audit probe 3: the REAL-process 4h-park restart test the implementer only
// simulated with "a new DB connection". Full path:
//   fixture SMTP (loopback TLS) -> prep DB (task RUNNING + mail.send draft
//   proposed -> attempt PARKED, approval WAITING) -> start REAL daemon ->
//   kill -9 -> restart -> card intact, PARKED intact, nonce survives ->
//   console approve (HTTP) -> dispatcher sends EXACTLY ONE email -> stable.
import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";

process.chdir("D:/AegisPi/aegis-pi");
const REPO = "D:/AegisPi/aegis-pi";
const NODE = "D:/AegisPi/tools/node-v22.23.5/node.exe";
const ws = join(REPO, ".audit/batch2-audit/probes/ws-restart");
try { rmSync(ws, { recursive: true, force: true }); } catch {}
const dataDir = join(ws, "daemon");
mkdirSync(join(dataDir, "db"), { recursive: true });

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); };

// --- fixture ---
const portsFile = join(ws, "ports.json");
const fx = spawn(NODE, [join(REPO, "evals/phase5/scenarios/fixtures/serve-fixtures.mjs"), portsFile], { stdio: "ignore" });
let ports = null;
for (let i = 0; i < 50 && !ports; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if (existsSync(portsFile)) ports = JSON.parse(readFileSync(portsFile, "utf8"));
}
if (!ports) { console.error("fixture did not start"); process.exit(9); }
function control(op, extra = {}) {
  return new Promise((resolve) => {
    const s = net.connect(ports.controlPort, "127.0.0.1", () => {
      s.write(JSON.stringify({ id: 1, op, ...extra }) + "\n");
    });
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { s.end(); resolve(msg.result); return; }
      }
    });
  });
}

// --- config ---
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

// --- prep DB (daemon NOT running) ---
const imp = (rel) => import(`file:///D:/AegisPi/aegis-pi/${rel}`);
const { openDatabase } = await imp("apps/daemon/src/db/connect.mjs");
const { migrate, loadCanonicalSchema, ensureModelRequestsTable } = await imp("apps/daemon/src/db/migrate.mjs");
const { ensurePrincipal, ensureScope } = await imp("apps/daemon/src/ingress.mjs");
const { grantPermission } = await imp("apps/daemon/src/acl.mjs");
const { putObjectContent, insertObjectRow } = await imp("apps/daemon/src/objects.mjs");
const { proposeMailReplyEffect, buildMailSendIntent, ensureMailScope } = await imp("apps/daemon/src/mail-triage.mjs");
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
const st0 = putObjectContent(dataDir, "probe origin");
const op = insertObjectRow(db, { scopeId: scopeA.id, kind: "event_payload", sourceUri: "probe://origin", sourceActor: OWNER, contentHash: st0.contentHash, storageRef: st0.storageRef, observedAt: NOW, requiredScopeIds: [scopeA.id] });
db.prepare(`INSERT INTO inbox(id, source, source_event_id, principal_id, scope_id, payload_object_id, thread_key, priority, policy_version, verdict, state, received_at)
  VALUES ('inb:restart', 'probe', 'probe-restart', ?, ?, ?, 'thread:restart', 5, 'pv1', 'ADMIT', 'DONE', ?)`).run(OWNER, scopeA.id, op.id, NOW);
db.prepare(`INSERT INTO tasks(id, scope_id, principal_id, origin_event_id, dispatch_key, policy_version, scope_epoch, state, priority,
    available_at, deadline_at, attempt_no, fence, lease_owner, lease_expires_at, max_steps, skill_set_hash, created_at, updated_at)
  VALUES ('task:restart', ?, ?, 'inb:restart', 'dk:restart', 'pv1', 1, 'RUNNING', 5, ?, ?, 1, 3, 'worker-x', ?, 25, 'probe', ?, ?)`)
  .run(scopeA.id, OWNER, NOW, NOW + 3600_000, NOW + 45_000, NOW, NOW);
db.prepare(`INSERT INTO attempts(id, task_id, attempt_no, fence, state, started_at) VALUES ('att:restart', 'task:restart', 1, 3, 'ACTIVE', ?)`).run(NOW);
const card = proposeMailReplyEffect(db, dataDir, {
  now: NOW, taskId: "task:restart", attemptId: "att:restart", account: "owner@example.test",
  intent: buildMailSendIntent({ to: ["victim@example.test"], subject: "restart probe", bodyText: "one email only", sendingIdentity: "aegispi@local", threadKey: "mail:restart" }),
  mailConfig: { allowedRecipients: ["victim@example.test"], approvalTtlMs: 2 * 3600_000, maxAttachmentBytes: 4194304 },
  adaptersConfig: { fixedSendingIdentity: "aegispi@local" }, evidenceManifestHash: null,
});
const approvalId = card.approvalId;
const { openDatabase: reopen } = await imp("apps/daemon/src/db/connect.mjs");
const snap = () => {
  const r = reopen(dbPath);
  const t = r.prepare("SELECT state, fence, attempt_no FROM tasks WHERE id='task:restart'").get();
  const a = r.prepare("SELECT state FROM attempts WHERE id='att:restart'").get();
  const e = r.prepare("SELECT state, attempt_count FROM effects WHERE id=?").get(card.effectId);
  const ap = r.prepare("SELECT state FROM approvals WHERE id=?").get(approvalId);
  const n = r.prepare("SELECT value FROM system_state WHERE key=?").get(`console_nonce:${approvalId}`);
  r.close();
  return { task: t?.state, fence: t?.fence, attempt: a?.state, effect: e?.state, approval: ap?.state, nonceRow: n ? "present" : "gone" };
};
const before = snap();
check("P1 prep: proposal parks attempt (fence untouched) with WAITING card",
  before.task === "WAITING_APPROVAL" && before.attempt === "PARKED" && before.effect === "WAITING_APPROVAL" && before.approval === "WAITING" && before.fence === 3,
  JSON.stringify(before));
db.close();

// --- daemon process management ---
const ENV = { ...process.env, AEGISPI_AUDIT_MAIL_CRED: "audit-user:audit-password-not-a-real-secret" };
function startDaemon() {
  return spawn(NODE, [join(REPO, "apps/daemon/src/daemon.mjs"), `--data-dir=${dataDir}`, `--config=${join(ws, "daemon-config.json")}`, "--port=4312"], {
    env: ENV, stdio: ["ignore", "pipe", "pipe"],
  });
}
let daemonLog = "";
const consoleToken = () => readFileSync(join(dataDir, "console", "token"), "utf8").trim();
async function waitHealth(proc) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const res = await fetch("http://127.0.0.1:4312/api/health", { headers: { host: "127.0.0.1:4312", authorization: "Bearer " + consoleToken() } });
      if (res.ok) return true;
    } catch {}
    if (proc.exitCode !== null) return false;
  }
  return false;
}
let d1 = startDaemon();
d1.stdout.on("data", (d) => (daemonLog += d.toString()));
d1.stderr.on("data", (d) => (daemonLog += d.toString()));
const up1 = await waitHealth(d1);
check("P2 first daemon boot healthy", up1, daemonLog.slice(-200).replace(/\n/g, " | "));
const during = snap();
check("P3 card intact while daemon runs (tick does not clobber the park)", during.approval === "WAITING" && during.task === "WAITING_APPROVAL" && during.attempt === "PARKED", JSON.stringify(during));
d1.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 500));

let d2 = startDaemon();
d2.stdout.on("data", (d) => (daemonLog += d.toString()));
d2.stderr.on("data", (d) => (daemonLog += d.toString()));
const up2 = await waitHealth(d2);
const after = snap();
check("P4 REAL kill -9 + restart: park survives (approval WAITING, attempt PARKED, fence 3)", up2 && after.approval === "WAITING" && after.task === "WAITING_APPROVAL" && after.attempt === "PARKED" && after.fence === 3, JSON.stringify(after));

// --- console approve after restart ---
const token = readFileSync(join(dataDir, "console", "token"), "utf8").trim();
const H = { host: "127.0.0.1:4312", "content-type": "application/json" };
const mint = await fetch("http://127.0.0.1:4312/api/session", { method: "POST", headers: { ...H, authorization: "Bearer " + token }, body: JSON.stringify({ token }) });
const sess = await mint.json();
const enc = encodeURIComponent(approvalId);
const cardRes = await fetch(`http://127.0.0.1:4312/api/approvals/${enc}`, { headers: { host: "127.0.0.1:4312", authorization: "Bearer " + sess.sessionId } });
const cardJson = await cardRes.json();
const dm = cardJson.decisionMaterials;
check("P5 nonce delivered to designated approver live session after restart", !!dm?.nonce && dm.actionHash.length === 64, dm ? "nonce present" : JSON.stringify(cardJson).slice(0, 120));
const dec = await fetch(`http://127.0.0.1:4312/api/approvals/${enc}/decide`, {
  method: "POST",
  headers: { ...H, authorization: "Bearer " + sess.sessionId, "x-csrf-token": sess.csrfToken },
  body: JSON.stringify({ decision: "approve", actionHash: dm.actionHash, nonce: dm.nonce }),
});
const decJson = await dec.json();
check("P6 approve consumed after restart", dec.status === 200 && decJson.accepted === true, JSON.stringify(decJson).slice(0, 140));

await new Promise((r) => setTimeout(r, 12000));
const stats1 = await control("smtpStats");
const afterSend = snap();
check("P7 dispatcher sent EXACTLY ONE email to the loopback SMTP fixture", stats1.count === 1 && afterSend.effect === "SUCCEEDED", `smtpCount=${stats1.count} effect=${afterSend.effect}`);
await new Promise((r) => setTimeout(r, 11000));
const stats2 = await control("smtpStats");
check("P8 no second email on subsequent ticks", stats2.count === 1, `smtpCount=${stats2.count}`);

d2.kill("SIGKILL");
fx.kill();
console.log(`\n== restart probe: ${pass} pass, ${fail} fail ==`);
process.exit(fail === 0 ? 0 : 1);
