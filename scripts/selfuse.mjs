import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadDaemonConfig } from "../apps/daemon/src/config.mjs";
import { openDatabase } from "../apps/daemon/src/db/connect.mjs";
import { ensureModelRequestsTable, loadCanonicalSchema, migrate } from "../apps/daemon/src/db/migrate.mjs";
import {
  ensureLocalConfigFile,
  readDotEnvFile,
  syncSelfUseDatabase,
  synthesizeEnvVars,
} from "../apps/daemon/src/selfuse-bootstrap.mjs";
import { APP_IMAGES, ImageGateError, imageRef, parseAppImageDigests } from "../evals/phase3/lib/image-gate.mjs";

const LOCKED_NODE = "v22.23.5";
if (process.version !== LOCKED_NODE) {
  console.error(
    `selfuse: refusing to run on Node ${process.version}; locked Node is ${LOCKED_NODE} (use D:\\AegisPi\\tools\\node-v22.23.5\\node.exe).`,
  );
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");
const DAEMON_ENTRY = join(REPO_ROOT, "apps", "daemon", "src", "daemon.mjs");
const EXAMPLE_CONFIG_PATH = join(REPO_ROOT, "apps", "daemon", "config", "selfuse.example.json");
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function usage() {
  return [
    "Usage:",
    "  D:\\AegisPi\\tools\\node-v22.23.5\\node.exe scripts/selfuse.mjs <init|check|start> [--config=selfuse.local.json] [--data-dir=workspace-state] [--env-file=.env] [--port=4310] [--briefing-time=HH:MM] [--dry-run]",
  ].join("\n");
}

function parseCliArgs(argv) {
  const positionals = [];
  let configPath = resolve(REPO_ROOT, "selfuse.local.json");
  let configExplicit = false;
  let dataDir = resolve(REPO_ROOT, "workspace-state");
  let envFilePath = resolve(REPO_ROOT, ".env");
  let port = 4310;
  let briefingTime = null;
  let dryRun = false;

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    const eq = arg.indexOf("=");
    if (eq === -1) {
      throw new Error(`unknown or missing-value flag: ${arg}`);
    }
    const key = arg.slice(0, eq);
    const val = arg.slice(eq + 1);
    if (key === "--config") {
      if (!val) throw new Error("--config requires a non-empty path");
      configPath = resolve(process.cwd(), val);
      configExplicit = true;
    } else if (key === "--data-dir") {
      if (!val) throw new Error("--data-dir requires a non-empty path");
      dataDir = resolve(process.cwd(), val);
    } else if (key === "--env-file") {
      if (!val) throw new Error("--env-file requires a non-empty path");
      envFilePath = resolve(process.cwd(), val);
    } else if (key === "--port") {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`--port must be an integer 1..65535, got ${JSON.stringify(val)}`);
      }
      port = n;
    } else if (key === "--briefing-time") {
      if (!HHMM_RE.test(val)) {
        throw new Error(`--briefing-time must be HH:MM (24h), got ${JSON.stringify(val)}`);
      }
      briefingTime = val;
    } else {
      throw new Error(`unknown flag: ${key}`);
    }
  }

  const command = positionals[0] ?? null;
  if (!command || !["init", "check", "start"].includes(command) || positionals.length !== 1) {
    throw new Error("first argument must be one of: init, check, start");
  }
  return { command, configPath, configExplicit, dataDir, envFilePath, port, briefingTime, dryRun };
}

function hasEnvKey(env, key) {
  return typeof env[key] === "string" && env[key].trim().length > 0;
}

function loadValidatedConfig(configPath) {
  try {
    return loadDaemonConfig({ path: configPath });
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new Error(`config invalid (${configPath}): ${err.message}`);
    }
    throw err;
  }
}

function loadRuntimeEnv(envFilePath) {
  const exists = existsSync(envFilePath);
  const dotEnvVars = readDotEnvFile(envFilePath);
  const runtimeEnv = synthesizeEnvVars({ ...process.env, ...dotEnvVars });
  return { exists, runtimeEnv };
}

