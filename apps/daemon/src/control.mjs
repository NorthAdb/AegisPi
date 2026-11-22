// Deterministic control bypass (Unit 5.2; spec 06 section 3.1, 01 section 2).
//
// /stop, /status, /pause and /resume never queue behind model inference:
// the host verifies the principal's grant on the scope, executes the
// command in its own transaction, and audits it. No bytes leave the
// machine and no model request is ever issued for these. Permission is
// checked from live acl_grants only — a nickname or message text claiming
// authority is worth nothing (CP1).

import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { cancelTask } from "./effects.mjs";
import { completeInboxIfDone } from "./scheduler.mjs";

export class ControlCommandRefused extends Error {}

const COMMANDS = new Map([
  ["stop", "/stop"],
  ["status", "/status"],
  ["pause", "/pause"],
  ["resume", "/resume"],
]);

/**
 * Classify an inbound text as a deterministic control command. Matches
 * `/stop`, `/stop@botname`, and a trailing-word form; anything else is a
 * normal event and belongs to the ordinary routing path.
 */
export function classifyControlCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const m = /^\/(stop|status|pause|resume)(?:@[A-Za-z0-9_]{1,64})?\s*$/i.exec(trimmed);
  if (!m) return null;
  return COMMANDS.get(m[1].toLowerCase());
}

function hasControlGrant(db, { scopeId, principalId, now }) {
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
 * Execute a control command. Each command runs through its own committed
 * transaction (cancelTask and friends own theirs — nested BEGIN would
 * fail), then ONE closing transaction marks the durable inbox row DONE
 * and writes the audit + stream trail. Re-running a control command is
 * idempotent: the live-target queries only ever see non-terminal work.
 */
export function handleDeterministicControl(db, {
  command, scopeId, threadKey, principalId, inboxId = null, now,
}) {
  // Accept both 'stop' and '/stop' (classifyControlCommand returns the
  // canonical slashed form; callers may pass the bare verb).
  const bare = String(command ?? "").replace(/^\//, "").toLowerCase();
  const canonical = COMMANDS.get(bare);
  if (!canonical) throw new ControlCommandRefused(`unknown control command '${command}'`);
  if (!hasControlGrant(db, { scopeId, principalId, now })) {
    writeAudit(db, {
      code: "control_command_refused",
      eventId: inboxId,
      actorId: principalId,
      details: { command: canonical, scope_id: scopeId, reason: "no live request/admin grant on the scope" },
      now,
    });
    throw new ControlCommandRefused(`principal has no live request/admin grant on ${scopeId}; control command refused`);
  }

  let outcome = {};
  if (bare === "stop") {
    // /stop cancels every non-terminal task this thread's work touched —
    // the tasks subscribed to the thread AND the tasks carrying deliveries
    // of this thread's events without a live subscription row (the
    // subscription table is an index, the durable delivery is the truth;
    // a deactivated or missing row must not shield running work). Other
    // threads in the scope are not touched.
    const targets = db
      .prepare(
        `SELECT DISTINCT t.id FROM tasks t
         WHERE t.scope_id=? AND t.state IN ('QUEUED','RETRY_WAIT','RUNNING','WAITING_APPROVAL','WAITING_EFFECT')
           AND (
             EXISTS (SELECT 1 FROM thread_subscriptions s
                     WHERE s.task_id=t.id AND s.scope_id=? AND s.thread_key=? AND s.active=1)
             OR EXISTS (SELECT 1 FROM event_deliveries d JOIN inbox i ON i.id=d.event_id
                         WHERE d.task_id=t.id AND i.scope_id=? AND i.thread_key=? AND d.state IN ('PENDING','ACKED'))
           )`,
      )
      .all(scopeId, scopeId, threadKey, scopeId, threadKey);
    const cancelled = [];
    for (const target of targets) {
      const res = cancelTask(db, { taskId: target.id, now, actorId: principalId });
      // Collapse the cancelled task's open deliveries in one transaction:
      // DEAD is terminal, completeInboxIfDone closes the inbox row, and
      // nothing lingers PENDING or ROUTED on cancelled work.
      const open = db
        .prepare("SELECT event_id FROM event_deliveries WHERE task_id=? AND state IN ('PENDING','ACKED')")
        .all(target.id);
      withTx(db, () => {
        for (const d of open) {
          db.prepare(
            "UPDATE event_deliveries SET state='DEAD', updated_at=? WHERE event_id=? AND task_id=? AND state IN ('PENDING','ACKED')",
          ).run(now, d.event_id, target.id);
          writeAudit(db, {
            code: "delivery_dead",
            taskId: target.id,
            eventId: d.event_id,
            details: { reason: "task cancelled by /stop" },
            now,
          });
          completeInboxIfDone(db, { eventId: d.event_id, now });
        }
      });
      cancelled.push({ taskId: target.id, epochAfter: res.epochAfter, cancelledEffects: res.cancelledEffects });
    }
    outcome = { command: "/stop", cancelledTasks: cancelled.map((c) => c.taskId), cancelled };
  } else if (bare === "status") {
    const running = db.prepare("SELECT count(*) c FROM tasks WHERE scope_id=? AND state='RUNNING'").get(scopeId).c;
    const queued = db.prepare("SELECT count(*) c FROM tasks WHERE scope_id=? AND state IN ('QUEUED','RETRY_WAIT')").get(scopeId).c;
    const waiting = db
      .prepare(
        `SELECT count(*) c FROM approvals a JOIN effects e ON e.id=a.effect_id
         WHERE e.scope_id=? AND a.state='WAITING'`,
      )
      .get(scopeId).c;
    const pending = db.prepare("SELECT count(*) c FROM inbox WHERE scope_id=? AND state='PENDING'").get(scopeId).c;
    const paused = db.prepare("SELECT paused FROM scopes WHERE id=?").get(scopeId)?.paused ?? 0;
    outcome = { command: "/status", running, queued, waitingApprovals: waiting, pendingInbox: pending, paused: paused === 1 };
  }

  withTx(db, () => {
    if (bare === "pause") {
      db.prepare("UPDATE scopes SET paused=1 WHERE id=? AND paused=0").run(scopeId);
      outcome = { command: "/pause", paused: true };
    } else if (bare === "resume") {
      db.prepare("UPDATE scopes SET paused=0 WHERE id=? AND paused=1").run(scopeId);
      outcome = { command: "/resume", paused: false };
    }
    if (inboxId !== null) {
      db.prepare("UPDATE inbox SET state='DONE' WHERE id=? AND state IN ('PENDING','ROUTED')").run(inboxId);
    }
    writeAudit(db, {
      code: "control_command_executed",
      eventId: inboxId,
      actorId: principalId,
      details: { scope_id: scopeId, thread_key: threadKey, ...outcome },
      now,
    });
    writeStreamEvent(db, {
      scopeId,
      eventType: "task_changed",
      entityId: `control:${canonical}`,
      entityVersion: 1,
      payload: { command: canonical, executed_by: principalId },
      now,
    });
  });
  return { command: canonical, ...outcome };
}
