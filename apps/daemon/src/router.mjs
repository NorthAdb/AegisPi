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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class DispatchError extends Error {}

// Structured payloads never merge: a repo_triage / repo_observe event is a
// self-contained work item whose exact bytes are the task's input, so a
// second structured payload (or any follow-up) riding the same task would
// concatenate two JSON documents into one model input. They always get
// their OWN task.
const STRUCTURED_PAYLOAD_KINDS = new Set(["repo_triage", "repo_observe"]);

function payloadProfile(db, stateDir, payloadObjectId) {
  if (typeof stateDir !== "string" || typeof payloadObjectId !== "string") {
    return { bytes: null, kind: null };
  }
  const obj = db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(payloadObjectId);
  if (!obj?.storage_ref) return { bytes: null, kind: null };
  const path = join(stateDir, ...obj.storage_ref.split("/"));
  if (!existsSync(path)) return { bytes: null, kind: null };
  let kind = null;
  let bytes = null;
  try {
    const text = readFileSync(path, "utf8");
    bytes = Buffer.byteLength(text, "utf8");
    try {
      kind = JSON.parse(text)?.kind ?? null;
    } catch {}
  } catch {}
  return { bytes, kind };
}

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

// ---------------------------------------------------------------------------
// Unit 5.2: per-domain single-flight fair routing (01 section 2, audit
// matrix F14). Waiting events gain priority with age, a scope's pending
// events merge into ONE bounded batch (max 8) anchored on the
// highest-effective-priority event, and a thread's live task may receive
// a follow-up event ONLY when it cannot widen permissions.

/** effectivePriority = base + floor(waitMs / agingStepMs) (01 section 2). */
export function effectivePriorityOf({ priority, receivedAt, now, agingStepMs = null }) {
  if (!Number.isInteger(agingStepMs) || agingStepMs <= 0) return priority;
  const waitMs = Math.max(0, now - receivedAt);
  return priority + Math.floor(waitMs / agingStepMs);
}

