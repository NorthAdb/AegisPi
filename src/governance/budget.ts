import type { DatabaseSync } from "node:sqlite";
import { withImmediateTx, writeAuditEvent } from "./db.ts";
import { canonicalJson } from "./canonical.ts";

export const DEFAULT_TASK_LIMIT_MU = 800_000;
export const DEFAULT_DAY_LIMIT_MU = 5_000_000;
export const DEFAULT_TIME_ZONE = "Asia/Hong_Kong";

export type BudgetAccountKind = "TASK" | "DAY";
export type BudgetPurpose = "router" | "worker" | "compaction" | "summary" | "classify";
export type ReservationState = "HELD" | "SETTLED" | "RELEASED" | "CHARGED_BOUND";

export interface BudgetAccountRow {
  account_id: string;
  kind: BudgetAccountKind;
  limit_mu: number;
  held_mu: number;
  charged_mu: number;
  frozen: number;
}

export interface BudgetReservationRow {
  request_id: string;
  runtime_epoch: string;
  conversation_id: string;
  owner_task_id: string;
  purpose: string;
  task_account: string;
  day_account: string;
  charge_day: string;
  zone: string;
  binding_json: string;
  upper_mu: number;
  actual_mu: number | null;
  reserved_at: number;
  settle_due_at: number;
  state: ReservationState;
}

export type BudgetDenialCode =
  | "task_budget_exceeded"
  | "day_budget_exceeded"
  | "task_account_frozen"
  | "day_account_frozen"
  | "unknown_upper_bound"
  | "invalid_binding";

export class BudgetDeniedError extends Error {
  readonly code: BudgetDenialCode;
  readonly details: Record<string, unknown>;
  constructor(code: BudgetDenialCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BudgetDeniedError";
    this.code = code;
    this.details = details;
  }
}

export function formatChargeDay(nowMs: number, zone = DEFAULT_TIME_ZONE): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(nowMs));
}

export function taskAccountIdFor(ownerTaskId: string): string {
  return `acct:task:${ownerTaskId}`;
}

export function dayAccountIdFor(chargeDay: string, zone = DEFAULT_TIME_ZONE): string {
  return `acct:day:${zone}:${chargeDay}`;
}

export function getBudgetAccount(db: DatabaseSync, accountId: string): BudgetAccountRow | null {
  const row = db.prepare("SELECT * FROM budget_accounts WHERE account_id = ?").get(accountId) as
    | BudgetAccountRow
    | undefined;
  return row ?? null;
}

export function availableMu(account: BudgetAccountRow): number {
  return account.limit_mu - account.held_mu - account.charged_mu;
}

export function ensureBudgetAccount(
  db: DatabaseSync,
  params: { accountId: string; kind: BudgetAccountKind; limitMu: number },
): BudgetAccountRow {
  if (!Number.isSafeInteger(params.limitMu) || params.limitMu < 0) {
    throw new Error(`Invalid limitMu: ${String(params.limitMu)}`);
  }
  db.prepare(
    `INSERT OR IGNORE INTO budget_accounts(account_id, kind, limit_mu, held_mu, charged_mu, frozen)
     VALUES (?, ?, ?, 0, 0, 0)`,
  ).run(params.accountId, params.kind, params.limitMu);
  const row = getBudgetAccount(db, params.accountId);
  if (!row) {
    throw new Error(`Failed to ensure budget account ${params.accountId}`);
  }
  if (row.kind !== params.kind) {
    throw new Error(`Budget account ${params.accountId} kind mismatch: ${row.kind} vs ${params.kind}`);
  }
  return row;
}

