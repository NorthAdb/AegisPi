// Timers per 06 section 7. A timer freezes scope, principal, epoch, condition,
// timezone and a payload reference at creation. The due scan runs each timer
// inside one transaction: the condition is re-checked against the LATEST
// committed events — satisfied means SATISFIED and nothing is sent; otherwise
// the timer generates one unique inbox event (source 'timer', event id
// <timer_id>:<occurrence_no>), increments the occurrence, and a one-shot
// goes FIRED while a periodic timer stays SCHEDULED with an advanced due_at.
// Missed periods are merged into ONE catch-up fire with missed_count recorded
// — boot never chases an unbounded backlog. A reply racing a due scan is
// decided by the same database transaction order: whichever commits first
// wins, and a follow-up reminder that went READY is re-checked before
// submission and cancelled as stale when its condition is already satisfied.
//
// Unit 5.4 adds two condition/recurrence shapes:
//   condition {type:"contact_no_reply", threadKey, expectedSender, sinceMs}
//     — satisfied only by a REAL envelope reply on that thread (bot receipts,
//       the owner's own messages and bounce/system notices never count);
//   recurrence {type:"daily_wall_clock", timeOfDay, timezone}
//     — IANA wall-clock schedule (Asia/Hong_Kong and DST zones alike),
//       missed beats merged into one catch-up with an honest missed_count.

import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { escapeComponent } from "./keys.mjs";
import { crashpoint } from "./testing/crashpoints.mjs";
import { countOccurrencesBetween, nextWallClockOccurrence } from "./quiet-time.mjs";
import { readObjectContent } from "./objects.mjs";

export class TimerError extends Error {}

export function timerIdFor(naturalName) {
  return `tmr:${escapeComponent(naturalName)}`;
}

export function createTimer(db, {
  id,
  scopeId,
  principalId,
  scopeEpoch,
  threadKey,
  condition,
  dueAt,
  recurrence = null,
  payloadObjectId,
  now,
}) {
  const conditionJson = JSON.stringify(condition ?? { type: "none" });
  return withTx(db, () => {
    db.prepare(
      `INSERT INTO timers(id, scope_id, principal_id, scope_epoch, thread_key, condition_json,
        due_at, recurrence_json, occurrence_no, state, payload_object_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,0, 'SCHEDULED', ?, ?)`,
    ).run(id, scopeId, principalId, scopeEpoch, threadKey, conditionJson, dueAt, recurrence ? JSON.stringify(recurrence) : null, payloadObjectId, now);
    writeAudit(db, {
      code: "timer_created",
      details: { timer_id: id, due_at: dueAt, recurrence: recurrence, condition: condition ?? { type: "none" } },
      now,
    });
    return { id, state: "SCHEDULED", occurrenceNo: 0 };
  });
}

// Well-known automated mailer identities: a bounce or an auto-reply from one
// of these is never a human reply, no matter what the display name says.
const SYSTEM_NOTIFIER_RE = /^(?:mailer-daemon|postmaster|noreply|no-reply|donotreply|do-not-reply|auto-reply|autoreply|notifications?|bounces?|daemon)@/i;

export function isSystemNotifierAddress(address) {
  const a = String(address ?? "").trim().toLowerCase();
  return a.length > 0 && SYSTEM_NOTIFIER_RE.test(a);
}

