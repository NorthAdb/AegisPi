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
  };
}
