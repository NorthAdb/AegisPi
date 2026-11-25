import type { DatabaseSync } from "node:sqlite";
import { buildCanonicalDraft } from "./canonical.ts";
import { withImmediateTx, writeAuditEvent } from "./db.ts";
import { isPrincipalAuthorizedForScope, type ApprovalRow, type DraftRevisionRow, type ProposalRow, type ScopeRow } from "./approvals.ts";

export type EffectState =
  | "READY"
  | "SUBMITTING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "QUARANTINED";

export interface EffectRow {
  effect_id: string;
  approval_id: string;
  state: EffectState;
  claimed_at: number | null;
  receipt_ref: string | null;
  reason: string | null;
  reconciled_by: string | null;
  reconciled_at: number | null;
  reconcile_evidence: string | null;
}

export interface ClaimEffectParams {
  effectId: string;
  runtimeEpoch: string;
  conversationId: string;
  toolTaskId: string;
  callId: string;
  toolName: string;
  finalTarget: string;
  finalPayload: Record<string, unknown>;
  now: number;
  precondition?: () => boolean;
}

export interface ClaimEffectResult {
  claimed: boolean;
  code: string;
  message: string;
  effectId: string;
  state?: EffectState;
  canonicalSnapshot?: string;
  actionHash?: string;
}

/**
 * T4: Sole host submitter claiming CAS (READY -> SUBMITTING).
 * Re-verifies call identity, runtime epoch, approval state, RFC 8785 canonical snapshot
 * hash against final args/target, live ACL, scope epoch, policy version, cancellation,
 * and optional target precondition inside one BEGIN IMMEDIATE transaction.
 * Network calls MUST occur strictly after this function returns claimed=true.
 */
