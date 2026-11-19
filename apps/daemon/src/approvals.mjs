// Approvals per 06 section 5. One approval, bound to an immutable canonical
// action. The consume path is a single BEGIN IMMEDIATE that re-verifies the
// approver identity, the action hash, the nonce, the expiry, and the current
// attempt/fence/epoch/policy/ACL revisions, then CASes three rows
// (approval WAITING->CONSUMED, effect WAITING_APPROVAL->READY, task
// WAITING_APPROVAL->WAITING_EFFECT). Any check or CAS count that is not 1
// rolls the whole transaction back: a double click returns "already
// processed", a changed context returns "needs re-approval". Consuming an
// approval is NOT an external submission — the dispatcher still owns that.

import { createHash, randomBytes } from "node:crypto";
import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent, authorizationRevision } from "./audit.mjs";
import { crashpoint } from "./testing/crashpoints.mjs";

export class ApprovalError extends Error {}

export function nonceHashFor(nonce) {
  return createHash("sha256").update(String(nonce), "utf8").digest("hex");
}

export function mintNonce() {
  return randomBytes(16).toString("hex");
}

export function approvalIdFor(effectId) {
  return `apr:${effectId}`;
}

export function hasApproveGrant(db, { scopeId, principalId, now }) {
  const row = db
    .prepare(
      `SELECT 1 FROM acl_grants
        WHERE scope_id=? AND principal_id=? AND permission='approve'
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)
        LIMIT 1`,
    )
    .get(scopeId, principalId, now);
  return row !== undefined;
}

export function createApprovalRow(db, {
  effectId,
  actionHash,
  approverId,
  attemptId,
  proposalFence,
  scopeEpoch,
  authorizationRevisionValue,
  policyVersion,
  expiresAt,
  now,
}) {
  const id = approvalIdFor(effectId);
  const nonce = mintNonce();
  db.prepare(
    `INSERT INTO approvals(id, effect_id, action_hash, approver_id, attempt_id, proposal_fence,
       scope_epoch, authorization_revision, policy_version, expires_at, state, nonce_hash, consumed_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'WAITING', ?, NULL, ?)`,
  ).run(
    id,
    effectId,
    actionHash,
    approverId,
    attemptId,
    proposalFence,
    scopeEpoch,
    authorizationRevisionValue,
    policyVersion,
    expiresAt,
    nonceHashFor(nonce),
    now,
  );
  return { approvalId: id, nonce };
}

function verifyDecision(db, { approval, actionHash, nonce, approverId, now }) {
  if (approval.state !== "WAITING") {
    return { ok: false, reason: `already ${approval.state}` };
  }
  if (approverId !== approval.approver_id) {
    return { ok: false, reason: "callback is not the designated approver" };
  }
  if (now >= approval.expires_at) {
    return { ok: false, reason: "expired" };
  }
  if (actionHash !== approval.action_hash) {
    return { ok: false, reason: "action hash mismatch" };
  }
  if (nonceHashFor(nonce) !== approval.nonce_hash) {
    return { ok: false, reason: "nonce mismatch" };
  }
  return { ok: true };
}

function verifyContext(db, { approval, effect, now }) {
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(effect.task_id);
  const scope = db.prepare("SELECT * FROM scopes WHERE id=?").get(effect.scope_id);
  if (task.fence !== effect.proposal_fence) {
    return { ok: false, reason: `task fence moved to ${task.fence}; action was proposed under ${effect.proposal_fence}` };
  }
  if (scope.epoch !== approval.scope_epoch) {
    return { ok: false, reason: `scope epoch moved to ${scope.epoch}` };
  }
  if (scope.policy_version !== approval.policy_version) {
    return { ok: false, reason: "policy version changed" };
  }
  if (authorizationRevision(db) !== approval.authorization_revision) {
    return { ok: false, reason: "authorization revision changed" };
  }
  return { ok: true };
}