export function setBudgetAccountLimit(
  db: DatabaseSync,
  params: {
    accountId: string;
    kind: BudgetAccountKind;
    limitMu: number;
    now: number;
    approvedBy?: string | null;
  },
): BudgetAccountRow {
  if (!Number.isSafeInteger(params.limitMu) || params.limitMu < 0) {
    throw new Error(`limitMu must be a non-negative integer, got ${String(params.limitMu)}`);
  }
  return withImmediateTx(db, () => {
    const existing = getBudgetAccount(db, params.accountId);
    if (!existing) {
      const created = ensureBudgetAccount(db, {
        accountId: params.accountId,
        kind: params.kind,
        limitMu: params.limitMu,
      });
      writeAuditEvent(db, {
        entityType: "budget_account",
        entityId: params.accountId,
        eventKey: `init:${params.now}:${params.limitMu}`,
        eventType: "budget_account_initialized",
        occurredAt: params.now,
        details: { kind: params.kind, limitMu: params.limitMu },
      });
      return created;
    }
    if (params.limitMu > existing.limit_mu && !params.approvedBy) {
      throw new Error(
        `Raising budget limit for ${params.accountId} (${existing.limit_mu} -> ${params.limitMu}) requires explicit approval`,
      );
    }
    db.prepare("UPDATE budget_accounts SET limit_mu = ? WHERE account_id = ?").run(
      params.limitMu,
      params.accountId,
    );
    writeAuditEvent(db, {
      entityType: "budget_account",
      entityId: params.accountId,
      eventKey: `limit:${params.now}:${existing.limit_mu}->${params.limitMu}`,
      eventType: "budget_limit_updated",
      occurredAt: params.now,
      details: {
        oldLimitMu: existing.limit_mu,
        newLimitMu: params.limitMu,
        approvedBy: params.approvedBy ?? null,
      },
    });
    return getBudgetAccount(db, params.accountId)!;
  });
}

export interface ReserveBudgetParams {
  requestId: string;
  runtimeEpoch: string;
  conversationId: string;
  ownerTaskId: string;
  purpose: BudgetPurpose;
  upperMu: number;
  now: number;
  settleTimeoutMs?: number;
  zone?: string;
  defaultTaskLimitMu?: number;
  defaultDayLimitMu?: number;
  binding: Record<string, unknown>;
  /** Test seam for B07: throws inside transaction after updating task_account and before day_account. */
  injectFaultAfterFirstAccount?: () => void;
}

export interface ReserveBudgetResult {
  reservation: BudgetReservationRow;
  taskAccountBefore: BudgetAccountRow;
  dayAccountBefore: BudgetAccountRow;
  taskAccountAfter: BudgetAccountRow;
  dayAccountAfter: BudgetAccountRow;
}

/**
 * T6: Atomically verify and freeze upperMu on BOTH task_account and day_account
 * inside one BEGIN IMMEDIATE transaction. Any shortfall rolls back both accounts
 * and writes a durable denial audit event with zero held funds.
 */
