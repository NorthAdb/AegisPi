import type { DatabaseSync } from "node:sqlite";
import {
  buildCanonicalDraft,
  canonicalJson,
  digestSecret,
  mintId,
  mintNonce,
  sha256Hex,
} from "./canonical.ts";
import { withImmediateTx, writeAuditEvent } from "./db.ts";

export type ApprovalState = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "SUPERSEDED";
export type DecisionChoice = "APPROVE" | "REJECT";

export interface ScopeRow {
  scope_id: string;
  scope_epoch: number;
  policy_version: number;
  cancelled: number;
  allowed_principals_json: string;
  allowed_tools_json: string;
  allowed_targets_json: string;
}

export interface ProposalRow {
  proposal_id: string;
  runtime_epoch: string;
  conversation_id: string;
  tool_task_id: string;
  call_id: string;
  scope_id: string;
  tool_name: string;
  target: string;
  head_rev: number;
  cancelled: number;
  created_at: number;
}

export interface DraftRevisionRow {
  proposal_id: string;
  revision: number;
  canonical_snapshot: string;
  action_hash: string;
  scope_epoch: number;
  policy_version: number;
  created_at: number;
}

export interface ApprovalRow {
  approval_id: string;
  proposal_id: string;
  revision: number;
  nonce_digest: string;
  expires_at: number;
  state: ApprovalState;
  principal_id: string | null;
  decision_key: string | null;
  decision_digest: string | null;
  receipt: string | null;
  decided_at: number | null;
}

export function signalKeyFor(runtimeEpoch: string, proposalId: string, revision: number): string {
  return `sig:${runtimeEpoch}:${proposalId}:r${revision}`;
}

