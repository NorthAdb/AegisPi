// Host-side model_requests state machine & proposal processor (ADR-0001 §2/§3/§4/§6/§7).
//
// Enforces the full validation-before-row-insertion order, idempotent PK
// lookup, same-transaction RESERVED + ledger.reserve, pre-call-only release,
// separate pre-call EXECUTING commit, single-shot pi-ai execution, atomic
// write-back (SETTLED / HELD / ORPHAN), late-usage reconciliation (only from
// request-row EXECUTING + ledger-row HELD), and UUID-validated result delivery.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTx } from "./db/tx.mjs";
import { writeAudit } from "./audit.mjs";
import { PURPOSES } from "./budget.mjs";
import { createCredentialService } from "./credentials.mjs";
import { putObjectContent, insertObjectRow } from "./objects.mjs";
import { completeTaskInTx, deliveryAckCheckpoint, deliveryDone } from "./scheduler.mjs";
import { callModelOnce, isLoopbackModelEndpoint, microusdForUsage } from "./model-call.mjs";
import { crashpoint } from "./testing/crashpoints.mjs";

export class ModelRequestError extends Error {}

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_MODEL_MESSAGES_BYTES = 128 * 1024;

const ALLOWED_ENVELOPE_KEYS = new Set([
  "schemaVersion",
  "kind",
  "requestId",
  "taskId",
  "attemptId",
  "fence",
  "scopeDomainKey",
  "purpose",
  "modelId",
  "messages",
]);
const ALLOWED_MESSAGE_KEYS = new Set(["role", "content"]);
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

export function isUuidV4(value) {
  return typeof value === "string" && UUID_V4_RE.test(value);
}

// requestId must pass UUID v4 validation before entering any host-command filename (ADR §2).
export function modelResultFileName(requestId) {
  if (!isUuidV4(requestId)) {
    throw new ModelRequestError(`refusing non-uuid requestId in result filename: ${JSON.stringify(requestId)}`);
  }
  return `model-result-${requestId}.json`;
}

