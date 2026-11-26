import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";

interface ConnectRecord {
  seq: number;
  at: string;
  target: string;
  status: number;
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
const dataDir = path.resolve(args["data-dir"] ?? ".tmp-fake-connect-proxy");
const host = args["host"] ?? "127.0.0.1";
const proxyPort = Number(args["proxy-port"] ?? "0");
const controlPort = Number(args["control-port"] ?? "0");

mkdirSync(dataDir, { recursive: true });
const logPath = path.join(dataDir, "connect-tunnels.jsonl");
let seq = readJsonl<ConnectRecord>(logPath).length;

const proxyServer = http.createServer((_req, res) => {
  res.writeHead(405);
  res.end("CONNECT only");
});

proxyServer.on("connect", (req, clientSocket, head) => {
  const authority = req.url ?? "";
  const [targetHost, targetPortStr] = authority.split(":");
  const targetPort = Number(targetPortStr);
  // Stage 1 safety: local fake proxy only tunnels to loopback targets
  if (!targetHost || (targetHost !== "127.0.0.1" && targetHost !== "localhost") || !Number.isFinite(targetPort)) {
    seq++;
    appendJsonl(logPath, { seq, at: new Date().toISOString(), target: authority, status: 403 });
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.destroy();
    return;
  }
  const upstream = net.connect({ host: targetHost, port: targetPort }, () => {
    seq++;
    appendJsonl(logPath, { seq, at: new Date().toISOString(), target: authority, status: 200 });
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => {
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.destroy();
  });
  clientSocket.on("error", () => upstream.destroy());
});

const controlServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}`);
  const sendJson = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/__control/stats" && req.method === "GET") {
    const records = readJsonl<ConnectRecord>(logPath);
    sendJson(200, { pid: process.pid, totalTunnels: records.length, records });
    return;
  }
  if (url.pathname === "/__control/shutdown" && req.method === "POST") {
    sendJson(200, { ok: true });
    setImmediate(() => {
      proxyServer.close();
      controlServer.close();
      process.exit(0);
    });
    return;
  }
  sendJson(404, { error: "not_found" });
});

await new Promise<void>((resolve) => proxyServer.listen(proxyPort, host, () => resolve()));
await new Promise<void>((resolve) => controlServer.listen(controlPort, host, () => resolve()));

const pAddr = proxyServer.address() as AddressInfo;
const cAddr = controlServer.address() as AddressInfo;

process.stdout.write(
  JSON.stringify({
    ready: true,
    service: "fake-connect-proxy",
    pid: process.pid,
    host,
    proxyPort: pAddr.port,
    controlPort: cAddr.port,
    logPath,
  }) + "\n",
);
