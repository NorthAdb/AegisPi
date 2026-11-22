// Isolated short-lived mail child (Unit 5.3; spec 02 section 4, 03 section 3).
// One process, one job, zero environment secrets: everything arrives on
// stdin as a single JSON line and the ONLY output is one JSON line on stdout.
//
// Two deterministic protocol drivers — the model NEVER touches this surface
// and cannot assemble a server address or a raw protocol command here:
//   {mode:"imap.fetch"}  LOGIN -> SELECT -> UID SEARCH -> UID FETCH
//                        (headers + bounded text preview + BODYSTRUCTURE
//                        attachment listing, each attachment hashed SHA-256,
//                        bounded by maxAttachmentBytes);
//   {mode:"smtp.send"}   EHLO -> AUTH PLAIN/LOGIN -> MAIL FROM -> RCPT TO ->
//                        DATA -> "." -> QUIT, with the 06 section 6 honesty
//                        rule: any break AFTER the final "." is kind "unknown"
//                        (the message may or may not have been accepted),
//                        never a silent success or a retryable failure.
//
// TLS: full certificate verification by default. A loopback host (the same
// local-verification-seam convention as model.baseUrl / telegram apiBase)
// accepts the fixture's self-signed certificate; nothing else does.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_BYTES_DEFAULT = 4194304;
const MAX_ATTACHMENTS = 10;

function readInput() {
  const raw = readFileSync(0, "utf8");
  return JSON.parse(raw);
}

function isLoopbackHost(host) {
  const h = String(host ?? "").toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h === "[::1]";
}

function scrub(text, secrets) {
  let clean = String(text ?? "");
  for (const s of secrets) {
    if (typeof s === "string" && s.length > 0) clean = clean.split(s).join("[REDACTED_CREDENTIAL]");
  }
  return clean.slice(0, 600);
}