export function claimEffectForSubmission(
  db: DatabaseSync,
  params: ClaimEffectParams,
): ClaimEffectResult {
  return withImmediateTx(db, () => {
    const effect = db.prepare("SELECT * FROM effects WHERE effect_id = ?").get(params.effectId) as
      | EffectRow
      | undefined;
    if (!effect) {
      return {
        claimed: false,
        code: "effect_not_found",
        message: `Effect not found: ${params.effectId}`,
        effectId: params.effectId,
      };
    }

    const approval = db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(effect.approval_id) as
      | ApprovalRow
      | undefined;
    if (!approval || approval.state !== "APPROVED") {
      return {
        claimed: false,
        code: "approval_not_approved",
        message: `Effect ${params.effectId} approval is not APPROVED`,
        effectId: params.effectId,
        state: effect.state,
      };
    }

    const proposal = db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(approval.proposal_id) as
      | ProposalRow
      | undefined;
    const draft = db
      .prepare("SELECT * FROM draft_revisions WHERE proposal_id = ? AND revision = ?")
      .get(approval.proposal_id, approval.revision) as DraftRevisionRow | undefined;
    const scope = proposal
      ? (db.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(proposal.scope_id) as ScopeRow | undefined)
      : undefined;
    const epochRow = proposal
      ? (db
          .prepare("SELECT status FROM runtime_epochs WHERE runtime_epoch = ?")
          .get(proposal.runtime_epoch) as { status: string } | undefined)
      : undefined;

    if (!proposal || !draft || !scope || !epochRow) {
      return {
        claimed: false,
        code: "corrupt_lineage",
        message: "Missing proposal, draft, scope, or runtime_epoch row",
        effectId: params.effectId,
        state: effect.state,
      };
    }

    const refuse = (code: string, message: string): ClaimEffectResult => {
      writeAuditEvent(db, {
        entityType: "effect",
        entityId: params.effectId,
        eventKey: `claim_refused:${code}:${params.now}`,
        eventType: "effect_claim_refused",
        occurredAt: params.now,
        details: { code, message, state: effect.state, toolTaskId: params.toolTaskId, callId: params.callId },
      });
      return { claimed: false, code, message, effectId: params.effectId, state: effect.state };
    };

    if (effect.state !== "READY") {
      return refuse("effect_not_ready", `Effect ${params.effectId} is ${effect.state}, not READY`);
    }
    if (epochRow.status !== "ACTIVE" || proposal.runtime_epoch !== params.runtimeEpoch) {
      return refuse("runtime_epoch_mismatch", "Runtime epoch is retired or mismatched");
    }
    if (
      proposal.conversation_id !== params.conversationId ||
      proposal.tool_task_id !== params.toolTaskId ||
      proposal.call_id !== params.callId ||
      proposal.tool_name !== params.toolName
    ) {
      return refuse("call_identity_mismatch", "Tool call identity does not match approved proposal");
    }
    if (proposal.head_rev !== approval.revision) {
      return refuse("superseded_revision", `Approval revision ${approval.revision} is superseded by ${proposal.head_rev}`);
    }
    if (proposal.cancelled === 1 || scope.cancelled === 1) {
      return refuse("cancelled", "Proposal or scope is cancelled");
    }
    if (scope.scope_epoch !== draft.scope_epoch) {
      return refuse("scope_epoch_changed", `Scope epoch moved from ${draft.scope_epoch} to ${scope.scope_epoch}`);
    }
    if (scope.policy_version !== draft.policy_version) {
      return refuse("policy_version_changed", `Policy version moved from ${draft.policy_version} to ${scope.policy_version}`);
    }

    // Live ACL verification
    const allowedTools = JSON.parse(scope.allowed_tools_json) as string[];
    const allowedTargets = JSON.parse(scope.allowed_targets_json) as string[];
    if (!allowedTools.includes(params.toolName)) {
      return refuse("tool_acl_denied", `Tool ${params.toolName} is not allowed in scope ${scope.scope_id}`);
    }
    if (!allowedTargets.includes(params.finalTarget) && !allowedTargets.includes("*")) {
      return refuse("target_acl_denied", `Target ${params.finalTarget} is not allowed in scope ${scope.scope_id}`);
    }

    // Recompute RFC 8785 canonical snapshot & hash from actual final arguments
    const recomputed = buildCanonicalDraft({
      runtimeEpoch: proposal.runtime_epoch,
      conversationId: proposal.conversation_id,
      toolTaskId: proposal.tool_task_id,
      callId: proposal.call_id,
      proposalId: proposal.proposal_id,
      revision: approval.revision,
      tool: params.toolName,
      target: params.finalTarget,
      scopeId: proposal.scope_id,
      scopeEpoch: draft.scope_epoch,
      policyVersion: draft.policy_version,
      payload: params.finalPayload,
    });
    if (
      recomputed.actionHash !== draft.action_hash ||
      recomputed.canonicalSnapshot !== draft.canonical_snapshot
    ) {
      return refuse(
        "final_args_hash_mismatch",
        "Final execution arguments or target do not match approved canonical snapshot",
      );
    }

    if (params.precondition && !params.precondition()) {
      return refuse("precondition_failed", "Target precondition check failed");
    }

    // Second CAS: READY -> SUBMITTING (changes MUST equal 1)
    const cas = db
      .prepare("UPDATE effects SET state = 'SUBMITTING', claimed_at = ? WHERE effect_id = ? AND state = 'READY'")
      .run(params.now, params.effectId);
    if (Number(cas.changes) !== 1) {
      return refuse("cas_lost", "Concurrent claim already transitioned this effect");
    }

    writeAuditEvent(db, {
      entityType: "effect",
      entityId: params.effectId,
      eventKey: `claim:${params.effectId}`,
      eventType: "effect_claimed",
      occurredAt: params.now,
      details: {
        proposalId: proposal.proposal_id,
        approvalId: approval.approval_id,
        revision: approval.revision,
        actionHash: draft.action_hash,
        target: params.finalTarget,
      },
    });

    return {
      claimed: true,
      code: "claimed",
      message: "Effect claimed READY -> SUBMITTING",
      effectId: params.effectId,
      state: "SUBMITTING",
      canonicalSnapshot: draft.canonical_snapshot,
      actionHash: draft.action_hash,
    };
  });
}

/**
 * T5: Record delivery receipt after connector returns.
 * Guarded by state='SUBMITTING' so recovery/reconciliation decisions are never overwritten.
 */
