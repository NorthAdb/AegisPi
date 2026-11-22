// Host-side model_requests state machine & proposal processor (ADR-0001 §2/§3/§4/§6/§7).
//
// Enforces the full validation-before-row-insertion order, idempotent PK
// lookup, same-transaction RESERVED + ledger.reserve, pre-call-only release,
// separate pre-call EXECUTING commit, single-shot pi-ai execution, atomic
// write-back (SETTLED / HELD / ORPHAN), late-usage reconciliation (only from
// request-row EXECUTING + ledger-row HELD), and UUID-validated result delivery.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTx } from "./db/tx.mjs";
import { writeAudit } from "./audit.mjs";
import { PURPOSES } from "./budget.mjs";
import { safeTaskDirComponent } from "./container-executor.mjs";
import { createCredentialService } from "./credentials.mjs";
import { putObjectContent, insertObjectRow } from "./objects.mjs";
import { observeManifestObjectIdForAttempt } from "./repo-observe.mjs";
import {
  completePendingDeliveryCheckpointInTx,
  completeTaskInTx,
  deliveryReturnedInTx,
  heartbeat,
} from "./scheduler.mjs";
import { assertSessionFresh } from "./memory.mjs";
import {
  assertValidModelBaseUrl,
  callModelOnce,
  callModelOnceAsync,
  isLoopbackModelEndpoint,
  MAX_MODEL_MESSAGES_BYTES,
  microusdForUsage,
  parseModelWhitelistKey,
  validateModelMessages,
  validateModelTokenCaps,
} from "./model-call.mjs";
import { crashpoint } from "./testing/crashpoints.mjs";

export class ModelRequestError extends Error {}

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export { MAX_MODEL_MESSAGES_BYTES };
export const MAX_PROPOSAL_FILE_BYTES = MAX_MODEL_MESSAGES_BYTES + 16 * 1024;

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
  const msgCheck = validateModelMessages(envelope.messages);
  if (!msgCheck.ok) {
    return msgCheck;
  }
  return { ok: true };
}

