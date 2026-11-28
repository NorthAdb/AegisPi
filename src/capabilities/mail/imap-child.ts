// Isolated short-lived read-only IMAP child process.
// Zero secrets in environment variables: credentials arrive ONLY on stdin JSON
// and are scrubbed from all output/error messages.
// Supports Direct TLS and HTTP CONNECT proxy tunnel with inner target TLS verification.
// Strictly read-only IMAP commands: EXAMINE + UID FETCH BODY.PEEK (never alters \Seen or FLAGS).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";

interface ImapChildInput {
  mode: "direct" | "connect_tunnel";
  host: string;
  port: number;
  servername: string;
  caPem?: string;
  proxy?: {
    host: string;
    port: number;
  };
  username: string;
  password: string;
  mailbox: string;
  uid?: number;
  subjectContains?: string;
  connectivityOnly?: boolean;
  verifyReadOnly?: boolean;
  timeoutMs?: number;
  includeEnvValuesForAudit?: boolean;
}

function buildObservedEnvMeta(includeValues: boolean, password: string): {
  childEnvKeysObserved: string[];
  childEnvValueDigests: Record<string, string>;
  passwordPresentInEnv: boolean;
  childEnvEntriesObserved?: Array<[string, string]>;
} {
  const entries = Object.entries(process.env)
    .filter((e): e is [string, string] => typeof e[1] === "string")
    .sort(([a], [b]) => a.localeCompare(b));
  const digests: Record<string, string> = {};
  for (const [k, v] of entries) {
    digests[k] = createHash("sha256").update(v, "utf8").digest("hex").slice(0, 16);
  }
  return {
    childEnvKeysObserved: entries.map(([k]) => k),
    childEnvValueDigests: digests,
    passwordPresentInEnv: entries.some(([, v]) => password.length > 0 && v.includes(password)),
    ...(includeValues ? { childEnvEntriesObserved: entries } : {}),
  };
}

function scrub(text: string, secrets: string[], maxLen?: number): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length > 0) out = out.split(s).join("[REDACTED_CREDENTIAL]");
  }
  return maxLen !== undefined ? out.slice(0, maxLen) : out;
}

function writeResult(obj: Record<string, unknown>, secrets: string[]): never {
  const raw = JSON.stringify(obj);
  process.stdout.write(scrub(raw, secrets) + "\n");
  process.exit(0);
}

