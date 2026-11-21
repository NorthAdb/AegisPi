// test:model:real — the REAL model acceptance (plan item A; rewired onto the
// ADR-0001 pi-ai 1.5.2 core + model_requests proposal pipeline; NEVER run in
// Phase 4.1).
//
// Exit codes by contract (same discipline as test:ingress-telegram:real):
//   0   the real check(s) passed: one daemon production tick on the
//       owner-authorized real SDK root baseUrl, reserve BEFORE the call,
//       settle by the four-field response usage priced through the host catalog
//   1   a real check failed — recorded honestly, no retry
//   3   NOT VERIFIED — no DEEPSEEK_API_KEY in the local .env. Never a skip
//       dressed as a pass.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
import { loadCanonicalSchema, migrate, ensureModelRequestsTable } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../apps/daemon/src/scheduler.mjs";
import { createCredentialService } from "../../../apps/daemon/src/credentials.mjs";
import { microusdForUsage } from "../../../apps/daemon/src/model-call.mjs";
import { agentWorkAttemptDir, lockHostProposalsDir } from "../../../apps/daemon/src/container-executor.mjs";

lockedNodeGuard();

// Owner-authorized values for real execution (ADR-0001 §5): pathless SDK root
// baseUrl (OpenAI SDK appends /chat/completions) and whitelist key.
const BASE_URL = "https://api.deepseek.com";
const MODEL_WHITELIST_KEY = "deepseek/deepseek-flash";
const WIRE_MODEL_ID = "deepseek-flash";
const PRICE_INPUT_PER_MTOK_MICROUSD = 300000;
const PRICE_OUTPUT_PER_MTOK_MICROUSD = 1200000;
const CALL_UPPER_MICROUSD = 1000;
const PROMPT = "Reply with exactly the word OK and nothing else.";

const suite = makeSuite("model-real");

if (process.env.AEGISPI_ALLOW_REAL_MODEL_ACCEPTANCE !== "1") {
  console.error("");
  console.error("=== test:model:real — REFUSED (exit 4) ===");
  console.error(
    "真实模型验收入口已锁定：必须由主人逐项书面授权并显式设置 AEGISPI_ALLOW_REAL_MODEL_ACCEPTANCE=1 后才允许读取 .env 并发起真实调用。",
  );
  console.error("");
  process.exit(4);
}

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

