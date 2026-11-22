// Effects, the dispatcher, and cancellation linearization per 06 sections 5
// and 6. The READY->SUBMITTING CAS transaction is the system's commitment
// point — the linearization of OUR promise, not the remote's effective time.
// The upstream call happens strictly AFTER that transaction commits and
// never inside it. A crash anywhere between the CAS and the local record
// leaves SUBMITTING on disk, which startup recovery (and only startup
// recovery) converts to UNKNOWN; UNKNOWN is never blindly retried — each
// retry_mode defines its own reconciliation, and a human reconciliation is
// always recorded with actor, evidence and conclusion.

import { createHash } from "node:crypto";
import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent, authorizationRevision } from "./audit.mjs";
import { canonicalJson, businessKey as encodeBusinessKey, escapeComponent } from "./keys.mjs";
import { insertObjectRow } from "./objects.mjs";
import { scopeId as scopeIdForDomainKey } from "./ingress.mjs";
import {
  cp4EffectDecision,
  cp4TargetShape,
  recordCp4Block,
} from "./cp4.mjs";
import {
  createApprovalRow,
  approvalIdFor,
  decideApproval,
  invalidateApproval,
} from "./approvals.mjs";
import { cancelScopeTimersInTx } from "./timers.mjs";
import { crashpoint } from "./testing/crashpoints.mjs";

export class EffectError extends Error {}
export class EffectConflict extends EffectError {}
export class EffectCp4Blocked extends EffectError {}
export class DispatcherRefused extends EffectError {}
export class UnknownNotReconcilable extends EffectError {}

const RETRY_MODES = ["IDEMPOTENCY_KEY", "LOOKUP_THEN_RETRY", "AT_MOST_ONCE", "AT_LEAST_ONCE"];

// The canonical action fields of 06 section 5. proposeEffect fills the
// identity/attempt/revision fields from the database and merges the caller's
// operation-specific intent; the serialized bytes are the action_json and its
// SHA-256 is the action_hash. Keys never enter the body.
export function canonicalActionJson({
  schemaVersion,
  principalId,
  sendingIdentity,
  scopeId,
  domainKey,
  targetResource,
  operation,
  contentHash,
  attachmentHash = null,
  expectedHead = null,
  attemptId,
  proposalFence,
  scopeEpoch,
  authorizationRevisionValue,
  policyVersion,
  expiresAt,
  evidenceManifestHash,
  extra = {},
}) {
  // P3-1 (D-98): a caller that omits the evidence manifest used to crash deep
  // inside canonicalJson ("undefined is not representable"). The honest
  // canonical value for "no manifest quoted" is the well-known SHA-256 of the
  // empty string — a distinguished constant the audit trail can read back as
  // "this action binds no evidence manifest", never a fabricated manifest.
  const manifestHash =
    typeof evidenceManifestHash === "string" && evidenceManifestHash.length > 0
      ? evidenceManifestHash
      : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  return canonicalJson({
    schema_version: schemaVersion,
    principal: principalId,
    sending_identity: sendingIdentity,
    scope: scopeId,
    domain_key: domainKey,
    target_resource: targetResource,
    operation,
    content_hash: contentHash,
    attachment_hash: attachmentHash,
    expected_head: expectedHead,
    attempt_id: attemptId,
    proposal_fence: proposalFence,
    scope_epoch: scopeEpoch,
    authorization_revision: authorizationRevisionValue,
    policy_version: policyVersion,
    expires_at: expiresAt,
    evidence_manifest_hash: manifestHash,
    ...extra,
  });
}

