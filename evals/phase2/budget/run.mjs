// test:budget — Phase 2 budget-ledger suite (06 section 8).
// Every case runs the real ledger against a real SQLite file; the race case
// spawns two child processes on the same database. All money is integer
// microUSD; the spec defaults (800000 per task / 5000000 per day) are asserted
// straight out of the shipped defaults.json so scenario examples cannot
// quietly override them.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
  repoRoot,
  spawnNode,
} from "../lib/harness.mjs";
import { loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import {
  createBudgetLedger,
  PURPOSES,
  BudgetExceeded,
  AccountFrozen,
  MissingUsage,
  RaiseRequiresApproval,
  WarmingDisabled,
  BudgetError,
  dayKeyFor,
} from "../../../apps/daemon/src/budget.mjs";

lockedNodeGuard();

const suite = makeSuite("budget");

// Seed one real task so reservations hang off an existing tasks row (the
// ledger's task_id is a real foreign key, not a free string).
async function seedTask(db, stateDir, { eventSuffix, now }) {
  const { receiveEvent, dispatchKeyForInbox } = await import("../../../apps/daemon/src/ingress.mjs");
  const { dispatchEventToTask } = await import("../../../apps/daemon/src/router.mjs");
  const ing = receiveEvent(db, stateDir, {
    now,
    source: "telegram",
    sourceEventId: `evt-budget-${eventSuffix}`,
    principal: { platform: "telegram", subject: `7${eventSuffix}` },
    scope: {
      kind: "owner_dm",
      domainKey: `dm:telegram:7${eventSuffix}`,
      channel: "telegram",
      conversationId: `7${eventSuffix}`,
    },
    threadKey: `t-${eventSuffix}`,
    priority: 5,
    policyVersion: "pv1",
    payload: `budget fixture ${eventSuffix}`,
    verdict: "ADMIT",
  });
  const d = dispatchEventToTask(db, {
    inboxId: ing.inboxId,
    dispatchKey: dispatchKeyForInbox(db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId)),
    now,
    priority: 5,
    maxSteps: 25,
    deadlineAt: now + 15 * 60 * 1000,
    skillSetHash: "skillset-v1",
  });
  return d.taskId;
}

// ----------------------------------------------------- spec defaults are pinned
{
  const defaults = JSON.parse(
    readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"),
  );
  suite.check(
    "spec-defaults-not-overridden",
    defaults.budget.taskMicroUsd === 800000 &&
      defaults.budget.taskMaxSteps === 25 &&
      defaults.budget.taskMaxWallClockSeconds === 900 &&
      defaults.budget.dayMicroUsd === 5000000 &&
      defaults.budget.cacheWarming === "off",
    `task=${defaults.budget.taskMicroUsd} steps=${defaults.budget.taskMaxSteps} wall=${defaults.budget.taskMaxWallClockSeconds}s day=${defaults.budget.dayMicroUsd} warming=${defaults.budget.cacheWarming}`,
  );
  const expected = ["router", "worker", "summary", "classify", "rsi", "replay", "warming", "watchdog"];
  suite.check(
    "eight-purposes-declared",
    JSON.stringify(defaults.budget.purposes) === JSON.stringify(expected) &&
      JSON.stringify(PURPOSES) === JSON.stringify(expected),
    `purposes=${defaults.budget.purposes.join(",")}`,
  );
}

