// Probe: a dispatch whose target head drifted from the action's pinned head
// must be refused BEFORE any request byte. Exit 0 when the gate holds, 1
// when the stale action goes through.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadCanonicalSchema, migrate } from "../../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../../apps/daemon/src/scheduler.mjs";
import { proposeEffect, dispatchEffect } from "../../../../apps/daemon/src/effects.mjs";
import { decideApproval } from "../../../../apps/daemon/src/approvals.mjs";
import { grantPermission } from "../../../../apps/daemon/src/acl.mjs";
import { createFakeRemote } from "../../../../apps/daemon/src/testing/fake-remote.mjs";
import { createAdapterUpstream, headPrecondition } from "../../../../apps/daemon/src/adapters.mjs";

const stateDir = join("D:/AegisPi/aegis-pi/workspace-state/phase3/probe-head");
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(join(stateDir, "db"), { recursive: true });
const db = openDatabase(join(stateDir, "db", "aegis.db"));
migrate(db, loadCanonicalSchema());
const now = Date.now();
const OWNER = "prn:telegram:6101";
db.prepare("INSERT INTO principals(id, platform, platform_subject) VALUES (?,?,?)").run(OWNER, "telegram", "6101");
db.prepare(
  "INSERT INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
).run("scp:dm%3Atelegram%3A6101", OWNER, "owner_dm", "dm:telegram:6101", "telegram", "6101", null, 1, 1, "pv1", 0);
grantPermission(db, { scopeId: "scp:dm%3Atelegram%3A6101", principalId: OWNER, permission: "approve", now });
const ing = receiveEvent(db, stateDir, {
  now, source: "telegram", sourceEventId: "evt-probe-head",
  principal: { platform: "telegram", subject: "6101" },
  scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
  threadKey: "t1", priority: 5, policyVersion: "pv1", payload: "probe", verdict: "ADMIT",
});
const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
dispatchEventToTask(db, { inboxId: inbox.id, dispatchKey: dispatchKeyForInbox(inbox), now, priority: 5, maxSteps: 25, deadlineAt: now + 900000, skillSetHash: "ss" });
const claim = claimNextTask(db, { now, leaseMs: 45000 });
const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(claim.taskId);
const fake = createFakeRemote(stateDir, { label: "probe-fake" });
fake.setHead("repo://github.com/x/y", "head1");
const adapter = createAdapterUpstream(db, { baseUpstream: fake, transportKind: "fake", policy: {}, config: {} });
const card = proposeEffect(db, stateDir, {
  now, taskId: task.id,
  attemptId: db.prepare("SELECT id FROM attempts WHERE task_id=? AND attempt_no=?").get(task.id, task.attempt_no).id,
  effectType: "notify", domainKey: "dm:telegram:6101", naturalKey: "probe-head",
  operationIntent: { targetResource: "repo://github.com/x/y", operation: "pr.create_draft", contentHash: "d".repeat(64), expectedHead: "head1", evidenceManifestHash: "b".repeat(64), extra: { branch: "aegis-fix/test" } },
  retryMode: "AT_MOST_ONCE", provider: "github", resource: "repo://github.com/x/y",
  requiresApproval: true, approverPrincipalId: OWNER, expiresAt: now + 3600000,
});
decideApproval(db, { approvalId: card.approvalId, decision: "approve", actionHash: card.actionHash, nonce: card.approvalNonce, approverId: OWNER, now: Date.now() });
fake.setHead("repo://github.com/x/y", "head2"); // the drift
let refused = null;
try {
  const row = db.prepare("SELECT * FROM effects WHERE id=?").get(card.effectId);
  dispatchEffect(db, adapter, { effectId: card.effectId, now: Date.now(), precondition: headPrecondition(adapter, row) });
} catch (e) {
  refused = e;
}
const effect = db.prepare("SELECT state FROM effects WHERE id=?").get(card.effectId);
const delivered = fake.appliedCount(card.businessKey);
const ok = refused !== null && /head_changed/.test(refused.message) && effect.state === "READY" && delivered === 0;
console.log(`probe-head: refused=${refused ? refused.message.slice(0, 50) : "NONE"} effect=${effect.state} delivered=${delivered} -> ${ok ? "gate holds" : "GATE BROKEN"}`);
process.exit(ok ? 0 : 1);