export function proposeEffectInTx(db, _stateDir, {
  now,
  taskId,
  attemptId,
  effectType,
  domainKey,
  naturalKey,
  operationIntent, // { targetResource, operation, contentHash, attachmentHash?, expectedHead?, evidenceManifestHash, extra?, parentObjectIds?, extraRequiredScopeIds?, payloadContent? }
  retryMode,
  provider,
  resource,
  requiresApproval,
  approverPrincipalId,
  checkpointContent = null,
  expiresAt,
}) {
  if (!RETRY_MODES.includes(retryMode)) {
    throw new EffectError(`retry_mode ${retryMode} is not one of the four 06 section 6 modes`);
  }
  if (requiresApproval && !approverPrincipalId) {
    throw new EffectError("an approval-requiring effect must name its approver principal");
  }
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  if (!task) throw new EffectError(`task ${taskId} not found`);
  const scope = db.prepare("SELECT * FROM scopes WHERE id=?").get(task.scope_id);
  const bkey = encodeBusinessKey(effectType, domainKey, naturalKey);
  // Upstream lineage (02 section 3 CP4 / 01 section 3: every derivative
  // carries its sources' ACL): a payload derived from other objects
  // inherits their required scopes — direct parents' scopes here, and the
  // object_edges recorded below let the CP4 closure walk reach every
  // ancestor at decision time. Summarizing never de-classifies.
  const parentObjectIds = Array.isArray(operationIntent.parentObjectIds) ? operationIntent.parentObjectIds : [];
  const extraRequiredScopeIds = Array.isArray(operationIntent.extraRequiredScopeIds)
    ? operationIntent.extraRequiredScopeIds
    : [];
  const lineageScopes = new Set([task.scope_id, ...extraRequiredScopeIds]);
  for (const parentId of parentObjectIds) {
    const parent = db.prepare("SELECT id FROM objects WHERE id=?").get(parentId);
    if (!parent) throw new EffectError(`operationIntent parent object ${parentId} does not exist`);
    for (const r of db.prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=?").all(parentId)) {
      lineageScopes.add(r.scope_id);
    }
  }
  // CP4 proposal gate (02 section 3: "审批不能静默覆盖数据所有者没有授予的
  // 披露权限" — the refusal happens BEFORE the row exists). The decision
  // runs on the lineage closure, which is exactly what the dispatch-time
  // walk of the inserted payload object yields. The public proposeEffect
  // entry records the durable refusal audit in its own transaction before
  // this point; direct in-tx callers abort their own transaction and their
  // failure handling owns the visible record (the dispatch gate re-checks
  // anything that still lands).
  const cp4 = cp4EffectDecision(db, {
    operation: operationIntent.operation,
    resource: operationIntent.targetResource,
    closure: [...lineageScopes],
    parentObjectIds,
    effectScopeId: task.scope_id,
    now,
  });
  if (!cp4.allowed) {
    throw new EffectCp4Blocked(
      `CP4 blocked at proposal: ${operationIntent.operation} to ${JSON.stringify(operationIntent.targetResource)} — ${cp4.basis}`,
    );
  }
  const actionJson = canonicalActionJson({
    schemaVersion: 1,
    principalId: task.principal_id,
    sendingIdentity: "aegispi-daemon",
    scopeId: task.scope_id,
    domainKey,
    targetResource: operationIntent.targetResource,
    operation: operationIntent.operation,
    contentHash: operationIntent.contentHash,
    attachmentHash: operationIntent.attachmentHash ?? null,
    expectedHead: operationIntent.expectedHead ?? null,
    attemptId,
    proposalFence: task.fence,
    scopeEpoch: scope.epoch,
    authorizationRevisionValue: authorizationRevision(db),
    policyVersion: scope.policy_version,
    expiresAt,
    evidenceManifestHash: operationIntent.evidenceManifestHash,
    extra: operationIntent.extra ?? {},
  });
  const actionHash = createHash("sha256").update(Buffer.from(actionJson, "utf8")).digest("hex");
  const existing = db.prepare("SELECT id FROM effects WHERE business_key=?").get(bkey);
  if (existing) {
    throw new EffectConflict(
      `business_key ${bkey} already exists (${existing.id}); edit the intent and mint a new natural_key version`,
    );
  }
  const payloadObject = insertObjectRow(db, {
    scopeId: task.scope_id,
    kind: "effect_payload",
    sourceUri: `task:${taskId}`,
    sourceActor: task.principal_id,
    content: operationIntent.payloadContent ?? actionJson,
    observedAt: now,
    requiredScopeIds: [...lineageScopes],
    parents: parentObjectIds.map((id) => ({ parentId: id })),
  });
  const effectId = `efx:${escapeComponent(bkey, { allowSlash: true })}`;
  const state = requiresApproval ? "WAITING_APPROVAL" : "DRAFT";
  db.prepare(
    `INSERT INTO effects(id, task_id, attempt_id, proposal_fence, scope_id, principal_id, scope_epoch,
      authorization_revision, policy_version, action_json, action_hash, payload_object_id,
      provider, resource, operation, expires_at, retry_mode, idempotency_key, business_key,
      state, attempt_count, max_attempts, next_attempt_at, submit_owner, submit_started_at,
      external_id, response_object_id, last_error, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,3,?, NULL, NULL, NULL, NULL, NULL, ?,?)`,
  ).run(
    effectId,
    taskId,
    attemptId,
    task.fence,
    task.scope_id,
    task.principal_id,
    scope.epoch,
    authorizationRevision(db),
    scope.policy_version,
    actionJson,
    actionHash,
    payloadObject.id,
    provider,
    resource,
    operationIntent.operation,
    expiresAt,
    retryMode,
    retryMode === "IDEMPOTENCY_KEY" ? `idem:${bkey}` : null,
    bkey,
    state,
    now,
    now,
    now,
  );
  let approval = null;
  if (requiresApproval) {
    approval = createApprovalRow(db, {
      effectId,
      actionHash,
      approverId: approverPrincipalId,
      attemptId,
      proposalFence: task.fence,
      scopeEpoch: scope.epoch,
      authorizationRevisionValue: authorizationRevision(db),
      policyVersion: scope.policy_version,
      expiresAt,
      now,
    });
  }
  if (requiresApproval && task.state === "RUNNING") {
    let checkpointObjectId = null;
    if (checkpointContent !== null) {
      const ck = insertObjectRow(db, {
        scopeId: task.scope_id,
        kind: "attempt_checkpoint",
        sourceUri: `attempt:${attemptId}`,
        sourceActor: "host",
        content: checkpointContent,
        observedAt: now,
        requiredScopeIds: [task.scope_id],
      });
      checkpointObjectId = ck.id;
      db.prepare("UPDATE attempts SET checkpoint_object_id=?, state='PARKED' WHERE id=? AND state='ACTIVE'")
        .run(checkpointObjectId, attemptId);
    } else {
      db.prepare("UPDATE attempts SET state='PARKED' WHERE id=? AND state='ACTIVE'").run(attemptId);
    }
    db.prepare(
      "UPDATE tasks SET state='WAITING_APPROVAL', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND state='RUNNING'",
    ).run(now, taskId);
    writeAudit(db, {
      code: "task_parked_for_approval",
      taskId,
      details: { attempt_id: attemptId, effect_id: effectId, checkpoint: checkpointObjectId },
      now,
    });
  }
  writeAudit(db, {
    code: "effect_proposed",
    taskId,
    details: { effect_id: effectId, state, retry_mode: retryMode, business_key: bkey, approval: approval?.approvalId ?? null },
    now,
  });
  writeStreamEvent(db, {
    scopeId: task.scope_id,
    eventType: "effect_changed",
    entityId: `effect:${effectId}`,
    entityVersion: 1,
    payload: { state, retry_mode: retryMode },
    now,
  });
  return {
    effectId,
    businessKey: bkey,
    actionHash,
    state,
    approvalId: approval?.approvalId ?? null,
    approvalNonce: approval?.nonce ?? null,
  };
}

