// Probe: after reviseEffect, the OLD approval is INVALIDATED and the old
// effect CANCELLED. Exit 0 when the gate holds, 1 when it does not.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadCanonicalSchema, migrate } from "../../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../../apps/daemon/src/scheduler.mjs";
import { proposeEffect, reviseEffect } from "../../../../apps/daemon/src/effects.mjs";
import { grantPermission } from "../../../../apps/daemon/src/acl.mjs";

const stateDir = join("D:/AegisPi/aegis-pi/workspace-state/phase3/probe-revise");
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
  now, source: "telegram", sourceEventId: "evt-probe-revise",
  principal: { platform: "telegram", subject: "6101" },
  scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
  threadKey: "t1", priority: 5, policyVersion: "pv1", payload: "probe", verdict: "ADMIT",
});
const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
dispatchEventToTask(db, { inboxId: inbox.id, dispatchKey: dispatchKeyForInbox(inbox), now, priority: 5, maxSteps: 25, deadlineAt: now + 900000, skillSetHash: "ss" });
const claim = claimNextTask(db, { now, leaseMs: 45000 });
const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(claim.taskId);
const card = proposeEffect(db, stateDir, {
  now, taskId: task.id,
  attemptId: db.prepare("SELECT id FROM attempts WHERE task_id=? AND attempt_no=?").get(task.id, task.attempt_no).id,
  effectType: "notify", domainKey: "dm:telegram:6101", naturalKey: "probe-revise",
  operationIntent: { targetResource: "im:dm:6101", operation: "im.notify", contentHash: "a".repeat(64), evidenceManifestHash: "b".repeat(64) },
  retryMode: "AT_MOST_ONCE", provider: "telegram", resource: "im:dm:6101",
  requiresApproval: true, approverPrincipalId: OWNER, expiresAt: now + 3600000,
});
reviseEffect(db, stateDir, {
  now, effectId: card.effectId,
  editedIntent: { targetResource: "im:dm:6101", operation: "im.notify", contentHash: "c".repeat(64), evidenceManifestHash: "b".repeat(64) },
  approverPrincipalId: OWNER, actorId: OWNER, expiresAt: now + 7200000,
});
const oldApproval = db.prepare("SELECT state FROM approvals WHERE id=?").get(card.approvalId);
const oldEffect = db.prepare("SELECT state FROM effects WHERE id=?").get(card.effectId);
const ok = oldApproval.state === "INVALIDATED" && oldEffect.state === "CANCELLED";
console.log(`probe-revise: oldApproval=${oldApproval.state} oldEffect=${oldEffect.state} -> ${ok ? "gate holds" : "GATE BROKEN"}`);
process.exit(ok ? 0 : 1);
