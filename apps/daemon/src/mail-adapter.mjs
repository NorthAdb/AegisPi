// Host-side mail adapter runtime (Unit 5.3; spec 02 section 4, 03 section 3).
// The trusted registry decides WHAT a mail.send action is; THIS module owns
// the transport: credential slot resolution, the fail-closed gates, the
// isolated child process (stdin JSON in, one JSON line out), and the honest
// outcome mapping into the effect ledger's four statuses.
//
// Fail-closed ladder, all checked BEFORE any byte is spawned:
//   mail.smtpHost null            -> not wired, zero transports;
//   mail.allowRealMailSend false  -> not authorized (even on loopback — the
//                                    loopback host is the local verification
//                                    seam, never a silent bypass);
//   credential slot "mail"        -> missing or revoked, no credentials.
// The model never sees a server address or a protocol command: recipients,
// subject and body travel inside the canonical action, the host config owns
// the endpoints, and the child accepts structured fields only.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createCredentialService } from "./credentials.mjs";
import { writeAudit } from "./audit.mjs";
import { extraFieldsOfAction } from "./effects.mjs";
import { isLoopbackEndpoint } from "./upstream-http.mjs";
import { buildSafeChildEnv } from "./model-call.mjs";

const MAIL_CHILD = join(dirname(fileURLToPath(import.meta.url)), "upstream-mail-child.mjs");

export class MailAdapterError extends Error {}

// The "mail" credential slot value shapes (02 section 4: secrets live in the
// host secret store; the DB holds slot metadata only). Accepted:
//   {"user":"...","password":"..."}   JSON object
//   "user:app-password"               single colon split
export function splitMailCredential(value) {
  const v = String(value ?? "");
  if (v.startsWith("{")) {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed?.user === "string" && typeof parsed?.password === "string") {
        return { user: parsed.user, password: parsed.password };
      }
    } catch {}
    throw new MailAdapterError("the mail credential slot value is a JSON object without user/password strings");
  }
  const idx = v.indexOf(":");
  if (idx <= 0 || idx === v.length - 1) {
    throw new MailAdapterError("the mail credential slot value must be user:app-password or a JSON object");
  }
  return { user: v.slice(0, idx), password: v.slice(idx + 1) };
}

function mailLoopback(host) {
  const h = String(host ?? "").toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.") || h === "[::1]";
}

/**
 * One-shot child runner: spawns upstream-mail-child.mjs with a clean env and
 * stdin JSON, parses the single stdout JSON line, scrubs credentials from
 * anything that comes back. Classification is the child's; the runner only
 * adds process-level failures (spawn errors, unparseable output).
 */
export function createMailChildRunner({ nodePath = process.execPath, childPath = MAIL_CHILD } = {}) {
  return function runMailChild(input) {
    const r = spawnSync(nodePath, [childPath], {
      input: JSON.stringify(input),
      env: buildSafeChildEnv(),
      encoding: "utf8",
      timeout: (input?.timeoutMs ?? 30000) + 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) {
      return { ok: false, kind: "local", error: `mail child failed to run: ${r.error.message}` };
    }
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      return { ok: false, kind: "local", error: `mail child produced unparseable output (status ${r.status})` };
    }
    if (out && typeof out === "object") return out;
    return { ok: false, kind: "local", error: "mail child output was not an object" };
  };
}

/**
 * The SMTP transport inside the adapter registry. submit() maps the child's
 * classification to the dispatcher outcome contract:
 *   succeeded     -> { status: "succeeded", externalId: <Message-ID> }
 *   failed_local  -> { status: "failed_local", error: "local_error: ..." }
 *                    (zero request bytes left the host; requeueable)
 *   failed_remote -> { status: "failed_remote", error } (definitive refusal)
 *   unknown       -> { status: "unknown", error } (DATA submitted; 06 §6)
 */
