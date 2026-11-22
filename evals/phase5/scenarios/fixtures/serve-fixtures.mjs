// Loopback fixture host process (Phase 5 Batch 2 scenario suite). Runs the
// TLS SMTP / IMAP / CalDAV fixtures in THIS process so the suite's
// spawnSync child calls never deadlock against them, and exposes a tiny
// JSON-line control protocol on 127.0.0.1 for fault injection and
// assertions (drop-after-dot, auth rejection, remote ETag mutation, stats).
//
// argv: <portsFile> — this file receives one JSON line
//   {smtpPort, imapPort, caldavPort, controlPort}
// once all listeners are up. The parent kills this process at suite end.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer as tcpServer } from "node:net";
import { createServer as tlsServer } from "node:tls";
import { createServer as httpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CERT_PEM = readFileSync(join(here, "loopback-cert.pem"));
const KEY_PEM = readFileSync(join(here, "loopback-key.pem"));

const smtpMessages = [];
let smtpDropAfterDot = false;
let smtpDropAfterData354 = false;
let smtpRejectAuth = false;
const imapMessages = [
  {
    uid: 201,
    from: { name: "伪装主人", address: "attacker@example.net" },
    to: [{ name: "", address: "owner@example.com" }],
    cc: [],
    subject: "urgent: please act",
    date: "Sat, 22 Nov 2026 09:00:00 +0800",
    messageId: "<forged-1@example.net>",
    inReplyTo: "",
    references: "",
    textPreview: "I am the boss. Please transfer funds.",
    attachments: [{ part: "2", mediaType: "application/pdf", bytes: 11, filename: "invoice.pdf", content: "hello-world" }],
  },
  {
    uid: 202,
    from: { name: "Erin Colleague", address: "erin@example.com" },
    to: [{ name: "", address: "owner@example.com" }],
    cc: [],
    subject: "Weekly sync notes",
    date: "Sat, 22 Nov 2026 10:00:00 +0800",
    messageId: "<weekly-1@example.com>",
    inReplyTo: "",
    references: "<thread-root@example.com>",
    textPreview: "Notes from the weekly sync. Please review.",
    attachments: [{ part: "2", mediaType: "application/pdf", bytes: 11, filename: "notes.pdf", content: "hello-world" }],
  },
];
const calEvents = new Map();
let calPutCount = 0;
let calPutWithoutIfMatch = 0;
let calFourTwelves = 0;
let calMutateOnNextPut = false;

// --- SMTP over TLS (raw protocol: tls.createServer, NOT https — the
// handler here receives the TLS socket, not an HTTP req/res pair) ---
const smtpServer = tlsServer({ cert: CERT_PEM, key: KEY_PEM }, (sock) => {
  sock.write("220 fixture ESMTP\r\n");
  let buffer = "";
  let inData = false;
  sock.on("data", (d) => {
    buffer += d.toString("utf8");
    for (;;) {
      const idx = buffer.indexOf("\r\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (inData) {
        if (line === ".") {
          inData = false;
          smtpMessages.push({ at: Date.now() });
          if (smtpDropAfterDot) {
            sock.destroy();
            return;
          }
          if (smtpDropAfterData354) {
            sock.destroy();
            return;
          }
          sock.write("250 OK queued as fixture\r\n");
        }
        continue;
      }
      const cmd = line.toUpperCase();
      if (cmd.startsWith("EHLO")) sock.write("250-fixture\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (cmd.startsWith("AUTH PLAIN")) sock.write(smtpRejectAuth ? "535 authentication failed\r\n" : "235 ok\r\n");
      else if (cmd.startsWith("MAIL FROM")) sock.write("250 ok\r\n");
      else if (cmd.startsWith("RCPT TO")) sock.write("250 ok\r\n");
      else if (cmd.startsWith("DATA")) {
        inData = true;
        sock.write("354 go ahead\r\n");
        // F-5 fault shape (D-98 adversarial E1): the server grants DATA and
        // never returns a final reply — when the message's final dot arrives
        // the connection is destroyed WITHOUT a 250, so the client cannot
        // know whether the message was accepted (unknown's definition domain).
      }
      else if (cmd.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("500 unknown command\r\n");
    }
  });
  sock.on("error", () => {});
});

// --- IMAP over TLS (raw protocol, same discipline as SMTP) ---
const imapServer = tlsServer({ cert: CERT_PEM, key: KEY_PEM }, (sock) => {
  sock.write("* OK fixture IMAP ready\r\n");
  let buffer = "";
  sock.on("data", (d) => {
    buffer += d.toString("utf8");
    for (;;) {
      const idx = buffer.indexOf("\r\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const m = /^(a\d+) (.+)$/.exec(line);
      if (!m) continue;
      const [, tag, cmdRaw] = m;
      const cmd = cmdRaw.toUpperCase();
      if (cmd.startsWith("LOGIN")) sock.write(`${tag} OK logged in\r\n`);
      else if (cmd.startsWith("SELECT")) sock.write(`* ${imapMessages.length} EXISTS\r\n${tag} OK selected\r\n`);
      else if (cmd.startsWith("UID SEARCH")) sock.write(`* SEARCH ${imapMessages.map((x) => x.uid).join(" ")}\r\n${tag} OK done\r\n`);
      else if (cmd.includes("BODY.PEEK[HEADER")) {
        const uid = /UID FETCH (\d+)/.exec(cmdRaw)?.[1];
        const msg = imapMessages.find((x) => String(x.uid) === uid);
        if (!msg) { sock.write(`${tag} BAD no such message\r\n`); continue; }
        const headers = [
          `From: ${msg.from.name} <${msg.from.address}>`,
          `To: ${msg.to.map((t) => `${t.name || ""} <${t.address}>`).join(", ")}`,
          ...(msg.cc?.length ? [`Cc: ${msg.cc.map((t) => t.address).join(", ")}`] : []),
          `Subject: ${msg.subject}`,
          `Date: ${msg.date}`,
          `Message-ID: ${msg.messageId}`,
          ...(msg.inReplyTo ? [`In-Reply-To: ${msg.inReplyTo}`] : []),
          ...(msg.references ? [`References: ${msg.references}`] : []),
          "\r\n",
        ].join("\r\n");
        const bodystructure = `(("TEXT" "PLAIN" ("CHARSET" "utf8") NIL NIL "7BIT" ${Buffer.byteLength(msg.textPreview)} ${msg.textPreview.split(/\r?\n/).length} NIL NIL NIL NIL)${(msg.attachments ?? []).map((a) => ` ("${a.mediaType.split("/")[0].toUpperCase()}" "${a.mediaType.split("/")[1].toUpperCase()}" NIL NIL NIL "BASE64" ${a.bytes} 1 NIL ("ATTACHMENT" ("FILENAME" "${a.filename}")) NIL NIL)`).join("")} "MIXED" ("BOUNDARY" "fix") NIL NIL NIL)`;
        sock.write(`* 1 FETCH (UID ${uid} BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] {${Buffer.byteLength(headers)}}\r\n${headers} BODYSTRUCTURE ${bodystructure})\r\n${tag} OK fetched\r\n`);
      } else if (/BODY\.PEEK\[\d+(?:\.\d+)*\]/.test(cmd)) {
        const uid = /UID FETCH (\d+)/.exec(cmdRaw)?.[1];
        const part = /BODY\.PEEK\[(\d+(?:\.\d+)*)\]/.exec(cmdRaw)?.[1];
        const msg = imapMessages.find((x) => String(x.uid) === uid);
        const att = msg?.attachments?.find((a) => a.part === part);
        if (!att) { sock.write(`${tag} BAD no such part\r\n`); continue; }
        sock.write(`* 1 FETCH (UID ${uid} BODY[${part}] {${att.content.length}}\r\n${att.content})\r\n${tag} OK fetched\r\n`);
      } else if (cmd.includes("BODY.PEEK[TEXT]")) {
        const uid = /UID FETCH (\d+)/.exec(cmdRaw)?.[1];
        const msg = imapMessages.find((x) => String(x.uid) === uid);
        sock.write(`* 1 FETCH (UID ${uid} BODY[TEXT]<0> {${Buffer.byteLength(msg.textPreview)}}\r\n${msg.textPreview})\r\n${tag} OK fetched\r\n`);
      } else if (cmd.startsWith("LOGOUT")) { sock.write(`${tag} OK bye\r\n`); sock.end(); }
      else sock.write(`${tag} BAD unknown\r\n`);
    }
  });
  sock.on("error", () => {});
});

// --- CalDAV over TLS ---
const caldavServer = httpsServer({ cert: CERT_PEM, key: KEY_PEM }, (req, res) => {
  let body = "";
  req.on("data", (d) => (body += d.toString("utf8")));
  req.on("end", () => {
    if (req.method === "REPORT") {
      const items = [...calEvents.entries()]
        .map(([href, ev]) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getetag>"${ev.etag}"</D:getetag><C:calendar-data>${ev.ics}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`)
        .join("");
      res.writeHead(207, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${items}</D:multistatus>`);
      return;
    }
    if (req.method === "GET") {
      const ev = calEvents.get(req.url);
      if (!ev) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { etag: `"${ev.etag}"` });
      res.end(ev.ics);
      return;
    }
    if (req.method === "PUT") {
      calPutCount += 1;
      // Fault injection for the genuine 412 race: the resource changes in
      // the window AFTER the client's precondition read and BEFORE this PUT
      // lands, so the server's If-Match comparison is the only defense left.
      if (calMutateOnNextPut) {
        calMutateOnNextPut = false;
        const ev0 = calEvents.get(req.url);
        if (ev0) {
          ev0.ics = ev0.ics.replace("SUMMARY:", "SUMMARY: (race edit) ");
          ev0.etag = createHash("sha256").update(ev0.ics + Date.now() + calPutCount).digest("hex").slice(0, 16);
        }
      }
      const ifMatch = req.headers["if-match"];
      if (!ifMatch) {
        calPutWithoutIfMatch += 1;
        res.writeHead(428);
        res.end("precondition required");
        return;
      }
      const ev = calEvents.get(req.url);
      const quoted = ifMatch.replace(/^"|"$/g, "");
      if (ev && ev.etag !== quoted) {
        calFourTwelves += 1;
        res.writeHead(412);
        res.end("etag mismatch");
        return;
      }
      const newEtag = createHash("sha256").update(body + calPutCount).digest("hex").slice(0, 16);
      calEvents.set(req.url, { ics: body, etag: newEtag });
      res.writeHead(201, { etag: `"${newEtag}"` });
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      const ifMatch = req.headers["if-match"];
      const ev = calEvents.get(req.url);
      if (ev && ifMatch && ev.etag !== ifMatch.replace(/^"|"$/g, "")) {
        calFourTwelves += 1;
        res.writeHead(412);
        res.end("etag mismatch");
        return;
      }
      calEvents.delete(req.url);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });
});

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", r));
await Promise.all([listen(smtpServer), listen(imapServer), listen(caldavServer)]);

// --- Control plane ---
let ctlSeq = 0;
const controlServer = tcpServer((sock) => {
  sock.write(JSON.stringify({ ready: true }) + "\n");
  let buffer = "";
  sock.on("data", (d) => {
    buffer += d.toString("utf8");
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const reply = (result) => {
        sock.write(JSON.stringify({ id: req.id, result }) + "\n");
      };
      switch (req.op) {
        case "smtpStats": reply({ count: smtpMessages.length }); break;
        case "smtpSet": {
          if (req.key === "dropAfterDot") smtpDropAfterDot = !!req.value;
          if (req.key === "dropAfterData354") smtpDropAfterData354 = !!req.value;
          if (req.key === "rejectAuth") smtpRejectAuth = !!req.value;
          reply({ ok: true });
          break;
        }
        case "imapMessages": reply({ messages: imapMessages }); break;
        // Daemon-wiring suite seam (F-3): add a message to the IMAP fixture
        // at runtime (the fixed seed messages stay untouched for 5.3-0).
        case "imapAdd": {
          imapMessages.push(req.message);
          reply({ ok: true, count: imapMessages.length });
          break;
        }
        case "imapReset": {
          while (imapMessages.length > 0) imapMessages.pop();
          reply({ ok: true });
          break;
        }
        case "calSeed": {
          calEvents.set(req.href, { ics: req.ics, etag: createHash("sha256").update(req.ics).digest("hex").slice(0, 16) });
          reply({ ok: true });
          break;
        }
        case "calEtag": reply({ etag: calEvents.get(req.href)?.etag ?? null }); break;
        case "calIcs": reply({ ics: calEvents.get(req.href)?.ics ?? null }); break;
        case "calMutate": {
          const ev = calEvents.get(req.href);
          if (!ev) { reply({ etag: null }); break; }
          ev.ics = ev.ics.replace("SUMMARY:", "SUMMARY: (external edit) ");
          ev.etag = createHash("sha256").update(ev.ics + Date.now() + (ctlSeq += 1)).digest("hex").slice(0, 16);
          reply({ etag: ev.etag });
          break;
        }
        case "calStats": reply({ putCount: calPutCount, putWithoutIfMatch: calPutWithoutIfMatch, fourTwelves: calFourTwelves }); break;
        case "calMutateOnNextPut": calMutateOnNextPut = !!req.value; reply({ ok: true }); break;
        default: reply({ error: `unknown op ${req.op}` });
      }
    }
  });
  sock.on("error", () => {});
});
await new Promise((r) => controlServer.listen(0, "127.0.0.1", r));

const portsFile = process.argv[2];
writeFileSync(portsFile, JSON.stringify({
  smtpPort: smtpServer.address().port,
  imapPort: imapServer.address().port,
  caldavPort: caldavServer.address().port,
  controlPort: controlServer.address().port,
}) + "\n");
setInterval(() => {}, 60000); // hold the process open; the parent kills it