function hasRequestGrant(db, { scopeId, principalId, now }) {
  const row = db
    .prepare(
      `SELECT count(*) c FROM acl_grants
       WHERE scope_id=? AND principal_id=? AND permission IN ('request','admin')
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,
    )
    .get(scopeId, principalId, now);
  return row.c > 0;
}

/**
 * The bounded same-scope batch: PENDING ADMIT rows ordered by
 * effectivePriority (aging applied), capped at maxBatchEvents.
 */
export function claimScopeInboxBatch(db, { scopeId, now, agingStepMs = null, maxBatchEvents = 8 }) {
  const rows = db
    .prepare("SELECT * FROM inbox WHERE scope_id=? AND state='PENDING' AND verdict='ADMIT'")
    .all(scopeId);
  const scored = rows
    .map((row) => ({
      row,
      effectivePriority: effectivePriorityOf({ priority: row.priority, receivedAt: row.received_at, now, agingStepMs }),
    }))
    .sort((a, b) => b.effectivePriority - a.effectivePriority || a.row.received_at - b.row.received_at || (a.row.id < b.row.id ? -1 : 1));
  return scored.slice(0, Math.max(1, maxBatchEvents)).map((s) => ({ ...s.row, effective_priority: s.effectivePriority }));
}

/**
 * Attach one more event to an already-dispatched task (idempotent by PK).
 *
 * Unit 5.2 rework: EVERY attach — batch merge or thread direct-delivery —
 * passes the same checks the anchor's dispatch implies:
 *   - the inbox row is ADMIT and not terminal;
 *   - the sender holds a LIVE request grant on the scope;
 *   - the event payload's required-scope closure never exceeds the task's
 *     own scope (tighten-only);
 *   - the task is actively subscribed to the event's thread;
 *   - the task is not WAITING_APPROVAL and has not already started
 *     consuming (a RUNNING task with consumed deliveries or stepped work
 *     gets a NEW task, not a mid-flight widening);
 *   - the merged model input stays under the byte cap, and structured
 *     (repo_triage / repo_observe) payloads never merge at all.
 * A policy refusal returns { attached: false, reason } so the caller can
 * route the event to its own task instead of losing it.
 */
export function attachEventToTask(db, { inboxId, taskId, now, batchReason, stateDir = null, inputByteCap = null }) {
  return withTx(db, () => {
    const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(inboxId);
    if (!inbox) throw new DispatchError(`inbox ${inboxId} not found`);
    if (inbox.state === "DONE" || inbox.state === "DEAD") {
      throw new DispatchError(`inbox ${inboxId} is ${inbox.state}; attach refused`);
    }
    if (inbox.verdict !== "ADMIT") {
      throw new DispatchError(`inbox ${inboxId} verdict ${inbox.verdict} never attaches to a task`);
    }
    const existing = db
      .prepare("SELECT state FROM event_deliveries WHERE event_id=? AND task_id=?")
      .get(inboxId, taskId);
    if (existing) {
      db.prepare("UPDATE inbox SET state='ROUTED' WHERE id=? AND state='PENDING'").run(inboxId);
      return { attached: true, duplicate: true, taskId };
    }
    // The task itself: terminal, parked-for-approval or already-consuming
    // tasks never absorb a follow-up.
    const task = db.prepare("SELECT state, step_count, scope_id FROM tasks WHERE id=?").get(taskId);
    if (!task) throw new DispatchError(`task ${taskId} not found`);
    if (["SUCCEEDED", "FAILED", "CANCELLED", "DEAD"].includes(task.state)) {
      return { attached: false, taskId, reason: `task is ${task.state}; a new task takes the event` };
    }
    if (task.state === "WAITING_APPROVAL") {
      return { attached: false, taskId, reason: "task is WAITING_APPROVAL; a new task takes the event" };
    }
    if (task.state === "RUNNING") {
      const consumed = db
        .prepare("SELECT count(*) c FROM event_deliveries WHERE task_id=? AND state IN ('DONE','RETURNED','DEAD')")
        .get(taskId).c;
      if (task.step_count > 0 || consumed > 0) {
        return { attached: false, taskId, reason: "task already started consuming; a new task takes the event" };
      }
    }
    // The sender needs a live request grant — same rule the thread
    // direct-delivery applies to the anchor's sender.
    if (!hasRequestGrant(db, { scopeId: inbox.scope_id, principalId: inbox.principal_id, now })) {
      return { attached: false, taskId, reason: "sender lacks a live request grant; a new task takes the event" };
    }
    // Tighten-only: the event's payload closure may never demand scopes
    // beyond the task's own.
    const extraScopes = db
      .prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=? AND scope_id != ?")
      .all(inbox.payload_object_id, inbox.scope_id);
    if (extraScopes.length > 0) {
      return { attached: false, taskId, reason: "event payload requires scopes beyond the thread; a new task takes the event" };
    }
    // The task must be subscribed to THIS event's thread.
    const subscribed = db
      .prepare("SELECT 1 FROM thread_subscriptions WHERE task_id=? AND scope_id=? AND thread_key=? AND active=1")
      .get(taskId, inbox.scope_id, inbox.thread_key);
    if (!subscribed) {
      return { attached: false, taskId, reason: "task is not subscribed to the event's thread; a new task takes the event" };
    }
    // Structured payloads never merge, onto or from.
    if (stateDir !== null) {
      const incoming = payloadProfile(db, stateDir, inbox.payload_object_id);
      if (STRUCTURED_PAYLOAD_KINDS.has(incoming.kind)) {
        return { attached: false, taskId, reason: `structured payload (${incoming.kind}) never merges; a new task takes the event` };
      }
      if (Number.isInteger(inputByteCap) && inputByteCap > 0) {
        const pending = db
          .prepare("SELECT i.payload_object_id FROM event_deliveries d JOIN inbox i ON i.id=d.event_id WHERE d.task_id=? AND d.state='PENDING'")
          .all(taskId);
        let total = incoming.bytes ?? 0;
        for (const p of pending) {
          const profile = payloadProfile(db, stateDir, p.payload_object_id);
          if (profile.bytes === null) {
            return { attached: false, taskId, reason: "an existing pending payload is unreadable; refusing the merge rather than guessing the input bound" };
          }
          if (STRUCTURED_PAYLOAD_KINDS.has(profile.kind)) {
            return { attached: false, taskId, reason: "the task already holds a structured payload; a new task takes the event" };
          }
          total += profile.bytes;
        }
        if ((incoming.bytes ?? null) === null) {
          return { attached: false, taskId, reason: "the incoming payload is unreadable; refusing the merge rather than guessing the input bound" };
        }
        if (total > inputByteCap) {
          return { attached: false, taskId, reason: `merged input would exceed the ${inputByteCap}-byte cap; a new task takes the event` };
        }
      } else {
        // No cap configured still demands readable payloads for the
        // structured rule above; bytes stay unchecked only when the
        // caller runs the legacy direct API shape (stateDir supplied,
        // cap null is a caller's explicit choice).
      }
    }
    db.prepare(
      "INSERT INTO event_deliveries(event_id, task_id, state, command_id, checkpoint_object_id, updated_at) VALUES (?,?, 'PENDING', ?, NULL, ?)",
    ).run(inboxId, taskId, commandIdFor(inboxId, taskId), now);
    db.prepare(
      "INSERT OR IGNORE INTO thread_subscriptions(scope_id, thread_key, task_id, active) VALUES (?,?,?,1)",
    ).run(inbox.scope_id, inbox.thread_key, taskId);
    db.prepare("UPDATE inbox SET state='ROUTED' WHERE id=? AND state='PENDING'").run(inboxId);
    writeAudit(db, {
      code: "event_attached_to_task",
      taskId,
      eventId: inboxId,
      details: { batch_reason: batchReason ?? "same-scope batch merge", thread_key: inbox.thread_key },
      now,
    });
    return { attached: true, duplicate: false, taskId };
  });
}

/**
 * Thread direct-delivery with the tighten-only rule (01 section 2): a new
 * event may join a live thread task only when the sender holds a live
 * request grant, the task is non-terminal, the scope epoch matches, and
 * the event's payload closure never exceeds the task's own scope. Any
 * widening demand — a cross-scope payload, a stale epoch, an unknown
 * sender, a started or approval-parked task, a structured payload — means
 * a NEW task, not a widened old one.
 */
export function directDeliverToThreadTask(db, { inboxId, now, stateDir = null, inputByteCap = null }) {
  const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(inboxId);
  if (!inbox) return { directDelivered: false, reason: "inbox row missing" };
  const scope = db.prepare("SELECT id, epoch FROM scopes WHERE id=?").get(inbox.scope_id);
  if (!scope) return { directDelivered: false, reason: "scope missing" };
  const candidates = db
    .prepare(
      `SELECT t.id, t.state, t.scope_epoch FROM thread_subscriptions s JOIN tasks t ON t.id=s.task_id
       WHERE s.scope_id=? AND s.thread_key=? AND s.active=1
         AND t.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','DEAD')`,
    )
    .all(inbox.scope_id, inbox.thread_key);
  if (candidates.length === 0) return { directDelivered: false, reason: "no live thread task" };
  if (!hasRequestGrant(db, { scopeId: inbox.scope_id, principalId: inbox.principal_id, now })) {
    return { directDelivered: false, reason: "sender lacks a live request grant; new task instead" };
  }
  const extraScopes = db
    .prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=? AND scope_id != ?")
    .all(inbox.payload_object_id, inbox.scope_id);
  if (extraScopes.length > 0) {
    return { directDelivered: false, reason: "event payload requires scopes beyond the thread; new task instead" };
  }
  const refusalReasons = [];
  for (const candidate of candidates) {
    if (candidate.scope_epoch !== scope.epoch) continue;
    const attached = attachEventToTask(db, {
      inboxId, taskId: candidate.id, now, batchReason: "thread direct-delivery (tighten-only)",
      stateDir, inputByteCap,
    });
    if (attached.attached) return { directDelivered: true, taskId: candidate.id, duplicate: attached.duplicate };
    if (attached.reason) refusalReasons.push(attached.reason);
  }
  return {
    directDelivered: false,
    reason: refusalReasons.length > 0 ? `no attachable live thread task (${refusalReasons[0]})` : "no live thread task at the current scope epoch",
  };
}

