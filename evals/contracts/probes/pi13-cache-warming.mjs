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

  // The off value is respected by the runtime settings path (falsifiable):
  // an explicit in-memory override must read back "off", and the shipped
  // defaults.json must actually contain the off value.
  const offMode = pi.SettingsManager.inMemory({ cacheWarming: "off" }).getCacheWarmingMode?.();
  probe.check(
    "explicit-off-respected-by-settings-path",
    offMode === "off",
    `SettingsManager.inMemory({cacheWarming:"off"}).getCacheWarmingMode() = ${offMode}`,
  );
  const defaultsFile = readFileSync(
    join(process.cwd(), "apps", "daemon", "config", "defaults.json"),
    "utf8",
  );
  probe.check(
    "defaults-json-sets-off",
    /"cacheWarming"\s*:\s*"off"/.test(defaultsFile),
    `apps/daemon/config/defaults.json contains "cacheWarming": "off" — config value written; the daemon loading this file is Phase 2 code, so runtime enforcement is NOT yet in place (recorded, not claimed)`,
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
        ? "Pi 1.5.2 defaults cacheWarming to 'idle' — measured, and a real conflict with the AegisPi 'off by default' budget rule. Mitigation is in place at the settings level only: inMemory({cacheWarming:'off'}) reads back 'off' and defaults.json carries the off value; daemon code that loads it is Phase 2, so runtime enforcement is recorded as NOT yet in place. cache_warming_decision is a declared, registrable override event; deepseek-flash declares no promptCache lifetime so warming is ineligible on the launch model. Future warming must be budgeted as purpose=warming."
        : "cacheWarming contract deviates; see findings.",
    findings: probe.findings,
  };
}