export function ensureScope(
  db: DatabaseSync,
  params: {
    scopeId: string;
    scopeEpoch?: number;
    policyVersion?: number;
    allowedPrincipals: string[];
    allowedTools: string[];
    allowedTargets: string[];
  },
): ScopeRow {
  db.prepare(
    `INSERT OR IGNORE INTO scopes(
       scope_id, scope_epoch, policy_version, cancelled,
       allowed_principals_json, allowed_tools_json, allowed_targets_json
     ) VALUES (?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    params.scopeId,
    params.scopeEpoch ?? 1,
    params.policyVersion ?? 1,
    JSON.stringify(params.allowedPrincipals),
    JSON.stringify(params.allowedTools),
    JSON.stringify(params.allowedTargets),
  );
  return db.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(params.scopeId) as unknown as ScopeRow;
}

export function registerConversationScope(
  db: DatabaseSync,
  params: {
    conversationId: string;
    scopeId: string;
    principalId: string;
    runtimeEpoch: string;
    now: number;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO conversation_scopes(runtime_epoch, conversation_id, scope_id, principal_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(params.runtimeEpoch, params.conversationId, params.scopeId, params.principalId, params.now);
}

export function isPrincipalAuthorizedForScope(scope: ScopeRow, principalId: string): boolean {
  try {
    const list = JSON.parse(scope.allowed_principals_json) as string[];
    return Array.isArray(list) && list.includes(principalId);
  } catch {
    return false;
  }
}

export interface ProposeToolActionParams {
  runtimeEpoch: string;
  conversationId: string;
  toolTaskId: string;
  callId: string;
  scopeId: string;
  toolName: string;
  target: string;
  payload: Record<string, unknown>;
  expiresAt: number;
  now: number;
}

export interface ProposalSnapshot {
  created: boolean;
  proposal: ProposalRow;
  revision: DraftRevisionRow;
  approval: ApprovalRow;
  nonce: string | null;
  effect: {
    effect_id: string;
    approval_id: string;
    state: string;
    claimed_at: number | null;
    receipt_ref: string | null;
    reason: string | null;
  } | null;
}

/**
 * T1 (create): Idempotently create or fetch a logical proposal bound to
 * (runtime_epoch, conversation_id, tool_task_id, call_id).
 */
export function proposeOrGetApproval(
  db: DatabaseSync,
  params: ProposeToolActionParams,
): ProposalSnapshot {
  return withImmediateTx(db, () => {
    const existing = db
      .prepare(
        `SELECT * FROM proposals
          WHERE runtime_epoch = ? AND conversation_id = ? AND tool_task_id = ? AND call_id = ?`,
      )
      .get(
        params.runtimeEpoch,
        params.conversationId,
        params.toolTaskId,
        params.callId,
      ) as ProposalRow | undefined;

    if (existing) {
      const rev = db
        .prepare("SELECT * FROM draft_revisions WHERE proposal_id = ? AND revision = ?")
        .get(existing.proposal_id, existing.head_rev) as unknown as DraftRevisionRow;
      const apr = db
        .prepare("SELECT * FROM approvals WHERE proposal_id = ? AND revision = ?")
        .get(existing.proposal_id, existing.head_rev) as unknown as ApprovalRow;
      const challenge = db
        .prepare("SELECT nonce_value FROM approval_challenges WHERE approval_id = ?")
        .get(apr.approval_id) as { nonce_value: string } | undefined;
      const effect = db
        .prepare("SELECT * FROM effects WHERE approval_id = ?")
        .get(apr.approval_id) as ProposalSnapshot["effect"] | undefined;
      return {
        created: false,
        proposal: existing,
        revision: rev,
        approval: apr,
        nonce: challenge?.nonce_value ?? null,
        effect: effect ?? null,
      };
    }

    const scope = db.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(params.scopeId) as
      | ScopeRow
      | undefined;
    if (!scope) {
      throw new Error(`Scope not found: ${params.scopeId}`);
    }

    const proposalId = mintId("prp");
    const approvalId = mintId("apr");
    const nonce = mintNonce();
    const { canonicalSnapshot, actionHash } = buildCanonicalDraft({
      runtimeEpoch: params.runtimeEpoch,
      conversationId: params.conversationId,
      toolTaskId: params.toolTaskId,
      callId: params.callId,
      proposalId,
      revision: 1,
      tool: params.toolName,
      target: params.target,
      scopeId: params.scopeId,
      scopeEpoch: scope.scope_epoch,
      policyVersion: scope.policy_version,
      payload: params.payload,
    });

    db.prepare(
      `INSERT INTO proposals(
         proposal_id, runtime_epoch, conversation_id, tool_task_id, call_id,
         scope_id, tool_name, target, head_rev, cancelled, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
    ).run(
      proposalId,
      params.runtimeEpoch,
      params.conversationId,
      params.toolTaskId,
      params.callId,
      params.scopeId,
      params.toolName,
      params.target,
      params.now,
    );

    db.prepare(
      `INSERT INTO draft_revisions(
         proposal_id, revision, canonical_snapshot, action_hash, scope_epoch, policy_version, created_at
       ) VALUES (?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      proposalId,
      canonicalSnapshot,
      actionHash,
      scope.scope_epoch,
      scope.policy_version,
      params.now,
    );

    db.prepare(
      `INSERT INTO approvals(
         approval_id, proposal_id, revision, nonce_digest, expires_at, state
       ) VALUES (?, ?, 1, ?, ?, 'PENDING')`,
    ).run(approvalId, proposalId, digestSecret(nonce), params.expiresAt);

    db.prepare("INSERT INTO approval_challenges(approval_id, nonce_value) VALUES (?, ?)").run(
      approvalId,
      nonce,
    );

    writeAuditEvent(db, {
      entityType: "proposal",
      entityId: proposalId,
      eventKey: `create:${proposalId}:r1`,
      eventType: "proposal_created",
      occurredAt: params.now,
      details: {
        approvalId,
        revision: 1,
        actionHash,
        conversationId: params.conversationId,
        toolTaskId: params.toolTaskId,
        callId: params.callId,
        toolName: params.toolName,
        target: params.target,
      },
    });

    const proposal = db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId) as unknown as ProposalRow;
    const revision = db
      .prepare("SELECT * FROM draft_revisions WHERE proposal_id = ? AND revision = 1")
      .get(proposalId) as unknown as DraftRevisionRow;
    const approval = db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) as unknown as ApprovalRow;

    return {
      created: true,
      proposal,
      revision,
      approval,
      nonce,
      effect: null,
    };
  });
}

export interface SaveDraftRevisionResult {
  httpStatus: 200 | 403 | 404 | 409;
  ok: boolean;
  code?: string;
  message?: string;
  proposal?: ProposalRow;
  revision?: DraftRevisionRow;
  approval?: ApprovalRow;
  nonce?: string;
  quarantinedEffectIds?: string[];
  isolatedOutboxIds?: string[];
}

/**
 * T1 (edit): CAS on head_rev to append a new immutable draft_revision and fresh nonce.
 * Supersedes any old PENDING approval, and atomically quarantines any unclaimed READY
 * effect and isolates pending outbox rows from previous revisions.
 * Refuses edit (409) once any effect for this proposal has been claimed (SUBMITTING/SUCCEEDED/UNKNOWN).
 */
export function saveDraftRevision(
  db: DatabaseSync,
  params: {
    proposalId: string;
    conversationId: string;
    principalId: string;
    expectedHeadRev: number;
    target?: string;
    payload: Record<string, unknown>;
    expiresAt: number;
    now: number;
  },
): SaveDraftRevisionResult {
  return withImmediateTx(db, () => {
    const proposal = db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(params.proposalId) as
      | ProposalRow
      | undefined;
    if (!proposal) {
      return { httpStatus: 404, ok: false, code: "proposal_not_found", message: "Proposal not found" };
    }
    const scope = db.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(proposal.scope_id) as
      | ScopeRow
      | undefined;
    const convScope = db
      .prepare("SELECT principal_id FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?")
      .get(proposal.runtime_epoch, proposal.conversation_id) as { principal_id: string } | undefined;
    if (
      !scope ||
      !isPrincipalAuthorizedForScope(scope, params.principalId) ||
      proposal.conversation_id !== params.conversationId ||
      (convScope && convScope.principal_id !== params.principalId)
    ) {
      return {
        httpStatus: 403,
        ok: false,
        code: "forbidden",
        message: "Principal or conversation is not authorized for this proposal",
      };
    }
    const epochRow = db
      .prepare("SELECT status FROM runtime_epochs WHERE runtime_epoch = ?")
      .get(proposal.runtime_epoch) as { status: string } | undefined;
    if (!epochRow || epochRow.status !== "ACTIVE") {
      return { httpStatus: 409, ok: false, code: "runtime_epoch_retired", message: "Proposal belongs to a retired runtime epoch" };
    }
    if (proposal.cancelled === 1 || scope.cancelled === 1) {
      return { httpStatus: 409, ok: false, code: "cancelled", message: "Proposal or scope is cancelled" };
    }

    // Once any effect for this proposal has been claimed, editing is forbidden; caller must open a new proposal.
    const claimedEffect = db
      .prepare(
        `SELECT e.effect_id, e.state FROM effects e
           JOIN approvals a ON a.approval_id = e.approval_id
          WHERE a.proposal_id = ? AND e.state IN ('SUBMITTING','SUCCEEDED','UNKNOWN')
          LIMIT 1`,
      )
      .get(params.proposalId) as { effect_id: string; state: string } | undefined;
    if (claimedEffect) {
      return {
        httpStatus: 409,
        ok: false,
        code: "already_claimed",
        message: `Effect ${claimedEffect.effect_id} is already ${claimedEffect.state}; create a new proposal instead`,
      };
    }

    if (proposal.head_rev !== params.expectedHeadRev) {
      return {
        httpStatus: 409,
        ok: false,
        code: "stale_revision",
        message: `Expected head_rev ${params.expectedHeadRev}, current is ${proposal.head_rev}`,
      };
    }

    const newRev = proposal.head_rev + 1;
    const newTarget = params.target ?? proposal.target;

    const updated = db
      .prepare("UPDATE proposals SET head_rev = ?, target = ? WHERE proposal_id = ? AND head_rev = ?")
      .run(newRev, newTarget, params.proposalId, params.expectedHeadRev);
    if (Number(updated.changes) !== 1) {
      return { httpStatus: 409, ok: false, code: "cas_conflict", message: "Concurrent revision edit" };
    }

    // Supersede any prior PENDING approval
    const oldPending = db
      .prepare("SELECT approval_id FROM approvals WHERE proposal_id = ? AND state = 'PENDING'")
      .all(params.proposalId) as Array<{ approval_id: string }>;
    for (const row of oldPending) {
      db.prepare("UPDATE approvals SET state = 'SUPERSEDED' WHERE approval_id = ? AND state = 'PENDING'").run(
        row.approval_id,
      );
      db.prepare("DELETE FROM approval_challenges WHERE approval_id = ?").run(row.approval_id);
    }

    // Quarantine any unclaimed READY effect and isolate any pending outbox rows of older revisions
    const oldReadyEffects = db
      .prepare(
        `SELECT e.effect_id FROM effects e
           JOIN approvals a ON a.approval_id = e.approval_id
          WHERE a.proposal_id = ? AND e.state = 'READY'`,
      )
      .all(params.proposalId) as Array<{ effect_id: string }>;
    const quarantinedEffectIds: string[] = [];
    for (const e of oldReadyEffects) {
      const ch = db
        .prepare("UPDATE effects SET state = 'QUARANTINED', reason = ? WHERE effect_id = ? AND state = 'READY'")
        .run(`superseded_by_revision_${newRev}`, e.effect_id);
      if (Number(ch.changes) === 1) {
        quarantinedEffectIds.push(e.effect_id);
        writeAuditEvent(db, {
          entityType: "effect",
          entityId: e.effect_id,
          eventKey: `quarantine:edit:${newRev}`,
          eventType: "effect_quarantined",
          occurredAt: params.now,
          details: { reason: `superseded_by_revision_${newRev}`, proposalId: params.proposalId },
        });
      }
    }

    const oldPendingOutbox = db
      .prepare(
        `SELECT o.approval_id FROM signal_outbox o
           JOIN approvals a ON a.approval_id = o.approval_id
          WHERE a.proposal_id = ? AND o.state = 'PENDING'`,
      )
      .all(params.proposalId) as Array<{ approval_id: string }>;
    const isolatedOutboxIds: string[] = [];
    for (const o of oldPendingOutbox) {
      const ch = db
        .prepare(
          `UPDATE signal_outbox
              SET state = 'ISOLATED', reason = ?, updated_at = ?
            WHERE approval_id = ? AND state = 'PENDING'`,
        )
        .run(`superseded_by_revision_${newRev}`, params.now, o.approval_id);
      if (Number(ch.changes) === 1) {
        isolatedOutboxIds.push(o.approval_id);
      }
    }

    const { canonicalSnapshot, actionHash } = buildCanonicalDraft({
      runtimeEpoch: proposal.runtime_epoch,
      conversationId: proposal.conversation_id,
      toolTaskId: proposal.tool_task_id,
      callId: proposal.call_id,
      proposalId: proposal.proposal_id,
      revision: newRev,
      tool: proposal.tool_name,
      target: newTarget,
      scopeId: proposal.scope_id,
      scopeEpoch: scope.scope_epoch,
      policyVersion: scope.policy_version,
      payload: params.payload,
    });

    db.prepare(
      `INSERT INTO draft_revisions(
         proposal_id, revision, canonical_snapshot, action_hash, scope_epoch, policy_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      proposal.proposal_id,
      newRev,
      canonicalSnapshot,
      actionHash,
      scope.scope_epoch,
      scope.policy_version,
      params.now,
    );

    const newApprovalId = mintId("apr");
    const newNonce = mintNonce();
    db.prepare(
      `INSERT INTO approvals(
         approval_id, proposal_id, revision, nonce_digest, expires_at, state
       ) VALUES (?, ?, ?, ?, ?, 'PENDING')`,
    ).run(newApprovalId, proposal.proposal_id, newRev, digestSecret(newNonce), params.expiresAt);
    db.prepare("INSERT INTO approval_challenges(approval_id, nonce_value) VALUES (?, ?)").run(
      newApprovalId,
      newNonce,
    );

    writeAuditEvent(db, {
      entityType: "proposal",
      entityId: proposal.proposal_id,
      eventKey: `edit:${proposal.proposal_id}:r${newRev}`,
      eventType: "draft_revision_saved",
      occurredAt: params.now,
      details: {
        newRev,
        newApprovalId,
        actionHash,
        quarantinedEffectIds,
        isolatedOutboxIds,
      },
    });

    const updatedProposal = db
      .prepare("SELECT * FROM proposals WHERE proposal_id = ?")
      .get(proposal.proposal_id) as unknown as ProposalRow;
    const newRevision = db
      .prepare("SELECT * FROM draft_revisions WHERE proposal_id = ? AND revision = ?")
      .get(proposal.proposal_id, newRev) as unknown as DraftRevisionRow;
    const newApproval = db
      .prepare("SELECT * FROM approvals WHERE approval_id = ?")
      .get(newApprovalId) as unknown as ApprovalRow;

    return {
      httpStatus: 200,
      ok: true,
      proposal: updatedProposal,
      revision: newRevision,
      approval: newApproval,
      nonce: newNonce,
      quarantinedEffectIds,
      isolatedOutboxIds,
    };
  });
}

