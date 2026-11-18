// Minimal csrf() text/ping bypass check for the hono triage oracle.
// Proposition (GHSA-46wx-v44x-9hh2, affects hono < 4.13.16): the csrf()
// middleware must reject cross-site state-changing requests sent by
// hyperlink auditing (Content-Type: text/ping / Sec-Fetch-Dest: ping).
//
// Run: node checks/csrf-textping-check.mjs
// Exit 0 = check holds (csrf rejects the ping request),
// exit 1 = check fails (ping bypasses csrf),
// exit 2 = infra error (middleware could not be exercised).

import { Hono } from "hono";
import { csrf } from "hono/csrf";

function jsonOf(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k] = v;
  return out;
}

async function runCheck() {
  const app = new Hono();
  app.use(csrf());
  app.post("/action", (c) => c.json({ ok: true }));

  // Hyperlink auditing request: a state-changing POST carrying text/ping.
  // The browser sends Sec-Fetch-Dest: ping and Content-Type: text/ping.
  const res = await app.request(
    "/action",
    {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "text/ping",
        "sec-fetch-dest": "ping",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-site": "cross-site",
      },
    },
    (env) => env,
  );

  const h = jsonOf(res.headers);
  return {
    status: res.status,
    rejected: res.status === 403,
    varyHasOrigin: (h["vary"] ?? "").toLowerCase().includes("origin"),
  };
}

let result;
try {
  result = await runCheck();
} catch (e) {
  console.error(JSON.stringify({ infra_error: String(e.message) }));
  process.exit(2);
}

console.log(JSON.stringify(result, null, 1));
process.exit(result.rejected ? 0 : 1);
