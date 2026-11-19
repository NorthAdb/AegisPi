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

const here = dirname(fileURLToPath(import.meta.url));

export class ConfigError extends Error {}

// Disk-watermark drill seam (audit F8: 常开前必须有实测触警演练). The real
// statfs path stays untouched; the operator (or a drill suite) may inject
// warn/critical thresholds via AEGISPI_DISK_DRILL_WARN_GIB /
// AEGISPI_DISK_DRILL_CRITICAL_GIB to trip the watermark on a machine whose
// disk is healthy. The seam can only provide sane positive thresholds — it
// can never disable the watermark or widen a level.
export function resolveDiskThresholds(defaults) {
  const base = {
    warnFreeBytes: (defaults.disk?.warnFreeGiB ?? 20) * 1024 * 1024 * 1024,
    criticalFreeBytes: (defaults.disk?.criticalFreeGiB ?? 10) * 1024 * 1024 * 1024,
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
  if (warn !== null) base.warnFreeBytes = warn;
  if (critical !== null) base.criticalFreeBytes = critical;
  if (warn !== null && critical !== null && critical > warn) {
    throw new ConfigError("AEGISPI_DISK_DRILL_CRITICAL_GIB must not exceed the warn threshold; a drill cannot invert the watermark levels");
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
    model: { ...defaults.model },
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
    disk: resolveDiskThresholds(defaults),
    backup: {
      windowStartHour: defaults.backup?.windowStartHour ?? 4,
      windowEndHour: defaults.backup?.windowEndHour ?? 5,
      retentionDays: defaults.backup?.retentionDays ?? 14,
      timeZone: defaults.time?.timezoneIANA ?? "Asia/Hong_Kong",
    },
  };
}
