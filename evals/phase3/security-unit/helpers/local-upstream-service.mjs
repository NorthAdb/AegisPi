// Local controllable upstream service for the security-unit submitter
// cases. Runs as its OWN process (argv: portFile logFile) because the test
// process blocks synchronously during spawnSync calls: a server held by
// the test process could never accept while the daemon or transport child
// is running. Writes its port to portFile, appends one JSON line per
// request to logFile, and answers the three request kinds the HTTP
// transport sends. /slow answers a submit only after a long sleep so the
// timeout->unknown mapping is exercised against a real wire.
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
    const entry = { kind: body?.kind, businessKey: body?.businessKey, path: req.url, at: body?.at };
    try {
      appendFileSync(logFile, JSON.stringify(entry) + "\n");
    } catch {}
    const slow = req.url === "/slow";
    const answer = () => {
      if (body?.kind === "submit") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ externalId: `ext-${Date.now()}`, duplicate: false }));
      } else if (body?.kind === "lookup") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ found: true, externalId: "ext-1" }));
      } else if (body?.kind === "lookupHead") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, head: "sha512-head" }));
      } else {
        res.writeHead(400);
        res.end("{}");
      }
    };
    if (slow) {
      setTimeout(answer, 6000);
    } else {
      answer();
    }
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
writeFileSync(portFile, String(server.address().port), "utf8");
