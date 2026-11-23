// Briefing & conditional follow-up runtime (Unit 5.4; spec 03 section 4,
// 06 section 7). The follow-up Timer decides WHEN; this module decides WHAT
// a fired follow-up becomes and WHEN a real reply cancels it:
//   - handleThreadReply: after a thread event lands, every SCHEDULED
//     contact_no_reply timer on that thread is re-judied inside one
//     transaction — first committer wins, exactly the 06 section 7 race.
//   - processFiredFollowUpTimers: converts a FIRED follow-up timer into the
//     owner's reminder effect (narrow-routine "followup-reminder", AT_MOST_ONCE)
//     plus an outbox row keyed notify_reason followup:<timerId>. A still-pending
//     older reminder for the SAME timer is superseded, never doubled: one live
//     reminder per timer is the configured merge policy (06 section 7).
//     Quiet hours push not_before to the window's end — delays, never drops;
//     persistent infra failures are NEVER hidden by the quiet merge.
//   - processFiredBriefingTimers: converts a FIRED morning_briefing timer
//     (daily_wall_clock recurrence owns the IANA zone schedule) into the
//     owner's structured digest — composeMorningBriefing for the content,
//     mergeQuietBriefings for the quiet merge — as a narrow-routine
//     "morning-briefing" notify effect with outbox row briefing:<timerId>.
//   - The pre-dispatch re-check stays cancelSatisfiedFollowUpReminders
//     (timers.mjs, run every daemon tick before dispatch).

import { createHash } from "node:crypto";
import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { insertObjectRow, readObjectContent } from "./objects.mjs";
import { proposeEffectInTx, draftToReadyInTx } from "./effects.mjs";
import { enqueueNotificationInTx, supersedeNotificationInTx, finalizeTaskWithNotificationInTx } from "./outbox.mjs";
import { completeTaskInTx, completePendingDeliveryCheckpointInTx } from "./scheduler.mjs";
import { markTimerSatisfied, evaluateCondition, timerIdFor } from "./timers.mjs";
import { inQuietHours, nextQuietBoundary } from "./quiet-time.mjs";

export class FollowUpError extends Error {}

const FOLLOWUP_ROUTINE = "followup-reminder";

// Reply path (03 section 4: "回信和到期竞争按06事务处理"). The event is
// already durable; this transaction re-judges every SCHEDULED follow-up
// timer bound to (scope, threadKey). Runs with the payload reader so the
// contact_no_reply condition can see envelopes.
export function handleThreadReply(db, stateDir, { scopeId, threadKey, now }) {
  const timers = db
    .prepare("SELECT id FROM timers WHERE scope_id=? AND thread_key=? AND state='SCHEDULED'")
    .all(scopeId, threadKey);
  const satisfied = [];
  for (const t of timers) {
    try {
      const outcome = markTimerSatisfied(db, { timerId: t.id, now, stateDir });
      if (outcome.changed) satisfied.push(t.id);
    } catch {
      // An unreadable condition keeps its timer SCHEDULED (fail closed for
      // reminders); the due scan's refused path audits it.
    }
  }
  return { satisfied };
}

function timerCondition(db, timerId) {
  const row = db.prepare("SELECT condition_json, recurrence_json FROM timers WHERE id=?").get(timerId);
  if (!row) throw new FollowUpError(`timer ${timerId} missing`);
  return { condition: JSON.parse(row.condition_json), recurrence: row.recurrence_json ? JSON.parse(row.recurrence_json) : null };
}