export function checkModelWhitelists({ purpose, modelId, config, warmingEnabled = config?.budget?.warmingEnabled ?? false }) {
  const allowedPurposes = Array.isArray(config?.model?.allowedPurposes) ? config.model.allowedPurposes : [];
  if (!PURPOSES.includes(purpose) || !allowedPurposes.includes(purpose)) {
    return {
      ok: false,
      code: "purpose_not_allowed",
      reason: `purpose ${JSON.stringify(purpose)} is not permitted by ledger PURPOSES and model.allowedPurposes`,
    };
  }
  if (purpose === "warming" && warmingEnabled === false) {
    return {
      ok: false,
      code: "warming_disabled",
      reason: "warming is off: purpose=warming cannot reserve",
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

function writeRefusalResultFile(db, { requestId, code, reason, hostCommandsDir, allowOverwrite = false }) {
  if (!hostCommandsDir || !isUuidV4(requestId)) return;
  const filename = modelResultFileName(requestId);
  if (!allowOverwrite) {
    const existingRow = db.prepare("SELECT 1 FROM model_requests WHERE request_id=?").get(requestId);
    if (existingRow || existsSync(join(hostCommandsDir, filename))) {
      return;
    }
  }
  writeAtomicJson(hostCommandsDir, filename, {
    kind: "model_result",
    requestId,
    ok: false,
    refusal: { code, reason },
  });
}

function recordRefusalInTx(db, { taskId = null, requestId = null, code, reason, now }) {
  const safeTaskId = taskId && db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId) ? taskId : null;
  writeAudit(db, {
    code: "model_request_refused",
    taskId: safeTaskId,
    details: { request_id: requestId, reason_code: code, reason },
    now,
  });
}

function recordRefusal(db, { taskId = null, requestId = null, code, reason, hostCommandsDir = null, now }) {
  withTx(db, () => {
    recordRefusalInTx(db, { taskId, requestId, code, reason, now });
  });
  writeRefusalResultFile(db, { requestId, code, reason, hostCommandsDir, allowOverwrite: false });
}

function isClaimExpiredOrTerminal(task, attempt, expectedFence, now) {
  const leaseExpired = Boolean(task && task.lease_expires_at !== null && task.lease_expires_at <= now);
  return {
    leaseExpired,
    terminal:
      !task ||
      task.state !== "RUNNING" ||
      task.fence !== expectedFence ||
      !attempt ||
      attempt.state !== "ACTIVE" ||
      leaseExpired,
  };
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
  requireSettledForCompletion = false,
  parentObjectIds = [],
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
  const preStatus = isClaimExpiredOrTerminal(taskPre, attemptPre, reqRowPre.fence, now);

  if (!call.ok) {
    withTx(db, () => {
      const reqNow = db.prepare("SELECT * FROM model_requests WHERE request_id=?").get(requestId);
      if (!reqNow || reqNow.state !== "EXECUTING") return;
      writeAudit(db, {
        code: "model_call_failed",
        taskId: taskPre ? reqNow.task_id : null,
        details: {
          request_id: requestId,
          error: String(call.error ?? "model call failed").slice(0, 200),
          reservation: reqNow.reservation_id,
        },
        now,
      });
      if (preStatus.terminal) {
        db.prepare("UPDATE model_requests SET state='ORPHAN', error_code=?, updated_at=? WHERE request_id=? AND state='EXECUTING'")
          .run(preStatus.leaseExpired ? "lease_expired_on_failed_call" : "task_terminal_on_failed_call", now, requestId);
        writeAudit(db, {
          code: "model_result_orphan",
          taskId: taskPre ? reqNow.task_id : null,
          details: { request_id: requestId, reservation: reqNow.reservation_id, task_state: taskPre?.state ?? "missing", call_ok: false },
          now,
        });
      } else {
        const errCode = call.kind === "timeout" ? "model_timeout" : (call.kind ?? "model_call_failed");
        db.prepare("UPDATE model_requests SET error_code=?, updated_at=? WHERE request_id=? AND state='EXECUTING'")
          .run(errCode, now, requestId);
      }
    });
    if (!preStatus.terminal && hostCommandsDir && isUuidV4(requestId)) {
      writeAtomicJson(hostCommandsDir, modelResultFileName(requestId), {
        kind: "model_result",
        requestId,
        ok: false,
        refusal: { code: call.kind ?? "model_call_failed", reason: call.error ?? "model call failed" },
      });
    }
    return {
      status: preStatus.terminal ? "orphan_failed_call" : "call_failed",
      state: preStatus.terminal ? "ORPHAN" : "EXECUTING",
      reservationState: ledger.reservationRow(reqRowPre.reservation_id)?.state ?? null,
      settled: false,
    };
  }

  const priced = microusdForUsage(call.usage, priceCatalog);
  const replyTrimmed = (call.reply ?? "").slice(0, 4000);
  const evidencePayload = JSON.stringify({
    done: true,
    at: now,
    worker: "pi-ai",
    requestId,
    model: call.model ?? reqRowPre.model_id,
    endpoint: call.endpoint ?? null,
    reply: replyTrimmed,
    stopReason: call.stopReason ?? null,
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
    const nowStatus = isClaimExpiredOrTerminal(taskNow, attemptNow, reqNow.fence, now);
    const observeManifestId = observeManifestObjectIdForAttempt(db, reqNow.attempt_id);
    const effectiveParents =
      parentObjectIds.length > 0 ? parentObjectIds : observeManifestId ? [observeManifestId] : [];
    const mustSettleToComplete = requireSettledForCompletion || Boolean(observeManifestId);

    const scopeId =
      taskNow?.scope_id ??
      db.prepare("SELECT id FROM scopes WHERE domain_key=?").get(reqNow.scope_domain_key)?.id ??
      null;
    const evidence = scopeId
      ? insertObjectRow(db, {
          scopeId,
          kind: "task_result",
          sourceUri: `task:${reqNow.task_id}:req:${requestId}`,
          sourceActor: "model-worker",
          contentHash: storedEvidence.contentHash,
          storageRef: storedEvidence.storageRef,
          observedAt: now,
          requiredScopeIds: [scopeId],
          parents: effectiveParents.map((id) => ({ parentId: id, relation: "derived_from" })),
        })
      : null;

    let settled = false;
    let finalRequestState;
    const auditTaskId = taskNow ? reqNow.task_id : null;
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
          taskId: auditTaskId,
          details: { request_id: requestId, reservation_id: reqNow.reservation_id, actual_microusd: priced },
          now,
        });
      }
      finalRequestState = nowStatus.terminal ? "ORPHAN" : "SETTLED";
    } else {
      finalRequestState = nowStatus.terminal ? "ORPHAN" : "HELD";
      writeAudit(db, {
        code: "model_usage_not_settled",
        taskId: auditTaskId,
        details: {
          reason: call.usage ? "usage missing totalFromProvider/zero or category rate null" : "no usage block",
          reservation: reqNow.reservation_id,
          request_id: requestId,
          usage: call.usage ?? null,
        },
        now,
      });
    }

    if (nowStatus.terminal) {
      db.prepare(
        "UPDATE model_requests SET state='ORPHAN', reply_object_id=?, error_code=?, updated_at=? WHERE request_id=? AND state='EXECUTING'",
      ).run(evidence?.id ?? null, nowStatus.leaseExpired ? "lease_expired_before_writeback" : "task_terminal_before_writeback", now, requestId);
      writeAudit(db, {
        code: "model_result_orphan",
        taskId: auditTaskId,
        details: {
          request_id: requestId,
          reservation: reqNow.reservation_id,
          reply_object_id: evidence?.id ?? null,
          task_state: taskNow?.state ?? "missing",
          lease_expired: nowStatus.leaseExpired,
          settled_microusd: priced,
        },
        now,
      });
    } else {
      db.prepare(
        "UPDATE model_requests SET state=?, reply_object_id=?, error_code=?, updated_at=? WHERE request_id=? AND state='EXECUTING'",
      ).run(finalRequestState, evidence?.id ?? null, priced === null ? "usage_not_settled" : null, now, requestId);
    }

    const emptyReply = typeof call.reply !== "string" || call.reply.trim().length === 0;
    const emptyErrorCode = call.stopReason === "length" ? "model_output_truncated_empty" : "model_empty_reply";
    let taskFailed = false;
    if (!nowStatus.terminal && completeActiveTask && evidence?.id) {
      const effectiveLeaseOwner = leaseOwner ?? taskNow.lease_owner;
      if (effectiveLeaseOwner) {
        if (mustSettleToComplete && !settled) {
          taskFailed = true;
          completeTaskInTx(db, {
            taskId: reqNow.task_id,
            attemptNo: taskNow.attempt_no,
            leaseOwner: effectiveLeaseOwner,
            fence: taskNow.fence,
            now,
            resultClass: "infra_error",
            resultObjectId: evidence.id,
            errorCode: "settlement_held_uncompleted",
          });
          writeAudit(db, {
            code: "observe_stopped_settlement_held",
            taskId: reqNow.task_id,
            details: {
              request_id: requestId,
              reservation_id: reqNow.reservation_id,
              reason: "settlement remained HELD; repo-observe loop refused to mark succeeded",
            },
            now,
          });
        } else if (emptyReply) {
          taskFailed = true;
          completeTaskInTx(db, {
            taskId: reqNow.task_id,
            attemptNo: taskNow.attempt_no,
            leaseOwner: effectiveLeaseOwner,
            fence: taskNow.fence,
            now,
            resultClass: "infra_error",
            resultObjectId: evidence.id,
            errorCode: emptyErrorCode,
          });
          writeAudit(db, {
            code: "model_empty_reply_uncompleted",
            taskId: reqNow.task_id,
            details: {
              request_id: requestId,
              reservation_id: reqNow.reservation_id,
              stop_reason: call.stopReason ?? null,
              error_code: emptyErrorCode,
            },
            now,
          });
        } else {
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
        if (taskFailed) {
          // EVERY open delivery returns, not just the first: a batch task
          // carries several, and one stranded PENDING on a terminal task
          // would leave its inbox row unable to reach DONE.
          const openDeliveries = db
            .prepare("SELECT event_id FROM event_deliveries WHERE task_id=? AND state IN ('PENDING','ACKED')")
            .all(reqNow.task_id);
          for (const open of openDeliveries) {
            deliveryReturnedInTx(db, {
              eventId: open.event_id,
              taskId: reqNow.task_id,
              now,
              reason: mustSettleToComplete && !settled ? "settlement_held_uncompleted" : emptyErrorCode,
            });
          }
        } else {
          completePendingDeliveryCheckpointInTx(db, {
            taskId: reqNow.task_id,
            scopeId: taskNow.scope_id,
            content: "model worker consumed the event",
            insertObjectRowFn: insertObjectRow,
            now,
          });
        }
      }
    }

    const resAfter = ledger.reservationRow(reqNow.reservation_id);
    return {
      status: nowStatus.terminal ? "orphan" : finalRequestState === "SETTLED" ? "settled" : "held",
      state: finalRequestState,
      reservationState: resAfter?.state ?? null,
      actualMicrousd: priced,
      replyObjectId: evidence?.id ?? null,
      settled,
      orphan: nowStatus.terminal,
      taskFailed,
      emptyReply,
      emptyErrorCode,
    };
  });

  if (txOut.status !== "dropped" && !txOut.orphan && hostCommandsDir) {
    writeAtomicJson(
      hostCommandsDir,
      modelResultFileName(requestId),
      txOut.emptyReply
        ? {
            kind: "model_result",
            requestId,
            ok: false,
            refusal: { code: txOut.emptyErrorCode, reason: "model returned an empty reply" },
            usage: call.usage ?? null,
          }
        : {
            kind: "model_result",
            requestId,
            ok: true,
            reply: call.reply ?? "",
            usage: call.usage ?? null,
          },
    );
  }

  return txOut;
}