export function proposeEffect(db, stateDir, opts) {
  // CP4 proposal gate, durable before any row exists: the decision is pure
  // (reads only), the refusal audit lands in its OWN transaction, and the
  // throw stops the caller before a payload or effect row is written.
  const gate = withTx(db, () => {
    const task = db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(opts.taskId);
    if (!task) return null;
    const parentObjectIds = Array.isArray(opts.operationIntent?.parentObjectIds)
      ? opts.operationIntent.parentObjectIds
      : [];
    const extraRequired = Array.isArray(opts.operationIntent?.extraRequiredScopeIds)
      ? opts.operationIntent.extraRequiredScopeIds
      : [];
    const lineage = new Set([task.scope_id, ...extraRequired]);
    for (const pid of parentObjectIds) {
      for (const r of db.prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=?").all(pid)) {
        lineage.add(r.scope_id);
      }
    }
    return cp4EffectDecision(db, {
      operation: opts.operationIntent?.operation,
      resource: opts.operationIntent?.targetResource,
      closure: [...lineage],
      parentObjectIds,
      effectScopeId: task.scope_id,
      now: opts.now,
    });
  });
  if (gate !== null && !gate.allowed) {
    const shape = cp4TargetShape({ operation: opts.operationIntent?.operation, resource: opts.operationIntent?.targetResource });
    withTx(db, () => {
      recordCp4Block(db, {
        payloadObjectId: null,
        targetScopeId: shape.scopeDomainKey !== null ? scopeIdForDomainKey(shape.scopeDomainKey) : null,
        targetResource: opts.operationIntent?.targetResource ?? null,
        closure: gate.closure,
        basis: `proposal refused: ${gate.basis}`,
        now: opts.now,
      });
    });
    throw new EffectCp4Blocked(
      `CP4 blocked at proposal: ${opts.operationIntent?.operation} to ${JSON.stringify(opts.operationIntent?.targetResource)} — ${gate.basis}`,
    );
  }
  return withTx(db, () => proposeEffectInTx(db, stateDir, opts));
}

export function draftToReadyInTx(db, { effectId, routineRef, approvedRoutines, now }) {
  if (!routineRef || !Array.isArray(approvedRoutines) || !approvedRoutines.includes(routineRef)) {
    throw new EffectError(`routine ${routineRef ?? "(none)"} is not on the approved narrow-routine list`);
  }
  const changed = db
    .prepare("UPDATE effects SET state='READY', next_attempt_at=?, updated_at=? WHERE id=? AND state='DRAFT'")
    .run(now, now, effectId).changes;
  if (changed !== 1) {
    throw new EffectError(`effect ${effectId} is not DRAFT; a human-approval effect cannot skip its approval`);
  }
  writeAudit(db, {
    code: "effect_draft_to_ready",
    details: { effect_id: effectId, routine_ref: routineRef },
    now,
  });
  return { effectId, state: "READY" };
}

export function draftToReady(db, opts) {
  return withTx(db, () => draftToReadyInTx(db, opts));
}

function hashOfActionJson(actionJson) {
  return createHash("sha256").update(Buffer.from(actionJson, "utf8")).digest("hex");
}

