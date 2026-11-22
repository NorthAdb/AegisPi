// Audit probe 2: (G) composeMorningBriefing cross-scope metadata leak;
// (H) the scenarios suite's child-entries-never-imported-by-host check —
// verify it detects a real host import and probe its blind spots.
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
process.chdir("D:/AegisPi/aegis-pi");
const REPO = "D:/AegisPi/aegis-pi";
const ws = join(REPO, ".audit/batch2-audit/probes/ws-brief");
try { rmSync(ws, { recursive: true, force: true }); } catch {}
mkdirSync(join(ws, "db"), { recursive: true });

const imp = (rel) => import(`file:///D:/AegisPi/aegis-pi/${rel}`);
const { openDatabase } = await imp("apps/daemon/src/db/connect.mjs");
const { migrate, loadCanonicalSchema, ensureModelRequestsTable } = await imp("apps/daemon/src/db/migrate.mjs");
const { ensurePrincipal, ensureScope } = await imp("apps/daemon/src/ingress.mjs");
const { grantPermission } = await imp("apps/daemon/src/acl.mjs");
const { putObjectContent } = await imp("apps/daemon/src/objects.mjs");
const { composeMorningBriefing } = await imp("apps/daemon/src/briefing-followup.mjs");

const dbPath = join(ws, "db", "t.sqlite");
const db = openDatabase(dbPath);
migrate(db, loadCanonicalSchema());
ensureModelRequestsTable(db);
const NOW = Date.now();
ensurePrincipal(db, { platform: "local", subject: "owner" });
ensurePrincipal(db, { platform: "local", subject: "someoneelse" });
const OWNER = "prn:local:owner";
const scopeA = ensureScope(db, { ownerId: OWNER, kind: "owner_dm", domainKey: "dm:telegram:800", channel: "telegram", conversationId: "800", policyVersion: "pv1" });
const scopeB = ensureScope(db, { ownerId: "prn:local:someoneelse", kind: "owner_dm", domainKey: "dm:telegram:801", channel: "telegram", conversationId: "801", policyVersion: "pv1" });

// A WAITING approval in scope B (private to someoneelse), plus an audit_alert in scope B.
const st = putObjectContent(ws, "dbg payload b");
const objMod = await imp("apps/daemon/src/objects.mjs");
const dbgPayload = objMod.insertObjectRow(db, { scopeId: scopeB.id, kind: "effect_payload", sourceUri: "probe://b", sourceActor: "prn:local:someoneelse", contentHash: st.contentHash, storageRef: st.storageRef, observedAt: NOW, requiredScopeIds: [scopeB.id] });
db.prepare(`INSERT INTO inbox(id, source, source_event_id, principal_id, scope_id, payload_object_id, thread_key, priority, policy_version, verdict, state, received_at)
  VALUES ('inb:dbg-b', 'probe', 'probe-b', 'prn:local:someoneelse', ?, ?, 'thread:b', 5, 'pv1', 'ADMIT', 'DONE', ?)`).run(scopeB.id, dbgPayload.id, NOW);
db.prepare(`INSERT INTO tasks(id, scope_id, principal_id, origin_event_id, dispatch_key, policy_version, scope_epoch, state, priority,
    available_at, deadline_at, attempt_no, fence, max_steps, skill_set_hash, created_at, updated_at)
  VALUES ('task:dbg-b', ?, 'prn:local:someoneelse', 'inb:dbg-b', 'dk:dbg-b', 'pv1', 1, 'RUNNING', 5, ?, ?, 1, 1, 25, 'probe', ?, ?)`)
  .run(scopeB.id, NOW, NOW + 3600_000, NOW, NOW);
db.prepare(`INSERT INTO attempts(id, task_id, attempt_no, fence, state, started_at) VALUES ('att:dbg-b', 'task:dbg-b', 1, 1, 'ACTIVE', ?)`).run(NOW);
db.prepare(`INSERT INTO effects(id, task_id, attempt_id, proposal_fence, scope_id, principal_id, scope_epoch, authorization_revision,
    policy_version, action_json, action_hash, payload_object_id, provider, resource, operation, expires_at, retry_mode,
    business_key, state, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
  VALUES ('efx:dbg-b', 'task:dbg-b', 'att:dbg-b', 1, ?, 'prn:local:someoneelse', 1, 0, 'pv1',
    '{"target_resource":"mail:x@example.test","operation":"mail.send"}', 'deadbeef', ?, 'smtp', 'dm:mail:x', 'mail.send',
    ?, 'AT_MOST_ONCE', 'bk:dbg-b', 'WAITING_APPROVAL', 0, 3, 0, ?, ?)`).run(scopeB.id, dbgPayload.id, NOW + 3600_000, NOW, NOW);