export interface DecideApprovalParams {
  approvalId: string;
  conversationId: string;
  principalId: string;
  decision: DecisionChoice;
  expectedRevision: number;
  expectedActionHash: string;
  nonce: string;
  decisionKey: string;
  now: number;
  /** Test seam for E02: invoked inside T2 transaction after writes and before COMMIT. */
  injectCrashBeforeCommit?: () => void;
}

export interface DecideApprovalResult {
  httpStatus: 200 | 403 | 404 | 409 | 410;
  ok: boolean;
  idempotentReplay?: boolean;
  code: string;
  message: string;
  approvalId?: string;
  proposalId?: string;
  revision?: number;
  approvalState?: ApprovalState;
  effectId?: string | null;
  effectState?: string | null;
  signalKey?: string | null;
  receipt?: Record<string, unknown>;
}

/**
 * T2: Single-consume approval CAS transaction.
 * Atomically transitions PENDING -> APPROVED/REJECTED/EXPIRED, inserts unique READY
 * effect (only for APPROVED), and registers signal_outbox for runtime wakeup.
 */
export function decideApproval(
  db: DatabaseSync,
  params: DecideApprovalParams,
): DecideApprovalResult {
  if (params.decision !== "APPROVE" && params.decision !== "REJECT") {
    return {
      httpStatus: 409,
      ok: false,
      code: "invalid_decision",
      message: `Unsupported decision: ${String(params.decision)}`,
    };
  }

  const decisionDigest = sha256Hex(
    canonicalJson({
      approvalId: params.approvalId,
      conversationId: params.conversationId,
      decision: params.decision,
      expectedRevision: params.expectedRevision,
      expectedActionHash: params.expectedActionHash,
    }),
  );

  return withImmediateTx(db, () => {
    const approval = db
      .prepare("SELECT * FROM approvals WHERE approval_id = ?")
      .get(params.approvalId) as ApprovalRow | undefined;
    if (!approval) {
      return { httpStatus: 404, ok: false, code: "approval_not_found", message: "Approval not found" };
    }
    const proposal = db
      .prepare("SELECT * FROM proposals WHERE proposal_id = ?")
      .get(approval.proposal_id) as ProposalRow | undefined;
    if (!proposal) {
      return { httpStatus: 404, ok: false, code: "proposal_not_found", message: "Proposal not found" };
    }
    const scope = db.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(proposal.scope_id) as
      | ScopeRow
      | undefined;
    const convScope = db
      .prepare("SELECT principal_id FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?")
      .get(proposal.runtime_epoch, proposal.conversation_id) as { principal_id: string } | undefined;

    // 1. Authorization & conversation binding FIRST (before idempotency lookup!)
    if (
      !scope ||
      !isPrincipalAuthorizedForScope(scope, params.principalId) ||
      proposal.conversation_id !== params.conversationId ||
      (convScope && convScope.principal_id !== params.principalId)
    ) {
      writeAuditEvent(db, {
        entityType: "approval",
        entityId: params.approvalId,
        eventKey: `forbidden:${params.principalId}:${params.now}:${params.decisionKey}`,
        eventType: "approval_decision_forbidden",
        occurredAt: params.now,
        details: {
          principalId: params.principalId,
          requestedConversationId: params.conversationId,
          actualConversationId: proposal.conversation_id,
        },
      });
      return {
        httpStatus: 403,
        ok: false,
        code: "forbidden",
        message: "Principal or conversation is not authorized for this approval",
      };
    }

    // 2. Idempotent decisionKey lookup for this principal
    const existingByKey = db
      .prepare("SELECT * FROM approvals WHERE principal_id = ? AND decision_key = ?")
      .get(params.principalId, params.decisionKey) as ApprovalRow | undefined;
    if (existingByKey) {
      if (existingByKey.decision_digest === decisionDigest) {
        const eff = db
          .prepare("SELECT effect_id, state FROM effects WHERE approval_id = ?")
          .get(existingByKey.approval_id) as { effect_id: string; state: string } | undefined;
        const outbox = db
          .prepare("SELECT signal_key FROM signal_outbox WHERE approval_id = ?")
          .get(existingByKey.approval_id) as { signal_key: string } | undefined;
        return {
          httpStatus: 200,
          ok: true,
          idempotentReplay: true,
          code: "idempotent_replay",
          message: "Returning original decision receipt for decisionKey",
          approvalId: existingByKey.approval_id,
          proposalId: existingByKey.proposal_id,
          revision: existingByKey.revision,
          approvalState: existingByKey.state,
          effectId: eff?.effect_id ?? null,
          effectState: eff?.state ?? null,
          signalKey: outbox?.signal_key ?? null,
          receipt: existingByKey.receipt ? (JSON.parse(existingByKey.receipt) as Record<string, unknown>) : undefined,
        };
      }
      return {
        httpStatus: 409,
        ok: false,
        code: "decision_key_conflict",
        message: "decisionKey was already used for a different decision payload",
      };
    }

    const draft = db
      .prepare("SELECT * FROM draft_revisions WHERE proposal_id = ? AND revision = ?")
      .get(approval.proposal_id, approval.revision) as unknown as DraftRevisionRow;

    // 3. Expiry handling (410)
    if (approval.state === "EXPIRED") {
      return {
        httpStatus: 410,
        ok: false,
        code: "approval_expired",
        message: "Approval has expired",
        approvalId: approval.approval_id,
        approvalState: "EXPIRED",
      };
    }
    if (approval.state === "PENDING" && params.now >= approval.expires_at) {
      db.prepare("UPDATE approvals SET state = 'EXPIRED', decided_at = ? WHERE approval_id = ? AND state = 'PENDING'").run(
        params.now,
        approval.approval_id,
      );
      db.prepare("DELETE FROM approval_challenges WHERE approval_id = ?").run(approval.approval_id);
      const sigKey = signalKeyFor(proposal.runtime_epoch, proposal.proposal_id, approval.revision);
      db.prepare(
        `INSERT OR IGNORE INTO signal_outbox(approval_id, signal_key, state, reason, attempts, updated_at)
         VALUES (?, ?, 'PENDING', 'expired', 0, ?)`,
      ).run(approval.approval_id, sigKey, params.now);
      writeAuditEvent(db, {
        entityType: "approval",
        entityId: approval.approval_id,
        eventKey: `expired:${approval.approval_id}`,
        eventType: "approval_expired",
        occurredAt: params.now,
        details: { proposalId: proposal.proposal_id, revision: approval.revision },
      });
      return {
        httpStatus: 410,
        ok: false,
        code: "approval_expired",
        message: "Approval expired before decision",
        approvalId: approval.approval_id,
        proposalId: proposal.proposal_id,
        revision: approval.revision,
        approvalState: "EXPIRED",
        effectId: null,
        effectState: null,
        signalKey: sigKey,
      };
    }

    // 4. State, revision, hash, nonce, and scope checks (409)
    if (approval.state !== "PENDING") {
      return {
        httpStatus: 409,
        ok: false,
        code: "approval_not_pending",
        message: `Approval is already ${approval.state}`,
        approvalId: approval.approval_id,
        approvalState: approval.state,
      };
    }
    if (params.expectedRevision !== proposal.head_rev || params.expectedRevision !== approval.revision) {
      return {
        httpStatus: 409,
        ok: false,
        code: "stale_revision",
        message: `Stale revision ${params.expectedRevision}; current head revision is ${proposal.head_rev}`,
      };
    }
    if (params.expectedActionHash !== draft.action_hash) {
      return {
        httpStatus: 409,
        ok: false,
        code: "action_hash_mismatch",
        message: "Expected actionHash does not match canonical draft revision",
      };
    }
    if (digestSecret(params.nonce) !== approval.nonce_digest) {
      return {
        httpStatus: 409,
        ok: false,
        code: "nonce_mismatch",
        message: "Invalid or stale approval nonce",
      };
    }
    const epochRow = db
      .prepare("SELECT status FROM runtime_epochs WHERE runtime_epoch = ?")
      .get(proposal.runtime_epoch) as { status: string } | undefined;
    if (!epochRow || epochRow.status !== "ACTIVE") {
      return {
        httpStatus: 409,
        ok: false,
        code: "runtime_epoch_retired",
        message: "Approval belongs to a retired runtime epoch",
      };
    }
    if (
      proposal.cancelled === 1 ||
      scope.cancelled === 1 ||
      scope.scope_epoch !== draft.scope_epoch ||
      scope.policy_version !== draft.policy_version
    ) {
      return {
        httpStatus: 409,
        ok: false,
        code: "context_changed",
        message: "Scope, policy version, or cancellation state changed since draft was created",
      };
    }

    // 5. Atomic CAS consume + optional READY effect + signal_outbox
    const nextState: ApprovalState = params.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const effectId = params.decision === "APPROVE" ? mintId("efx") : null;
    const signalKey = signalKeyFor(proposal.runtime_epoch, proposal.proposal_id, approval.revision);
    const receiptObj = {
      approvalId: approval.approval_id,
      proposalId: proposal.proposal_id,
      revision: approval.revision,
      actionHash: draft.action_hash,
      decision: params.decision,
      approvalState: nextState,
      effectId,
      principalId: params.principalId,
      decisionKey: params.decisionKey,
      decidedAt: params.now,
    };

    const cas = db
      .prepare(
        `UPDATE approvals
            SET state = ?, principal_id = ?, decision_key = ?, decision_digest = ?, receipt = ?, decided_at = ?
          WHERE approval_id = ? AND state = 'PENDING'`,
      )
      .run(
        nextState,
        params.principalId,
        params.decisionKey,
        decisionDigest,
        JSON.stringify(receiptObj),
        params.now,
        approval.approval_id,
      );
    if (Number(cas.changes) !== 1) {
      return {
        httpStatus: 409,
        ok: false,
        code: "cas_conflict",
        message: "Concurrent decision consumed this approval",
      };
    }

    db.prepare("DELETE FROM approval_challenges WHERE approval_id = ?").run(approval.approval_id);

    if (effectId !== null) {
      db.prepare(
        `INSERT INTO effects(effect_id, approval_id, state, claimed_at, receipt_ref, reason)
         VALUES (?, ?, 'READY', NULL, NULL, NULL)`,
      ).run(effectId, approval.approval_id);
    }

    db.prepare(
      `INSERT INTO signal_outbox(approval_id, signal_key, state, sdk_result, reason, attempts, updated_at)
       VALUES (?, ?, 'PENDING', NULL, NULL, 0, ?)`,
    ).run(approval.approval_id, signalKey, params.now);

    writeAuditEvent(db, {
      entityType: "approval",
      entityId: approval.approval_id,
      eventKey: `decide:${approval.approval_id}:${nextState}`,
      eventType: nextState === "APPROVED" ? "approval_approved" : "approval_rejected",
      occurredAt: params.now,
      details: receiptObj,
    });

    // E02 deterministic crash-before-commit seam
    if (params.injectCrashBeforeCommit) {
      params.injectCrashBeforeCommit();
    }

    return {
      httpStatus: 200,
      ok: true,
      idempotentReplay: false,
      code: nextState === "APPROVED" ? "approved" : "rejected",
      message: nextState === "APPROVED" ? "Approval recorded and effect marked READY" : "Approval rejected",
      approvalId: approval.approval_id,
      proposalId: proposal.proposal_id,
      revision: approval.revision,
      approvalState: nextState,
      effectId,
      effectState: effectId ? "READY" : null,
      signalKey,
      receipt: receiptObj,
    };
  });
}