function validateAndAuthorizeModelProposal(db, { config, envelope, hostCommandsDir, warmingEnabled, now }) {
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
    return { ok: false, result: { accepted: false, status: "refused", code: envCheck.code, reason: envCheck.reason, rowCreated: false } };
  }
  const wlCheck = checkModelWhitelists({
    purpose: envelope.purpose,
    modelId: envelope.modelId,
    config,
    warmingEnabled,
  });
  if (!wlCheck.ok) {
    recordRefusal(db, {
      taskId: envelope.taskId,
      requestId: envelope.requestId,
      code: wlCheck.code,
      reason: wlCheck.reason,
      hostCommandsDir,
      now,
    });
    return { ok: false, result: { accepted: false, status: "refused", code: wlCheck.code, reason: wlCheck.reason, rowCreated: false } };
  }
  if (!config?.model?.baseUrl) {
    return { ok: false, result: { accepted: false, status: "pending_no_base_url", rowCreated: false } };
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
    return { ok: false, result: { accepted: false, status: "refused", code: "endpoint_not_authorized", rowCreated: false } };
  }
  try {
    assertValidModelBaseUrl(config.model.baseUrl);
    parseModelWhitelistKey(envelope.modelId);
  } catch (e) {
    recordRefusal(db, {
      taskId: envelope.taskId,
      requestId: envelope.requestId,
      code: "invalid_model_config",
      reason: e.message,
      hostCommandsDir,
      now,
    });
    return { ok: false, result: { accepted: false, status: "refused", code: "invalid_model_config", reason: e.message, rowCreated: false } };
  }
  // CP2 session freshness (Unit 5.1 rework): an attempt anchored to a
  // session must still be FRESH before the call is issued — a revoke
  // bumps the authorization revision and kills the session immediately;
  // the proposal is refused with zero call bytes instead of running on
  // the frozen-but-stale context.
  if (typeof envelope.attemptId === "string") {
    const attempt = db.prepare("SELECT session_id FROM attempts WHERE id=?").get(envelope.attemptId);
    if (attempt && typeof attempt.session_id === "string" && attempt.session_id.length > 0) {
      const session = db.prepare("SELECT id FROM sessions WHERE id=?").get(attempt.session_id);
      if (!session) {
        recordRefusal(db, {
          taskId: envelope.taskId,
          requestId: envelope.requestId,
          code: "session_missing",
          reason: `attempt ${envelope.attemptId} anchors session ${attempt.session_id}, which no longer exists`,
          hostCommandsDir,
          now,
        });
        return { ok: false, result: { accepted: false, status: "refused", code: "session_missing", rowCreated: false } };
      }
      const fresh = assertSessionFresh(db, { sessionId: attempt.session_id });
      if (!fresh.fresh) {
        recordRefusal(db, {
          taskId: envelope.taskId,
          requestId: envelope.requestId,
          code: "session_stale_authorization_changed",
          reason: `session ${attempt.session_id} recorded revision ${fresh.sessionRevision}, current is ${fresh.currentRevision}; the attempt must be abandoned and rebuilt`,
          hostCommandsDir,
          now,
        });
        return {
          ok: false,
          result: {
            accepted: false,
            status: "refused",
            code: "session_stale_authorization_changed",
            reason: "authorization revision changed since the session froze",
            rowCreated: false,
          },
        };
      }
    }
  }
  const capCheck = validateModelTokenCaps(config.model, envelope.messages);
  if (!capCheck.ok) {
    recordRefusal(db, {
      taskId: envelope.taskId,
      requestId: envelope.requestId,
      code: capCheck.code,
      reason: capCheck.reason,
      hostCommandsDir,
      now,
    });
    return { ok: false, result: { accepted: false, status: "refused", code: capCheck.code, reason: capCheck.reason, rowCreated: false } };
  }
  return { ok: true };
}

