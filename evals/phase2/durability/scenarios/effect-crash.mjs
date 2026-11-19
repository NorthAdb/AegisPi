// Crash-matrix scenario child (approval + dispatch). Walks the full
// committed-action path: event -> task -> claim -> grant -> propose ->
// approve -> dispatch. The runner arms AEGISPI_CRASH_POINT to land the kill
// exactly at one 06 section 9 window:
//   approvals:inside-txn            - CAS mid-transaction (rolls back)
//   approvals:after-commit          - consumed, caller never learned
//   effects:after-cas-before-call   - READY->SUBMITTING committed, no bytes
//   effects:after-call-before-record- remote applied, local record missing
// Without a crashpoint it prints DONE and the fake remote's external id.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireDaemonLock } from "../../../../apps/daemon/src/db/lock.mjs";
import { openDatabase } from "../../../../apps/daemon/src/db/connect.mjs";
import { loadCanonicalSchema, migrate } from "../../../../apps/daemon/src/db/migrate.mjs";
import { receiveEvent, dispatchKeyForInbox, ensurePrincipal } from "../../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../../apps/daemon/src/scheduler.mjs";
import { proposeEffect } from "../../../../apps/daemon/src/effects.mjs";
import { decideApproval } from "../../../../apps/daemon/src/approvals.mjs";
import { dispatchEffect } from "../../../../apps/daemon/src/effects.mjs";
import { createFakeRemote } from "../../../../apps/daemon/src/testing/fake-remote.mjs";

const ws = process.env.AEGISPI_WS;
const now = Number(process.env.AEGISPI_NOW ?? Date.now());
const retryMode = process.env.AEGISPI_RETRY_MODE ?? "IDEMPOTENCY_KEY";
const fakeMode = process.env.AEGISPI_FAKE_MODE ?? "ok";

mkdirSync(join(ws, "db"), { recursive: true });
const lock = acquireDaemonLock(ws);
if (!lock.ok) {
  console.error(`lock held by pid ${lock.heldBy}`);
  process.exit(3);
}
const db = openDatabase(join(ws, "db", "aegis.db"));
migrate(db, loadCanonicalSchema());

const ing = receiveEvent(db, ws, {
  now,
  source: "telegram",
  sourceEventId: "evt-effect-1",
  principal: { platform: "telegram", subject: "5001" },
  scope: { kind: "owner_dm", domainKey: "dm:telegram:5001", channel: "telegram", conversationId: "5001" },
  threadKey: "t1",
  priority: 5,
  policyVersion: "pv1",
  payload: "notify me about the upstream change",
  verdict: "ADMIT",
});
const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
const d = dispatchEventToTask(db, {
  inboxId: ing.inboxId,
  dispatchKey: dispatchKeyForInbox(inbox),
  now,
  priority: 5,
  maxSteps: 25,
  deadlineAt: now + 15 * 60 * 1000,
  skillSetHash: "skillset-v1",
});
const claim = claimNextTask(db, { now, leaseMs: 45000 });

const approver = ensurePrincipal(db, { platform: "telegram", subject: "approver-1" });
db.prepare(
  "INSERT OR IGNORE INTO acl_grants(scope_id, principal_id, permission, expires_at, revoked_at) VALUES (?,?,'approve',NULL,NULL)",
).run(inbox.scope_id, approver.id);

const proposal = proposeEffect(db, ws, {
  now,
  taskId: d.taskId,
  attemptId: claim.attemptId,
  effectType: "notify",
  domainKey: "dm:telegram:5001",
  naturalKey: "v1",
  operationIntent: {
    targetResource: "telegram-dm:5001",
    operation: "send_message",
    contentHash: "deadbeef01",
    evidenceManifestHash: "cafe02",
  },
  retryMode,
  provider: "fake-telegram",
  resource: "dm:5001",
  requiresApproval: true,
  approverPrincipalId: approver.id,
  checkpointContent: "worker parked awaiting approval",
  expiresAt: now + 60 * 60 * 1000,
});
console.log(`PROPOSED ${proposal.effectId} state=${proposal.state} NONCE ${proposal.approvalNonce}`);

const decision = decideApproval(db, {
  approvalId: proposal.approvalId,
  decision: "approve",
  actionHash: proposal.actionHash,
  nonce: proposal.approvalNonce,
  approverId: approver.id,
  now,
});
console.log(`DECIDED accepted=${decision.accepted} state=${decision.state ?? decision.reason}`);

const remote = createFakeRemote(ws);
const dispatched = dispatchEffect(db, remote, {
  effectId: proposal.effectId,
  now,
  precondition: () => true,
});
console.log(`DISPATCHED state=${dispatched.state}${dispatched.externalId ? " external=" + dispatched.externalId : ""}`);
lock.release();
console.log("DONE");
process.exit(0);
