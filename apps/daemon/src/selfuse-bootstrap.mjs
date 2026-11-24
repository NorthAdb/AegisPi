import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { grantPermission } from "./acl.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { createCredentialService } from "./credentials.mjs";
import { withTx } from "./db/tx.mjs";
import {
  ensurePrincipal,
  ensureScope,
  kindForDomainKey,
  scopeId as scopeIdForDomainKey,
} from "./ingress.mjs";
import { insertObjectRow, putObjectContent } from "./objects.mjs";
import { nextWallClockOccurrence } from "./quiet-time.mjs";
import { parseTelegramTargetResource } from "./telegram-send.mjs";
import { createTimer, timerIdFor, timerRow } from "./timers.mjs";

export const ALLOWED_SECRET_KEYS = new Set([
  "DEEPSEEK_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "MAIL_USER",
  "MAIL_APP_PASSWORD",
  "AEGISPI_BACKUP_MANIFEST_KEY",
  "AEGISPI_REAL_TG_PROXY",
]);

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CHAT_ID_RE = /^-?\d+$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const OWNER_PERMISSIONS = ["read", "request", "approve", "admin"];

function atomicWriteFile(filePath, content, { mode = null } = {}) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
  try {
    writeFileSync(tmpPath, content, mode !== null ? { encoding: "utf8", mode } : { encoding: "utf8" });
    if (mode !== null) {
      try {
        chmodSync(tmpPath, mode);
      } catch {}
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

function unquoteDotEnvValue(rawVal) {
  const trimmed = rawVal.trim();
  if (trimmed.startsWith('"')) {
    const m = trimmed.match(/^"((?:[^"\\]|\\.)*)"(?:\s*#.*)?$/);
    if (m) return m[1].replace(/\\(["\\])/g, "$1");
  }
  if (trimmed.startsWith("'")) {
    const m = trimmed.match(/^'([^']*)'(?:\s*#.*)?$/);
    if (m) return m[1];
  }
  return trimmed;
}

function formatDotEnvValue(val) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(val)) return val;
  return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function parseDotEnvText(text) {
  const vars = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = rawLine.match(ENV_LINE_RE);
    if (!match) continue;
    vars[match[1]] = unquoteDotEnvValue(match[2]);
  }
  return vars;
}

export function readDotEnvFile(envFilePath) {
  if (!envFilePath || !existsSync(envFilePath)) return {};
  return parseDotEnvText(readFileSync(envFilePath, "utf8"));
}

function assertAllowedSecretKey(key) {
  if (typeof key !== "string" || !ALLOWED_SECRET_KEYS.has(key)) {
    throw new Error(`disallowed secret key: ${String(key)}`);
  }
}

export function upsertDotEnvKeys(envFilePath, { set = {}, clear = [] } = {}) {
  if (!set || typeof set !== "object" || Array.isArray(set)) {
    throw new Error("upsertDotEnvKeys: set must be a plain object");
  }
  if (!Array.isArray(clear)) {
    throw new Error("upsertDotEnvKeys: clear must be an array");
  }

  const updates = new Map();
  for (const [key, rawVal] of Object.entries(set)) {
    assertAllowedSecretKey(key);
    if (rawVal === undefined || rawVal === null || rawVal === "") continue;
    if (typeof rawVal !== "string") {
      throw new Error(`secret value for ${key} must be a string`);
    }
    if (/[\r\n\0]/.test(rawVal)) {
      throw new Error(`secret value for ${key} contains forbidden control characters`);
    }
    updates.set(key, rawVal);
  }

  const clearSet = new Set();
  for (const key of clear) {
    assertAllowedSecretKey(key);
    if (updates.has(key)) {
      throw new Error(`conflicting set and clear for secret key ${key}`);
    }
    clearSet.add(key);
  }

  const existingLines = existsSync(envFilePath)
    ? readFileSync(envFilePath, "utf8").split(/\r?\n/)
    : [];
  if (existingLines.length > 0 && existingLines[existingLines.length - 1] === "") {
    existingLines.pop();
  }

  const written = new Set();
  const nextLines = [];
  for (const line of existingLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      nextLines.push(line);
      continue;
    }
    const match = line.match(ENV_LINE_RE);
    if (!match) {
      nextLines.push(line);
      continue;
    }
    const key = match[1];
    if (clearSet.has(key)) continue;
    if (updates.has(key)) {
      if (!written.has(key)) {
        nextLines.push(`${key}=${formatDotEnvValue(updates.get(key))}`);
        written.add(key);
      }
      continue;
    }
    nextLines.push(line);
  }

  for (const [key, val] of updates.entries()) {
    if (!written.has(key)) {
      nextLines.push(`${key}=${formatDotEnvValue(val)}`);
    }
  }

  const output = nextLines.length > 0 ? `${nextLines.join("\n")}\n` : "";
  atomicWriteFile(envFilePath, output, { mode: 0o600 });
  return {
    envFilePath,
    updated: [...updates.keys()],
    cleared: [...clearSet],
  };
}