// The frozen condition, evaluated against the LATEST committed state.
// Phase 2 predicates (host-supplied, never model-supplied):
//   {type:"event_seen", source, source_event_id}  - that inbox row exists
//   {type:"none"}                                  - never satisfied
// Unit 5.4 predicate (host-supplied; 03 section 4):
//   {type:"contact_no_reply", threadKey, expectedSender, sinceMs} — SATISFIED
//   only by a REAL reply from the expected contact on that thread since the
//   window opened: bot receipts (sourceActor=bot), the owner's own messages
//   (condition.ownerAddresses) and bounce/system notices
//   (payload.systemNotification or a well-known mailer identity) never count.
//   The display name is NEVER identity — the envelope address is compared.
//   An unreadable payload is skipped (conservative: an unread record never
//   cancels a reminder); this condition without a payload reader at all is a
//   hard error, never a silent "not satisfied".
export function evaluateCondition(db, condition, { now, timer = null, stateDir = null }) {
  if (!condition || condition.type === "none") {
    return { satisfied: false, evidence: null };
  }
  if (condition.type === "event_seen") {
    const row = db
      .prepare("SELECT id, received_at FROM inbox WHERE source=? AND source_event_id=?")
      .get(condition.source, condition.source_event_id);
    if (row) {
      return { satisfied: true, evidence: row.id };
    }
    return { satisfied: false, evidence: null };
  }
  if (condition.type === "contact_no_reply") {
    if (typeof stateDir !== "string" || stateDir.length === 0) {
      throw new TimerError("contact_no_reply evaluation requires the state dir to read thread payloads (fail closed)");
    }
    const since = Number.isFinite(condition.sinceAt)
      ? condition.sinceAt
      : (timer ? Number(timer.created_at ?? 0) + Number(condition.sinceMs ?? 0) : Number(condition.sinceMs ?? 0));
    const expected = condition.expectedSender
      ? String(condition.expectedSender).trim().toLowerCase()
      : null;
    const owners = new Set(
      (Array.isArray(condition.ownerAddresses) ? condition.ownerAddresses : [])
        .map((a) => String(a).trim().toLowerCase())
        .filter((a) => a.length > 0),
    );
    const rows = db
      .prepare(
        `SELECT id, payload_object_id, received_at FROM inbox
          WHERE thread_key=? AND received_at>=? AND state IN ('PENDING','ROUTED','DONE')
          ORDER BY received_at ASC LIMIT 500`,
      )
      .all(String(condition.threadKey ?? ""), since);
    for (const row of rows) {
      const text = readObjectContent(db, stateDir, row.payload_object_id);
      if (typeof text !== "string") continue;
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        continue;
      }
      if (payload?.kind !== "mail" && payload?.kind !== "im") continue;
      if (payload.sourceActor === "bot") continue;
      if (payload.systemNotification === true) continue;
      if (isSystemNotifierAddress(payload.envelopeFrom)) continue;
      const address = String(payload.envelopeFrom ?? "").trim().toLowerCase();
      if (address.length === 0) continue;
      if (owners.has(address)) continue;
      if (expected !== null && address !== expected) continue;
      return { satisfied: true, evidence: row.id };
    }
    return { satisfied: false, evidence: null };
  }
  throw new TimerError(`condition type ${condition.type} has no Phase 2 evaluator`);
}

export function timerRow(db, timerId) {
  return db.prepare("SELECT * FROM timers WHERE id=?").get(timerId);
}

