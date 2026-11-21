import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";

const [, , portFile, logFile, hostMapRaw, modeFile] = process.argv;
let hostMap = {};
if (hostMapRaw) {
  try {
    hostMap = JSON.parse(hostMapRaw);
  } catch {}
}

function currentMode() {
  if (!modeFile || !existsSync(modeFile)) return "normal";
  try {
    return readFileSync(modeFile, "utf8").trim() || "normal";
  } catch {
    return "normal";
  }
}

const server = createServer((_req, res) => {
  res.writeHead(405);
  res.end();
});

server.on("connect", (req, clientSocket, head) => {
  const rawAuth = String(req.url ?? "");
  const lastColon = rawAuth.lastIndexOf(":");
  const rawHost = (lastColon > 0 ? rawAuth.slice(0, lastColon) : rawAuth).replace(/^\[|\]$/g, "");
  const host = hostMap[rawHost] ?? rawHost;
  const port = Number(lastColon > 0 ? rawAuth.slice(lastColon + 1) : 80);
  const mode = currentMode();
  try {
    appendFileSync(logFile, JSON.stringify({ target: req.url, mode }) + "\n", "utf8");
  } catch {}
  if (mode === "eof-before-200") {
    clientSocket.destroy();
    return;
  }
  if (mode === "reject-407") {
    clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  if (mode === "reject-407-spoof-200") {
    clientSocket.end("HTTP/1.1 407 Auth Code 200 Required\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  const upstreamSock = netConnect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length > 0) upstreamSock.write(head);
    upstreamSock.pipe(clientSocket);
    clientSocket.pipe(upstreamSock);
  });
  upstreamSock.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstreamSock.destroy());
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
writeFileSync(portFile, String(server.address().port), "utf8");