// ------------------------------------------------------------ ledger basics
{
  const canonical = loadCanonicalSchema();
  const ws = makeWorkspace("budget-basics");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, canonical);
  const ledger = createBudgetLedger(db, {});
  const now = 1795200000000;
  const taskIdBasic = await seedTask(db, ws.stateDir, { eventSuffix: "b1", now });

  const task = ledger.ensureTaskAccount({ taskId: taskIdBasic, now });
  const day = ledger.ensureDayAccount({ now });
  suite.check(
    "accounts-created-with-spec-defaults",
    task.created === true && day.created === true &&
      ledger.accountRow(task.accountId).limit_microusd === 800000 &&
      ledger.accountRow(day.accountId).limit_microusd === 5000000,
    `task account limit=${ledger.accountRow(task.accountId).limit_microusd}, day limit=${ledger.accountRow(day.accountId).limit_microusd}`,
  );
  suite.check(
    "day-key-uses-hong-kong-midnight",
    day.accountId.endsWith(dayKeyFor(now)),
    `account ${day.accountId} for dayKey ${dayKeyFor(now)}`,
  );
  const again = ledger.ensureTaskAccount({ taskId: taskIdBasic, now });
  suite.check("account-ensure-idempotent", again.created === false, "second ensure reuses the row");

  const r1 = ledger.reserve({
    requestKey: "req:b1",
    taskId: taskIdBasic,
    purpose: "worker",
    provider: "deepseek",
    priceVersion: "catalog-v1",
    upperMicrousd: 2000,
    accounts: [
      { accountId: task.accountId, amountMicrousd: 1000 },
      { accountId: day.accountId, amountMicrousd: 1000 },
    ],
    now,
  });
  const taskRow = ledger.accountRow(task.accountId);
  const dayRow = ledger.accountRow(day.accountId);
  const resRow = ledger.reservationRow(r1.reservationId);
  const resAccounts = db
    .prepare("SELECT account_id, amount_microusd FROM reservation_accounts WHERE reservation_id=?")
    .all(r1.reservationId);
  suite.check(
    "reserve-holds-on-every-account",
    r1.duplicate === false && resRow.state === "HELD" && resRow.upper_microusd === 2000 &&
      taskRow.held_microusd === 1000 && dayRow.held_microusd === 1000 && resAccounts.length === 2,
    `HELD task+1000 day+1000, reservation_accounts=${resAccounts.length}`,
  );

  const r2 = ledger.reserve({
    requestKey: "req:b1",
    taskId: taskIdBasic,
    purpose: "worker",
    provider: "deepseek",
    priceVersion: "catalog-v1",
    upperMicrousd: 2000,
    accounts: [
      { accountId: task.accountId, amountMicrousd: 1000 },
      { accountId: day.accountId, amountMicrousd: 1000 },
    ],
    now,
  });
  suite.check(
    "request-key-prevents-double-hold",
    r2.duplicate === true && r2.reservationId === r1.reservationId &&
      ledger.accountRow(task.accountId).held_microusd === 1000,
    `duplicate=${r2.duplicate}, held still ${ledger.accountRow(task.accountId).held_microusd}`,
  );

  // All-or-nothing: the day account could hold it, the task account cannot;
  // the whole transaction must roll back (no reservation row, no day residue).
  let exceeded = false;
  try {
    ledger.reserve({
      requestKey: "req:b2",
      taskId: taskIdBasic,
      purpose: "worker",
      provider: "deepseek",
      priceVersion: "catalog-v1",
      upperMicrousd: 799000 + 1,
      accounts: [
        { accountId: task.accountId, amountMicrousd: 799001 },
        { accountId: day.accountId, amountMicrousd: 799001 },
      ],
      now,
    });
  } catch (e) {
    exceeded = e instanceof BudgetExceeded;
  }
  const resB2 = db.prepare("SELECT count(*) c FROM budget_reservations WHERE request_key='req:b2'").get().c;
  suite.check(
    "any-account-failure-rolls-back-everything",
    exceeded === true && resB2 === 0 &&
      ledger.accountRow(task.accountId).held_microusd === 1000 &&
      ledger.accountRow(day.accountId).held_microusd === 1000,
    `reservation rows for req:b2=${resB2}, task held=${ledger.accountRow(task.accountId).held_microusd}, day held=${ledger.accountRow(day.accountId).held_microusd}`,
  );

  // Settlement: trusted usage only.
  let missingUsageRefused = false;
  try {
    ledger.settle({ reservationId: r1.reservationId, usage: null, now });
  } catch (e) {
    missingUsageRefused = e instanceof MissingUsage;
  }
  suite.check(
    "missing-usage-cannot-settle-as-zero",
    missingUsageRefused && ledger.reservationRow(r1.reservationId).state === "HELD",
    "settle without usage refused, reservation stays HELD",
  );
  const settled = ledger.settle({
    reservationId: r1.reservationId,
    usage: { inputTokens: 461, outputTokens: 2, actualMicrousd: 1407 },
    now,
  });
  const resSettled = ledger.reservationRow(r1.reservationId);
  const taskAfter = ledger.accountRow(task.accountId);
  const dayAfter = ledger.accountRow(day.accountId);
  suite.check(
    "settle-releases-held-adds-actual-spent",
    settled.state === "SETTLED" && resSettled.actual_microusd === 1407 &&
      taskAfter.held_microusd === 0 && dayAfter.held_microusd === 0 &&
      taskAfter.spent_microusd + dayAfter.spent_microusd === 1407,
    `task spent=${taskAfter.spent_microusd} day spent=${dayAfter.spent_microusd} held both 0`,
  );

  // RELEASED only for a definitely-not-sent, not-billed reservation.
  const r3 = ledger.reserve({
    requestKey: "req:b3",
    taskId: taskIdBasic,
    purpose: "router",
    provider: "deepseek",
    priceVersion: "catalog-v1",
    upperMicrousd: 500,
    accounts: [{ accountId: day.accountId, amountMicrousd: 500 }],
    now,
  });
  let releaseRefusedAfterSettle = false;
  try {
    ledger.release({ reservationId: r1.reservationId, reason: "not_sent", now });
  } catch (e) {
    releaseRefusedAfterSettle = e instanceof BudgetError;
  }
  const released = ledger.release({ reservationId: r3.reservationId, reason: "model call never dispatched, provider not billed", now });
  suite.check(
    "release-only-when-definitely-not-sent",
    releaseRefusedAfterSettle && released.state === "RELEASED" &&
      ledger.accountRow(day.accountId).held_microusd === 0,
    "RELEASED on held-only reservation; SETTLED reservation refuses release",
  );

  // CHARGED_BOUND: unknown usage, timeout, upper bound becomes spent; only a
  // trusted bill with an actor can correct it afterwards.
  const r4 = ledger.reserve({
    requestKey: "req:b4",
    taskId: taskIdBasic,
    purpose: "summary",
    provider: "deepseek",
    priceVersion: "catalog-v1",
    upperMicrousd: 900,
    accounts: [{ accountId: day.accountId, amountMicrousd: 900 }],
    now,
  });
  const charged = ledger.chargeBound({ reservationId: r4.reservationId, now: now + 15 * 60 * 1000 });
  let correctionWithoutEvidenceRefused = false;
  try {
    ledger.correctChargedBound({ reservationId: r4.reservationId, newActualMicrousd: 300, evidence: null, actorId: null, now });
  } catch (e) {
    correctionWithoutEvidenceRefused = e instanceof BudgetError;
  }
  const corrected = ledger.correctChargedBound({
    reservationId: r4.reservationId,
    newActualMicrousd: 300,
    evidence: { kind: "provider_bill", ref: "invoice-2026-11#401", sha256: "ab12" },
    actorId: "prn:system:owner",
    now,
  });
  suite.check(
    "charged-bound-conservative-then-trusted-bill-corrects",
    charged.state === "CHARGED_BOUND" && correctionWithoutEvidenceRefused &&
      corrected.actualMicrousd === 300,
    `CHARGED_BOUND upper->spent, correction refused without evidence, corrected to ${corrected.actualMicrousd}`,
  );

  // Overcharge: honest record, freeze, stop new requests.
  const r5 = ledger.reserve({
    requestKey: "req:b5",
    taskId: taskIdBasic,
    purpose: "classify",
    provider: "deepseek",
    priceVersion: "catalog-v1",
    upperMicrousd: 100,
    accounts: [{ accountId: day.accountId, amountMicrousd: 100 }],
    now,
  });
  const over = ledger.settle({
    reservationId: r5.reservationId,
    usage: { inputTokens: 10, outputTokens: 10, actualMicrousd: 250 },
    now,
  });
  let frozenRefuses = false;
  try {
    ledger.reserve({
      requestKey: "req:b6",
      taskId: taskIdBasic,
      purpose: "worker",
      provider: "deepseek",
      priceVersion: "catalog-v1",
      upperMicrousd: 10,
      accounts: [{ accountId: day.accountId, amountMicrousd: 10 }],
      now,
    });
  } catch (e) {
    frozenRefuses = e instanceof AccountFrozen;
  }
  suite.check(
    "overcharge-records-honestly-freezes-stops-new",
    over.overcharged === true && ledger.accountRow(day.accountId).frozen === 1 && frozenRefuses,
    `actual 250 over bound 100 recorded, day account frozen, new reserve refused`,
  );

  // Limit changes: lower freely, raise only with approval.
  const lowered = ledger.setAccountLimit({ accountId: task.accountId, limitMicrousd: 500000, now, actorId: "prn:system:owner" });
  let raiseRefused = false;
  try {
    ledger.setAccountLimit({ accountId: task.accountId, limitMicrousd: 900000, now, actorId: "prn:system:owner" });
  } catch (e) {
    raiseRefused = e instanceof RaiseRequiresApproval;
  }
  const raised = ledger.setAccountLimit({
    accountId: task.accountId, limitMicrousd: 900000, now,
    actorId: "prn:system:owner", approvedBy: "owner-approval-2026-11-19",
  });
  suite.check(
    "limit-lower-free-raise-needs-approval",
    lowered.limitMicrousd === 500000 && raiseRefused && raised.limitMicrousd === 900000,
    `lower ok; raise refused without approval, accepted with`,
  );
}