export function processDueTimers(db, { now, stateDir = null }) {
  const due = db
    .prepare("SELECT * FROM timers WHERE state='SCHEDULED' AND due_at<=? ORDER BY due_at ASC")
    .all(now);
  const fired = [];
  const satisfied = [];
  const skipped = [];
  const refused = [];
  for (const t of due) {
    crashpoint("timers:before-fire-txn");
    let outcome;
    try {
      outcome = withTx(db, () => {
        // Re-read inside the transaction: a concurrent SATISFIED or a prior
        // crash changes what "due" means.
        const fresh = db.prepare("SELECT * FROM timers WHERE id=?").get(t.id);
        if (!fresh || fresh.state !== "SCHEDULED" || fresh.due_at > now) {
          return { kind: "skipped", timer: fresh };
        }
        const cond = JSON.parse(fresh.condition_json);
        const check = evaluateCondition(db, cond, { now, timer: fresh, stateDir });
        if (check.satisfied) {
          db.prepare("UPDATE timers SET state='SATISFIED' WHERE id=? AND state='SCHEDULED'").run(t.id);
          writeAudit(db, {
            code: "timer_satisfied",
            details: { timer_id: t.id, evidence: check.evidence },
            now,
          });
          writeStreamEvent(db, {
            scopeId: fresh.scope_id,
            eventType: "timer_changed",
            entityId: `timer:${t.id}`,
            entityVersion: 2,
            payload: { state: "SATISFIED", evidence: check.evidence },
            now,
          });
          return { kind: "satisfied", timer: fresh, evidence: check.evidence };
        }
        const occurrence = fresh.occurrence_no + 1;
        const eventId = `${t.id}:${occurrence}`;
        // Missed periods merge into ONE catch-up fire with missed_count
        // recorded (06 section 7); the next due time starts a fresh period.
        let missedCount = 0;
        let nextDue = null;
        let oneShot = true;
        if (fresh.recurrence_json) {
          const rec = JSON.parse(fresh.recurrence_json);
          oneShot = false;
          if (rec.type === "daily_wall_clock") {
            // Wall-clock schedule (Unit 5.4): anchored to the zone's local
            // hh:mm, DST-safe. Beats strictly after due_at and no later than
            // now were missed and merge into THIS single catch-up fire.
            const beatsAfterDue = countOccurrencesBetween(fresh.due_at, now, {
              timeOfDay: rec.timeOfDay,
              timeZone: rec.timezone,
            });
            missedCount = Math.max(0, beatsAfterDue - 1);
            nextDue = nextWallClockOccurrence(now, { timeOfDay: rec.timeOfDay, timeZone: rec.timezone });
          } else {
            const every = rec.everyMs;
            const periodsLapsed = Math.floor((now - fresh.due_at) / every);
            missedCount = periodsLapsed > 0 ? periodsLapsed - 1 : 0;
            nextDue = now + every;
          }
        }
        // UNIQUE(source, source_event_id) is the crash fence: a re-run after a
        // mid-transaction kill finds the row already committed or not at all.
        const exists = db
          .prepare("SELECT id FROM inbox WHERE source='timer' AND source_event_id=?")
          .get(eventId);
        if (!exists) {
          db.prepare(
            `INSERT INTO inbox(id, source, source_event_id, principal_id, scope_id, payload_object_id,
              thread_key, priority, policy_version, verdict, state, received_at)
             VALUES (?, 'timer', ?, ?, ?, ?, ?, 5, (SELECT policy_version FROM scopes WHERE id=?), 'ADMIT', 'PENDING', ?)`,
          ).run(
            `inb:timer:${escapeComponent(eventId, { allowSlash: true })}`,
            eventId,
            fresh.principal_id,
            fresh.scope_id,
            fresh.payload_object_id,
            fresh.thread_key,
            fresh.scope_id,
            now,
          );
        }
        if (oneShot) {
          db.prepare("UPDATE timers SET state='FIRED', occurrence_no=? WHERE id=? AND state='SCHEDULED'")
            .run(occurrence, t.id);
        } else {
          db.prepare(
            "UPDATE timers SET occurrence_no=?, due_at=? WHERE id=? AND state='SCHEDULED'",
          ).run(occurrence, nextDue, t.id);
        }
        writeAudit(db, {
          code: "timer_fired",
          details: { timer_id: t.id, occurrence_no: occurrence, event_id: eventId, missed_count: missedCount, next_due_at: nextDue },
          now,
        });
        writeStreamEvent(db, {
          scopeId: fresh.scope_id,
          eventType: "timer_changed",
          entityId: `timer:${t.id}`,
          entityVersion: 2,
          payload: { state: oneShot ? "FIRED" : "SCHEDULED", occurrence_no: occurrence, missed_count: missedCount },
          now,
        });
        crashpoint("timers:inside-fire-txn");
        return { kind: "fired", timer: fresh, occurrence, eventId, missedCount, nextDue, oneShot };
      });
    } catch (e) {
      // One unreadable condition must not wedge the whole scan: the refusal
      // is audited and visible, the timer stays SCHEDULED for the next tick.
      refused.push({ timerId: t.id, error: String(e.message).slice(0, 160) });
      try {
        withTx(db, () => {
          writeAudit(db, {
            code: "timer_condition_refused",
            details: { timer_id: t.id, error: String(e.message).slice(0, 200) },
            now,
          });
        });
      } catch {}
      continue;
    }
    crashpoint("timers:after-fire-commit");
    if (outcome.kind === "fired") fired.push(outcome);
    else if (outcome.kind === "satisfied") satisfied.push(outcome);
    else skipped.push(outcome);
  }
  return { fired, satisfied, skipped, refused };
}