const ws = makeWorkspace("model-real");
mkdirSync(join(ws.stateDir, "db"), { recursive: true });
const requestId = randomUUID();
{
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  ensureModelRequestsTable(db);
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
  const claim = claimNextTask(db, { now, leaseMs: 60000 });
  createCredentialService(db).registerSlot({
    slot: "model", purpose: "model", source: "deepseek",
    envName: "DEEPSEEK_API_KEY", actorId: "owner", now,
  });
  const attemptDir = agentWorkAttemptDir(ws.stateDir, claim.taskId, claim.attemptNo);
  const proposalsDir = join(attemptDir, "proposals");
  mkdirSync(join(attemptDir, "host-commands"), { recursive: true });
  lockHostProposalsDir(proposalsDir);
  writeFileSync(
    join(proposalsDir, `model-request-${requestId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      kind: "model_request",
      requestId,
      taskId: claim.taskId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      scopeDomainKey: "dm:telegram:6101",
      purpose: "worker",
      modelId: MODEL_WHITELIST_KEY,
      messages: [{ role: "user", content: PROMPT }],
    }) + "\n",
    "utf8",
  );
  db.close();
}

const defaults = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
defaults.model = {
  ...defaults.model,
  baseUrl: BASE_URL,
  allowedPurposes: ["worker"],
  allowedModelIds: [MODEL_WHITELIST_KEY],
  allowRealModelCalls: true,
  callTimeoutMs: 60000,
  callUpperMicrousd: CALL_UPPER_MICROUSD,
  maxInputBytes: 8192,
  maxOutputTokens: 64,
  modelId: WIRE_MODEL_ID,
  priceCatalog: {
    inputPerMTokMicrousd: PRICE_INPUT_PER_MTOK_MICROUSD,
    outputPerMTokMicrousd: PRICE_OUTPUT_PER_MTOK_MICROUSD,
    cacheReadPerMTokMicrousd: null,
    cacheWritePerMTokMicrousd: null,
  },
};
delete defaults.model.priceCatalog.$comment;
const configPath = join(ws.stateDir, "test-config.json");
writeFileSync(configPath, JSON.stringify(defaults, null, 2), "utf8");

const r = spawnSync(
  process.execPath,
  [join(repoRoot, "apps", "daemon", "src", "daemon.mjs"), "--once", `--data-dir=${ws.stateDir}`, `--config=${configPath}`],
  { cwd: repoRoot, encoding: "utf8", timeout: 90000, env: { ...process.env, DEEPSEEK_API_KEY: key } },
);

const db = openDatabase(ws.dbPath, { readOnly: true });
const reqRow = db.prepare("SELECT * FROM model_requests WHERE request_id=?").get(requestId);
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
  cacheReadPerMTokMicrousd: null,
  cacheWritePerMTokMicrousd: null,
};
const pricedNow = microusdForUsage(usage, catalog);
const outHead = (r.stdout ?? "").split(/\r?\n/).filter((l) => /worker:|config:|dispatcher:/.test(l)).slice(0, 4).map(scrub).join(" | ");

suite.check(
  "real-model-call-reserved-then-settled-no-overcharge",
  r.status === 0 &&
    reqRow?.state === "SETTLED" &&
    reservation?.state === "SETTLED" &&
    reservation.actual_microusd > 0 &&
    settled?.usage?.source === "pi-ai" &&
    overcharge === 0 &&
    callFailed === 0 &&
    notSettled === 0,
  `daemon exit=${r.status} req=${reqRow?.state ?? "none"} reservation=${reservation?.state ?? "none"} actual=${reservation?.actual_microusd ?? "-"}microusd source=${settled?.usage?.source ?? "-"} overcharge-audits=${overcharge} call-failed=${callFailed} not-settled=${notSettled} — first log lines: ${outHead.slice(0, 200)}`,
);

suite.check(
  "usage-priced-exactly-by-host-catalog",
  usage !== null &&
    pricedNow === reservation?.actual_microusd &&
    reservation?.actual_microusd > 0 &&
    reservation?.actual_microusd <= CALL_UPPER_MICROUSD,
  `usage input=${usage?.inputTokens ?? "-"} output=${usage?.outputTokens ?? "-"} cacheRead=${usage?.cacheReadTokens ?? "-"} cacheWrite=${usage?.cacheWriteTokens ?? "-"} catalog-price=${pricedNow ?? "null"} microusd settled=${reservation?.actual_microusd ?? "-"} upper=${CALL_UPPER_MICROUSD}`,
);

suite.check(
  "task-succeeded-with-real-evidence-object",
  task?.state === "SUCCEEDED" &&
    typeof evidence?.reply === "string" &&
    evidence?.model === WIRE_MODEL_ID &&
    evidence?.endpoint === "api.deepseek.com",
  `task=${task?.state ?? "?"} reply="${typeof evidence?.reply === "string" ? scrub(evidence.reply.slice(0, 60)) : "-"}" model=${evidence?.model ?? "-"} endpoint=${evidence?.endpoint ?? "-"} settledMicrousd=${evidence?.settledMicrousd ?? "-"}`,
);

writeReport({
  suiteId: "model-real",
  suite,
  label: "test:model:real — 真实模型验收（pi-ai 1.5.2 核心；先预留后请求；四字段目录价结清）",
  extra: {
    dataSources: `接通至 pi-ai 1.5.2 唯一执行核心与 model_requests 提议链路；SDK 根地址 ${BASE_URL}，白名单键 ${MODEL_WHITELIST_KEY}，wire 模型 ${WIRE_MODEL_ID}；输出全程脱敏`,
  },
});
const { pass, fail } = suite.counts;
console.log(`\n=== test:model:real: ${pass} pass, ${fail} fail, ${pass + fail} judged ===`);
process.exit(suiteExit(suite, { label: "test:model:real" }));