// The deterministic narrow-routine claim: the HOST owns this attempt (no
// model call, no provider bill). A reminder/digest effect needs a real
// attempt anchor (effects.attempt_id is NOT NULL REFERENCES attempts), and
// without a claim the routed task would sit QUEUED forever in an offline
// daemon — exactly the F-3 broken chain this wiring closes. The claim CASes
// the same QUEUED->RUNNING transition the worker claim uses (fence bump,
// pause/epoch re-check), with a short host lease the same tick releases.
function claimForNarrowRoutine(db, taskId, { now, leaseMs = 60_000 }) {
  const t = db
    .prepare(
      `SELECT t.*, s.paused AS scope_paused, s.epoch AS scope_epoch_now
       FROM tasks t JOIN scopes s ON s.id=t.scope_id WHERE t.id=?`,
    )
    .get(taskId);
  if (!t || (t.state !== "QUEUED" && t.state !== "RETRY_WAIT") || t.scope_paused === 1 || t.scope_epoch_now !== t.scope_epoch) {
    return null;
  }
  const attemptNo = t.attempt_no + 1;
  const fence = t.fence + 1;
  const attemptId = `att:${t.id}:${attemptNo}`;
  db.prepare(
    `INSERT INTO attempts(id, task_id, attempt_no, fence, state, session_id, checkpoint_object_id, started_at, ended_at, error_code)
     VALUES (?,?,?,?, 'ACTIVE', NULL, NULL, ?, NULL, NULL)`,
  ).run(attemptId, t.id, attemptNo, fence, now);
  const leaseOwner = `wkr:host-routine:${process.pid}:${now}`;
  const changed = db
    .prepare(
      `UPDATE tasks SET state='RUNNING', attempt_no=?, fence=?, lease_owner=?, lease_expires_at=?, updated_at=?
       WHERE id=? AND state IN ('QUEUED','RETRY_WAIT') AND attempt_no=? AND fence=?`,
    )
    .run(attemptNo, fence, leaseOwner, now + leaseMs, now, t.id, t.attempt_no, t.fence).changes;
  if (changed !== 1) return null;
  return { taskId: t.id, attemptId, attemptNo, leaseOwner, fence, scopeId: t.scope_id };
}