// The dispatcher. One short transaction re-checks everything and CASes
// READY -> SUBMITTING; the upstream call happens after COMMIT, outside any
// SQLite transaction.
//
// Unit 5.2 CP4 (02 section 3 / 01 section 3): before the CAS commits, the
// payload's full upstream closure is re-adjudicated against the NORMALIZED
// target audience — group:telegram:<id>, the prefix-less telegram:<id>
// (worst case: a group), dm:telegram:<id>, the legacy single-person fixture
// shapes, and repo:// writes. adapters.allowedRecipients is TRANSPORT
// reachability only (the adapter still refuses unlisted targets with zero
// bytes); it is NOT a disclosure authorization — a cross-scope disclosure
// needs the system_state disclosure allowlist or an owner_dm audience whose
// owner holds live read on every closure scope. The gate also fires when
// the closure leaves the effect's own scope even though the target IS the
// effect's own scope. Anything else is blocked BEFORE the commitment point,
// the effect lands DEAD with the audit trail, and zero bytes leave.
export function dispatchEffect(db, upstream, { effectId, now, precondition = null, label = "dispatcher", submitMode = undefined, reservationId = null }) {
  const cas = withTx(db, () => {
    const e = db.prepare("SELECT * FROM effects WHERE id=?").get(effectId);
    if (!e) throw new DispatcherRefused(`effect ${effectId} not found`);
    if (e.state !== "READY") {
      throw new DispatcherRefused(`effect ${effectId} is ${e.state}, not READY`);
    }
    if (hashOfActionJson(e.action_json) !== e.action_hash) {
      throw new DispatcherRefused(`effect ${effectId} action_json no longer hashes to action_hash`);
    }
    if (now >= e.expires_at) {
      throw new DispatcherRefused(`effect ${effectId} expired`);
    }
    // CP4 recipient reverse-check, normalized for every outbound/write
    // target shape (cp4.mjs owns the classification; multi-member GROUP
    // audiences are always adjudicated, and any closure that leaves the
    // effect's own scope is adjudicated regardless of the target shape).
    const targetResource = (() => {
      try {
        const parsed = JSON.parse(e.action_json);
        return parsed?.target_resource ?? parsed?.targetResource ?? parsed?.operationIntent?.targetResource ?? e.resource;
      } catch {
        return e.resource;
      }
    })();
    const decision = cp4EffectDecision(db, {
      operation: e.operation,
      resource: targetResource,
      payloadObjectId: e.payload_object_id,
      effectScopeId: e.scope_id,
      now,
    });
    if (decision.needed && !decision.allowed) {
      // Block INSIDE the transaction so the refusal record commits:
      // the effect goes DEAD (visible, demands a human), the audit
      // and stream alert land with it, and no byte is ever built.
      const shape = cp4TargetShape({ operation: e.operation, resource: targetResource });
      db.prepare("UPDATE effects SET state='DEAD', last_error=?, updated_at=? WHERE id=? AND state='READY'")
        .run(`cp4_recipient_scope_leak_blocked: ${decision.basis}`, now, effectId);
      recordCp4Block(db, {
        payloadObjectId: e.payload_object_id,
        targetScopeId: shape.scopeDomainKey !== null ? scopeIdForDomainKey(shape.scopeDomainKey) : null,
        targetResource,
        closure: decision.closure,
        basis: decision.basis,
        now,
      });
      return { effectId, cp4Blocked: true, basis: decision.basis };
    }
    const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(e.task_id);
    const scope = db.prepare("SELECT * FROM scopes WHERE id=?").get(e.scope_id);
    if (task.state === "CANCELLED" || task.state === "DEAD") {
      throw new DispatcherRefused(`task ${e.task_id} is ${task.state}; effect cannot submit`);
    }
    if (task.fence !== e.proposal_fence) {
      throw new DispatcherRefused(`task fence moved to ${task.fence}; effect proposed under ${e.proposal_fence} must be cancelled and re-proposed`);
    }
    if (scope.epoch !== e.scope_epoch) {
      throw new DispatcherRefused(`scope epoch moved to ${scope.epoch}`);
    }
    if (authorizationRevision(db) !== e.authorization_revision) {
      throw new DispatcherRefused("authorization revision changed");
    }
    if (scope.policy_version !== e.policy_version) {
      throw new DispatcherRefused("policy version changed");
    }
    if (e.attempt_count >= e.max_attempts) {
      throw new DispatcherRefused(`effect ${effectId} exhausted its ${e.max_attempts} attempts`);
    }
    if (e.next_attempt_at > now) {
      throw new DispatcherRefused(`effect ${effectId} next attempt at ${e.next_attempt_at}`);
    }
    if (precondition && !precondition()) {
      throw new DispatcherRefused("target resource precondition failed");
    }
    const changed = db
      .prepare(
        `UPDATE effects SET state='SUBMITTING', submit_owner=?, submit_started_at=?,
           attempt_count=attempt_count+1, updated_at=?
         WHERE id=? AND state='READY' AND attempt_count=?`,
      )
      .run(label, now, now, effectId, e.attempt_count).changes;
    if (changed !== 1) {
      throw new DispatcherRefused(`CAS lost: effect ${effectId} left READY between read and update`);
    }
    writeAudit(db, {
      code: "effect_submitting",
      taskId: e.task_id,
      details: { effect_id: effectId, attempt: e.attempt_count + 1, submit_owner: label },
      now,
    });
    return { effectId, attemptCount: e.attempt_count + 1 };
  });
  if (cas.cp4Blocked === true) {
    // The blocking transaction is COMMITTED at this point: the refusal,
    // its audit trail and the DEAD effect are durable. The throw tells
    // the caller the dispatch did not happen.
    throw new DispatcherRefused(`CP4 blocked: effect ${effectId} may not flow to its target — ${cas.basis}`);
  }
  // Commit is the linearization point of the system's commitment. A crash
  // from here on leaves SUBMITTING for startup recovery to call UNKNOWN.
  crashpoint("effects:after-cas-before-call");
  const operationRow = db.prepare("SELECT operation, provider, resource, action_json FROM effects WHERE id=?").get(effectId);
  const outcome = upstream.submit({
    businessKey: db.prepare("SELECT business_key FROM effects WHERE id=?").get(effectId).business_key,
    idempotencyKey: db.prepare("SELECT idempotency_key FROM effects WHERE id=?").get(effectId).idempotency_key,
    operation: operationRow,
    now,
    // Fault-injection seam for the fake remote only: real adapters ignore
    // an unset mode and behave like themselves.
    mode: submitMode,
    // Chargeable dispatches carry their live reservation id; the adapter
    // upstream refuses chargeable operations without one (06 section 8).
    reservationId,
    effectId,
  });
  // Remote may have succeeded here while the local record does not exist
  // yet: the 06 crash row "远端已成功、本地未记账".
  crashpoint("effects:after-call-before-record");
  return withTx(db, () => {
    const e = db.prepare("SELECT * FROM effects WHERE id=?").get(effectId);
    if (e.state !== "SUBMITTING") {
      // Recovery already moved it (e.g. UNKNOWN after a restart): never
      // overwrite a concurrent reconciliation decision.
      return { effectId, state: e.state, superseded: true };
    }
    if (outcome.status === "succeeded") {
      const response = insertObjectRow(db, {
        scopeId: e.scope_id,
        kind: "effect_response",
        sourceUri: `${e.provider}:${e.resource}`,
        sourceActor: "host-dispatcher",
        content: JSON.stringify({ external_id: outcome.externalId, at: now }),
        observedAt: now,
        requiredScopeIds: [e.scope_id],
      });
      db.prepare(
        "UPDATE effects SET state='SUCCEEDED', external_id=?, response_object_id=?, updated_at=? WHERE id=? AND state='SUBMITTING'",
      ).run(outcome.externalId, response.id, now, effectId);
      writeAudit(db, {
        code: "effect_succeeded",
        taskId: e.task_id,
        details: { effect_id: effectId, external_id: outcome.externalId },
        now,
      });
      writeStreamEvent(db, {
        scopeId: e.scope_id,
        eventType: "effect_changed",
        entityId: `effect:${effectId}`,
        entityVersion: 3,
        payload: { state: "SUCCEEDED", external_id: outcome.externalId },
        now,
      });
      return { effectId, state: "SUCCEEDED", externalId: outcome.externalId };
    }
    if (outcome.status === "failed_local") {
      // The structured `local_error:` prefix is the requeue convention: zero
      // request bytes left the host, so a later READY re-dispatch is safe.
      // Any other FAILED text stays terminal.
      db.prepare(
        "UPDATE effects SET state='FAILED', last_error=?, updated_at=? WHERE id=? AND state='SUBMITTING'",
      ).run(`local_error: ${outcome.error}`, now, effectId);
      writeAudit(db, {
        code: "effect_failed_local",
        taskId: e.task_id,
        details: { effect_id: effectId, error: outcome.error, bytes_sent: 0 },
        now,
      });
      return { effectId, state: "FAILED", requeueable: true };
    }
    if (outcome.status === "failed_remote") {
      db.prepare(
        "UPDATE effects SET state='FAILED', last_error=?, updated_at=? WHERE id=? AND state='SUBMITTING'",
      ).run(outcome.error, now, effectId);
      writeAudit(db, {
        code: "effect_failed_remote",
        taskId: e.task_id,
        details: { effect_id: effectId, error: outcome.error },
        now,
      });
      return { effectId, state: "FAILED", requeueable: false };
    }
    // unknown: timeout, broken stream, or a crash-after-send. Never a
    // success, never an auto-retry trigger.
    db.prepare(
      "UPDATE effects SET state='UNKNOWN', last_error=?, updated_at=? WHERE id=? AND state='SUBMITTING'",
    ).run(outcome.error ?? "unknown outcome", now, effectId);
    writeAudit(db, {
      code: "effect_unknown",
      taskId: e.task_id,
      details: { effect_id: effectId, error: outcome.error ?? "unknown outcome" },
      now,
    });
    writeStreamEvent(db, {
      scopeId: e.scope_id,
      eventType: "audit_alert",
      entityId: `effect:${effectId}`,
      entityVersion: 1,
      payload: { state: "UNKNOWN", retry_mode: e.retry_mode },
      now,
    });
    return { effectId, state: "UNKNOWN" };
  });
}