/**
 * Route one inbox event: direct-delivery into a live thread task when the
 * tighten-only checks pass, otherwise a fresh dispatch through the
 * ordinary (idempotent) plan path.
 */
export function routeInboxEvent(db, {
  inboxId, dispatchKey, now, routineId = null, priority, maxSteps, deadlineAt, skillSetHash,
  stateDir = null, inputByteCap = null,
}) {
  const direct = directDeliverToThreadTask(db, { inboxId, now, stateDir, inputByteCap });
  if (direct.directDelivered) {
    return { taskId: direct.taskId, created: false, directDelivered: true };
  }
  const dispatched = dispatchEventToTask(db, { inboxId, dispatchKey, now, routineId, priority, maxSteps, deadlineAt, skillSetHash });
  return { ...dispatched, directDelivered: false, directReason: direct.reason };
}

/**
 * The Router batch pass for one scope: the anchor event becomes the task,
 * the rest of the bounded batch attaches to it — and EVERY member of the
 * batch passes the same grant / closure / thread / task-state / byte-cap /
 * structured-payload checks the anchor's dispatch implies (the
 * tighten-only rule is not an anchor-only rule). Events the attach
 * refuses stay PENDING in the inbox and form their own task on the next
 * pass. Returns an honest summary.
 */
export function dispatchEventBatchToTask(db, {
  scopeId, now, agingStepMs = null, maxBatchEvents = 8, routineId = null,
  maxSteps, deadlineAt, skillSetHash, dispatchKeyFor,
  stateDir = null, inputByteCap = null,
}) {
  const batch = claimScopeInboxBatch(db, { scopeId, now, agingStepMs, maxBatchEvents });
  if (batch.length === 0) return { dispatched: 0, attached: 0, taskId: null };
  const anchor = batch[0];
  const routed = routeInboxEvent(db, {
    inboxId: anchor.id,
    dispatchKey: dispatchKeyFor(anchor),
    now,
    routineId,
    priority: anchor.priority,
    maxSteps,
    deadlineAt,
    skillSetHash,
    stateDir,
    inputByteCap,
  });
  let attached = 0;
  const refused = [];
  for (const row of batch.slice(1)) {
    const res = attachEventToTask(db, {
      inboxId: row.id, taskId: routed.taskId, now, batchReason: "same-scope batch merge",
      stateDir, inputByteCap,
    });
    if (res.attached) attached += 1;
    else if (res.reason) refused.push(`${row.id}: ${res.reason}`);
  }
  return {
    dispatched: batch.length,
    attached,
    refused,
    taskId: routed.taskId,
    anchorInboxId: anchor.id,
    effectivePriority: anchor.effective_priority,
  };
}
