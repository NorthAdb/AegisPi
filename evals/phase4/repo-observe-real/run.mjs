import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  repoRoot,
  suiteExit,
  writeReport,
} from "../../phase3/lib/harness.mjs";
import { imageRef, requireAppImageDigests } from "../../phase3/lib/image-gate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { ensureModelRequestsTable, loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { dispatchKeyForInbox, receiveEvent } from "../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { createCredentialService } from "../../../apps/daemon/src/credentials.mjs";

lockedNodeGuard();

if (process.env.AEGISPI_ALLOW_REAL_OBSERVE_ACCEPTANCE !== "1") {
  console.error("");
  console.error("=== phase4:repo-observe-real — REFUSED (exit 4) ===");
  console.error(
    "真实仓库 Observe 验收入口已锁定：必须先完成许可 2 首跑检查表书面确认并显式设置 AEGISPI_ALLOW_REAL_OBSERVE_ACCEPTANCE=1 后才允许读取 .env、访问公网仓库与调用真实模型。",
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

const apiKey = readEnv("DEEPSEEK_API_KEY");
if (!apiKey) {
  console.error("");
  console.error("=== phase4:repo-observe-real — NOT VERIFIED (exit 3) ===");
  console.error("DEEPSEEK_API_KEY 未配置于本机 .env；真实 Repo Observe 验收未执行。");
  console.error("");
  process.exit(3);
}

const scrub = (s) => String(s ?? "").split(apiKey).join("***");
const { digests } = await requireAppImageDigests();
const AGENT_REF = imageRef("agent", digests);
const ACQUISITION_REF = imageRef("acquisition", digests);
const daemonPath = join(repoRoot, "apps", "daemon", "src", "daemon.mjs");

const PEAK_CATALOG = {
  inputPerMTokMicrousd: 300000,
  outputPerMTokMicrousd: 1200000,
  cacheReadPerMTokMicrousd: 6000,
  cacheWritePerMTokMicrousd: null,
};
const OFFPEAK_CATALOG = {
  inputPerMTokMicrousd: 150000,
  outputPerMTokMicrousd: 600000,
  cacheReadPerMTokMicrousd: 3000,
  cacheWritePerMTokMicrousd: null,
};

function computeCatalogMicrousd(usage, cat) {
  if (!usage) return null;
  const scaled =
    BigInt(usage.inputTokens ?? 0) * BigInt(cat.inputPerMTokMicrousd ?? 0) +
    BigInt(usage.outputTokens ?? 0) * BigInt(cat.outputPerMTokMicrousd ?? 0) +
    BigInt(usage.cacheReadTokens ?? 0) * BigInt(cat.cacheReadPerMTokMicrousd ?? 0);
  if (scaled === 0n) return 0;
  return Number((scaled + 999_999n) / 1_000_000n);
}

const TARGETS = {
  aegispi: {
    repo: "NorthAdb/AegisPi",
    url: "https://github.com/NorthAdb/AegisPi/archive/8943a108df5fceb0a98a91771b23464e50c34dfb.tar.gz",
    ref: "8943a108df5fceb0a98a91771b23464e50c34dfb",
    mode: "tar",
    allowedRedirectHosts: ["codeload.github.com"],
    readPaths: [
      "AegisPi-8943a108df5fceb0a98a91771b23464e50c34dfb/package.json",
      "AegisPi-8943a108df5fceb0a98a91771b23464e50c34dfb/apps/daemon/src/model-requests.mjs",
    ],
  },
  hono: {
    repo: "honojs/hono",
    url: "https://github.com/honojs/hono/archive/676c8f80fcafc49e6e74c847a8f0d9c44cc7faee.tar.gz",
    ref: "v4.13.19",
    mode: "tar",
    allowedRedirectHosts: ["codeload.github.com"],
    readPaths: [
      "hono-676c8f80fcafc49e6e74c847a8f0d9c44cc7faee/package.json",
      "hono-676c8f80fcafc49e6e74c847a8f0d9c44cc7faee/src/index.ts",
      "hono-676c8f80fcafc49e6e74c847a8f0d9c44cc7faee/README.md",
    ],
  },
  "pi-agent-north": {
    repo: "NorthAdb/pi-agent-north",
    url: "https://github.com/NorthAdb/pi-agent-north/archive/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d.tar.gz",
    ref: "ce950d78f424dcaf9f5d6a03ce80ab141130eb1d",
    mode: "tar",
    allowedRedirectHosts: ["codeload.github.com"],
    maxDownloadBytes: 33554432,
    readPaths: [
      "pi-agent-north-ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/package.json",
      "pi-agent-north-ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/ai/src/index.ts",
      "pi-agent-north-ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/src/index.ts",
    ],
  },
  openpi: {
    repo: "NorthAdb/openpi",
    url: "https://github.com/NorthAdb/openpi/archive/6c43f92756a93129abe282e587b6afdf0f7e99b0.tar.gz",
    ref: "6c43f92756a93129abe282e587b6afdf0f7e99b0",
    mode: "tar",
    allowedRedirectHosts: ["codeload.github.com"],
    readPaths: [
      "openpi-6c43f92756a93129abe282e587b6afdf0f7e99b0/package.json",
      "openpi-6c43f92756a93129abe282e587b6afdf0f7e99b0/README.md",
      "openpi-6c43f92756a93129abe282e587b6afdf0f7e99b0/extensions/background-terminals/src/runtime.ts",
    ],
  },
  "hermes-agents-file": {
    repo: "NorthAdb/hermes-agent",
    url: "https://raw.githubusercontent.com/NorthAdb/hermes-agent/ddb56d0aa126be722115afd3779d17f80f490825/agent/AGENTS.md",
    ref: "ddb56d0aa126be722115afd3779d17f80f490825",
    mode: "file",
    readPaths: ["repo"],
  },
  "piper-durable-file": {
    repo: "NorthAdb/Piper",
    url: "https://raw.githubusercontent.com/NorthAdb/Piper/4484231e1913cf22cbc72ca6ee8b990007a82b09/packages/durable/src/index.ts",
    ref: "4484231e1913cf22cbc72ca6ee8b990007a82b09",
    mode: "file",
    readPaths: ["repo"],
  },
  "hono-no-redirect": {
    repo: "honojs/hono",
    url: "https://github.com/honojs/hono/archive/676c8f80fcafc49e6e74c847a8f0d9c44cc7faee.tar.gz",
    ref: "v4.13.19",
    mode: "tar",
    readPaths: ["hono-676c8f80fcafc49e6e74c847a8f0d9c44cc7faee/package.json"],
  },
  "hermes-oversize-tar": {
    repo: "NorthAdb/hermes-agent",
    url: "https://github.com/NorthAdb/hermes-agent/archive/ddb56d0aa126be722115afd3779d17f80f490825.tar.gz",
    ref: "ddb56d0aa126be722115afd3779d17f80f490825",
    mode: "tar",
    allowedRedirectHosts: ["codeload.github.com"],
    maxDownloadBytes: 2 * 1024 * 1024,
    readPaths: ["hermes-agent-ddb56d0aa126be722115afd3779d17f80f490825/README.md"],
  },
};

function writeRealConfig(
  ws,
  {
    maxInputBytes = 49152,
    maxOutputTokens = 8192,
    callUpperMicrousd = 50000,
    callTimeoutMs = 120000,
    priceCatalog = PEAK_CATALOG,
    allowedHosts = ["github.com", "codeload.github.com", "raw.githubusercontent.com"],
    targets = TARGETS,
  } = {},
) {
  const defaults = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
  defaults.model = {
    ...defaults.model,
    baseUrl: "https://api.deepseek.com",
    allowedPurposes: ["worker"],
    allowedModelIds: ["deepseek/deepseek-flash"],
    allowRealModelCalls: true,
    callUpperMicrousd,
    callTimeoutMs,
    maxInputBytes,
    maxOutputTokens,
    priceCatalog,
  };
  defaults.acquisition = {
    ...defaults.acquisition,
    allowRealRepoFetch: true,
    enableHostGateway: false,
    allowedHosts,
    maxDownloadBytes: 33554432,
    maxExcerptBytes: 49152,
    timeoutMs: 120000,
    targets,
  };
  const cfgPath = join(ws.stateDir, "real-observe-config.json");
  writeFileSync(cfgPath, JSON.stringify(defaults, null, 2), "utf8");
  return cfgPath;
}

function enqueueObserveTask(ws, { eventId, targetId, question, initDb = false } = {}) {
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  if (initDb) {
    migrate(db, loadCanonicalSchema());
    ensureModelRequestsTable(db);
    createCredentialService(db).registerSlot({
      slot: "model",
      purpose: "model",
      source: "deepseek",
      envName: "DEEPSEEK_API_KEY",
      actorId: "owner",
      now: Date.now(),
    });
  }
  const now = Date.now();
  const ing = receiveEvent(db, ws.stateDir, {
    now,
    source: "telegram",
    sourceEventId: eventId,
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: `t-${eventId}`,
    priority: 5,
    policyVersion: "pv1",
    payload: JSON.stringify({ kind: "repo_observe", targetId, question }),
    verdict: "ADMIT",
  });
  const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
  const disp = dispatchEventToTask(db, {
    inboxId: inbox.id,
    dispatchKey: dispatchKeyForInbox(inbox),
    now,
    priority: 5,
    maxSteps: 25,
    deadlineAt: now + 15 * 60 * 1000,
    skillSetHash: "ss-p42-real",
  });
  db.close();
  return disp.taskId;
}

function runDaemonOnceReal(ws, cfgPath) {
  return spawnSync(
    process.execPath,
    [
      daemonPath,
      "--once",
      `--data-dir=${ws.stateDir}`,
      `--config=${cfgPath}`,
      `--agent-image=${AGENT_REF}`,
      `--acquisition-image=${ACQUISITION_REF}`,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 240000,
      env: { ...process.env, DEEPSEEK_API_KEY: apiKey },
    },
  );
}

function readTaskSummary(ws, taskId) {
  const db = openDatabase(ws.dbPath, { readOnly: true });
  const task = db
    .prepare(
      "SELECT t.state, t.result_object_id, a.error_code FROM tasks t LEFT JOIN attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no WHERE t.id=?",
    )
    .get(taskId);
  const req = db
    .prepare("SELECT state, reservation_id, reply_object_id FROM model_requests WHERE task_id=?")
    .get(taskId);
  const resRow = req?.reservation_id
    ? db.prepare("SELECT state, actual_microusd, upper_microusd FROM budget_reservations WHERE id=?").get(req.reservation_id)
    : null;
  const resObj = task?.result_object_id
    ? db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(task.result_object_id)
    : null;
  const manifestObj = db
    .prepare(
      "SELECT o.id, o.storage_ref FROM objects o WHERE o.kind='repo_observe_manifest' ORDER BY o.observed_at DESC LIMIT 1",
    )
    .get();
  const edgeRow =
    task?.result_object_id && manifestObj?.id
      ? db
          .prepare("SELECT relation FROM object_edges WHERE parent_id=? AND child_id=?")
          .get(manifestObj.id, task.result_object_id)
      : null;
  const heldAudit = db
    .prepare("SELECT count(*) c FROM audit_log WHERE code='observe_stopped_settlement_held' AND task_id=?")
    .get(taskId).c;
  const frozenCount = db.prepare("SELECT count(*) c FROM budget_accounts WHERE frozen=1").get().c;
  db.close();

  const resultJson = resObj?.storage_ref
    ? JSON.parse(readFileSync(join(ws.stateDir, ...resObj.storage_ref.split("/")), "utf8"))
    : null;
  const manifestJson = manifestObj?.storage_ref
    ? JSON.parse(readFileSync(join(ws.stateDir, ...manifestObj.storage_ref.split("/")), "utf8"))
    : null;
  const leftWorkDirs = existsSync(join(ws.stateDir, "acquisitions"))
    ? readdirSync(join(ws.stateDir, "acquisitions")).length
    : 0;
  const leftContainers = spawnSync(
    "docker",
    ["ps", "-aq", "--filter", `label=aegispi.state_dir=${ws.stateDir}`],
    { encoding: "utf8" },
  ).stdout.trim();

  return {
    task,
    req,
    resRow,
    edgeRow,
    heldAudit,
    frozenCount,
    resultJson,
    manifestJson,
    leftWorkDirs,
    leftContainers,
  };
}

const suite = makeSuite("repo-observe-real");
const runTelemetry = [];

// 1. NorthAdb/AegisPi (GitHub 302 redirect -> codeload + Chinese deep audit prompt)
{
  const ws = makeWorkspace("p42-real-aegispi");
  const cfgPath = writeRealConfig(ws);
  const taskId = enqueueObserveTask(ws, {
    eventId: "real-aegispi",
    targetId: "aegispi",
    question:
      "请仅基于本次只读提取的 package.json 与 model-requests.mjs，用中文简要总结：1) model_requests 的七态状态名；2) 在哪个节点进入 CHARGED_BOUND；3) 本次过程是否发生仓库写入。",
    initDb: true,
  });
  const d = runDaemonOnceReal(ws, cfgPath);
  const s = readTaskSummary(ws, taskId);
  const usage = s.resultJson?.usage ?? null;
  const offPeak = computeCatalogMicrousd(usage, OFFPEAK_CATALOG);
  runTelemetry.push({
    case: "aegispi-self-observe",
    repo: "NorthAdb/AegisPi@8943a108",
    mode: "tar (302->codeload)",
    usage,
    settledPeakMicrousd: s.resRow?.actual_microusd ?? null,
    estimatedOffPeakMicrousd: offPeak,
    replyPreview: scrub((s.resultJson?.reply ?? "").slice(0, 240)),
  });
  suite.check(
    "real-aegispi-302-codeload-and-chinese-summary",
    d.status === 0 &&
      s.task?.state === "SUCCEEDED" &&
      s.req?.state === "SETTLED" &&
      s.resRow?.state === "SETTLED" &&
      s.resRow?.actual_microusd > 0 &&
      typeof usage?.totalFromProvider === "boolean" &&
      s.edgeRow?.relation === "derived_from" &&
      s.manifestJson?.readOnly === true &&
      s.manifestJson?.repoWrites === 0 &&
      (s.resultJson?.reply ?? "").length > 60 &&
      !String(s.resultJson?.reply ?? "").includes(apiKey) &&
      s.frozenCount === 0 &&
      s.leftWorkDirs === 0 &&
      s.leftContainers === "",
    scrub(
      `exit=${d.status} task=${s.task?.state} req=${s.req?.state} actual=${s.resRow?.actual_microusd}u$(offPeak~${offPeak}u$) in=${usage?.inputTokens} out=${usage?.outputTokens} cache=${usage?.cacheReadTokens} totalFromProvider=${usage?.totalFromProvider} replyLen=${(s.resultJson?.reply ?? "").length}`,
    ),
  );
}

// 2. honojs/hono v4.13.19 third-party public TypeScript repo
{
  const ws = makeWorkspace("p42-real-hono");
  const cfgPath = writeRealConfig(ws);
  const taskId = enqueueObserveTask(ws, {
    eventId: "real-hono",
    targetId: "hono",
    question:
      "Based strictly on these Hono v4.13.19 files (package.json, src/index.ts, README.md), state Hono's version, primary entry exports, and three supported JavaScript runtimes.",
    initDb: true,
  });
  const d = runDaemonOnceReal(ws, cfgPath);
  const s = readTaskSummary(ws, taskId);
  const usage = s.resultJson?.usage ?? null;
  const offPeak = computeCatalogMicrousd(usage, OFFPEAK_CATALOG);
  runTelemetry.push({
    case: "hono-v4.13.19",
    repo: "honojs/hono@676c8f80",
    mode: "tar (302->codeload)",
    usage,
    settledPeakMicrousd: s.resRow?.actual_microusd ?? null,
    estimatedOffPeakMicrousd: offPeak,
    replyPreview: scrub((s.resultJson?.reply ?? "").slice(0, 240)),
  });
  suite.check(
    "real-hono-v4-13-19-third-party-tar-observe",
    d.status === 0 &&
      s.task?.state === "SUCCEEDED" &&
      s.req?.state === "SETTLED" &&
      s.resRow?.state === "SETTLED" &&
      s.resRow?.actual_microusd > 0 &&
      s.edgeRow?.relation === "derived_from" &&
      /hono/i.test(s.resultJson?.reply ?? "") &&
      s.frozenCount === 0 &&
      s.leftWorkDirs === 0 &&
      s.leftContainers === "",
    scrub(
      `exit=${d.status} task=${s.task?.state} actual=${s.resRow?.actual_microusd}u$(offPeak~${offPeak}u$) in=${usage?.inputTokens} out=${usage?.outputTokens} cache=${usage?.cacheReadTokens}`,
    ),
  );
}

// 3. NorthAdb/pi-agent-north (23 MB / 1947-blob monorepo) + sequential pair for DeepSeek cache_read & day ledger accumulation
{
  const ws = makeWorkspace("p42-real-pi-monorepo");
  const cfgPath = writeRealConfig(ws);
  const task1 = enqueueObserveTask(ws, {
    eventId: "real-pi-1",
    targetId: "pi-agent-north",
    question:
      "Inspect package.json, packages/ai/src/index.ts, and packages/coding-agent/src/index.ts. Summarize the monorepo role split between packages/ai and packages/coding-agent in four concise bullets.",
    initDb: true,
  });
  const d1 = runDaemonOnceReal(ws, cfgPath);
  const s1 = readTaskSummary(ws, task1);

  const task2 = enqueueObserveTask(ws, {
    eventId: "real-pi-2",
    targetId: "pi-agent-north",
    question:
      "Using the exact same package.json, packages/ai/src/index.ts, and packages/coding-agent/src/index.ts excerpt, list five exported symbols or APIs exposed by these entrypoints.",
    initDb: false,
  });
  const d2 = runDaemonOnceReal(ws, cfgPath);
  const s2 = readTaskSummary(ws, task2);

  const db = openDatabase(ws.dbPath, { readOnly: true });
  const dayAcct = db.prepare("SELECT spent_microusd, limit_microusd, frozen FROM budget_accounts WHERE id LIKE 'acct:day:%'").get();
  const taskAccts = db.prepare("SELECT spent_microusd, frozen FROM budget_accounts WHERE id LIKE 'acct:task:%'").all();
  db.close();
  const taskSpentSum = taskAccts.reduce((sum, a) => sum + Number(a.spent_microusd), 0);

  const u1 = s1.resultJson?.usage ?? null;
  const u2 = s2.resultJson?.usage ?? null;
  runTelemetry.push({
    case: "pi-agent-north-call1",
    repo: "NorthAdb/pi-agent-north@ce950d78",
    mode: "tar (23MB monorepo)",
    usage: u1,
    settledPeakMicrousd: s1.resRow?.actual_microusd ?? null,
    estimatedOffPeakMicrousd: computeCatalogMicrousd(u1, OFFPEAK_CATALOG),
  });
  runTelemetry.push({
    case: "pi-agent-north-call2",
    repo: "NorthAdb/pi-agent-north@ce950d78",
    mode: "tar (sequential cache probe)",
    usage: u2,
    settledPeakMicrousd: s2.resRow?.actual_microusd ?? null,
    estimatedOffPeakMicrousd: computeCatalogMicrousd(u2, OFFPEAK_CATALOG),
  });
  suite.check(
    "real-pi-agent-north-monorepo-and-sequential-ledger",
    d1.status === 0 &&
      d2.status === 0 &&
      s1.task?.state === "SUCCEEDED" &&
      s2.task?.state === "SUCCEEDED" &&
      s1.resRow?.state === "SETTLED" &&
      s2.resRow?.state === "SETTLED" &&
      dayAcct?.spent_microusd + taskSpentSum === s1.resRow.actual_microusd + s2.resRow.actual_microusd &&
      dayAcct?.spent_microusd > 0 &&
      dayAcct?.frozen === 0 &&
      taskAccts.every((a) => a.frozen === 0) &&
      s1.leftWorkDirs === 0 &&
      s2.leftContainers === "",
    scrub(
      `call1=${s1.resRow?.actual_microusd}u$(in=${u1?.inputTokens},out=${u1?.outputTokens},cache=${u1?.cacheReadTokens}) call2=${s2.resRow?.actual_microusd}u$(in=${u2?.inputTokens},out=${u2?.outputTokens},cache=${u2?.cacheReadTokens}) daySpent=${dayAcct?.spent_microusd}u$ taskSum=${taskSpentSum}u$`,
    ),
  );
}

// 4. NorthAdb/openpi with deliberate tight model.maxInputBytes=8192 truncation
{
  const ws = makeWorkspace("p42-real-openpi-cap");
  const cfgPath = writeRealConfig(ws, { maxInputBytes: 8192, maxOutputTokens: 2048 });
  const taskId = enqueueObserveTask(ws, {
    eventId: "real-openpi",
    targetId: "openpi",
    question: "Summarize what openpi provides from the truncated excerpts without inventing missing sections.",
    initDb: true,
  });
  const d = runDaemonOnceReal(ws, cfgPath);
  const s = readTaskSummary(ws, taskId);
  const usage = s.resultJson?.usage ?? null;
  const someTruncated = (s.manifestJson?.files ?? []).some((f) => f.truncated === true);
  runTelemetry.push({
    case: "openpi-max-input-truncation",
    repo: "NorthAdb/openpi@6c43f927",
    mode: "tar (maxInputBytes=8192)",
    usage,
    settledPeakMicrousd: s.resRow?.actual_microusd ?? null,
    estimatedOffPeakMicrousd: computeCatalogMicrousd(usage, OFFPEAK_CATALOG),
    someFileTruncated: someTruncated,
  });
  suite.check(
    "real-openpi-input-cap-truncation-settles-cleanly",
    d.status === 0 &&
      s.task?.state === "SUCCEEDED" &&
      s.req?.state === "SETTLED" &&
      someTruncated === true &&
      (s.resultJson?.reply ?? "").length > 30 &&
      s.frozenCount === 0,
    scrub(
      `exit=${d.status} truncated=${someTruncated} actual=${s.resRow?.actual_microusd}u$ in=${usage?.inputTokens} out=${usage?.outputTokens} replyLen=${(s.resultJson?.reply ?? "").length}`,
    ),
  );
}

// 5. NorthAdb/hermes-agent (AGENTS.md) & NorthAdb/Piper (durable/src/index.ts) single-file mode
{
  const ws = makeWorkspace("p42-real-file-mode");
  const cfgPath = writeRealConfig(ws);
  const taskHermes = enqueueObserveTask(ws, {
    eventId: "real-hermes-file",
    targetId: "hermes-agents-file",
    question: "用两句中文概括这份 Hermes AGENTS.md 中的一条核心开发约定。",
    initDb: true,
  });
  const d1 = runDaemonOnceReal(ws, cfgPath);
  const s1 = readTaskSummary(ws, taskHermes);

  const taskPiper = enqueueObserveTask(ws, {
    eventId: "real-piper-file",
    targetId: "piper-durable-file",
    question: "List the public exports re-exported from Piper packages/durable/src/index.ts.",
    initDb: false,
  });
  const d2 = runDaemonOnceReal(ws, cfgPath);
  const s2 = readTaskSummary(ws, taskPiper);

  runTelemetry.push({
    case: "hermes-agent-raw-file",
    repo: "NorthAdb/hermes-agent@ddb56d0a (agent/AGENTS.md)",
    mode: "file (raw.githubusercontent.com)",
    usage: s1.resultJson?.usage ?? null,
    settledPeakMicrousd: s1.resRow?.actual_microusd ?? null,
    estimatedOffPeakMicrousd: computeCatalogMicrousd(s1.resultJson?.usage, OFFPEAK_CATALOG),
  });
  runTelemetry.push({
    case: "piper-durable-raw-file",
    repo: "NorthAdb/Piper@4484231e (packages/durable/src/index.ts)",
    mode: "file (raw.githubusercontent.com)",
    usage: s2.resultJson?.usage ?? null,
    settledPeakMicrousd: s2.resRow?.actual_microusd ?? null,
    estimatedOffPeakMicrousd: computeCatalogMicrousd(s2.resultJson?.usage, OFFPEAK_CATALOG),
  });
  suite.check(
    "real-hermes-and-piper-single-file-observe",
    d1.status === 0 &&
      d2.status === 0 &&
      s1.task?.state === "SUCCEEDED" &&
      s2.task?.state === "SUCCEEDED" &&
      s1.resRow?.state === "SETTLED" &&
      s2.resRow?.state === "SETTLED" &&
      (s1.resultJson?.reply ?? "").length > 20 &&
      (s2.resultJson?.reply ?? "").length > 20,
    scrub(
      `hermes=${s1.resRow?.actual_microusd}u$(in=${s1.resultJson?.usage?.inputTokens},out=${s1.resultJson?.usage?.outputTokens}) piper=${s2.resRow?.actual_microusd}u$(in=${s2.resultJson?.usage?.inputTokens},out=${s2.resultJson?.usage?.outputTokens})`,
    ),
  );
}

// 6. Live GitHub fail-closed controls: unallowlisted 302 redirect + 182 MB repo archive size cap
{
  const wsRedir = makeWorkspace("p42-real-redir-block");
  const cfgRedir = writeRealConfig(wsRedir, { allowedHosts: ["github.com"] });
  const tRedir = enqueueObserveTask(wsRedir, {
    eventId: "real-redir-block",
    targetId: "hono-no-redirect",
    question: "Must never execute agent.",
    initDb: true,
  });
  const dRedir = runDaemonOnceReal(wsRedir, cfgRedir);
  const sRedir = readTaskSummary(wsRedir, tRedir);

  const wsBig = makeWorkspace("p42-real-hermes-oversize");
  const cfgBig = writeRealConfig(wsBig);
  const tBig = enqueueObserveTask(wsBig, {
    eventId: "real-hermes-oversize",
    targetId: "hermes-oversize-tar",
    question: "Must die at 2 MiB size cap inside acquisition.",
    initDb: true,
  });
  const dBig = runDaemonOnceReal(wsBig, cfgBig);
  const sBig = readTaskSummary(wsBig, tBig);

  suite.check(
    "real-failclosed-redirect-and-oversize-tar-stop-before-model",
    dRedir.status === 0 &&
      sRedir.task?.state === "FAILED" &&
      sRedir.task?.error_code === "acquisition_failed" &&
      sRedir.req === undefined &&
      dBig.status === 0 &&
      sBig.task?.state === "FAILED" &&
      sBig.task?.error_code === "acquisition_failed" &&
      sBig.req === undefined &&
      sRedir.leftContainers === "" &&
      sBig.leftContainers === "",
    `redir=${sRedir.task?.state}/${sRedir.task?.error_code}(req=${sRedir.req ?? "none"}) hermesBig=${sBig.task?.state}/${sBig.task?.error_code}(req=${sBig.req ?? "none"})`,
  );
}

// 7. Live HELD stop condition when output price is null on real DeepSeek response
{
  const ws = makeWorkspace("p42-real-held-stop");
  const cfgPath = writeRealConfig(ws, {
    maxOutputTokens: 512,
    priceCatalog: {
      inputPerMTokMicrousd: 300000,
      outputPerMTokMicrousd: null,
      cacheReadPerMTokMicrousd: 6000,
      cacheWritePerMTokMicrousd: null,
    },
  });
  const taskId = enqueueObserveTask(ws, {
    eventId: "real-held",
    targetId: "openpi",
    question: "Reply in one short sentence identifying openpi.",
    initDb: true,
  });
  const d = runDaemonOnceReal(ws, cfgPath);
  const s = readTaskSummary(ws, taskId);
  runTelemetry.push({
    case: "real-held-stop-openpi",
    repo: "NorthAdb/openpi@6c43f927",
    mode: "tar (null output rate)",
    usage: s.resultJson?.usage ?? null,
    settledPeakMicrousd: null,
    reservationState: s.resRow?.state ?? null,
  });
  suite.check(
    "real-missing-price-keeps-held-and-stops-observe-task",
    d.status === 0 &&
      s.req?.state === "HELD" &&
      s.resRow?.state === "HELD" &&
      s.task?.state === "FAILED" &&
      s.task?.error_code === "settlement_held_uncompleted" &&
      s.heldAudit === 1 &&
      s.leftContainers === "",
    `req=${s.req?.state} res=${s.resRow?.state} task=${s.task?.state}/${s.task?.error_code} heldAudit=${s.heldAudit}`,
  );
}

// 8. Committed defaults.json stayed 100% fail-closed and zero API key leaked into telemetry
{
  const rawDefaults = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
  const serialized = JSON.stringify(runTelemetry);
  suite.check(
    "defaults-untouched-fail-closed-and-zero-key-leakage",
    rawDefaults.model.baseUrl === null &&
      rawDefaults.model.allowRealModelCalls === false &&
      rawDefaults.model.maxInputBytes === null &&
      rawDefaults.model.maxOutputTokens === null &&
      rawDefaults.model.priceCatalog.inputPerMTokMicrousd === null &&
      rawDefaults.model.priceCatalog.outputPerMTokMicrousd === null &&
      rawDefaults.acquisition.allowRealRepoFetch === false &&
      Object.keys(rawDefaults.acquisition.targets ?? {}).length === 0 &&
      !serialized.includes(apiKey),
    `defaultsClosed=true telemetryLeak=${serialized.includes(apiKey)}`,
  );
}

writeReport({
  suiteId: "repo-observe-real",
  suite,
  label: "phase4:repo-observe-real — Phase 4.2 许可 2 广度真实仓库 Observe 与 DeepSeek 实测验收",
  extra: {
    dataSources:
      "真实公网 GitHub 目标（NorthAdb/AegisPi、honojs/hono、NorthAdb/pi-agent-north、NorthAdb/openpi、NorthAdb/hermes-agent、NorthAdb/Piper）经 Epoch 6 acquisition 容器拉取 + 真实 https://api.deepseek.com（deepseek-flash, reasoning:high）+ 本地 .env 临时读取（不入库、defaults.json 保持失败关闭）",
    telemetry: runTelemetry,
  },
});
process.exit(suiteExit(suite, { label: "phase4:repo-observe-real" }));