export function reserveBudget(db: DatabaseSync, params: ReserveBudgetParams): ReserveBudgetResult {
  const zone = params.zone ?? DEFAULT_TIME_ZONE;
  const chargeDay = formatChargeDay(params.now, zone);
  const taskAccountId = taskAccountIdFor(params.ownerTaskId);
  const dayAccountId = dayAccountIdFor(chargeDay, zone);

  if (!Number.isSafeInteger(params.upperMu) || params.upperMu < 0) {
    withImmediateTx(db, () => {
      writeAuditEvent(db, {
        entityType: "budget_denial",
        entityId: params.requestId,
        eventKey: `deny:${params.requestId}`,
        eventType: "budget_denied",
        occurredAt: params.now,
        details: {
          code: "unknown_upper_bound",
          runtimeEpoch: params.runtimeEpoch,
          conversationId: params.conversationId,
          ownerTaskId: params.ownerTaskId,
          purpose: params.purpose,
          upperMu: params.upperMu,
        },
      });
    });
    throw new BudgetDeniedError(
      "unknown_upper_bound",
      `Cannot determine integer microUSD upper bound for request ${params.requestId}`,
      { conversationId: params.conversationId, ownerTaskId: params.ownerTaskId, purpose: params.purpose },
    );
  }

  const bindingJson = canonicalJson(params.binding);
  const settleDueAt = params.now + (params.settleTimeoutMs ?? 300_000);
  const taskLimit = params.defaultTaskLimitMu ?? DEFAULT_TASK_LIMIT_MU;
  const dayLimit = params.defaultDayLimitMu ?? DEFAULT_DAY_LIMIT_MU;

  try {
    return withImmediateTx(db, () => {
      const taskBefore = ensureBudgetAccount(db, {
        accountId: taskAccountId,
        kind: "TASK",
        limitMu: taskLimit,
      });
      const dayBefore = ensureBudgetAccount(db, {
        accountId: dayAccountId,
        kind: "DAY",
        limitMu: dayLimit,
      });

      const taskUpdate = db
        .prepare(
          `UPDATE budget_accounts
             SET held_mu = held_mu + ?
           WHERE account_id = ?
             AND kind = 'TASK'
             AND frozen = 0
             AND charged_mu + held_mu + ? <= limit_mu`,
        )
        .run(params.upperMu, taskAccountId, params.upperMu);

      if (Number(taskUpdate.changes) !== 1) {
        const code: BudgetDenialCode =
          taskBefore.frozen === 1 ? "task_account_frozen" : "task_budget_exceeded";
        throw new BudgetDeniedError(
          code,
          code === "task_account_frozen"
            ? `Task budget account ${taskAccountId} is frozen`
            : `Insufficient task budget: need ${params.upperMu} microUSD, available ${availableMu(taskBefore)} microUSD (${taskAccountId})`,
          {
            accountId: taskAccountId,
            kind: "TASK",
            upperMu: params.upperMu,
            availableMu: availableMu(taskBefore),
            limitMu: taskBefore.limit_mu,
            heldMu: taskBefore.held_mu,
            chargedMu: taskBefore.charged_mu,
            conversationId: params.conversationId,
            ownerTaskId: params.ownerTaskId,
            purpose: params.purpose,
          },
        );
      }

      // B07 deterministic transaction interruption seam (after first account, before second account)
      if (params.injectFaultAfterFirstAccount) {
        params.injectFaultAfterFirstAccount();
      }

      const dayUpdate = db
        .prepare(
          `UPDATE budget_accounts
             SET held_mu = held_mu + ?
           WHERE account_id = ?
             AND kind = 'DAY'
             AND frozen = 0
             AND charged_mu + held_mu + ? <= limit_mu`,
        )
        .run(params.upperMu, dayAccountId, params.upperMu);

      if (Number(dayUpdate.changes) !== 1) {
        const code: BudgetDenialCode =
          dayBefore.frozen === 1 ? "day_account_frozen" : "day_budget_exceeded";
        throw new BudgetDeniedError(
          code,
          code === "day_account_frozen"
            ? `Day budget account ${dayAccountId} is frozen`
            : `Insufficient day budget: need ${params.upperMu} microUSD, available ${availableMu(dayBefore)} microUSD (${dayAccountId})`,
          {
            accountId: dayAccountId,
            kind: "DAY",
            upperMu: params.upperMu,
            availableMu: availableMu(dayBefore),
            limitMu: dayBefore.limit_mu,
            heldMu: dayBefore.held_mu,
            chargedMu: dayBefore.charged_mu,
            conversationId: params.conversationId,
            ownerTaskId: params.ownerTaskId,
            purpose: params.purpose,
          },
        );
      }

      db.prepare(
        `INSERT INTO budget_reservations(
           request_id, runtime_epoch, conversation_id, owner_task_id, purpose,
           task_account, day_account, charge_day, zone, binding_json,
           upper_mu, actual_mu, reserved_at, settle_due_at, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'HELD')`,
      ).run(
        params.requestId,
        params.runtimeEpoch,
        params.conversationId,
        params.ownerTaskId,
        params.purpose,
        taskAccountId,
        dayAccountId,
        chargeDay,
        zone,
        bindingJson,
        params.upperMu,
        params.now,
        settleDueAt,
      );

      writeAuditEvent(db, {
        entityType: "budget_reservation",
        entityId: params.requestId,
        eventKey: `reserve:${params.requestId}`,
        eventType: "budget_reserved",
        occurredAt: params.now,
        deltaMu: params.upperMu,
        details: {
          conversationId: params.conversationId,
          ownerTaskId: params.ownerTaskId,
          purpose: params.purpose,
          taskAccount: taskAccountId,
          dayAccount: dayAccountId,
          chargeDay,
          zone,
          upperMu: params.upperMu,
        },
      });

      const reservation = db
        .prepare("SELECT * FROM budget_reservations WHERE request_id = ?")
        .get(params.requestId) as unknown as BudgetReservationRow;
      const taskAfter = getBudgetAccount(db, taskAccountId)!;
      const dayAfter = getBudgetAccount(db, dayAccountId)!;

      return {
        reservation,
        taskAccountBefore: taskBefore,
        dayAccountBefore: dayBefore,
        taskAccountAfter: taskAfter,
        dayAccountAfter: dayAfter,
      };
    });
  } catch (err) {
    if (err instanceof BudgetDeniedError) {
      // Record durable denial reason in its own clean transaction (zero funds held)
      withImmediateTx(db, () => {
        writeAuditEvent(db, {
          entityType: "budget_denial",
          entityId: params.requestId,
          eventKey: `deny:${params.requestId}`,
          eventType: "budget_denied",
          occurredAt: params.now,
          details: {
            code: err.code,
            message: err.message,
            runtimeEpoch: params.runtimeEpoch,
            ...err.details,
          },
        });
      });
    }
    throw err;
  }
}

