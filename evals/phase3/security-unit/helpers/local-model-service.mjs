// Local controllable model service for the security-unit worker cases.
// Runs as its own process (argv: portFile logFile): the test process blocks
// synchronously during spawnSync, so it could never serve a call itself.
// Routes:
//   /model     -> OpenAI-shaped answer WITH usage (500k prompt / 250k
//                 completion tokens) so the host can price it for real
//   /no-usage  -> the same answer shape with NO usage field
// Each request is appended to logFile as one JSON line with its receive
// timestamp, so the suite can prove reserve-before-call and
// settle-after-call ordering against the same wall clock.
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
    try {
      appendFileSync(logFile, JSON.stringify({ at: Date.now(), path: req.url, model: body?.model, input: body?.messages?.[0]?.content ?? null }) + "\n");
    } catch {}
    const withUsage = req.url !== "/no-usage";
    const payload = {
      choices: [{ message: { content: "model reply for the local verification seam" } }],
    };
    if (withUsage) {
      payload.usage = { prompt_tokens: 500000, completion_tokens: 250000 };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
writeFileSync(portFile, String(server.address().port), "utf8");
