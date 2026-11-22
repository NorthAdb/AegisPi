// Local loopback stand-in for the Telegram Bot API (Unit 5.2 fixtures).
//
// argv: portFile logFile [queueFile]
//   - GET  /bot<token>/getUpdates?offset&limit  → {ok:true, result:[updates
//     with update_id >= offset, capped at limit]} — a READ, the queue is
//     never consumed (platform semantics: nothing is acked here).
//   - POST /bot<token>/sendMessage              → {ok:true, result:{...}}
//     and a log line so the suite can assert ZERO bytes left when a gate
//     blocks a send.
// The queue file (JSON array of updates) is read once at start; the token
// is REDACTED in every log line.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [, , portFile, logFile, queueFile] = process.argv;
let queue = [];
if (queueFile && existsSync(queueFile)) {
  try {
    queue = JSON.parse(readFileSync(queueFile, "utf8"));
  } catch {
    queue = [];
  }
}

function redact(path) {
  return String(path).replace(/\/bot[^/]+/g, "/bot[REDACTED_BOT_TOKEN]");
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const getUpdates = /^\/bot[^/]+\/getUpdates$/.test(url.pathname) && req.method === "GET";
  const sendMessage = /^\/bot[^/]+\/sendMessage$/.test(url.pathname) && req.method === "POST";
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (getUpdates) {
      const offset = Number(url.searchParams.get("offset") ?? "0") || 0;
      const limit = Number(url.searchParams.get("limit") ?? "100") || 100;
      const result = queue.filter((u) => Number(u?.update_id) >= offset).slice(0, limit);
      appendFileSync(logFile, JSON.stringify({ method: "GET", path: redact(url.pathname), offset, limit, served: result.length }) + "\n", "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    if (sendMessage) {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {}
      appendFileSync(logFile, JSON.stringify({ method: "POST", path: redact(url.pathname), chat_id: body.chat_id ?? null, text: body.text ?? null }) + "\n", "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 9000 + Math.floor(Math.random() * 100), chat: { id: body.chat_id ?? null } } }));
      return;
    }
    appendFileSync(logFile, JSON.stringify({ method: req.method, path: redact(url.pathname), status: 404 }) + "\n", "utf8");
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, description: "not found" }));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
writeFileSync(portFile, String(server.address().port), "utf8");