export function recordEffectResult(
  db: DatabaseSync,
  params: {
    effectId: string;
    outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN";
    receiptRef?: string | null;
    reason?: string | null;
    now: number;
  },
): { updated: boolean; state: EffectState } {
  return withImmediateTx(db, () => {
    const existing = db.prepare("SELECT * FROM effects WHERE effect_id = ?").get(params.effectId) as
      | EffectRow
      | undefined;
    if (!existing) {
      throw new Error(`Effect not found: ${params.effectId}`);
    }
    if (existing.state !== "SUBMITTING") {
      return { updated: false, state: existing.state };
    }
    const ch = db
      .prepare(
        `UPDATE effects
            SET state = ?, receipt_ref = COALESCE(?, receipt_ref), reason = COALESCE(?, reason)
          WHERE effect_id = ? AND state = 'SUBMITTING'`,
      )
      .run(params.outcome, params.receiptRef ?? null, params.reason ?? null, params.effectId);
    if (Number(ch.changes) !== 1) {
      const latest = db.prepare("SELECT state FROM effects WHERE effect_id = ?").get(params.effectId) as {
        state: EffectState;
      };
      return { updated: false, state: latest.state };
    }
    writeAuditEvent(db, {
      entityType: "effect",
      entityId: params.effectId,
      eventKey: `result:${params.effectId}:${params.outcome}`,
      eventType: `effect_${params.outcome.toLowerCase()}`,
      occurredAt: params.now,
      evidenceRef: params.receiptRef ?? null,
      details: { reason: params.reason ?? null, receiptRef: params.receiptRef ?? null },
    });
    return { updated: true, state: params.outcome };
  });
}

/**
 * Step 2 of startup recovery (exclusive transaction):
 * Transitions every leftover SUBMITTING effect to UNKNOWN.
 * Never touches SUCCEEDED, FAILED, QUARANTINED, or already-UNKNOWN effects.
 */
export function recoverSubmittingEffectsToUnknown(db: DatabaseSync, now: number): string[] {
  return withImmediateTx(db, () => {
    const rows = db
      .prepare("SELECT effect_id FROM effects WHERE state = 'SUBMITTING'")
      .all() as Array<{ effect_id: string }>;
    const transitioned: string[] = [];
    for (const row of rows) {
      const ch = db
        .prepare(
          `UPDATE effects
              SET state = 'UNKNOWN', reason = 'recovered_submitting_without_receipt'
            WHERE effect_id = ? AND state = 'SUBMITTING'`,
        )
        .run(row.effect_id);
      if (Number(ch.changes) === 1) {
        writeAuditEvent(db, {
          entityType: "effect",
          entityId: row.effect_id,
          eventKey: `recover_unknown:${row.effect_id}`,
          eventType: "effect_recovered_to_unknown",
          occurredAt: now,
          details: { reason: "recovered_submitting_without_receipt" },
        });
        transitioned.push(row.effect_id);
      }
    }
    return transitioned;
  });
}

/**
 * Quarantine an unclaimed READY effect (e.g., Pi tool terminated before claim, or epoch retired).
 */
export function quarantineReadyEffect(
  db: DatabaseSync,
  params: { effectId: string; reason: string; now: number },
): boolean {
  return withImmediateTx(db, () => {
    const ch = db
      .prepare("UPDATE effects SET state = 'QUARANTINED', reason = ? WHERE effect_id = ? AND state = 'READY'")
      .run(params.reason, params.effectId);
    if (Number(ch.changes) !== 1) return false;
    writeAuditEvent(db, {
      entityType: "effect",
      entityId: params.effectId,
      eventKey: `quarantine:${params.effectId}:${params.reason}`,
      eventType: "effect_quarantined",
      occurredAt: params.now,
      details: { reason: params.reason },
    });
    return true;
  });
}

/**
 * Manual human reconciliation of an UNKNOWN effect.
 * Enforces principal authorization against the effect's scope and conversation owner.
 */