function runInit({ configPath, configExplicit, dataDir, envFilePath, briefingTime }) {
  if (!configExplicit) {
    const ensured = ensureLocalConfigFile({ configPath, examplePath: EXAMPLE_CONFIG_PATH });
    if (ensured.created) {
      console.log(`init: created default config ${configPath} from ${EXAMPLE_CONFIG_PATH}`);
    }
  }
  const config = loadValidatedConfig(configPath);
  const { runtimeEnv } = loadRuntimeEnv(envFilePath);

  mkdirSync(join(dataDir, "db"), { recursive: true });
  const dbPath = join(dataDir, "db", "aegis.db");
  const db = openDatabase(dbPath);
  try {
    migrate(db, loadCanonicalSchema());
    ensureModelRequestsTable(db);
    const summary = syncSelfUseDatabase(db, {
      config,
      dataDir,
      envMap: runtimeEnv,
      briefingTime,
    });
    return { config, runtimeEnv, summary: { dbPath, ...summary } };
  } finally {
    db.close();
  }
}

async function runCheck({ configPath, dataDir, envFilePath, port }) {
  if (!existsSync(configPath)) {
    throw new Error(`config file not found (${configPath})`);
  }
  const config = loadValidatedConfig(configPath);
  const { exists: envExists, runtimeEnv } = loadRuntimeEnv(envFilePath);
  let ok = true;

  console.log(`check: config OK (${configPath})`);
  console.log(
    `check: flags allowRealModelCalls=${config.model.allowRealModelCalls} allowRealExternalWrites=${config.policy.allowRealExternalWrites} tgPull=${config.telegram.allowRealPull} tgSend=${config.telegram.allowRealSend} mailRead=${config.mail.allowRealMailRead} mailSend=${config.mail.allowRealMailSend} caldav=${config.calendar.caldavUrl !== null}`,
  );

  const requiredKeys = [];
  if (config.model.baseUrl !== null && config.model.allowRealModelCalls) {
    requiredKeys.push("DEEPSEEK_API_KEY");
  }
  if (config.telegram.apiBase !== null && (config.telegram.allowRealPull || config.telegram.allowRealSend)) {
    requiredKeys.push("TELEGRAM_BOT_TOKEN");
  }
  if (
    (config.mail.imapHost !== null || config.mail.smtpHost !== null) &&
    (config.mail.allowRealMailRead || config.mail.allowRealMailSend)
  ) {
    requiredKeys.push("AEGISPI_MAIL_CREDENTIAL");
  }
  const trackedKeys = [
    "DEEPSEEK_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_OWNER_USER_ID",
    "MAIL_USER",
    "MAIL_APP_PASSWORD",
    "AEGISPI_MAIL_CREDENTIAL",
    "AEGISPI_BACKUP_MANIFEST_KEY",
    "AEGISPI_REAL_TG_PROXY",
  ];
  console.log(`check: envFile=${envExists ? "present" : "missing"} (${envFilePath})`);
  for (const key of trackedKeys) {
    const present = hasEnvKey(runtimeEnv, key);
    const reqMark = requiredKeys.includes(key) ? "required" : "optional";
    console.log(`check: env ${key}=${present ? "present" : "missing"} (${reqMark})`);
    if (requiredKeys.includes(key) && !present) ok = false;
  }

  try {
    const gate = await parseAppImageDigests();
    console.log(`check: image-gate OK (registry=${gate.registry}, images=${APP_IMAGES.join(",")})`);
  } catch (err) {
    ok = false;
    const detail = err instanceof ImageGateError ? err.message : String(err?.message ?? err);
    console.error(`check: image-gate FAIL: ${detail}`);
    console.error(
      "check: hint: if apps/daemon/src or apps/daemon/config changed, run D:\\AegisPi\\tools\\node-v22.23.5\\node.exe tools/build-app-images.mjs --only=agent",
    );
  }

  const daemonCheck = spawnSync(
    process.execPath,
    [DAEMON_ENTRY, "--check", `--data-dir=${dataDir}`, `--config=${configPath}`, `--port=${port}`],
    {
      encoding: "utf8",
      env: {
        ...runtimeEnv,
        AEGISPI_CONFIG_PATH: configPath,
        AEGISPI_ENV_FILE: envFilePath,
      },
    },
  );
  if (daemonCheck.stdout) process.stdout.write(daemonCheck.stdout);
  if (daemonCheck.stderr) process.stderr.write(daemonCheck.stderr);
  if (daemonCheck.status !== 0) {
    ok = false;
    console.error(`check: daemon --check exited with status ${daemonCheck.status}`);
  }

  return ok ? 0 : 1;
}

