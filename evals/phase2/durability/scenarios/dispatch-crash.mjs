// Crash-matrix scenario child (dispatch). Ingests one event and dispatches
// one plan. With AEGISPI_CRASH_POINT=router:pre-txn it dies after the plan is
// computed but before the dispatch transaction — the 06 row "模型给出计划、
// 派单事务前：重算计划；唯一dispatch_key防重建". With router:inside-txn it dies
// mid-transaction and everything rolls back. Without a crashpoint it prints
// the DISPATCHED line only after the transaction committed.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireDaemonLock } from "../../../../apps/daemon/src/db/lock.mjs";
import { openDatabase } from "../../../../apps/daemon/src/db/connect.mjs";
import { loadCanonicalSchema, migrate } from "../../../../apps/daemon/src/db/migrate.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../../apps/daemon/src/router.mjs";

const ws = process.env.AEGISPI_WS;
mkdirSync(join(ws, "db"), { recursive: true });
const lock = acquireDaemonLock(ws);
if (!lock.ok) {
  console.error(`lock held by pid ${lock.heldBy}`);
  process.exit(3);
}
const db = openDatabase(join(ws, "db", "aegis.db"));
migrate(db, loadCanonicalSchema());

const now = Number(process.env.AEGISPI_NOW ?? Date.now());
const ing = receiveEvent(db, ws, {
  now,
  source: "telegram",
  sourceEventId: process.env.AEGISPI_EVENT_ID ?? "evt-d1",
  principal: { platform: "telegram", subject: "1001" },
  scope: {
    kind: "owner_dm",
    domainKey: "dm:telegram:1001",
    channel: "telegram",
    conversationId: "1001",
  },
  threadKey: "t1",
  priority: 5,
  policyVersion: "pv1",
  payload: "please check upstream",
  verdict: "ADMIT",
});
if (ing.duplicate) {
  // Redelivery after a crash: recompute the plan from the durable inbox row.
  console.log(`REDELIVER ${ing.inboxId}`);
}
const row = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
const d = dispatchEventToTask(db, {
  inboxId: ing.inboxId,
  dispatchKey: dispatchKeyForInbox(row),
  now,
  priority: 5,
  maxSteps: 25,
  deadlineAt: now + 15 * 60 * 1000,
  skillSetHash: "skillset-v1",
});
console.log(`DISPATCHED ${d.taskId} created=${d.created}`);
lock.release();
process.exit(0);