export function reconcileUnknownEffect(
  db: DatabaseSync,
  params: {
    effectId: string;
    actorId: string;
    evidenceRef: string;
    conclusion: "CONFIRMED_SUCCEEDED" | "CONFIRMED_NOT_SENT" | "REMAINS_UNKNOWN";
    receiptRef?: string | null;
    now: number;
  },
): { ok: boolean; httpStatus: 200 | 403 | 404 | 409; code: string; state?: EffectState; message: string } {
  if (!params.actorId || !params.evidenceRef) {
    throw new Error("Manual reconciliation requires actorId and evidenceRef");
  }
  return withImmediateTx(db, () => {
    const existing = db.prepare("SELECT * FROM effects WHERE effect_id = ?").get(params.effectId) as
      | EffectRow
      | undefined;
    if (!existing) {
      return {
        ok: false,
        httpStatus: 404,
        code: "effect_not_found",
        message: `Effect not found: ${params.effectId}`,
      };
    }

    const lineage = db
      .prepare(
        `SELECT p.runtime_epoch, p.scope_id, p.conversation_id
           FROM approvals a
           JOIN proposals p ON p.proposal_id = a.proposal_id
          WHERE a.approval_id = ?`,
      )
      .get(existing.approval_id) as { runtime_epoch: string; scope_id: string; conversation_id: string } | undefined;
    const scope = lineage
      ? (db.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(lineage.scope_id) as ScopeRow | undefined)
      : undefined;
    const convScope = lineage
      ? (db
          .prepare("SELECT principal_id FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?")
          .get(lineage.runtime_epoch, lineage.conversation_id) as { principal_id: string } | undefined)
      : undefined;

    if (
      !scope ||
      !isPrincipalAuthorizedForScope(scope, params.actorId) ||
      (convScope && convScope.principal_id !== params.actorId)
    ) {
      writeAuditEvent(db, {
        entityType: "effect",
        entityId: params.effectId,
        eventKey: `reconcile_forbidden:${params.actorId}:${params.now}`,
        eventType: "effect_reconcile_forbidden",
        occurredAt: params.now,
        details: { actorId: params.actorId, scopeId: lineage?.scope_id ?? null },
      });
      return {
        ok: false,
        httpStatus: 403,
        code: "forbidden",
        state: existing.state,
        message: `Principal ${params.actorId} is not authorized to reconcile effect ${params.effectId}`,
      };
    }

    if (existing.state !== "UNKNOWN") {
      return {
        ok: false,
        httpStatus: 409,
        code: "effect_not_unknown",
        state: existing.state,
        message: `Effect is ${existing.state}, not UNKNOWN`,
      };
    }
    let nextState: EffectState = "UNKNOWN";
    if (params.conclusion === "CONFIRMED_SUCCEEDED") {
      nextState = "SUCCEEDED";
    } else if (params.conclusion === "CONFIRMED_NOT_SENT") {
      nextState = "FAILED";
    }
    db.prepare(
      `UPDATE effects
          SET state = ?,
              receipt_ref = COALESCE(?, receipt_ref),
              reconciled_by = ?,
              reconciled_at = ?,
              reconcile_evidence = ?,
              reason = ?
        WHERE effect_id = ? AND state = 'UNKNOWN'`,
    ).run(
      nextState,
      params.receiptRef ?? null,
      params.actorId,
      params.now,
      params.evidenceRef,
      `reconciled:${params.conclusion}`,
      params.effectId,
    );
    writeAuditEvent(db, {
      entityType: "effect",
      entityId: params.effectId,
      eventKey: `reconcile:${params.effectId}:${params.now}`,
      eventType: "effect_reconciled_manually",
      occurredAt: params.now,
      evidenceRef: params.evidenceRef,
      details: {
        actorId: params.actorId,
        conclusion: params.conclusion,
        nextState,
        receiptRef: params.receiptRef ?? null,
      },
    });
    return { ok: true, httpStatus: 200, code: "reconciled", state: nextState, message: `Reconciled to ${nextState}` };
  });
}

/**
 * E08: Cancel / revoke a scope in the same governance write serialization as claim CAS.
 * Enforces principal authorization on the target scope before mutating any governance row.
 * Increments scope_epoch, quarantines READY effects, isolates pending outbox rows,
 * and honestly retains already-SUBMITTING/UNKNOWN effects for reconciliation.
 */
