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
import { assertValidModelBaseUrl, ModelCallError } from "./model-call.mjs";

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

export function defaultsJsonPath() {
  return join(here, "..", "config", "defaults.json");
}

export function loadDaemonConfig({ path = defaultsJsonPath() } = {}) {
  if (!existsSync(path)) {
    throw new ConfigError(`defaults.json not found at ${path}`);
  }
  const defaults = JSON.parse(readFileSync(path, "utf8"));
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
        const { endpoint: _removed, ...rest } = modelRaw;
        return rest;
      })(),
      baseUrl,
      allowedPurposes: Array.isArray(modelRaw.allowedPurposes) ? [...modelRaw.allowedPurposes] : [],
      allowedModelIds: Array.isArray(modelRaw.allowedModelIds) ? [...modelRaw.allowedModelIds] : [],
      allowRealModelCalls: modelRaw.allowRealModelCalls === true,
      callUpperMicrousd,
      callTimeoutMs,
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
      allowedRecipients: defaults.adapters?.allowedRecipients ?? [],
      allowedRepos: defaults.adapters?.allowedRepos ?? [],
      allowedBranches: defaults.adapters?.allowedBranches ?? [],
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
  };
}
