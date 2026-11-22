// Daemon configuration. This module is the ONLY reader of defaults.json for
// the daemon: the file is 06-shaped (budget keys nested) and MUST flow
// through piSettingsFromDefaults before anything Pi-shaped sees it (D-11,
// audit round 2 N2): SettingsManager reads ONLY the top-level cacheWarming
// key and silently falls back to "idle" when it is missing. Bypassing the
// loader here would silently re-enable warming. The gate tests assert both
// the behavior (mapped settings carry "off") and the wiring (this module
// imports the loader; the raw JSON has no top-level cacheWarming at all).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { piSettingsFromDefaults } from "../config/load-pi-settings.mjs";
import { assertValidModelBaseUrl, MAX_MODEL_MESSAGES_BYTES, ModelCallError } from "./model-call.mjs";
import { isHttpUrlWithoutCredentials, isSafeRelativeReadPath } from "./repo-observe.mjs";
import { parseTriageConfig } from "./repo-triage.mjs";
import { parseQuietHours, wallClock } from "./quiet-time.mjs";
import { assertValidTelegramApiBase, parseTelegramProxyUrl, TelegramSendError } from "./telegram-send.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export class ConfigError extends Error {}

// Disk-watermark drill seam (audit F8: 常开前必须有实测触警演练). The real
// statfs path stays untouched; the operator (or a drill suite) may inject
// warn/critical thresholds via AEGISPI_DISK_DRILL_WARN_GIB /
// AEGISPI_DISK_DRILL_CRITICAL_GIB to trip the watermark on a machine whose
// disk is healthy. The seam can only TIGHTEN (re-review F8): an injected
// threshold is a free-bytes GATE, and a gate may only RISE — a value below
// the production threshold would loosen the watermark and a drill would
// then lie about coverage. Looser or level-inverting values refuse startup.
export function resolveDiskThresholds(defaults) {
  const prodWarnGiB = defaults.disk?.warnFreeGiB ?? 20;
  const prodCriticalGiB = defaults.disk?.criticalFreeGiB ?? 10;
  const base = {
    warnFreeBytes: prodWarnGiB * 1024 * 1024 * 1024,
    criticalFreeBytes: prodCriticalGiB * 1024 * 1024 * 1024,
  };
  const drill = (name) => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return null;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) {
      throw new ConfigError(`${name} must be a positive number of GiB for the watermark drill; refusing to run with a broken seam value`);
    }
    return v * 1024 * 1024 * 1024;
  };
  const warn = drill("AEGISPI_DISK_DRILL_WARN_GIB");
  const critical = drill("AEGISPI_DISK_DRILL_CRITICAL_GIB");
  if (warn !== null && warn < base.warnFreeBytes) {
    throw new ConfigError(
      `AEGISPI_DISK_DRILL_WARN_GIB may only tighten the watermark (production warn is ${prodWarnGiB} GiB); the injected value loosens it — refusing to start`,
    );
  }
  if (critical !== null && critical < base.criticalFreeBytes) {
    throw new ConfigError(
      `AEGISPI_DISK_DRILL_CRITICAL_GIB may only tighten the watermark (production critical is ${prodCriticalGiB} GiB); the injected value loosens it — refusing to start`,
    );
  }
  if (warn !== null) base.warnFreeBytes = warn;
  if (critical !== null) base.criticalFreeBytes = critical;
  if (base.criticalFreeBytes > base.warnFreeBytes) {
    throw new ConfigError(
      "the effective critical threshold exceeds warn; a drill cannot invert the watermark escalation order — refusing to start",
    );
  }
  return base;
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