db.prepare(`INSERT INTO approvals(id, effect_id, action_hash, approver_id, attempt_id, proposal_fence, scope_epoch, authorization_revision,
    policy_version, expires_at, state, nonce_hash, created_at)
  VALUES ('apr:dbg-b', 'efx:dbg-b', 'deadbeef', 'prn:local:someoneelse', 'att:dbg-b', 1, 1, 0, 'pv1', ?, 'WAITING', 'noncehash', ?)`)
  .run(NOW + 3600_000, NOW);
db.prepare(`INSERT INTO stream_events(scope_id, event_type, entity_id, entity_version, payload_json, created_at)
  VALUES (?, 'audit_alert', 'alert:b-private', 1, '{"alert":"private-scope-alert"}', ?)`).run(scopeB.id, NOW);

// Briefing composed FOR SCOPE A:
const briefing = composeMorningBriefing(db, { now: NOW, scopeId: scopeA.id, window: null });
const leakedApprovals = briefing.pendingApprovals.filter((a) => a.scope_id !== scopeA.id);
const leakedAlerts = briefing.unrecoveredAlerts.filter((r) => r.payload_json.includes("private-scope-alert"));
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); };
check("G1 briefing for scope A excludes other scopes' WAITING approvals", leakedApprovals.length === 0,
  `leaked=${leakedApprovals.length} (composeMorningBriefing has no scope filter on approvals)`);
check("G2 briefing for scope A excludes other scopes' audit_alerts", leakedAlerts.length === 0,
  `leaked=${leakedAlerts.length} (unrecoveredAlerts query has no scope filter)`);

// H: the child-import guard. Replicate its logic; then test its blind spots.
// fs imported statically

const guardSrc = readFileSync(join(REPO, "evals/phase5/scenarios/run.mjs"), "utf8");
const guardBlock = guardSrc.slice(guardSrc.indexOf("child-entries-never-imported-by-host") - 800, guardSrc.indexOf("child-entries-never-imported-by-host") + 100);
console.log("--- guard source excerpt ---");
console.log(guardBlock.split("\n").slice(0, 30).join("\n"));
console.log("--- end excerpt ---");
const childFiles = ["upstream-mail-child.mjs", "upstream-calendar-child.mjs", "ingress-telegram-child.mjs", "upstream-telegram-child.mjs", "upstream-http-child.mjs"];
const hosts = ["daemon.mjs", "adapters.mjs", "mail-adapter.mjs", "calendar-adapter.mjs", "router.mjs", "model-requests.mjs", "telegram-pull.mjs", "memory.mjs", "objects.mjs", "effects.mjs", "timers.mjs", "dreaming.mjs", "briefing-followup.mjs", "mail-triage.mjs", "console/api.mjs", "console/ui.mjs", "acl.mjs", "control.mjs", "cp4.mjs", "recovery.mjs", "scheduler.mjs", "worker.mjs"];
let directHits = [];
for (const h of hosts) {
  let text = "";
  try { text = readFileSync(join(REPO, "apps/daemon/src", h), "utf8"); } catch { continue; }
  for (const c of childFiles) {
    if (text.includes(c)) directHits.push(`${h} -> ${c}`);
  }
}
check("H1 no host module references any child entry file name", directHits.length === 0, directHits.join("; ") || "clean");
// Blind-spot probe: does the guard cover spawn-by-variable / join-built paths?
// The guard likely greps source text for child file names. A host could
// construct the child name dynamically: read what the guard actually scans.
const scannedList = (guardSrc.match(/HOST_MODULES\s*=\s*\[([^\]]*)\]/s) || [])[1];
check("H2 guard file-list inspected (see excerpt above for scope)", true, (scannedList ?? "list literal not found — guard may scan a different structure").slice(0, 200).replace(/\s+/g, " "));
console.log(`\n== probe 2: ${pass} pass, ${fail} fail ==`);
process.exit(fail === 0 ? 0 : 1);
