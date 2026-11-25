import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, closeSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

export interface SmtpReceiptRecord {
  seq: number;
  receivedAt: string;
  remoteAddress: string;
  mailFrom: string;
  rcptTo: string[];
  rawData: string;
  rawSha256: string;
  modeAtArrival: string;
  replySent: string | null;
}

type SmtpMode = "normal" | "hold_after_receive" | "reject_550";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg && arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        out[key] = val;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function appendJsonlDurable(filePath: string, obj: unknown): void {
  const fd = openSync(filePath, "a");
  try {
    const line = JSON.stringify(obj) + "\n";
    appendFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as T);
}

const args = parseArgs(process.argv.slice(2));
const dataDir = args["data-dir"] ? path.resolve(args["data-dir"]) : path.resolve(".tmp-fake-smtp");
const smtpPort = Number(args["smtp-port"] ?? "0");
const controlPort = Number(args["control-port"] ?? "0");
const host = args["host"] ?? "127.0.0.1";

mkdirSync(dataDir, { recursive: true });
const logPath = path.join(dataDir, "smtp-received.jsonl");

let records: SmtpReceiptRecord[] = readJsonl<SmtpReceiptRecord>(logPath);
let mode: SmtpMode = (args["mode"] as SmtpMode | undefined) ?? "normal";

interface HeldConnection {
  seq: number;
  release: (replyLine?: string) => void;
}
const heldConnections: HeldConnection[] = [];
const arrivalWaiters: Array<{ targetSeq: number; resolve: (rec: SmtpReceiptRecord) => void }> = [];

function notifyArrival(rec: SmtpReceiptRecord): void {
  for (let i = arrivalWaiters.length - 1; i >= 0; i--) {
    const w = arrivalWaiters[i];
    if (w && rec.seq >= w.targetSeq) {
      arrivalWaiters.splice(i, 1);
      w.resolve(rec);
    }
  }
}

