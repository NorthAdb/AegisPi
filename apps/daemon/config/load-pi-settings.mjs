// The single mapping from AegisPi daemon defaults.json (06-shaped, budget
// keys nested) to the Pi 1.5.2 SettingsManager settings shape.
//
// Why this exists (audit round 2 N2): SettingsManager.getCacheWarmingMode()
// reads ONLY the top-level `cacheWarming` key and falls back to "idle" when
// it is absent — feeding JSON.parse(defaults.json) straight into
// SettingsManager.inMemory() silently yields "idle" even though the file
// says budget.cacheWarming === "off". The Phase 2 daemon MUST load the file
// through this module; the PI-13 probe asserts the round trip.
//
// Mappings are explicit and one-way. Keys absent from defaults.json are
// left for Pi's own defaults (which PI-13 documents where they deviate
// from AegisPi policy).

export function piSettingsFromDefaults(defaults) {
  if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new Error("defaults must be a JSON object");
  }
  const settings = {};
  const budget = defaults.budget ?? {};
  if (budget.cacheWarming !== undefined) {
    // Pi setting name: cacheWarming ("off" | "streaming" | "idle").
    settings.cacheWarming = budget.cacheWarming;
  }
  // Future Phase 2 mappings (retry, compaction, codemode budgets...) get
  // added here as the daemon starts consuming them — one place, no drift.
  return settings;
}
