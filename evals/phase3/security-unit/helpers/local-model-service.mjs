// Local controllable OpenAI SSE model service for security-unit and
// model-proposal suites. Runs as its own child process (argv: portFile logFile
// [modeFile]) because spawnSync blocks the parent event loop.
// Routes:
//   POST /chat/completions  -> OpenAI-shaped SSE stream with scripted usage
//   POST /_control          -> switch active mode / inspect log
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [, , portFile, logFile, modeFile] = process.argv;

function readMode() {
  if (modeFile && existsSync(modeFile)) {
    try {
      return JSON.parse(readFileSync(modeFile, "utf8"));
    } catch {}
  }
  return { kind: "priced", promptTokens: 500000, completionTokens: 250000 };
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}

    if (req.method === "POST" && req.url === "/_mode") {
      if (modeFile) writeFileSync(modeFile, JSON.stringify(body ?? {}), "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
      return;
    }

    try {
      appendFileSync(
        logFile,
        JSON.stringify({
          at: Date.now(),
          method: req.method,
          path: req.url,
          model: body?.model ?? null,
          thinking: body?.thinking ?? null,
          reasoning_effort: body?.reasoning_effort ?? null,
          max_tokens: body?.max_tokens ?? null,
          input: body?.messages?.[0]?.content ?? null,
        }) + "\n",
      );
    } catch {}

    const cfg = readMode();
    if (cfg.kind === "timeout") {
      // Hold connection open past caller timeout without writing bytes.
      const timer = setTimeout(() => {
        try {
          res.end();
        } catch {}
      }, cfg.delayMs ?? 10000);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    if (cfg.delayMs && cfg.delayMs > 0) {
      await new Promise((r) => setTimeout(r, cfg.delayMs));
    }
    if (cfg.kind === "http_error") {
      res.writeHead(cfg.status ?? 500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: cfg.message ?? "scripted error" } }));
      return;
    }

    const replyText = cfg.reply ?? "model reply for the local verification seam";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-local",
        object: "chat.completion.chunk",
        created: 0,
        model: "deepseek-flash",
        choices: [{ index: 0, delta: { role: "assistant", content: replyText }, finish_reason: null }],
      })}\n\n`,
    );

    const finalChunk = {
      id: "chatcmpl-local",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: {}, finish_reason: cfg.finishReason ?? "stop" }],
    };
    if (cfg.kind !== "no-usage") {
      const promptTokens = cfg.promptTokens ?? 500000;
      const completionTokens = cfg.completionTokens ?? 250000;
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      if (cfg.cacheReadTokens !== undefined || cfg.cacheWriteTokens !== undefined) {
        usage.prompt_tokens_details = {
          ...(cfg.cacheReadTokens !== undefined ? { cached_tokens: cfg.cacheReadTokens } : {}),
          ...(cfg.cacheWriteTokens !== undefined ? { cache_write_tokens: cfg.cacheWriteTokens } : {}),
        };
      }
      finalChunk.usage = usage;
    }
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
writeFileSync(portFile, String(server.address().port), "utf8");
