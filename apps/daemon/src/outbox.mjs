// Outbox per 06 sections 6 and 7. The outbox row carries destination,
// not_before and notify_reason; whether a notification was actually SENT is
// only ever effects.state — the outbox never keeps a second delivery status
// (schema comment: "Delivery status is effects.state. Do not maintain a second
// conflicting outbox status"). A quiet period (not_before in the future)
// delays the message without dropping it; a digest merge creates a NEW outbox
// row that supersedes the old one and CANCELS its READY effect, never edits
// an approved body; an expired notification is cancelled with a visible
// reason.

import { withTx } from "./db/tx.mjs";
import { writeAudit } from "./audit.mjs";
import { completeTaskInTx } from "./scheduler.mjs";

export class OutboxError extends Error {}

export function enqueueNotification(db, { effectId, channel, destination, notBefore, notifyReason, now }) {
  return withTx(db, () => enqueueNotificationInTx(db, { effectId, channel, destination, notBefore, notifyReason, now }));
}

export function enqueueNotificationInTx(db, { effectId, channel, destination, notBefore, notifyReason, now }) {
  const id = `obx:${effectId}`;
  const existing = db.prepare("SELECT id FROM outbox WHERE effect_id=?").get(effectId);
  if (existing) {
    return { outboxId: existing.id, duplicate: true };
  }
  db.prepare(
    "INSERT INTO outbox(id, effect_id, channel, destination, not_before, notify_reason, supersedes_outbox_id) VALUES (?,?,?,?,?,?,NULL)",
  ).run(id, effectId, channel, destination, notBefore, notifyReason);
  writeAudit(db, {
    code: "outbox_enqueued",
    details: { outbox_id: id, effect_id: effectId, channel, destination, not_before: notBefore, notify_reason: notifyReason },
    now,
  });
  return { outboxId: id, duplicate: false };
}

// The one-transaction composition point (06 section 7): task conclusion,
// result evidence, the notification effect proposal and the outbox row land
// together or not at all. The effect here is already-approved notification
// machinery owned by the host, so it is created READY via the caller's
// pre-approved routine reference.
export function finalizeTaskWithNotificationInTx(db, {
  now,
  taskId,
  attemptNo,
  leaseOwner,
  fence,
  resultClass,
  resultObjectId,
  errorCode = null,
  notification, // {effectId, channel, destination, notBefore, notifyReason}
}) {
  const result = completeTaskInTx(db, {
    taskId, attemptNo, leaseOwner, fence, now, resultClass, resultObjectId, errorCode,
  });
  const box = enqueueNotificationInTx(db, {
    effectId: notification.effectId,
    channel: notification.channel,
    destination: notification.destination,
    notBefore: notification.notBefore,
    notifyReason: notification.notifyReason,
    now,
  });
  return { taskState: result.state, outboxId: box.outboxId, outboxDuplicate: box.duplicate };
}

export function finalizeTaskWithNotification(db, opts) {
  return withTx(db, () => finalizeTaskWithNotificationInTx(db, opts));
}

// Digest merge: a newer summary supersedes a pending older one. The new
// outbox row references the old row; the OLD READY effect is cancelled with
// the reason recorded — the approved body is never edited in place.
export function supersedeNotification(db, {
  oldOutboxId,
  newEffectId,
  channel,
  destination,
  notBefore,
  notifyReason,
  now,
}) {
  return withTx(db, () => {
    const old = db.prepare("SELECT * FROM outbox WHERE id=?").get(oldOutboxId);
    if (!old) throw new OutboxError(`outbox row ${oldOutboxId} not found`);
    const newId = `obx:${newEffectId}`;
    const changedEffect = db
      .prepare(
        "UPDATE effects SET state='CANCELLED', last_error='superseded by a newer digest', updated_at=? WHERE id=? AND state='READY'",
      )
      .run(now, old.effect_id).changes;
    db.prepare(
      "INSERT INTO outbox(id, effect_id, channel, destination, not_before, notify_reason, supersedes_outbox_id) VALUES (?,?,?,?,?,?,?)",
    ).run(newId, newEffectId, channel, destination, notBefore, notifyReason, oldOutboxId);
    writeAudit(db, {
      code: "outbox_superseded",
      details: { old_outbox_id: oldOutboxId, old_effect_id: old.effect_id, new_outbox_id: newId, effect_cancelled: changedEffect === 1 },
      now,
    });
    return { outboxId: newId, oldEffectCancelled: changedEffect === 1 };
  });
}

// Notifications whose quiet window has not opened yet are NOT dropped; they
// stay queued until not_before. This reader is what a dispatcher loop uses to
// decide what may go out now.
export function dueNotifications(db, { now }) {
  return db
    .prepare(
      `SELECT o.*, e.state AS effect_state, e.expires_at AS effect_expires_at, e.retry_mode
       FROM outbox o JOIN effects e ON e.id=o.effect_id
       WHERE o.not_before<=? AND e.state='READY'
       ORDER BY o.not_before ASC`,
    )
    .all(now);
}

// Expired notifications are cancelled with a visible reason, never silently
// discarded (06 section 7: "通知过期时给出可见的过期原因").
export function expireStaleNotifications(db, { now }) {
  const rows = db
    .prepare(
      `SELECT o.id AS outbox_id, e.id AS effect_id, e.task_id, e.expires_at
       FROM outbox o JOIN effects e ON e.id=o.effect_id
       WHERE e.state='READY' AND e.expires_at<=?`,
    )
    .all(now);
  const expired = [];
  for (const r of rows) {
    withTx(db, () => {
      const changed = db
        .prepare(
          "UPDATE effects SET state='CANCELLED', last_error='notification expired before its quiet window opened', updated_at=? WHERE id=? AND state='READY'",
        )
        .run(now, r.effect_id).changes;
      if (changed !== 1) return;
      writeAudit(db, {
        code: "notification_expired",
        taskId: r.task_id,
        details: { outbox_id: r.outbox_id, effect_id: r.effect_id, expired_at: r.expires_at, reason: "quiet window never opened before effect expiry" },
        now,
      });
      expired.push(r.effect_id);
    });
  }
  return expired;
}