/**
 * Expire all PENDING approvals whose expires_at <= now and queue wakeup outbox entries.
 */
export function expireOverdueApprovals(db: DatabaseSync, now: number): string[] {
  return withImmediateTx(db, () => {
    const overdue = db
      .prepare(
        `SELECT a.approval_id, a.proposal_id, a.revision, p.runtime_epoch
           FROM approvals a
           JOIN proposals p ON p.proposal_id = a.proposal_id
          WHERE a.state = 'PENDING' AND a.expires_at <= ?`,
      )
      .all(now) as Array<{
      approval_id: string;
      proposal_id: string;
      revision: number;
      runtime_epoch: string;
    }>;

    const expiredIds: string[] = [];
    for (const row of overdue) {
      const ch = db
        .prepare("UPDATE approvals SET state = 'EXPIRED', decided_at = ? WHERE approval_id = ? AND state = 'PENDING'")
        .run(now, row.approval_id);
      if (Number(ch.changes) !== 1) continue;
      db.prepare("DELETE FROM approval_challenges WHERE approval_id = ?").run(row.approval_id);
      const sigKey = signalKeyFor(row.runtime_epoch, row.proposal_id, row.revision);
      db.prepare(
        `INSERT OR IGNORE INTO signal_outbox(approval_id, signal_key, state, reason, attempts, updated_at)
         VALUES (?, ?, 'PENDING', 'expired', 0, ?)`,
      ).run(row.approval_id, sigKey, now);
      writeAuditEvent(db, {
        entityType: "approval",
        entityId: row.approval_id,
        eventKey: `expired:${row.approval_id}`,
        eventType: "approval_expired",
        occurredAt: now,
        details: { proposalId: row.proposal_id, revision: row.revision },
      });
      expiredIds.push(row.approval_id);
    }
    return expiredIds;
  });
}

