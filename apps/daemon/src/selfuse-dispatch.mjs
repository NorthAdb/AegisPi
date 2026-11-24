import { hasReadGrant } from "./acl.mjs";
import { withTx } from "./db/tx.mjs";
import { writeAudit } from "./audit.mjs";
import { draftToReadyInTx, proposeEffectInTx } from "./effects.mjs";
import {
  buildMailSendIntent,
  insertMailDraftEvidence,
  mailThreadKey,
  proposeMailReplyEffect,
} from "./mail-triage.mjs";
import { fenceAttemptProposals, processPendingModelProposalsAsync } from "./model-requests.mjs";
import { insertObjectRow, putObjectContent, readObjectContent } from "./objects.mjs";
import { enqueueNotificationInTx } from "./outbox.mjs";
import {
  completePendingDeliveryCheckpointInTx,
  completeTaskInTx,
  deliveryReturnedInTx,
  heartbeat,
} from "./scheduler.mjs";

const OBSERVE_CMD_RE = /^\/observe(?:@[A-Za-z0-9_]+)?\s+(\S+)(?:\s+([\s\S]+))?$/i;
const TRIAGE_CMD_RE = /^\/triage(?:@[A-Za-z0-9_]+)?\s+(\S+)(?:\s+([\s\S]+))?$/i;
const TELEGRAM_MAX_REPLY_CHARS = 3900;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isLeaseRevokedError(err) {
  return Boolean(err && (err.name === "StaleWorker" || /lease|fence|stale/i.test(String(err.message ?? ""))));
}

