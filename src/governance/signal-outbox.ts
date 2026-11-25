import type { DatabaseSync } from "node:sqlite";
import { withImmediateTx, writeAuditEvent } from "./db.ts";
import { quarantineReadyEffect } from "./effects.ts";

export type OutboxState = "PENDING" | "ACKED" | "ISOLATED";
export type SdkSignalOutcome = "delivered" | "duplicate" | "invalid" | "closed" | "not_found";

export interface SignalOutboxItem {
  approval_id: string;
  signal_key: string;
  state: OutboxState;
  sdk_result: string | null;
  reason: string | null;
  attempts: number;
  updated_at: number;
  proposal_id: string;
  runtime_epoch: string;
  conversation_id: string;
  tool_task_id: string;
  call_id: string;
  revision: number;
  approval_state: string;
  effect_id: string | null;
  effect_state: string | null;
}

export function listPendingOutboxItems(db: DatabaseSync, activeRuntimeEpoch?: string): SignalOutboxItem[] {
  const sql = `
    SELECT
      o.approval_id, o.signal_key, o.state, o.sdk_result, o.reason, o.attempts, o.updated_at,
      a.proposal_id, a.revision, a.state AS approval_state,
      p.runtime_epoch, p.conversation_id, p.tool_task_id, p.call_id,
      e.effect_id, e.state AS effect_state
    FROM signal_outbox o
    JOIN approvals a ON a.approval_id = o.approval_id
    JOIN proposals p ON p.proposal_id = a.proposal_id
    LEFT JOIN effects e ON e.approval_id = a.approval_id
    WHERE o.state = 'PENDING'
    ${activeRuntimeEpoch ? "AND p.runtime_epoch = ?" : ""}
    ORDER BY o.updated_at ASC, o.approval_id ASC
  `;
  return (activeRuntimeEpoch
    ? db.prepare(sql).all(activeRuntimeEpoch)
    : db.prepare(sql).all()) as unknown as SignalOutboxItem[];
}

export type DuplicateCheckOutcome = "matched" | "conflict" | "unverifiable";

export interface ReconcileSignalOutcomeParams {
  approvalId: string;
  sdkOutcome: SdkSignalOutcome;
  duplicateValueMatches?: boolean;
  duplicateCheck?: DuplicateCheckOutcome;
  taskObservedDecisionOrFinished?: boolean;
  reason?: string;
  now: number;
}

/**
 * T3: Apply the SDK signal delivery outcome to signal_outbox (and isolate orphaned READY
 * effects when the task is closed/not_found/invalid or duplicate conflicts).
 */
export function recordOutboxDeliveryOutcome(
  db: DatabaseSync,
  params: ReconcileSignalOutcomeParams,
): { outboxState: OutboxState; effectQuarantined: boolean } {
  const row = db
    .prepare(
      `SELECT o.approval_id, o.state, e.effect_id, e.state AS effect_state
         FROM signal_outbox o
         LEFT JOIN effects e ON e.approval_id = o.approval_id
        WHERE o.approval_id = ?`,
    )
    .get(params.approvalId) as
    | { approval_id: string; state: OutboxState; effect_id: string | null; effect_state: string | null }
    | undefined;

  if (!row) {
    throw new Error(`signal_outbox row not found for approval ${params.approvalId}`);
  }
  if (row.state !== "PENDING") {
    return { outboxState: row.state, effectQuarantined: false };
  }

  let nextState: OutboxState = "PENDING";
  let shouldQuarantineReady = false;
  let reason = params.reason ?? params.sdkOutcome;

  switch (params.sdkOutcome) {
    case "delivered":
      nextState = "ACKED";
      reason = "sdk_delivered";
      break;
    case "duplicate": {
      const check: DuplicateCheckOutcome =
        params.duplicateCheck ??
        (params.duplicateValueMatches === true
          ? "matched"
          : params.duplicateValueMatches === false
            ? "conflict"
            : "unverifiable");
      if (check === "matched") {
        nextState = "ACKED";
        reason = "sdk_duplicate_same_value";
      } else if (check === "conflict") {
        nextState = "ISOLATED";
        shouldQuarantineReady = true;
        reason = "sdk_duplicate_value_conflict";
      } else {
        // Cannot prove stored value matches: fail closed and keep isolated for manual review.
        nextState = "ISOLATED";
        shouldQuarantineReady = true;
        reason = "sdk_duplicate_unverifiable_pending_review";
      }
      break;
    }
    case "invalid":
      nextState = "ISOLATED";
      shouldQuarantineReady = true;
      reason = params.reason ?? "sdk_invalid_signal_contract";
      break;
    case "closed":
    case "not_found":
      if (params.taskObservedDecisionOrFinished) {
        nextState = "ACKED";
        reason = `sdk_${params.sdkOutcome}_already_consumed`;
      } else {
        nextState = "ISOLATED";
        shouldQuarantineReady = true;
        reason = params.reason ?? `sdk_${params.sdkOutcome}_orphan_task`;
      }
      break;
  }

  withImmediateTx(db, () => {
    db.prepare(
      `UPDATE signal_outbox
          SET state = ?, sdk_result = ?, reason = ?, attempts = attempts + 1, updated_at = ?
        WHERE approval_id = ? AND state = 'PENDING'`,
    ).run(nextState, params.sdkOutcome, reason, params.now, params.approvalId);

    writeAuditEvent(db, {
      entityType: "signal_outbox",
      entityId: params.approvalId,
      eventKey: `outbox:${params.approvalId}:${params.sdkOutcome}:${nextState}`,
      eventType: nextState === "ACKED" ? "signal_outbox_acked" : "signal_outbox_isolated",
      occurredAt: params.now,
      details: { sdkOutcome: params.sdkOutcome, nextState, reason },
    });
  });

  let effectQuarantined = false;
  if (shouldQuarantineReady && row.effect_id && row.effect_state === "READY") {
    effectQuarantined = quarantineReadyEffect(db, {
      effectId: row.effect_id,
      reason,
      now: params.now,
    });
  }

  return { outboxState: nextState, effectQuarantined };
}

export function markOutboxObservedByReentry(
  db: DatabaseSync,
  approvalId: string,
  now: number,
): boolean {
  return withImmediateTx(db, () => {
    const ch = db
      .prepare(
        `UPDATE signal_outbox
            SET state = 'ACKED', sdk_result = 'reentry_observed', reason = 'observed_before_park', updated_at = ?
          WHERE approval_id = ? AND state = 'PENDING'`,
      )
      .run(now, approvalId);
    if (Number(ch.changes) === 1) {
      writeAuditEvent(db, {
        entityType: "signal_outbox",
        entityId: approvalId,
        eventKey: `outbox_reentry:${approvalId}`,
        eventType: "signal_outbox_acked",
        occurredAt: now,
        details: { via: "reentry_observed" },
      });
      return true;
    }
    return false;
  });
}
