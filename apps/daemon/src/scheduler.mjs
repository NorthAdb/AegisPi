// Task/attempt scheduling, fencing and leases per 06 section 4.
//
// The claim runs inside BEGIN IMMEDIATE and checks scope unpaused, epoch
// consistency, deadline, per-scope concurrency and remaining steps; then
// attempt_no and fence each increment by one and the ACTIVE attempt with its
// lease is created — all in that single transaction. Every later write from
// the worker (heartbeat, step, result) repeats the same identity check:
// task_id + attempt_no + lease_owner + fence + unexpired lease + RUNNING
// state, executed as a conditional UPDATE whose row count must be exactly 1.
// An expired lease means the old worker's writes are dead on arrival; the
// reaper marks the attempt LOST and the task re-queues (or dies at retry
// exhaustion). fence is minted by the DB, never chosen by the worker.

import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { assertLiveReservation, BudgetError } from "./budget.mjs";
import { crashpoint } from "./testing/crashpoints.mjs";

export class ClaimRefused extends Error {}
export class StaleWorker extends Error {}
export class DeliveryError extends Error {}

const TASK_STATES = new Set([
  "QUEUED", "RUNNING", "WAITING_APPROVAL", "WAITING_EFFECT",
  "RETRY_WAIT", "SUCCEEDED", "FAILED", "CANCELLED", "DEAD",
]);

const RESULT_CLASSES = new Set([
  "affected", "unaffected", "unknown", "infra_error", "not_applicable",
]);

export function claimNextTask(db, {
  now,
  leaseMs,
  maxConcurrentPerScope = 1,
}) {
  return withTx(db, () => {
    const candidates = db
      .prepare(
        `SELECT t.*, s.paused AS scope_paused, s.epoch AS scope_epoch_now,
           (SELECT count(*) FROM tasks t2 WHERE t2.scope_id=t.scope_id AND t2.state='RUNNING') AS running_in_scope
         FROM tasks t JOIN scopes s ON s.id=t.scope_id
         WHERE t.state IN ('QUEUED','RETRY_WAIT')
         ORDER BY t.priority DESC, t.available_at ASC, t.created_at ASC`,
      )
      .all();
    for (const t of candidates) {
      if (t.available_at > now) continue;
      if (t.scope_paused) continue;
      if (t.scope_epoch_now !== t.scope_epoch) continue; // Stale epoch: cancelled fence.
      if (t.deadline_at <= now) {
        markTask(db, t, "DEAD", now, { code: "task_deadline_passed" });
        continue;
      }
      if (t.step_count >= t.max_steps) {
        markTask(db, t, "DEAD", now, { code: "task_steps_exhausted" });
        continue;
      }
      if (t.running_in_scope >= maxConcurrentPerScope) continue;
      const attemptNo = t.attempt_no + 1;
      const fence = t.fence + 1;
      const attemptId = `att:${t.id}:${attemptNo}`;
      db.prepare(
        `INSERT INTO attempts(id, task_id, attempt_no, fence, state, session_id, checkpoint_object_id, started_at, ended_at, error_code)
         VALUES (?,?,?,?, 'ACTIVE', NULL, NULL, ?, NULL, NULL)`,
      ).run(attemptId, t.id, attemptNo, fence, now);
      // The lease owner is a fresh ephemeral worker identity; the worker must
      // present it together with the fence on every later write.
      const leaseOwner = `wkr:${process.pid}:${now}`;
      const changed = db
        .prepare(
          `UPDATE tasks SET state='RUNNING', attempt_no=?, fence=?, lease_owner=?, lease_expires_at=?, updated_at=?
           WHERE id=? AND state IN ('QUEUED','RETRY_WAIT') AND attempt_no=? AND fence=?`,
        )
        .run(attemptNo, fence, leaseOwner, now + leaseMs, now, t.id, t.attempt_no, t.fence).changes;
      if (changed !== 1) {
        throw new ClaimRefused(
          `claim race inside the transaction: task ${t.id} moved between read and conditional update`,
        );
      }
      writeAudit(db, {
        code: "task_claimed",
        taskId: t.id,
        details: { attempt_no: attemptNo, fence, lease_owner: leaseOwner, lease_expires_at: now + leaseMs },
        now,
      });
      writeStreamEvent(db, {
        scopeId: t.scope_id,
        eventType: "task_changed",
        entityId: `task:${t.id}`,
        entityVersion: 2,
        payload: { state: "RUNNING", attempt_no: attemptNo, fence },
        now,
      });
      return {
        taskId: t.id,
        attemptId,
        attemptNo,
        fence,
        leaseOwner,
        leaseExpiresAt: now + leaseMs,
      };
    }
    return null;
  });
}