// ------------------------------------------------------------- eight purposes
{
  const canonical = loadCanonicalSchema();
  const ws = makeWorkspace("budget-purposes");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, canonical);
  const ledger = createBudgetLedger(db, {});
  const now = 1795200000000;
  const taskIdAll = await seedTask(db, ws.stateDir, { eventSuffix: "all", now });
  const task = ledger.ensureTaskAccount({ taskId: taskIdAll, now }).accountId;
  const day = ledger.ensureDayAccount({ now }).accountId;
  let allOk = true;
  const details = [];
  for (const purpose of PURPOSES) {
    if (purpose === "warming") continue; // gated below
    const r = ledger.reserve({
      requestKey: `purpose:${purpose}`,
      taskId: taskIdAll,
      purpose,
      provider: "deepseek",
      priceVersion: "catalog-v1",
      upperMicrousd: 100,
      accounts: [
        { accountId: task, amountMicrousd: 50 },
        { accountId: day, amountMicrousd: 50 },
      ],
      now,
    });
    const s = ledger.settle({
      reservationId: r.reservationId,
      usage: { actualMicrousd: 80 },
      now,
    });
    allOk = allOk && r.duplicate === false && s.state === "SETTLED";
    details.push(`${purpose}=settled`);
  }
  suite.check("seven-purposes-reserve-and-settle", allOk, details.join(", "));

  // Warming: off by default — no account, no reservation.
  let warmingReserveRefused = false;
  let warmingAccountRefused = false;
  try {
    ledger.reserve({
      requestKey: "purpose:warming",
      taskId: taskIdAll,
      purpose: "warming",
      provider: "deepseek",
      priceVersion: "catalog-v1",
      upperMicrousd: 10,
      accounts: [{ accountId: day, amountMicrousd: 10 }],
      now,
    });
  } catch (e) {
    warmingReserveRefused = e instanceof WarmingDisabled;
  }
  try {
    ledger.ensureWarmingDayAccount({ now });
  } catch (e) {
    warmingAccountRefused = e instanceof WarmingDisabled;
  }
  const warmingRows = db.prepare("SELECT count(*) c FROM budget_accounts WHERE id LIKE 'acct:warming-day:%'").get().c;
  suite.check(
    "warming-off-no-account-no-reserve",
    warmingReserveRefused && warmingAccountRefused && warmingRows === 0,
    `warming reserve refused, account refused, rows=${warmingRows}`,
  );

  // Explicitly enabled: the warming-day account appears and reserves.
  const ws2 = makeWorkspace("budget-warming-on");
  mkdirSync(join(ws2.stateDir, "db"), { recursive: true });
  const db2 = openDatabase(ws2.dbPath);
  migrate(db2, canonical);
  const ledgerOn = createBudgetLedger(db2, { warmingEnabled: true });
  const warmAcc = ledgerOn.ensureWarmingDayAccount({ now });
  const warmRes = ledgerOn.reserve({
    requestKey: "warm:1",
    purpose: "warming",
    provider: "deepseek",
    priceVersion: "catalog-v1",
    upperMicrousd: 300,
    accounts: [{ accountId: warmAcc.accountId, amountMicrousd: 300 }],
    now,
  });
  suite.check(
    "warming-enabled-creates-account-and-reserves",
    warmAcc.created === true && warmRes.state === "HELD",
    `warming account ${warmAcc.accountId} created, reservation HELD`,
  );
}