export interface SettleBudgetResult {
  requestId: string;
  state: ReservationState;
  duplicate: boolean;
  deltaMu: number;
  overcharged: boolean;
}

/**
 * T7: Idempotent settlement on trusted usage. Unfreezes upper_mu and charges actual_mu
 * on BOTH original task_account and day_account (preserving original charge_day across midnight).
 */
export function settleBudgetReservation(
  db: DatabaseSync,
  params: {
    requestId: string;
    actualMu: number;
    eventKey: string;
    evidenceRef?: string | null;
    now: number;
  },
): SettleBudgetResult {
  if (!Number.isSafeInteger(params.actualMu) || params.actualMu < 0) {
    throw new Error(`actualMu must be a non-negative integer, got ${String(params.actualMu)}`);
  }
  return withImmediateTx(db, () => {
    const row = db
      .prepare("SELECT * FROM budget_reservations WHERE request_id = ?")
      .get(params.requestId) as BudgetReservationRow | undefined;
    if (!row) {
      throw new Error(`Budget reservation not found: ${params.requestId}`);
    }
    if (row.state !== "HELD") {
      return {
        requestId: row.request_id,
        state: row.state,
        duplicate: true,
        deltaMu: 0,
        overcharged: false,
      };
    }

    const inserted = writeAuditEvent(db, {
      entityType: "budget_reservation",
      entityId: params.requestId,
      eventKey: params.eventKey,
      eventType: "budget_settled",
      occurredAt: params.now,
      evidenceRef: params.evidenceRef ?? null,
      deltaMu: params.actualMu,
      details: {
        upperMu: row.upper_mu,
        actualMu: params.actualMu,
        taskAccount: row.task_account,
        dayAccount: row.day_account,
        chargeDay: row.charge_day,
      },
    });
    if (!inserted) {
      return {
        requestId: row.request_id,
        state: row.state,
        duplicate: true,
        deltaMu: 0,
        overcharged: false,
      };
    }

    const r1 = db
      .prepare(
        `UPDATE budget_accounts
           SET held_mu = held_mu - ?, charged_mu = charged_mu + ?
         WHERE account_id = ? AND held_mu >= ?`,
      )
      .run(row.upper_mu, params.actualMu, row.task_account, row.upper_mu);
    const r2 = db
      .prepare(
        `UPDATE budget_accounts
           SET held_mu = held_mu - ?, charged_mu = charged_mu + ?
         WHERE account_id = ? AND held_mu >= ?`,
      )
      .run(row.upper_mu, params.actualMu, row.day_account, row.upper_mu);

    if (Number(r1.changes) !== 1 || Number(r2.changes) !== 1) {
      throw new Error(`Failed to settle held_mu on accounts for ${params.requestId}`);
    }

    db.prepare(
      `UPDATE budget_reservations
         SET state = 'SETTLED', actual_mu = ?
       WHERE request_id = ? AND state = 'HELD'`,
    ).run(params.actualMu, params.requestId);

    const overcharged = params.actualMu > row.upper_mu;
    if (overcharged) {
      db.prepare("UPDATE budget_accounts SET frozen = 1 WHERE account_id IN (?, ?)").run(
        row.task_account,
        row.day_account,
      );
      writeAuditEvent(db, {
        entityType: "budget_reservation",
        entityId: params.requestId,
        eventKey: `overcharge:${params.requestId}`,
        eventType: "budget_overcharge_frozen",
        occurredAt: params.now,
        deltaMu: params.actualMu - row.upper_mu,
        details: {
          taskAccount: row.task_account,
          dayAccount: row.day_account,
          upperMu: row.upper_mu,
          actualMu: params.actualMu,
        },
      });
    }

    return {
      requestId: row.request_id,
      state: "SETTLED",
      duplicate: false,
      deltaMu: params.actualMu,
      overcharged,
    };
  });
}