export function synthesizeEnvVars(envMap = {}, { target = null, refresh = false, explicitKeys = null } = {}) {
  const out = target ?? { ...envMap };
  const mailUser = typeof envMap.MAIL_USER === "string" ? envMap.MAIL_USER.trim().toLowerCase() : "";
  const mailPass = typeof envMap.MAIL_APP_PASSWORD === "string" ? envMap.MAIL_APP_PASSWORD : "";
  const hasExplicitMailCred = explicitKeys
    ? explicitKeys.has("AEGISPI_MAIL_CREDENTIAL")
    : typeof envMap.AEGISPI_MAIL_CREDENTIAL === "string" && envMap.AEGISPI_MAIL_CREDENTIAL.length > 0;

  if (mailUser.length > 0 && mailPass.length > 0) {
    if (!hasExplicitMailCred || refresh) {
      out.AEGISPI_MAIL_CREDENTIAL = JSON.stringify({ user: mailUser, password: mailPass });
    }
  } else if (refresh && !explicitKeys?.has("AEGISPI_MAIL_CREDENTIAL")) {
    delete out.AEGISPI_MAIL_CREDENTIAL;
  }
  return out;
}

export function ensureLocalConfigFile({ configPath, examplePath }) {
  if (existsSync(configPath)) {
    return { created: false, configPath };
  }
  if (!existsSync(examplePath)) {
    throw new Error(`example config not found at ${examplePath}`);
  }
  atomicWriteFile(configPath, readFileSync(examplePath, "utf8"));
  return { created: true, configPath };
}

function hasEnvKey(env, key) {
  return typeof env?.[key] === "string" && env[key].trim().length > 0;
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

function createBriefingPayloadObject(db, { dataDir, scopeId, ownerId, briefingTime, timeZone, now }) {
  const seedContent = JSON.stringify({
    kind: "morning_briefing_seed",
    timeOfDay: briefingTime,
    timeZone,
  });
  const stored = putObjectContent(dataDir, seedContent);
  return withTx(db, () =>
    insertObjectRow(db, {
      scopeId,
      kind: "event_payload",
      sourceUri: "selfuse://morning-briefing",
      sourceActor: ownerId,
      contentHash: stored.contentHash,
      storageRef: stored.storageRef,
      observedAt: now,
      requiredScopeIds: [scopeId],
    }),
  );
}

function syncBriefingTimer(db, { config, dataDir, ownerId, briefingTime, grantAll, now }) {
  if (briefingTime === null || briefingTime === undefined) return null;

  const timerId = timerIdFor("selfuse-morning-briefing");
  const existingTimer = timerRow(db, timerId);
  if (briefingTime === "") {
    if (!existingTimer || existingTimer.state !== "SCHEDULED") return null;
    withTx(db, () => {
      db.prepare("UPDATE timers SET state='CANCELLED' WHERE id=? AND state='SCHEDULED'").run(timerId);
      writeAudit(db, { code: "timer_cancelled", actorId: ownerId, details: { timer_id: timerId }, now });
      writeStreamEvent(db, {
        scopeId: existingTimer.scope_id,
        eventType: "timer_changed",
        entityId: `timer:${timerId}`,
        entityVersion: 2,
        payload: { state: "CANCELLED" },
        now,
      });
    });
    return { id: timerId, created: false, updated: true, state: "CANCELLED", dueAt: existingTimer.due_at };
  }

  if (!HHMM_RE.test(briefingTime)) {
    throw new Error(`briefingTime must be HH:MM (24h), got ${JSON.stringify(briefingTime)}`);
  }
  if (!dataDir) {
    throw new Error("syncSelfUseDatabase requires dataDir when briefingTime is set");
  }

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
        ownerId,
        kind: kindForDomainKey(briefingDomain),
        domainKey: briefingDomain,
        channel: "telegram",
        conversationId: chatId,
        policyVersion: "pv1",
      }),
    );
    grantAll(created.id, ownerId, OWNER_PERMISSIONS);
    scopeRow = db.prepare("SELECT id, epoch FROM scopes WHERE id=?").get(created.id);
  }

  const timeZone = config.calendar.defaultTimezone;
  if (existingTimer) {
    let existingRec = null;
    try {
      existingRec = existingTimer.recurrence_json ? JSON.parse(existingTimer.recurrence_json) : null;
    } catch {}
    if (
      existingTimer.state === "SCHEDULED" &&
      existingTimer.scope_id === scopeRow.id &&
      existingRec?.type === "daily_wall_clock" &&
      existingRec?.timeOfDay === briefingTime &&
      existingRec?.timezone === timeZone
    ) {
      return { id: timerId, created: false, updated: false, state: existingTimer.state, dueAt: existingTimer.due_at };
    }
  }

  const dueAt = nextWallClockOccurrence(now, { timeOfDay: briefingTime, timeZone, exactOk: false });
  const recurrence = { type: "daily_wall_clock", timeOfDay: briefingTime, timezone: timeZone };
  const payloadObj = createBriefingPayloadObject(db, {
    dataDir,
    scopeId: scopeRow.id,
    ownerId,
    briefingTime,
    timeZone,
    now,
  });

  if (existingTimer) {
    withTx(db, () => {
      db.prepare(
        `UPDATE timers
         SET scope_id=?, scope_epoch=?, due_at=?, recurrence_json=?, state='SCHEDULED', payload_object_id=?
         WHERE id=?`,
      ).run(scopeRow.id, scopeRow.epoch, dueAt, JSON.stringify(recurrence), payloadObj.id, timerId);
      writeAudit(db, {
        code: "timer_updated",
        actorId: ownerId,
        details: { timer_id: timerId, due_at: dueAt, recurrence },
        now,
      });
    });
    return { id: timerId, created: false, updated: true, state: "SCHEDULED", dueAt };
  }

  createTimer(db, {
    id: timerId,
    scopeId: scopeRow.id,
    principalId: ownerId,
    scopeEpoch: scopeRow.epoch,
    threadKey: "briefing",
    condition: { type: "morning_briefing" },
    dueAt,
    recurrence,
    payloadObjectId: payloadObj.id,
    now,
  });
  return { id: timerId, created: true, updated: false, state: "SCHEDULED", dueAt };
}

