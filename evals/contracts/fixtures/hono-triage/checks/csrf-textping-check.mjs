// csrf() text/ping bypass check for the hono triage oracle.
// Proposition (GHSA-46wx-v44x-9hh2, affects hono < 4.13.16): the csrf()
// middleware must reject cross-site state-changing requests sent by
// hyperlink auditing (Content-Type: text/ping / Sec-Fetch-Dest: ping).
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
// Run: node checks/csrf-textping-check.mjs <hono-install-dir>
// Exit 0 = check holds (csrf rejects the ping request),
// exit 1 = check fails (ping bypasses csrf),
// exit 2 = infra error (hono missing, or resolved outside the requested dir).

import { createRequire } from "node:module";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const installDir = resolve(process.argv[2] ?? here);
const requireFromInstall = createRequire(join(installDir, "package.json"));

let Hono, csrf, resolvedHono, resolvedCsrf;
try {
  ({ Hono } = requireFromInstall("hono"));
  ({ csrf } = requireFromInstall("hono/csrf"));
  resolvedHono = requireFromInstall.resolve("hono");
  resolvedCsrf = requireFromInstall.resolve("hono/csrf");
} catch (e) {
  console.error(JSON.stringify({ infra_error: `cannot load hono from ${installDir}: ${e.message}` }));
  process.exit(2);
}

// Containment gate (audit round 3 N9). `relative` returns a path starting
// with ".." (or an absolute one across drives) when the resolved module
// lives OUTSIDE installDir — that means resolution walked up to some other
// tree's node_modules (e.g. the repo's hono 4.13.19) and the run would test
// the wrong hono. Refuse instead of green-lighting.
function insideInstall(p) {
  const rel = relative(installDir, resolve(p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
if (!insideInstall(resolvedHono) || !insideInstall(resolvedCsrf)) {
  console.error(
    JSON.stringify({
      infra_error: `hono resolved OUTSIDE the requested install dir — refusing to run (audit round 3 N9). requested=${installDir} resolvedHono=${resolvedHono} resolvedCsrf=${resolvedCsrf}`,
    }),
  );
  process.exit(2);
}

function headersOf(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k] = v;
  return out;
}

let result;
try {
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

  const h = headersOf(res.headers);
  result = {
    honoFrom: resolvedHono,
    csrfFrom: resolvedCsrf,
    status: res.status,
    rejected: res.status === 403,
  };
} catch (e) {
  console.error(JSON.stringify({ infra_error: String(e.message) }));
  process.exit(2);
}

console.log(JSON.stringify(result, null, 1));
process.exit(result.rejected ? 0 : 1);
