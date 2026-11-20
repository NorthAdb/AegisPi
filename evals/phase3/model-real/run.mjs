// test:model:real — the REAL model acceptance (plan item A; owner-authorized
// 2026-11-20, this run makes exactly ONE real call).
//
// Exit codes by contract (same discipline as test:ingress-telegram:real):
//   0   the real check(s) passed: one daemon production tick on the
//       owner-authorized real endpoint, reserve BEFORE the call, settle by
//       the response usage priced through the host catalog
//   1   a real check failed — recorded honestly, no retry
//   3   NOT VERIFIED — no DEEPSEEK_API_KEY in the local .env. Never a skip
//       dressed as a pass.
//
// What the tick does (unchanged production code, no test seams): claim ->
// ledger.reserve (task/day accounts, upper = model.callUpperMicrousd) ->
// callModelOnce, which POSTs {model, messages} VERBATIM to the configured
// URL (no path appending, no model-name translation; the wire model name is
// the config value itself) -> settle by usage x catalog, or keep HELD when
// usage is missing. An actual over the upper bound still SETTLES and then
// freezes the accounts (budget_overcharge_frozen): that is the code's
// honest accounting, and this suite reports it rather than masking it.
//
// The key transits process env -> credential slot "model" (the DB stores the
// ENV NAME only) -> a short-lived child's argv. It is never printed, logged,
// or committed; every emitted byte passes through a scrub of the live value.
// This direct host path is NOT a Pi SDK call and proves nothing about Pi
// end-to-end (see docs/phase3/reports/model-path-and-pi.md, gap B).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
  repoRoot,
} from "../lib/harness.mjs";
import { loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { createCredentialService } from "../../../apps/daemon/src/credentials.mjs";
import { microusdForUsage } from "../../../apps/daemon/src/model-call.mjs";

lockedNodeGuard();

// Owner-authorized this run (2026-11-20): the FULL request URL (the client
// never appends a path) and the vendor model name. The name is the one the
// real API already accepted in the Phase 1 minimal inference contract
// (docs/phase1/reports/model-binding.md) — not a guess, not the Pi pair ID.
const ENDPOINT = "https://api.deepseek.com/chat/completions";
const MODEL_NAME = "deepseek-flash";
// Phase 1 catalog binding: 0.3 / 1.2 USD per M tokens = microUSD per M.
const PRICE_INPUT_PER_MTOK_MICROUSD = 300000;
const PRICE_OUTPUT_PER_MTOK_MICROUSD = 1200000;
const CALL_UPPER_MICROUSD = 1000; // defaults.json placeholder, owner-confirmed this run
// Fixed neutral prompt; the event payload becomes the call input.
const PROMPT = "Reply with exactly the word OK and nothing else.";

const suite = makeSuite("model-real");

function readEnv(name) {
  try {
    const txt = readFileSync(join(repoRoot, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return undefined;
}

const key = readEnv("DEEPSEEK_API_KEY");
if (!key) {
  console.error("");
  console.error("=== test:model:real — NOT VERIFIED (exit 3) ===");
  console.error("DEEPSEEK_API_KEY 未配置于本机 .env；真实模型验收未执行（未验收，非跳过冒充通过）。需主人授权的 key 槽；本地失败关闭路径已在 test:security:unit 覆盖。");
  console.error("");
  process.exit(3);
}
const scrub = (s) => String(s).split(key).join("***");

// Scratch workspace: the real endpoint/authorization values live ONLY in this
// run's test config; the repo defaults.json is never modified (model.endpoint
// stays null there — the fail-closed default).
const ws = makeWorkspace("model-real");
mkdirSync(join(ws.stateDir, "db"), { recursive: true });
{
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const now = Date.now();
  const ing = receiveEvent(db, ws.stateDir, {
    now, source: "telegram", sourceEventId: "evt-model-real",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: "t-model-real", priority: 5, policyVersion: "pv1", payload: PROMPT, verdict: "ADMIT",
  });
  const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
  dispatchEventToTask(db, {
    inboxId: inbox.id, dispatchKey: dispatchKeyForInbox(inbox), now, priority: 5,
    maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "ss",
  });
  // The host credential slot: the DB row stores the ENV NAME, never the value.
  createCredentialService(db).registerSlot({
    slot: "model", purpose: "model", source: "deepseek",
    envName: "DEEPSEEK_API_KEY", actorId: "owner", now,
  });
  db.close();
}

const defaults = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
defaults.model = {
  ...defaults.model,
  endpoint: ENDPOINT,
  allowRealModelCalls: true,
  callTimeoutMs: 60000,
  callUpperMicrousd: CALL_UPPER_MICROUSD,
  modelId: MODEL_NAME,
  priceCatalog: {
    inputPerMTokMicrousd: PRICE_INPUT_PER_MTOK_MICROUSD,
    outputPerMTokMicrousd: PRICE_OUTPUT_PER_MTOK_MICROUSD,
  },
};
delete defaults.model.priceCatalog.$comment;
const configPath = join(ws.stateDir, "test-config.json");
writeFileSync(configPath, JSON.stringify(defaults, null, 2), "utf8");

// ONE production tick. The daemon child resolves slot "model" from its own
// env; the key rides the child env only.
const r = spawnSync(
  process.execPath,
  [join(repoRoot, "apps", "daemon", "src", "daemon.mjs"), "--once", `--data-dir=${ws.stateDir}`, `--config=${configPath}`],
  { cwd: repoRoot, encoding: "utf8", timeout: 90000, env: { ...process.env, DEEPSEEK_API_KEY: key } },
);

const db = openDatabase(ws.dbPath, { readOnly: true });
const reservation = db.prepare("SELECT * FROM budget_reservations WHERE purpose='worker'").get();
const settledAudits = db.prepare("SELECT details_json FROM audit_log WHERE code='budget_settled'").all();
const overcharge = db.prepare("SELECT count(*) c FROM audit_log WHERE code='budget_overcharge_frozen'").get().c;
const callFailed = db.prepare("SELECT count(*) c FROM audit_log WHERE code='model_call_failed'").get().c;
const notSettled = db.prepare("SELECT count(*) c FROM audit_log WHERE code='model_usage_not_settled'").get().c;
const task = db.prepare("SELECT state FROM tasks ORDER BY created_at DESC LIMIT 1").get();
const resultObj = db.prepare("SELECT storage_ref FROM objects WHERE kind='task_result' ORDER BY observed_at DESC LIMIT 1").get();
db.close();

let evidence = null;
if (resultObj?.storage_ref) {
  try {
    evidence = JSON.parse(readFileSync(join(ws.stateDir, ...resultObj.storage_ref.split("/")), "utf8"));
  } catch {}
}
let settled = null;
for (const row of settledAudits) {
  try {
    settled = JSON.parse(row.details_json);
  } catch {}
}
const usage = evidence?.usage ?? null;
const catalog = {
  inputPerMTokMicrousd: PRICE_INPUT_PER_MTOK_MICROUSD,
  outputPerMTokMicrousd: PRICE_OUTPUT_PER_MTOK_MICROUSD,
};
const pricedNow = microusdForUsage(usage, catalog);
const outHead = (r.stdout ?? "").split(/\r?\n/).filter((l) => /worker:|config:|dispatcher:/.test(l)).slice(0, 4).map(scrub).join(" | ");

suite.check(
  "real-model-call-reserved-then-settled-no-overcharge",
  r.status === 0 &&
    reservation?.state === "SETTLED" &&
    reservation.actual_microusd > 0 &&
    settled?.usage?.source === "model-http-transport" &&
    overcharge === 0 &&
    callFailed === 0 &&
    notSettled === 0,
  `daemon exit=${r.status} reservation=${reservation?.state ?? "none"} actual=${reservation?.actual_microusd ?? "-"}microusd source=${settled?.usage?.source ?? "-"} overcharge-audits=${overcharge} call-failed=${callFailed} not-settled=${notSettled} — one call, reserve before, settle after; first log lines: ${outHead.slice(0, 200)}`,
);

suite.check(
  "usage-priced-exactly-by-host-catalog",
  usage !== null &&
    pricedNow === reservation?.actual_microusd &&
    reservation?.actual_microusd > 0 &&
    reservation?.actual_microusd <= CALL_UPPER_MICROUSD,
  `usage prompt=${usage?.promptTokens ?? "-"} completion=${usage?.completionTokens ?? "-"} catalog-price=${pricedNow ?? "null"} microusd settled=${reservation?.actual_microusd ?? "-"} upper=${CALL_UPPER_MICROUSD} (within bound: no freeze)`,
);

suite.check(
  "task-succeeded-with-real-evidence-object",
  task?.state === "SUCCEEDED" &&
    typeof evidence?.reply === "string" &&
    evidence?.model === MODEL_NAME &&
    evidence?.endpoint === "api.deepseek.com",
  `task=${task?.state ?? "?"} reply="${typeof evidence?.reply === "string" ? scrub(evidence.reply.slice(0, 60)) : "-"}" model=${evidence?.model ?? "-"} endpoint=${evidence?.endpoint ?? "-"} settledMicrousd=${evidence?.settledMicrousd ?? "-"}`,
);

writeReport({
  suiteId: "model-real",
  suite,
  label: "test:model:real — 真实模型验收（DeepSeek 官方端点；单次调用；先预留后请求；目录价结清）",
  extra: {
    dataSources: `主人 2026-11-20 授权的真实调用：完整 URL ${ENDPOINT}，供应商模型名 ${MODEL_NAME}（Phase 1 契约已实测接受），本次恰 1 次调用（授权上限 ≤2，勘误见 docs/phase3/reports/errata-2026-11-20.md）；先 ledger.reserve 后 callModelOnce，按宿主目录价结清；不经 Pi SDK、不构成 Pi 端到端证据；输出全程脱敏；凭据值仅经本机 .env 与短命子进程环境`,
  },
});
const { pass, fail } = suite.counts;
console.log(`\n=== test:model:real: ${pass} pass, ${fail} fail, ${pass + fail} judged ===`);
process.exit(suiteExit(suite, { label: "test:model:real" }));
