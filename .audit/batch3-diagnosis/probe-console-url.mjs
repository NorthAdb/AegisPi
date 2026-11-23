// Diagnostic probe for the batch-3 console approval 404 (zero side effects:
// GET views only, NO decide call, local server only).
import { join } from "node:path";
import { createInterface } from "node:readline";
import { openDatabase } from "../../apps/daemon/src/db/connect.mjs";
import { createConsoleApp, ensureConsoleToken, serveConsole, CONSOLE_BIND, CONSOLE_DEFAULT_PORT } from "../../apps/daemon/src/console/api.mjs";

const stateDir = "D:/AegisPi/aegis-pi/workspace-state/phase5/scenarios-real-mail";
const db = openDatabase(join(stateDir, "db", "aegis.db"), { readOnly: true });
const approval = db.prepare("SELECT id, state, approver_id, action_hash FROM approvals WHERE state='WAITING' ORDER BY created_at DESC LIMIT 1").get();
db.close();
if (!approval) {
  console.log("no WAITING approval found in the diagnosis workspace");
  process.exit(0);
}
console.log("approval id (raw):", approval.id);
console.log("approval state:", approval.state, "approver:", approval.approver_id);
const enc = encodeURIComponent(approval.id);
console.log("approval id (encoded path segment):", enc.slice(0, 60) + "…");

const { token } = ensureConsoleToken(stateDir);
const app = createConsoleApp(db, {
  recovery: { mode: "open", actions: [], failedStep: null },
  mode: "open",
  token,
  port: CONSOLE_DEFAULT_PORT,
  stateDir,
  ownerPrincipalId: approval.approver_id,
});
// NOTE: createConsoleApp binds its own db handle; reopen writable is not
// needed for GET views, but the app needs a live db — reopen read-write is
// fine and this probe only reads.
const db2 = openDatabase(join(stateDir, "db", "aegis.db"));
const app2 = createConsoleApp(db2, {
  recovery: { mode: "open", actions: [], failedStep: null },
  mode: "open",
  token,
  port: CONSOLE_DEFAULT_PORT,
  stateDir,
  ownerPrincipalId: approval.approver_id,
});
const served = await serveConsole(app2, { port: CONSOLE_DEFAULT_PORT });
const base = `http://${CONSOLE_BIND}:${CONSOLE_DEFAULT_PORT}`;
const sessionRes = await fetch(`${base}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ token }),
});
const session = await sessionRes.json();
console.log("session mint status:", sessionRes.status, "body keys:", Object.keys(session).join(","));
console.log("session minted:", typeof session.sessionId === "string");
for (const [label, pathId] of [["raw", approval.id], ["encoded", enc]]) {
  const res = await fetch(`${base}/api/approvals/${pathId}`, { headers: { authorization: `Bearer ${session.sessionId}` } });
  const body = await res.json();
  console.log(`view [${label}]: HTTP ${res.status} code=${body.code ?? "-"} decisionMaterials=${body.decisionMaterials ? "present" : "null"}`);
}
await new Promise((r) => served.server.close(r));
db2.close();