export interface ApprovedSnapshotForReentry {
  state: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "SUPERSEDED" | "CANCELLED";
  proposalId: string;
  approvalId: string;
  revision: number;
  actionHash: string;
  canonicalSnapshot: string;
  parsedSnapshot: Record<string, unknown>;
  effectId: string | null;
  effectState: string | null;
  signalKey: string;
}

/**
 * Called by beforeTool on initial invocation or re-entry after wakeup.
 * Reads authoritative governance state (never trusting signal payload for parameters).
 */
export function readProposalGovernanceState(
  db: DatabaseSync,
  params: {
    runtimeEpoch: string;
    conversationId: string;
    toolTaskId: string;
    callId: string;
  },
): ApprovedSnapshotForReentry | null {
  const proposal = db
    .prepare(
      `SELECT * FROM proposals
        WHERE runtime_epoch = ? AND conversation_id = ? AND tool_task_id = ? AND call_id = ?`,
    )
    .get(
      params.runtimeEpoch,
      params.conversationId,
      params.toolTaskId,
      params.callId,
    ) as ProposalRow | undefined;
  if (!proposal) return null;

  const draft = db
    .prepare("SELECT * FROM draft_revisions WHERE proposal_id = ? AND revision = ?")
    .get(proposal.proposal_id, proposal.head_rev) as unknown as DraftRevisionRow;
  const approval = db
    .prepare("SELECT * FROM approvals WHERE proposal_id = ? AND revision = ?")
    .get(proposal.proposal_id, proposal.head_rev) as unknown as ApprovalRow;
  const effect = db
    .prepare("SELECT effect_id, state FROM effects WHERE approval_id = ?")
    .get(approval.approval_id) as { effect_id: string; state: string } | undefined;
  const scope = db.prepare("SELECT cancelled FROM scopes WHERE scope_id = ?").get(proposal.scope_id) as {
    cancelled: number;
  };

  const effectiveState =
    proposal.cancelled === 1 || scope.cancelled === 1 ? "CANCELLED" : approval.state;

  return {
    state: effectiveState,
    proposalId: proposal.proposal_id,
    approvalId: approval.approval_id,
    revision: approval.revision,
    actionHash: draft.action_hash,
    canonicalSnapshot: draft.canonical_snapshot,
    parsedSnapshot: JSON.parse(draft.canonical_snapshot) as Record<string, unknown>,
    effectId: effect?.effect_id ?? null,
    effectState: effect?.state ?? null,
    signalKey: signalKeyFor(proposal.runtime_epoch, proposal.proposal_id, approval.revision),
  };
}

