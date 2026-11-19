// CORS credential-reflection check for the hono triage oracle.
// Proposition (GHSA-88fw-hqm2-52qc / CVE-2026-54290, affects hono < 4.12.25,
// severity high): when cors() runs with its default wildcard-origin behavior
// AND credentials are enabled, the middleware must NOT reflect an arbitrary
// caller Origin back as access-control-allow-origin alongside
// access-control-allow-credentials: true. Reflecting it lets any site read
// credentialed responses cross-origin.
//
// Resolution (audit round 2 N4 + round 3 N9): hono is loaded EXPLICITLY from
// the install directory given as the first argument via createRequire —
// never from the process cwd and never by walking up from this script's
// location. Because Node's module resolution walks UP the directory tree,
// loading alone is not proof of source: pointing at a directory that has no
// node_modules/hono (e.g. a committed snapshot dir inside the repo tree)
// silently resolves the REPO's hono and false-greens. So after loading, the
// REAL resolved module paths (require.resolve) must lie INSIDE the requested
// install dir; otherwise this is an infra error and the script exits 2 —
// never a green result. honoFrom reports the actual resolved file path.
// With no argument, the script's own directory is used (copy-in-place mode:
// copy this script INTO the install dir, then run it there).
//
// Run: node checks/cors-credential-check.mjs <hono-install-dir>
// Exit 0 = check holds (no reflection), exit 1 = check fails (reflection),
// exit 2 = infra error (hono missing, or resolved outside the requested dir).

import { createRequire } from "node:module";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const installDir = resolve(process.argv[2] ?? here);
const requireFromInstall = createRequire(join(installDir, "package.json"));

let Hono, cors, resolvedHono, resolvedCors;
try {
  ({ Hono } = requireFromInstall("hono"));
  ({ cors } = requireFromInstall("hono/cors"));
  resolvedHono = requireFromInstall.resolve("hono");
  resolvedCors = requireFromInstall.resolve("hono/cors");
} catch (e) {
  console.error(JSON.stringify({ infra_error: `cannot load hono from ${installDir}: ${e.message}` }));
  process.exit(2);
}

// Containment gate (audit round 3 N9): see csrf-textping-check.mjs.
function insideInstall(p) {
  const rel = relative(installDir, resolve(p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
if (!insideInstall(resolvedHono) || !insideInstall(resolvedCors)) {
  console.error(
    JSON.stringify({
      infra_error: `hono resolved OUTSIDE the requested install dir — refusing to run (audit round 3 N9). requested=${installDir} resolvedHono=${resolvedHono} resolvedCors=${resolvedCors}`,
    }),
  );
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
    honoFrom: resolvedHono,
    corsFrom: resolvedCors,
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