// -------------------------------------------------------------- bypass gate
{
  const canonical = loadCanonicalSchema();
  const ws = makeWorkspace("budget-bypass-gate");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, canonical);
  const { receiveEvent, dispatchKeyForInbox } = await import("../../../apps/daemon/src/ingress.mjs");
  const { dispatchEventToTask } = await import("../../../apps/daemon/src/router.mjs");
  const { claimNextTask, workerStep } = await import("../../../apps/daemon/src/scheduler.mjs");
  const now = 1795300000000;
  const ing = receiveEvent(db, ws.stateDir, {
    now,
    source: "telegram",
    sourceEventId: "evt-budget-1",
    principal: { platform: "telegram", subject: "7001" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:7001", channel: "telegram", conversationId: "7001" },
    threadKey: "t1",
    priority: 5,
    policyVersion: "pv1",
    payload: "charge me",
    verdict: "ADMIT",
  });
  const d = dispatchEventToTask(db, {
    inboxId: ing.inboxId,
    dispatchKey: dispatchKeyForInbox(db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId)),
    now, priority: 5, maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "skillset-v1",
  });
  const claim = claimNextTask(db, { now, leaseMs: 45000 });
  let noReservationRefused = false;
  try {
    workerStep(db, { taskId: claim.taskId, attemptNo: claim.attemptNo, leaseOwner: claim.leaseOwner, fence: claim.fence, now, budgetReservationId: "res:does-not-exist" });
  } catch (e) {
    noReservationRefused = e instanceof BudgetError;
  }
  suite.check(
    "chargeable-step-refuses-without-live-reservation",
    noReservationRefused,
    "workerStep without a reservation: BudgetError",
  );
  const ledger = createBudgetLedger(db, {});
  const taskAcc = ledger.ensureTaskAccount({ taskId: claim.taskId, now }).accountId;
  const dayAcc = ledger.ensureDayAccount({ now }).accountId;
  const res = ledger.reserve({
    requestKey: `worker:${claim.taskId}:1`,
    taskId: claim.taskId,
    purpose: "worker",
    provider: "deepseek",
    priceVersion: "catalog-v1",
    upperMicrousd: 1000,
    accounts: [
      { accountId: taskAcc, amountMicrousd: 500 },
      { accountId: dayAcc, amountMicrousd: 500 },
    ],
    now,
  });
  const step = workerStep(db, {
    taskId: claim.taskId, attemptNo: claim.attemptNo, leaseOwner: claim.leaseOwner, fence: claim.fence,
    now, budgetReservationId: res.reservationId,
  });
  let foreignPurposeRefused = false;
  const routerRes = ledger.reserve({
    requestKey: `router:${claim.taskId}:1`,
    taskId: claim.taskId,
    purpose: "router",
    provider: "deepseek",
    priceVersion: "catalog-v1",
    upperMicrousd: 100,
    accounts: [{ accountId: dayAcc, amountMicrousd: 100 }],
    now,
  });
  try {
    workerStep(db, {
      taskId: claim.taskId, attemptNo: claim.attemptNo, leaseOwner: claim.leaseOwner, fence: claim.fence,
      now, budgetReservationId: routerRes.reservationId,
    });
  } catch (e) {
    foreignPurposeRefused = e instanceof BudgetError;
  }
  suite.check(
    "step-runs-with-reservation-and-refuses-foreign-purpose",
    step.stepCount === 1 && foreignPurposeRefused,
    `step ok with worker reservation; router reservation refused for a worker step`,
  );
}

