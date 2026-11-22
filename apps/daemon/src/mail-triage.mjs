// Mail triage and the draft-first send loop (Unit 5.3; spec 03 section 3,
// 02 section 4, 06 sections 4-6).
//
// Identity rule (03 section 3: "不假设From显示名是真实指令"): the principal
// of an inbound mail comes from the ENVELOPE address only — a display name
// claiming to be the owner grants nothing, ever. Scope: dm:mail:<account>
// (owner_dm shape of 06 section 1.1); only pointers, the thread key built
// from Message-ID / In-Reply-To / References, the envelope sender, a redacted
// summary and attachment SHA-256s are persisted — never the whole mailbox,
// never a group task inheriting mail thread access (CP2 keeps every read
// behind the object_required_scopes closure).
//
// The send path is draft-first: the triage proposes mail.send as an
// AT_MOST_ONCE effect with a 4h approval TTL; proposeEffectInTx parks the
// attempt (PARKED, lease cleared, fence NOT bumped) and the task into
// WAITING_APPROVAL in one transaction — the daemon's container reclaim pass
// frees the worker the moment it sees the parked attempt, and the parked
// state survives daemon restarts because it lives in SQLite, not memory.
// Reject / expiry / cancel end the task normally; NOTHING auto-retries or
// borrows another channel; a DATA-stage unknown stays UNKNOWN until a human
// reconciles it with external evidence (effects.mjs reconcileUnknown).

import { createHash } from "node:crypto";
import { withTx } from "./db/tx.mjs";
import { writeAudit } from "./audit.mjs";
import { receiveEvent, scopeId, ensureScope, ensurePrincipal, principalId } from "./ingress.mjs";
import { insertObjectRow } from "./objects.mjs";
import { redactSecrets } from "./spill.mjs";
import { isSystemNotifierAddress } from "./timers.mjs";
import { handleThreadReply } from "./briefing-followup.mjs";
import { proposeEffect } from "./effects.mjs";

export class MailTriageError extends Error {}

export function mailDomainKey(account) {
  const a = String(account ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(a)) {
    throw new MailTriageError(`mail account ${JSON.stringify(account)} is not a bare address`);
  }
  return `dm:mail:${a}`;
}

export function mailScopeId(account) {
  return scopeId(mailDomainKey(account));
}

// Thread key (06 section 1.1 natural-key discipline): the ROOT of the
// References chain if present, else In-Reply-To, else the message's own
// Message-ID. Normalized lowercase; an escaping error in one component can
// never merge two threads because the whole key is compared verbatim.
// P3-7 (D-98): a message with NO thread headers at all no longer throws —
// it gets a deterministic fallback key hashed from the message's own stable
// content, so the same mail re-fetched maps to the same thread and inbox row
// (dedup works), while two distinct no-ID mails never merge.
export function mailThreadKey({ messageId, inReplyTo, references, from, subject, date, textPreview }) {
  const refs = String(references ?? "").trim().split(/\s+/).filter((s) => s.length > 0);
  const root = refs[0] ?? String(inReplyTo ?? "").trim() ?? "";
  let base = root.length > 0 ? root : String(messageId ?? "").trim();
  if (base.length === 0) {
    const digest = createHash("sha256")
      .update(JSON.stringify([
        String(from?.address ?? ""),
        String(subject ?? ""),
        String(date ?? ""),
        String(textPreview ?? ""),
      ]))
      .digest("hex")
      .slice(0, 24);
    base = `no-id-${digest}`;
  }
  return `mail:${base.toLowerCase()}`;
}

export function ensureMailScope(db, { account, ownerId, policyVersion }) {
  return ensureScope(db, {
    ownerId,
    kind: "owner_dm",
    domainKey: mailDomainKey(account),
    channel: "mail",
    conversationId: String(account ?? "").toLowerCase(),
    policyVersion,
  });
}

