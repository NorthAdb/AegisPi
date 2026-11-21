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
  return {
    apiBase: normalizedApiBase,
    allowRealSend: raw.allowRealSend === true,
    proxyUrl,
    timeoutMs,
  };
}

function parseStringAllowlist(rawValue, name) {
  if (rawValue === undefined) return [];
  if (!Array.isArray(rawValue) || !rawValue.every((item) => typeof item === "string")) {
    throw new ConfigError(`${name} must be an array of strings`);
  }
  return [...rawValue];
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