// The reply path: a satisfying event arrived, so the follow-up timer is
// SATISFIED — first committer wins, the loser is a no-op.
export function markTimerSatisfied(db, { timerId, evidenceEventId, now, stateDir = null }) {
  return withTx(db, () => {
    const fresh = db.prepare("SELECT * FROM timers WHERE id=?").get(timerId);
    if (!fresh) throw new TimerError(`timer ${timerId} not found`);
    if (fresh.state === "SATISFIED") return { changed: false, state: "SATISFIED" };
    if (fresh.state !== "SCHEDULED") return { changed: false, state: fresh.state };
    const cond = JSON.parse(fresh.condition_json);
    const check = evaluateCondition(db, cond, { now, timer: fresh, stateDir });
    if (!check.satisfied) {
      return { changed: false, state: fresh.state, reason: "condition not satisfied by committed state" };
    }
    db.prepare("UPDATE timers SET state='SATISFIED' WHERE id=? AND state='SCHEDULED'").run(timerId);
    writeAudit(db, {
      code: "timer_satisfied",
      details: { timer_id: timerId, evidence: evidenceEventId ?? check.evidence, path: "reply" },
      now,
    });
    writeStreamEvent(db, {
      scopeId: fresh.scope_id,
      eventType: "timer_changed",
      entityId: `timer:${timerId}`,
      entityVersion: 2,
      payload: { state: "SATISFIED", path: "reply" },
      now,
    });
    return { changed: true, state: "SATISFIED" };
  });
}

// "即使触发先赢，消息提交前还要重验跟进条件，撤销已过时READY提醒" — the
// recheck that cancels a READY follow-up reminder whose condition became
// satisfied between the fire and the submission. Follow-up outbox rows carry
// notify_reason `followup:<timerId>`, which is what this sweep keys on.
export function cancelSatisfiedFollowUpReminders(db, { now, stateDir = null }) {
  const rows = db
    .prepare(
      `SELECT o.id AS outbox_id, o.notify_reason, e.id AS effect_id, e.task_id
       FROM outbox o JOIN effects e ON e.id=o.effect_id
       WHERE e.state='READY' AND o.notify_reason LIKE 'followup:%'`,
    )
    .all();
  const cancelled = [];
  for (const r of rows) {
    const timerId = r.notify_reason.slice("followup:".length);
    const timer = db.prepare("SELECT * FROM timers WHERE id=?").get(timerId);
    if (!timer) continue;
    const cond = JSON.parse(timer.condition_json);
    const check = evaluateCondition(db, cond, { now, timer, stateDir });
    if (!check.satisfied) continue;
    withTx(db, () => {
      const changed = db
        .prepare(
          "UPDATE effects SET state='CANCELLED', last_error='follow-up condition satisfied; stale reminder cancelled', updated_at=? WHERE id=? AND state='READY'",
        )
        .run(now, r.effect_id).changes;
      if (changed !== 1) return;
      writeAudit(db, {
        code: "stale_reminder_cancelled",
        taskId: r.task_id,
        details: { effect_id: r.effect_id, timer_id: timerId, evidence: check.evidence },
        now,
      });
      cancelled.push(r.effect_id);
    });
  }
  return cancelled;
}

// Revocation / cancellation cascade (03 section 4: "用户撤销任务、权限或邮
// 件访问时，关联 Timer 必须取消或停车"). The CALLER owns the surrounding
// transaction when it has one (acl revocation, task cancellation); this form
// opens its own single transaction otherwise. Only SCHEDULED timers die —
// FIRED/SATISFIED/CANCELLED are already terminal and stay as history.
export function cancelScopeTimersInTx(db, { scopeId, now, reason, actorId = null }) {
  const rows = db
    .prepare("SELECT id FROM timers WHERE scope_id=? AND state='SCHEDULED'")
    .all(scopeId);
  for (const r of rows) {
    const changed = db
      .prepare("UPDATE timers SET state='CANCELLED' WHERE id=? AND state='SCHEDULED'")
      .run(r.id).changes;
    if (changed !== 1) continue;
    writeAudit(db, {
      code: "timer_cancelled_cascade",
      actorId,
      details: { timer_id: r.id, scope_id: scopeId, reason },
      now,
    });
    writeStreamEvent(db, {
      scopeId,
      eventType: "timer_changed",
      entityId: `timer:${r.id}`,
      entityVersion: 2,
      payload: { state: "CANCELLED", reason },
      now,
    });
  }
  return rows.map((r) => r.id);
}

export function cancelScopeTimers(db, { scopeId, now, reason, actorId = null }) {
  return withTx(db, () => cancelScopeTimersInTx(db, { scopeId, now, reason, actorId }));
}