async function runStart({ configPath, configExplicit, dataDir, envFilePath, port, briefingTime, dryRun }) {
  const { runtimeEnv, summary } = runInit({ configPath, configExplicit, dataDir, envFilePath, briefingTime });
  console.log(
    `init: db=${summary.dbPath} slots=${summary.slots.map((s) => `${s.slot}->${s.envName}`).join(",") || "none"} scopes=${summary.scopes.length} grantsAdded=${summary.grantsAdded}`,
  );
  if (summary.briefingTimer) {
    console.log(
      `init: briefingTimer=${summary.briefingTimer.id} created=${summary.briefingTimer.created} dueAt=${summary.briefingTimer.dueAt}`,
    );
  }

  let gate;
  try {
    gate = await parseAppImageDigests();
  } catch (err) {
    const detail = err instanceof ImageGateError ? err.message : String(err?.message ?? err);
    console.error(`start: image-gate REFUSED: ${detail}`);
    console.error(
      "start: rebuild the agent image if needed: D:\\AegisPi\\tools\\node-v22.23.5\\node.exe tools/build-app-images.mjs --only=agent",
    );
    return 2;
  }

  const agentImage = imageRef("agent", gate.digests);
  const executionImage = imageRef("execution", gate.digests);
  const acquisitionImage = imageRef("acquisition", gate.digests);
  const consoleUrl = `http://127.0.0.1:${port}/`;
  const tokenPath = join(dataDir, "console", "token");

  console.log(`console: ${consoleUrl}`);
  console.log(`console-token-path: ${tokenPath}`);

  const daemonArgs = [
    DAEMON_ENTRY,
    `--data-dir=${dataDir}`,
    `--config=${configPath}`,
    `--port=${port}`,
    `--agent-image=${agentImage}`,
    `--execution-image=${executionImage}`,
    `--acquisition-image=${acquisitionImage}`,
  ];

  if (dryRun) {
    console.log(`dry-run: ${process.execPath} ${daemonArgs.join(" ")}`);
    return 0;
  }

  const child = spawn(process.execPath, daemonArgs, {
    stdio: "inherit",
    env: {
      ...runtimeEnv,
      AEGISPI_CONFIG_PATH: configPath,
      AEGISPI_ENV_FILE: envFilePath,
    },
  });

  const forwardSignal = (sig) => {
    if (!child.killed) {
      child.kill(sig);
    }
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  return await new Promise((resolvePromise) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        resolvePromise(1);
      } else {
        resolvePromise(code ?? 0);
      }
    });
    child.on("error", (err) => {
      console.error(`start: failed to spawn daemon: ${err.message}`);
      resolvePromise(1);
    });
  });
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`selfuse: ${err.message}`);
    console.error(usage());
    process.exit(2);
  }

  try {
    if (opts.command === "init") {
      const { summary } = runInit(opts);
      console.log(
        `init: ok db=${summary.dbPath} slots=${summary.slots.map((s) => `${s.slot}->${s.envName}`).join(",") || "none"} scopes=${summary.scopes.length} grantsAdded=${summary.grantsAdded}`,
      );
      if (summary.briefingTimer) {
        console.log(
          `init: briefingTimer=${summary.briefingTimer.id} created=${summary.briefingTimer.created} dueAt=${summary.briefingTimer.dueAt}`,
        );
      }
      process.exit(0);
    }
    if (opts.command === "check") {
      const code = await runCheck(opts);
      process.exit(code);
    }
    if (opts.command === "start") {
      const code = await runStart(opts);
      process.exit(code);
    }
  } catch (err) {
    console.error(`selfuse: ${err.message}`);
    process.exit(1);
  }
}

main();