function admitAndReserveModelRequestTx(db, { envelope, ledger, config, now }) {
  const upperMicrousd = config.model.callUpperMicrousd ?? 1000;
  const provider = envelope.modelId.split("/")[0] || config.model.provider || "deepseek";
  return withTx(db, () => {
    const existing = db.prepare("SELECT * FROM model_requests WHERE request_id=?").get(envelope.requestId);
    if (existing) {
      if (
        existing.task_id !== envelope.taskId ||
        existing.attempt_id !== envelope.attemptId ||
        existing.fence !== envelope.fence ||
        existing.scope_domain_key !== envelope.scopeDomainKey
      ) {
        const reason = `requestId ${envelope.requestId} already bound to a different task/attempt/fence/scope`;
        recordRefusalInTx(db, { taskId: envelope.taskId, requestId: envelope.requestId, code: "request_id_identity_conflict", reason, now });
        return {
          done: true,
          refusalFile: { code: "request_id_identity_conflict", reason, allowOverwrite: false },
          result: { accepted: false, status: "refused", code: "request_id_identity_conflict", rowCreated: false },
        };
      }
      if (existing.state === "RECEIVED") {
        db.prepare("UPDATE model_requests SET state='FAILED', error_code='stranded_received_recovered', updated_at=? WHERE request_id=? AND state='RECEIVED'")
          .run(now, envelope.requestId);
        const reason = `requestId ${envelope.requestId} recovered from incomplete RECEIVED state before reservation`;
        recordRefusalInTx(db, { taskId: envelope.taskId, requestId: envelope.requestId, code: "stranded_received_recovered", reason, now });
        return {
          done: true,
          refusalFile: { code: "stranded_received_recovered", reason: "request recovered from stranded RECEIVED state", allowOverwrite: false },
          result: { accepted: false, status: "refused", code: "stranded_received_recovered", state: "FAILED", rowCreated: false },
        };
      }
      writeAudit(db, {
        code: "model_request_duplicate",
        taskId: existing.task_id,
        details: { request_id: existing.request_id, state: existing.state, reservation_id: existing.reservation_id },
        now,
      });
      return {
        done: true,
        result: {
          accepted: true,
          duplicate: true,
          status: "duplicate",
          state: existing.state,
          reservationId: existing.reservation_id,
          replyObjectId: existing.reply_object_id,
          rowCreated: false,
        },
      };
    }

    const idCheck = checkRunningClaimIdentity(db, {
      taskId: envelope.taskId,
      attemptId: envelope.attemptId,
      fence: envelope.fence,
      scopeDomainKey: envelope.scopeDomainKey,
      now,
    });
    if (!idCheck.ok) {
      recordRefusalInTx(db, { taskId: envelope.taskId, requestId: envelope.requestId, code: idCheck.code, reason: idCheck.reason, now });
      return {
        done: true,
        refusalFile: { code: idCheck.code, reason: idCheck.reason, allowOverwrite: false },
        result: { accepted: false, status: "refused", code: idCheck.code, reason: idCheck.reason, rowCreated: false },
      };
    }

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

    try {
      db.exec("SAVEPOINT reserve_sp");
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
      db.exec("RELEASE reserve_sp");
      return { done: false, idCheck, reservationId: res.reservationId };
    } catch (e) {
      try {
        db.exec("ROLLBACK TO reserve_sp");
        db.exec("RELEASE reserve_sp");
      } catch {}
      db.prepare("UPDATE model_requests SET state='FAILED', error_code=?, updated_at=? WHERE request_id=? AND state='RECEIVED'")
        .run(e.constructor?.name ?? "budget_refused", now, envelope.requestId);
      writeAudit(db, {
        code: "model_request_refused",
        taskId: envelope.taskId,
        details: { request_id: envelope.requestId, reason_code: e.constructor?.name ?? "budget_refused", reason: e.message },
        now,
      });
      return {
        done: true,
        refusalFile: { code: "budget_refused", reason: e.message, allowOverwrite: true },
        result: { accepted: false, status: "budget_refused", state: "FAILED", reason: e.message, rowCreated: true },
      };
    }
  });
}