function fail(error, kind = "local") {
  process.stdout.write(JSON.stringify({ ok: false, kind, error: scrub(error, []) }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Wire plumbing: one socket, framed by CRLF lines with IMAP literal support.

function openSocket({ host, port, tls, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const opts = {
      host,
      port,
      ...(tls ? { rejectUnauthorized: !isLoopbackHost(host), servername: host } : {}),
    };
    const sock = tls ? tlsConnect(opts, () => resolve(sock)) : netConnect({ host, port }, () => resolve(sock));
    sock.once("error", (err) => reject(Object.assign(err, { preConnect: true })));
    const connectTimer = setTimeout(() => {
      const e = new Error(`${tls ? "TLS" : "TCP"} connect timed out after ${timeoutMs}ms`);
      e.preConnect = true;
      sock.destroy();
      reject(e);
    }, timeoutMs);
    connectTimer.unref();
    const clear = () => clearTimeout(connectTimer);
    sock.once("secureConnect", clear);
    sock.once("connect", clear);
    sock.once("close", clear);
  });
}

class Wire {
  constructor(sock, { secrets = [], timeoutMs = 30000 } = {}) {
    this.sock = sock;
    this.secrets = secrets;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.closed = false;
    this.closedError = null;
    sock.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 16 * 1024 * 1024) {
        this.closedError = "wire buffer exceeded 16MiB";
        this.sock.destroy();
        this.drainWaiters();
        return;
      }
      this.drainWaiters();
    });
    sock.on("error", (err) => {
      this.closedError = String(err.message ?? err);
      this.drainWaiters();
    });
    sock.on("close", () => {
      this.closed = true;
      this.drainWaiters();
    });
  }

  drainWaiters() {
    for (const w of [...this.waiters]) w();
    this.waiters = [];
  }

  destroy() {
    try {
      this.sock.destroy();
    } catch {}
  }

  write(text) {
    if (this.closed) throw Object.assign(new Error("wire closed mid-command"), { networkLocal: true });
    return new Promise((resolve, reject) => {
      this.sock.write(text, "utf8", (err) => (err ? reject(err) : resolve()));
    });
  }

  dropConsumed(n) {
    // Consumed bytes leave the buffer for good: every scan starts at 0 of
    // the CURRENT buffer. (A cumulative readOffset beside a shrinking buffer
    // would double-count and desync the SMTP reply stream.)
    this.buffer = this.buffer.subarray(n);
  }

  async waitFor(predicate, { timeoutMs } = {}) {
    const deadline = Date.now() + (timeoutMs ?? this.timeoutMs);
    for (;;) {
      const result = predicate(this.buffer, this.closed, this.closedError);
      if (result.done) return result;
      if (this.closed || this.closedError) {
        return { done: false, reason: this.closedError ?? "connection closed" };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { done: false, reason: `timed out after ${timeoutMs ?? this.timeoutMs}ms` };
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, Math.min(remaining, 150));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}

// Walk complete CRLF lines from `startPos`, handling IMAP literals
// ({N}\r\n + N raw bytes that may contain any bytes including CRLF).
// Returns the tagged completion when `predicate` matches a completion line.
function scanImapCompletion(buf, startPos, predicate) {
  let pos = startPos;
  let text = "";
  for (;;) {
    if (pos >= buf.length) return null;
    const lineEnd = buf.indexOf(0x0a, pos);
    if (lineEnd === -1) return null;
    const lineStr = buf.subarray(pos, lineEnd + 1).toString("utf8");
    const lit = /\{(\d+)\}\r?\n$/.exec(lineStr);
    if (lit) {
      const n = Number(lit[1]);
      const literalStart = lineEnd + 1;
      const literalEnd = literalStart + n;
      if (buf.length < literalEnd) return null;
      text += buf.subarray(pos, literalEnd).toString("utf8");
      pos = literalEnd;
      continue;
    }
    text += lineStr;
    pos = lineEnd + 1;
    if (predicate(lineStr)) {
      return { consumed: pos - startPos, text };
    }
    if (text.length > 4 * 1024 * 1024) {
      throw new Error("IMAP response exceeded 4MiB");
    }
  }
}

// ---------------------------------------------------------------------------
// IMAP fetch driver.

function parseAddressList(raw) {
  // RFC 5322 address-list, best effort and bounded: display names never
  // carry identity downstream — the ADDRESS part is what triage stores.
  const out = [];
  for (const piece of String(raw ?? "").split(",")) {
    const p = piece.trim();
    if (!p) continue;
    const angled = /<([^<>]+)>/.exec(p);
    const address = (angled ? angled[1] : p).replace(/^mailto:/i, "").trim().toLowerCase();
    const name = angled ? p.slice(0, p.indexOf("<")).trim().replace(/^"|"$/g, "") : "";
    if (address) out.push({ name: name.replace(/[<>]/g, ""), address });
  }
  return out;
}

function headerBlockToMessage(headers) {
  const msg = {};
  const lines = headers.split(/\r?\n/);
  let lastKey = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && lastKey) {
      msg[lastKey] += ` ${line.trim()}`;
      continue;
    }
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) {
      lastKey = m[1].toLowerCase();
      msg[lastKey] = m[2];
    }
  }
  return {
    from: parseAddressList(msg.from ?? "")[0] ?? { name: "", address: "" },
    to: parseAddressList(msg.to ?? ""),
    cc: parseAddressList(msg.cc ?? ""),
    subject: String(msg.subject ?? "").replace(/\s+/g, " ").trim(),
    date: String(msg.date ?? ""),
    messageId: String(msg["message-id"] ?? "").trim(),
    inReplyTo: String(msg["in-reply-to"] ?? "").trim(),
    references: String(msg.references ?? "").trim(),
  };
}

