// Cross-process budget race child. The runner pre-migrates a workspace whose
// task account only has room for ONE of the two 60_000-microUSD holds. Both
// slots run concurrently against the same SQLite file; exactly one conditional
// UPDATE may win. The loser must leave NO held residue on the global-day
// account either (whole-transaction rollback).

import { join } from "node:path";
import { openDatabase } from "../../../../apps/daemon/src/db/connect.mjs";
import { createBudgetLedger, BudgetExceeded } from "../../../../apps/daemon/src/budget.mjs";

const ws = process.env.AEGISPI_WS;
const slot = process.env.AEGISPI_SLOT;
const taskId = process.env.AEGISPI_TASK_ID;
const db = openDatabase(join(ws, "db", "aegis.db"));
const ledger = createBudgetLedger(db, {});
const now = Number(process.env.AEGISPI_NOW ?? Date.now());
const taskAcc = ledger.ensureTaskAccount({ taskId, now }).accountId;
const dayAcc = ledger.ensureDayAccount({ now }).accountId;
try {
  const r = ledger.reserve({
    requestKey: `race:${slot}`,
    taskId,
    purpose: "worker",
    provider: "deepseek",
    priceVersion: "catalog-v1",
    upperMicrousd: 60000,
    accounts: [
      { accountId: taskAcc, amountMicrousd: 60000 },
      { accountId: dayAcc, amountMicrousd: 60000 },
    ],
    now,
  });
  console.log(`RACE-RESULT slot=${slot} ok reservation=${r.reservationId} duplicate=${r.duplicate}`);
  process.exit(0);
} catch (e) {
  if (e instanceof BudgetExceeded) {
    console.log(`RACE-RESULT slot=${slot} exceeded ${e.message}`);
    process.exit(4);
  }
  console.error(`RACE-RESULT slot=${slot} error ${e.message}`);
  process.exit(5);
}