export function revokeOrCancelScope(
  db: DatabaseSync,
  params: {
    scopeId: string;
    actorId: string;
    reason: string;
    markCancelled?: boolean;
    now: number;
  },
): {
  ok: boolean;
  httpStatus: 200 | 403 | 404;
  code: string;
  message?: string;
  newScopeEpoch: number;
  quarantinedReadyEffectIds: string[];
  retainedCommittedEffectIds: string[];
} {
  return withImmediateTx(db, () => {
    const scope = db.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(params.scopeId) as
      | ScopeRow
      | undefined;
    if (!scope) {
      return {
        ok: false,
        httpStatus: 404,
        code: "scope_not_found",
        message: `Scope not found: ${params.scopeId}`,
        newScopeEpoch: 0,
        quarantinedReadyEffectIds: [],
        retainedCommittedEffectIds: [],
      };
    }
    if (!isPrincipalAuthorizedForScope(scope, params.actorId)) {
      writeAuditEvent(db, {
        entityType: "scope",
        entityId: params.scopeId,
        eventKey: `revoke_forbidden:${params.actorId}:${params.now}`,
        eventType: "scope_revoke_forbidden",
        occurredAt: params.now,
        details: { actorId: params.actorId, scopeId: params.scopeId },
      });
      return {
        ok: false,
        httpStatus: 403,
        code: "forbidden",
        message: `Principal ${params.actorId} is not authorized to revoke scope ${params.scopeId}`,
        newScopeEpoch: scope.scope_epoch,
        quarantinedReadyEffectIds: [],
        retainedCommittedEffectIds: [],
      };
    }
    const newScopeEpoch = scope.scope_epoch + 1;
    db.prepare("UPDATE scopes SET scope_epoch = ?, cancelled = ? WHERE scope_id = ?").run(
      newScopeEpoch,
      params.markCancelled ? 1 : scope.cancelled,
      params.scopeId,
    );

    const readyEffects = db
      .prepare(
        `SELECT e.effect_id FROM effects e
           JOIN approvals a ON a.approval_id = e.approval_id
           JOIN proposals p ON p.proposal_id = a.proposal_id
          WHERE p.scope_id = ? AND e.state = 'READY'`,
      )
      .all(params.scopeId) as Array<{ effect_id: string }>;

    const quarantinedReadyEffectIds: string[] = [];
    for (const r of readyEffects) {
      const ch = db
        .prepare("UPDATE effects SET state = 'QUARANTINED', reason = ? WHERE effect_id = ? AND state = 'READY'")
        .run(`scope_revoked:${params.reason}`, r.effect_id);
      if (Number(ch.changes) === 1) {
        quarantinedReadyEffectIds.push(r.effect_id);
      }
    }

    const retained = db
      .prepare(
        `SELECT e.effect_id FROM effects e
           JOIN approvals a ON a.approval_id = e.approval_id
           JOIN proposals p ON p.proposal_id = a.proposal_id
          WHERE p.scope_id = ? AND e.state IN ('SUBMITTING','UNKNOWN')`,
      )
      .all(params.scopeId) as Array<{ effect_id: string }>;
    const retainedCommittedEffectIds = retained.map((r) => r.effect_id);

    db.prepare(
      `UPDATE signal_outbox
          SET state = 'ISOLATED', reason = ?, updated_at = ?
        WHERE state = 'PENDING' AND approval_id IN (
          SELECT a.approval_id FROM approvals a
            JOIN proposals p ON p.proposal_id = a.proposal_id
           WHERE p.scope_id = ?
        )`,
    ).run(`scope_revoked:${params.reason}`, params.now, params.scopeId);

    writeAuditEvent(db, {
      entityType: "scope",
      entityId: params.scopeId,
      eventKey: `revoke:${params.scopeId}:e${newScopeEpoch}`,
      eventType: "scope_revoked",
      occurredAt: params.now,
      details: {
        actorId: params.actorId,
        reason: params.reason,
        newScopeEpoch,
        quarantinedReadyEffectIds,
        retainedCommittedEffectIds,
      },
    });

    return {
      ok: true,
      httpStatus: 200,
      code: "revoked",
      newScopeEpoch,
      quarantinedReadyEffectIds,
      retainedCommittedEffectIds,
    };
  });
}

export function countSuccessfulClaimsForEffect(db: DatabaseSync, effectId: string): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM audit_events
        WHERE entity_type = 'effect' AND entity_id = ? AND event_type = 'effect_claimed'`,
    )
    .get(effectId) as { n: number };
  return row.n;
}
