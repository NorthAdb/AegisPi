// Budget ledger per design-pack 06 section 8.
//
// Every chargeable request reserves BEFORE it runs: one transaction creates
// the HELD reservation and bumps each account's held with a single
// conditional UPDATE (unfrozen AND spent+held+new <= limit); any account
// failing rolls the whole transaction back. request_key is unique so the
// same request never double-holds. Settlement needs a trusted usage; usage
// unknown stays HELD and only a timeout converts it to CHARGED_BOUND (upper
// bound to spent, never released without reconciliation); later only a
// trusted bill can correct it. An actual over the bound is recorded honestly
// and freezes the account. The warming-day account exists only after warming
// is explicitly enabled; while off, warming reserves are refused outright.
//
// All money is integer microUSD. Multi-account splits are not double charges:
// on settle, each account's held drops by its share and its spent rises by
// the same share of the actual (integer division, remainder to the last
// account).

import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";

// Standalone gate used by chargeable paths (scheduler steps, dispatcher): the
// caller must hold a LIVE (HELD) reservation for this task and purpose, and
// the reservation id — not a stdout line — is the proof.
export function assertLiveReservation(db, { reservationId, taskId = null, purpose = null }) {
  const row = db.prepare("SELECT * FROM budget_reservations WHERE id=?").get(reservationId);
  if (!row) {
    throw new BudgetError(`reservation ${reservationId} not found: no chargeable call without a reservation`);
  }
  if (taskId !== null && row.task_id !== taskId) {
    throw new BudgetError(`reservation ${reservationId} belongs to task ${row.task_id}, not ${taskId}`);
  }
  if (purpose && row.purpose !== purpose) {
    throw new BudgetError(`reservation ${reservationId} is purpose ${row.purpose}, expected ${purpose}`);
  }
  if (row.state !== "HELD") {
    throw new BudgetError(`reservation ${reservationId} is ${row.state}, not HELD`);
  }
  return row;
}

export const PURPOSES = [
  "router", "worker", "summary", "classify", "rsi", "replay", "warming", "watchdog",
];

export class BudgetError extends Error {}
export class BudgetExceeded extends BudgetError {}
export class AccountFrozen extends BudgetError {}
export class MissingUsage extends BudgetError {}
export class RaiseRequiresApproval extends BudgetError {}
export class WarmingDisabled extends BudgetError {}

export function dayKeyFor(nowMs, timeZone = "Asia/Hong_Kong") {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(nowMs));
}