// BODYSTRUCTURE walk (RFC 3501 7.4.2): a multipart node's LEADING elements
// are the child parts and the first string element after them is the subtype
// ("MIXED"); a message/rfc822 node nests the inner body at index 8; leaf
// parts carry size at index 6 and disposition at index 9. Part paths are
// IMAP section numbers ("1", "2", "1.1", ...).
function collectAttachments(node, path = "", out = []) {
  if (!Array.isArray(node)) return out;
  if (Array.isArray(node[0])) {
    let i = 0;
    while (i < node.length && Array.isArray(node[i])) i += 1;
    const kids = node.slice(0, i);
    kids.forEach((kid, idx) => {
      const kidPath = path === "" ? String(idx + 1) : `${path}.${idx + 1}`;
      collectAttachments(kid, kidPath, out);
    });
    return out;
  }
  const type = String(node[0] ?? "").toLowerCase();
  const subtype = String(node[1] ?? "").toLowerCase();
  const mediaType = `${type}/${subtype}`;
  const size = Number(node[6] ?? 0) || 0;
  if (mediaType === "message/rfc822") {
    const inner = node[8];
    if (Array.isArray(inner)) collectAttachments(inner, path, out);
    return out;
  }
  let filename = null;
  const disp = node[9];
  if (Array.isArray(disp) && String(disp[0] ?? "").toLowerCase() === "attachment") {
    const params = disp[1];
    if (Array.isArray(params)) {
      for (let i = 0; i + 1 < params.length; i += 1) {
        if (String(params[i]).toLowerCase() === "filename") filename = String(params[i + 1] ?? "");
      }
    }
  }
  if (/^(?:image|application|audio|video)\//.test(mediaType) && mediaType !== "application/octet-stream") {
    out.push({ part: path, mediaType, bytes: size, filename: filename ?? `part-${path}` });
  } else if (filename) {
    out.push({ part: path, mediaType, bytes: size, filename });
  }
  return out;
}

function extractBodystructureValue(respText) {
  const idx = respText.indexOf("BODYSTRUCTURE ");
  if (idx === -1) return null;
  const start = respText.indexOf("(", idx);
  if (start === -1) return null;
  let depth = 0;
  let inQuote = false;
  for (let i = start; i < respText.length; i += 1) {
    const ch = respText[i];
    if (inQuote) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return respText.slice(start, i + 1);
    }
  }
  return null;
}

function parseSexpr(text) {
  let i = 0;
  function skipWs() {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  }
  function parse() {
    skipWs();
    if (text[i] === "(") {
      i += 1;
      const list = [];
      for (;;) {
        skipWs();
        if (text[i] === ")") {
          i += 1;
          return list;
        }
        if (i >= text.length) return list;
        list.push(parse());
      }
    }
    if (text[i] === '"') {
      i += 1;
      let s = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i += 1;
        s += text[i];
        i += 1;
      }
      i += 1;
      return s;
    }
    let s = "";
    while (i < text.length && !/[)\s]/.test(text[i])) {
      s += text[i];
      i += 1;
    }
    if (/^nil$/i.test(s)) return null;
    if (/^\d+$/.test(s)) return Number(s);
    return s;
  }
  return parse();
}

function uidSearchAll(respText) {
  const m = /\* SEARCH ([0-9\r\n ]+)/.exec(respText);
  if (!m) return [];
  return m[1].trim().split(/\s+/).map(Number).filter(Number.isFinite);
}

// A FETCH response echoes the section WITHOUT the .PEEK marker:
// `BODY[HEADER.FIELDS (...)] {N}`, `BODY[1] {N}`, `BODY[TEXT]<0> {N}`.
// sectionRe is a RegExp whose source is spliced before the literal marker.
function literalAfter(respText, sectionRe) {
  const re = new RegExp(sectionRe.source + "\\s*\\{(\\d+)\\}\\r\\n");
  const m = re.exec(respText);
  if (!m) return null;
  const start = m.index + m[0].length;
  return respText.slice(start, start + Number(m[1]));
}