function markTask(db, task, state, now, audit) {
  db.prepare("UPDATE tasks SET state=?, updated_at=? WHERE id=?").run(state, now, task.id);
  writeAudit(db, { code: audit.code, taskId: task.id, details: audit.details ?? {}, now });
}

function fencedTaskUpdate(db, { taskId, attemptNo, leaseOwner, fence, now }) {
  const row = db
    .prepare(
      `SELECT id, state, lease_expires_at FROM tasks
        WHERE id=? AND attempt_no=? AND lease_owner=? AND fence=? AND state='RUNNING'`,
    )
    .get(taskId, attemptNo, leaseOwner, fence);
  if (!row) {
    throw new StaleWorker(
      `fenced write rejected: task ${taskId} attempt ${attemptNo} fence ${fence} is not the current RUNNING lease holder`,
    );
  }
  if (row.lease_expires_at !== null && row.lease_expires_at <= now) {
    throw new StaleWorker(`fenced write rejected: lease for task ${taskId} expired at ${row.lease_expires_at}`);
  }
  const attempt = db
    .prepare("SELECT state FROM attempts WHERE task_id=? AND attempt_no=? AND fence=?")
    .get(taskId, attemptNo, fence);
  if (!attempt || attempt.state !== "ACTIVE") {
    throw new StaleWorker(`fenced write rejected: attempt ${taskId}#${attemptNo} is ${attempt?.state ?? "missing"}`);
  }
  return row;
}

export function heartbeat(db, { taskId, attemptNo, leaseOwner, fence, now, leaseMs }) {
  return withTx(db, () => {
    fencedTaskUpdate(db, { taskId, attemptNo, leaseOwner, fence, now });
    const changed = db
      .prepare(
        "UPDATE tasks SET lease_expires_at=?, updated_at=? WHERE id=? AND attempt_no=? AND lease_owner=? AND fence=? AND state='RUNNING'",
      )
      .run(now + leaseMs, now, taskId, attemptNo, leaseOwner, fence).changes;
    if (changed !== 1) throw new StaleWorker("heartbeat row count != 1");
    return { extendedTo: now + leaseMs };
  });
}

export function workerStep(db, { taskId, attemptNo, leaseOwner, fence, now, budgetReservationId }) {
  // Chargeable-path gate (06 section 8): a step runs only against a live
  // HELD reservation for this exact task and purpose=worker. No reservation,
  // no step — the budget interface cannot be bypassed by calling the worker.
  assertLiveReservation(db, { reservationId: budgetReservationId, taskId, purpose: "worker" });
  return withTx(db, () => {
    fencedTaskUpdate(db, { taskId, attemptNo, leaseOwner, fence, now });
    const row = db.prepare("SELECT step_count, max_steps FROM tasks WHERE id=?").get(taskId);
    if (row.step_count >= row.max_steps) {
      throw new ClaimRefused(`task ${taskId} has no steps left (step_count=${row.step_count})`);
    }
    const changed = db
      .prepare(
        "UPDATE tasks SET step_count=step_count+1, updated_at=? WHERE id=? AND attempt_no=? AND lease_owner=? AND fence=? AND state='RUNNING'",
      )
      .run(now, taskId, attemptNo, leaseOwner, fence).changes;
    if (changed !== 1) throw new StaleWorker("step row count != 1");
    return { stepCount: row.step_count + 1 };
  });
}