// A FAILED effect whose request bytes were never sent (local error) may go
// back to READY — but only while the authorization context is still intact
// and attempts remain. UNKNOWN never passes through here.
export function requeueLocalFailure(db, { effectId, now, backoffMs }) {
  return withTx(db, () => {
    const e = db.prepare("SELECT * FROM effects WHERE id=?").get(effectId);
    if (!e || e.state !== "FAILED") {
      throw new EffectError(`effect ${effectId} is ${e?.state ?? "missing"}; only FAILED can requeue`);
    }
    if (!/^local_error:/.test(e.last_error ?? "")) {
      throw new EffectError(`effect ${effectId} failed remotely or with unknown outcome; no automatic requeue`);
    }
    const scope = db.prepare("SELECT epoch, policy_version FROM scopes WHERE id=?").get(e.scope_id);
    if (scope.epoch !== e.scope_epoch || authorizationRevision(db) !== e.authorization_revision) {
      throw new EffectError("authorization context changed; re-proposal needs a fresh approval");
    }
    if (e.attempt_count >= e.max_attempts) {
      db.prepare("UPDATE effects SET state='DEAD', last_error='local retries exhausted', updated_at=? WHERE id=?").run(now, effectId);
      return { effectId, state: "DEAD" };
    }
    db.prepare(
      "UPDATE effects SET state='READY', next_attempt_at=?, updated_at=? WHERE id=? AND state='FAILED'",
    ).run(now + backoffMs, now, effectId);
    writeAudit(db, { code: "effect_requeued_local_failure", details: { effect_id: effectId }, now });
    return { effectId, state: "READY", nextAttemptAt: now + backoffMs };
  });
}

// Per-mode UNKNOWN handling (06 section 6 table). This is policy, not blind
// retry: AT_MOST_ONCE never resends; LOOKUP_THEN_RETRY looks first and only
// resends on a definitive not-occurred from a strongly consistent lookup;
// IDEMPOTENCY_KEY re-sends the SAME key; AT_LEAST_ONCE re-sends within its
// bounded backoff. Anything less certain stays UNKNOWN for a human.
export function autoRecoverUnknown(db, upstream, { effectId, now, backoffMs = 5000 }) {
  const e = db.prepare("SELECT * FROM effects WHERE id=?").get(effectId);
  if (!e || e.state !== "UNKNOWN") {
    throw new UnknownNotReconcilable(`effect ${effectId} is ${e?.state ?? "missing"}, not UNKNOWN`);
  }
  if (e.retry_mode === "AT_MOST_ONCE") {
    return { action: "none", reason: "AT_MOST_ONCE: UNKNOWN stops automatic resend; a human may mint a new action" };
  }
  if (e.retry_mode === "LOOKUP_THEN_RETRY") {
    const found = upstream.lookup({ businessKey: e.business_key, consistency: "strong" });
    if (found.found) {
      return withTx(db, () => {
        db.prepare(
          "UPDATE effects SET state='SUCCEEDED', external_id=?, last_error=NULL, updated_at=? WHERE id=? AND state='UNKNOWN'",
        ).run(found.externalId, now, effectId);
        writeAudit(db, {
          code: "effect_unknown_resolved_by_lookup",
          taskId: e.task_id,
          details: { effect_id: effectId, external_id: found.externalId, source: "upstream lookup" },
          now,
        });
        return { action: "recorded_success", externalId: found.externalId };
      });
    }
    if (found.strong === false) {
      return { action: "none", reason: "lookup is not strongly consistent; cannot treat not-found as not-occurred — waiting for human or bill" };
    }
    // Strongly consistent not-found: definitively not occurred.
    return requeueReady(db, { effectId, now, backoffMs, reason: "lookup confirmed not occurred" });
  }
  if (e.retry_mode === "IDEMPOTENCY_KEY" || e.retry_mode === "AT_LEAST_ONCE") {
    return requeueReady(db, {
      effectId,
      now,
      backoffMs,
      reason: e.retry_mode === "IDEMPOTENCY_KEY" ? "same-key resend" : "at-least-once bounded resend",
    });
  }
  throw new UnknownNotReconcilable(`no auto policy for retry_mode ${e.retry_mode}`);
}

function requeueReady(db, { effectId, now, backoffMs, reason }) {
  return withTx(db, () => {
    const e = db.prepare("SELECT * FROM effects WHERE id=?").get(effectId);
    if (e.state !== "UNKNOWN") {
      return { action: "none", reason: `effect left UNKNOWN (${e.state})` };
    }
    if (e.attempt_count >= e.max_attempts) {
      db.prepare("UPDATE effects SET state='DEAD', last_error='reconcile retries exhausted', updated_at=? WHERE id=?").run(now, effectId);
      return { action: "dead", reason: "reconcile retries exhausted" };
    }
    db.prepare(
      "UPDATE effects SET state='READY', next_attempt_at=?, updated_at=? WHERE id=? AND state='UNKNOWN'",
    ).run(now + backoffMs, now, effectId);
    writeAudit(db, { code: "effect_unknown_requeued", details: { effect_id: effectId, reason }, now });
    return { action: "requeued", reason, nextAttemptAt: now + backoffMs };
  });
}