// One fired contact_no_reply timer -> at most one live READY reminder, and
// the timer's routed task CONCLUDES with the reminder as its evidence (the
// 06 section 7 composition point: task conclusion + notification land
// together). No routed task yet -> skip; the next pass retries.
export function processFiredFollowUpTimers(db, stateDir, {
  now,
  firedTimers, // processDueTimers(...) result.fired
  approvedRoutines = [FOLLOWUP_ROUTINE],
  channel = "telegram",
  destination = null, // required: the owner DM destination for reminders
  quietHours = null,
  reminderTtlMs = 24 * 3600 * 1000,
  ownerId = null,
}) {
  const results = [];
  for (const f of firedTimers) {
    const timerId = f.timer.id;
    let cond;
    try {
      cond = timerCondition(db, timerId);
    } catch {
      continue;
    }
    if (cond.condition?.type !== "contact_no_reply") continue;
    // The task the router created from this timer's fired event (latest
    // occurrence wins). No task yet is not an error — skip and retry.
    const timerEvent = db
      .prepare(
        `SELECT id FROM inbox WHERE source='timer' AND source_event_id LIKE ? || ':%'
          ORDER BY received_at DESC LIMIT 1`,
      )
      .get(timerId);
    const taskRow = timerEvent
      ? db
          .prepare(
            `SELECT t.id AS task_id, t.scope_id, t.principal_id
             FROM tasks t
             WHERE t.origin_event_id=?
                OR EXISTS (SELECT 1 FROM event_deliveries d WHERE d.task_id=t.id AND d.event_id=?)
             ORDER BY t.created_at DESC LIMIT 1`,
          )
          .get(timerEvent.id, timerEvent.id)
      : null;
    if (!taskRow) {
      results.push({ timerId, skipped: "no routed task for the fired timer yet" });
      continue;
    }
    const claim = withTx(db, () => claimForNarrowRoutine(db, taskRow.task_id, { now }));
    if (!claim) {
      results.push({ timerId, skipped: "timer task not claimable for the narrow routine (state, pause or epoch)" });
      continue;
    }
    const summaryText = `Follow-up reminder: no reply yet from ${cond.condition.expectedSender ?? "the expected contact"} on thread ${cond.condition.threadKey ?? timerId} (missed beats merged: ${f.missedCount ?? 0}).`;
    const reminder = withTx(db, () => {
      const payload = insertObjectRow(db, {
        scopeId: taskRow.scope_id,
        kind: "briefing_payload",
        sourceUri: `timer:${timerId}`,
        sourceActor: "host",
        content: JSON.stringify({ kind: "followup_reminder", timerId, missedCount: f.missedCount ?? 0, text: summaryText }),
        observedAt: now,
        requiredScopeIds: [taskRow.scope_id],
      });
      let proposed;
      try {
        proposed = proposeEffectInTx(db, stateDir, {
          now,
          taskId: claim.taskId,
          attemptId: claim.attemptId,
          effectType: "notify",
          domainKey: taskRow.scope_id.replace(/^scp:/, ""),
          naturalKey: `followup:${timerId}`,
          operationIntent: {
            targetResource: destination,
            operation: "send_message",
            contentHash: createHash("sha256").update(summaryText).digest("hex"),
            evidenceManifestHash: payload.content_hash,
            parentObjectIds: [payload.id],
            payloadContent: summaryText,
          },
          retryMode: "AT_MOST_ONCE",
          provider: "im",
          resource: destination ?? "owner-dm",
          requiresApproval: false,
          expiresAt: now + reminderTtlMs,
        });
      } catch (e) {
        // A live reminder for this timer already exists: merge — the newest
        // beat supersedes the pending older one (06 section 7 merge policy).
        if (!/already exists/.test(String(e.message))) throw e;
        const oldOutbox = db
          .prepare(
            `SELECT o.id AS outbox_id FROM outbox o JOIN effects e ON e.id=o.effect_id
             WHERE e.task_id=? AND o.notify_reason=? AND e.state IN ('READY','SUBMITTING')`,
          )
          .get(claim.taskId, `followup:${timerId}`);
        if (!oldOutbox) {
          results.push({ timerId, skipped: "reminder already live in a non-supersedeable state" });
          return { timerId, merged: false };
        }
        const mergedPayload = insertObjectRow(db, {
          scopeId: taskRow.scope_id,
          kind: "briefing_payload",
          sourceUri: `timer:${timerId}`,
          sourceActor: "host",
          content: JSON.stringify({ kind: "followup_reminder", timerId, missedCount: f.missedCount ?? 0, text: summaryText }),
          observedAt: now,
          requiredScopeIds: [taskRow.scope_id],
        });
        const merged = proposeEffectInTx(db, stateDir, {
          now,
          taskId: claim.taskId,
          attemptId: claim.attemptId,
          effectType: "notify",
          domainKey: taskRow.scope_id.replace(/^scp:/, ""),
          naturalKey: `followup:${timerId}:beat${f.occurrence}`,
          operationIntent: {
            targetResource: destination,
            operation: "send_message",
            contentHash: createHash("sha256").update(summaryText).digest("hex"),
            evidenceManifestHash: mergedPayload.content_hash,
            parentObjectIds: [mergedPayload.id],
            payloadContent: summaryText,
          },
          retryMode: "AT_MOST_ONCE",
          provider: "im",
          resource: destination ?? "owner-dm",
          requiresApproval: false,
          expiresAt: now + reminderTtlMs,
        });
        draftToReadyInTx(db, { effectId: merged.effectId, routineRef: FOLLOWUP_ROUTINE, approvedRoutines, now });
        const notBefore = quietHours ? nextQuietBoundary(now, quietHours, { wantOpen: false }) : now;
        const box = supersedeNotificationInTx(db, {
          oldOutboxId: oldOutbox.outbox_id,
          newEffectId: merged.effectId,
          channel,
          destination: destination ?? "owner-dm",
          notBefore,
          notifyReason: `followup:${timerId}`,
          now,
        });
        finalizeTaskWithNotificationInTx(db, {
          now,
          taskId: claim.taskId,
          attemptNo: claim.attemptNo,
          leaseOwner: claim.leaseOwner,
          fence: claim.fence,
          resultClass: "not_applicable",
          resultObjectId: mergedPayload.id,
          notification: { effectId: merged.effectId, channel, destination: destination ?? "owner-dm", notBefore, notifyReason: `followup:${timerId}` },
        });
        completePendingDeliveryCheckpointInTx(db, {
          taskId: claim.taskId,
          scopeId: taskRow.scope_id,
          content: `follow-up reminder superseded and scheduled (${timerId})`,
          insertObjectRowFn: insertObjectRow,
          now,
        });
        return { timerId, merged: true, effectId: merged.effectId, outboxId: box.outboxId };
      }
      draftToReadyInTx(db, { effectId: proposed.effectId, routineRef: FOLLOWUP_ROUTINE, approvedRoutines, now });
      // Quiet hours delay, never drop (06 section 7). A persistent infra
      // failure is never hidden: the effect stays READY and visible.
      const notBefore = quietHours ? nextQuietBoundary(now, quietHours, { wantOpen: false }) : now;
      const box = enqueueNotificationInTx(db, {
        effectId: proposed.effectId,
        channel,
        destination: destination ?? "owner-dm",
        notBefore,
        notifyReason: `followup:${timerId}`,
        now,
      });
      finalizeTaskWithNotificationInTx(db, {
        now,
        taskId: claim.taskId,
        attemptNo: claim.attemptNo,
        leaseOwner: claim.leaseOwner,
        fence: claim.fence,
        resultClass: "not_applicable",
        resultObjectId: payload.id,
        notification: { effectId: proposed.effectId, channel, destination: destination ?? "owner-dm", notBefore, notifyReason: `followup:${timerId}` },
      });
      completePendingDeliveryCheckpointInTx(db, {
        taskId: claim.taskId,
        scopeId: taskRow.scope_id,
        content: `follow-up reminder scheduled (${timerId})`,
        insertObjectRowFn: insertObjectRow,
        now,
      });
      writeAudit(db, {
        code: "followup_reminder_scheduled",
        details: { timer_id: timerId, effect_id: proposed.effectId, outbox_id: box.outboxId, not_before: notBefore, missed_count: f.missedCount ?? 0, task_id: claim.taskId },
        now,
      });
      return { timerId, merged: false, effectId: proposed.effectId, outboxId: box.outboxId, notBefore };
    });
    results.push(reminder);
  }
  return results;
}