export interface ApprovalChallengeResult {
  httpStatus: 200 | 403 | 404 | 409 | 410;
  ok: boolean;
  code: string;
  message?: string;
  approvalId?: string;
  proposalId?: string;
  revision?: number;
  actionHash?: string;
  nonce?: string;
}

/**
 * Dedicated authorized challenge lookup for the decision UI/API (G3).
 * Never exposed on SSE streams, URLs, or general snapshots.
 */
export function fetchAuthorizedApprovalChallenge(
  db: DatabaseSync,
  params: {
    approvalId: string;
    conversationId: string;
    principalId: string;
    now: number;
  },
): ApprovalChallengeResult {
  const approval = db
    .prepare("SELECT * FROM approvals WHERE approval_id = ?")
    .get(params.approvalId) as ApprovalRow | undefined;
  if (!approval) {
    return { httpStatus: 404, ok: false, code: "approval_not_found", message: "Approval not found" };
  }
  const proposal = db
    .prepare("SELECT * FROM proposals WHERE proposal_id = ?")
    .get(approval.proposal_id) as ProposalRow | undefined;
  if (!proposal) {
    return { httpStatus: 404, ok: false, code: "proposal_not_found", message: "Proposal not found" };
  }
  const scope = db.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(proposal.scope_id) as
    | ScopeRow
    | undefined;
  const convScope = db
    .prepare("SELECT principal_id FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?")
    .get(proposal.runtime_epoch, proposal.conversation_id) as { principal_id: string } | undefined;

  if (
    !scope ||
    !isPrincipalAuthorizedForScope(scope, params.principalId) ||
    proposal.conversation_id !== params.conversationId ||
    (convScope && convScope.principal_id !== params.principalId)
  ) {
    return {
      httpStatus: 403,
      ok: false,
      code: "forbidden",
      message: "Principal or conversation is not authorized to retrieve this approval challenge",
    };
  }
  const epochRow = db
    .prepare("SELECT status FROM runtime_epochs WHERE runtime_epoch = ?")
    .get(proposal.runtime_epoch) as { status: string } | undefined;
  if (!epochRow || epochRow.status !== "ACTIVE") {
    return { httpStatus: 409, ok: false, code: "runtime_epoch_retired", message: "Runtime epoch is retired" };
  }
  if (approval.state === "EXPIRED" || (approval.state === "PENDING" && params.now >= approval.expires_at)) {
    return { httpStatus: 410, ok: false, code: "approval_expired", message: "Approval has expired" };
  }
  if (approval.state !== "PENDING") {
    return {
      httpStatus: 409,
      ok: false,
      code: "approval_not_pending",
      message: `Approval is ${approval.state}, not PENDING`,
    };
  }
  const draft = db
    .prepare("SELECT action_hash FROM draft_revisions WHERE proposal_id = ? AND revision = ?")
    .get(approval.proposal_id, approval.revision) as { action_hash: string } | undefined;
  const challenge = db
    .prepare("SELECT nonce_value FROM approval_challenges WHERE approval_id = ?")
    .get(approval.approval_id) as { nonce_value: string } | undefined;
  if (!draft || !challenge) {
    return { httpStatus: 409, ok: false, code: "challenge_unavailable", message: "Approval challenge unavailable" };
  }
  return {
    httpStatus: 200,
    ok: true,
    code: "ok",
    approvalId: approval.approval_id,
    proposalId: proposal.proposal_id,
    revision: approval.revision,
    actionHash: draft.action_hash,
    nonce: challenge.nonce_value,
  };
}