const smtpServer = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let inData = false;
  let mailFrom = "";
  let rcptTo: string[] = [];
  let dataLines: string[] = [];

  const sendLine = (line: string): void => {
    if (!socket.destroyed && socket.writable) {
      socket.write(line + "\r\n");
    }
  };

  sendLine("220 aegispi-fake-smtp.local ESMTP ready");

  const processLine = (line: string): void => {
    if (inData) {
      if (line === ".") {
        inData = false;
        const rawData = dataLines.join("\r\n");
        const rawSha256 = createHash("sha256").update(Buffer.from(rawData, "utf8")).digest("hex");
        const currentMode = mode;

        if (currentMode === "reject_550") {
          sendLine("550 5.7.1 Synthetic SMTP rejection");
          mailFrom = "";
          rcptTo = [];
          dataLines = [];
          return;
        }

        const seq = records.length + 1;
        const rec: SmtpReceiptRecord = {
          seq,
          receivedAt: new Date().toISOString(),
          remoteAddress: socket.remoteAddress ?? "unknown",
          mailFrom,
          rcptTo: [...rcptTo],
          rawData,
          rawSha256,
          modeAtArrival: currentMode,
          replySent: currentMode === "normal" ? `250 2.0.0 OK fake-msg-${seq}` : null,
        };
        // Persist durably BEFORE any reply or hold so count survives any crash/kill.
        appendJsonlDurable(logPath, rec);
        records.push(rec);
        notifyArrival(rec);

        mailFrom = "";
        rcptTo = [];
        dataLines = [];

        if (currentMode === "hold_after_receive") {
          heldConnections.push({
            seq,
            release: (replyLine = `250 2.0.0 OK fake-msg-${seq}`) => {
              sendLine(replyLine);
            },
          });
          return;
        }

        sendLine(rec.replySent ?? `250 2.0.0 OK fake-msg-${seq}`);
        return;
      }
      // RFC 5321 dot-unstuffing
      dataLines.push(line.startsWith("..") ? line.slice(1) : line);
      return;
    }

    const upper = line.toUpperCase();
    if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
      sendLine("250-aegispi-fake-smtp.local");
      sendLine("250 SIZE 10485760");
    } else if (upper.startsWith("MAIL FROM:")) {
      mailFrom = line.slice(10).trim();
      rcptTo = [];
      sendLine("250 2.1.0 Sender OK");
    } else if (upper.startsWith("RCPT TO:")) {
      rcptTo.push(line.slice(8).trim());
      sendLine("250 2.1.5 Recipient OK");
    } else if (upper === "DATA") {
      inData = true;
      dataLines = [];
      sendLine("354 Start mail input; end with <CRLF>.<CRLF>");
    } else if (upper === "RSET") {
      mailFrom = "";
      rcptTo = [];
      dataLines = [];
      sendLine("250 2.0.0 Reset OK");
    } else if (upper === "NOOP") {
      sendLine("250 2.0.0 OK");
    } else if (upper === "QUIT") {
      sendLine("221 2.0.0 Bye");
      socket.end();
    } else {
      sendLine("500 5.5.1 Command unrecognized");
    }
  };

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      let line = buffer.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      buffer = buffer.slice(idx + 1);
      processLine(line);
      idx = buffer.indexOf("\n");
    }
  });

  socket.on("error", () => {
    // Expected when host is force-killed with Stop-Process -Force mid-hold.
  });
});

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const controlServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}`);
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  try {
    if (req.method === "GET" && url.pathname === "/__control/stats") {
      const diskRecords = readJsonl<SmtpReceiptRecord>(logPath);
      json(200, {
        pid: process.pid,
        mode,
        totalReceived: diskRecords.length,
        heldCount: heldConnections.length,
        logPath,
        records: diskRecords,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/__control/config") {
      const body = await readJsonBody(req);
      if (body["mode"] === "normal" || body["mode"] === "hold_after_receive" || body["mode"] === "reject_550") {
        mode = body["mode"];
      }
      json(200, { ok: true, mode, totalReceived: records.length });
      return;
    }

    if (req.method === "POST" && url.pathname === "/__control/release") {
      const count = heldConnections.length;
      while (heldConnections.length > 0) {
        const item = heldConnections.shift();
        item?.release();
      }
      json(200, { ok: true, released: count });
      return;
    }

    if (req.method === "GET" && url.pathname === "/__control/wait-arrival") {
      const targetSeq = Number(url.searchParams.get("seq") ?? "1");
      const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? "15000");
      const existing = records.find((r) => r.seq >= targetSeq);
      if (existing) {
        json(200, { arrived: true, record: existing, totalReceived: records.length });
        return;
      }
      const result = await new Promise<SmtpReceiptRecord | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        arrivalWaiters.push({
          targetSeq,
          resolve: (rec) => {
            clearTimeout(timer);
            resolve(rec);
          },
        });
      });
      if (!result) {
        json(408, { arrived: false, totalReceived: records.length });
        return;
      }
      json(200, { arrived: true, record: result, totalReceived: records.length });
      return;
    }

    if (req.method === "POST" && url.pathname === "/__control/shutdown") {
      json(200, { ok: true, shuttingDown: true, id: randomUUID() });
      setImmediate(() => {
        smtpServer.close();
        controlServer.close();
        process.exit(0);
      });
      return;
    }

    json(404, { error: "not_found" });
  } catch (err) {
    json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});

await Promise.all([
  new Promise<void>((resolve) => smtpServer.listen(smtpPort, host, () => resolve())),
  new Promise<void>((resolve) => controlServer.listen(controlPort, host, () => resolve())),
]);

const smtpAddr = smtpServer.address() as net.AddressInfo;
const ctrlAddr = controlServer.address() as net.AddressInfo;
const readyPayload = {
  ready: true,
  service: "fake-smtp",
  pid: process.pid,
  host,
  smtpPort: smtpAddr.port,
  controlPort: ctrlAddr.port,
  mode,
  dataDir,
  logPath,
  initialTotalReceived: records.length,
};
process.stdout.write(JSON.stringify(readyPayload) + "\n");