export function completeTask(db, {
  taskId,
  attemptNo,
  leaseOwner,
  fence,
  now,
  resultClass,
  resultObjectId = null,
  errorCode = null,
}) {
  return withTx(db, () =>
    completeTaskInTx(db, {
      taskId, attemptNo, leaseOwner, fence, now, resultClass, resultObjectId, errorCode,
    }),
  );
}

// Same lease/fence conditions and writes as completeTask, but inside the
// caller's open transaction — the composition point where a task conclusion,
// its result object, the notification effect and the outbox row must land
// together (06 section 7: "Task结论、result对象、通知effect和outbox行在同一
// 事务保存").
export function completeTaskInTx(db, {
  taskId,
  attemptNo,
  leaseOwner,
  fence,
  now,
  resultClass,
  resultObjectId = null,
  errorCode = null,
}) {
  if (!RESULT_CLASSES.has(resultClass)) {
    throw new Error(`result_class ${resultClass} is not in the 06 section 2.1 enum`);
  }
  fencedTaskUpdate(db, { taskId, attemptNo, leaseOwner, fence, now });
  const finalState = resultClass === "infra_error" ? "FAILED" : "SUCCEEDED";
  if (finalState === "SUCCEEDED" && !resultObjectId) {
    // "宿主检查证据及验收项" — a SUCCEEDED task must point at its evidence
    // object; success without evidence is not a state this host records.
    throw new Error("SUCCEEDED requires a result_object_id (evidence)");
  }
  const changed = db
    .prepare(
      `UPDATE tasks SET state=?, result_class=?, result_object_id=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=?
       WHERE id=? AND attempt_no=? AND lease_owner=? AND fence=? AND state='RUNNING'`,
    )
    .run(finalState, resultClass, resultObjectId, now, taskId, attemptNo, leaseOwner, fence).changes;
  if (changed !== 1) throw new StaleWorker("complete row count != 1");
  db.prepare(
    "UPDATE attempts SET state=?, ended_at=?, error_code=? WHERE task_id=? AND attempt_no=? AND fence=?",
  ).run(finalState === "SUCCEEDED" ? "SUCCEEDED" : "FAILED", now, errorCode, taskId, attemptNo, fence);
  writeAudit(db, {
    code: finalState === "SUCCEEDED" ? "task_succeeded" : "task_failed",
    taskId,
    details: { result_class: resultClass, attempt_no: attemptNo, fence, error_code: errorCode },
    now,
  });
  writeStreamEvent(db, {
    scopeId: db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(taskId).scope_id,
    eventType: "task_changed",
    entityId: `task:${taskId}`,
    entityVersion: 3,
    payload: { state: finalState, result_class: resultClass },
    now,
  });
  return { state: finalState };
}

export function retryTask(db, {
  taskId,
  attemptNo,
  leaseOwner,
  fence,
  now,
  backoffMs,
  errorCode = null,
}) {
  return withTx(db, () => {
    fencedTaskUpdate(db, { taskId, attemptNo, leaseOwner, fence, now });
    // "明确可重试且没有未对账动作" — a task with a live SUBMITTING/UNKNOWN
    // effect must reconcile first; retry is refused until then.
    const unreconciled = db
      .prepare("SELECT count(*) c FROM effects WHERE task_id=? AND state IN ('SUBMITTING','UNKNOWN')")
      .get(taskId).c;
    if (unreconciled > 0) {
      throw new ClaimRefused(`task ${taskId} has ${unreconciled} unreconciled effect(s); reconcile before retry`);
    }
    const changed = db
      .prepare(
        `UPDATE tasks SET state='RETRY_WAIT', available_at=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=?
         WHERE id=? AND attempt_no=? AND lease_owner=? AND fence=? AND state='RUNNING'`,
      )
      .run(now + backoffMs, now, taskId, attemptNo, leaseOwner, fence).changes;
    if (changed !== 1) throw new StaleWorker("retry row count != 1");
    db.prepare(
      "UPDATE attempts SET state='FAILED', ended_at=?, error_code=? WHERE task_id=? AND attempt_no=? AND fence=?",
    ).run(now, errorCode, taskId, attemptNo, fence);
    writeAudit(db, {
      code: "task_retry_wait",
      taskId,
      details: { attempt_no: attemptNo, fence, backoff_ms: backoffMs, error_code: errorCode },
      now,
    });
    return { state: "RETRY_WAIT", availableAt: now + backoffMs };
  });
}