function commitExecutingTransition(db, { requestId, now }) {
  withTx(db, () => {
    const changed = db
      .prepare("UPDATE model_requests SET state='EXECUTING', updated_at=? WHERE request_id=? AND state='RESERVED'")
      .run(now, requestId).changes;
    if (changed !== 1) {
      throw new ModelRequestError(`cannot commit EXECUTING for ${requestId}`);
    }
  });
}

function prepareAndStartModelRequest(db, {
  stateDir,
  config,
  ledger,
  envelope,
  hostCommandsDir = null,
  completeActiveTask = false,
  preCallCancelled = false,
  now,
}) {
  const explicitNow = now !== undefined;
  const effectiveNow = explicitNow ? now : Date.now();
  const warmingEnabled = ledger?.warmingEnabled ?? config?.budget?.warmingEnabled ?? false;

  const gate = validateAndAuthorizeModelProposal(db, {
    config,
    envelope,
    hostCommandsDir,
    warmingEnabled,
    now: effectiveNow,
  });
  if (!gate.ok) {
    return { done: true, result: gate.result };
  }

  const admission = admitAndReserveModelRequestTx(db, {
    envelope,
    ledger,
    config,
    now: effectiveNow,
  });
  if (admission.refusalFile) {
    writeRefusalResultFile(db, {
      requestId: envelope.requestId,
      code: admission.refusalFile.code,
      reason: admission.refusalFile.reason,
      hostCommandsDir,
      allowOverwrite: admission.refusalFile.allowOverwrite,
    });
  }
  if (admission.done) {
    return { done: true, result: admission.result };
  }

  crashpoint("model_requests:after-reserve-before-executing");

  const preCallIdentity = checkRunningClaimIdentity(db, {
    taskId: envelope.taskId,
    attemptId: envelope.attemptId,
    fence: envelope.fence,
    scopeDomainKey: envelope.scopeDomainKey,
    now: effectiveNow,
  });
  if (preCallCancelled || !preCallIdentity.ok) {
    return {
      done: true,
      result: cancelPreCallModelRequest(db, {
        ledger,
        requestId: envelope.requestId,
        reason: preCallCancelled ? "pre_call_cancelled" : `pre_call_${preCallIdentity.code}`,
        now: effectiveNow,
      }),
    };
  }

  commitExecutingTransition(db, { requestId: envelope.requestId, now: effectiveNow });
  crashpoint("model_requests:after-executing-before-call");

  const cred = createCredentialService(db).resolve("model");
  const bearer = cred.ok === true ? cred.value : null;
  return {
    done: false,
    prep: {
      stateDir,
      config,
      ledger,
      envelope,
      hostCommandsDir,
      completeActiveTask,
      idCheck: admission.idCheck,
      bearer,
      now: effectiveNow,
      explicitNow,
    },
  };
}

