// Crash-matrix scenario child (ingress). The runner creates the workspace,
// arms AEGISPI_CRASH_POINT, and spawns this script on the locked Node. The
// child performs the daemon-shaped init (lock, open, migrate) and then one
// event receive. If no crashpoint is armed it completes normally and prints
// the ACK line — the runner uses that line to prove ACKs only happen after
// the transaction committed.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireDaemonLock } from "../../../../apps/daemon/src/db/lock.mjs";
import { openDatabase } from "../../../../apps/daemon/src/db/connect.mjs";
import { loadCanonicalSchema, migrate } from "../../../../apps/daemon/src/db/migrate.mjs";
import { receiveEvent } from "../../../../apps/daemon/src/ingress.mjs";

const ws = process.env.AEGISPI_WS;
mkdirSync(join(ws, "db"), { recursive: true });
const lock = acquireDaemonLock(ws);
if (!lock.ok) {
  console.error(`lock held by pid ${lock.heldBy}`);
  process.exit(3);
}
const db = openDatabase(join(ws, "db", "aegis.db"));
const canonical = loadCanonicalSchema();
migrate(db, canonical);

const r = receiveEvent(db, ws, {
  now: Number(process.env.AEGISPI_NOW ?? Date.now()),
  source: "telegram",
  sourceEventId: "evt-0001",
  sourceKind: "message",
  principal: { platform: "telegram", subject: "1001" },
  scope: {
    kind: "owner_dm",
    domainKey: "dm:telegram:1001",
    channel: "telegram",
    conversationId: "1001",
  },
  threadKey: "thread-1",
  priority: 5,
  policyVersion: "pv1",
  payload: "owner asked for a repo status check",
  verdict: "ADMIT",
});

// The ACK line: printed only after receiveEvent returned, i.e. only after the
// transaction committed. A child that dies at a crashpoint never prints it.
console.log(`ACK ${r.inboxId} duplicate=${r.duplicate} state=${r.state}`);
lock.release();
process.exit(0);