// The one CAS transaction of 06 section 5.
export function decideApproval(db, { approvalId, decision, actionHash, nonce, approverId, now }) {
  if (decision !== "approve" && decision !== "reject") {
    throw new ApprovalError(`decision must be approve/reject, got ${decision}`);
  }
  const result = withTx(db, () => {
    const approval = db.prepare("SELECT * FROM approvals WHERE id=?").get(approvalId);
    if (!approval) throw new ApprovalError(`approval ${approvalId} not found`);
    const effect = db.prepare("SELECT * FROM effects WHERE id=?").get(approval.effect_id);
    if (!effect) throw new ApprovalError(`effect ${approval.effect_id} missing`);
    const decisionOk = verifyDecision(db, { approval, actionHash, nonce, approverId, now });
    if (!decisionOk.ok) {
      // Not an error to arrive late or with a stale card: report, change
      // nothing. A mismatched hash/nonce/approver is recorded loudly.
      writeAudit(db, {
        code: decisionOk.reason.match(/hash|nonce|approver/) ? "approval_verification_failed" : "approval_not_actionable",
        taskId: effect.task_id,
        actorId: approverId,
        details: { approval_id: approvalId, decision, reason: decisionOk.reason, state: approval.state },
        now,
      });
      return { accepted: false, reason: decisionOk.reason, state: approval.state };
    }
    if (!hasApproveGrant(db, { scopeId: effect.scope_id, principalId: approverId, now })) {
      writeAudit(db, {
        code: "approval_verification_failed",
        taskId: effect.task_id,
        actorId: approverId,
        details: { approval_id: approvalId, reason: "approver has no live approve grant" },
        now,
      });
      return { accepted: false, reason: "approver has no live approve grant", state: approval.state };
    }
    const contextOk = verifyContext(db, { approval, effect, now });
    if (!contextOk.ok) {
      writeAudit(db, {
        code: "approval_context_stale",
        taskId: effect.task_id,
        actorId: approverId,
        details: { approval_id: approvalId, reason: contextOk.reason },
        now,
      });
      return { accepted: false, reason: contextOk.reason, state: approval.state };
    }
    if (decision === "approve") {
      const casApproval = db
        .prepare("UPDATE approvals SET state='CONSUMED', consumed_at=? WHERE id=? AND state='WAITING'")
        .run(now, approvalId).changes;
      const casEffect = db
        .prepare("UPDATE effects SET state='READY', next_attempt_at=?, updated_at=? WHERE id=? AND state='WAITING_APPROVAL'")
        .run(now, now, effect.id).changes;
      const casTask = db
        .prepare("UPDATE tasks SET state='WAITING_EFFECT', updated_at=? WHERE id=? AND state='WAITING_APPROVAL'")
        .run(now, effect.task_id).changes;
      if (casApproval !== 1 || casEffect !== 1 || casTask !== 1) {
        throw new ApprovalError(
          `approval consume CAS inconsistent (approval=${casApproval} effect=${casEffect} task=${casTask}); rolled back`,
        );
      }
      writeAudit(db, {
        code: "approval_consumed",
        taskId: effect.task_id,
        actorId: approverId,
        details: { approval_id: approvalId, effect_id: effect.id, action_hash: actionHash },
        now,
      });
      writeStreamEvent(db, {
        scopeId: effect.scope_id,
        eventType: "approval_changed",
        entityId: `approval:${approvalId}`,
        entityVersion: 2,
        payload: { state: "CONSUMED", effect: effect.id },
        now,
      });
      const out = { accepted: true, state: "CONSUMED", effectState: "READY", taskState: "WAITING_EFFECT" };
      crashpoint("approvals:inside-txn");
      return out;
    }
    // reject: the action never submits, never auto-retries, never hops
    // channels. The task stops as a normal, non-error outcome.
    const casApproval = db
      .prepare("UPDATE approvals SET state='REJECTED', consumed_at=? WHERE id=? AND state='WAITING'")
      .run(now, approvalId).changes;
    const casEffect = db
      .prepare("UPDATE effects SET state='DEAD', last_error='approval_rejected', updated_at=? WHERE id=? AND state='WAITING_APPROVAL'")
      .run(now, effect.id).changes;
    const casTask = db
      .prepare("UPDATE tasks SET state='FAILED', updated_at=? WHERE id=? AND state='WAITING_APPROVAL'")
      .run(now, effect.task_id).changes;
    if (casApproval !== 1 || casEffect !== 1) {
      throw new ApprovalError("approval reject CAS inconsistent; rolled back");
    }
    db.prepare("UPDATE attempts SET state='FAILED', ended_at=?, error_code='approval_rejected' WHERE task_id=? AND attempt_no=?")
      .run(now, effect.task_id, db.prepare("SELECT attempt_no FROM tasks WHERE id=?").get(effect.task_id).attempt_no);
    writeAudit(db, {
      code: "approval_rejected",
      taskId: effect.task_id,
      actorId: approverId,
      details: { approval_id: approvalId, effect_id: effect.id },
      now,
    });
    return { accepted: true, state: "REJECTED", effectState: "DEAD", taskState: "FAILED" };
  });
  // Past this line the decision transaction committed; a crash before the
  // caller learns about it must not double-consume on retry (the state CAS
  // makes the retry a clean "already processed").
  crashpoint("approvals:after-commit");
  return result;
}

// Old approvals die on edit/expiry/policy change; the new intent is a NEW
// effect with a new business_key version — action_json is never edited.
export function invalidateApproval(db, { approvalId, reason, now }) {
  return withTx(db, () => {
    const approval = db.prepare("SELECT * FROM approvals WHERE id=?").get(approvalId);
    if (!approval || approval.state !== "WAITING") {
      return { invalidated: false, state: approval?.state ?? "missing" };
    }
    db.prepare("UPDATE approvals SET state='INVALIDATED' WHERE id=? AND state='WAITING'").run(approvalId);
    const changed = db
      .prepare("UPDATE effects SET state='CANCELLED', last_error=?, updated_at=? WHERE id=? AND state='WAITING_APPROVAL'")
      .run(`approval invalidated: ${reason}`, now, approval.effect_id).changes;
    writeAudit(db, {
      code: "approval_invalidated",
      taskId: db.prepare("SELECT task_id FROM effects WHERE id=?").get(approval.effect_id)?.task_id ?? null,
      details: { approval_id: approvalId, reason },
      now,
    });
    return { invalidated: true, effectCancelled: changed === 1 };
  });
}

export function expireApprovals(db, { now }) {
  const stale = db
    .prepare("SELECT id, effect_id FROM approvals WHERE state='WAITING' AND expires_at<=?")
    .all(now);
  const out = [];
  for (const a of stale) {
    db.prepare("UPDATE approvals SET state='EXPIRED' WHERE id=? AND state='WAITING'").run(a.id);
    db.prepare("UPDATE effects SET state='CANCELLED', last_error='approval expired', updated_at=? WHERE id=? AND state='WAITING_APPROVAL'").run(now, a.effect_id);
    writeAudit(db, { code: "approval_expired", details: { approval_id: a.id }, now });
    out.push(a.id);
  }
  return out;
}
