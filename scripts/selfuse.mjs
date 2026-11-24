import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grantPermission } from "../apps/daemon/src/acl.mjs";
import { ConfigError, loadDaemonConfig } from "../apps/daemon/src/config.mjs";
import { createCredentialService } from "../apps/daemon/src/credentials.mjs";
import { openDatabase } from "../apps/daemon/src/db/connect.mjs";
import { ensureModelRequestsTable, loadCanonicalSchema, migrate } from "../apps/daemon/src/db/migrate.mjs";
import { withTx } from "../apps/daemon/src/db/tx.mjs";
import {
  ensurePrincipal,
  ensureScope,
  kindForDomainKey,
  scopeId as scopeIdForDomainKey,
} from "../apps/daemon/src/ingress.mjs";
import { insertObjectRow, putObjectContent } from "../apps/daemon/src/objects.mjs";
import { nextWallClockOccurrence } from "../apps/daemon/src/quiet-time.mjs";
import { parseTelegramTargetResource } from "../apps/daemon/src/telegram-send.mjs";
import { createTimer, timerIdFor, timerRow } from "../apps/daemon/src/timers.mjs";
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
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CHAT_ID_RE = /^-?\d+$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

function usage() {
  return [
    "Usage:",
    "  D:\\AegisPi\\tools\\node-v22.23.5\\node.exe scripts/selfuse.mjs <init|check|start> --config=<path> [--data-dir=workspace-state] [--env-file=.env] [--port=4310] [--briefing-time=HH:MM] [--dry-run]",
  ].join("\n");
}

function parseCliArgs(argv) {
  const positionals = [];
  let configPath = null;
  let dataDir = resolve(process.cwd(), "workspace-state");
  let envFilePath = resolve(process.cwd(), ".env");
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
  if (!configPath) {
    throw new Error("--config=<path> is required");
  }
  return { command, configPath, dataDir, envFilePath, port, briefingTime, dryRun };
}

export function parseDotEnvFile(envFilePath) {
  if (!existsSync(envFilePath)) {
    return { exists: false, vars: {} };
  }
  const text = readFileSync(envFilePath, "utf8");
  const vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const name = match[1];
    let val = match[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    vars[name] = val;
  }
  return { exists: true, vars };
}

function buildRuntimeEnv(dotEnvVars) {
  const env = { ...process.env, ...dotEnvVars };
  const mailUser = String(env.MAIL_USER ?? "").trim().toLowerCase();
  const mailPass = typeof env.MAIL_APP_PASSWORD === "string" ? env.MAIL_APP_PASSWORD : "";
  if (!env.AEGISPI_MAIL_CREDENTIAL && mailUser.length > 0 && mailPass.length > 0) {
    env.AEGISPI_MAIL_CREDENTIAL = `${mailUser}:${mailPass}`;
  }
  return env;
}

function hasEnvKey(env, key) {
  return typeof env[key] === "string" && env[key].trim().length > 0;
}

function ensureCredentialSlot(creds, { slot, purpose, source, envName, actorId, now }) {
  const existing = creds.slotRow(slot);
  if (
    existing &&
    existing.revoked_at === null &&
    existing.purpose === purpose &&
    existing.source === source &&
    existing.env_name === envName
  ) {
    return { slot, envName, created: false };
  }
  creds.registerSlot({ slot, purpose, source, envName, actorId, now });
  return { slot, envName, created: true };
}

function ensureLiveGrant(db, { scopeId, principalId, permission, now, actorId }) {
  const existing = db
    .prepare(
      `SELECT 1 FROM acl_grants
       WHERE scope_id=? AND principal_id=? AND permission=?
         AND revoked_at IS NULL AND expires_at IS NULL
       LIMIT 1`,
    )
    .get(scopeId, principalId, permission);
  if (existing) return false;
  grantPermission(db, { scopeId, principalId, permission, now, actorId });
  return true;
}