// Manual reconciliation of an UNKNOWN effect. Every resolution records the
// actor, the evidence reference and the conclusion; there is no bulk form.
export function reconcileUnknown(db, {
  effectId,
  resolution,
  externalEvidenceRef,
  externalId = null,
  actorId,
  now,
}) {
  if (!["CONFIRMED_SUCCESS", "CONFIRMED_NOT_SENT", "REMAINS_UNKNOWN"].includes(resolution)) {
    throw new EffectError(`resolution ${resolution} is not a known reconciliation outcome`);
  }
  if (!actorId || !externalEvidenceRef) {
    throw new EffectError("manual reconciliation requires an actor and an evidence reference");
  }
  return withTx(db, () => {
    const e = db.prepare("SELECT * FROM effects WHERE id=?").get(effectId);
    if (!e || e.state !== "UNKNOWN") {
      throw new UnknownNotReconcilable(`effect ${effectId} is ${e?.state ?? "missing"}, not UNKNOWN`);
    }
    if (resolution === "CONFIRMED_SUCCESS") {
      if (!externalId) {
        throw new EffectError("CONFIRMED_SUCCESS requires the external id from the evidence");
      }
      db.prepare(
        "UPDATE effects SET state='SUCCEEDED', external_id=?, last_error=NULL, updated_at=? WHERE id=? AND state='UNKNOWN'",
      ).run(externalId, now, effectId);
    } else if (resolution === "CONFIRMED_NOT_SENT") {
      db.prepare(
        "UPDATE effects SET state='FAILED', last_error='confirmed not sent by human reconciliation', updated_at=? WHERE id=? AND state='UNKNOWN'",
      ).run(now, effectId);
    }
    writeAudit(db, {
      code: "effect_reconciled_manually",
      taskId: e.task_id,
      actorId,
      details: { effect_id: effectId, resolution, evidence_ref: externalEvidenceRef, external_id: externalId },
      now,
    });
    return { effectId, resolution, state: resolution === "REMAINS_UNKNOWN" ? "UNKNOWN" : resolution === "CONFIRMED_SUCCESS" ? "SUCCEEDED" : "FAILED" };
  });
}

