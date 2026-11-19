// Probe: a caller holding ONLY the bootstrap token cannot make a state
// change — the console must answer 401 "mutations require a session".
// Exit 0 when the gate holds, 1 when the bootstrap token can mutate.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadCanonicalSchema, migrate } from "../../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../../apps/daemon/src/db/connect.mjs";
import { createConsoleApp, ensureConsoleToken } from "../../../../apps/daemon/src/console/api.mjs";

const stateDir = join("D:/AegisPi/aegis-pi/workspace-state/phase3/probe-console");
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(join(stateDir, "db"), { recursive: true });
const db = openDatabase(join(stateDir, "db", "aegis.db"));
migrate(db, loadCanonicalSchema());
const { token } = ensureConsoleToken(stateDir);
const app = createConsoleApp(db, {
  recovery: { mode: "open", actions: [], failedStep: null },
  mode: "open",
  token,
  port: 4310,
  stateDir,
  ownerPrincipalId: "prn:local:owner",
});
const request = new Request(new URL("http://127.0.0.1:4310/api/approvals/apr:x/decide"), {
  method: "POST",
  headers: { host: "127.0.0.1:4310", authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ decision: "approve", actionHash: "0".repeat(64), nonce: "n" }),
});
const response = await app.fetch(request);
const body = await response.json();
const ok = response.status === 401 && /session/.test(body.message ?? "");
console.log(`probe-console-guard: bootstrap-token mutation -> ${response.status} (${body.code}) -> ${ok ? "gate holds" : "GATE BROKEN"}`);
process.exit(ok ? 0 : 1);