async function openDirectTls(input: ImapChildInput): Promise<{ socket: tls.TLSSocket; peerSubject: string }> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  return await new Promise((resolve, reject) => {
    const sock = tls.connect(
      {
        host: input.host,
        port: input.port,
        servername: input.servername,
        ca: input.caPem ? [input.caPem] : undefined,
        rejectUnauthorized: true,
      },
      () => {
        clearTimeout(timer);
        const cert = sock.getPeerCertificate();
        const subj = cert?.subject?.CN ? String(cert.subject.CN) : input.servername;
        resolve({ socket: sock, peerSubject: subj });
      },
    );
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Direct TLS connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function openConnectTunnelTls(input: ImapChildInput): Promise<{ socket: tls.TLSSocket; peerSubject: string }> {
  if (!input.proxy) {
    throw new Error("connect_tunnel mode requires proxy { host, port }");
  }
  const timeoutMs = input.timeoutMs ?? 15_000;
  const targetAuthority = `${input.host}:${input.port}`;

  // 1. Open TCP to HTTP CONNECT proxy and establish tunnel
  const rawSocket = await new Promise<net.Socket>((resolve, reject) => {
    const sock = net.connect({ host: input.proxy!.host, port: input.proxy!.port });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`CONNECT tunnel timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.once("connect", () => {
      sock.write(`CONNECT ${targetAuthority} HTTP/1.1\r\nHost: ${targetAuthority}\r\n\r\n`);
    });
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      sock.off("data", onData);
      clearTimeout(timer);
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      if (!/^HTTP\/1\.[01]\s+200\b/i.test(statusLine)) {
        sock.destroy();
        reject(new Error(`CONNECT proxy rejected tunnel: ${statusLine}`));
        return;
      }
      resolve(sock);
    };
    sock.on("data", onData);
  });

  // 2. Upgrade tunneled socket to TLS verifying target server certificate BEFORE sending any credentials!
  return await new Promise((resolve, reject) => {
    const tlsSock = tls.connect(
      {
        socket: rawSocket,
        servername: input.servername,
        ca: input.caPem ? [input.caPem] : undefined,
        rejectUnauthorized: true,
      },
      () => {
        clearTimeout(timer);
        const cert = tlsSock.getPeerCertificate();
        const subj = cert?.subject?.CN ? String(cert.subject.CN) : input.servername;
        resolve({ socket: tlsSock, peerSubject: subj });
      },
    );
    const timer = setTimeout(() => {
      tlsSock.destroy();
      reject(new Error(`Tunneled TLS handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    tlsSock.once("error", (err) => {
      clearTimeout(timer);
      rawSocket.destroy();
      reject(err);
    });
  });
}

class ImapWire {
  readonly #sock: tls.TLSSocket;
  #buf = Buffer.alloc(0);
  #waiters: Array<() => void> = [];
  #closed = false;
  #err: string | null = null;

  constructor(sock: tls.TLSSocket) {
    this.#sock = sock;
    sock.on("data", (chunk: Buffer) => {
      this.#buf = Buffer.concat([this.#buf, chunk]);
      this.#drain();
    });
    sock.on("error", (e) => {
      this.#err = e.message;
      this.#drain();
    });
    sock.on("close", () => {
      this.#closed = true;
      this.#drain();
    });
  }

  #drain(): void {
    const ws = [...this.#waiters];
    this.#waiters = [];
    for (const w of ws) w();
  }

  async #waitMore(timeoutMs = 15_000): Promise<void> {
    if (this.#closed || this.#err) {
      throw new Error(this.#err ?? "IMAP socket closed unexpectedly");
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("IMAP response timeout")), timeoutMs);
      this.#waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async readGreeting(): Promise<string> {
    for (;;) {
      const idx = this.#buf.indexOf("\r\n");
      if (idx !== -1) {
        const line = this.#buf.subarray(0, idx).toString("utf8");
        this.#buf = this.#buf.subarray(idx + 2);
        return line;
      }
      await this.#waitMore();
    }
  }

  async command(tag: string, cmd: string): Promise<string> {
    this.#sock.write(`${tag} ${cmd}\r\n`, "utf8");
    for (;;) {
      const parsed = this.#scanTaggedCompletion(tag);
      if (parsed !== null) {
        this.#buf = this.#buf.subarray(parsed.consumed);
        return parsed.text;
      }
      await this.#waitMore();
    }
  }

  #scanTaggedCompletion(tag: string): { consumed: number; text: string } | null {
    let pos = 0;
    let text = "";
    const tagPrefix = `${tag} `;
    for (;;) {
      if (pos >= this.#buf.length) return null;
      const lf = this.#buf.indexOf(0x0a, pos);
      if (lf === -1) return null;
      const line = this.#buf.subarray(pos, lf + 1).toString("utf8");
      const lit = /\{(\d+)\}\r?\n$/.exec(line);
      if (lit) {
        const n = Number(lit[1]);
        const litEnd = lf + 1 + n;
        if (this.#buf.length < litEnd) return null;
        text += this.#buf.subarray(pos, litEnd).toString("utf8");
        pos = litEnd;
        continue;
      }
      text += line;
      pos = lf + 1;
      if (line.startsWith(tagPrefix)) {
        return { consumed: pos, text };
      }
    }
  }

  close(): void {
    try {
      this.#sock.end();
      this.#sock.destroy();
    } catch {
      // ignore
    }
  }
}

function parseImapQuote(val: string): string {
  return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseHeaders(rawHeader: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of rawHeader.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  return out;
}

function extractLiteralAfter(resp: string, marker: string): string {
  const idx = resp.indexOf(marker);
  if (idx === -1) return "";
  const after = resp.slice(idx + marker.length);
  const lit = /^\s*\{(\d+)\}\r?\n/.exec(after);
  if (lit) {
    const n = Number(lit[1]);
    return after.slice(lit[0].length, lit[0].length + n);
  }
  return "";
}

async function main(): Promise<void> {
  const raw = readFileSync(0, "utf8");
  const input = JSON.parse(raw) as ImapChildInput;
  const secrets = [input.password];

  let wire: ImapWire | null = null;
  try {
    const conn = input.mode === "connect_tunnel"
      ? await openConnectTunnelTls(input)
      : await openDirectTls(input);
    wire = new ImapWire(conn.socket);

    const greeting = await wire.readGreeting();
    if (!greeting.startsWith("* OK")) {
      writeResult({ ok: false, code: "imap_bad_greeting", error: greeting }, secrets);
    }

    const loginResp = await wire.command("A1", `LOGIN ${parseImapQuote(input.username)} ${parseImapQuote(input.password)}`);
    if (!/\bA1 OK\b/i.test(loginResp)) {
      writeResult({ ok: false, code: "imap_login_failed", error: loginResp }, secrets);
    }

    // Strictly READ-ONLY open: EXAMINE (never SELECT!)
    const examineResp = await wire.command("A2", `EXAMINE ${parseImapQuote(input.mailbox)}`);
    if (!/\bA2 OK\b/i.test(examineResp)) {
      writeResult({ ok: false, code: "imap_examine_failed", error: examineResp }, secrets);
    }
    const uidValidityMatch = /UIDVALIDITY\s+(\d+)/i.exec(examineResp);
    const uidValidity = uidValidityMatch ? Number(uidValidityMatch[1]) : 0;

    if (input.connectivityOnly) {
      await wire.command("A9", "LOGOUT").catch(() => {});
      wire.close();
      writeResult(
        {
          ok: true,
          code: "connectivity_ok",
          mode: input.mode,
          tlsVerified: true,
          tlsPeerSubject: conn.peerSubject,
          readOnlyExamine: true,
          usedBodyPeek: false,
          mailbox: input.mailbox,
          uidValidity,
          message: null,
          ...buildObservedEnvMeta(Boolean(input.includeEnvValuesForAudit), input.password),
        },
        secrets,
      );
    }

    if (input.verifyReadOnly) {
      const search = await wire.command("P1", "UID SEARCH ALL");
      if (!/\bP1 OK\b/i.test(search)) throw new Error("imap_search_failed");
      const present = /^\* SEARCH(?: ([\d ]+))?\r?$/im.exec(search);
      const uid = present?.[1]?.trim().split(/\s+/).at(-1);
      if (!present) throw new Error("imap_search_failed");
      let seenUnchanged: boolean | undefined;
      if (uid && /^\d+$/.test(uid)) {
        const before = await wire.command("P2", `UID FETCH ${uid} (UID FLAGS)`);
        const peek = await wire.command("P3", `UID FETCH ${uid} (UID BODY.PEEK[HEADER])`);
        const after = await wire.command("P4", `UID FETCH ${uid} (UID FLAGS)`);
        const beforeFlags = /FLAGS\s*\(([^)]*)\)/i.exec(before)?.[1];
        const afterFlags = /FLAGS\s*\(([^)]*)\)/i.exec(after)?.[1];
        if (!/\bP2 OK\b/i.test(before) || !/\bP3 OK\b/i.test(peek) || !/BODY\[HEADER\]\s+\{\d+\}/i.test(peek) ||
            !/\bP4 OK\b/i.test(after) || beforeFlags === undefined || afterFlags === undefined) {
          throw new Error("imap_read_probe_failed");
        }
        const seen = (flags: string) => flags.toLowerCase().split(/\s+/).includes("\\seen");
        seenUnchanged = seen(beforeFlags) === seen(afterFlags);
      }
      await wire.command("A9", "LOGOUT").catch(() => {});
      wire.close();
      writeResult({
        ok: seenUnchanged === true,
        code: seenUnchanged === true ? "read_verified" : seenUnchanged === false ? "seen_changed" : "mailbox_empty",
        mode: input.mode, tlsVerified: true, readOnlyExamine: true, usedBodyPeek: seenUnchanged !== undefined,
        seenUnchanged,
      }, secrets);
    }

    let targetUid = input.uid;
    if (!targetUid) {
      const searchResp = await wire.command("A3", "UID SEARCH ALL");
      const searchLine = searchResp
        .split(/\r?\n/)
        .find((l) => l.startsWith("* SEARCH"));
      const uids = searchLine
        ? searchLine
            .replace(/^\* SEARCH\s*/i, "")
            .trim()
            .split(/\s+/)
            .map(Number)
            .filter((n) => Number.isFinite(n) && n > 0)
        : [];
      if (uids.length === 0) {
        await wire.command("A9", "LOGOUT").catch(() => {});
        writeResult(
          {
            ok: true,
            mode: input.mode,
            tlsVerified: true,
            tlsPeerSubject: conn.peerSubject,
            readOnlyExamine: true,
            usedBodyPeek: true,
            uidValidity,
            messages: [],
          },
          secrets,
        );
      }
      // Fetch all headers with BODY.PEEK to filter/pick latest by UID
      const uidSet = uids.join(",");
      const listResp = await wire.command("A4", `UID FETCH ${uidSet} (UID FLAGS BODY.PEEK[HEADER])`);
      const candidates: Array<{ uid: number; subject: string }> = [];
      for (const uid of uids) {
        const rx = new RegExp(`\\*\\s+\\d+\\s+FETCH\\s+\\([^)]*UID\\s+${uid}\\b[\\s\\S]*?BODY\\[HEADER\\]\\s*\\{(\\d+)\\}\\r?\\n`, "i");
        const m = rx.exec(listResp);
        if (m) {
          const start = m.index + m[0].length;
          const hdrStr = listResp.slice(start, start + Number(m[1]));
          const hdrs = parseHeaders(hdrStr);
          candidates.push({ uid, subject: hdrs["subject"] ?? "" });
        } else {
          candidates.push({ uid, subject: "" });
        }
      }
      const filtered = input.subjectContains
        ? candidates.filter((c) => c.subject.toLowerCase().includes(input.subjectContains!.toLowerCase()))
        : candidates;
      if (filtered.length === 0) {
        // W2-S5: NEVER widen read scope to unrelated emails when filter has zero matches!
        await wire.command("A9", "LOGOUT").catch(() => {});
        wire.close();
        writeResult(
          {
            ok: true,
            code: "no_matching_message",
            found: false,
            mode: input.mode,
            tlsVerified: true,
            tlsPeerSubject: conn.peerSubject,
            readOnlyExamine: true,
            usedBodyPeek: true,
            mailbox: input.mailbox,
            uidValidity,
            message: null,
            ...buildObservedEnvMeta(Boolean(input.includeEnvValuesForAudit), input.password),
          },
          secrets,
        );
      }
      targetUid = filtered.sort((a, b) => b.uid - a.uid)[0]!.uid;
    }

    // Strictly BODY.PEEK[HEADER] and BODY.PEEK[TEXT] so \Seen flag is NEVER modified!
    const fetchResp = await wire.command(
      "A5",
      `UID FETCH ${targetUid} (UID FLAGS BODY.PEEK[HEADER] BODY.PEEK[TEXT])`,
    );
    if (!/\bA5 OK\b/i.test(fetchResp)) {
      writeResult({ ok: false, code: "imap_fetch_failed", error: fetchResp }, secrets);
    }

    const flagsMatch = /FLAGS\s*\(([^)]*)\)/i.exec(fetchResp);
    const flags = flagsMatch
      ? flagsMatch[1]!
          .trim()
          .split(/\s+/)
          .filter(Boolean)
      : [];
    const rawHeader = extractLiteralAfter(fetchResp, "BODY[HEADER]");
    const rawBody = extractLiteralAfter(fetchResp, "BODY[TEXT]");
    const headers = parseHeaders(rawHeader);

    await wire.command("A9", "LOGOUT").catch(() => {});
    wire.close();

    writeResult(
      {
        ok: true,
        mode: input.mode,
        tlsVerified: true,
        tlsPeerSubject: conn.peerSubject,
        readOnlyExamine: true,
        usedBodyPeek: true,
        mailbox: input.mailbox,
        uidValidity,
        message: {
          uid: targetUid,
          flags,
          from: headers["from"] ?? "",
          to: headers["to"] ?? "",
          subject: headers["subject"] ?? "",
          date: headers["date"] ?? "",
          messageId: headers["message-id"] ?? "",
          body: rawBody,
        },
        ...buildObservedEnvMeta(Boolean(input.includeEnvValuesForAudit), input.password),
      },
      secrets,
    );
  } catch (err) {
    wire?.close();
    const errObj = err as Error & { code?: string };
    writeResult(
      {
        ok: false,
        code: errObj.code ?? "imap_tls_or_transport_error",
        error: scrub(errObj.message ?? String(err), secrets),
        tlsVerified: false,
      },
      secrets,
    );
  }
}

void main();
