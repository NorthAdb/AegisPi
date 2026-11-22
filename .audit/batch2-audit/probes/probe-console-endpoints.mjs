// Audit probe: hit every console endpoint against a fresh canonical-schema DB.
// Goal: (1) confirm POST /api/routines/:id/mode 500s on the objects.content
// ghost column (console/api.mjs:854); (2) surface any other latent 500.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { migrate, loadCanonicalSchema } from "../../../apps/daemon/src/db/migrate.mjs";

const ws = ".audit/batch2-audit/probes/ws-console-probe";
mkdirSync(join(ws, "db"), { recursive: true });
const db = openDatabase(join(ws, "db", "test.sqlite"));
migrate(db, loadCanonicalSchema());
(await import("../../../apps/daemon/src/db/migrate.mjs")).ensureModelRequestsTable(db);

const { createConsoleApp, ensureConsoleToken } = await import("../../../apps/daemon/src/console/api.mjs");
const { ensureScope, ensurePrincipal } = await import("../../../apps/daemon/src/ingress.mjs");
const { grantPermission } = await import("../../../apps/daemon/src/acl.mjs");

ensurePrincipal(db, { platform: "local", subject: "owner" });
const OWNER = "prn:local:owner";
const scope = ensureScope(db, {
  ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:9001",
  channel: "telegram", conversationId: "9001", policyVersion: "pv1",
});
for (const p of ["read", "request", "approve", "admin"]) {
  grantPermission(db, { scopeId: scope.id, principalId: OWNER, permission: p, now: Date.now() });
}
const token = ensureConsoleToken(ws).token;
const app = createConsoleApp(db, {
  recovery: { failedStep: null, actions: [] }, mode: "open", token,
  port: 4310, stateDir: ws, ownerPrincipalId: OWNER,
});
const H = { host: "127.0.0.1:4310" };
const get = (p, h = {}) => app.fetch(new Request("http://127.0.0.1:4310" + p, { headers: { ...H, ...h } }));
const mint = await app.fetch(new Request("http://127.0.0.1:4310/api/session", {
  method: "POST", headers: { ...H, "content-type": "application/json", authorization: "Bearer " + token },
  body: JSON.stringify({ token }),
}));
const session = await mint.json();
const AUTH = { authorization: "Bearer " + session.sessionId, "x-csrf-token": session.csrfToken };
const post = (p, b) => app.fetch(new Request("http://127.0.0.1:4310" + p, {
  method: "POST", headers: { ...H, "content-type": "application/json", ...AUTH }, body: JSON.stringify(b),
}));

// a real routine object row (raw INSERT; objects has no content column)
const now = Date.now();
db.prepare(`INSERT INTO objects(id, scope_id, kind, source_uri, source_actor, content_hash, storage_ref, status, version, observed_at, metadata_json)
  VALUES ('obj:probe-routine-1', ?, 'routine', 'probe://routine', 'probe', 'deadbeef', NULL, 'active', 1, ?, '{"routineId":"rt1","mode":"observe","policyVersion":"pv1"}')`).run(scope.id, now);

const reads = [
  ["/api/health"], ["/api/recovery"], ["/api/snapshot"], ["/api/tasks"], ["/api/tasks/nope"],
  ["/api/tasks/nope/checkpoints"], ["/api/notifications"], ["/api/budget"], ["/api/scopes"],
  [`/api/scopes/${scope.id}/grants`], ["/api/memory"], ["/api/routines"], ["/api/effects-unknown"],
  ["/api/approvals"], ["/api/approvals/apr:none"],
];
for (const [p] of reads) {
  const r = await get(p, { authorization: "Bearer " + token });
  const body = r.status >= 500 ? " <== " + (await r.text()).slice(0, 160) : "";
  console.log(`GET  ${p} -> ${r.status}${body}`);
}

const r1 = await post("/api/routines/obj:probe-routine-1/mode", { mode: "auto", reviewReportRef: "review-1", policyVersion: "pv1", expectedRevision: 1 });
const t1 = await r1.text();
console.log(`POST /api/routines/:id/mode -> ${r1.status} ${t1.slice(0, 220)}`);

const r2 = await post(`/api/tasks/task:none/steer`, { message: "hello", expectedRevision: 1 });
console.log(`POST /api/tasks/:id/steer (missing) -> ${r2.status}`);

const r3 = await get(`/api/tasks/task:none/trace`, { authorization: "Bearer " + token });
console.log(`GET  /api/tasks/:id/trace (missing) -> ${r3.status}`);

const r4 = await get(`/api/objects/obj:probe-routine-1`, { authorization: "Bearer " + token });
console.log(`GET  /api/objects/:id (no disk content) -> ${r4.status}`);