function tryParsePlainObject(rawPayload) {
  if (typeof rawPayload !== "string") return null;
  try {
    const parsed = JSON.parse(rawPayload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function translateTelegramCommandToPayload(rawPayload, { scopeDomainKey = null } = {}) {
  const obj = tryParsePlainObject(rawPayload);
  if (!obj || typeof obj.text !== "string") return rawPayload;
  if (obj.kind !== undefined && obj.kind !== "web_chat") return rawPayload;

  const trimmed = obj.text.trim();
  const obsMatch = OBSERVE_CMD_RE.exec(trimmed);
  if (obsMatch) {
    const targetId = obsMatch[1];
    const question = obsMatch[2] ? obsMatch[2].trim().slice(0, 4096) : "";
    return JSON.stringify({
      kind: "repo_observe",
      targetId,
      ...(question ? { question } : {}),
    });
  }

  const triageMatch = TRIAGE_CMD_RE.exec(trimmed);
  if (triageMatch) {
    const presetId = triageMatch[1];
    const question = triageMatch[2] ? triageMatch[2].trim().slice(0, 512) : "";
    const notifyChannel =
      typeof scopeDomainKey === "string" &&
      (scopeDomainKey.startsWith("dm:telegram:") || scopeDomainKey.startsWith("group:telegram:"))
        ? scopeDomainKey
        : null;
    return JSON.stringify({
      kind: "repo_triage",
      presetId,
      ...(notifyChannel ? { notifyChannel } : {}),
      ...(question ? { question } : {}),
    });
  }

  return rawPayload;
}

export function formatGeneralUserPrompt(rawPayload) {
  const obj = tryParsePlainObject(rawPayload);
  if (
    obj &&
    (obj.kind === "web_chat" || obj.update_id !== undefined) &&
    typeof obj.text === "string" &&
    obj.text.length > 0
  ) {
    return obj.text;
  }
  return rawPayload;
}

function trimCleanly(text, maxChars) {
  if (text.length <= maxChars) return text;
  const suffix = "\n...[truncated]";
  if (maxChars <= suffix.length) return text.slice(0, maxChars);
  let slice = text.slice(0, maxChars - suffix.length);
  const lastCode = slice.charCodeAt(slice.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    slice = slice.slice(0, -1);
  }
  return slice + suffix;
}

function isObjectStrictlyInScope(db, objectId, scopeId) {
  if (!objectId) return false;
  const obj = db.prepare("SELECT id, scope_id, status FROM objects WHERE id=?").get(objectId);
  if (!obj || obj.status === "deleted" || obj.scope_id !== scopeId) return false;
  const foreign = db
    .prepare("SELECT 1 FROM object_required_scopes WHERE object_id=? AND scope_id != ? LIMIT 1")
    .get(objectId, scopeId);
  return foreign === undefined;
}

export function buildScopedThreadMessages(
  db,
  stateDir,
  {
    scopeId,
    principalId,
    threadKey,
    currentTaskId = null,
    currentUserPrompt = "",
    maxTurns = 6,
    maxTotalBytes = 64 * 1024,
    now = Date.now(),
  },
) {
  const currentMsg = { role: "user", content: String(currentUserPrompt ?? "") };
  if (!scopeId || !principalId || !threadKey || !hasReadGrant(db, { scopeId, principalId, now })) {
    return [currentMsg];
  }
  const turnLimit = Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : 0;
  if (turnLimit === 0) {
    return [currentMsg];
  }
  const effectiveMaxBytes = Math.min(
    Number.isFinite(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : 64 * 1024,
    127 * 1024,
  );
  if (Buffer.byteLength(JSON.stringify([currentMsg]), "utf8") >= effectiveMaxBytes) {
    return [currentMsg];
  }

  const rows = db
    .prepare(
      `SELECT t.id AS task_id, t.result_object_id, t.updated_at AS task_updated_at,
              i.id AS inbox_id, i.source AS inbox_source, i.payload_object_id, i.received_at
       FROM tasks t
       JOIN event_deliveries d ON d.task_id = t.id
       JOIN inbox i ON i.id = d.event_id
       WHERE t.scope_id = ?
         AND (? IS NULL OR t.id != ?)
         AND t.state = 'SUCCEEDED'
         AND t.result_object_id IS NOT NULL
         AND i.scope_id = ?
         AND i.thread_key = ?
         AND i.source IN ('console-chat', 'telegram')
       ORDER BY t.updated_at DESC, i.received_at DESC, i.rowid DESC
       LIMIT ?`,
    )
    .all(scopeId, currentTaskId, currentTaskId, scopeId, threadKey, turnLimit * 2);

  const perMsgMaxChars = Math.min(8192, Math.max(512, Math.floor(effectiveMaxBytes / 4)));
  const validTurnsNewestFirst = [];
  const seenTaskIds = new Set();

  for (const row of rows) {
    if (seenTaskIds.has(row.task_id)) continue;
    if (!isObjectStrictlyInScope(db, row.payload_object_id, scopeId)) continue;
    if (!isObjectStrictlyInScope(db, row.result_object_id, scopeId)) continue;

    const rawPayload = readObjectContent(db, stateDir, row.payload_object_id);
    if (typeof rawPayload !== "string" || rawPayload.length === 0) continue;
    const payloadObj = tryParsePlainObject(rawPayload);
    if (payloadObj && (payloadObj.kind === "repo_observe" || payloadObj.kind === "repo_triage" || payloadObj.kind === "mail")) {
      continue;
    }

    const userText = String(formatGeneralUserPrompt(rawPayload) ?? "").trim();
    if (!userText) continue;

    const rawReply = readObjectContent(db, stateDir, row.result_object_id);
    if (typeof rawReply !== "string" || rawReply.length === 0) continue;
    const replyObj = tryParsePlainObject(rawReply);
    const assistantRaw = replyObj && typeof replyObj.reply === "string" ? replyObj.reply : rawReply;
    const assistantText = String(assistantRaw).trim();
    if (!assistantText) continue;

    seenTaskIds.add(row.task_id);
    validTurnsNewestFirst.push({
      userContent: trimCleanly(userText, perMsgMaxChars),
      assistantContent: trimCleanly(assistantText, perMsgMaxChars),
    });
    if (validTurnsNewestFirst.length >= turnLimit) break;
  }

  let packedChrono = [];
  for (const turn of validTurnsNewestFirst) {
    const candidateTurns = [turn, ...packedChrono];
    const candidateMsgs = [];
    for (const t of candidateTurns) {
      candidateMsgs.push({ role: "user", content: t.userContent });
      candidateMsgs.push({ role: "assistant", content: t.assistantContent });
    }
    candidateMsgs.push(currentMsg);
    if (Buffer.byteLength(JSON.stringify(candidateMsgs), "utf8") <= effectiveMaxBytes) {
      packedChrono = candidateTurns;
    } else {
      break;
    }
  }

  const messages = [];
  for (const t of packedChrono) {
    messages.push({ role: "user", content: t.userContent });
    messages.push({ role: "assistant", content: t.assistantContent });
  }
  messages.push(currentMsg);
  return messages;
}

export function parseInboundMailPayload(rawPayload) {
  const obj = tryParsePlainObject(rawPayload);
  if (obj && obj.kind === "mail" && typeof obj.envelopeFrom === "string" && obj.envelopeFrom.trim().length > 0) {
    return { isMail: true, mail: obj };
  }
  return { isMail: false };
}

export function maybeEnqueueTelegramTaskReply(db, stateDir, { config, taskId, now }) {
  if (config?.telegram?.autoReplyOnTask !== true || !config?.telegram?.apiBase) {
    return { enqueued: false, reason: "disabled" };
  }
  const task = db
    .prepare("SELECT id, scope_id, state, result_object_id FROM tasks WHERE id=?")
    .get(taskId);
  if (!task || task.state !== "SUCCEEDED" || !task.result_object_id) {
    return { enqueued: false, reason: "task_not_eligible" };
  }
  const scope = db.prepare("SELECT id, domain_key FROM scopes WHERE id=?").get(task.scope_id);
  const allowedRecipients = Array.isArray(config.adapters?.allowedRecipients) ? config.adapters.allowedRecipients : [];
  if (
    !scope ||
    !(scope.domain_key.startsWith("dm:telegram:") || scope.domain_key.startsWith("group:telegram:")) ||
    !allowedRecipients.includes(scope.domain_key)
  ) {
    return { enqueued: false, reason: "scope_not_eligible" };
  }
  const existing = db
    .prepare("SELECT id FROM effects WHERE task_id=? AND operation IN ('send_message', 'im.notify') LIMIT 1")
    .get(taskId);
  if (existing) {
    return { enqueued: false, reason: "already_enqueued" };
  }

  const rawContent = readObjectContent(db, stateDir, task.result_object_id);
  if (!rawContent) {
    return { enqueued: false, reason: "empty_reply" };
  }
  let replyText = rawContent;
  const parsed = tryParsePlainObject(rawContent);
  if (parsed && typeof parsed.reply === "string") {
    replyText = parsed.reply;
  }
  replyText = replyText.trim().slice(0, TELEGRAM_MAX_REPLY_CHARS).trim();
  if (!replyText) {
    return { enqueued: false, reason: "empty_reply" };
  }

  const attempt = db
    .prepare("SELECT id FROM attempts WHERE task_id=? ORDER BY attempt_no DESC LIMIT 1")
    .get(taskId);
  if (!attempt) {
    return { enqueued: false, reason: "missing_attempt" };
  }

  const stored = putObjectContent(stateDir, replyText);
  return withTx(db, () => {
    const again = db
      .prepare("SELECT id FROM effects WHERE task_id=? AND operation IN ('send_message', 'im.notify') LIMIT 1")
      .get(taskId);
    if (again) {
      return { enqueued: false, reason: "already_enqueued" };
    }
    const proposed = proposeEffectInTx(db, stateDir, {
      now,
      taskId,
      attemptId: attempt.id,
      effectType: "notify",
      domainKey: scope.domain_key,
      naturalKey: `tg-reply:${taskId}`,
      operationIntent: {
        targetResource: scope.domain_key,
        operation: "send_message",
        contentHash: stored.contentHash,
        evidenceManifestHash: stored.contentHash,
        payloadContent: replyText,
      },
      retryMode: "AT_MOST_ONCE",
      provider: "im",
      resource: scope.domain_key,
      requiresApproval: false,
      expiresAt: now + 3600_000,
    });
    draftToReadyInTx(db, {
      effectId: proposed.effectId,
      routineRef: "telegram-reply",
      approvedRoutines: ["telegram-reply"],
      now,
    });
    const box = enqueueNotificationInTx(db, {
      effectId: proposed.effectId,
      channel: "telegram",
      destination: scope.domain_key,
      notBefore: now,
      notifyReason: "telegram-reply",
      now,
    });
    return { enqueued: true, effectId: proposed.effectId, outboxId: box.outboxId };
  });
}

function buildMailTriagePrompt(mailPayload) {
  return [
    "You are triaging a sanitized inbound email for the owner.",
    "Decide whether a reply should be drafted for owner approval.",
    'Respond ONLY with a single JSON object: {"skipReply": boolean, "reason": string, "replySubject": string, "replyBody": string}.',
    "Set skipReply=true for automated alerts, newsletters, or messages needing no reply.",
    "",
    `From: ${mailPayload.fromDisplayName ? `${mailPayload.fromDisplayName} <${mailPayload.envelopeFrom}>` : mailPayload.envelopeFrom}`,
    `Subject: ${mailPayload.subject ?? "(no subject)"}`,
    `Message-ID: ${mailPayload.messageId || "(none)"}`,
    `In-Reply-To: ${mailPayload.inReplyTo || "(none)"}`,
    `System-Notification: ${Boolean(mailPayload.systemNotification)}`,
    `Source-Actor: ${mailPayload.sourceActor ?? "unknown"}`,
    `Summary: ${mailPayload.summary ?? ""}`,
  ].join("\n");
}

function parseMailTriageReply(rawReply, originalSubject) {
  const cleanSubject = String(originalSubject ?? "").trim();
  const defaultReSubject = /^re:/i.test(cleanSubject)
    ? cleanSubject
    : `Re: ${cleanSubject || "(no subject)"}`;

  let candidate = rawReply.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fence) {
    candidate = fence[1].trim();
  }
  const parsed = tryParsePlainObject(candidate);
  if (parsed && ("skipReply" in parsed || "replyBody" in parsed)) {
    return {
      skipReply: parsed.skipReply === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      replySubject:
        typeof parsed.replySubject === "string" && parsed.replySubject.trim().length > 0
          ? parsed.replySubject.trim()
          : defaultReSubject,
      replyBody: typeof parsed.replyBody === "string" ? parsed.replyBody : "",
    };
  }
  return {
    skipReply: false,
    reason: "plain_text_fallback",
    replySubject: defaultReSubject,
    replyBody: rawReply,
  };
}

async function runMailTriageModelCall(db, {
  stateDir,
  config,
  ledger,
  agentLauncher,
  claim,
  taskDeadlineAt,
  scopeDomainKey,
  promptText,
}) {
  const modelKey =
    config.model.provider && config.model.modelId
      ? `${config.model.provider}/${config.model.modelId}`
      : "deepseek/deepseek-flash";
  if (taskDeadlineAt && Date.now() >= taskDeadlineAt) {
    return { ok: false, errorCode: "mail_triage_deadline_exceeded", replyObjectId: null };
  }
  const tryHeartbeat = () => {
    try {
      heartbeat(db, {
        taskId: claim.taskId,
        attemptNo: claim.attemptNo,
        leaseOwner: claim.leaseOwner,
        fence: claim.fence,
        now: Date.now(),
        leaseMs: config.leases.leaseMs,
      });
      return true;
    } catch (e) {
      if (isLeaseRevokedError(e)) return false;
      throw e;
    }
  };
  if (!tryHeartbeat()) {
    return { ok: false, leaseLost: true, errorCode: "mail_triage_lease_lost", replyObjectId: null };
  }

  const launched = agentLauncher.launchAttempt({
    taskId: claim.taskId,
    attemptId: claim.attemptId,
    attemptNo: claim.attemptNo,
    fence: claim.fence,
    scopeDomainKey,
    modelRequest: {
      purpose: "worker",
      modelId: modelKey,
      messages: [{ role: "user", content: promptText }],
    },
    now: Date.now(),
  });
  const wallLimit = Date.now() + (config.model.callTimeoutMs ?? 60000) + 15000;
  const deadline = taskDeadlineAt ? Math.min(wallLimit, taskDeadlineAt) : wallLimit;

  try {
    while (Date.now() < deadline) {
      if (!tryHeartbeat()) {
        return { ok: false, leaseLost: true, errorCode: "mail_triage_lease_lost", replyObjectId: null };
      }
      await processPendingModelProposalsAsync(db, {
        stateDir,
        config,
        ledger,
        leaseMs: config.leases.leaseMs,
        heartbeatMs: config.leases.heartbeatMs,
        completeActiveTask: false,
        onlyTaskId: claim.taskId,
        now: Date.now(),
        useWallClockAfterCall: true,
      });
      const mr = db
        .prepare("SELECT request_id, state, error_code, reply_object_id FROM model_requests WHERE attempt_id=? ORDER BY created_at DESC LIMIT 1")
        .get(claim.attemptId);
      if (mr) {
        if (mr.state === "SETTLED") {
          let reply = "";
          let stopReason = null;
          if (mr.reply_object_id) {
            const raw = readObjectContent(db, stateDir, mr.reply_object_id);
            const parsed = tryParsePlainObject(raw);
            if (parsed) {
              reply = typeof parsed.reply === "string" ? parsed.reply : "";
              stopReason = parsed.stopReason ?? null;
            }
          }
          if (reply.trim().length === 0) {
            return {
              ok: false,
              errorCode: stopReason === "length" ? "model_output_truncated_empty" : "model_empty_reply",
              replyObjectId: mr.reply_object_id,
            };
          }
          return { ok: true, reply: reply.trim(), replyObjectId: mr.reply_object_id };
        }
        if (mr.state === "HELD") {
          return { ok: false, errorCode: "settlement_held_uncompleted", replyObjectId: mr.reply_object_id };
        }
        if (mr.state === "FAILED" || mr.state === "ORPHAN" || (mr.state === "EXECUTING" && mr.error_code)) {
          return { ok: false, errorCode: mr.error_code ?? "mail_triage_model_failed", replyObjectId: mr.reply_object_id };
        }
      }
      const insp = agentLauncher.inspectContainer(launched.containerId);
      if (!insp.running && !mr) {
        return { ok: false, errorCode: "mail_triage_agent_exited_early", replyObjectId: null };
      }
      await sleep(150);
    }
    return { ok: false, errorCode: "mail_triage_model_timeout", replyObjectId: null };
  } finally {
    agentLauncher.stopAttempt({ containerId: launched.containerId, commandsDir: launched.commandsDir });
    fenceAttemptProposals(launched.attemptDir, "mailTriageStopped");
  }
}

function returnOpenDeliveriesInTx(db, { taskId, now, reason }) {
  const open = db
    .prepare("SELECT event_id FROM event_deliveries WHERE task_id=? AND state IN ('PENDING','ACKED')")
    .all(taskId);
  for (const d of open) {
    try {
      deliveryReturnedInTx(db, { eventId: d.event_id, taskId, now, reason });
    } catch {}
  }
}

export async function executeMailTriageTask(db, {
  stateDir,
  config,
  ledger,
  agentLauncher,
  claim,
  taskRow,
  scopeRow,
  mailPayload,
  now,
}) {
  const failInfra = (errorCode, replyObjectId = null) => {
    const finishNow = Math.max(now, Date.now());
    try {
      withTx(db, () => {
        completeTaskInTx(db, {
          ...claim,
          now: finishNow,
          resultClass: "infra_error",
          resultObjectId: replyObjectId,
          errorCode,
        });
        returnOpenDeliveriesInTx(db, { taskId: claim.taskId, now: finishNow, reason: errorCode });
      });
    } catch (e) {
      if (!isLeaseRevokedError(e)) throw e;
    }
    return { ok: false, errorCode };
  };

  if (!agentLauncher) {
    return failInfra("mail_triage_missing_agent_launcher");
  }

  const modelOutcome = await runMailTriageModelCall(db, {
    stateDir,
    config,
    ledger,
    agentLauncher,
    claim,
    taskDeadlineAt: taskRow.deadline_at,
    scopeDomainKey: scopeRow.domain_key,
    promptText: buildMailTriagePrompt(mailPayload),
  });
  if (modelOutcome.leaseLost) {
    return { ok: false, leaseLost: true, errorCode: modelOutcome.errorCode };
  }
  if (!modelOutcome.ok) {
    return failInfra(modelOutcome.errorCode, modelOutcome.replyObjectId ?? null);
  }

  const parsed = parseMailTriageReply(modelOutcome.reply, mailPayload.subject);
  const recipient = mailPayload.envelopeFrom.trim().toLowerCase();
  const normList = (arr) =>
    Array.isArray(arr) ? arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : [];
  const mailAllowed = normList(config.mail?.allowedRecipients).includes(recipient);
  const adapterAllowed = normList(config.adapters?.allowedRecipients).includes(recipient);
  const eligible =
    !parsed.skipReply &&
    parsed.replyBody.trim().length > 0 &&
    !mailPayload.systemNotification &&
    mailPayload.sourceActor !== "bot" &&
    mailAllowed &&
    adapterAllowed;

  const finishNow = Math.max(now, Date.now());
  if (!eligible) {
    const reason =
      parsed.reason ||
      (!mailAllowed || !adapterAllowed
        ? "recipient_not_allowed"
        : parsed.skipReply
          ? "model_skipped"
          : "empty_or_automated");
    withTx(db, () => {
      completeTaskInTx(db, {
        ...claim,
        now: finishNow,
        resultClass: "not_applicable",
        resultObjectId: modelOutcome.replyObjectId,
      });
      completePendingDeliveryCheckpointInTx(db, {
        taskId: claim.taskId,
        scopeId: taskRow.scope_id,
        content: "mail triage completed (no reply proposed)",
        insertObjectRowFn: insertObjectRow,
        now: finishNow,
      });
      writeAudit(db, {
        code: "mail_triage_no_reply_proposed",
        taskId: claim.taskId,
        details: {
          reason,
          recipient,
          system_notification: Boolean(mailPayload.systemNotification),
          source_actor: mailPayload.sourceActor ?? null,
        },
        now: finishNow,
      });
    });
    return { ok: true, drafted: false };
  }

  const deliveries = db
    .prepare(
      `SELECT i.thread_key, i.payload_object_id
       FROM event_deliveries d JOIN inbox i ON i.id=d.event_id
       WHERE d.task_id=? AND d.state IN ('PENDING','ACKED')
       ORDER BY d.rowid ASC`,
    )
    .all(claim.taskId);
  const threadObjectIds = deliveries.map((d) => d.payload_object_id).filter(Boolean);
  const threadKey =
    deliveries[0]?.thread_key ??
    mailThreadKey({
      messageId: mailPayload.messageId,
      inReplyTo: mailPayload.inReplyTo,
      references: mailPayload.references,
      from: { address: recipient },
      subject: mailPayload.subject,
      date: "",
      textPreview: mailPayload.summary,
    });

  const { draftId, evidenceManifestHash } = withTx(db, () => {
    const draftObj = insertMailDraftEvidence(db, stateDir, {
      now: finishNow,
      taskId: claim.taskId,
      scopeId: taskRow.scope_id,
      threadObjectIds,
      draftText: parsed.replyBody,
    });
    const row = db.prepare("SELECT content_hash FROM objects WHERE id=?").get(draftObj.id);
    if (!row?.content_hash) {
      throw new Error(`missing content_hash for mail_draft object ${draftObj.id}`);
    }
    return { draftId: draftObj.id, evidenceManifestHash: row.content_hash };
  });

  const proposed = proposeMailReplyEffect(db, stateDir, {
    now: finishNow,
    taskId: claim.taskId,
    attemptId: claim.attemptId,
    account: scopeRow.domain_key.replace(/^dm:mail:/, ""),
    approverPrincipalId: "prn:local:owner",
    intent: buildMailSendIntent({
      to: [recipient],
      subject: parsed.replySubject,
      bodyText: parsed.replyBody,
      sendingIdentity: config.adapters.fixedSendingIdentity,
      threadKey,
      inReplyTo: mailPayload.messageId || null,
      references: mailPayload.references || mailPayload.messageId || null,
      messageId: mailPayload.messageId || null,
    }),
    mailConfig: config.mail,
    adaptersConfig: config.adapters,
    evidenceManifestHash,
    parentObjectIds: [draftId],
  });

  withTx(db, () => {
    completePendingDeliveryCheckpointInTx(db, {
      taskId: claim.taskId,
      scopeId: taskRow.scope_id,
      content: "mail triage drafted reply for approval",
      insertObjectRowFn: insertObjectRow,
      now: finishNow,
    });
  });

  return { ok: true, drafted: true, effectId: proposed.effectId, approvalId: proposed.approvalId };
}
