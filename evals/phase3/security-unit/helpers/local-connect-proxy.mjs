import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";

const [, , portFile, logFile] = process.argv;

const server = createServer((_req, res) => {
  res.writeHead(405);
  res.end();
});

server.on("connect", (req, clientSocket, head) => {
  const rawAuth = String(req.url ?? "");
  const lastColon = rawAuth.lastIndexOf(":");
  const host = (lastColon > 0 ? rawAuth.slice(0, lastColon) : rawAuth).replace(/^\[|\]$/g, "");
  const port = Number(lastColon > 0 ? rawAuth.slice(lastColon + 1) : 80);
  try {
    appendFileSync(logFile, JSON.stringify({ target: req.url }) + "\n", "utf8");
  } catch {}
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
