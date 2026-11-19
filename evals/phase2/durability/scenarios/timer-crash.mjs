// Crash-matrix scenario child (timer fire). Seeds one scope via a real
// ingress event, freezes a one-shot due timer, and runs the due scan. With
// AEGISPI_CRASH_POINT armed at timers:inside-fire-txn the kill lands inside
// the fire transaction (rollback); at timers:after-fire-commit it lands after
// the transaction (occurrence already durable, re-run must not duplicate).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireDaemonLock } from "../../../../apps/daemon/src/db/lock.mjs";
import { openDatabase } from "../../../../apps/daemon/src/db/connect.mjs";
import { loadCanonicalSchema, migrate } from "../../../../apps/daemon/src/db/migrate.mjs";
import { receiveEvent } from "../../../../apps/daemon/src/ingress.mjs";
import { createTimer, processDueTimers } from "../../../../apps/daemon/src/timers.mjs";

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
  sourceEventId: "evt-timer-seed-1",
  principal: { platform: "telegram", subject: "4001" },
  scope: { kind: "owner_dm", domainKey: "dm:telegram:4001", channel: "telegram", conversationId: "4001" },
  threadKey: "t1",
  priority: 5,
  policyVersion: "pv1",
  payload: "timer fixture seed",
  verdict: "ADMIT",
});
const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
createTimer(db, {
  id: "tmr:crash-1",
  scopeId: inbox.scope_id,
  principalId: inbox.principal_id,
  scopeEpoch: 1,
  threadKey: "t1",
  condition: { type: "none" },
  dueAt: now,
  recurrence: null,
  payloadObjectId: inbox.payload_object_id,
  now,
});
const result = processDueTimers(db, { now: now + 1 });
console.log(
  `TIMER-RESULT fired=${result.fired.length} satisfied=${result.satisfied.length} skipped=${result.skipped.length}`,
);
lock.release();
console.log("DONE");
process.exit(0);