function redactedSummary(text, maxChars = 512) {
  const clean = redactSecrets(String(text ?? ""));
  const compact = clean.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}…[truncated]` : compact;
}

export function attachmentHashOf(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return null;
  const canonical = JSON.stringify(
    list.map((a) => ({ filename: String(a.filename ?? ""), sha256: String(a.sha256 ?? "") })).sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1)),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

// Inbound mail ingest. The message shape is the mail child's imap.fetch
// output (upstream-mail-child.mjs). Verdict is ADMIT only when the envelope
// sender is on mail.allowedSenders (fail closed: an empty list admits
// nothing); every other mail is a masked safety audit with zero persistence.
export function ingestInboundMail(db, stateDir, {
  now,
  account,
  message,
  ownerId = null,
  mailConfig,
  policyVersion = "pv1",
}) {
  // The scope owner principal must exist before ensureScope (FK); the
  // mailbox owner is a mail-channel principal keyed by the account itself.
  const ownerPrincipal = ownerId ?? principalId("mail", String(account).toLowerCase());
  withTx(db, () => {
    ensurePrincipal(db, { platform: "mail", subject: String(account).toLowerCase() });
  });
  const scopeRef = ensureMailScope(db, { account, ownerId: ownerPrincipal, policyVersion });
  const envelopeFrom = String(message?.from?.address ?? "").trim().toLowerCase();
  const displayName = String(message?.from?.name ?? "").trim();
  if (!envelopeFrom) {
    withTx(db, () => {
      writeAudit(db, { code: "mail_triage_refused", details: { account, reason: "no envelope sender" }, now });
    });
    return { admitted: false, reason: "no envelope sender" };
  }
  const allowedSenders = Array.isArray(mailConfig?.allowedSenders) ? mailConfig.allowedSenders.map((s) => String(s).toLowerCase()) : [];
  if (!allowedSenders.includes(envelopeFrom)) {
    withTx(db, () => {
      writeAudit(db, {
        code: "mail_triage_refused",
        details: { account, sender_sha: createHash("sha256").update(envelopeFrom).digest("hex").slice(0, 16), reason: "envelope sender not on mail.allowedSenders" },
        now,
      });
    });
    return { admitted: false, reason: "sender not allowed" };
  }
  const systemNotification = message?.systemNotification === true || isSystemNotifierAddress(envelopeFrom);
  const botReceipt = String(message?.sourceActor ?? "") === "bot";
  const threadKey = mailThreadKey(message);
  const attachments = (Array.isArray(message?.attachments) ? message.attachments : []).map((a) => ({
    filename: String(a.filename ?? "").slice(0, 200),
    sha256: a.sha256 ?? null,
    bytes: Number(a.bytes ?? 0),
  }));
  const payload = {
    kind: "mail",
    envelopeFrom,
    fromDisplayName: displayName,
    sourceActor: botReceipt ? "bot" : `contact:${envelopeFrom}`,
    systemNotification,
    subject: redactedSummary(message?.subject, 200),
    summary: redactedSummary(message?.textPreview, 512),
    messageId: String(message?.messageId ?? ""),
    inReplyTo: String(message?.inReplyTo ?? ""),
    references: String(message?.references ?? ""),
    attachments,
  };
  const received = receiveEvent(db, stateDir, {
    now,
    source: "mail",
    // P3-7: a no-Message-ID mail dedups on the deterministic fallback thread
    // key instead of minting a fresh inbox row on every pull pass.
    sourceEventId: payload.messageId || threadKey,
    principal: { platform: "mail", subject: envelopeFrom },
    scope: { kind: "owner_dm", domainKey: mailDomainKey(account), channel: "mail", conversationId: String(account).toLowerCase() },
    threadKey,
    priority: 5,
    policyVersion,
    payload,
    verdict: "ADMIT",
  });
  if (!received.duplicate && !systemNotification && !botReceipt) {
    // A real contact reply may satisfy follow-up timers on this thread —
    // first committer wins by transaction order (06 section 7).
    handleThreadReply(db, stateDir, { scopeId: scopeRef.id, threadKey, now });
  }
  return { admitted: true, duplicate: received.duplicate, inboxId: received.inboxId, objectId: received.objectId, scopeId: scopeRef.id, threadKey, payload };
}

// Validation shared by proposal and revision: recipients (To/Cc/Bcc) must
// stay on the transport whitelist, the sending identity is FIXED, and the
// attachment hash is computed over the declared list. Deterministic refusals
// happen here, before any row exists.
export function validateMailSendIntent(db, { intent, mailConfig, adaptersConfig }) {
  const errs = [];
  const to = (intent.to ?? []).map((s) => String(s).trim().toLowerCase()).filter((s) => s.length > 0);
  const cc = (intent.cc ?? []).map((s) => String(s).trim().toLowerCase()).filter((s) => s.length > 0);
  const bcc = (intent.bcc ?? []).map((s) => String(s).trim().toLowerCase()).filter((s) => s.length > 0);
  const recipients = [...new Set([...to, ...cc, ...bcc])];
  if (recipients.length === 0) errs.push("no recipients in To/Cc/Bcc");
  if (recipients.length > 50) errs.push("more than 50 recipients");
  const whitelist = Array.isArray(mailConfig?.allowedRecipients) ? mailConfig.allowedRecipients.map((s) => String(s).toLowerCase()) : [];
  for (const r of recipients) {
    if (!whitelist.includes(r)) errs.push(`recipient ${r} is not on mail.allowedRecipients`);
  }
  const identity = String(intent.sendingIdentity ?? "");
  const fixedIdentity = String(adaptersConfig?.fixedSendingIdentity ?? "");
  if (identity !== fixedIdentity) errs.push(`sending identity ${identity} is not the configured fixed identity ${fixedIdentity}`);
  const bodyText = typeof intent.bodyText === "string" ? intent.bodyText : "";
  if (bodyText.trim().length === 0) errs.push("empty body");
  if (Buffer.byteLength(bodyText, "utf8") > 1024 * 1024) errs.push("body exceeds 1MiB");
  const attachments = Array.isArray(intent.attachments) ? intent.attachments : [];
  for (const a of attachments) {
    if (Number(a.bytes ?? 0) > (mailConfig?.maxAttachmentBytes ?? 4194304)) errs.push(`attachment ${a.filename} exceeds mail.maxAttachmentBytes`);
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) errs.push(`attachment ${a.filename} has no SHA-256`);
  }
  return { ok: errs.length === 0, errors: errs, to, cc, bcc, recipients, contentHash: createHash("sha256").update(bodyText, "utf8").digest("hex"), attachmentHash: attachmentHashOf(attachments) };
}

export function buildMailSendIntent({ to, cc = [], bcc = [], subject, bodyText, sendingIdentity, attachments = [], threadKey, inReplyTo = null, references = null, messageId = null }) {
  return {
    to: to.map((s) => String(s).trim().toLowerCase()),
    cc: cc.map((s) => String(s).trim().toLowerCase()),
    bcc: bcc.map((s) => String(s).trim().toLowerCase()),
    subject: String(subject ?? "").slice(0, 998),
    bodyText: String(bodyText ?? ""),
    sendingIdentity: String(sendingIdentity ?? ""),
    attachments,
    threadKey,
    inReplyTo,
    references,
    messageId,
  };
}

// Draft-first proposal (03 section 3): creates the mail.send effect in
// WAITING_APPROVAL with an approval card expiring at now + approvalTtlMs.
// When the proposing task is RUNNING, proposeEffectInTx parks the attempt
// and clears the lease in the same transaction (fence unchanged) — the
// 4-hour persistent park that survives restarts. Attachments ride in extra
// (the host validates their hashes; the body itself is extra.bodyText so the
// dispatcher's adapter can send exactly what the human approved).
export function proposeMailReplyEffect(db, stateDir, {
  now,
  taskId,
  attemptId,
  account,
  intent,
  mailConfig,
  adaptersConfig,
  evidenceManifestHash,
  parentObjectIds = [],
  naturalKey = null,
  approverPrincipalId = null,
}) {
  const check = validateMailSendIntent(db, { intent, mailConfig, adaptersConfig });
  if (!check.ok) {
    withTx(db, () => {
      writeAudit(db, {
        code: "mail_send_intent_refused",
        taskId,
        details: { errors: check.errors, thread_key: intent.threadKey ?? null },
        now,
      });
    });
    throw new MailTriageError(`mail.send intent refused: ${check.errors.join("; ")}`);
  }
  const domainKey = mailDomainKey(account);
  const threadTag = createHash("sha256").update(String(intent.threadKey ?? "no-thread")).digest("hex").slice(0, 12);
  // One draft per REPLY (not per thread): the same thread can carry several
  // inbound mails, each with its own draft proposal — the message id (or the
  // body when none exists) keeps the natural keys distinct while the thread
  // tag keeps them grouped.
  const messageTag = createHash("sha256").update(String(intent.messageId ?? intent.bodyText ?? "")).digest("hex").slice(0, 12);
  const key = naturalKey ?? `reply-${threadTag}-${messageTag}`;
  return proposeEffect(db, stateDir, {
    now,
    taskId,
    attemptId,
    effectType: "mail",
    domainKey,
    naturalKey: key,
    operationIntent: {
      targetResource: `mail:${check.recipients.join(";")}`,
      operation: "mail.send",
      contentHash: check.contentHash,
      attachmentHash: check.attachmentHash,
      evidenceManifestHash,
      parentObjectIds,
      payloadContent: intent.bodyText,
      extra: {
        to: check.to,
        cc: check.cc,
        bcc: check.bcc,
        recipients: check.recipients,
        sendingIdentity: intent.sendingIdentity,
        subject: intent.subject,
        bodyText: intent.bodyText,
        attachments: intent.attachments,
        threadKey: intent.threadKey ?? null,
        inReplyTo: intent.inReplyTo ?? null,
        references: intent.references ?? null,
        fixedSendingIdentity: adaptersConfig?.fixedSendingIdentity ?? null,
      },
    },
    retryMode: "AT_MOST_ONCE",
    provider: "smtp",
    resource: domainKey,
    requiresApproval: true,
    approverPrincipalId: approverPrincipalId
      ?? db.prepare("SELECT owner_id FROM scopes WHERE id=?")
        .get(db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(taskId)?.scope_id)?.owner_id,
    expiresAt: now + (mailConfig?.approvalTtlMs ?? 14400000),
  });
}

// The draft evidence payload: a bounded, redacted, ACL-locked view of the
// thread the draft answers (the approval card cites it; the group scopes can
// never read it because its required scope is the mail scope only).
export function insertMailDraftEvidence(db, stateDir, { now, taskId, scopeId, threadObjectIds, draftText }) {
  return insertObjectRow(db, {
    scopeId,
    kind: "mail_draft",
    sourceUri: `task:${taskId}`,
    sourceActor: "host-triage",
    content: JSON.stringify({ draft: redactSecrets(String(draftText ?? "")), threadObjectIds }),
    observedAt: now,
    requiredScopeIds: [scopeId],
    parents: threadObjectIds.map((id) => ({ parentId: id })),
  });
}
