// Crash-matrix scenario child (task done, outbox not yet dispatched). Walks
// the full host-owned notification flow: claimed task -> pre-approved routine
// notification effect -> finalize (task conclusion + result evidence + outbox
// row in one transaction) — then dies BEFORE dispatching the notification.
// The durable pair (READY effect + outbox row) carries the work forward:
// after restart, recovery reports the pending notification and the dispatcher
// loop completes it.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireDaemonLock } from "../../../../apps/daemon/src/db/lock.mjs";
import { openDatabase } from "../../../../apps/daemon/src/db/connect.mjs";
import { loadCanonicalSchema, migrate } from "../../../../apps/daemon/src/db/migrate.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../../apps/daemon/src/scheduler.mjs";
import { insertObjectRow } from "../../../../apps/daemon/src/objects.mjs";
import { proposeEffect, draftToReady } from "../../../../apps/daemon/src/effects.mjs";
import { finalizeTaskWithNotification } from "../../../../apps/daemon/src/outbox.mjs";
import { crashpoint } from "../../../../apps/daemon/src/testing/crashpoints.mjs";

const ws = process.env.AEGISPI_WS;
const now = Number(process.env.AEGISPI_NOW ?? Date.now());
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
  sourceEventId: "evt-outbox-1",
  principal: { platform: "telegram", subject: "3001" },
  scope: { kind: "owner_dm", domainKey: "dm:telegram:3001", channel: "telegram", conversationId: "3001" },
  threadKey: "t1",
  priority: 5,
  policyVersion: "pv1",
  payload: "finish the task and notify me",
  verdict: "ADMIT",
});
const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
const d = dispatchEventToTask(db, {
  inboxId: ing.inboxId, dispatchKey: dispatchKeyForInbox(inbox),
  now, priority: 5, maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "skillset-v1",
});
const claim = claimNextTask(db, { now, leaseMs: 45000 });

const note = proposeEffect(db, ws, {
  now,
  taskId: d.taskId,
  attemptId: claim.attemptId,
  effectType: "notify",
  domainKey: "dm:telegram:3001",
  naturalKey: "outbox-crash-v1",
  operationIntent: { targetResource: "telegram-dm:3001", operation: "send_message", contentHash: "aa01", evidenceManifestHash: "bb01" },
  retryMode: "AT_MOST_ONCE",
  provider: "fake-telegram",
  resource: "dm",
  requiresApproval: false,
  expiresAt: now + 3600000,
});
draftToReady(db, { effectId: note.effectId, routineRef: "result-notification", approvedRoutines: ["result-notification"], now });

const evidence = insertObjectRow(db, {
  scopeId: inbox.scope_id, kind: "task_result", sourceUri: `task:${d.taskId}`,
  sourceActor: "host", content: "task result summary body",
  observedAt: now, requiredScopeIds: [inbox.scope_id],
});
const final = finalizeTaskWithNotification(db, {
  now: now + 100,
  taskId: d.taskId,
  attemptNo: claim.attemptNo,
  leaseOwner: claim.leaseOwner,
  fence: claim.fence,
  resultClass: "not_applicable",
  resultObjectId: evidence.id,
  notification: {
    effectId: note.effectId,
    channel: "telegram",
    destination: "dm:3001",
    notBefore: now,
    notifyReason: "task-result",
  },
});
console.log(`FINALIZED task=${final.taskState} outbox=${final.outboxId}`);
// The daemon dies between the durable conclusion and the notification send.
crashpoint("scenario:outbox-before-send");
console.log("UNREACHABLE");