function finishModelRequest(db, prep, call, { useWallClockAfterCall = false } = {}) {
  if (process.env.AEGISPI_T7_CAPTURE_PATH) {
    writeFileSync(
      process.env.AEGISPI_T7_CAPTURE_PATH,
      JSON.stringify({ requestId: prep.envelope.requestId, call }),
      "utf8",
    );
  }
  crashpoint("model_requests:after-call-before-writeback");

  const writebackNow = !prep.explicitNow || useWallClockAfterCall
    ? Math.max(prep.now, Date.now())
    : prep.now;

  return commitModelCallWriteback(db, {
    stateDir: prep.stateDir,
    ledger: prep.ledger,
    requestId: prep.envelope.requestId,
    call,
    priceCatalog: prep.config.model.priceCatalog,
    hostCommandsDir: prep.hostCommandsDir,
    completeActiveTask: prep.completeActiveTask,
    leaseOwner: prep.idCheck.task.lease_owner,
    now: writebackNow,
  });
}

export function processModelRequest(db, opts = {}) {
  const started = prepareAndStartModelRequest(db, opts);
  if (started.done) return started.result;
  const { prep } = started;
  let call;
  try {
    call = callModelOnce({
      baseUrl: prep.config.model.baseUrl,
      model: prep.envelope.modelId,
      messages: prep.envelope.messages,
      timeoutMs: prep.config.model.callTimeoutMs ?? 60000,
      bearer: prep.bearer,
      maxTokens: prep.config.model.maxOutputTokens ?? undefined,
    });
  } catch (e) {
    call = { ok: false, kind: "local", stopReason: "error", error: e.message, usage: null };
  }
  return finishModelRequest(db, prep, call, { useWallClockAfterCall: opts.useWallClockAfterCall === true });
}