export function syncSelfUseDatabase(db, { config, dataDir = null, envMap = process.env, briefingTime = null, now = Date.now() }) {
  for (const id of config.telegram.allowedChatIds) {
    if (!CHAT_ID_RE.test(id)) {
      throw new Error(
        `telegram.allowedChatIds contains non-numeric entry ${JSON.stringify(id)}; replace placeholders with numeric chat IDs first`,
      );
    }
  }

  const summary = {
    slots: [],
    scopes: [],
    grantsAdded: 0,
    briefingTimer: null,
  };

  const creds = createCredentialService(db);
  const ownerRef = withTx(db, () => ensurePrincipal(db, { platform: "local", subject: "owner" }));

  if (config.model.baseUrl !== null || hasEnvKey(envMap, "DEEPSEEK_API_KEY")) {
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
    hasEnvKey(envMap, "TELEGRAM_BOT_TOKEN")
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
    hasEnvKey(envMap, "AEGISPI_MAIL_CREDENTIAL")
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
  grantAll(webScopeRef.id, ownerRef.id, OWNER_PERMISSIONS);

  const tgOwnerIdRaw = typeof envMap.TELEGRAM_OWNER_USER_ID === "string" ? envMap.TELEGRAM_OWNER_USER_ID.trim() : "";
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
    grantAll(scopeRef.id, ownerRef.id, OWNER_PERMISSIONS);
    if (!isGroup) {
      const tgPrincipal = withTx(db, () => ensurePrincipal(db, { platform: "telegram", subject: chatId }));
      grantAll(scopeRef.id, tgPrincipal.id, ["read", "request"]);
    } else if (/^\d+$/.test(tgOwnerIdRaw)) {
      const tgOwnerPrincipal = withTx(db, () => ensurePrincipal(db, { platform: "telegram", subject: tgOwnerIdRaw }));
      grantAll(scopeRef.id, tgOwnerPrincipal.id, ["read", "request"]);
    }
  }

  if (hasEnvKey(envMap, "MAIL_USER")) {
    const mailUser = envMap.MAIL_USER.trim().toLowerCase();
    if (!EMAIL_RE.test(mailUser)) {
      throw new Error("MAIL_USER in env must be a valid email address");
    }
    const mailScopeRef = withTx(db, () =>
      ensureScope(db, {
        ownerId: ownerRef.id,
        kind: "owner_dm",
        domainKey: `dm:mail:${mailUser}`,
        channel: "mail",
        conversationId: mailUser,
        policyVersion: "pv1",
      }),
    );
    summary.scopes.push(mailScopeRef.id);
    grantAll(mailScopeRef.id, ownerRef.id, OWNER_PERMISSIONS);
  }

  summary.briefingTimer = syncBriefingTimer(db, {
    config,
    dataDir,
    ownerId: ownerRef.id,
    briefingTime,
    grantAll,
    now,
  });

  return summary;
}