function parseOptionalPositiveInt(value, { name, max }) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new ConfigError(`${name} must be null or a positive integer <= ${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function parseAcquisitionTarget(targetId, spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new ConfigError(`acquisition.targets.${targetId} must be an object`);
  }
  for (const k of ["repo", "url", "ref"]) {
    if (typeof spec[k] !== "string" || spec[k].trim().length === 0) {
      throw new ConfigError(`acquisition.targets.${targetId}.${k} must be a non-empty string`);
    }
  }
  if (!isHttpUrlWithoutCredentials(spec.url)) {
    throw new ConfigError(`acquisition.targets.${targetId}.url must be http(s) without embedded credentials`);
  }
  if (spec.sha256 !== undefined && spec.sha256 !== null && !/^[0-9a-f]{64}$/.test(spec.sha256)) {
    throw new ConfigError(`acquisition.targets.${targetId}.sha256 must be 64 lowercase hex chars`);
  }
  const mode = spec.mode ?? "tar";
  if (mode !== "tar" && mode !== "file") {
    throw new ConfigError(`acquisition.targets.${targetId}.mode must be "tar" or "file"`);
  }
  if (!Array.isArray(spec.readPaths) || spec.readPaths.length === 0) {
    throw new ConfigError(`acquisition.targets.${targetId}.readPaths must be a non-empty array`);
  }
  for (const p of spec.readPaths) {
    if (!isSafeRelativeReadPath(p)) {
      throw new ConfigError(`acquisition.targets.${targetId}.readPaths contains unsafe path ${JSON.stringify(p)}`);
    }
  }
  let allowedRedirectHosts = [];
  if (spec.allowedRedirectHosts !== undefined) {
    if (!Array.isArray(spec.allowedRedirectHosts) || !spec.allowedRedirectHosts.every((h) => typeof h === "string")) {
      throw new ConfigError(`acquisition.targets.${targetId}.allowedRedirectHosts must be an array of strings`);
    }
    allowedRedirectHosts = spec.allowedRedirectHosts.map((h) => h.toLowerCase());
  }
  for (const h of allowedRedirectHosts) {
    if (!HOSTNAME_RE.test(h)) {
      throw new ConfigError(`acquisition.targets.${targetId}.allowedRedirectHosts invalid host ${JSON.stringify(h)}`);
    }
  }
  const maxDownloadBytes = parseOptionalPositiveInt(spec.maxDownloadBytes ?? null, {
    name: `acquisition.targets.${targetId}.maxDownloadBytes`,
    max: 1024 * 1024 * 1024,
  });
  return {
    repo: spec.repo.trim(),
    url: spec.url,
    ref: spec.ref.trim(),
    sha256: spec.sha256 ?? null,
    mode,
    readPaths: [...spec.readPaths],
    allowedRedirectHosts,
    maxDownloadBytes,
  };
}

function parseAcquisitionConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("acquisition config must be an object");
  }
  const allowedHostsRaw = raw.allowedHosts ?? [];
  if (!Array.isArray(allowedHostsRaw)) {
    throw new ConfigError("acquisition.allowedHosts must be an array");
  }
  const allowedHosts = allowedHostsRaw.map((h) => {
    if (typeof h !== "string" || !HOSTNAME_RE.test(h)) {
      throw new ConfigError(`acquisition.allowedHosts entry invalid: ${JSON.stringify(h)}`);
    }
    return h.toLowerCase();
  });
  const targetsRaw = raw.targets ?? {};
  if (!targetsRaw || typeof targetsRaw !== "object" || Array.isArray(targetsRaw)) {
    throw new ConfigError("acquisition.targets must be a plain object");
  }
  const targets = {};
  for (const [id, spec] of Object.entries(targetsRaw)) {
    targets[id] = parseAcquisitionTarget(id, spec);
  }
  const maxDownloadBytes = raw.maxDownloadBytes ?? 8 * 1024 * 1024;
  if (!Number.isInteger(maxDownloadBytes) || maxDownloadBytes <= 0 || maxDownloadBytes > 1024 * 1024 * 1024) {
    throw new ConfigError(`acquisition.maxDownloadBytes invalid: ${JSON.stringify(maxDownloadBytes)}`);
  }
  const maxExcerptBytes = raw.maxExcerptBytes ?? 32768;
  if (!Number.isInteger(maxExcerptBytes) || maxExcerptBytes <= 0 || maxExcerptBytes > MAX_MODEL_MESSAGES_BYTES) {
    throw new ConfigError(`acquisition.maxExcerptBytes invalid: ${JSON.stringify(maxExcerptBytes)}`);
  }
  const maxFiles = raw.maxFiles ?? 32;
  if (!Number.isInteger(maxFiles) || maxFiles <= 0 || maxFiles > 256) {
    throw new ConfigError(`acquisition.maxFiles invalid: ${JSON.stringify(maxFiles)}`);
  }
  const timeoutMs = raw.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    throw new ConfigError(`acquisition.timeoutMs invalid: ${JSON.stringify(timeoutMs)}`);
  }
  return {
    allowRealRepoFetch: raw.allowRealRepoFetch === true,
    enableHostGateway: raw.enableHostGateway === true,
    allowedHosts,
    targets,
    maxDownloadBytes,
    maxExcerptBytes,
    maxFiles,
    timeoutMs,
  };
}

function parseTelegramConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("telegram config must be an object");
  }
  const apiBase = raw.apiBase ?? null;
  let normalizedApiBase = null;
  if (apiBase !== null) {
    try {
      normalizedApiBase = assertValidTelegramApiBase(apiBase);
    } catch (e) {
      throw new ConfigError(e instanceof TelegramSendError ? e.message : String(e));
    }
  }
  const timeoutMs = raw.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new ConfigError(`telegram.timeoutMs must be an integer 1000..120000, got ${JSON.stringify(timeoutMs)}`);
  }
  const proxyRaw = raw.proxyUrl ?? null;
  let proxyUrl = null;
  if (proxyRaw !== null) {
    try {
      proxyUrl = parseTelegramProxyUrl(proxyRaw).url;
    } catch (e) {
      throw new ConfigError(e instanceof TelegramSendError ? e.message : String(e));
    }
  }
  // Route 1 pull ingress (Unit 5.2). Fail closed: allowRealPull only ever
  // becomes true by explicit owner config, and an empty allowedChatIds means
  // every update is refused (masked counter only, zero payload persisted).
  const allowRealPull = raw.allowRealPull === true;
  const pullIntervalMs = raw.pullIntervalMs ?? 5000;
  if (!Number.isInteger(pullIntervalMs) || pullIntervalMs < 500 || pullIntervalMs > 600_000) {
    throw new ConfigError(`telegram.pullIntervalMs must be an integer 500..600000, got ${JSON.stringify(raw.pullIntervalMs)}`);
  }
  const pullTimeoutSeconds = raw.pullTimeoutSeconds ?? 0;
  if (!Number.isInteger(pullTimeoutSeconds) || pullTimeoutSeconds < 0 || pullTimeoutSeconds > 60) {
    throw new ConfigError(`telegram.pullTimeoutSeconds must be an integer 0..60, got ${JSON.stringify(raw.pullTimeoutSeconds)}`);
  }
  const pullBatchLimit = raw.pullBatchLimit ?? 20;
  if (!Number.isInteger(pullBatchLimit) || pullBatchLimit < 1 || pullBatchLimit > 100) {
    throw new ConfigError(`telegram.pullBatchLimit must be an integer 1..100, got ${JSON.stringify(raw.pullBatchLimit)}`);
  }
  const allowedChatIds = parseStringAllowlist(raw.allowedChatIds, "telegram.allowedChatIds").map((v) => String(v).trim()).filter((v) => v.length > 0);
  return {
    apiBase: normalizedApiBase,
    allowRealSend: raw.allowRealSend === true,
    proxyUrl,
    timeoutMs,
    allowRealPull,
    pullIntervalMs,
    pullTimeoutSeconds,
    pullBatchLimit,
    allowedChatIds,
  };
}

// Fair-scheduling bounds for the per-domain single-flight Router (01 §2,
// audit matrix F14). Pure numeric bounds — none of these gates real-world
// writes; they shape starvation-free ordering only.
function parseRouterConfig(raw) {
  const r = raw ?? {};
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    throw new ConfigError("router config must be an object");
  }
  const agingStepMs = r.agingStepMs ?? 60000;
  if (!Number.isInteger(agingStepMs) || agingStepMs < 1000 || agingStepMs > 3_600_000) {
    throw new ConfigError(`router.agingStepMs must be an integer 1000..3600000, got ${JSON.stringify(r.agingStepMs)}`);
  }
  const batchMaxEvents = r.batchMaxEvents ?? 8;
  if (!Number.isInteger(batchMaxEvents) || batchMaxEvents < 1 || batchMaxEvents > 8) {
    throw new ConfigError(`router.batchMaxEvents must be an integer 1..8, got ${JSON.stringify(r.batchMaxEvents)}`);
  }
  const scopeConsecutiveTurnLimit = r.scopeConsecutiveTurnLimit ?? 3;
  if (!Number.isInteger(scopeConsecutiveTurnLimit) || scopeConsecutiveTurnLimit < 1 || scopeConsecutiveTurnLimit > 100) {
    throw new ConfigError(`router.scopeConsecutiveTurnLimit must be an integer 1..100, got ${JSON.stringify(r.scopeConsecutiveTurnLimit)}`);
  }
  return { agingStepMs, batchMaxEvents, scopeConsecutiveTurnLimit };
}

// Layered memory bounds (Unit 5.1, 01 §4–6). autoActivateCandidateFacts stays
// false: candidate facts never self-activate, and identity/recipient/payment/
// approval-exemption/permission facts are hard-refused regardless.
function parseMemoryConfig(raw) {
  const m = raw ?? {};
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    throw new ConfigError("memory config must be an object");
  }
  const intBound = (value, fallback, min, max, name) => {
    const v = value ?? fallback;
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new ConfigError(`memory.${name} must be an integer ${min}..${max}, got ${JSON.stringify(value)}`);
    }
    return v;
  };
  return {
    l0MemoryMaxChars: intBound(m.l0MemoryMaxChars, 2200, 200, 100_000, "l0MemoryMaxChars"),
    l0UserMaxChars: intBound(m.l0UserMaxChars, 1375, 100, 50_000, "l0UserMaxChars"),
    l1MaxHops: intBound(m.l1MaxHops, 2, 1, 4, "l1MaxHops"),
    l1MaxObjects: intBound(m.l1MaxObjects, 16, 1, 64, "l1MaxObjects"),
    summaryMaxOutputTokens: intBound(m.summaryMaxOutputTokens, 500, 50, 4000, "summaryMaxOutputTokens"),
    autoActivateCandidateFacts: m.autoActivateCandidateFacts === true,
    spillMaxBytes: intBound(m.spillMaxBytes, 51200, 1024, 8 * 1024 * 1024, "spillMaxBytes"),
    spillMaxLines: intBound(m.spillMaxLines, 2000, 10, 100_000, "spillMaxLines"),
  };
}

function parseStringAllowlist(rawValue, name) {
  if (rawValue === undefined) return [];
  if (!Array.isArray(rawValue) || !rawValue.every((item) => typeof item === "string")) {
    throw new ConfigError(`${name} must be an array of strings`);
  }
  return [...rawValue];
}

// Unit 5.3 mail adapter config (03 section 3 / 02 section 4). Hosts are null
// by default (fail closed); a loopback host is the local verification seam
// but still demands the explicit allow flag, exactly like model.baseUrl and
// the telegram pull seam. Port bounds keep numeric fields numeric.
function parseMailConfig(raw) {
  const m = raw ?? {};
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    throw new ConfigError("mail config must be an object");
  }
  const hostOrNull = (v, name) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || v.length === 0 || v.length > 253 || /[\s/\\]/.test(v)) {
      throw new ConfigError(`mail.${name} must be null or a bare hostname without spaces`);
    }
    return v;
  };
  const port = (v, fallback, name) => {
    const p = v ?? fallback;
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new ConfigError(`mail.${name} must be an integer 1..65535, got ${JSON.stringify(v)}`);
    }
    return p;
  };
  const ttl = m.approvalTtlMs ?? 14400000;
  if (!Number.isInteger(ttl) || ttl < 60_000 || ttl > 7 * 24 * 3600_000) {
    throw new ConfigError(`mail.approvalTtlMs must be an integer 60000..604800000, got ${JSON.stringify(ttl)}`);
  }
  const maxAttachmentBytes = m.maxAttachmentBytes ?? 4194304;
  if (!Number.isInteger(maxAttachmentBytes) || maxAttachmentBytes < 1024 || maxAttachmentBytes > 26_214_400) {
    throw new ConfigError(`mail.maxAttachmentBytes must be an integer 1024..26214400, got ${JSON.stringify(maxAttachmentBytes)}`);
  }
  return {
    imapHost: hostOrNull(m.imapHost, "imapHost"),
    imapPort: port(m.imapPort, 993, "imapPort"),
    imapTls: m.imapTls !== false,
    smtpHost: hostOrNull(m.smtpHost, "smtpHost"),
    smtpPort: port(m.smtpPort, 465, "smtpPort"),
    smtpTls: m.smtpTls !== false,
    allowRealMailRead: m.allowRealMailRead === true,
    allowRealMailSend: m.allowRealMailSend === true,
    allowedFolders: parseStringAllowlist(m.allowedFolders, "mail.allowedFolders"),
    allowedSenders: parseStringAllowlist(m.allowedSenders, "mail.allowedSenders"),
    allowedRecipients: parseStringAllowlist(m.allowedRecipients, "mail.allowedRecipients"),
    approvalTtlMs: ttl,
    maxAttachmentBytes,
  };
}

// Unit 5.4 calendar adapter config + the quiet window the briefing merge and
// the L3 dreaming loop share (03 section 4, 06 section 7).
function parseCalendarConfig(raw) {
  const c = raw ?? {};
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    throw new ConfigError("calendar config must be an object");
  }
  let caldavUrl = c.caldavUrl ?? null;
  if (caldavUrl !== null) {
    if (typeof caldavUrl !== "string" || !/^https?:\/\//.test(caldavUrl)) {
      throw new ConfigError(`calendar.caldavUrl must be null or an http(s) URL, got ${JSON.stringify(caldavUrl)}`);
    }
    try {
      const u = new URL(caldavUrl);
      if (u.username !== "" || u.password !== "" || u.search !== "") {
        throw new ConfigError("calendar.caldavUrl must not embed credentials or a query string");
      }
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(`calendar.caldavUrl is not a valid URL: ${e.message}`);
    }
  }
  const defaultTimezone = typeof c.defaultTimezone === "string" && c.defaultTimezone.length > 0 ? c.defaultTimezone : "Asia/Hong_Kong";
  let quietHours;
  try {
    quietHours = parseQuietHours(c.quietHours, { defaultTimezone });
  } catch (e) {
    throw new ConfigError(`calendar.quietHours invalid: ${e.message}`);
  }
  try {
    wallClock(Date.now(), defaultTimezone);
  } catch {
    throw new ConfigError(`calendar.defaultTimezone ${defaultTimezone} is not a valid IANA zone`);
  }
  return {
    caldavUrl,
    allowRealCalendarRead: c.allowRealCalendarRead === true,
    allowRealCalendarWrite: c.allowRealCalendarWrite === true,
    allowedCalendars: parseStringAllowlist(c.allowedCalendars, "calendar.allowedCalendars"),
    defaultTimezone,
    quietHours,
  };
}

export function defaultsJsonPath() {
  return join(here, "..", "config", "defaults.json");
}

export function loadDaemonConfig({ path = defaultsJsonPath() } = {}) {
  if (!existsSync(path)) {
    throw new ConfigError(`defaults.json not found at ${path}`);
  }
  let defaults;
  try {
    defaults = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`config JSON at ${path} is invalid: ${e.message}`);
  }
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new ConfigError(`config at ${path} must be a JSON object`);
  }
  for (const reqSection of ["budget", "leases", "time", "sqlite", "containerPlaceholders"]) {
    if (!defaults[reqSection] || typeof defaults[reqSection] !== "object" || Array.isArray(defaults[reqSection])) {
      throw new ConfigError(`config section ${reqSection} is missing or invalid`);
    }
  }
  // The single mapping point (D-11): never hand raw defaults to Pi settings.
  const piSettings = piSettingsFromDefaults(defaults);

  const warmingEnabled = defaults.budget.cacheWarming === "off" ? false : true;
  const modelRaw = defaults.model ?? {};
  const baseUrl = modelRaw.baseUrl ?? null;
  if (baseUrl !== null) {
    if (typeof baseUrl !== "string") {
      throw new ConfigError(`model.baseUrl must be null or a pathless URL string, got ${typeof baseUrl}`);
    }
    try {
      assertValidModelBaseUrl(baseUrl);
    } catch (e) {
      throw new ConfigError(e instanceof ModelCallError ? e.message : String(e));
    }
  }
  const callUpperMicrousd = modelRaw.callUpperMicrousd ?? 1000;
  if (!Number.isSafeInteger(callUpperMicrousd) || callUpperMicrousd < 0) {
    throw new ConfigError(`model.callUpperMicrousd must be a non-negative safe integer, got ${JSON.stringify(callUpperMicrousd)}`);
  }
  const callTimeoutMs = modelRaw.callTimeoutMs ?? 60000;
  if (!Number.isInteger(callTimeoutMs) || callTimeoutMs <= 0 || callTimeoutMs > 2_147_000_000) {
    throw new ConfigError(`model.callTimeoutMs must be a positive integer <= 2147000000, got ${JSON.stringify(callTimeoutMs)}`);
  }
  const maxInputBytes = parseOptionalPositiveInt(modelRaw.maxInputBytes ?? null, {
    name: "model.maxInputBytes",
    max: MAX_MODEL_MESSAGES_BYTES,
  });
  const maxOutputTokens = parseOptionalPositiveInt(modelRaw.maxOutputTokens ?? null, {
    name: "model.maxOutputTokens",
    max: 1_000_000,
  });
  const acquisition = parseAcquisitionConfig(defaults.acquisition ?? {});
  const telegram = parseTelegramConfig(defaults.telegram ?? {});
  let triage;
  try {
    triage = parseTriageConfig(defaults.triage ?? {});
  } catch (e) {
    throw new ConfigError(e.message);
  }

  return {
    defaultsPath: path,
    raw: defaults,
    piSettings,
    budget: {
      taskLimitMicrousd: defaults.budget.taskMicroUsd,
      taskMaxSteps: defaults.budget.taskMaxSteps,
      taskMaxWallClockMs: defaults.budget.taskMaxWallClockSeconds * 1000,
      dayLimitMicrousd: defaults.budget.dayMicroUsd,
      purposes: defaults.budget.purposes,
      cacheWarming: defaults.budget.cacheWarming,
      warmingEnabled,
    },
    leases: {
      heartbeatMs: defaults.leases.heartbeatSeconds * 1000,
      leaseMs: defaults.leases.leaseSeconds * 1000,
      offlineJobDeadlineMs: defaults.leases.offlineJobDeadlineSeconds * 1000,
      maxConcurrentAgentsPerScope: defaults.leases.maxConcurrentAgentsPerScope,
      maxOfflineJobsMachineWide: defaults.leases.maxOfflineJobsMachineWide,
    },
    // Model call path (ADR-0001 §5/§9). baseUrl is the SDK root address
    // (null = no worker path wired: nothing is claimed, zero reservations).
    // A loopback baseUrl is the local verification seam; a non-loopback
    // baseUrl additionally needs allowRealModelCalls (owner authorization).
    // allowedPurposes and allowedModelIds default to [] (fail-closed).
    // priceCatalog null per category = rate not authorized: any positive
    // token count in that category keeps the reservation HELD, never zero.
    model: {
      ...(() => {
        const { endpoint: _removed, $modelComment: _mc, $evidence: _ev, $comment: _c, ...rest } = modelRaw;
        return rest;
      })(),
      baseUrl,
      allowedPurposes: Array.isArray(modelRaw.allowedPurposes) ? [...modelRaw.allowedPurposes] : [],
      allowedModelIds: Array.isArray(modelRaw.allowedModelIds) ? [...modelRaw.allowedModelIds] : [],
      allowRealModelCalls: modelRaw.allowRealModelCalls === true,
      callUpperMicrousd,
      callTimeoutMs,
      maxInputBytes,
      maxOutputTokens,
      priceCatalog: {
        inputPerMTokMicrousd: modelRaw.priceCatalog?.inputPerMTokMicrousd ?? null,
        outputPerMTokMicrousd: modelRaw.priceCatalog?.outputPerMTokMicrousd ?? null,
        cacheReadPerMTokMicrousd: modelRaw.priceCatalog?.cacheReadPerMTokMicrousd ?? null,
        cacheWritePerMTokMicrousd: modelRaw.priceCatalog?.cacheWritePerMTokMicrousd ?? null,
      },
    },
    timezone: defaults.time.timezoneIANA,
    sqlite: { ...defaults.sqlite },
    containerPlaceholders: { ...defaults.containerPlaceholders },
    // Host adapter policy (02 section 4). Real external writes stay fail
    // closed until the owner explicitly authorizes them; the allowlists are
    // deployment values the owner sets when granting real scopes.
    policy: {
      allowRealExternalWrites: defaults.policy?.allowRealExternalWrites === true,
    },
    adapters: {
      fixedSendingIdentity: defaults.adapters?.fixedSendingIdentity ?? "aegispi@local",
      allowedRecipients: parseStringAllowlist(defaults.adapters?.allowedRecipients, "adapters.allowedRecipients"),
      allowedRepos: parseStringAllowlist(defaults.adapters?.allowedRepos, "adapters.allowedRepos"),
      allowedBranches: parseStringAllowlist(defaults.adapters?.allowedBranches, "adapters.allowedBranches"),
    },
    // Real submitter transport (re-review P1). submitUrl null = no transport
    // wired: READY effects stay durable with the honest log, fail closed.
    // Configured = the production tick submits through the adapter gates
    // (transportKind "real"), which still refuse without
    // policy.allowRealExternalWrites and wired credential slots.
    upstream: {
      submitUrl: defaults.upstream?.submitUrl ?? null,
      timeoutMs: defaults.upstream?.timeoutMs ?? 30000,
    },
    telegram,
    router: parseRouterConfig(defaults.router),
    memory: parseMemoryConfig(defaults.memory),
    mail: parseMailConfig(defaults.mail),
    calendar: parseCalendarConfig(defaults.calendar),
    // Credential SLOT markers the adapter checks (values never live here —
    // 02 section 4: only the host credential service reads secrets). A null
    // slot means nothing real is wired and the adapter refuses real writes.
    credentials: defaults.credentials ?? {},
    disk: resolveDiskThresholds(defaults),
    backup: {
      windowStartHour: defaults.backup?.windowStartHour ?? 4,
      windowEndHour: defaults.backup?.windowEndHour ?? 5,
      retentionDays: defaults.backup?.retentionDays ?? 14,
      timeZone: defaults.time?.timezoneIANA ?? "Asia/Hong_Kong",
    },
    acquisition,
    triage,
  };
}
