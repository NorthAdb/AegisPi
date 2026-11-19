// PI-13: cacheWarming — default value (settings-defaults.js says "idle"),
// the decision event surface, and that a warm cycle is a real billed call.
// The deepseek-flash catalog entry declares no promptCache lifetime, so on
// this model warming is ineligible: recorded as an eligibility limitation.

import * as pi from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeOpenAIServer } from "../helpers/fake-openai-server.mjs";
import {
  createProbe,
  summarizeProbe,
  makeIsolatedAgentDir,
  makeWorkspaceDir,
} from "../helpers/probe-utils.mjs";

export const ID = "PI-13";
export const TITLE = "cacheWarming default, decision event, eligibility";

export async function run() {
  const probe = createProbe(ID, TITLE);
  const defaults = readFileSync(
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "settings-defaults.js"),
    "utf8",
  );
  probe.check(
    "default-is-idle",
    /cacheWarming:\s*"idle"/.test(defaults),
    "dist/core/settings-defaults.js: cacheWarming: \"idle\" — warming ON by default (30 min idle window)",
  );

  const settingsManager = pi.SettingsManager.inMemory({});
  const mode = settingsManager.getCacheWarmingMode?.();
  probe.check(
    "runtime-reads-default",
    mode === "idle",
    `SettingsManager.inMemory({}).getCacheWarmingMode() = ${mode}`,
  );

  const server = createFakeOpenAIServer({
    scripts: [{ kind: "text", text: "pi13 response" }],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();

  const warmingEvents = [];
  const sessionEvents = [];
  try {
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(agent.dir, "auth.json"),
      modelsPath: agent.modelsPath,
    });
    await modelRuntime.setRuntimeApiKey("deepseek", "probe-fake-key");
    const flash = modelRuntime.getModel("deepseek", "deepseek-flash");

    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: wsDir,
      agentDir: agent.dir,
      extensionFactories: [
        (ext) => {
          ext.on("cache_warming_decision", async (event) => {
            warmingEvents.push({
              action: event.action,
              warmCost: event.warmCost,
              missCost: event.missCost,
              continuationProbability: event.continuationProbability,
            });
            return { action: "stop" };
          });
        },
      ],
    });
    await resourceLoader.reload();

    const { session } = await pi.createAgentSession({
      agentDir: agent.dir,
      cwd: wsDir,
      model: flash,
      thinkingLevel: "high",
      modelRuntime,
      resourceLoader,
      sessionManager: pi.SessionManager.inMemory(wsDir),
      settingsManager,
      tools: [],
    });
    const unsub = session.subscribe((e) => sessionEvents.push(e.type));
    await session.prompt("pi13 turn");
    unsub();
    probe.check(
      "warming-eligible-model-check",
      flash.promptCache === undefined,
      `deepseek-flash catalog entry has no promptCache lifetime declared → ineligible for cache warming on this model; no warm call is expected (hits=${server.hits})`,
    );
    // Falsifiable static evidence: the decision override surface is a real
    // declared event in the installed dist — extensions/types.d.ts declares
    // the registration signature on(event: "cache_warming_decision", ...)
    // and cache-warmer.d.ts declares the event type plus its result.
    const extTypes = readFileSync(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "types.d.ts"),
      "utf8",
    );
    const warmerDts = readFileSync(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "cache-warmer.d.ts"),
      "utf8",
    );
    probe.check(
      "decision-event-type-declared",
      /on\(event:\s*"cache_warming_decision"/.test(extTypes) &&
        /type:\s*"cache_warming_decision"/.test(warmerDts) &&
        /CacheWarmingDecisionEventResult/.test(extTypes),
      `extensions/types.d.ts declares on(event: "cache_warming_decision", ...) with CacheWarmingDecisionEventResult, cache-warmer.d.ts declares the event type; observed during run: ${warmingEvents.length} invocations (0 expected: model ineligible)`,
    );
    session.dispose();
  } catch (e) {
    probe.check("probe-run", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    await server.stop();
    agent.cleanup();
  }

  // Round 2 N2 closed: the two previously-disconnected facts (regex on the
  // file + a hand-written settings object) are now connected by the single
  // loader module. The probe walks the REAL path: parse the shipped
  // defaults.json, map it through apps/daemon/config/load-pi-settings.mjs,
  // and hand the result to Pi's SettingsManager. Feeding the raw file to
  // SettingsManager yields "idle" (budget.* nesting never reaches the
  // top-level key Pi reads) — measured; this assertion must stay red until
  // a loader performs the mapping.
  const defaultsJson = readFileSync(
    join(process.cwd(), "apps", "daemon", "config", "defaults.json"),
    "utf8",
  );
  const { pathToFileURL } = await import("node:url");
  const { piSettingsFromDefaults } = await import(
    pathToFileURL(join(process.cwd(), "apps", "daemon", "config", "load-pi-settings.mjs")).href,
  );
  const piSettings = piSettingsFromDefaults(JSON.parse(defaultsJson));
  const fileModeRaw = pi.SettingsManager.inMemory(JSON.parse(defaultsJson)).getCacheWarmingMode?.();
  probe.check(
    "raw-defaults-json-reads-idle-hazard",
    fileModeRaw === "idle",
    `SettingsManager.inMemory(JSON.parse(defaults.json)) = ${fileModeRaw} — the nested budget.cacheWarming does NOT reach the top-level key Pi reads; loading the file without the mapping loader silently enables default warming (hazard recorded as an assertion)`,
  );
  const fileModeViaLoader = pi.SettingsManager.inMemory(piSettings).getCacheWarmingMode?.();
  probe.check(
    "defaults-json-off-reaches-pi-via-loader",
    fileModeViaLoader === "off",
    `JSON.parse(defaults.json) -> piSettingsFromDefaults() -> SettingsManager.inMemory(...).getCacheWarmingMode() = ${fileModeViaLoader}; mapped settings = ${JSON.stringify(piSettings)} — the shipped file's off value reaches Pi's runtime settings path through the single loader; the Phase 2 daemon must load the file through that same module`,
  );
  probe.check(
    "defaults-json-sets-off",
    /"cacheWarming"\s*:\s*"off"/.test(defaultsJson),
    `apps/daemon/config/defaults.json contains "cacheWarming": "off" under budget (file-shape sanity; the reachability proof is the loader check above)`,
  );
  probe.note(
    "warming-must-be-budgeted-before-enabling",
    "warming calls are billed (usage kind 'cache_warm') and must be budgeted as purpose=warming before enabling — normative 06 rule for later phases",
  );

  const status = summarizeProbe(probe);
  return {
    id: ID,
    title: TITLE,
    status,
    summary:
      status === "PASS"
        ? "Pi 1.5.2 defaults cacheWarming to 'idle' — measured conflict with the AegisPi 'off by default' rule. The shipped defaults.json's budget.cacheWarming='off' reaches Pi's runtime settings ONLY through the single loader module (raw file -> SettingsManager reads 'idle', asserted as a hazard; loader-mapped settings -> 'off', asserted). The Phase 2 daemon must load the file through that module — recorded, not claimed as runtime enforcement. cache_warming_decision is a declared override event; deepseek-flash is warming-ineligible; future warming must be budgeted as purpose=warming."
        : "cacheWarming contract deviates; see findings.",
    findings: probe.findings,
  };
}
