// csrf() text/ping bypass check for the hono triage oracle.
// Proposition (GHSA-46wx-v44x-9hh2, affects hono < 4.13.16): the csrf()
// middleware must reject cross-site state-changing requests sent by
// hyperlink auditing (Content-Type: text/ping / Sec-Fetch-Dest: ping).
//
// Resolution (audit round 2 N4): hono is loaded EXPLICITLY from the install
// directory given as the first argument via createRequire — never from the
// process cwd and never by walking up from this script's location (both of
// those resolve the REPO's hono 4.13.19 and produce a false green for the
// vulnerable snapshot). With no argument, the script's own directory is
// used (copy-in-place still works).
//
// Run: node checks/csrf-textping-check.mjs <hono-install-dir>
// Exit 0 = check holds (csrf rejects the ping request),
// exit 1 = check fails (ping bypasses csrf),
// exit 2 = infra error (hono could not be loaded / middleware failed).

import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const installDir = resolve(process.argv[2] ?? here);
let Hono, csrf;
try {
  const requireFromInstall = createRequire(join(installDir, "package.json"));
  ({ Hono } = requireFromInstall("hono"));
  ({ csrf } = requireFromInstall("hono/csrf"));
} catch (e) {
  console.error(JSON.stringify({ infra_error: `cannot load hono from ${installDir}: ${e.message}` }));
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
    honoFrom: installDir,
    status: res.status,
    rejected: res.status === 403,
  };
} catch (e) {
  console.error(JSON.stringify({ infra_error: String(e.message) }));
  process.exit(2);
}

console.log(JSON.stringify(result, null, 1));
process.exit(result.rejected ? 0 : 1);