// Startup recovery action (06 section 9): a SUBMITTING effect means the CAS
// committed and we cannot know what the upstream did. It becomes UNKNOWN and
// only the per-mode policies or a human may move it further.
export function markSubmittingEffectsUnknown(db, { now }) {
  const rows = db.prepare("SELECT id, task_id, scope_id FROM effects WHERE state='SUBMITTING'").all();
  for (const r of rows) {
    withTx(db, () => {
      const changed = db
        .prepare("UPDATE effects SET state='UNKNOWN', last_error='crashed while SUBMITTING; outcome unknown', updated_at=? WHERE id=? AND state='SUBMITTING'")
        .run(now, r.id).changes;
      if (changed !== 1) return;
      writeAudit(db, {
        code: "effect_unknown_after_restart",
        taskId: r.task_id,
        details: { effect_id: r.id },
        now,
      });
      writeStreamEvent(db, {
        scopeId: r.scope_id,
        eventType: "audit_alert",
        entityId: `effect:${r.id}`,
        entityVersion: 1,
        payload: { state: "UNKNOWN", cause: "restart while SUBMITTING" },
        now,
      });
    });
  }
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Cancellation (06 section 6). The cancel transaction bumps the scope epoch
// and fences everything not yet committed; already-SUBMITTING effects are
// RETAINED and reported as "committed, may have taken effect, confirming".
// Cancelling a single task still fences the whole scope; other non-terminal
// tasks park under the new epoch instead of silently continuing the old one.

export function cancelScope(db, { scopeId, now, actorId = null, onlyTaskId = null }) {
  return withTx(db, () => {
    const scope = db.prepare("SELECT * FROM scopes WHERE id=?").get(scopeId);
    if (!scope) throw new EffectError(`scope ${scopeId} not found`);
    const newEpoch = scope.epoch + 1;
    db.prepare("UPDATE scopes SET epoch=? WHERE id=?").run(newEpoch, scopeId);
    const affectedTasks = db
      .prepare("SELECT * FROM tasks WHERE scope_id=? AND state IN ('QUEUED','RETRY_WAIT','RUNNING','WAITING_APPROVAL')")
      .all(scopeId);
    const retained = [];
    const cancelled = [];
    const parked = [];
    for (const t of affectedTasks) {
      const isTarget = onlyTaskId === null || t.id === onlyTaskId;
      const committed = db
        .prepare("SELECT id FROM effects WHERE task_id=? AND state IN ('SUBMITTING','UNKNOWN')")
        .all(t.id);
      if (committed.length > 0) {
        // This task has a committed-but-unresolved action: it keeps waiting
        // for reconciliation; the cancel reports it honestly.
        retained.push({ taskId: t.id, effects: committed.map((c) => c.id) });
        continue;
      }
      if (t.state === "RUNNING") {
        db.prepare("UPDATE attempts SET state='CANCELLED', ended_at=?, error_code='cancelled' WHERE task_id=? AND attempt_no=? AND state='ACTIVE'")
          .run(now, t.id, t.attempt_no);
      }
      if (isTarget) {
        db.prepare("UPDATE tasks SET state='CANCELLED', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?").run(now, t.id);
        cancelled.push(t.id);
      } else if (t.state === "RUNNING") {
        // Parked by the epoch update: the old attempt dies, the task requeues
        // under the NEW epoch (it will not silently continue the old one).
        db.prepare("UPDATE tasks SET state='QUEUED', available_at=?, scope_epoch=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?")
          .run(now, newEpoch, now, t.id);
        parked.push(t.id);
      } else if (t.state === "WAITING_APPROVAL") {
        db.prepare("UPDATE attempts SET state='CANCELLED', ended_at=?, error_code='epoch_parked' WHERE task_id=? AND state='PARKED'")
          .run(now, t.id);
        db.prepare("UPDATE tasks SET state='QUEUED', available_at=?, scope_epoch=?, updated_at=? WHERE id=?")
          .run(now, newEpoch, now, t.id);
        parked.push(t.id);
      } else {
        // QUEUED / RETRY_WAIT never started: plain cancel when targeted,
        // parked under the new epoch otherwise.
        if (isTarget) {
          db.prepare("UPDATE tasks SET state='CANCELLED', updated_at=? WHERE id=?").run(now, t.id);
          cancelled.push(t.id);
        } else {
          db.prepare("UPDATE tasks SET scope_epoch=?, updated_at=? WHERE id=?").run(newEpoch, now, t.id);
          parked.push(t.id);
        }
      }
    }
    // Un-committed effects and their waiting approvals die together.
    const cancelledEffects = db
      .prepare("SELECT id, task_id FROM effects WHERE scope_id=? AND state IN ('DRAFT','WAITING_APPROVAL','READY')")
      .all(scopeId);
    // Unit 5.4 cascade (03 section 4): a cancelled scope loses its SCHEDULED
    // timers in the SAME transaction — a cancelled task may not leave a
    // follow-up armed.
    cancelScopeTimersInTx(db, { scopeId, now, reason: "scope/task cancelled", actorId });
    for (const e of cancelledEffects) {
      db.prepare("UPDATE effects SET state='CANCELLED', last_error='scope cancelled', updated_at=? WHERE id=? AND state IN ('DRAFT','WAITING_APPROVAL','READY')").run(now, e.id);
      const approval = db.prepare("SELECT id FROM approvals WHERE effect_id=? AND state='WAITING'").get(e.id);
      if (approval) {
        db.prepare("UPDATE approvals SET state='INVALIDATED' WHERE id=? AND state='WAITING'").run(approval.id);
      }
    }
    // WAITING_EFFECT tasks whose effect got cancelled: an uncommitted task
    // under a whole-scope cancel is CANCELLED; under a single-task cancel the
    // target is cancelled and its peers park under the new epoch.
    const waitingEffect = db
      .prepare("SELECT id FROM tasks WHERE scope_id=? AND state='WAITING_EFFECT'")
      .all(scopeId);
    for (const t of waitingEffect) {
      const liveEffects = db
        .prepare("SELECT id FROM effects WHERE task_id=? AND state IN ('SUBMITTING','UNKNOWN','READY')")
        .all(t.id);
      if (liveEffects.length === 0) {
        if (onlyTaskId === null || t.id === onlyTaskId) {
          db.prepare("UPDATE tasks SET state='CANCELLED', updated_at=? WHERE id=?").run(now, t.id);
          cancelled.push(t.id);
        } else {
          db.prepare("UPDATE tasks SET state='QUEUED', scope_epoch=?, updated_at=? WHERE id=?").run(newEpoch, now, t.id);
          parked.push(t.id);
        }
      } else {
        // Committed-but-unresolved actions: retained, reported honestly as
        // "committed, may have taken effect, confirming".
        retained.push({ taskId: t.id, effects: liveEffects.map((e) => e.id) });
      }
    }
    writeAudit(db, {
      code: onlyTaskId ? "task_cancelled" : "scope_cancelled",
      taskId: onlyTaskId,
      actorId,
      details: {
        scope_id: scopeId,
        epoch_after: newEpoch,
        cancelled_tasks: cancelled,
        parked_tasks: parked,
        retained_committed: retained,
        cancelled_effects: cancelledEffects.map((e) => e.id),
      },
      now,
    });
    return {
      epochAfter: newEpoch,
      cancelledTasks: cancelled,
      parkedTasks: parked,
      retainedCommitted: retained,
      cancelledEffects: cancelledEffects.map((e) => e.id),
    };
  });
}

export function cancelTask(db, { taskId, now, actorId = null }) {
  const task = db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(taskId);
  if (!task) throw new EffectError(`task ${taskId} not found`);
  return cancelScope(db, { scopeId: task.scope_id, now, actorId, onlyTaskId: taskId });
}

// ---------------------------------------------------------------------------
// Revision and HEAD-change re-proposal (06 section 5: "编辑正文、变更附件、
// HEAD变化、过期、策略或ACL变化、Task换attempt，都使旧审批INVALIDATED或
// EXPIRED。产生新effect、business_key版本和新审批，不修改原action_json").
// Both paths mint a NEW effect with a NEW business_key version and a NEW
// approval; the original action_json and its history are never edited.

// business_key decoding: every component escapes ':' to %3A before joining,
// so the ':' separator splits the key into exactly three parts. The parts
// are ESCAPED — reuse through proposeEffect requires unescaping first (the
// proposal re-escapes), or the new action would carry double-escaped keys.
export function splitBusinessKey(businessKey) {
  const parts = String(businessKey).split(":");
  if (parts.length !== 3) {
    throw new EffectError(`business_key ${businessKey} does not have the three-part 06 section 1.1 shape`);
  }
  return { effectType: parts[0], domainKey: parts[1], naturalKey: parts[2] };
}

export function unescapeKeyComponent(component) {
  try {
    return decodeURIComponent(component);
  } catch {
    throw new EffectError(`business_key component ${component} is not a valid escape sequence`);
  }
}

// canonicalActionJson spreads operationIntent.extra at the TOP level of the
// action, so recovering the extra fields means "every key that is not one of
// the canonical fields".
const CANONICAL_ACTION_FIELDS = new Set([
  "schema_version",
  "principal",
  "sending_identity",
  "scope",
  "domain_key",
  "target_resource",
  "operation",
  "content_hash",
  "attachment_hash",
  "expected_head",
  "attempt_id",
  "proposal_fence",
  "scope_epoch",
  "authorization_revision",
  "policy_version",
  "expires_at",
  "evidence_manifest_hash",
]);

export function extraFieldsOfAction(action) {
  const extra = {};
  for (const key of Object.keys(action)) {
    if (!CANONICAL_ACTION_FIELDS.has(key)) {
      extra[key] = action[key];
    }
  }
  return extra;
}

function nextNaturalKeyVersion(db, { effectType, domainKey, naturalKey }) {
  let candidate = `${naturalKey}~rev1`;
  let n = 1;
  while (db.prepare("SELECT id FROM effects WHERE business_key=?").get(encodeBusinessKey(effectType, domainKey, candidate))) {
    n += 1;
    candidate = `${naturalKey}~rev${n}`;
  }
  return candidate;
}

// Edit path (04 section 2 "编辑创建新动作和新审批，旧卡失效"): the old card is
// invalidated, the old effect cancelled, and a fresh approval card is minted
// for the edited intent. Two transactions: invalidate-then-propose. A crash
// between them leaves the old card dead and NO new card — the human simply
// proposes again; nothing half-approved can ever submit.
export function reviseEffect(db, stateDir, {
  now,
  effectId,
  editedIntent, // same shape as proposeEffect's operationIntent
  approverPrincipalId,
  actorId = null,
  expiresAt,
}) {
  const old = db.prepare("SELECT * FROM effects WHERE id=?").get(effectId);
  if (!old) throw new EffectError(`effect ${effectId} not found`);
  if (old.state !== "WAITING_APPROVAL") {
    throw new EffectError(`effect ${effectId} is ${old.state}; only a WAITING_APPROVAL effect can be revised`);
  }
  const approvalId = approvalIdFor(effectId);
  const parts = splitBusinessKey(old.business_key);
  const domainKey = unescapeKeyComponent(parts.domainKey);
  const naturalKey = unescapeKeyComponent(parts.naturalKey);
  const newNaturalKey = nextNaturalKeyVersion(db, {
    effectType: unescapeKeyComponent(parts.effectType),
    domainKey,
    naturalKey,
  });
  const invalidation = invalidateApproval(db, { approvalId, reason: "revised by editor", now });
  if (invalidation.invalidated !== true) {
    throw new EffectError(`approval ${approvalId} could not be invalidated (${invalidation.state}); refusing to mint a second live card`);
  }
  db.prepare(
    "UPDATE effects SET state='CANCELLED', last_error='superseded by revision', updated_at=? WHERE id=? AND state='WAITING_APPROVAL'",
  ).run(now, effectId);
  writeAudit(db, {
    code: "effect_revised",
    taskId: old.task_id,
    actorId,
    details: { old_effect_id: effectId, new_natural_key: newNaturalKey, reason: "editor revision" },
    now,
  });
  const proposed = proposeEffect(db, stateDir, {
    now,
    taskId: old.task_id,
    attemptId: old.attempt_id,
    effectType: unescapeKeyComponent(parts.effectType),
    domainKey,
    naturalKey: newNaturalKey,
    operationIntent: editedIntent,
    retryMode: old.retry_mode,
    provider: old.provider,
    resource: old.resource,
    requiresApproval: true,
    approverPrincipalId,
    expiresAt,
  });
  return {
    oldEffectId: effectId,
    oldApprovalId: approvalId,
    newEffectId: proposed.effectId,
    newApprovalId: proposed.approvalId,
    newApprovalNonce: proposed.approvalNonce,
    newActionHash: proposed.actionHash,
    newBusinessKey: proposed.businessKey,
  };
}

// HEAD-change path (04 section 2 "HEAD变化返回需重审"): the dispatcher found
// the target at a different head than the approved action pinned. The old
// effect is cancelled, and a NEW card is minted against the CURRENT head so
// the human re-approves with fresh facts. The consumed old approval stays in
// history; the task parks again for the new one.
export function reproposeHeadChanged(db, stateDir, {
  now,
  effectId,
  currentHead,
  actorId = null,
  expiresAt,
}) {
  if (typeof currentHead !== "string" || currentHead.length === 0) {
    throw new EffectError("reproposeHeadChanged needs the real current head from the transport");
  }
  const old = db.prepare("SELECT * FROM effects WHERE id=?").get(effectId);
  if (!old) throw new EffectError(`effect ${effectId} not found`);
  if (old.state !== "READY") {
    throw new EffectError(`effect ${effectId} is ${old.state}; only a READY effect can be re-proposed after a head change`);
  }
  const parts = splitBusinessKey(old.business_key);
  const domainKey = unescapeKeyComponent(parts.domainKey);
  const oldAction = JSON.parse(old.action_json);
  const newNaturalKey = nextNaturalKeyVersion(db, {
    effectType: unescapeKeyComponent(parts.effectType),
    domainKey,
    naturalKey: unescapeKeyComponent(parts.naturalKey),
  });
  const changed = db.prepare(
    "UPDATE effects SET state='CANCELLED', last_error='head_changed', updated_at=? WHERE id=? AND state='READY'",
  ).run(now, effectId).changes;
  if (changed !== 1) {
    throw new EffectError(`effect ${effectId} left READY before the head-change cancellation`);
  }
  const taskParked = db
    .prepare("UPDATE tasks SET state='WAITING_APPROVAL', updated_at=? WHERE id=? AND state='WAITING_EFFECT'")
    .run(now, old.task_id).changes;
  writeAudit(db, {
    code: "effect_head_changed_reproposed",
    taskId: old.task_id,
    actorId,
    details: {
      old_effect_id: effectId,
      pinned_head: oldAction.expected_head,
      current_head: currentHead,
      new_natural_key: newNaturalKey,
      task_reparked: taskParked === 1,
    },
    now,
  });
  writeStreamEvent(db, {
    scopeId: old.scope_id,
    eventType: "approval_changed",
    entityId: `effect:${effectId}`,
    entityVersion: 2,
    payload: { state: "CANCELLED", reason: "head_changed", current_head: currentHead },
    now,
  });
  const proposed = proposeEffect(db, stateDir, {
    now,
    taskId: old.task_id,
    attemptId: old.attempt_id,
    effectType: unescapeKeyComponent(parts.effectType),
    domainKey,
    naturalKey: newNaturalKey,
    operationIntent: {
      targetResource: oldAction.target_resource,
      operation: oldAction.operation,
      contentHash: oldAction.content_hash,
      attachmentHash: oldAction.attachment_hash ?? null,
      expectedHead: currentHead,
      evidenceManifestHash: oldAction.evidence_manifest_hash,
      // canonicalActionJson spreads extra at the top level, so the recovery
      // is "everything that is not a canonical field".
      extra: { ...extraFieldsOfAction(oldAction), reproposed_from: effectId },
    },
    retryMode: old.retry_mode,
    provider: old.provider,
    resource: old.resource,
    requiresApproval: true,
    approverPrincipalId: db.prepare("SELECT approver_id FROM approvals WHERE effect_id=?").get(effectId)?.approver_id,
    expiresAt,
  });
  return {
    oldEffectId: effectId,
    newEffectId: proposed.effectId,
    newApprovalId: proposed.approvalId,
    newApprovalNonce: proposed.approvalNonce,
    newActionHash: proposed.actionHash,
    pinnedHead: currentHead,
    taskReparked: taskParked === 1,
  };
}