/**
 * T7: Release reservation ONLY when provably NOT sent (confirmed pre-transport failure).
 */
export function releaseBudgetReservation(
  db: DatabaseSync,
  params: {
    requestId: string;
    reason: string;
    evidenceRef: string;
    now: number;
  },
): { requestId: string; state: ReservationState; duplicate: boolean } {
  if (!params.evidenceRef) {
    throw new Error("releaseBudgetReservation requires explicit non-send evidenceRef");
  }
  return withImmediateTx(db, () => {
    const row = db
      .prepare("SELECT * FROM budget_reservations WHERE request_id = ?")
      .get(params.requestId) as BudgetReservationRow | undefined;
    if (!row) {
      throw new Error(`Budget reservation not found: ${params.requestId}`);
    }
    if (row.state !== "HELD") {
      return { requestId: row.request_id, state: row.state, duplicate: true };
    }

    const r1 = db
      .prepare("UPDATE budget_accounts SET held_mu = held_mu - ? WHERE account_id = ? AND held_mu >= ?")
      .run(row.upper_mu, row.task_account, row.upper_mu);
    const r2 = db
      .prepare("UPDATE budget_accounts SET held_mu = held_mu - ? WHERE account_id = ? AND held_mu >= ?")
      .run(row.upper_mu, row.day_account, row.upper_mu);
    if (Number(r1.changes) !== 1 || Number(r2.changes) !== 1) {
      throw new Error(`Failed to release held_mu for ${params.requestId}`);
    }

    db.prepare("UPDATE budget_reservations SET state = 'RELEASED', actual_mu = 0 WHERE request_id = ? AND state = 'HELD'").run(
      params.requestId,
    );

    writeAuditEvent(db, {
      entityType: "budget_reservation",
      entityId: params.requestId,
      eventKey: `release:${params.requestId}`,
      eventType: "budget_released",
      occurredAt: params.now,
      evidenceRef: params.evidenceRef,
      deltaMu: 0,
      details: { reason: params.reason, upperMu: row.upper_mu },
    });

    return { requestId: row.request_id, state: "RELEASED", duplicate: false };
  });
}

/**
 * T7: Convert timed-out HELD reservations (sent, missing usage) into CHARGED_BOUND
 * against their original task_account and day_account.
 */
export function chargeBoundExpiredReservations(
  db: DatabaseSync,
  params: { now: number; requestId?: string },
): string[] {
  return withImmediateTx(db, () => {
    const rows = (
      params.requestId
        ? db
            .prepare("SELECT * FROM budget_reservations WHERE request_id = ? AND state = 'HELD' AND settle_due_at <= ?")
            .all(params.requestId, params.now)
        : db
            .prepare("SELECT * FROM budget_reservations WHERE state = 'HELD' AND settle_due_at <= ?")
            .all(params.now)
    ) as unknown as BudgetReservationRow[];

    const transitioned: string[] = [];
    for (const row of rows) {
      const r1 = db
        .prepare(
          `UPDATE budget_accounts
             SET held_mu = held_mu - ?, charged_mu = charged_mu + ?
           WHERE account_id = ? AND held_mu >= ?`,
        )
        .run(row.upper_mu, row.upper_mu, row.task_account, row.upper_mu);
      const r2 = db
        .prepare(
          `UPDATE budget_accounts
             SET held_mu = held_mu - ?, charged_mu = charged_mu + ?
           WHERE account_id = ? AND held_mu >= ?`,
        )
        .run(row.upper_mu, row.upper_mu, row.day_account, row.upper_mu);
      if (Number(r1.changes) !== 1 || Number(r2.changes) !== 1) {
        throw new Error(`Failed to charge bound for ${row.request_id}`);
      }
      db.prepare(
        "UPDATE budget_reservations SET state = 'CHARGED_BOUND', actual_mu = ? WHERE request_id = ? AND state = 'HELD'",
      ).run(row.upper_mu, row.request_id);
      writeAuditEvent(db, {
        entityType: "budget_reservation",
        entityId: row.request_id,
        eventKey: `charge_bound:${row.request_id}`,
        eventType: "budget_charged_bound",
        occurredAt: params.now,
        deltaMu: row.upper_mu,
        details: {
          taskAccount: row.task_account,
          dayAccount: row.day_account,
          chargeDay: row.charge_day,
          upperMu: row.upper_mu,
        },
      });
      transitioned.push(row.request_id);
    }
    return transitioned;
  });
}