async function runImapFetch(input, secrets) {
  const {
    host, port = 993, tls = true, username, password,
    folder = "INBOX", limit = 10, timeoutMs = 30000,
    maxAttachmentBytes = MAX_ATTACHMENT_BYTES_DEFAULT,
  } = input;
  const sock = await openSocket({ host, port, tls, timeoutMs });
  const wire = new Wire(sock, { secrets, timeoutMs });
  let seq = 0;
  const tag = () => `a${(seq += 1)}`;
  const taggedOk = (t) => (line) => line.startsWith(t + " ");
  const command = async (cmd, t) => {
    await wire.write(cmd + "\r\n");
    const res = await wire.waitFor(
      (buf, closed, closedError) => {
        try {
          const scan = scanImapCompletion(buf, 0, taggedOk(t));
          if (scan) return { done: true, value: scan };
        } catch (e) {
          return { done: true, error: e.message };
        }
        if (closed || closedError) return { done: false, reason: closedError ?? "connection closed mid-response" };
        return { done: false };
      },
      { timeoutMs },
    );
    if (!res.done) throw Object.assign(new Error(`imap ${t}: ${res.reason}`), { smtpStage: false, imapStage: true });
    if (res.value.error) throw Object.assign(new Error(res.value.error), { imapStage: true });
    wire.dropConsumed(res.value.consumed);
    return res.value.text;
  };
  try {
    // Greeting.
    await wire.waitFor(
      (buf) => (/^\* (OK|PREAUTH)/.test(buf.subarray(0, 128).toString("utf8")) ? { done: true, value: true } : { done: false }),
      { timeoutMs },
    );
    const tLogin = tag();
    const loginResp = await command(`${tLogin} LOGIN "${username.replace(/"/g, '\\"')}" "${password.replace(/"/g, '\\"')}"`, tLogin);
    const lastLine = loginResp.trim().split(/\r?\n/).pop() ?? "";
    if (!/^a\d+ OK/.test(lastLine)) {
      throw Object.assign(new Error("imap LOGIN refused"), { imapStage: true, remote: true });
    }
    const tSelect = tag();
    const selectResp = await command(`${tSelect} SELECT "${folder.replace(/"/g, '\\"')}"`, tSelect);
    if (!/^a\d+ OK/.test(selectResp.trim().split(/\r?\n/).pop() ?? "")) {
      throw Object.assign(new Error(`imap SELECT ${folder} refused`), { imapStage: true, remote: true });
    }
    const tSearch = tag();
    const searchResp = await command(`${tSearch} UID SEARCH ALL`, tSearch);
    const uids = uidSearchAll(searchResp).slice(-limit);
    const messages = [];
    for (const uid of uids) {
      const t1 = tag();
      const headerResp = await command(
        `${t1} UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] BODYSTRUCTURE)`,
        t1,
      );
      const headerText = literalAfter(headerResp, /BODY\[HEADER\.FIELDS[^\]]*\]/) ?? "";
      const envelope = headerBlockToMessage(headerText);
      let attachments = [];
      const bsRaw = extractBodystructureValue(headerResp);
      if (bsRaw) {
        try {
          attachments = collectAttachments(parseSexpr(bsRaw)).slice(0, MAX_ATTACHMENTS);
        } catch {}
      }
      let totalAttachmentBytes = 0;
      const hashed = [];
      for (const att of attachments) {
        if (att.bytes > maxAttachmentBytes || totalAttachmentBytes + att.bytes > maxAttachmentBytes * 2) {
          hashed.push({ ...att, sha256: null, skipped: "attachment exceeds the configured maxAttachmentBytes bound" });
          continue;
        }
        const t2 = tag();
        const partResp = await command(`${t2} UID FETCH ${uid} (BODY.PEEK[${att.part}])`, t2);
        const body = literalAfter(partResp, new RegExp(`BODY\\[${att.part.replace(/\./g, "\\.")}\\]`));
        if (typeof body === "string") {
          totalAttachmentBytes += Buffer.byteLength(body, "utf8");
          hashed.push({ ...att, sha256: createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex") });
        } else {
          hashed.push({ ...att, sha256: null, skipped: "attachment literal not found in fetch response" });
        }
      }
      const t3 = tag();
      const textResp = await command(`${t3} UID FETCH ${uid} (BODY.PEEK[TEXT]<0.2048>)`, t3);
      const textPreview = literalAfter(textResp, /BODY\[TEXT\](?:<[^>]*>)?/) ?? "";
      messages.push({
        uid,
        ...envelope,
        textPreview: textPreview.slice(0, 2048),
        attachments: hashed,
      });
    }
    try {
      await wire.write(`${tag()} LOGOUT\r\n`);
    } catch {}
    return { ok: true, messages };
  } catch (e) {
    e.imapStage = true;
    throw e;
  } finally {
    wire.destroy();
  }
}

// ---------------------------------------------------------------------------
// SMTP send driver. Replies are consumed in offset order: each
// smtpCommand starts at wire.readOffset so a greeting is never re-parsed
// as the EHLO reply.

function smtpReplyFrom(buf, startPos) {
  let pos = startPos;
  const lines = [];
  for (;;) {
    const idx = buf.indexOf(0x0a, pos);
    if (idx === -1) return null;
    const line = buf.subarray(pos, idx).toString("utf8").replace(/\r$/, "");
    lines.push(line);
    pos = idx + 1;
    if (/^\d{3}(?: |$)/.test(line)) {
      return { lines, code: Number(line.slice(0, 3)), consumed: pos - startPos };
    }
    if (lines.length > 64) return null;
  }
}

async function smtpCommand(wire, payload, { label, timeoutMs }) {
  if (payload !== null) {
    try {
      await wire.write(payload + "\r\n");
    } catch (e) {
      throw Object.assign(new Error(`smtp ${label}: write failed: ${e.message}`), { networkLocal: true });
    }
  }
  const res = await wire.waitFor(
    (buf) => {
      const parsed = smtpReplyFrom(buf, 0);
      if (parsed) return { done: true, value: parsed };
      return { done: false };
    },
    { timeoutMs },
  );
  if (!res.done) {
    throw new Error(`smtp ${label}: ${res.reason}`);
  }
  wire.dropConsumed(res.value.consumed);
  return { code: res.value.code, lines: res.value.lines };
}

async function runSmtpSend(input, secrets) {
  const { host, port = 465, tls = true, username, password, timeoutMs = 30000, message } = input;
  const { from, to = [], cc = [], bcc = [], subject = "", text = "", attachments = [], messageId } = message ?? {};
  const rcptAll = [...to, ...cc, ...bcc].map((r) => String(r).trim().toLowerCase()).filter((r) => /^[^@\s]+@[^@\s]+$/.test(r));
  if (!from || rcptAll.length === 0 || rcptAll.length > 50) fail("smtp.send needs 1..50 syntactically valid recipients");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) fail(`body exceeds ${MAX_BODY_BYTES} bytes`);
  const boundedAtts = (attachments ?? []).slice(0, 5);
  const boundary = `aegispi-${createHash("sha256").update(messageId ?? `${text}:${Date.now()}`).digest("hex").slice(0, 16)}`;
  const finalMessageId = messageId ?? `<${createHash("sha256").update(`${from}|${rcptAll.join(",")}|${subject}|${text}|${Date.now()}`).digest("hex")}@aegispi.local>`;
  const headers = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${subject.replace(/[\r\n]+/g, " ")}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${finalMessageId}`,
    "MIME-Version: 1.0",
  ];
  let mimeBody;
  if (boundedAtts.length === 0) {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit");
    mimeBody = text;
  } else {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    mimeBody = `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}\r\n`;
    for (const att of boundedAtts) {
      mimeBody += `--${boundary}\r\nContent-Type: ${att.mediaType ?? "application/octet-stream"}; name="${att.filename}"\r\nContent-Disposition: attachment; filename="${att.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${att.contentB64}\r\n`;
    }
    mimeBody += `--${boundary}--`;
  }
  // Dot-stuffing (RFC 5321 4.5.2): a leading '.' on any line doubles it.
  const dataPayload = (headers.join("\r\n") + "\r\n\r\n" + mimeBody)
    .split(/\r\n/)
    .map((l) => (l.startsWith(".") ? "." + l : l))
    .join("\r\n");

  const sock = await openSocket({ host, port, tls, timeoutMs });
  const wire = new Wire(sock, { secrets, timeoutMs });
  let sentDot = false;
  try {
    const greet = await smtpCommand(wire, null, { label: "greeting", timeoutMs });
    if (greet.code !== 220) throw Object.assign(new Error(`smtp greeting refused (${greet.code})`), { remote: true });
    const ehlo = await smtpCommand(wire, "EHLO aegispi.local", { label: "ehlo", timeoutMs });
    if (ehlo.code !== 250) throw Object.assign(new Error(`EHLO refused (${ehlo.code})`), { remote: true });
    const authPlain = Buffer.from(`\0${username}\0${password}`, "utf8").toString("base64");
    const auth = await smtpCommand(wire, `AUTH PLAIN ${authPlain}`, { label: "auth", timeoutMs });
    if (auth.code !== 235) {
      const a1 = await smtpCommand(wire, "AUTH LOGIN", { label: "auth-login", timeoutMs });
      if (a1.code !== 334) throw Object.assign(new Error(`AUTH refused (${auth.code}/${a1.code})`), { remote: true });
      const u1 = await smtpCommand(wire, Buffer.from(username, "utf8").toString("base64"), { label: "auth-user", timeoutMs });
      if (u1.code !== 334) throw Object.assign(new Error(`AUTH username refused (${u1.code})`), { remote: true });
      const p1 = await smtpCommand(wire, Buffer.from(password, "utf8").toString("base64"), { label: "auth-pass", timeoutMs });
      if (p1.code !== 235) throw Object.assign(new Error(`AUTH password refused (${p1.code})`), { remote: true });
    }
    const mailFrom = await smtpCommand(wire, `MAIL FROM:<${from}>`, { label: "mail-from", timeoutMs });
    if (mailFrom.code !== 250) throw Object.assign(new Error(`MAIL FROM refused (${mailFrom.code})`), { remote: true });
    for (const r of rcptAll) {
      const rc = await smtpCommand(wire, `RCPT TO:<${r}>`, { label: "rcpt-to", timeoutMs });
      if (rc.code !== 250 && rc.code !== 251) {
        throw Object.assign(new Error(`RCPT TO:<${r}> refused (${rc.code})`), { remote: true });
      }
    }
    const data = await smtpCommand(wire, "DATA", { label: "data", timeoutMs });
    if (data.code !== 354) throw Object.assign(new Error(`DATA refused (${data.code})`), { remote: true });
    await wire.write(dataPayload + "\r\n.\r\n");
    sentDot = true;
    const accepted = await smtpCommand(wire, null, { label: "data-accepted", timeoutMs });
    if (accepted.code !== 250) {
      throw Object.assign(new Error(`message rejected after DATA (${accepted.code})`), { remote: true, afterDot: true });
    }
    try {
      await wire.write("QUIT\r\n");
    } catch {}
    return { ok: true, messageId: finalMessageId, recipients: rcptAll.length };
  } catch (e) {
    // The 06 section 6 honesty line: once the final '.' was written the
    // message MAY have been accepted — a break here is "unknown", never a
    // clean failure a scheduler could retry.
    if (sentDot && e.afterDot !== true) {
      e.kindAfterDot = "unknown";
    }
    e.smtpStage = true;
    throw e;
  } finally {
    wire.destroy();
  }
}