const BRIEFING_ROUTINE = "morning-briefing";

// One fired morning_briefing timer -> the owner's queued digest. The timer's
// recurrence (daily_wall_clock, IANA zone, missed-beat merge) decides WHEN;
// composeMorningBriefing decides WHAT; mergeQuietBriefings applies the quiet
// window and the supersede merge. The notify effect is AT_MOST_ONCE, hosted
// by the narrow "morning-briefing" routine, anchored on the timer's routed
// task — a briefing without a live authorization context would be
// unaccountable. No routed task yet -> skip; the next pass retries (the
// per-occurrence natural key makes the retry a duplicate-skip, never a
// second send).
export function processFiredBriefingTimers(db, stateDir, {
  now,
  firedTimers, // processDueTimers(...) result.fired
  approvedRoutines = [BRIEFING_ROUTINE, FOLLOWUP_ROUTINE],
  channel = "telegram",
  destination = null, // the owner DM destination for digests
  quietHours = null,
  window = null, // composeMorningBriefing horizon (default 24h)
  briefingTtlMs = 24 * 3600 * 1000,
}) {
  const results = [];
  for (const f of firedTimers) {
    const timerId = f.timer.id;
    let cond;
    try {
      cond = timerCondition(db, timerId);
    } catch {
      continue;
    }
    if (cond.condition?.type !== "morning_briefing") continue;
    const timerEvent = db
      .prepare(
        `SELECT id FROM inbox WHERE source='timer' AND source_event_id LIKE ? || ':%'
          ORDER BY received_at DESC LIMIT 1`,
      )
      .get(timerId);
    const taskRow = timerEvent
      ? db
          .prepare(
            `SELECT t.id AS task_id, t.scope_id, t.principal_id
             FROM tasks t
             WHERE t.origin_event_id=?
                OR EXISTS (SELECT 1 FROM event_deliveries d WHERE d.task_id=t.id AND d.event_id=?)
             ORDER BY t.created_at DESC LIMIT 1`,
          )
          .get(timerEvent.id, timerEvent.id)
      : null;
    if (!taskRow) {
      results.push({ timerId, skipped: "no routed task for the fired timer yet" });
      continue;
    }
    const claim = withTx(db, () => claimForNarrowRoutine(db, taskRow.task_id, { now }));
    if (!claim) {
      results.push({ timerId, skipped: "timer task not claimable for the narrow routine (state, pause or epoch)" });
      continue;
    }
    const digest = composeMorningBriefing(db, { now, scopeId: taskRow.scope_id, window });
    const summaryText = `Morning briefing: ${digest.calendarEvents.length} calendar event(s), ${digest.pendingApprovals.length} pending approval(s), ${digest.pendingTimers.length} pending follow-up timer(s), ${digest.unrecoveredAlerts.length} unrecovered alert(s).`;
    // insertObjectRow returns {id, alreadyPresent, status} — NOT the content
    // hash it computed (D-101 non-blocking memo; the old code read a
    // nonexistent .content_hash and the effect silently bound P3-1's
    // empty-manifest constant). Hash the same content string here: identical
    // to the row's stored content_hash.
    const digestContent = JSON.stringify(digest);
    const digestContentHash = createHash("sha256").update(digestContent).digest("hex");
    const outcome = withTx(db, () => {
      const digestObject = insertObjectRow(db, {
        scopeId: taskRow.scope_id,
        kind: "briefing_payload",
        sourceUri: `timer:${timerId}`,
        sourceActor: "host",
        content: digestContent,
        observedAt: now,
        requiredScopeIds: [taskRow.scope_id],
      });
      const proposed = proposeEffectInTx(db, stateDir, {
        now,
        taskId: claim.taskId,
        attemptId: claim.attemptId,
        effectType: "notify",
        domainKey: taskRow.scope_id.replace(/^scp:/, ""),
        naturalKey: `briefing:${timerId}:beat${f.occurrence}`,
        operationIntent: {
          targetResource: destination,
          operation: "send_message",
          contentHash: createHash("sha256").update(summaryText).digest("hex"),
          evidenceManifestHash: digestContentHash,
          parentObjectIds: [digestObject.id],
          payloadContent: summaryText,
        },
        retryMode: "AT_MOST_ONCE",
        provider: "im",
        resource: destination ?? "owner-dm",
        requiresApproval: false,
        expiresAt: now + briefingTtlMs,
      });
      draftToReadyInTx(db, { effectId: proposed.effectId, routineRef: BRIEFING_ROUTINE, approvedRoutines, now });
      const notBefore = quietHours ? nextQuietBoundary(now, quietHours, { wantOpen: false }) : now;
      const box = mergeQuietBriefingsInTx(db, {
        now,
        quietHours,
        channel,
        destination: destination ?? "owner-dm",
        newEffectId: proposed.effectId,
        notifyReason: `briefing:${timerId}`,
        notBefore,
      });
      // The task concludes with the digest as its evidence; the outbox row
      // already exists from the quiet merge (enqueue dedups on effect_id).
      completeTaskInTx(db, {
        taskId: claim.taskId,
        attemptNo: claim.attemptNo,
        leaseOwner: claim.leaseOwner,
        fence: claim.fence,
        now,
        resultClass: "not_applicable",
        resultObjectId: digestObject.id,
      });
      completePendingDeliveryCheckpointInTx(db, {
        taskId: claim.taskId,
        scopeId: taskRow.scope_id,
        content: `morning briefing scheduled (${timerId})`,
        insertObjectRowFn: insertObjectRow,
        now,
      });
      writeAudit(db, {
        code: "morning_briefing_scheduled",
        details: {
          timer_id: timerId,
          effect_id: proposed.effectId,
          outbox_id: box.outboxId,
          merged: box.merged,
          not_before: notBefore,
          task_id: claim.taskId,
          sections: {
            calendar_events: digest.calendarEvents.length,
            pending_approvals: digest.pendingApprovals.length,
            pending_timers: digest.pendingTimers.length,
            unrecovered_alerts: digest.unrecoveredAlerts.length,
          },
        },
        now,
      });
      return { timerId, merged: box.merged, effectId: proposed.effectId, outboxId: box.outboxId, notBefore, summaryText };
    });
    results.push(outcome);
  }
  return results;
}