/**
 * T7: Apply a late trusted provider bill to a CHARGED_BOUND reservation.
 * Idempotent by billEventKey: applies only the delta against original accounts;
 * duplicate deliveries produce deltaMu = 0.
 */
export function correctChargedBoundReservation(
  db: DatabaseSync,
  params: {
    requestId: string;
    actualMu: number;
    billEventKey: string;
    evidenceRef: string;
    actorId: string;
    now: number;
  },
): { requestId: string; state: ReservationState; duplicate: boolean; deltaMu: number; actualMu: number } {
  if (!Number.isSafeInteger(params.actualMu) || params.actualMu < 0) {
    throw new Error(`actualMu must be a non-negative integer, got ${String(params.actualMu)}`);
  }
  if (!params.evidenceRef || !params.actorId) {
    throw new Error("correctChargedBoundReservation requires evidenceRef and actorId");
  }
  return withImmediateTx(db, () => {
    const row = db
      .prepare("SELECT * FROM budget_reservations WHERE request_id = ?")
      .get(params.requestId) as BudgetReservationRow | undefined;
    if (!row) {
      throw new Error(`Budget reservation not found: ${params.requestId}`);
    }
    if (row.state !== "CHARGED_BOUND") {
      throw new Error(`Reservation ${params.requestId} is ${row.state}; only CHARGED_BOUND can be corrected`);
    }

    const previousActual = row.actual_mu ?? row.upper_mu;
    const delta = params.actualMu - previousActual;

    const inserted = writeAuditEvent(db, {
      entityType: "budget_reservation",
      entityId: params.requestId,
      eventKey: params.billEventKey,
      eventType: "budget_bill_corrected",
      occurredAt: params.now,
      evidenceRef: params.evidenceRef,
      deltaMu: delta,
      details: {
        actorId: params.actorId,
        previousActualMu: previousActual,
        newActualMu: params.actualMu,
        deltaMu: delta,
        taskAccount: row.task_account,
        dayAccount: row.day_account,
        chargeDay: row.charge_day,
      },
    });
    if (!inserted) {
      return {
        requestId: row.request_id,
        state: row.state,
        duplicate: true,
        deltaMu: 0,
        actualMu: previousActual,
      };
    }

    if (delta >= 0) {
      db.prepare("UPDATE budget_accounts SET charged_mu = charged_mu + ? WHERE account_id = ?").run(
        delta,
        row.task_account,
      );
      db.prepare("UPDATE budget_accounts SET charged_mu = charged_mu + ? WHERE account_id = ?").run(
        delta,
        row.day_account,
      );
    } else {
      const refund = -delta;
      const r1 = db
        .prepare("UPDATE budget_accounts SET charged_mu = charged_mu - ? WHERE account_id = ? AND charged_mu >= ?")
        .run(refund, row.task_account, refund);
      const r2 = db
        .prepare("UPDATE budget_accounts SET charged_mu = charged_mu - ? WHERE account_id = ? AND charged_mu >= ?")
        .run(refund, row.day_account, refund);
      if (Number(r1.changes) !== 1 || Number(r2.changes) !== 1) {
        throw new Error(`Bill correction refund ${refund} exceeds charged_mu for ${params.requestId}`);
      }
    }

    db.prepare("UPDATE budget_reservations SET actual_mu = ? WHERE request_id = ?").run(
      params.actualMu,
      params.requestId,
    );

    return {
      requestId: row.request_id,
      state: "CHARGED_BOUND",
      duplicate: false,
      deltaMu: delta,
      actualMu: params.actualMu,
    };
  });
}

