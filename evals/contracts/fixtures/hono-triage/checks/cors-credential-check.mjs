// CORS credential-reflection check for the hono triage oracle.
// Proposition (GHSA-88fw-hqm2-52qc / CVE-2026-54290, affects hono < 4.12.25,
// severity high): when cors() runs with its default wildcard-origin behavior
// AND credentials are enabled, the middleware must NOT reflect an arbitrary
// caller Origin back as access-control-allow-origin alongside
// access-control-allow-credentials: true. Reflecting it lets any site read
// credentialed responses cross-origin.
//
// Run: node checks/cors-credential-check.mjs   (cwd must resolve `hono`)
// Exit 0 = check holds (no reflection), exit 1 = check fails (reflection),
// exit 2 = infra error (middleware could not be exercised).

import { Hono } from "hono";
import { cors } from "hono/cors";

function headersOf(h) {
  const out = {};
  for (const [k, v] of h.entries()) out[k] = v;
  return out;
}

let result;
try {
  const app = new Hono();
  // The advisory's exact configuration family: credentials enabled, origin
  // left at its default (wildcard) handling.
  app.use("/data", cors({ credentials: true }));
  app.get("/data", (c) => c.json({ ok: true }));

  const res = await app.request(
    "/data",
    {
      method: "GET",
      headers: { origin: "https://attacker.example" },
    },
    (env) => env,
  );
  const h = headersOf(res.headers);
  const acao = h["access-control-allow-origin"] ?? "";
  const acac = h["access-control-allow-credentials"] ?? "";
  result = {
    status: res.status,
    acao,
    acac,
    reflected: acao.includes("attacker.example") && acac.toLowerCase() === "true",
  };
} catch (e) {
  console.error(JSON.stringify({ infra_error: String(e.message) }));
  process.exit(2);
}

console.log(JSON.stringify(result, null, 1));
process.exit(result.reflected ? 1 : 0);