// Morning briefing composition (03 section 4): a STRUCTURED digest of the
// day's calendar events (parsed .ics payloads ingested by the calendar
// adapter), pending draft approvals, pending follow-up timers and unrecovered
// alerts — composed as one outbox item, quiet-merged like any notification.
// The briefing itself is a READ-only composition; any calendar write stays a
// separate approval-gated calendar.write effect (never auto-executed).
export function composeMorningBriefing(db, { now, scopeId, window }) {
  const from = now;
  const to = now + (window?.horizonMs ?? 24 * 3600 * 1000);
  const events = [];
  const rows = db
    .prepare(
      `SELECT id, metadata_json, observed_at FROM objects
        WHERE scope_id=? AND kind='calendar_event' AND status='active'
          AND observed_at<=? ORDER BY observed_at ASC LIMIT 200`,
    )
    .all(scopeId, to);
  for (const r of rows) {
    let meta;
    try {
      meta = JSON.parse(r.metadata_json || "{}");
    } catch {
      continue;
    }
    const start = Number(meta.dtStart ?? 0);
    if (start >= from && start <= to) {
      events.push({
        objectId: r.id,
        summary: String(meta.summary ?? "(untitled)").slice(0, 200),
        dtStart: start,
        dtEnd: Number(meta.dtEnd ?? 0),
        timezone: meta.timezone ?? null,
        etag: meta.etag ?? null,
        attendees: Array.isArray(meta.attendees) ? meta.attendees.slice(0, 20) : [],
      });
    }
  }
  const pendingApprovals = db
    .prepare(
      `SELECT a.id, a.effect_id, a.expires_at, e.operation, e.scope_id
       FROM approvals a JOIN effects e ON e.id=a.effect_id
       WHERE a.state='WAITING' AND a.expires_at>? AND e.scope_id=?
       ORDER BY a.expires_at ASC LIMIT 50`,
    )
    .all(now, scopeId);
  const pendingTimers = db
    .prepare(
      `SELECT id, thread_key, due_at, condition_json FROM timers
        WHERE scope_id=? AND state='SCHEDULED' AND due_at<=?
        ORDER BY due_at ASC LIMIT 50`,
    )
    .all(scopeId, to)
    .map((t) => {
      let cond = null;
      try {
        cond = JSON.parse(t.condition_json);
      } catch {}
      return { id: t.id, threadKey: t.thread_key, dueAt: t.due_at, condition: cond };
    });
  const unrecoveredAlerts = db
    .prepare(
      `SELECT seq, event_type, entity_id, payload_json, created_at FROM stream_events
        WHERE event_type='audit_alert' AND created_at>=? AND scope_id=?
        ORDER BY seq DESC LIMIT 50`,
    )
    .all(now - 24 * 3600 * 1000, scopeId);
  return {
    scopeId,
    generatedAt: now,
    window: { from, to },
    calendarEvents: events,
    pendingApprovals,
    pendingTimers,
    unrecoveredAlerts,
  };
}