export interface BudgetTaskBindingRow {
  runtime_epoch: string;
  binding_kind: "PI_TASK" | "CONVERSATION";
  binding_key: string;
  conversation_id: string;
  owner_task_id: string;
  purpose: BudgetPurpose;
  created_at: number;
}

export function persistBudgetTaskBinding(
  db: DatabaseSync,
  params: {
    runtimeEpoch: string;
    bindingKind: "PI_TASK" | "CONVERSATION";
    bindingKey: string;
    conversationId: string;
    ownerTaskId: string;
    purpose: BudgetPurpose;
    now: number;
    overwrite?: boolean;
  },
): void {
  withImmediateTx(db, () => {
    const sql = params.overwrite
      ? `INSERT INTO budget_task_bindings(
           runtime_epoch, binding_kind, binding_key, conversation_id, owner_task_id, purpose, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runtime_epoch, binding_kind, binding_key) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           owner_task_id = excluded.owner_task_id,
           purpose = excluded.purpose`
      : `INSERT OR IGNORE INTO budget_task_bindings(
           runtime_epoch, binding_kind, binding_key, conversation_id, owner_task_id, purpose, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.prepare(sql).run(
      params.runtimeEpoch,
      params.bindingKind,
      params.bindingKey,
      params.conversationId,
      params.ownerTaskId,
      params.purpose,
      params.now,
    );
  });
}

export function getPersistedBudgetBinding(
  db: DatabaseSync,
  params: {
    runtimeEpoch: string;
    bindingKind: "PI_TASK" | "CONVERSATION";
    bindingKey: string;
  },
): BudgetTaskBindingRow | null {
  const row = db
    .prepare(
      `SELECT * FROM budget_task_bindings
        WHERE runtime_epoch = ? AND binding_kind = ? AND binding_key = ?`,
    )
    .get(params.runtimeEpoch, params.bindingKind, params.bindingKey) as BudgetTaskBindingRow | undefined;
  return row ?? null;
}

export function listPersistedBudgetBindings(
  db: DatabaseSync,
  runtimeEpoch: string,
): BudgetTaskBindingRow[] {
  return db
    .prepare("SELECT * FROM budget_task_bindings WHERE runtime_epoch = ? ORDER BY created_at ASC")
    .all(runtimeEpoch) as unknown as BudgetTaskBindingRow[];
}

export function listBudgetDenialsForConversation(
  db: DatabaseSync,
  conversationId: string,
  runtimeEpoch?: string,
): Array<{
  seq: number;
  requestId: string;
  occurredAt: number;
  code: string;
  message: string;
  ownerTaskId: string;
  purpose: string;
}> {
  const rows = db
    .prepare(
      `SELECT seq, entity_id, occurred_at, details_json
         FROM audit_events
        WHERE entity_type = 'budget_denial' AND event_type = 'budget_denied'
        ORDER BY seq ASC`,
    )
    .all() as Array<{ seq: number; entity_id: string; occurred_at: number; details_json: string | null }>;

  const out: Array<{
    seq: number;
    requestId: string;
    occurredAt: number;
    code: string;
    message: string;
    ownerTaskId: string;
    purpose: string;
  }> = [];

  for (const r of rows) {
    if (!r.details_json) continue;
    try {
      const parsed = JSON.parse(r.details_json) as Record<string, unknown>;
      if (
        parsed["conversationId"] === conversationId &&
        (!runtimeEpoch || parsed["runtimeEpoch"] === undefined || parsed["runtimeEpoch"] === runtimeEpoch)
      ) {
        out.push({
          seq: r.seq,
          requestId: r.entity_id,
          occurredAt: r.occurred_at,
          code: String(parsed["code"] ?? "budget_denied"),
          message: String(parsed["message"] ?? "Budget denied"),
          ownerTaskId: String(parsed["ownerTaskId"] ?? ""),
          purpose: String(parsed["purpose"] ?? ""),
        });
      }
    } catch {
      // ignore malformed
    }
  }
  return out;
}