export async function processModelRequestAsync(db, opts = {}) {
  const started = prepareAndStartModelRequest(db, opts);
  if (started.done) return started.result;
  const { prep } = started;
  const leaseMs = opts.leaseMs ?? 45000;
  const hbFloor = Math.max(250, Math.floor(leaseMs / 3));
  const hbEveryMs = Number.isInteger(opts.heartbeatMs) && opts.heartbeatMs > 0
    ? Math.max(250, Math.min(opts.heartbeatMs, hbFloor))
    : hbFloor;
  const refreshHeartbeat = () => {
    try {
      heartbeat(db, {
        taskId: prep.idCheck.task.id,
        attemptNo: prep.idCheck.task.attempt_no,
        leaseOwner: prep.idCheck.task.lease_owner,
        fence: prep.idCheck.task.fence,
        now: Date.now(),
        leaseMs,
      });
    } catch {}
  };
  refreshHeartbeat();
  const timer = setInterval(refreshHeartbeat, hbEveryMs);
  let call;
  try {
    call = await callModelOnceAsync({
      baseUrl: prep.config.model.baseUrl,
      model: prep.envelope.modelId,
      messages: prep.envelope.messages,
      timeoutMs: prep.config.model.callTimeoutMs ?? 60000,
      bearer: prep.bearer,
      maxTokens: prep.config.model.maxOutputTokens ?? undefined,
    });
  } catch (e) {
    call = { ok: false, kind: "local", stopReason: "error", error: e.message, usage: null };
  } finally {
    clearInterval(timer);
  }
  return finishModelRequest(db, prep, call, { useWallClockAfterCall: opts.useWallClockAfterCall ?? true });
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

function scanPendingProposals(db, { stateDir, now = Date.now(), onlyTaskId = null, excludeTaskIds = null }) {
  const workRoot = join(stateDir, "agent-work");
  if (!existsSync(workRoot)) return { results: [], tasksToVisit: [] };
  const onlyDir = onlyTaskId ? safeTaskDirComponent(onlyTaskId) : null;
  const excludeDirs = excludeTaskIds && excludeTaskIds.size > 0
    ? new Set([...excludeTaskIds].map((id) => safeTaskDirComponent(id)))
    : null;
  const results = [];
  const tasksToVisit = [];
  let taskDirs = [];
  try {
    taskDirs = readdirSync(workRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return { results: [], tasksToVisit: [] };
  }
  for (const tDir of taskDirs) {
    if (onlyDir && tDir !== onlyDir) continue;
    if (excludeDirs && excludeDirs.has(tDir)) continue;
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
      const pendingItems = [];
      let dirty = false;
      for (const f of files) {
        const fPath = join(proposalsDir, f);
        let st;
        try {
          st = lstatSync(fPath);
          if (st.isSymbolicLink()) {
            recordRefusal(db, {
              taskId: null,
              requestId: null,
              code: "proposal_symlink_rejected",
              reason: `proposal ${f} is a symbolic link`,
              hostCommandsDir: null,
              now,
            });
            results.push({ file: f, status: "refused", code: "proposal_symlink_rejected" });
            continue;
          }
          if (!st.isFile()) continue;
        } catch {
          continue;
        }
        const prev = consumed[f];
        if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
          continue;
        }
        if (st.size > MAX_PROPOSAL_FILE_BYTES) {
          recordRefusal(db, {
            taskId: null,
            requestId: null,
            code: "messages_too_large",
            reason: `proposal file ${f} size ${st.size} exceeds max envelope cap ${MAX_PROPOSAL_FILE_BYTES}`,
            hostCommandsDir: null,
            now,
          });
          consumed[f] = { mtimeMs: st.mtimeMs, size: st.size };
          dirty = true;
          results.push({ file: f, status: "refused", code: "messages_too_large" });
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
        if (onlyTaskId && envelope?.taskId !== onlyTaskId) continue;
        if (excludeTaskIds && excludeTaskIds.has(envelope?.taskId)) continue;
        if (typeof envelope?.taskId === "string" && envelope.taskId.length > 0 && tDir !== safeTaskDirComponent(envelope.taskId)) {
          recordRefusal(db, {
            taskId: envelope.taskId,
            requestId: isUuidV4(envelope.requestId) ? envelope.requestId : null,
            code: "proposal_dir_mismatch",
            reason: `proposal ${f} taskId does not match container work directory`,
            hostCommandsDir: commandsDir,
            now,
          });
          consumed[f] = { mtimeMs: st.mtimeMs, size: st.size };
          dirty = true;
          results.push({ file: f, taskId: envelope.taskId, status: "refused", code: "proposal_dir_mismatch" });
          continue;
        }
        pendingItems.push({ f, st, envelope, proposalsDir });
      }
      tasksToVisit.push({ consumedPath, consumed, dirty, commandsDir, proposalsDir, pendingItems });
    }
  }
  return { results, tasksToVisit };
}

export function fenceAttemptProposals(attemptDir, reason = "triageStopped") {
  try {
    const proposalsDir = join(attemptDir, "proposals");
    if (!existsSync(proposalsDir)) return 0;
    const consumedPath = join(attemptDir, ".daemon-consumed.json");
    let consumed = {};
    if (existsSync(consumedPath)) {
      try {
        consumed = JSON.parse(readFileSync(consumedPath, "utf8")) ?? {};
      } catch {
        consumed = {};
      }
    }
    let fenced = 0;
    for (const f of readdirSync(proposalsDir)) {
      if (!f.startsWith("model-request-") || !f.endsWith(".json") || f.includes(".tmp")) continue;
      if (!consumed[f]) {
        const st = lstatSync(join(proposalsDir, f));
        consumed[f] = { mtimeMs: st.mtimeMs, size: st.size, [reason]: true };
        fenced += 1;
      }
    }
    if (fenced > 0) {
      writeFileSync(consumedPath, JSON.stringify(consumed, null, 2) + "\n", "utf8");
    }
    return fenced;
  } catch {
    return 0;
  }
}

function recordScannedProposalOutcome(scan, entry, item, outcome) {
  scan.results.push({ file: item.f, taskId: item.envelope?.taskId ?? null, proposalsDir: entry.proposalsDir, ...outcome });
  if (outcome.status !== "pending_no_base_url") {
    entry.consumed[item.f] = { mtimeMs: item.st.mtimeMs, size: item.st.size };
    return true;
  }
  return false;
}

async function runPendingBatches(db, { stateDir, config, ledger, completeActiveTask, onlyTaskId, excludeTaskIds, now, runner }) {
  const effectiveNow = now ?? Date.now();
  const scan = scanPendingProposals(db, { stateDir, now: effectiveNow, onlyTaskId, excludeTaskIds });
  for (const entry of scan.tasksToVisit) {
    let dirty = entry.dirty;
    for (const item of entry.pendingItems) {
      const outcome = await runner(entry, item);
      if (recordScannedProposalOutcome(scan, entry, item, outcome)) {
        dirty = true;
      }
    }
    if (dirty) {
      writeFileSync(entry.consumedPath, JSON.stringify(entry.consumed, null, 2) + "\n", "utf8");
    }
  }
  return { processed: scan.results.length, results: scan.results };
}

export function processPendingModelProposals(db, {
  stateDir,
  config,
  ledger,
  completeActiveTask = true,
  onlyTaskId = null,
  excludeTaskIds = null,
  now,
  useWallClockAfterCall = false,
}) {
  const effectiveNow = now ?? Date.now();
  const scan = scanPendingProposals(db, { stateDir, now: effectiveNow, onlyTaskId, excludeTaskIds });
  for (const entry of scan.tasksToVisit) {
    let dirty = entry.dirty;
    for (const item of entry.pendingItems) {
      const outcome = processModelRequest(db, {
        stateDir,
        config,
        ledger,
        envelope: item.envelope,
        hostCommandsDir: entry.commandsDir,
        completeActiveTask,
        now,
        useWallClockAfterCall,
      });
      if (recordScannedProposalOutcome(scan, entry, item, outcome)) {
        dirty = true;
      }
    }
    if (dirty) {
      writeFileSync(entry.consumedPath, JSON.stringify(entry.consumed, null, 2) + "\n", "utf8");
    }
  }
  return { processed: scan.results.length, results: scan.results };
}

export async function processPendingModelProposalsAsync(db, {
  stateDir,
  config,
  ledger,
  leaseMs = 45000,
  heartbeatMs = 10000,
  completeActiveTask = true,
  onlyTaskId = null,
  excludeTaskIds = null,
  now,
  useWallClockAfterCall = true,
}) {
  return runPendingBatches(db, {
    stateDir,
    config,
    ledger,
    completeActiveTask,
    onlyTaskId,
    excludeTaskIds,
    now,
    runner: (entry, item) =>
      processModelRequestAsync(db, {
        stateDir,
        config,
        ledger,
        leaseMs,
        heartbeatMs,
        envelope: item.envelope,
        hostCommandsDir: entry.commandsDir,
        completeActiveTask,
        now,
        useWallClockAfterCall,
      }),
  });
}