export function createBudgetLedger(db, {
  taskLimitMicrousd = 800000,
  dayLimitMicrousd = 5000000,
  warmingEnabled = false,
  timeZone = "Asia/Hong_Kong",
} = {}) {
  // Budget alerts stream into the service domain (06 section 1.1:
  // service:{name} for internal ops like budget patrol). The scope row must
  // exist before stream_events can reference it.
  db.prepare(
    "INSERT OR IGNORE INTO principals(id, platform, platform_subject) VALUES ('prn:system:budget','system','budget')",
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused)
     VALUES ('scp:service:budget','prn:system:budget','service','service:budget','internal',NULL,NULL,1,1,'pv1',0)`,
  ).run();

  function ensureTaskAccount({ taskId, now }) {
    return ensureAccount({
      id: `acct:task:${taskId}`,
      periodKey: `task:${taskId}`,
      limitMicrousd: taskLimitMicrousd,
      kind: "task",
      now,
    });
  }

  function ensureDayAccount({ now }) {
    const day = dayKeyFor(now, timeZone);
    return ensureAccount({
      id: `acct:day:${day}`,
      periodKey: `day:${day}`,
      limitMicrousd: dayLimitMicrousd,
      kind: "global-day",
      now,
    });
  }

  // "保温账户仅在保温被显式开启后才创建，默认不预留、不支出" (06 section 8).
  function ensureWarmingDayAccount({ now }) {
    if (!warmingEnabled) {
      throw new WarmingDisabled("warming is off: the warming-day account is not created and warming is not reserved");
    }
    const day = dayKeyFor(now, timeZone);
    return ensureAccount({
      id: `acct:warming-day:${day}`,
      periodKey: `warming-day:${day}`,
      limitMicrousd: dayLimitMicrousd,
      kind: "warming-day",
      now,
    });
  }

  function ensureAccount({ id, periodKey, limitMicrousd, kind, now }) {
    const existing = db.prepare("SELECT id, limit_microusd FROM budget_accounts WHERE id=?").get(id);
    if (existing) {
      return { accountId: id, created: false, limitMicrousd: existing.limit_microusd };
    }
    db.prepare(
      "INSERT INTO budget_accounts(id, period_key, limit_microusd, spent_microusd, held_microusd, frozen) VALUES (?,?,?,0,0,0)",
    ).run(id, periodKey, limitMicrousd);
    writeAudit(db, {
      code: "budget_account_created",
      details: { account_id: id, kind, limit_microusd: limitMicrousd, period_key: periodKey },
      now,
    });
    return { accountId: id, created: true, limitMicrousd };
  }

  // Limits may be lowered freely (audited); a raise requires an explicit
  // approval identity in the same call (06 section 8).
  function setAccountLimit({ accountId, limitMicrousd, now, actorId = null, approvedBy = null }) {
    return withTx(db, () => {
      const acc = db.prepare("SELECT limit_microusd FROM budget_accounts WHERE id=?").get(accountId);
      if (!acc) throw new BudgetError(`account ${accountId} not found`);
      if (limitMicrousd > acc.limit_microusd && !approvedBy) {
        throw new RaiseRequiresApproval(
          `raising account ${accountId} limit ${acc.limit_microusd}->${limitMicrousd} needs explicit approval`,
        );
      }
      db.prepare("UPDATE budget_accounts SET limit_microusd=? WHERE id=?").run(limitMicrousd, accountId);
      writeAudit(db, {
        code: "budget_limit_changed",
        actorId,
        details: { account_id: accountId, old_limit: acc.limit_microusd, new_limit: limitMicrousd, approved_by: approvedBy },
        now,
      });
      return { accountId, limitMicrousd };
    });
  }

  function freezeAccount({ accountId, reason, now, actorId = null }) {
    return withTx(db, () => {
      const changed = db
        .prepare("UPDATE budget_accounts SET frozen=1 WHERE id=? AND frozen=0")
        .run(accountId).changes;
      writeAudit(db, {
        code: "budget_account_frozen",
        actorId,
        details: { account_id: accountId, reason },
        now,
      });
      writeStreamEvent(db, {
        scopeId: "scp:service:budget",
        eventType: "audit_alert",
        entityId: `account:${accountId}`,
        entityVersion: 1,
        payload: { reason },
        now,
      });
      return { accountId, alreadyFrozen: changed === 0 };
    });
  }

  function inSavepoint(name, fn) {
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      try {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } catch {}
      throw e;
    }
  }

  function reserveInTx({
    requestKey,
    taskId = null,
    purpose,
    provider,
    priceVersion,
    upperMicrousd,
    accounts,
    now,
  }) {
    if (!PURPOSES.includes(purpose)) {
      throw new BudgetError(`purpose ${purpose} is not one of the eight 06 section 8 purposes`);
    }
    if (!Number.isSafeInteger(upperMicrousd) || upperMicrousd < 0) {
      throw new BudgetError("upper_microusd must be a non-negative integer");
    }
    if (purpose === "warming" && !warmingEnabled) {
      throw new WarmingDisabled("warming is off: purpose=warming cannot reserve");
    }
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new BudgetError("a reservation must name at least one account");
    }
    for (const a of accounts) {
      if (!a || typeof a.accountId !== "string" || !Number.isSafeInteger(a.amountMicrousd) || a.amountMicrousd < 0) {
        throw new BudgetError(`invalid reservation account entry: ${JSON.stringify(a)}`);
      }
    }
    return inSavepoint("budget_reserve", () => {
      const existing = db
        .prepare("SELECT id, state FROM budget_reservations WHERE request_key=?")
        .get(requestKey);
      if (existing) {
        return { reservationId: existing.id, state: existing.state, duplicate: true };
      }
      const reservationId = `res:${requestKey}`;
      db.prepare(
        `INSERT INTO budget_reservations(id, request_key, task_id, purpose, provider, price_version,
          state, upper_microusd, actual_microusd, created_at, settled_at)
         VALUES (?,?,?,?,?,?, 'HELD', ?, NULL, ?, NULL)`,
      ).run(reservationId, requestKey, taskId, purpose, provider, priceVersion, upperMicrousd, now);
      for (const a of accounts) {
        const changed = db
          .prepare(
            `UPDATE budget_accounts SET held_microusd=held_microusd+?
             WHERE id=? AND frozen=0 AND spent_microusd+held_microusd+?<=limit_microusd`,
          )
          .run(a.amountMicrousd, a.accountId, a.amountMicrousd).changes;
        if (changed !== 1) {
          const acc = db.prepare("SELECT frozen, spent_microusd, held_microusd, limit_microusd FROM budget_accounts WHERE id=?").get(a.accountId);
          if (!acc) {
            throw new BudgetError(`account ${a.accountId} not found`);
          }
          if (acc.frozen) {
            throw new AccountFrozen(`account ${a.accountId} is frozen`);
          }
          throw new BudgetExceeded(
            `account ${a.accountId} cannot hold ${a.amountMicrousd}: spent=${acc.spent_microusd} held=${acc.held_microusd} limit=${acc.limit_microusd}`,
          );
        }
        db.prepare(
          "INSERT INTO reservation_accounts(reservation_id, account_id, amount_microusd) VALUES (?,?,?)",
        ).run(reservationId, a.accountId, a.amountMicrousd);
      }
      writeAudit(db, {
        code: "budget_reserved",
        taskId,
        details: { reservation_id: reservationId, purpose, provider, price_version: priceVersion, upper_microusd: upperMicrousd, accounts: accounts.map((a) => `${a.accountId}:${a.amountMicrousd}`) },
        now,
      });
      return { reservationId, state: "HELD", duplicate: false };
    });
  }

  function reserve(opts) {
    return withTx(db, () => reserveInTx(opts));
  }

  function reservationRow(reservationId) {
    return db.prepare("SELECT * FROM budget_reservations WHERE id=?").get(reservationId);
  }

  function requireLiveReservation({ reservationId, taskId, purpose }) {
    // The chargeable-path gate: callers pass the id they reserved with; a
    // missing, released, settled, or foreign reservation refuses the call.
    const row = reservationRow(reservationId);
    if (!row) throw new BudgetError(`reservation ${reservationId} not found`);
    if (taskId !== null && row.task_id !== taskId) {
      throw new BudgetError(`reservation ${reservationId} belongs to task ${row.task_id}, not ${taskId}`);
    }
    if (purpose && row.purpose !== purpose) {
      throw new BudgetError(`reservation ${reservationId} is purpose ${row.purpose}, expected ${purpose}`);
    }
    if (row.state !== "HELD") {
      throw new BudgetError(`reservation ${reservationId} is ${row.state}, not HELD`);
    }
    return row;
  }

  function splitAccounts(reservationId, actualMicrousd, upperMicrousd) {
    const rows = db
      .prepare("SELECT account_id, amount_microusd FROM reservation_accounts WHERE reservation_id=? ORDER BY account_id")
      .all(reservationId);
    const total = rows.reduce((s, r) => s + BigInt(r.amount_microusd), 0n);
    const actual = BigInt(actualMicrousd);
    let allocated = 0n;
    return rows.map((r, i) => {
      let spentRise;
      if (i === rows.length - 1) {
        spentRise = Number(actual - allocated);
      } else {
        const share = total > 0n ? (actual * BigInt(r.amount_microusd)) / total : 0n;
        allocated += share;
        spentRise = Number(share);
      }
      return {
        accountId: r.account_id,
        heldDrop: r.amount_microusd,
        spentRise,
      };
    });
  }

  // Settlement requires a trusted usage. "usage未知则先保持HELD" and a missing
  // usage must never settle as zero cost (06 section 8; Phase 1 N11 kept the
  // zero-value predicate honest — this is its budget-side twin).
  function settleInTx({ reservationId, usage, now, actorId = null }) {
    if (!usage || !Number.isSafeInteger(usage.actualMicrousd) || usage.actualMicrousd < 0) {
      throw new MissingUsage(
        `settlement of ${reservationId} requires a trusted usage with integer actualMicrousd (>=0); refusing to settle unknown usage`,
      );
    }
    return inSavepoint("budget_settle", () => {
      const row = reservationRow(reservationId);
      if (!row) throw new BudgetError(`reservation ${reservationId} not found`);
      if (row.state !== "HELD") {
        throw new BudgetError(`reservation ${reservationId} is ${row.state}; only HELD settles`);
      }
      const split = splitAccounts(reservationId, usage.actualMicrousd, row.upper_microusd);
      for (const s of split) {
        const changed = db
          .prepare(
            "UPDATE budget_accounts SET held_microusd=held_microusd-?, spent_microusd=spent_microusd+? WHERE id=? AND held_microusd>=?",
          )
          .run(s.heldDrop, s.spentRise, s.accountId, s.heldDrop).changes;
        if (changed !== 1) {
          throw new BudgetError(`account ${s.accountId} cannot release held ${s.heldDrop}`);
        }
      }
      db.prepare(
        "UPDATE budget_reservations SET state='SETTLED', actual_microusd=?, settled_at=? WHERE id=? AND state='HELD'",
      ).run(usage.actualMicrousd, now, reservationId);
      writeAudit(db, {
        code: "budget_settled",
        taskId: row.task_id,
        actorId,
        details: { reservation_id: reservationId, purpose: row.purpose, actual_microusd: usage.actualMicrousd, upper_microusd: row.upper_microusd, usage },
        now,
      });
      if (usage.actualMicrousd > row.upper_microusd) {
        for (const s of split) {
          db.prepare("UPDATE budget_accounts SET frozen=1 WHERE id=?").run(s.accountId);
          writeAudit(db, {
            code: "budget_overcharge_frozen",
            taskId: row.task_id,
            details: { account_id: s.accountId, actual_microusd: usage.actualMicrousd, upper_microusd: row.upper_microusd },
            now,
          });
          writeStreamEvent(db, {
            scopeId: "scp:service:budget",
            eventType: "audit_alert",
            entityId: `account:${s.accountId}`,
            entityVersion: 1,
            payload: { overcharge: usage.actualMicrousd - row.upper_microusd },
            now,
          });
        }
      }
      return { state: "SETTLED", overcharged: usage.actualMicrousd > row.upper_microusd };
    });
  }

  function settle(opts) {
    return withTx(db, () => settleInTx(opts));
  }

  function releaseInTx({ reservationId, reason, now, actorId = null }) {
    return inSavepoint("budget_release", () => {
      const row = reservationRow(reservationId);
      if (!row) throw new BudgetError(`reservation ${reservationId} not found`);
      if (row.state !== "HELD") {
        throw new BudgetError(`reservation ${reservationId} is ${row.state}; only HELD can release`);
      }
      const split = splitAccounts(reservationId, 0, row.upper_microusd);
      for (const s of split) {
        const changed = db
          .prepare("UPDATE budget_accounts SET held_microusd=held_microusd-? WHERE id=? AND held_microusd>=?")
          .run(s.heldDrop, s.accountId, s.heldDrop).changes;
        if (changed !== 1) throw new BudgetError(`account ${s.accountId} cannot release held ${s.heldDrop}`);
      }
      db.prepare("UPDATE budget_reservations SET state='RELEASED', settled_at=? WHERE id=? AND state='HELD'").run(now, reservationId);
      writeAudit(db, {
        code: "budget_released",
        taskId: row.task_id,
        actorId,
        details: { reservation_id: reservationId, reason },
        now,
      });
      return { state: "RELEASED" };
    });
  }

  // "确定未发出且未计费才RELEASED" — the caller must state the justification;
  // the ledger audits it rather than guessing.
  function release(opts) {
    return withTx(db, () => releaseInTx(opts));
  }

  // Unknown usage past its settle timeout: the conservative bound becomes
  // spent. Never released, correctable later only by a trusted bill.
  function chargeBound({ reservationId, now }) {
    return withTx(db, () => {
      const row = reservationRow(reservationId);
      if (!row) throw new BudgetError(`reservation ${reservationId} not found`);
      if (row.state !== "HELD") {
        throw new BudgetError(`reservation ${reservationId} is ${row.state}; only HELD can be charged to its bound`);
      }
      const split = splitAccounts(reservationId, row.upper_microusd, row.upper_microusd);
      for (const s of split) {
        const changed = db
          .prepare("UPDATE budget_accounts SET held_microusd=held_microusd-?, spent_microusd=spent_microusd+? WHERE id=? AND held_microusd>=?")
          .run(s.heldDrop, s.spentRise, s.accountId, s.heldDrop).changes;
        if (changed !== 1) throw new BudgetError(`account ${s.accountId} cannot release held ${s.heldDrop}`);
      }
      db.prepare("UPDATE budget_reservations SET state='CHARGED_BOUND', actual_microusd=?, settled_at=? WHERE id=? AND state='HELD'").run(row.upper_microusd, now, reservationId);
      writeAudit(db, {
        code: "budget_charged_bound",
        taskId: row.task_id,
        details: { reservation_id: reservationId, purpose: row.purpose, upper_microusd: row.upper_microusd },
        now,
      });
      return { state: "CHARGED_BOUND" };
    });
  }

  // A CHARGED_BOUND reservation can be corrected only against trusted bill
  // evidence, with an actor recorded; the delta moves spent both ways.
  function correctChargedBound({ reservationId, newActualMicrousd, evidence, actorId, now }) {
    if (!Number.isSafeInteger(newActualMicrousd) || newActualMicrousd < 0) {
      throw new BudgetError("newActualMicrousd must be a non-negative integer");
    }
    if (!evidence || !actorId) {
      throw new BudgetError("correction requires trusted bill evidence and a recorded actor");
    }
    return withTx(db, () => {
      const row = reservationRow(reservationId);
      if (!row) throw new BudgetError(`reservation ${reservationId} not found`);
      if (row.state !== "CHARGED_BOUND") {
        throw new BudgetError(`reservation ${reservationId} is ${row.state}; only CHARGED_BOUND corrects`);
      }
      const oldActual = row.actual_microusd ?? row.upper_microusd;
      const delta = newActualMicrousd - oldActual;
      const split = splitAccounts(reservationId, Math.abs(delta), row.upper_microusd);
      for (const s of split) {
        if (delta >= 0) {
          db.prepare("UPDATE budget_accounts SET spent_microusd=spent_microusd+? WHERE id=?").run(s.spentRise, s.accountId);
        } else {
          const changed = db
            .prepare("UPDATE budget_accounts SET spent_microusd=spent_microusd-? WHERE id=? AND spent_microusd>=?")
            .run(s.spentRise, s.accountId, s.spentRise).changes;
          if (changed !== 1) throw new BudgetError(`account ${s.accountId} spent would go negative`);
        }
      }
      db.prepare("UPDATE budget_reservations SET actual_microusd=? WHERE id=?").run(newActualMicrousd, reservationId);
      writeAudit(db, {
        code: "budget_corrected",
        taskId: row.task_id,
        actorId,
        details: { reservation_id: reservationId, old_actual: oldActual, new_actual: newActualMicrousd, delta, evidence },
        now,
      });
      return { state: "CHARGED_BOUND", actualMicrousd: newActualMicrousd };
    });
  }

  function accountRow(accountId) {
    return db.prepare("SELECT * FROM budget_accounts WHERE id=?").get(accountId);
  }

  return {
    ensureTaskAccount,
    ensureDayAccount,
    ensureWarmingDayAccount,
    ensureAccount,
    setAccountLimit,
    freezeAccount,
    reserve,
    reserveInTx,
    requireLiveReservation,
    settle,
    settleInTx,
    release,
    releaseInTx,
    chargeBound,
    correctChargedBound,
    reservationRow,
    accountRow,
    get warmingEnabled() {
      return warmingEnabled;
    },
  };
}
