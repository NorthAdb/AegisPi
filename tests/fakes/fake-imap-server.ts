import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import tls from "node:tls";
import { generateSelfSignedTlsCert } from "./tls-cert.ts";

export interface FakeImapMessage {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  messageId: string;
  body: string;
  flags: string[];
}

interface ImapAuditRecord {
  seq: number;
  at: string;
  command: string;
  credentialsReceived: boolean;
  readOnlySelected: boolean;
  flagsMutated: boolean;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        out[k] = v;
        i++;
      } else {
        out[k] = "true";
      }
    }
  }
  return out;
}

function appendJsonl(filePath: string, obj: unknown): void {
  const fd = openSync(filePath, "a");
  try {
    appendFileSync(fd, JSON.stringify(obj) + "\n", "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args["data-dir"] ?? ".tmp-fake-imap");
const host = args["host"] ?? "127.0.0.1";
const imapPort = Number(args["imap-port"] ?? "0");
const controlPort = Number(args["control-port"] ?? "0");
const certCn = args["cert-cn"] ?? "imap.local.test";
const expectedUser = args["user"] ?? "owner@local.test";
const expectedPass = args["pass"] ?? "SYNTHETIC_IMAP_APP_PASS_V2";
const uidValidity = Number(args["uid-validity"] ?? "20261126");

mkdirSync(dataDir, { recursive: true });
const logPath = path.join(dataDir, "imap-events.jsonl");
const certPath = path.join(dataDir, "server-cert.pem");

const cert = generateSelfSignedTlsCert({
  commonName: certCn,
  dnsNames: [certCn],
  ipv4Addresses: certCn === "imap.local.test" ? ["127.0.0.1"] : [],
});
writeFileSync(certPath, cert.certPem, "utf8");

let mailboxMessages: FakeImapMessage[] = [
  {
    uid: 101,
    from: "pm@local.test",
    to: expectedUser,
    subject: "周报 - Project Helios (2026-11-19)",
    date: "Thu, 19 Nov 2026 09:00:00 +0800",
    messageId: "<weekly-101@local.test>",
    body: "Project Helios 上周周报：里程碑 M2 计划发布时间为 2026-12-01。",
    flags: [],
  },
  {
    uid: 102,
    from: "pm@local.test",
    to: expectedUser,
    subject: "周报 - Project Helios (2026-11-26 最新)",
    date: "Thu, 26 Nov 2026 09:00:00 +0800",
    messageId: "<weekly-102@local.test>",
    body: "Project Helios 最新周报：发布截止日期已调整为 2026-12-10，安全评审时间为 2026-12-05。",
    flags: [],
  },
];

let auditSeq = readJsonl<ImapAuditRecord>(logPath).length;
let totalLogins = 0;
let totalExamine = 0;
let totalSelect = 0;
let totalBodyPeekFetch = 0;
let totalNonPeekFetch = 0;
const bodyTextFetchedUids: number[] = [];

function recordAudit(entry: Omit<ImapAuditRecord, "seq" | "at">): void {
  auditSeq++;
  appendJsonl(logPath, { seq: auditSeq, at: new Date().toISOString(), ...entry });
}

function buildHeaderBlock(m: FakeImapMessage): string {
  return [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${m.subject}`,
    `Date: ${m.date}`,
    `Message-ID: ${m.messageId}`,
    "",
  ].join("\r\n");
}

const imapServer = tls.createServer({ key: cert.keyPem, cert: cert.certPem }, (socket) => {
  let authed = false;
  let selectedReadOnly = false;
  let buf = "";

  socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Fake TLS IMAP Ready\r\n");

  socket.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    for (;;) {
      const idx = buf.indexOf("\r\n");
      if (idx === -1) break;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const sp = line.indexOf(" ");
      if (sp === -1) continue;
      const tag = line.slice(0, sp);
      const rest = line.slice(sp + 1).trim();
      const upper = rest.toUpperCase();

      if (upper.startsWith("LOGIN ")) {
        totalLogins++;
        const m = /^LOGIN\s+"([^"]*)"\s+"([^"]*)"/i.exec(rest);
        const ok = Boolean(m && m[1] === expectedUser && m[2] === expectedPass);
        recordAudit({
          command: "LOGIN",
          credentialsReceived: true,
          readOnlySelected: false,
          flagsMutated: false,
        });
        if (ok) {
          authed = true;
          socket.write(`${tag} OK LOGIN completed\r\n`);
        } else {
          socket.write(`${tag} NO LOGIN failed\r\n`);
        }
        continue;
      }

      if (!authed && !upper.startsWith("LOGOUT")) {
        socket.write(`${tag} NO Not authenticated\r\n`);
        continue;
      }

      if (upper.startsWith("EXAMINE ")) {
        totalExamine++;
        selectedReadOnly = true;
        recordAudit({
          command: "EXAMINE",
          credentialsReceived: false,
          readOnlySelected: true,
          flagsMutated: false,
        });
        socket.write(`* ${mailboxMessages.length} EXISTS\r\n`);
        socket.write(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid\r\n`);
        socket.write(`${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
        continue;
      }

      if (upper.startsWith("SELECT ")) {
        totalSelect++;
        selectedReadOnly = false;
        recordAudit({
          command: "SELECT",
          credentialsReceived: false,
          readOnlySelected: false,
          flagsMutated: false,
        });
        socket.write(`* ${mailboxMessages.length} EXISTS\r\n`);
        socket.write(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid\r\n`);
        socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
        continue;
      }

      if (upper.startsWith("UID SEARCH")) {
        const uids = mailboxMessages.map((m) => m.uid).join(" ");
        recordAudit({
          command: "UID SEARCH",
          credentialsReceived: false,
          readOnlySelected: selectedReadOnly,
          flagsMutated: false,
        });
        socket.write(`* SEARCH ${uids}\r\n`);
        socket.write(`${tag} OK UID SEARCH completed\r\n`);
        continue;
      }

      if (upper.startsWith("UID FETCH ")) {
        const m = /^UID FETCH\s+([0-9,]+)\s+\((.+)\)$/i.exec(rest);
        if (!m) {
          socket.write(`${tag} BAD malformed UID FETCH\r\n`);
          continue;
        }
        const wantUids = m[1]!.split(",").map(Number);
        const itemsUpper = m[2]!.toUpperCase();
        const isPeek = itemsUpper.includes("BODY.PEEK");
        const hasNonPeekBody = /\bBODY\[/.test(itemsUpper);
        let mutated = false;
        if (isPeek && !hasNonPeekBody) {
          totalBodyPeekFetch++;
        } else if (hasNonPeekBody) {
          totalNonPeekFetch++;
          if (!selectedReadOnly) mutated = true;
        }
        for (const uid of wantUids) {
          const idxMsg = mailboxMessages.findIndex((x) => x.uid === uid);
          if (idxMsg === -1) continue;
          const msg = mailboxMessages[idxMsg]!;
          if (mutated && !msg.flags.includes("\\Seen")) {
            msg.flags.push("\\Seen");
          }
          const parts: string[] = [`UID ${msg.uid}`, `FLAGS (${msg.flags.join(" ")})`];
          if (itemsUpper.includes("HEADER")) {
            const hdr = buildHeaderBlock(msg);
            parts.push(`BODY[HEADER] {${Buffer.byteLength(hdr, "utf8")}}\r\n${hdr}`);
          }
          if (itemsUpper.includes("TEXT")) {
            bodyTextFetchedUids.push(msg.uid);
            parts.push(`BODY[TEXT] {${Buffer.byteLength(msg.body, "utf8")}}\r\n${msg.body}`);
          }
          socket.write(`* ${idxMsg + 1} FETCH (${parts.join(" ")})\r\n`);
        }
        recordAudit({
          command: isPeek ? "UID FETCH BODY.PEEK" : "UID FETCH BODY",
          credentialsReceived: false,
          readOnlySelected: selectedReadOnly,
          flagsMutated: mutated,
        });
        socket.write(`${tag} OK UID FETCH completed\r\n`);
        continue;
      }

      if (upper.startsWith("LOGOUT")) {
        socket.write("* BYE Fake IMAP logging out\r\n");
        socket.write(`${tag} OK LOGOUT completed\r\n`);
        socket.end();
        return;
      }

      socket.write(`${tag} BAD unsupported command\r\n`);
    }
  });
});

const controlServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}`);
  const sendJson = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/__control/stats" && req.method === "GET") {
    const events = readJsonl<ImapAuditRecord>(logPath);
    sendJson(200, {
      pid: process.pid,
      certCn,
      uidValidity,
      totalLogins,
      totalExamine,
      totalSelect,
      totalBodyPeekFetch,
      totalNonPeekFetch,
      bodyTextFetchedUids: [...bodyTextFetchedUids],
      messages: mailboxMessages.map((m) => ({
        uid: m.uid,
        subject: m.subject,
        date: m.date,
        flags: [...m.flags],
      })),
      eventsCount: events.length,
      events,
    });
    return;
  }

  if (url.pathname === "/__control/messages" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: FakeImapMessage[] };
    mailboxMessages = body.messages;
    sendJson(200, { ok: true, count: mailboxMessages.length });
    return;
  }

  if (url.pathname === "/__control/shutdown" && req.method === "POST") {
    sendJson(200, { ok: true });
    setImmediate(() => {
      imapServer.close();
      controlServer.close();
      process.exit(0);
    });
    return;
  }

  sendJson(404, { error: "not_found" });
});

await new Promise<void>((resolve) => imapServer.listen(imapPort, host, () => resolve()));
await new Promise<void>((resolve) => controlServer.listen(controlPort, host, () => resolve()));

const imapAddr = imapServer.address() as AddressInfo;
const ctrlAddr = controlServer.address() as AddressInfo;

process.stdout.write(
  JSON.stringify({
    ready: true,
    service: "fake-imap-tls",
    pid: process.pid,
    host,
    imapPort: imapAddr.port,
    controlPort: ctrlAddr.port,
    certCn,
    certPath,
    uidValidity,
    logPath,
  }) + "\n",
);