export function createMailUpstream(db, {
  mail: mailConfig,
  now = () => Date.now(),
  runner = null,
} = {}) {
  const runChild = runner ?? createMailChildRunner();
  const credentials = createCredentialService(db);

  const resolveCredentials = () => {
    const resolved = credentials.resolve("mail");
    if (!resolved.ok) return resolved;
    try {
      return { ok: true, ...splitMailCredential(resolved.value) };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  };

  return {
    label: "mail-upstream(smtp-child)",
    canHandle(resource) {
      return mailConfig?.smtpHost !== null && mailConfig?.smtpHost !== undefined;
    },
    // Honest gate probe for tests and the daemon's canDispatchEffectRow.
    gateSummary() {
      if (mailConfig?.smtpHost == null) return { wired: false, reason: "mail.smtpHost is null; zero transports" };
      if (mailConfig.allowRealMailSend !== true) return { wired: true, authorized: false, reason: "mail.allowRealMailSend is false; zero bytes" };
      const cred = resolveCredentials();
      if (!cred.ok) return { wired: true, authorized: false, reason: `mail credential slot not resolvable (${cred.reason})` };
      return { wired: true, authorized: true };
    },
    submit({ businessKey, idempotencyKey, operation: opRow, now: submitNow, mode, effectId = null }) {
      const auditRefusal = (reason) => {
        try {
          writeAudit(db, { code: "adapter_refused", details: { operation: opRow?.operation, reason, effect_id: effectId }, now: now() });
        } catch {}
      };
      const gate = this.gateSummary();
      if (!gate.wired || gate.authorized !== true) {
        auditRefusal(gate.reason);
        return { status: "failed_local", error: `local_error: mail adapter refused: ${gate.reason}` };
      }
      let action = {};
      try {
        action = JSON.parse(opRow?.action_json ?? "{}");
      } catch {
        return { status: "failed_local", error: "local_error: mail adapter refused: action_json is not parseable" };
      }
      const recipients = Array.isArray(extraFieldsOfAction(action).recipients) ? extraFieldsOfAction(action).recipients.map(String) : [];
      if (recipients.length === 0 || recipients.length > 50) {
        return { status: "failed_local", error: "local_error: mail adapter refused: recipients missing or out of bounds" };
      }
      // The transport reachability whitelist (adapters.allowedRecipients) is
      // enforced here too — but it is NOT a disclosure authorization; the CP4
      // closure gate already decided whether this payload may leave at all.
      const transportWhitelist = Array.isArray(mailConfig.allowedRecipients) ? mailConfig.allowedRecipients : [];
      for (const r of recipients) {
        if (!transportWhitelist.includes(r)) {
          auditRefusal(`recipient ${r} is not on mail.allowedRecipients (transport reachability)`);
          return { status: "failed_local", error: `local_error: mail adapter refused: recipient ${r} not on the transport whitelist` };
        }
      }
      const cred = resolveCredentials();
      if (!cred.ok) {
        auditRefusal(`mail credential slot not resolvable (${cred.reason})`);
        return { status: "failed_local", error: `local_error: mail adapter refused: ${cred.reason}` };
      }
      // canonicalActionJson spreads operationIntent.extra at the TOP level
      // of the action, so the adapter's view of "extra" is the same recovery
      // every other adapter uses: the non-canonical fields.
      const extra = extraFieldsOfAction(action);
      // The body text: the payload object content IS the message body (the
      // triage payload carries the draft text the human approved). Attachments
      // ride as base64 in extra (bounded by mail.maxAttachmentBytes at
      // proposal time); a missing body is a refusal, never an empty send.
      const bodyText = typeof extra.bodyText === "string" ? extra.bodyText : null;
      if (bodyText === null || bodyText.length === 0) {
        return { status: "failed_local", error: "local_error: mail adapter refused: no approved body text in the action" };
      }
      const subject = typeof extra.subject === "string" ? extra.subject.slice(0, 998) : "(no subject)";
      const attachments = (Array.isArray(extra.attachments) ? extra.attachments : []).map((a) => ({
        filename: String(a.filename ?? "attachment"),
        mediaType: String(a.mediaType ?? "application/octet-stream"),
        contentB64: String(a.contentB64 ?? ""),
      }));
      const outcome = runChild({
        mode: "smtp.send",
        host: mailConfig.smtpHost,
        port: mailConfig.smtpPort,
        tls: mailConfig.smtpTls !== false,
        username: cred.user,
        password: cred.password,
        timeoutMs: Number.isInteger(mailConfig.timeoutMs) ? mailConfig.timeoutMs : 30000,
        message: {
          from: extra.sendingIdentity,
          to: Array.isArray(extra.to) ? extra.to.map(String) : recipients,
          cc: Array.isArray(extra.cc) ? extra.cc.map(String) : [],
          bcc: Array.isArray(extra.bcc) ? extra.bcc.map(String) : [],
          subject,
          text: bodyText,
          attachments,
          messageId: extra.messageId ?? null,
        },
      });
      if (outcome.ok === true) {
        return { status: "succeeded", externalId: outcome.messageId ?? `smtp:${businessKey}`, recipients: outcome.recipients };
      }
      if (outcome.kind === "unknown") {
        return { status: "unknown", error: outcome.error ?? "smtp outcome unknown (DATA submitted)" };
      }
      if (outcome.kind === "remote") {
        return { status: "failed_remote", error: outcome.error ?? "smtp refused by server" };
      }
      return { status: "failed_local", error: `local_error: ${outcome.error ?? "smtp child local failure"}` };
    },
  };
}

/**
 * IMAP read pass (Unit 5.3 pull runtime). Fail-closed ladder mirrors the
 * send path; a failed read is a local failure — zero state changes, the
 * next interval retries. Returns {skipped|failed|fetched}.
 */
export function pullMailMessages(db, {
  mail: mailConfig,
  now = () => Date.now(),
  runner = null,
  limit = 10,
  timeoutMs = 30000,
} = {}) {
  const auditSkip = (reason) => {
    try {
      writeAudit(db, { code: "mail_pull_skipped", details: { reason }, now: now() });
    } catch {}
  };
  if (mailConfig?.imapHost == null) {
    return { skipped: "mail.imapHost is null; zero IMAP calls (fail closed)" };
  }
  if (mailConfig.allowRealMailRead !== true) {
    auditSkip("mail.allowRealMailRead is false (loopback included; the explicit flag is always demanded)");
    return { skipped: "mail.allowRealMailRead is false; zero IMAP calls" };
  }
  const credentials = createCredentialService(db);
  const resolved = credentials.resolve("mail");
  if (!resolved.ok) {
    auditSkip(`mail credential slot not resolvable (${resolved.reason})`);
    return { skipped: `mail credential slot not resolvable (${resolved.reason}); zero IMAP calls` };
  }
  let cred;
  try {
    cred = splitMailCredential(resolved.value);
  } catch (e) {
    auditSkip(e.message);
    return { skipped: `${e.message}; zero IMAP calls` };
  }
  const runChild = runner ?? createMailChildRunner();
  const folder = (Array.isArray(mailConfig.allowedFolders) && mailConfig.allowedFolders.length > 0)
    ? mailConfig.allowedFolders[0]
    : "INBOX";
  const outcome = runChild({
    mode: "imap.fetch",
    host: mailConfig.imapHost,
    port: mailConfig.imapPort,
    tls: mailConfig.imapTls !== false,
    username: cred.user,
    password: cred.password,
    timeoutMs,
    folder,
    limit,
    maxAttachmentBytes: mailConfig.maxAttachmentBytes ?? 4194304,
  });
  if (outcome.ok !== true) {
    try {
      writeAudit(db, { code: "mail_pull_failed", details: { kind: outcome.kind, error: String(outcome.error ?? "").slice(0, 200) }, now: now() });
    } catch {}
    return { failed: `mail pull failed (${outcome.kind}): ${String(outcome.error ?? "").slice(0, 160)}` };
  }
  return { fetched: Array.isArray(outcome.messages) ? outcome.messages : [] };
}

export { mailLoopback as isLoopbackMailHost, isLoopbackEndpoint };