// Lease reaper: an ACTIVE attempt whose lease expired is LOST; its task goes
// back to QUEUED (a new attempt mints a new fence) or DEAD when retries are
// exhausted. PARKED attempts hold no lease and are never reaped here (06
// section 4).
export function reapExpiredLeases(db, { now, maxAttempts }) {
  return withTx(db, () => {
    const rows = db
      .prepare(
        `SELECT t.id AS task_id, t.attempt_no, t.fence, t.scope_id
         FROM tasks t JOIN attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no
         WHERE t.state='RUNNING' AND a.state='ACTIVE'
           AND t.lease_expires_at IS NOT NULL AND t.lease_expires_at <= ?`,
      )
      .all(now);
    const reaped = [];
    for (const r of rows) {
      db.prepare(
        "UPDATE attempts SET state='LOST', ended_at=?, error_code='lease_expired' WHERE task_id=? AND attempt_no=? AND state='ACTIVE'",
      ).run(now, r.task_id, r.attempt_no);
      if (r.attempt_no >= maxAttempts) {
        db.prepare("UPDATE tasks SET state='DEAD', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?").run(now, r.task_id);
        writeAudit(db, {
          code: "task_dead_retries_exhausted",
          taskId: r.task_id,
          details: { attempt_no: r.attempt_no, cause: "lease_expired" },
          now,
        });
      } else {
        db.prepare(
          "UPDATE tasks SET state='QUEUED', available_at=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?",
        ).run(now, now, r.task_id);
        writeAudit(db, {
          code: "lease_reaped",
          taskId: r.task_id,
          details: { attempt_no: r.attempt_no, fence: r.fence, requeued: true },
          now,
        });
      }
      writeStreamEvent(db, {
        scopeId: r.scope_id,
        eventType: "task_changed",
        entityId: `task:${r.task_id}`,
        entityVersion: 4,
        payload: { reaped_attempt: r.attempt_no },
        now,
      });
      reaped.push({ taskId: r.task_id, attemptNo: r.attempt_no, finalState: r.attempt_no >= maxAttempts ? "DEAD" : "QUEUED" });
    }
    return reaped;
  });
}

// ---------------------------------------------------------------------------
// Deliveries (06 section 3.2). ACKED happens only after the host persisted
// the event into the session checkpoint (the checkpoint object id); the same
// command redelivered reads that checkpoint and never re-appends. DONE means
// the work consumed it.