// The quiet-hours merge for ordinary briefing notifications: while quiet,
// later digests supersede earlier pending ones (outbox.not_before +
// supersedes_outbox_id), but an effect in infra trouble is never silently
// folded away — only READY (not-yet-sent) reminders merge, and the supersede
// audit names both rows. The InTx form composes inside a CALLER-OWNED
// transaction (withTx does not nest); the wrapper is the standalone form.
export function mergeQuietBriefingsInTx(db, { now, quietHours, channel, destination, newEffectId, notifyReason, notBefore }) {
  if (!quietHours || !inQuietHours(now, quietHours)) {
    return { merged: false, outboxId: enqueueNotificationInTx(db, { effectId: newEffectId, channel, destination, notBefore, notifyReason, now }).outboxId };
  }
  const pending = db
    .prepare(
      `SELECT o.id AS outbox_id, o.notify_reason FROM outbox o JOIN effects e ON e.id=o.effect_id
       WHERE o.channel=? AND o.destination=? AND e.state='READY' AND o.notify_reason LIKE 'briefing:%'
       ORDER BY o.not_before ASC LIMIT 20`,
    )
    .all(channel, destination);
  if (pending.length === 0) {
    return { merged: false, outboxId: enqueueNotificationInTx(db, { effectId: newEffectId, channel, destination, notBefore, notifyReason, now }).outboxId };
  }
  // The oldest pending briefing is the merge target: the new digest
  // supersedes it and every other pending briefing is cancelled with the
  // same visible reason. infra-troubled effects (UNKNOWN/FAILED) are not in
  // the READY set, so they were never candidates.
  const target = pending[0];
  const box = supersedeNotificationInTx(db, {
    oldOutboxId: target.outbox_id,
    newEffectId,
    channel,
    destination,
    notBefore,
    notifyReason,
    now,
  });
  for (const p of pending.slice(1)) {
    db.prepare(
      "UPDATE effects SET state='CANCELLED', last_error='merged into a newer briefing digest', updated_at=? WHERE id=(SELECT effect_id FROM outbox WHERE id=?) AND state='READY'",
    ).run(now, p.outbox_id);
  }
  return { merged: true, outboxId: box.outboxId };
}

export function mergeQuietBriefings(db, opts) {
  return withTx(db, () => mergeQuietBriefingsInTx(db, opts));
}

function enqueuePlain(db, { newEffectId, channel, destination, notifyReason, notBefore, now }) {
  return withTx(db, () => enqueueNotificationInTx(db, { effectId: newEffectId, channel, destination, notBefore, notifyReason, now })).outboxId;
}

// The dreaming orchestration needs the same condition evaluation the timers
// use when it wants to report WHY a conflicted memory's thread stalled.
export function explainFollowUpCondition(db, stateDir, { timerId, now }) {
  const timer = db.prepare("SELECT * FROM timers WHERE id=?").get(timerId);
  if (!timer) return null;
  const cond = JSON.parse(timer.condition_json);
  try {
    return evaluateCondition(db, cond, { now, timer, stateDir });
  } catch (e) {
    return { satisfied: false, error: String(e.message) };
  }
}