function writeAtomicJson(dir, filename, payload) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, filename);
  const tmp = join(dir, `${filename}.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(payload) + "\n", "utf8");
  renameSync(tmp, target);
  return target;
}

export function validateModelRequestEnvelope(envelope) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ok: false, code: "invalid_envelope", reason: "envelope must be a JSON object" };
  }
  for (const key of Object.keys(envelope)) {
    if (!ALLOWED_ENVELOPE_KEYS.has(key)) {
      return { ok: false, code: "unknown_field", reason: `unknown envelope field: ${key}` };
    }
  }
  if (envelope.schemaVersion !== 1) {
    return { ok: false, code: "unsupported_schema_version", reason: `unsupported schemaVersion: ${JSON.stringify(envelope.schemaVersion)}` };
  }
  if (envelope.kind !== "model_request") {
    return { ok: false, code: "invalid_kind", reason: `expected kind model_request, got ${JSON.stringify(envelope.kind)}` };
  }
  if (!isUuidV4(envelope.requestId)) {
    return { ok: false, code: "invalid_request_id", reason: "requestId must be a valid UUID v4" };
  }
  for (const field of ["taskId", "attemptId", "scopeDomainKey", "purpose", "modelId"]) {
    if (typeof envelope[field] !== "string" || envelope[field].length === 0 || envelope[field].length > 256) {
      return { ok: false, code: "invalid_field", reason: `${field} must be a non-empty string (<=256 chars)` };
    }
  }
  if (!Number.isInteger(envelope.fence) || envelope.fence <= 0) {
    return { ok: false, code: "invalid_fence", reason: "fence must be a positive integer" };
  }
  if (!Array.isArray(envelope.messages) || envelope.messages.length === 0) {
    return { ok: false, code: "invalid_messages", reason: "messages must be a non-empty array" };
  }
  for (let i = 0; i < envelope.messages.length; i += 1) {
    const m = envelope.messages[i];
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      return { ok: false, code: "invalid_messages", reason: `messages[${i}] must be an object` };
    }
    for (const k of Object.keys(m)) {
      if (!ALLOWED_MESSAGE_KEYS.has(k)) {
        return { ok: false, code: "unknown_field", reason: `unknown message field: ${k}` };
      }
    }
    if (!ALLOWED_ROLES.has(m.role)) {
      return { ok: false, code: "invalid_messages", reason: `messages[${i}].role invalid: ${JSON.stringify(m.role)}` };
    }
    if (typeof m.content !== "string" || m.content.length === 0) {
      return { ok: false, code: "invalid_messages", reason: `messages[${i}].content must be a non-empty string` };
    }
  }
  const msgBytes = Buffer.byteLength(JSON.stringify(envelope.messages), "utf8");
  if (msgBytes > MAX_MODEL_MESSAGES_BYTES) {
    return {
      ok: false,
      code: "messages_too_large",
      reason: `messages exceed 128 KiB hard cap (${msgBytes} > ${MAX_MODEL_MESSAGES_BYTES})`,
    };
  }
  return { ok: true };
}

export function checkModelWhitelists({ purpose, modelId, config }) {
  const allowedPurposes = Array.isArray(config?.model?.allowedPurposes) ? config.model.allowedPurposes : [];
  if (!PURPOSES.includes(purpose) || !allowedPurposes.includes(purpose)) {
    return {
      ok: false,
      code: "purpose_not_allowed",
      reason: `purpose ${JSON.stringify(purpose)} is not permitted by ledger PURPOSES and model.allowedPurposes`,
    };
  }
  const allowedModelIds = Array.isArray(config?.model?.allowedModelIds) ? config.model.allowedModelIds : [];
  if (!allowedModelIds.includes(modelId)) {
    return {
      ok: false,
      code: "model_not_allowed",
      reason: `modelId ${JSON.stringify(modelId)} is not in model.allowedModelIds`,
    };
  }
  return { ok: true };
}

export function checkRunningClaimIdentity(db, { taskId, attemptId, fence, scopeDomainKey, now }) {
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  if (!task) {
    return { ok: false, code: "task_not_found", reason: `task ${taskId} not found` };
  }
  if (task.state !== "RUNNING") {
    return { ok: false, code: "task_not_running", reason: `task ${taskId} is ${task.state}, not RUNNING` };
  }
  if (task.fence !== fence) {
    return { ok: false, code: "fence_mismatch", reason: `task ${taskId} fence is ${task.fence}, envelope carried ${fence}` };
  }
  if (task.lease_expires_at !== null && task.lease_expires_at <= now) {
    return { ok: false, code: "lease_expired", reason: `task ${taskId} lease expired at ${task.lease_expires_at}` };
  }
  const attempt = db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId);
  if (!attempt || attempt.task_id !== taskId || attempt.fence !== fence || attempt.state !== "ACTIVE") {
    return {
      ok: false,
      code: "attempt_mismatch",
      reason: `attempt ${attemptId} does not match ACTIVE RUNNING claim (${taskId}, fence ${fence})`,
    };
  }
  const scope = db.prepare("SELECT * FROM scopes WHERE id=?").get(task.scope_id);
  if (!scope || scope.domain_key !== scopeDomainKey) {
    return {
      ok: false,
      code: "scope_mismatch",
      reason: `scopeDomainKey ${JSON.stringify(scopeDomainKey)} does not match task scope ${JSON.stringify(scope?.domain_key ?? null)}`,
    };
  }
  return { ok: true, task, attempt, scope };
}

function recordRefusal(db, { taskId = null, requestId = null, code, reason, hostCommandsDir = null, now }) {
  withTx(db, () => {
    const safeTaskId = taskId && db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId) ? taskId : null;
    writeAudit(db, {
      code: "model_request_refused",
      taskId: safeTaskId,
      details: { request_id: requestId, reason_code: code, reason },
      now,
    });
  });
  if (hostCommandsDir && isUuidV4(requestId)) {
    writeAtomicJson(hostCommandsDir, modelResultFileName(requestId), {
      kind: "model_result",
      requestId,
      ok: false,
      refusal: { code, reason },
    });
  }
}

// Unified write-back transaction (ADR §6 & §7): transitions request row from
// EXECUTING to SETTLED, HELD, or ORPHAN, and settles the ledger reservation in
// the exact same transaction when usage & price catalog permit.
export function commitModelCallWriteback(db, {
  stateDir,
  ledger,
  requestId,
  call,
  priceCatalog,
  hostCommandsDir = null,
  completeActiveTask = false,
  leaseOwner = null,
  now = Date.now(),
  auditCodeOnSettle = null,
}) {
  const reqRowPre = db.prepare("SELECT * FROM model_requests WHERE request_id=?").get(requestId);
  if (!reqRowPre) {
    throw new ModelRequestError(`model_request ${requestId} not found`);
  }
  if (reqRowPre.state !== "EXECUTING") {
    withTx(db, () => {
      writeAudit(db, {
        code: "model_late_usage_dropped",
        taskId: reqRowPre.task_id,
        details: { request_id: requestId, request_state: reqRowPre.state, reason: "request row is not EXECUTING" },
        now,
      });
    });
    return { status: "dropped", state: reqRowPre.state, settled: false };
  }

  const taskPre = db.prepare("SELECT * FROM tasks WHERE id=?").get(reqRowPre.task_id);
  const attemptPre = db.prepare("SELECT * FROM attempts WHERE id=?").get(reqRowPre.attempt_id);
  const taskIsTerminal =
    !taskPre ||
    taskPre.state !== "RUNNING" ||
    taskPre.fence !== reqRowPre.fence ||
    !attemptPre ||
    attemptPre.state !== "ACTIVE";

  if (!call.ok) {
    withTx(db, () => {
      const reqNow = db.prepare("SELECT * FROM model_requests WHERE request_id=?").get(requestId);
      if (!reqNow || reqNow.state !== "EXECUTING") return;
      writeAudit(db, {
        code: "model_call_failed",
        taskId: reqNow.task_id,
        details: {
          request_id: requestId,
          error: String(call.error ?? "model call failed").slice(0, 200),
          reservation: reqNow.reservation_id,
        },
        now,
      });
      if (taskIsTerminal) {
        db.prepare("UPDATE model_requests SET state='ORPHAN', error_code='task_terminal_on_failed_call', updated_at=? WHERE request_id=? AND state='EXECUTING'")
          .run(now, requestId);
        writeAudit(db, {
          code: "model_result_orphan",
          taskId: reqNow.task_id,
          details: { request_id: requestId, reservation: reqNow.reservation_id, task_state: taskPre?.state ?? "missing", call_ok: false },
          now,
        });
      }
    });
    if (!taskIsTerminal && hostCommandsDir && isUuidV4(requestId)) {
      writeAtomicJson(hostCommandsDir, modelResultFileName(requestId), {
        kind: "model_result",
        requestId,
        ok: false,
        refusal: { code: call.kind ?? "model_call_failed", reason: call.error ?? "model call failed" },
      });
    }
    return {
      status: taskIsTerminal ? "orphan_failed_call" : "call_failed",
      state: taskIsTerminal ? "ORPHAN" : "EXECUTING",
      reservationState: ledger.reservationRow(reqRowPre.reservation_id)?.state ?? null,
      settled: false,
    };
  }

  const priced = microusdForUsage(call.usage, priceCatalog, { stopReason: call.stopReason });
  const replyTrimmed = (call.reply ?? "").slice(0, 4000);
  const evidencePayload = JSON.stringify({
    done: true,
    at: now,
    worker: "pi-ai",
    requestId,
    model: call.model ?? reqRowPre.model_id,
    endpoint: call.endpoint ?? null,
    reply: replyTrimmed,
    usage: call.usage ?? null,
    settledMicrousd: priced,
  });
  const storedEvidence = putObjectContent(stateDir, evidencePayload);

  const txOut = withTx(db, () => {
    const reqNow = db.prepare("SELECT * FROM model_requests WHERE request_id=?").get(requestId);
    const resNow = reqNow?.reservation_id ? ledger.reservationRow(reqNow.reservation_id) : null;
    if (!reqNow || reqNow.state !== "EXECUTING" || !resNow || resNow.state !== "HELD") {
      writeAudit(db, {
        code: "model_late_usage_dropped",
        taskId: reqRowPre.task_id,
        details: {
          request_id: requestId,
          request_state: reqNow?.state ?? null,
          reservation_state: resNow?.state ?? null,
          reason: "entry requires request=EXECUTING and ledger=HELD",
        },
        now,
      });
      return { status: "dropped", state: reqNow?.state ?? null, reservationState: resNow?.state ?? null, settled: false };
    }

    const taskNow = db.prepare("SELECT * FROM tasks WHERE id=?").get(reqNow.task_id);
    const attemptNow = db.prepare("SELECT * FROM attempts WHERE id=?").get(reqNow.attempt_id);
    const isTerminalNow =
      !taskNow ||
      taskNow.state !== "RUNNING" ||
      taskNow.fence !== reqNow.fence ||
      !attemptNow ||
      attemptNow.state !== "ACTIVE";

    const scopeId = taskNow.scope_id;
    const evidence = insertObjectRow(db, {
      scopeId,
      kind: "task_result",
      sourceUri: `task:${reqNow.task_id}:req:${requestId}`,
      sourceActor: "model-worker",
      contentHash: storedEvidence.contentHash,
      storageRef: storedEvidence.storageRef,
      observedAt: now,
      requiredScopeIds: [scopeId],
    });

    let settled = false;
    let finalRequestState;
    if (priced !== null) {
      ledger.settleInTx({
        reservationId: reqNow.reservation_id,
        usage: {
          actualMicrousd: priced,
          source: "pi-ai",
          basis: "four-field usage from pi-ai 1.5.2 priced by host catalog",
        },
        now,
        actorId: "model-worker",
      });
      settled = true;
      if (auditCodeOnSettle) {
        writeAudit(db, {
          code: auditCodeOnSettle,
          taskId: reqNow.task_id,
          details: { request_id: requestId, reservation_id: reqNow.reservation_id, actual_microusd: priced },
          now,
        });
      }
      finalRequestState = isTerminalNow ? "ORPHAN" : "SETTLED";
    } else {
      finalRequestState = isTerminalNow ? "ORPHAN" : "HELD";
      writeAudit(db, {
        code: "model_usage_not_settled",
        taskId: reqNow.task_id,
        details: {
          reason: call.usage ? "usage missing totalFromProvider/zero or category rate null" : "no usage block",
          reservation: reqNow.reservation_id,
          request_id: requestId,
          usage: call.usage ?? null,
        },
        now,
      });
    }

    if (isTerminalNow) {
      db.prepare(
        "UPDATE model_requests SET state='ORPHAN', reply_object_id=?, error_code='task_terminal_before_writeback', updated_at=? WHERE request_id=? AND state='EXECUTING'",
      ).run(evidence.id, now, requestId);
      writeAudit(db, {
        code: "model_result_orphan",
        taskId: reqNow.task_id,
        details: {
          request_id: requestId,
          reservation: reqNow.reservation_id,
          reply_object_id: evidence.id,
          task_state: taskNow?.state ?? "missing",
          settled_microusd: priced,
        },
        now,
      });
    } else {
      db.prepare(
        "UPDATE model_requests SET state=?, reply_object_id=?, error_code=?, updated_at=? WHERE request_id=? AND state='EXECUTING'",
      ).run(finalRequestState, evidence.id, priced === null ? "usage_not_settled" : null, now, requestId);
    }

    if (!isTerminalNow && completeActiveTask) {
      const effectiveLeaseOwner = leaseOwner ?? taskNow.lease_owner;
      if (effectiveLeaseOwner) {
        completeTaskInTx(db, {
          taskId: reqNow.task_id,
          attemptNo: taskNow.attempt_no,
          leaseOwner: effectiveLeaseOwner,
          fence: taskNow.fence,
          now,
          resultClass: "not_applicable",
          resultObjectId: evidence.id,
        });
      }
    }

    const resAfter = ledger.reservationRow(reqNow.reservation_id);
    return {
      status: isTerminalNow ? "orphan" : finalRequestState === "SETTLED" ? "settled" : "held",
      state: finalRequestState,
      reservationState: resAfter?.state ?? null,
      actualMicrousd: priced,
      replyObjectId: evidence.id,
      settled,
      orphan: isTerminalNow,
    };
  });

  if (txOut.status !== "dropped" && !txOut.orphan && completeActiveTask && taskPre) {
    const pending = db
      .prepare("SELECT event_id FROM event_deliveries WHERE task_id=? AND state='PENDING'")
      .get(reqRowPre.task_id);
    if (pending) {
      const ck = insertObjectRow(db, {
        scopeId: taskPre.scope_id,
        kind: "session_checkpoint",
        sourceUri: `cmd:${pending.event_id}:${reqRowPre.task_id}`,
        sourceActor: "host",
        content: "model worker consumed the event",
        observedAt: now,
        requiredScopeIds: [taskPre.scope_id],
      });
      deliveryAckCheckpoint(db, { eventId: pending.event_id, taskId: reqRowPre.task_id, checkpointObjectId: ck.id, now });
      deliveryDone(db, { eventId: pending.event_id, taskId: reqRowPre.task_id, now });
    }
  }

  if (txOut.status !== "dropped" && !txOut.orphan && hostCommandsDir) {
    writeAtomicJson(hostCommandsDir, modelResultFileName(requestId), {
      kind: "model_result",
      requestId,
      ok: true,
      reply: call.reply ?? "",
      usage: call.usage ?? null,
    });
  }

  return txOut;
}

export function processModelRequest(db, {
  stateDir,
  config,
  ledger,
  envelope,
  hostCommandsDir = null,
  completeActiveTask = false,
  preCallCancelled = false,
  now = Date.now(),
}) {
  // 1. Validate closed envelope shape BEFORE inserting any DB row (ADR §2/§7, D-78).
  const envCheck = validateModelRequestEnvelope(envelope);
  if (!envCheck.ok) {
    recordRefusal(db, {
      taskId: typeof envelope?.taskId === "string" ? envelope.taskId : null,
      requestId: isUuidV4(envelope?.requestId) ? envelope.requestId : null,
      code: envCheck.code,
      reason: envCheck.reason,
      hostCommandsDir,
      now,
    });
    return { accepted: false, status: "refused", code: envCheck.code, reason: envCheck.reason, rowCreated: false };
  }

  // 2. Dual whitelist: purpose (PURPOSES + allowedPurposes) and modelId (allowedModelIds) (ADR §3).
  const wlCheck = checkModelWhitelists({ purpose: envelope.purpose, modelId: envelope.modelId, config });
  if (!wlCheck.ok) {
    recordRefusal(db, {
      taskId: envelope.taskId,
      requestId: envelope.requestId,
      code: wlCheck.code,
      reason: wlCheck.reason,
      hostCommandsDir,
      now,
    });
    return { accepted: false, status: "refused", code: wlCheck.code, reason: wlCheck.reason, rowCreated: false };
  }

  // 3. Idempotent PK lookup: duplicate requestId reads existing state, never double-reserves or double-calls (ADR §4/§7, T3).
  const existing = db.prepare("SELECT * FROM model_requests WHERE request_id=?").get(envelope.requestId);
  if (existing) {
    if (
      existing.task_id !== envelope.taskId ||
      existing.attempt_id !== envelope.attemptId ||
      existing.fence !== envelope.fence ||
      existing.scope_domain_key !== envelope.scopeDomainKey
    ) {
      recordRefusal(db, {
        taskId: envelope.taskId,
        requestId: envelope.requestId,
        code: "request_id_identity_conflict",
        reason: `requestId ${envelope.requestId} already bound to a different task/attempt/fence/scope`,
        hostCommandsDir,
        now,
      });
      return { accepted: false, status: "refused", code: "request_id_identity_conflict", rowCreated: false };
    }
    withTx(db, () => {
      writeAudit(db, {
        code: "model_request_duplicate",
        taskId: existing.task_id,
        details: { request_id: existing.request_id, state: existing.state, reservation_id: existing.reservation_id },
        now,
      });
    });
    return {
      accepted: true,
      duplicate: true,
      status: "duplicate",
      state: existing.state,
      reservationId: existing.reservation_id,
      replyObjectId: existing.reply_object_id,
      rowCreated: false,
    };
  }

  // 4. Identity quadruple re-check against RUNNING claim row (ADR §2/§4).
  const idCheck = checkRunningClaimIdentity(db, {
    taskId: envelope.taskId,
    attemptId: envelope.attemptId,
    fence: envelope.fence,
    scopeDomainKey: envelope.scopeDomainKey,
    now,
  });
  if (!idCheck.ok) {
    recordRefusal(db, {
      taskId: envelope.taskId,
      requestId: envelope.requestId,
      code: idCheck.code,
      reason: idCheck.reason,
      hostCommandsDir,
      now,
    });
    return { accepted: false, status: "refused", code: idCheck.code, reason: idCheck.reason, rowCreated: false };
  }

  // 5. Endpoint authorization gate (fail-closed if baseUrl null or non-loopback without allowRealModelCalls).
  if (!config?.model?.baseUrl) {
    return { accepted: false, status: "pending_no_base_url", rowCreated: false };
  }
  const authorizedForModel = isLoopbackModelEndpoint(config.model.baseUrl) || config.model.allowRealModelCalls === true;
  if (!authorizedForModel) {
    recordRefusal(db, {
      taskId: envelope.taskId,
      requestId: envelope.requestId,
      code: "endpoint_not_authorized",
      reason: "model.baseUrl is non-loopback and model.allowRealModelCalls is false",
      hostCommandsDir,
      now,
    });
    return { accepted: false, status: "refused", code: "endpoint_not_authorized", rowCreated: false };
  }

  // 6. All validations passed -> insert RECEIVED row (ADR §7).
  withTx(db, () => {
    db.prepare(
      `INSERT INTO model_requests(request_id, task_id, attempt_id, fence, scope_domain_key, purpose, model_id,
         state, reservation_id, reply_object_id, error_code, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'RECEIVED', NULL, NULL, NULL, ?, ?)`,
    ).run(
      envelope.requestId,
      envelope.taskId,
      envelope.attemptId,
      envelope.fence,
      envelope.scopeDomainKey,
      envelope.purpose,
      envelope.modelId,
      now,
      now,
    );
  });

  // 7. Same-transaction ledger.reserve + RECEIVED -> RESERVED (ADR §7).
  const upperMicrousd = config.model.callUpperMicrousd ?? 1000;
  const provider = envelope.modelId.split("/")[0] || config.model.provider || "deepseek";
  let reservationId = null;
  try {
    reservationId = withTx(db, () => {
      const taskAcc = ledger.ensureTaskAccount({ taskId: envelope.taskId, now }).accountId;
      const dayAcc = ledger.ensureDayAccount({ now }).accountId;
      const res = ledger.reserveInTx({
        requestKey: `model:${envelope.requestId}`,
        taskId: envelope.taskId,
        purpose: envelope.purpose,
        provider,
        priceVersion: "catalog-v1",
        upperMicrousd,
        accounts: [
          { accountId: taskAcc, amountMicrousd: Math.ceil(upperMicrousd / 2) },
          { accountId: dayAcc, amountMicrousd: Math.floor(upperMicrousd / 2) },
        ],
        now,
      });
      const changed = db
        .prepare("UPDATE model_requests SET state='RESERVED', reservation_id=?, updated_at=? WHERE request_id=? AND state='RECEIVED'")
        .run(res.reservationId, now, envelope.requestId).changes;
      if (changed !== 1) {
        throw new ModelRequestError(`failed to transition ${envelope.requestId} RECEIVED->RESERVED`);
      }
      return res.reservationId;
    });
  } catch (e) {
    // BudgetExceeded / AccountFrozen: reservation rolled back, mark request FAILED before any call (T2 subcase 2).
    withTx(db, () => {
      db.prepare("UPDATE model_requests SET state='FAILED', error_code=?, updated_at=? WHERE request_id=? AND state='RECEIVED'")
        .run(e.constructor?.name ?? "budget_refused", now, envelope.requestId);
      writeAudit(db, {
        code: "model_request_refused",
        taskId: envelope.taskId,
        details: { request_id: envelope.requestId, reason_code: e.constructor?.name ?? "budget_refused", reason: e.message },
        now,
      });
    });
    if (hostCommandsDir) {
      writeAtomicJson(hostCommandsDir, modelResultFileName(envelope.requestId), {
        kind: "model_result",
        requestId: envelope.requestId,
        ok: false,
        refusal: { code: "budget_refused", reason: e.message },
      });
    }
    return {
      accepted: false,
      status: "budget_refused",
      state: "FAILED",
      reason: e.message,
      rowCreated: true,
    };
  }

  // Crashpoint window between RESERVED and EXECUTING (T5).
  crashpoint("model_requests:after-reserve-before-executing");

  // 8. Pre-call cancellation seam (T4): only RESERVED can release before EXECUTING commits.
  const taskBeforeExec = db.prepare("SELECT state FROM tasks WHERE id=?").get(envelope.taskId);
  if (preCallCancelled || !taskBeforeExec || taskBeforeExec.state === "CANCELLED") {
    return cancelPreCallModelRequest(db, {
      ledger,
      requestId: envelope.requestId,
      reason: preCallCancelled ? "pre_call_cancelled" : `task_${taskBeforeExec?.state ?? "missing"}_before_executing`,
      now,
    });
  }

  // 9. Separate transaction: RESERVED -> EXECUTING committed strictly before spawning child (ADR §7).
  withTx(db, () => {
    const changed = db
      .prepare("UPDATE model_requests SET state='EXECUTING', updated_at=? WHERE request_id=? AND state='RESERVED'")
      .run(now, envelope.requestId).changes;
    if (changed !== 1) {
      throw new ModelRequestError(`cannot commit EXECUTING for ${envelope.requestId}`);
    }
  });

  // Crashpoint window after EXECUTING commit, before/during call (T6).
  crashpoint("model_requests:after-executing-before-call");

  // 10. Execute single inference via unique pi-ai core; key resolved from host credential slot "model".
  const cred = createCredentialService(db).resolve("model");
  const bearer = cred.ok === true ? cred.value : null;
  const call = callModelOnce({
    baseUrl: config.model.baseUrl,
    model: envelope.modelId,
    messages: envelope.messages,
    timeoutMs: config.model.callTimeoutMs ?? 60000,
    bearer,
  });

  // Optional test capture hook for T7 (call finished and usage obtained, write-back not yet committed).
  if (process.env.AEGISPI_T7_CAPTURE_PATH) {
    writeFileSync(
      process.env.AEGISPI_T7_CAPTURE_PATH,
      JSON.stringify({ requestId: envelope.requestId, call }),
      "utf8",
    );
  }
  crashpoint("model_requests:after-call-before-writeback");

  // 11. Atomic write-back (after-call wall clock).
  return commitModelCallWriteback(db, {
    stateDir,
    ledger,
    requestId: envelope.requestId,
    call,
    priceCatalog: config.model.priceCatalog,
    hostCommandsDir,
    completeActiveTask,
    leaseOwner: idCheck.task.lease_owner,
    now: Date.now(),
  });
}

// Pre-call cancellation / attempt abandonment (T4 & T5): only RESERVED may release.
export function cancelPreCallModelRequest(db, { ledger, requestId, reason = "pre_call_cancelled", now = Date.now() }) {
  return withTx(db, () => {
    const req = db.prepare("SELECT * FROM model_requests WHERE request_id=?").get(requestId);
    if (!req) {
      throw new ModelRequestError(`model_request ${requestId} not found`);
    }
    if (req.state !== "RESERVED") {
      throw new ModelRequestError(`model_request ${requestId} is ${req.state}; only pre-call RESERVED can release`);
    }
    ledger.releaseInTx({
      reservationId: req.reservation_id,
      reason,
      now,
      actorId: "model-worker",
    });
    const changed = db
      .prepare("UPDATE model_requests SET state='FAILED', error_code=?, updated_at=? WHERE request_id=? AND state='RESERVED'")
      .run(reason, now, requestId).changes;
    if (changed !== 1) {
      throw new ModelRequestError(`failed to mark ${requestId} FAILED after pre-call release`);
    }
    writeAudit(db, {
      code: "model_request_released_pre_call",
      taskId: req.task_id,
      details: { request_id: requestId, reservation_id: req.reservation_id, reason },
      now,
    });
    return {
      accepted: false,
      status: "released_pre_call",
      state: "FAILED",
      reservationState: "RELEASED",
      released: true,
    };
  });
}

// Pure ledger + DB late-usage reconciliation (T7): only valid from request=EXECUTING AND ledger=HELD.
// Never invokes the model client.
export function settleLateModelUsage(db, {
  stateDir,
  ledger,
  requestId,
  usage,
  reply = "",
  stopReason = "stop",
  model = "deepseek-flash",
  endpoint = null,
  priceCatalog,
  hostCommandsDir = null,
  completeActiveTask = false,
  now = Date.now(),
}) {
  return commitModelCallWriteback(db, {
    stateDir,
    ledger,
    requestId,
    call: { ok: true, reply, usage, model, endpoint, stopReason },
    priceCatalog,
    hostCommandsDir,
    completeActiveTask,
    now,
    auditCodeOnSettle: "model_late_usage_settled",
  });
}

// Scan <stateDir>/agent-work/<safeTask>/<attemptNo>/proposals/ for pending
// model-request-*.json files and drive each through processModelRequest.
export function processPendingModelProposals(db, {
  stateDir,
  config,
  ledger,
  completeActiveTask = true,
  now = Date.now(),
}) {
  const workRoot = join(stateDir, "agent-work");
  if (!existsSync(workRoot)) return { processed: 0, results: [] };
  const results = [];
  let taskDirs = [];
  try {
    taskDirs = readdirSync(workRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return { processed: 0, results: [] };
  }
  for (const tDir of taskDirs) {
    const tPath = join(workRoot, tDir);
    let attemptDirs = [];
    try {
      attemptDirs = readdirSync(tPath, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      continue;
    }
    for (const aDir of attemptDirs) {
      const attemptDir = join(tPath, aDir);
      const proposalsDir = join(attemptDir, "proposals");
      const commandsDir = join(attemptDir, "host-commands");
      if (!existsSync(proposalsDir)) continue;
      const consumedPath = join(attemptDir, ".daemon-consumed.json");
      let consumed = {};
      if (existsSync(consumedPath)) {
        try {
          consumed = JSON.parse(readFileSync(consumedPath, "utf8")) ?? {};
        } catch {
          consumed = {};
        }
      }
      let files = [];
      try {
        files = readdirSync(proposalsDir)
          .filter((f) => f.startsWith("model-request-") && f.endsWith(".json") && !f.includes(".tmp"))
          .sort();
      } catch {
        continue;
      }
      let dirty = false;
      for (const f of files) {
        const fPath = join(proposalsDir, f);
        let st;
        try {
          st = statSync(fPath);
        } catch {
          continue;
        }
        const prev = consumed[f];
        if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
          continue;
        }
        let envelope;
        try {
          envelope = JSON.parse(readFileSync(fPath, "utf8"));
        } catch (e) {
          recordRefusal(db, {
            taskId: null,
            requestId: null,
            code: "invalid_json",
            reason: `unparseable proposal ${f}: ${e.message}`,
            hostCommandsDir: null,
            now,
          });
          consumed[f] = { mtimeMs: st.mtimeMs, size: st.size };
          dirty = true;
          results.push({ file: f, status: "refused", code: "invalid_json" });
          continue;
        }
        const outcome = processModelRequest(db, {
          stateDir,
          config,
          ledger,
          envelope,
          hostCommandsDir: commandsDir,
          completeActiveTask,
          now,
        });
        results.push({ file: f, ...outcome });
        if (outcome.status !== "pending_no_base_url") {
          consumed[f] = { mtimeMs: st.mtimeMs, size: st.size };
          dirty = true;
        }
      }
      if (dirty) {
        writeFileSync(consumedPath, JSON.stringify(consumed, null, 2) + "\n", "utf8");
      }
    }
  }
  return { processed: results.length, results };
}