function resolveBriefingDomainKey(config) {
  const ownerDest = config.telegram?.ownerDestination ?? null;
  if (ownerDest) {
    if (ownerDest.startsWith("dm:telegram:") || ownerDest.startsWith("group:telegram:")) {
      return ownerDest;
    }
    const chatId = parseTelegramTargetResource(ownerDest);
    if (chatId) {
      return chatId.startsWith("-") ? `group:telegram:${chatId}` : `dm:telegram:${chatId}`;
    }
  }
  for (const chatId of config.telegram?.allowedChatIds ?? []) {
    if (CHAT_ID_RE.test(chatId) && !chatId.startsWith("-")) {
      return `dm:telegram:${chatId}`;
    }
  }
  return null;
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

function runInit({ configPath, dataDir, envFilePath, briefingTime }) {
  const config = loadValidatedConfig(configPath);
  const dotEnv = parseDotEnvFile(envFilePath);
  const runtimeEnv = buildRuntimeEnv(dotEnv.vars);

  for (const id of config.telegram.allowedChatIds) {
    if (!CHAT_ID_RE.test(id)) {
      throw new Error(
        `telegram.allowedChatIds contains non-numeric entry ${JSON.stringify(id)}; replace placeholders with numeric chat IDs first`,
      );
    }
  }

  mkdirSync(join(dataDir, "db"), { recursive: true });
  const dbPath = join(dataDir, "db", "aegis.db");
  const db = openDatabase(dbPath);
  const now = Date.now();
  const summary = {
    dbPath,
    slots: [],
    scopes: [],
    grantsAdded: 0,
    briefingTimer: null,
  };

  try {
    migrate(db, loadCanonicalSchema());
    ensureModelRequestsTable(db);

    const creds = createCredentialService(db);
    const ownerRef = withTx(db, () => ensurePrincipal(db, { platform: "local", subject: "owner" }));

    if (config.model.baseUrl !== null || hasEnvKey(runtimeEnv, "DEEPSEEK_API_KEY")) {
      summary.slots.push(
        ensureCredentialSlot(creds, {
          slot: "model",
          purpose: "model",
          source: config.model.provider ?? "deepseek",
          envName: "DEEPSEEK_API_KEY",
          actorId: ownerRef.id,
          now,
        }),
      );
    }
    if (
      config.telegram.apiBase !== null ||
      config.telegram.allowedChatIds.length > 0 ||
      hasEnvKey(runtimeEnv, "TELEGRAM_BOT_TOKEN")
    ) {
      summary.slots.push(
        ensureCredentialSlot(creds, {
          slot: "im",
          purpose: "im",
          source: "telegram",
          envName: "TELEGRAM_BOT_TOKEN",
          actorId: ownerRef.id,
          now,
        }),
      );
    }
    if (
      config.mail.imapHost !== null ||
      config.mail.smtpHost !== null ||
      hasEnvKey(runtimeEnv, "AEGISPI_MAIL_CREDENTIAL")
    ) {
      summary.slots.push(
        ensureCredentialSlot(creds, {
          slot: "mail",
          purpose: "mail",
          source: "imap-smtp",
          envName: "AEGISPI_MAIL_CREDENTIAL",
          actorId: ownerRef.id,
          now,
        }),
      );
    }

    const grantAll = (scopeId, principalId, permissions) => {
      for (const permission of permissions) {
        if (ensureLiveGrant(db, { scopeId, principalId, permission, now, actorId: ownerRef.id })) {
          summary.grantsAdded += 1;
        }
      }
    };

    const webScopeRef = withTx(db, () =>
      ensureScope(db, {
        ownerId: ownerRef.id,
        kind: "owner_dm",
        domainKey: "dm:local:owner",
        channel: "console",
        conversationId: "owner",
        policyVersion: "pv1",
      }),
    );
    summary.scopes.push(webScopeRef.id);
    grantAll(webScopeRef.id, ownerRef.id, ["read", "request", "approve", "admin"]);

    const tgOwnerIdRaw = typeof runtimeEnv.TELEGRAM_OWNER_USER_ID === "string" ? runtimeEnv.TELEGRAM_OWNER_USER_ID.trim() : "";
    for (const chatId of config.telegram.allowedChatIds) {
      const isGroup = /^-\d+$/.test(chatId);
      const domainKey = isGroup ? `group:telegram:${chatId}` : `dm:telegram:${chatId}`;
      const kind = isGroup ? "group" : "owner_dm";
      const scopeRef = withTx(db, () =>
        ensureScope(db, {
          ownerId: ownerRef.id,
          kind,
          domainKey,
          channel: "telegram",
          conversationId: chatId,
          policyVersion: "pv1",
        }),
      );
      summary.scopes.push(scopeRef.id);
      grantAll(scopeRef.id, ownerRef.id, ["read", "request", "approve", "admin"]);
      if (!isGroup) {
        const tgPrincipal = withTx(db, () => ensurePrincipal(db, { platform: "telegram", subject: chatId }));
        grantAll(scopeRef.id, tgPrincipal.id, ["read", "request"]);
      } else if (/^\d+$/.test(tgOwnerIdRaw)) {
        const tgOwnerPrincipal = withTx(db, () => ensurePrincipal(db, { platform: "telegram", subject: tgOwnerIdRaw }));
        grantAll(scopeRef.id, tgOwnerPrincipal.id, ["read", "request"]);
      }
    }

    if (hasEnvKey(runtimeEnv, "MAIL_USER")) {
      const mailUser = runtimeEnv.MAIL_USER.trim().toLowerCase();
      if (!EMAIL_RE.test(mailUser)) {
        throw new Error("MAIL_USER in env must be a valid email address");
      }
      const mailDomain = `dm:mail:${mailUser}`;
      const mailScopeRef = withTx(db, () =>
        ensureScope(db, {
          ownerId: ownerRef.id,
          kind: "owner_dm",
          domainKey: mailDomain,
          channel: "mail",
          conversationId: mailUser,
          policyVersion: "pv1",
        }),
      );
      summary.scopes.push(mailScopeRef.id);
      grantAll(mailScopeRef.id, ownerRef.id, ["read", "request", "approve", "admin"]);
    }

    if (briefingTime !== null) {
      const briefingDomain = resolveBriefingDomainKey(config);
      if (!briefingDomain) {
        throw new Error(
          "--briefing-time requires a Telegram owner DM scope (set telegram.ownerDestination or a non-negative id in telegram.allowedChatIds)",
        );
      }
      const targetScopeId = scopeIdForDomainKey(briefingDomain);
      let scopeRow = db.prepare("SELECT id, epoch FROM scopes WHERE id=?").get(targetScopeId);
      if (!scopeRow) {
        const chatId = parseTelegramTargetResource(briefingDomain);
        const created = withTx(db, () =>
          ensureScope(db, {
            ownerId: ownerRef.id,
            kind: kindForDomainKey(briefingDomain),
            domainKey: briefingDomain,
            channel: "telegram",
            conversationId: chatId,
            policyVersion: "pv1",
          }),
        );
        grantAll(created.id, ownerRef.id, ["read", "request", "approve", "admin"]);
        scopeRow = db.prepare("SELECT id, epoch FROM scopes WHERE id=?").get(created.id);
      }
      const timerId = timerIdFor("selfuse-morning-briefing");
      const existingTimer = timerRow(db, timerId);
      if (existingTimer) {
        summary.briefingTimer = { id: timerId, created: false, state: existingTimer.state, dueAt: existingTimer.due_at };
      } else {
        const timeZone = config.calendar.defaultTimezone;
        const dueAt = nextWallClockOccurrence(now, { timeOfDay: briefingTime, timeZone, exactOk: false });
        const seedContent = JSON.stringify({
          kind: "morning_briefing_seed",
          timeOfDay: briefingTime,
          timeZone,
        });
        const stored = putObjectContent(dataDir, seedContent);
        const payloadObj = withTx(db, () =>
          insertObjectRow(db, {
            scopeId: scopeRow.id,
            kind: "event_payload",
            sourceUri: "selfuse://morning-briefing",
            sourceActor: ownerRef.id,
            contentHash: stored.contentHash,
            storageRef: stored.storageRef,
            observedAt: now,
            requiredScopeIds: [scopeRow.id],
          }),
        );
        createTimer(db, {
          id: timerId,
          scopeId: scopeRow.id,
          principalId: ownerRef.id,
          scopeEpoch: scopeRow.epoch,
          threadKey: "briefing",
          condition: { type: "morning_briefing" },
          dueAt,
          recurrence: { type: "daily_wall_clock", timeOfDay: briefingTime, timezone: timeZone },
          payloadObjectId: payloadObj.id,
          now,
        });
        summary.briefingTimer = { id: timerId, created: true, state: "SCHEDULED", dueAt };
      }
    }
  } finally {
    db.close();
  }

  return { config, runtimeEnv, summary };
}

async function runCheck({ configPath, dataDir, envFilePath, port }) {
  const config = loadValidatedConfig(configPath);
  const dotEnv = parseDotEnvFile(envFilePath);
  const runtimeEnv = buildRuntimeEnv(dotEnv.vars);
  let ok = true;

  console.log(`check: config OK (${configPath})`);
  console.log(
    `check: flags allowRealModelCalls=${config.model.allowRealModelCalls} allowRealExternalWrites=${config.policy.allowRealExternalWrites} tgPull=${config.telegram.allowRealPull} tgSend=${config.telegram.allowRealSend} mailRead=${config.mail.allowRealMailRead} mailSend=${config.mail.allowRealMailSend} caldav=${config.calendar.caldavUrl !== null}`,
  );

  const requiredKeys = [];
  if (config.model.baseUrl !== null) requiredKeys.push("DEEPSEEK_API_KEY");
  if (config.telegram.apiBase !== null && (config.telegram.allowRealPull || config.telegram.allowRealSend)) {
    requiredKeys.push("TELEGRAM_BOT_TOKEN");
  }
  if (config.mail.imapHost !== null || config.mail.smtpHost !== null) {
    requiredKeys.push("AEGISPI_MAIL_CREDENTIAL");
  }
  const trackedKeys = [
    "DEEPSEEK_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_OWNER_USER_ID",
    "MAIL_USER",
    "MAIL_APP_PASSWORD",
    "AEGISPI_MAIL_CREDENTIAL",
  ];
  console.log(`check: envFile=${dotEnv.exists ? "present" : "missing"} (${envFilePath})`);
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
    { encoding: "utf8", env: runtimeEnv },
  );
  if (daemonCheck.stdout) process.stdout.write(daemonCheck.stdout);
  if (daemonCheck.stderr) process.stderr.write(daemonCheck.stderr);
  if (daemonCheck.status !== 0) {
    ok = false;
    console.error(`check: daemon --check exited with status ${daemonCheck.status}`);
  }

  return ok ? 0 : 1;
}

async function runStart({ configPath, dataDir, envFilePath, port, briefingTime, dryRun }) {
  const { runtimeEnv, summary } = runInit({ configPath, dataDir, envFilePath, briefingTime });
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
    env: runtimeEnv,
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
