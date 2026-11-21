import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [, , portFile, logFile] = process.argv;

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    const match = /^\/bot([^/]+)\/sendMessage$/.exec(req.url ?? "");
    const safePath = String(req.url ?? "").replace(/\/bot[^/\s"']+/g, "/bot[REDACTED_BOT_TOKEN]");
    const entry = {
      method: req.method,
      path: safePath,
      tokenPresent: Boolean(match?.[1]),
      chat_id: body?.chat_id ?? null,
      text: body?.text ?? null,
      disable_web_page_preview: body?.disable_web_page_preview ?? null,
    };
    try {
      appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");
    } catch {}

    const sendOk = () => {
      if (!match || req.method !== "POST") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, description: "Not Found" }));
        return;
      }
      if (typeof body?.text === "string" && body.text.includes("__REMOTE_ERR__")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 9001, chat: { id: Number(body?.chat_id) } } }));
    };

    if (typeof body?.text === "string" && body.text.includes("__SLOW__")) {
      setTimeout(sendOk, 4000);
    } else {
      sendOk();
    }
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
writeFileSync(portFile, String(server.address().port), "utf8");
