// CORS credential-reflection check for the hono triage oracle.
// Proposition (GHSA-88fw-hqm2-52qc / CVE-2026-54290, affects hono < 4.12.25,
// severity high): when cors() runs with its default wildcard-origin behavior
// AND credentials are enabled, the middleware must NOT reflect an arbitrary
// caller Origin back as access-control-allow-origin alongside
// access-control-allow-credentials: true. Reflecting it lets any site read
// credentialed responses cross-origin.
//
// Resolution (audit round 2 N4): hono is loaded EXPLICITLY from the install
// directory given as the first argument via createRequire — never from the
// process cwd and never by walking up from this script's location (both of
// those resolve the REPO's hono 4.13.19 and produce a false green for the
// vulnerable snapshot). With no argument, the script's own directory is
// used (copy-in-place still works).
//
// Run: node checks/cors-credential-check.mjs <hono-install-dir>
// Exit 0 = check holds (no reflection), exit 1 = check fails (reflection),
// exit 2 = infra error (hono could not be loaded / middleware failed).

import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const installDir = resolve(process.argv[2] ?? here);
let Hono, cors;
try {
  const requireFromInstall = createRequire(join(installDir, "package.json"));
  ({ Hono } = requireFromInstall("hono"));
  ({ cors } = requireFromInstall("hono/cors"));
} catch (e) {
  console.error(JSON.stringify({ infra_error: `cannot load hono from ${installDir}: ${e.message}` }));
  process.exit(2);
}

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
    honoFrom: installDir,
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
