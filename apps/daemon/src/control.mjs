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

function activeThreadTaskIds(db, { scopeId, threadKey }) {
  return db
    .prepare(
      `SELECT t.id, t.state FROM thread_subscriptions s JOIN tasks t ON t.id=s.task_id
       WHERE s.scope_id=? AND s.thread_key=? AND s.active=1 AND t.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','DEAD')`,
    )
    .all(scopeId, threadKey)
    .map((r) => r.id);
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
    const targets = activeThreadTaskIds(db, { scopeId, threadKey });
    const cancelled = [];
    for (const taskId of targets) {
      const res = cancelTask(db, { taskId, now, actorId: principalId });
      cancelled.push({ taskId, epochAfter: res.epochAfter, cancelledEffects: res.cancelledEffects });
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
