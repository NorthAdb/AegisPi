// Dispatch (06 section 3.2). The routing plan is identified by the event id
// plus a stable dispatch_key; the plan may be recomputed after any crash, and
// the UNIQUE(origin_event_id, dispatch_key) plus a pre-check inside the
// transaction make re-dispatch idempotent: one event + one plan = one task.
// The same transaction creates the delivery row, the same-scope thread
// subscription, flips inbox PENDING -> ROUTED, and writes audit + stream.

import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { escapeComponent } from "./keys.mjs";
import { crashpoint } from "./testing/crashpoints.mjs";

export class DispatchError extends Error {}

export function taskIdFor(inboxId, dispatchKey) {
  return `tsk:${escapeComponent(inboxId, { allowSlash: true })}:${escapeComponent(dispatchKey, { allowSlash: true })}`;
}

export function commandIdFor(inboxId, taskId) {
  return `cmd:${escapeComponent(inboxId, { allowSlash: true })}:${escapeComponent(taskId, { allowSlash: true })}`;
}

export function dispatchEventToTask(db, {
  inboxId,
  dispatchKey,
  now,
  routineId = null,
  priority,
  maxSteps,
  deadlineAt,
  skillSetHash,
}) {
  // The plan exists in memory at this point; a crash here (06 crash matrix,
  // "模型给出计划、派单事务前") only wastes the plan — the next run recomputes
  // it and the dispatch below stays single-row.
  crashpoint("router:pre-txn");
  return withTx(db, () => {
    const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(inboxId);
    if (!inbox) throw new DispatchError(`inbox ${inboxId} not found`);
    if (inbox.verdict !== "ADMIT") {
      throw new DispatchError(`inbox ${inboxId} verdict ${inbox.verdict} never dispatches a task`);
    }
    if (inbox.state === "DONE" || inbox.state === "DEAD") {
      throw new DispatchError(`inbox ${inboxId} is ${inbox.state}; dispatch refused`);
    }
    const existing = db
      .prepare("SELECT id FROM tasks WHERE origin_event_id=? AND dispatch_key=?")
      .get(inboxId, dispatchKey);
    if (existing) {
      return { taskId: existing.id, created: false, duplicatePlan: true };
    }
    const scope = db.prepare("SELECT epoch FROM scopes WHERE id=?").get(inbox.scope_id);
    const taskId = taskIdFor(inboxId, dispatchKey);
    db.prepare(
      `INSERT INTO tasks(
         id, scope_id, principal_id, origin_event_id, dispatch_key, routine_id,
         policy_version, scope_epoch, state, priority, available_at, deadline_at,
         attempt_no, fence, lease_owner, lease_expires_at, max_steps, step_count,
         result_class, result_object_id, skill_set_hash, created_at, updated_at)
       VALUES (?,?,?,?,?,? ,? ,?, 'QUEUED', ?, ?, ?,
               0, 0, NULL, NULL, ?, 0,
               NULL, NULL, ?, ?, ?)`,
    ).run(
      taskId,
      inbox.scope_id,
      inbox.principal_id,
      inboxId,
      dispatchKey,
      routineId,
      inbox.policy_version,
      scope.epoch,
      priority,
      now,
      deadlineAt,
      maxSteps,
      skillSetHash,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO event_deliveries(event_id, task_id, state, command_id, checkpoint_object_id, updated_at) VALUES (?,?, 'PENDING', ?, NULL, ?)",
    ).run(inboxId, taskId, commandIdFor(inboxId, taskId), now);
    db.prepare(
      "INSERT OR IGNORE INTO thread_subscriptions(scope_id, thread_key, task_id, active) VALUES (?,?,?,1)",
    ).run(inbox.scope_id, inbox.thread_key, taskId);
    db.prepare("UPDATE inbox SET state='ROUTED' WHERE id=? AND state='PENDING'").run(inboxId);
    writeAudit(db, {
      code: "task_dispatched",
      taskId,
      eventId: inboxId,
      details: { dispatch_key: dispatchKey, routine_id: routineId },
      now,
    });
    writeStreamEvent(db, {
      scopeId: inbox.scope_id,
      eventType: "task_changed",
      entityId: `task:${taskId}`,
      entityVersion: 1,
      payload: { state: "QUEUED", dispatch_key: dispatchKey },
      now,
    });
    crashpoint("router:inside-txn");
    return { taskId, created: true, duplicatePlan: false };
  });
}