export function deliveryAckCheckpoint(db, { eventId, taskId, checkpointObjectId, now }) {
  return withTx(db, () => {
    const row = db
      .prepare("SELECT state, checkpoint_object_id FROM event_deliveries WHERE event_id=? AND task_id=?")
      .get(eventId, taskId);
    if (!row) throw new DeliveryError(`delivery ${eventId}/${taskId} not found`);
    if (row.state === "PENDING") {
      db.prepare(
        "UPDATE event_deliveries SET state='ACKED', checkpoint_object_id=?, updated_at=? WHERE event_id=? AND task_id=? AND state='PENDING'",
      ).run(checkpointObjectId, now, eventId, taskId);
      return { state: "ACKED", checkpointObjectId, duplicate: false };
    }
    if (row.state === "ACKED") {
      if (row.checkpoint_object_id !== checkpointObjectId) {
        throw new DeliveryError(
          `delivery ${eventId}/${taskId} already ACKED with checkpoint ${row.checkpoint_object_id}; refusing a different checkpoint (would re-append)`,
        );
      }
      return { state: "ACKED", checkpointObjectId, duplicate: true };
    }
    if (row.state === "DONE" || row.state === "RETURNED" || row.state === "DEAD") {
      return { state: row.state, checkpointObjectId: row.checkpoint_object_id, duplicate: true };
    }
    throw new DeliveryError(`delivery ${eventId}/${taskId} in unknown state ${row.state}`);
  });
}

export function deliveryDone(db, { eventId, taskId, now }) {
  return withTx(db, () => {
    const changed = db
      .prepare(
        "UPDATE event_deliveries SET state='DONE', updated_at=? WHERE event_id=? AND task_id=? AND state='ACKED'",
      )
      .run(now, eventId, taskId).changes;
    if (changed !== 1) {
      throw new DeliveryError(`delivery ${eventId}/${taskId} is not ACKED`);
    }
    completeInboxIfDone(db, { eventId, now });
    return { state: "DONE" };
  });
}

export function deliveryReturned(db, { eventId, taskId, now, reason }) {
  return withTx(db, () => {
    const changed = db
      .prepare(
        "UPDATE event_deliveries SET state='RETURNED', updated_at=? WHERE event_id=? AND task_id=? AND state IN ('PENDING','ACKED')",
      )
      .run(now, eventId, taskId).changes;
    if (changed !== 1) throw new DeliveryError(`delivery ${eventId}/${taskId} cannot RETURN from its state`);
    writeAudit(db, {
      code: "delivery_returned",
      taskId,
      eventId,
      details: { reason },
      now,
    });
    completeInboxIfDone(db, { eventId, now });
    return { state: "RETURNED" };
  });
}

export function deliveryDead(db, { eventId, taskId, now, reason }) {
  return withTx(db, () => {
    const changed = db
      .prepare(
        "UPDATE event_deliveries SET state='DEAD', updated_at=? WHERE event_id=? AND task_id=? AND state IN ('PENDING','ACKED')",
      )
      .run(now, eventId, taskId).changes;
    if (changed !== 1) throw new DeliveryError(`delivery ${eventId}/${taskId} cannot go DEAD from its state`);
    // DEAD is visible and demands a human; never silently success.
    writeAudit(db, {
      code: "delivery_dead",
      taskId,
      eventId,
      details: { reason },
      now,
    });
    writeStreamEvent(db, {
      scopeId: db.prepare("SELECT scope_id FROM inbox WHERE id=?").get(eventId).scope_id,
      eventType: "audit_alert",
      entityId: `delivery:${eventId}:${taskId}`,
      entityVersion: 1,
      payload: { reason },
      now,
    });
    completeInboxIfDone(db, { eventId, now });
    return { state: "DEAD" };
  });
}

// inbox DONE gate (06 section 3.2): every delivery terminal AND no pending
// routing responsibility left.
export function completeInboxIfDone(db, { eventId, now }) {
  const inbox = db.prepare("SELECT state FROM inbox WHERE id=?").get(eventId);
  if (!inbox || inbox.state !== "ROUTED") return false;
  const open = db
    .prepare(
      "SELECT count(*) c FROM event_deliveries WHERE event_id=? AND state IN ('PENDING','ACKED')",
    )
    .get(eventId).c;
  if (open > 0) return false;
  db.prepare("UPDATE inbox SET state='DONE' WHERE id=? AND state='ROUTED'").run(eventId);
  writeAudit(db, { code: "inbox_done", eventId, details: {}, now });
  return true;
}