// ---------------------------------------------------------------------------
// Entry.

let input;
try {
  input = readInput();
} catch (err) {
  fail(`invalid mail child input: ${err.message}`);
}

const { mode, host, port, tls = true, username, password, timeoutMs = 30000 } = input ?? {};
const secrets = [username, password].filter((s) => typeof s === "string" && s.length > 0);

if (!["imap.fetch", "smtp.send"].includes(mode)) fail(`mode ${JSON.stringify(mode)} is not one of imap.fetch/smtp.send`);
if (typeof host !== "string" || host.length === 0 || /[\s/\\]/.test(host) || host.length > 253) fail("mail child refused the host parameter");
if (!Number.isInteger(port) || port < 1 || port > 65535) fail("mail child refused the port parameter");
if (typeof username !== "string" || username.length === 0 || username.length > 320 || /[\s"]/.test(username)) fail("mail child refused the username parameter");
if (typeof password !== "string" || password.length === 0 || password.length > 1024) fail("mail child refused the password parameter");
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) fail("mail child refused the timeout parameter");

const run = mode === "imap.fetch" ? runImapFetch : runSmtpSend;
try {
  const out = await run(input, secrets);
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
} catch (e) {
  // Classification, fail closed toward honesty (06 section 6):
  //   unknown  — the DATA final '.' was written; the remote MAY have accepted
  //              the message, so no clean failure is ever reported;
  //   remote   — a definitive protocol refusal (4xx/5xx, LOGIN/SELECT/DATA
  //              rejected): the action did not happen and cannot silently
  //              become a retry;
  //   local    — connect/write failures, protocol timeouts, mid-response
  //              closes, parse errors: zero bytes of consequence were sent.
  const kind = e.kindAfterDot === "unknown"
    ? "unknown"
    : e.remote === true || e.afterDot === true
      ? "remote"
      : "local";
  process.stdout.write(JSON.stringify({ ok: false, kind, error: scrub(e.message ?? String(e), secrets) }));
  process.exit(0);
}
