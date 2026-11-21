import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

if (process.env.AEGISPI_ALLOW_REAL_TRIAGE_ACCEPTANCE !== "1") {
  console.error("");
  console.error("=== phase4:triage-real — REFUSED (exit 4) ===");
  console.error(
    "Unit 4.5 真实 repo_triage 验收入口已锁定：必须显式设置 AEGISPI_ALLOW_REAL_TRIAGE_ACCEPTANCE=1 后才允许只读加载 .env、拉取公网 GitHub 仓库、调用真实模型与发送真实 @aegispibot Telegram 私聊。",
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
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch {}
  return undefined;
}

const apiKey = readEnv("DEEPSEEK_API_KEY");
const botToken = readEnv("TELEGRAM_BOT_TOKEN");
const ownerUserId = readEnv("TELEGRAM_OWNER_USER_ID");
if (!apiKey || !botToken || !ownerUserId) {
  console.error("");
  console.error("=== phase4:triage-real — NOT VERIFIED (exit 3) ===");
  console.error("DEEPSEEK_API_KEY / TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_USER_ID 之一未配置于本机 .env；真实 Triage 验收未执行。");
  console.error("");
  process.exit(3);
}
if (!/^-?\d+$/.test(ownerUserId)) {
  console.error("TELEGRAM_OWNER_USER_ID must be a numeric user id");
  process.exit(3);
}

const scrub = (s) => {
  let out = String(s ?? "");
  for (const [val, mask] of [
    [apiKey, "***"],
    [botToken, "[REDACTED_BOT_TOKEN]"],
    [ownerUserId, "[REDACTED_OWNER]"],
  ]) {
    if (val && val.length > 0) out = out.split(val).join(mask);
  }
  return out.replace(/\/bot[^/\s"']+/g, "/bot[REDACTED_BOT_TOKEN]");
};

const { digests } = await requireAppImageDigests();
const AGENT_REF = imageRef("agent", digests);
const ACQUISITION_REF = imageRef("acquisition", digests);
const EXECUTION_REF = imageRef("execution", digests);
const daemonPath = join(repoRoot, "apps", "daemon", "src", "daemon.mjs");
const ownerNotifyChannel = `dm:telegram:${ownerUserId}`;

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

const HONO_TS_CHECK_SCRIPT = [
  'import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";',
  'import { stripTypeScriptTypes } from "node:module";',
  'import { dirname, join, resolve } from "node:path";',
  'import { pathToFileURL } from "node:url";',
  "",
  "const [mode, rootDirName] = process.argv.slice(2);",
  'const srcRoot = join("/job/input/snapshot", rootDirName, "src");',
  'const workRoot = "/job/work/hono-compiled";',
  "",
  "function statIfFile(p) {",
  "  try { return statSync(p).isFile(); } catch { return false; }",
  "}",
  "function resolveTsRel(fromFile, spec) {",
  '  if (!spec.startsWith(".")) return spec;',
  "  const base = resolve(dirname(fromFile), spec);",
  '  if (statIfFile(base + ".ts")) return spec + ".mjs";',
  '  if (statIfFile(join(base, "index.ts"))) return spec.replace(/\\/?$/, "") + "/index.mjs";',
  '  if (spec.endsWith(".js") && statIfFile(base.replace(/\\.js$/, ".ts"))) return spec.replace(/\\.js$/, ".mjs");',
  '  if (statIfFile(base + ".js")) return spec + ".mjs";',
  "  return spec;",
  "}",
  "function compileTsTree(src, out) {",
  "  rmSync(out, { recursive: true, force: true });",
  "  function walk(dir, rel) {",
  "    for (const ent of readdirSync(dir, { withFileTypes: true })) {",
  "      const abs = join(dir, ent.name);",
  "      const childRel = rel ? `${rel}/${ent.name}` : ent.name;",
  "      if (ent.isDirectory()) {",
  "        walk(abs, childRel);",
  '      } else if (ent.isFile() && ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts") && !ent.name.endsWith(".test.ts")) {',
  '        const raw = readFileSync(abs, "utf8");',
  '        const js = stripTypeScriptTypes(raw, { mode: "transform" });',
  "        const rewritten = js.replace(",
  '          /((?:import|export)\\s+(?:[^"\']*?\\s+from\\s+)?|import\\s*\\(\\s*)(["\'])(\\.[^"\']+)\\2/g,',
  "          (_m, pre, q, spec) => `${pre}${q}${resolveTsRel(abs, spec)}${q}`,",
  "        );",
  '        const outFile = join(out, childRel.replace(/\\.ts$/, ".mjs"));',
  "        mkdirSync(dirname(outFile), { recursive: true });",
  '        writeFileSync(outFile, rewritten, "utf8");',
  "      }",
  "    }",
  "  }",
  "  walk(src, \"\");",
  "}",
  "",
  "try {",
  "  compileTsTree(srcRoot, workRoot);",
  '  const { Hono } = await import(pathToFileURL(join(workRoot, "index.mjs")).href);',
  '  if (mode === "csrf") {',
  '    const { csrf } = await import(pathToFileURL(join(workRoot, "middleware/csrf/index.mjs")).href);',
  "    const app = new Hono();",
  "    app.use(csrf());",
  '    app.post("/action", (c) => c.json({ ok: true }));',
  '    const res = await app.request("/action", {',
  '      method: "POST",',
  "      headers: {",
  '        origin: "https://attacker.example",',
  '        "content-type": "text/ping",',
  '        "sec-fetch-dest": "ping",',
  '        "sec-fetch-mode": "no-cors",',
  '        "sec-fetch-site": "cross-site",',
  "      },",
  "    });",
  '    console.log(JSON.stringify({ mode, rootDirName, status: res.status, rejected: res.status === 403 }));',
  "    process.exit(res.status === 403 ? 0 : 1);",
  '  } else if (mode === "cors") {',
  '    const { cors } = await import(pathToFileURL(join(workRoot, "middleware/cors/index.mjs")).href);',
  "    const app = new Hono();",
  '    app.use("/data", cors({ credentials: true }));',
  '    app.get("/data", (c) => c.json({ ok: true }));',
  '    const res = await app.request("/data", {',
  '      method: "GET",',
  '      headers: { origin: "https://attacker.example" },',
  "    });",
  '    const acao = res.headers.get("access-control-allow-origin") ?? "";',
  '    const acac = res.headers.get("access-control-allow-credentials") ?? "";',
  '    const reflected = acao.includes("attacker.example") && acac.toLowerCase() === "true";',
  '    console.log(JSON.stringify({ mode, rootDirName, status: res.status, acao, acac, reflected }));',
  "    process.exit(reflected ? 1 : 0);",
  "  } else {",
  '    console.error("unknown hono check mode: " + mode);',
  "    process.exit(2);",
  "  }",
  "} catch (e) {",
  "  console.error(JSON.stringify({ infra_error: String(e?.message ?? e) }));",
  "  process.exit(2);",
  "}",
].join("\n");

const AEGISPI_BASELINE_CHECK_SCRIPT = [
  'import { existsSync, readFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'const root = join("/job/input/snapshot", process.argv[2]);',
  "try {",
  '  const defaults = JSON.parse(readFileSync(join(root, "apps/daemon/config/defaults.json"), "utf8"));',
  '  const pkgDaemon = JSON.parse(readFileSync(join(root, "apps/daemon/package.json"), "utf8"));',
  '  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));',
  '  const honoLock = lock.packages?.["node_modules/hono"]?.version ?? null;',
  '  const piLock = lock.packages?.["node_modules/@earendil-works/pi-coding-agent"]?.version ?? null;',
  '  const legacyChildExists = existsSync(join(root, "apps/daemon/src/model-call-child.mjs"));',
  "  const ok =",
  "    defaults.budget?.taskMicroUsd === 800000 &&",
  "    defaults.budget?.dayMicroUsd === 5000000 &&",
  '    defaults.budget?.cacheWarming === "off" &&',
  "    defaults.model?.baseUrl === null &&",
  "    defaults.model?.allowRealModelCalls === false &&",
  "    defaults.model?.priceCatalog?.inputPerMTokMicrousd === null &&",
  "    defaults.model?.priceCatalog?.outputPerMTokMicrousd === null &&",
  "    defaults.policy?.allowRealExternalWrites === false &&",
  "    defaults.upstream?.submitUrl === null &&",
  "    Array.isArray(defaults.model?.allowedPurposes) && defaults.model.allowedPurposes.length === 0 &&",
  "    Array.isArray(defaults.model?.allowedModelIds) && defaults.model.allowedModelIds.length === 0 &&",
  "    (defaults.acquisition === undefined || defaults.acquisition.allowRealRepoFetch === false) &&",
  '    pkgDaemon.dependencies?.["@earendil-works/pi-coding-agent"] === "1.5.2" &&',
  '    honoLock === "4.13.19" &&',
  '    piLock === "1.5.2" &&',
  "    !legacyChildExists;",
  "  console.log(JSON.stringify({ ok, honoLock, piLock, legacyChildExists }));",
  "  process.exit(ok ? 0 : 1);",
  "} catch (e) {",
  "  console.error(JSON.stringify({ infra_error: String(e?.message ?? e) }));",
  "  process.exit(2);",
  "}",
].join("\n");

const PI_AGENT_BASELINE_CHECK_SCRIPT = [
  'import { existsSync, readFileSync } from "node:fs";',
  'import { stripTypeScriptTypes } from "node:module";',
  'import { join } from "node:path";',
  'const root = join("/job/input/snapshot", process.argv[2]);',
  "try {",
  '  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));',
  '  const aiPkg = JSON.parse(readFileSync(join(root, "packages/ai/package.json"), "utf8"));',
  '  const agentPkg = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8"));',
  '  const aiEntry = join(root, "packages/ai/src/index.ts");',
  '  const agentEntry = join(root, "packages/coding-agent/src/index.ts");',
  "  const aiJs = stripTypeScriptTypes(readFileSync(aiEntry, \"utf8\"), { mode: \"transform\" });",
  "  const agentJs = stripTypeScriptTypes(readFileSync(agentEntry, \"utf8\"), { mode: \"transform\" });",
  "  const ok =",
  "    Array.isArray(rootPkg.workspaces) &&",
  "    typeof aiPkg.name === \"string\" &&",
  "    typeof agentPkg.name === \"string\" &&",
  "    existsSync(join(root, \"package-lock.json\")) &&",
  "    aiJs.length > 50 &&",
  "    agentJs.length > 50;",
  "  console.log(JSON.stringify({ ok, aiPkg: aiPkg.name, agentPkg: agentPkg.name, aiLen: aiJs.length, agentLen: agentJs.length }));",
  "  process.exit(ok ? 0 : 1);",
  "} catch (e) {",
  "  console.error(JSON.stringify({ infra_error: String(e?.message ?? e) }));",
  "  process.exit(2);",
  "}",
].join("\n");

const HONO_413_SHA = "676c8f80fcafc49e6e74c847a8f0d9c44cc7faee";
const HONO_412_SHA = "5fdde5ab5a7d7c89eba4d1ceab76f4a7c011cd3b";
const AEGISPI_SHA = "8943a108df5fceb0a98a91771b23464e50c34dfb";
const PI_AGENT_SHA = "ce950d78f424dcaf9f5d6a03ce80ab141130eb1d";

const TARGETS = {
  "hono-4.13.19": {
    repo: "honojs/hono",
    url: `https://github.com/honojs/hono/archive/${HONO_413_SHA}.tar.gz`,
    ref: "v4.13.19",
    mode: "tar",
    allowedRedirectHosts: ["codeload.github.com"],
    readPaths: [
      `hono-${HONO_413_SHA}/src/middleware/csrf/index.ts`,
      `hono-${HONO_413_SHA}/src/middleware/cors/index.ts`,
      `hono-${HONO_413_SHA}/package.json`,
    ],
  },
  "hono-4.12.24": {
    repo: "honojs/hono",
    url: `https://github.com/honojs/hono/archive/${HONO_412_SHA}.tar.gz`,
    ref: "v4.12.24",
    mode: "tar",
    allowedRedirectHosts: ["codeload.github.com"],
    readPaths: [
      `hono-${HONO_412_SHA}/src/middleware/csrf/index.ts`,
      `hono-${HONO_412_SHA}/src/middleware/cors/index.ts`,
      `hono-${HONO_412_SHA}/package.json`,
    ],
  },
  "aegispi-origin": {
    repo: "NorthAdb/AegisPi",
    url: `https://github.com/NorthAdb/AegisPi/archive/${AEGISPI_SHA}.tar.gz`,
    ref: AEGISPI_SHA,
    mode: "tar",
    allowedRedirectHosts: ["codeload.github.com"],
    readPaths: [
      `AegisPi-${AEGISPI_SHA}/package.json`,
      `AegisPi-${AEGISPI_SHA}/apps/daemon/config/defaults.json`,
      `AegisPi-${AEGISPI_SHA}/apps/daemon/src/model-requests.mjs`,
    ],
  },
  "pi-agent-north": {
    repo: "NorthAdb/pi-agent-north",
    url: `https://github.com/NorthAdb/pi-agent-north/archive/${PI_AGENT_SHA}.tar.gz`,
    ref: PI_AGENT_SHA,
    mode: "tar",
    allowedRedirectHosts: ["codeload.github.com"],
    maxDownloadBytes: 33554432,
    readPaths: [
      `pi-agent-north-${PI_AGENT_SHA}/package.json`,
      `pi-agent-north-${PI_AGENT_SHA}/packages/ai/src/index.ts`,
      `pi-agent-north-${PI_AGENT_SHA}/packages/coding-agent/src/index.ts`,
    ],
  },
};

const honoCsrfOracle = JSON.parse(
  readFileSync(join(repoRoot, "evals", "contracts", "fixtures", "hono-triage", "oracle.hono-triage.json"), "utf8"),
);
const honoCorsOracle = JSON.parse(
  readFileSync(join(repoRoot, "evals", "contracts", "fixtures", "hono-triage", "oracle.hono-cors.json"), "utf8"),
);

const PRESETS = {
  "hono-ghsa-46wx-csrf": {
    baselineTargetId: "hono-4.13.19",
    targetTargetId: "hono-4.12.24",
    mode: "dependency_advisory",
    jobKind: "security_repro",
    baselineCommitSha: HONO_413_SHA,
    targetCommitSha: HONO_412_SHA,
    baselineCommand: { command: "node", args: ["/job/input/checks/hono-ts-check.mjs", "csrf", `hono-${HONO_413_SHA}`], deadlineMs: 60000 },
    targetCommand: { command: "node", args: ["/job/input/checks/hono-ts-check.mjs", "csrf", `hono-${HONO_412_SHA}`], deadlineMs: 60000 },
    baselineInputFiles: { "checks/hono-ts-check.mjs": HONO_TS_CHECK_SCRIPT },
    targetInputFiles: { "checks/hono-ts-check.mjs": HONO_TS_CHECK_SCRIPT },
    advisoryMeta: { advisoryId: "GHSA-46wx-v44x-9hh2", dependencyName: "hono", dependencyAffected: false },
    oracle: honoCsrfOracle,
    question: "基于实采的 Hono v4.13.19 与 v4.12.24 CSRF 中间件源码，用两句中文说明 v4.13.19 是否受 GHSA-46wx-v44x-9hh2 text/ping 绕过影响。",
  },
  "hono-ghsa-88fw-cors": {
    baselineTargetId: "hono-4.13.19",
    targetTargetId: "hono-4.12.24",
    mode: "dependency_advisory",
    jobKind: "security_repro",
    baselineCommitSha: HONO_413_SHA,
    targetCommitSha: HONO_412_SHA,
    baselineCommand: { command: "node", args: ["/job/input/checks/hono-ts-check.mjs", "cors", `hono-${HONO_413_SHA}`], deadlineMs: 60000 },
    targetCommand: { command: "node", args: ["/job/input/checks/hono-ts-check.mjs", "cors", `hono-${HONO_412_SHA}`], deadlineMs: 60000 },
    baselineInputFiles: { "checks/hono-ts-check.mjs": HONO_TS_CHECK_SCRIPT },
    targetInputFiles: { "checks/hono-ts-check.mjs": HONO_TS_CHECK_SCRIPT },
    advisoryMeta: { advisoryId: "GHSA-88fw-hqm2-52qc", dependencyName: "hono", dependencyAffected: false },
    oracle: honoCorsOracle,
    question: "基于实采的 Hono v4.13.19 与 v4.12.24 CORS 中间件源码，用两句中文说明 v4.13.19 是否存在默认通配源与 credentials 同开时的 Origin 反射缺陷。",
  },
  "hono-csrf-regression-affected": {
    baselineTargetId: "hono-4.13.19",
    targetTargetId: "hono-4.12.24",
    mode: "snapshot_regression",
    jobKind: "security_repro",
    baselineCommitSha: HONO_413_SHA,
    targetCommitSha: HONO_412_SHA,
    baselineCommand: { command: "node", args: ["/job/input/checks/hono-ts-check.mjs", "csrf", `hono-${HONO_413_SHA}`], deadlineMs: 60000 },
    targetCommand: { command: "node", args: ["/job/input/checks/hono-ts-check.mjs", "csrf", `hono-${HONO_412_SHA}`], deadlineMs: 60000 },
    baselineInputFiles: { "checks/hono-ts-check.mjs": HONO_TS_CHECK_SCRIPT },
    targetInputFiles: { "checks/hono-ts-check.mjs": HONO_TS_CHECK_SCRIPT },
    oracle: {
      schemaVersion: 1,
      oracleId: "oracles/hono-csrf-regression-v1",
      proposition: "Compare secure v4.13.19 baseline against target v4.12.24 snapshot for CSRF text/ping regression",
      assertions: [
        { id: "A1", kind: "baseline_passes", description: "Baseline 4.13.19 rejects text/ping with 403", expectedExitCode: 0, requiredOutputHash: null },
      ],
      resultClassRules: {
        affected: "Baseline passes and target reproduces CSRF text/ping bypass",
        unaffected: "Both snapshots pass",
        unknown: "Indeterminate exit",
        infra_error: "Baseline failed or infra error",
      },
    },
    question: "对比 Hono v4.13.19 基线与 v4.12.24 目标快照的 CSRF 校验差异，用一句话指出目标快照回归原因。",
  },
  "aegispi-baseline-check": {
    baselineTargetId: "aegispi-origin",
    targetTargetId: "aegispi-origin",
    mode: "snapshot_regression",
    jobKind: "self_check",
    baselineCommitSha: AEGISPI_SHA,
    targetCommitSha: AEGISPI_SHA,
    baselineCommand: { command: "node", args: ["/job/input/checks/aegispi-check.mjs", `AegisPi-${AEGISPI_SHA}`], deadlineMs: 45000 },
    targetCommand: { command: "node", args: ["/job/input/checks/aegispi-check.mjs", `AegisPi-${AEGISPI_SHA}`], deadlineMs: 45000 },
    baselineInputFiles: { "checks/aegispi-check.mjs": AEGISPI_BASELINE_CHECK_SCRIPT },
    targetInputFiles: { "checks/aegispi-check.mjs": AEGISPI_BASELINE_CHECK_SCRIPT },
    oracle: {
      schemaVersion: 1,
      oracleId: "oracles/aegispi-baseline-invariant-v1",
      proposition: "Verify AegisPi origin/main defaults fail-closed and dependency pin invariants",
      assertions: [
        { id: "A1", kind: "baseline_passes", description: "Defaults fail-closed and lockfile invariants hold", expectedExitCode: 0, requiredOutputHash: null },
      ],
      resultClassRules: {
        affected: "Regression in defaults fail-closed or dependency pins",
        unaffected: "All fail-closed and lockfile invariants hold",
        unknown: "Indeterminate check outcome",
        infra_error: "Infra or missing file failure",
      },
    },
    question: "基于只读采样的 AegisPi defaults.json 与 model-requests.mjs，用两句中文总结当前默认失败关闭策略状况。",
  },
  "pi-agent-north-baseline-check": {
    baselineTargetId: "pi-agent-north",
    targetTargetId: "pi-agent-north",
    mode: "snapshot_regression",
    jobKind: "config_verify",
    baselineCommitSha: PI_AGENT_SHA,
    targetCommitSha: PI_AGENT_SHA,
    stageSubpaths: [
      `pi-agent-north-${PI_AGENT_SHA}/package.json`,
      `pi-agent-north-${PI_AGENT_SHA}/package-lock.json`,
      `pi-agent-north-${PI_AGENT_SHA}/packages/ai/package.json`,
      `pi-agent-north-${PI_AGENT_SHA}/packages/ai/src`,
      `pi-agent-north-${PI_AGENT_SHA}/packages/coding-agent/package.json`,
      `pi-agent-north-${PI_AGENT_SHA}/packages/coding-agent/src`,
    ],
    baselineCommand: { command: "node", args: ["/job/input/checks/pi-agent-check.mjs", `pi-agent-north-${PI_AGENT_SHA}`], deadlineMs: 45000 },
    targetCommand: { command: "node", args: ["/job/input/checks/pi-agent-check.mjs", `pi-agent-north-${PI_AGENT_SHA}`], deadlineMs: 45000 },
    baselineInputFiles: { "checks/pi-agent-check.mjs": PI_AGENT_BASELINE_CHECK_SCRIPT },
    targetInputFiles: { "checks/pi-agent-check.mjs": PI_AGENT_BASELINE_CHECK_SCRIPT },
    oracle: {
      schemaVersion: 1,
      oracleId: "oracles/pi-agent-north-baseline-v1",
      proposition: "Verify pi-agent-north monorepo packages/ai and packages/coding-agent entrypoints parse cleanly",
      assertions: [
        { id: "A1", kind: "baseline_passes", description: "Workspace manifests and TS entrypoints valid", expectedExitCode: 0, requiredOutputHash: null },
      ],
      resultClassRules: {
        affected: "Entrypoint or workspace invariant broken",
        unaffected: "Baseline monorepo entrypoints and manifests hold",
        unknown: "Indeterminate check outcome",
        infra_error: "Acquisition or execution infra failure",
      },
    },
    question: "基于只读采样的 pi-agent-north 入口与 package.json，用两句中文概括 packages/ai 与 packages/coding-agent 的职责边界。",
  },
};

function writeRealTriageConfig(ws, { allowRealTriage = true, allowedRecipients = [ownerNotifyChannel] } = {}) {
  const defaults = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
  defaults.model = {
    ...defaults.model,
    baseUrl: "https://api.deepseek.com",
    allowedPurposes: ["worker"],
    allowedModelIds: ["deepseek/deepseek-flash"],
    allowRealModelCalls: true,
    callUpperMicrousd: 50000,
    callTimeoutMs: 120000,
    maxInputBytes: 49152,
    maxOutputTokens: 16384,
    priceCatalog: PEAK_CATALOG,
  };
  defaults.acquisition = {
    ...defaults.acquisition,
    allowRealRepoFetch: true,
    enableHostGateway: false,
    allowedHosts: ["github.com", "codeload.github.com", "raw.githubusercontent.com"],
    maxDownloadBytes: 33554432,
    maxExcerptBytes: 49152,
    timeoutMs: 120000,
    targets: TARGETS,
  };
  defaults.policy = { allowRealExternalWrites: true };
  defaults.credentials = { im: "im", mail: null, repo: null };
  defaults.adapters = { ...defaults.adapters, allowedRecipients };
  defaults.telegram = {
    apiBase: "https://api.telegram.org",
    allowRealSend: true,
    proxyUrl: null,
    timeoutMs: 20000,
  };
  defaults.triage = {
    allowRealTriage,
    allowModelObserve: true,
    presets: PRESETS,
  };
  const cfgPath = join(ws.stateDir, "real-triage-config.json");
  writeFileSync(cfgPath, JSON.stringify(defaults, null, 2), "utf8");
  return cfgPath;
}

function enqueueTriageTask(ws, { eventId, presetId } = {}) {
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  ensureModelRequestsTable(db);
  const creds = createCredentialService(db);
  creds.registerSlot({ slot: "model", purpose: "model", source: "deepseek", envName: "DEEPSEEK_API_KEY", actorId: "owner", now: Date.now() });
  creds.registerSlot({ slot: "im", purpose: "im", source: "telegram", envName: "TELEGRAM_BOT_TOKEN", actorId: "owner", now: Date.now() });
  const now = Date.now();
  const payload = { kind: "repo_triage", presetId, notifyChannel: ownerNotifyChannel };
  const ing = receiveEvent(db, ws.stateDir, {
    now,
    source: "telegram",
    sourceEventId: eventId,
    principal: { platform: "telegram", subject: ownerUserId },
    scope: { kind: "owner_dm", domainKey: ownerNotifyChannel, channel: "telegram", conversationId: ownerUserId },
    threadKey: `tr-${eventId}`,
    priority: 5,
    policyVersion: "pv1",
    payload: JSON.stringify(payload),
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
    skillSetHash: "ss-p45-real",
  });
  db.close();
  return disp.taskId;
}

function runDaemonOnceReal(ws, cfgPath) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        daemonPath,
        "--once",
        `--data-dir=${ws.stateDir}`,
        `--config=${cfgPath}`,
        `--agent-image=${AGENT_REF}`,
        `--acquisition-image=${ACQUISITION_REF}`,
        `--execution-image=${EXECUTION_REF}`,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, DEEPSEEK_API_KEY: apiKey, TELEGRAM_BOT_TOKEN: botToken },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 300000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function readTriageSummary(ws, taskId) {
  const db = openDatabase(ws.dbPath, { readOnly: true });
  const task = db.prepare("SELECT state, result_class, result_object_id FROM tasks WHERE id=?").get(taskId);
  const attempt = db.prepare("SELECT state, error_code FROM attempts WHERE task_id=? ORDER BY attempt_no DESC LIMIT 1").get(taskId);
  const mr = db.prepare("SELECT state, reservation_id, reply_object_id FROM model_requests WHERE task_id=?").get(taskId);
  const resRow = mr?.reservation_id
    ? db.prepare("SELECT state, actual_microusd FROM budget_reservations WHERE id=?").get(mr.reservation_id)
    : null;
  const replyObj = mr?.reply_object_id
    ? db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(mr.reply_object_id)
    : null;
  const reportObj = task?.result_object_id
    ? db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(task.result_object_id)
    : null;
  const edges = task?.result_object_id
    ? db.prepare("SELECT relation FROM object_edges WHERE child_id=?").all(task.result_object_id)
    : [];
  const jobs = db.prepare("SELECT id, state, exit_code FROM execution_jobs WHERE task_id=? ORDER BY created_at").all(taskId);
  const effect = db.prepare("SELECT state, external_id, last_error, action_json FROM effects WHERE task_id=?").get(taskId);
  let notifyContent = "";
  if (effect?.action_json) {
    try {
      const h = JSON.parse(effect.action_json)?.content_hash;
      if (typeof h === "string" && h.length >= 4) {
        const p = join(ws.stateDir, "objects", h.slice(0, 2), h.slice(2, 4), h);
        if (existsSync(p)) notifyContent = readFileSync(p, "utf8");
      }
    } catch {}
  }
  const frozenCount = db.prepare("SELECT count(*) c FROM budget_accounts WHERE frozen=1").get().c;
  const leftWorkDirs = existsSync(join(ws.stateDir, "acquisitions"))
    ? readdirSync(join(ws.stateDir, "acquisitions")).length
    : 0;
  const leftContainers = spawnSync(
    "docker",
    ["ps", "-aq", "--filter", `label=aegispi.state_dir=${ws.stateDir}`],
    { encoding: "utf8" },
  ).stdout.trim();
  db.close();

  const replyJson = replyObj?.storage_ref
    ? JSON.parse(readFileSync(join(ws.stateDir, ...replyObj.storage_ref.split("/")), "utf8"))
    : null;
  const reportJson = reportObj?.storage_ref
    ? JSON.parse(readFileSync(join(ws.stateDir, ...reportObj.storage_ref.split("/")), "utf8"))
    : null;
  return { task, attempt, mr, resRow, replyJson, reportJson, edges, jobs, effect, notifyContent, frozenCount, leftWorkDirs, leftContainers };
}

const suite = makeSuite("triage-real");
const runTelemetry = [];

const LIVE_CASES = [
  {
    name: "real-hono-ghsa-46wx-csrf-unaffected-ts-exec-and-dm",
    tag: "p45-real-hono-csrf",
    presetId: "hono-ghsa-46wx-csrf",
    expectedTaskState: "SUCCEEDED",
    expectedClass: "unaffected",
    expectedBaseExit: 0,
    expectedTargetExit: 1,
    expectedDmTag: "result=UNAFFECTED",
  },
  {
    name: "real-hono-ghsa-88fw-cors-unaffected-ts-exec-and-dm",
    tag: "p45-real-hono-cors",
    presetId: "hono-ghsa-88fw-cors",
    expectedTaskState: "SUCCEEDED",
    expectedClass: "unaffected",
    expectedBaseExit: 0,
    expectedTargetExit: 1,
    expectedDmTag: "result=UNAFFECTED",
  },
  {
    name: "real-hono-csrf-regression-affected-and-dm",
    tag: "p45-real-hono-reg",
    presetId: "hono-csrf-regression-affected",
    expectedTaskState: "SUCCEEDED",
    expectedClass: "affected",
    expectedBaseExit: 0,
    expectedTargetExit: 1,
    expectedDmTag: "result=AFFECTED",
  },
  {
    name: "real-aegispi-baseline-check-and-dm",
    tag: "p45-real-aegispi",
    presetId: "aegispi-baseline-check",
    expectedTaskState: "SUCCEEDED",
    expectedClass: "unaffected",
    expectedBaseExit: 0,
    expectedTargetExit: 0,
    expectedDmTag: "result=UNAFFECTED",
  },
  {
    name: "real-pi-agent-north-baseline-check-and-dm",
    tag: "p45-real-pi-agent",
    presetId: "pi-agent-north-baseline-check",
    expectedTaskState: "SUCCEEDED",
    expectedClass: "unaffected",
    expectedBaseExit: 0,
    expectedTargetExit: 0,
    expectedDmTag: "result=UNAFFECTED",
  },
];

for (const c of LIVE_CASES) {
  const ws = makeWorkspace(c.tag);
  const cfgPath = writeRealTriageConfig(ws);
  const taskId = enqueueTriageTask(ws, { eventId: c.tag, presetId: c.presetId });
  const d = await runDaemonOnceReal(ws, cfgPath);
  const s = readTriageSummary(ws, taskId);
  const usage = s.replyJson?.usage ?? null;
  const offPeak = computeCatalogMicrousd(usage, OFFPEAK_CATALOG);
  const extId = s.effect?.external_id ?? "";
  const dmSentOk = extId.startsWith(`tg:${ownerUserId}:`) && extId.length > `tg:${ownerUserId}:`.length;
  const allCredText = [d.stdout, d.stderr, JSON.stringify(s.reportJson), JSON.stringify(s.replyJson), s.effect?.last_error ?? "", s.notifyContent].join("\n");
  const ownerLogText = [d.stdout, d.stderr, JSON.stringify(s.replyJson), s.reportJson?.advisorySummary ?? "", s.effect?.last_error ?? "", s.notifyContent].join("\n");
  const zeroSecrets =
    !allCredText.includes(apiKey) &&
    !allCredText.includes(botToken) &&
    !ownerLogText.includes(ownerUserId);

  runTelemetry.push({
    case: c.presetId,
    repo: PRESETS[c.presetId].targetTargetId,
    resultClass: s.task?.result_class ?? null,
    jobs: s.jobs.map((j) => `${j.state}:${j.exit_code}`),
    usage,
    settledPeakMicrousd: s.resRow?.actual_microusd ?? null,
    estimatedOffPeakMicrousd: offPeak,
    effectState: s.effect?.state ?? null,
    externalIdMasked: scrub(extId),
    advisoryPreview: scrub((s.reportJson?.advisorySummary ?? "").slice(0, 200)),
  });

  suite.check(
    c.name,
    d.status === 0 &&
      s.task?.state === c.expectedTaskState &&
      s.task?.result_class === c.expectedClass &&
      s.mr?.state === "SETTLED" &&
      s.resRow?.state === "SETTLED" &&
      s.resRow?.actual_microusd > 0 &&
      s.jobs.length === 2 &&
      s.jobs[0].state === "SUCCEEDED" &&
      s.jobs[0].exit_code === c.expectedBaseExit &&
      s.jobs[1].exit_code === c.expectedTargetExit &&
      s.edges.length >= 4 &&
      s.effect?.state === "SUCCEEDED" &&
      dmSentOk &&
      s.notifyContent.includes(c.expectedDmTag) &&
      s.frozenCount === 0 &&
      s.leftWorkDirs === 0 &&
      s.leftContainers === "" &&
      zeroSecrets,
    scrub(
      `exit=${d.status} task=${s.task?.state}/${s.task?.result_class} cost=${s.resRow?.actual_microusd}u$(offPeak~${offPeak}u$) jobs=${s.jobs.map((j) => `${j.state}:${j.exit_code}`).join(",")} effect=${s.effect?.state}/${extId} edges=${s.edges.length} leakFree=${zeroSecrets}`,
    ),
  );
}

{
  const wsOff = makeWorkspace("p45-real-disabled");
  const cfgOff = writeRealTriageConfig(wsOff, { allowRealTriage: false });
  const tOff = enqueueTriageTask(wsOff, { eventId: "p45-off", presetId: "aegispi-baseline-check" });
  const dOff = await runDaemonOnceReal(wsOff, cfgOff);
  const sOff = readTriageSummary(wsOff, tOff);

  const wsBadRecv = makeWorkspace("p45-real-bad-notify");
  const cfgBadRecv = writeRealTriageConfig(wsBadRecv, { allowedRecipients: ["dm:telegram:999999999"] });
  const tBadRecv = enqueueTriageTask(wsBadRecv, { eventId: "p45-bad-notify", presetId: "aegispi-baseline-check" });
  const dBadRecv = await runDaemonOnceReal(wsBadRecv, cfgBadRecv);
  const sBadRecv = readTriageSummary(wsBadRecv, tBadRecv);

  const rawDefaults = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
  const defaultsClosed =
    rawDefaults.model?.baseUrl === null &&
    rawDefaults.model?.allowRealModelCalls === false &&
    rawDefaults.model?.priceCatalog?.inputPerMTokMicrousd === null &&
    rawDefaults.model?.priceCatalog?.outputPerMTokMicrousd === null &&
    rawDefaults.policy?.allowRealExternalWrites === false &&
    rawDefaults.telegram?.apiBase === null &&
    rawDefaults.telegram?.allowRealSend === false &&
    rawDefaults.telegram?.proxyUrl === null &&
    rawDefaults.acquisition?.allowRealRepoFetch === false &&
    rawDefaults.triage?.allowRealTriage === false &&
    Object.keys(rawDefaults.triage?.presets ?? {}).length === 0;
  const serialized = JSON.stringify(runTelemetry);
  const noTelemetryLeak = !serialized.includes(apiKey) && !serialized.includes(botToken) && !serialized.includes(ownerUserId);

  suite.check(
    "real-triage-fail-closed-controls-defaults-and-zero-leak",
    dOff.status === 0 &&
      sOff.task?.state === "FAILED" &&
      sOff.attempt?.error_code === "triage_real_disabled" &&
      sOff.jobs.length === 0 &&
      !sOff.mr &&
      !sOff.effect &&
      dBadRecv.status === 0 &&
      sBadRecv.task?.state === "FAILED" &&
      sBadRecv.attempt?.error_code === "triage_notify_target_not_allowed" &&
      sBadRecv.jobs.length === 0 &&
      !sBadRecv.mr &&
      !sBadRecv.effect &&
      defaultsClosed &&
      noTelemetryLeak,
    `triageOff=${sOff.attempt?.error_code} badNotify=${sBadRecv.attempt?.error_code} defaultsClosed=${defaultsClosed} telemetryLeakFree=${noTelemetryLeak}`,
  );
}

writeReport({
  suiteId: "triage-real",
  suite,
  label: "phase4:triage-real — Unit 4.5 真实 GitHub + DeepSeek + 执行容器 + @aegispibot 私聊端到端验收",
  extra: {
    dataSources:
      "真实公网 GitHub 目标（honojs/hono v4.13.19 vs v4.12.24、NorthAdb/AegisPi@8943a108、NorthAdb/pi-agent-north@ce950d78）+ 真实 https://api.deepseek.com（deepseek-flash, reasoning:high）+ 无网 --execution-image 执行真实 TypeScript 中间件与仓库检查 + 真实 @aegispibot TLS/CONNECT 私聊通知（.env 只读不入库、全链路脱敏、defaults.json 保持失败关闭）",
    telemetry: runTelemetry,
  },
});
process.exit(suiteExit(suite, { label: "phase4:triage-real" }));