// ------------------------------------------------------- cross-process race
{
  const canonical = loadCanonicalSchema();
  const ws = makeWorkspace("budget-race");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, canonical);
  // Only ONE of the two 60_000 holds fits the 100_000 task account.
  const now = 1795400000000;
  const { receiveEvent, dispatchKeyForInbox } = await import("../../../apps/daemon/src/ingress.mjs");
  const { dispatchEventToTask } = await import("../../../apps/daemon/src/router.mjs");
  const ing = receiveEvent(db, ws.stateDir, {
    now,
    source: "telegram",
    sourceEventId: "evt-race-1",
    principal: { platform: "telegram", subject: "9001" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:9001", channel: "telegram", conversationId: "9001" },
    threadKey: "t1",
    priority: 5,
    policyVersion: "pv1",
    payload: "race the budget",
    verdict: "ADMIT",
  });
  const d = dispatchEventToTask(db, {
    inboxId: ing.inboxId,
    dispatchKey: dispatchKeyForInbox(db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId)),
    now, priority: 5, maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "skillset-v1",
  });
  const ledger = createBudgetLedger(db, { taskLimitMicrousd: 100000 });
  const taskAcc = ledger.ensureTaskAccount({ taskId: d.taskId, now }).accountId;
  ledger.ensureDayAccount({ now });
  db.close();
  const scenario = join(repoRoot, "evals", "phase2", "budget", "scenarios", "budget-race.mjs");
  const env = {
    AEGISPI_WS: ws.stateDir,
    AEGISPI_TASK_ID: d.taskId,
    AEGISPI_NOW: String(now),
  };
  const p1 = spawnNode(scenario, [], { env: { ...env, AEGISPI_SLOT: "1" } });
  const p2 = spawnNode(scenario, [], { env: { ...env, AEGISPI_SLOT: "2" } });
  const [d1, d2] = await Promise.all([p1.done, p2.done]);
  const outcomes = [d1, d2].sort((a, b) => a.code - b.code);
  const oneWon = outcomes[0].code === 0 && outcomes[1].code === 4;
  const db2 = openDatabase(ws.dbPath, { readOnly: true });
  const taskRow = db2.prepare("SELECT spent_microusd, held_microusd FROM budget_accounts WHERE id=?").get(taskAcc);
  const dayRow = db2
    .prepare("SELECT spent_microusd, held_microusd FROM budget_accounts WHERE id LIKE 'acct:day:%'")
    .get();
  const winners = db2
    .prepare("SELECT count(*) c FROM budget_reservations WHERE request_key LIKE 'race:%' AND state='HELD'")
    .get().c;
  db2.close();
  suite.check(
    "concurrent-reservations-exactly-one-wins-no-residue",
    oneWon && winners === 1 && taskRow.held_microusd === 60000 && dayRow.held_microusd === 60000,
    `slots exit ${d1.code}/${d2.code}, HELD winners=${winners}, task held=${taskRow.held_microusd}, day held=${dayRow.held_microusd} (loser left nothing)`,
  );
}

// -------------------------------------------------------------------- summary
const exit = suiteExit(suite, { label: "test:budget" });
const { reportPath, logPath } = writeReport({
  suiteId: "budget",
  suite,
  label: "Phase 2 test:budget — HELD 账本、八种 purpose、并发预留与结算（06 §8）",
  extra: { dataSources: "fake 远端与本地 SQLite（无真实外部连接）" },
  evidenceDir: join(repoRoot, "docs", "phase2", "evidence"),
});
console.log(`report: ${reportPath}`);
console.log(`log: ${logPath}`);
process.exit(exit);
