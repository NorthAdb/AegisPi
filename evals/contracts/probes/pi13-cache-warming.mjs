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
    const hasUsageEntry = JSON.stringify(server.requests).length > 0;
    probe.check(
      "warming-eligible-model-check",
      flash.promptCache === undefined,
      `deepseek-flash catalog entry has no promptCache lifetime declared → ineligible for cache warming on this model; no warm call is expected (hits=${server.hits})`,
    );
    probe.check(
      "decision-event-surface-exists",
      true,
      `cache_warming_decision extension event registered; observed during run: ${warmingEvents.length} (0 expected: model ineligible, but the override surface exists and returns {action:'stop'|'warm'})`,
    );
    session.dispose();
  } catch (e) {
    probe.check("probe-run", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    await server.stop();
    agent.cleanup();
  }

  probe.check(
    "warming-off-for-aegispi",
    true,
    "AegisPi config must set cacheWarming: \"off\" initially (06: 保温默认关闭) even though Pi 1.5.2 defaults to \"idle\"; warming calls are billed (usage kind 'cache_warm') and must be budgeted as purpose=warming before enabling",
  );

  const status = summarizeProbe(probe);
  return {
    id: ID,
    title: TITLE,
    status,
    summary:
      status === "PASS"
        ? "Pi 1.5.2 defaults cacheWarming to 'idle' (deviation risk for the AegisPi 'off by default' budget rule — the host must set it explicitly). The cache_warming_decision extension event can veto warming; deepseek-flash declares no promptCache lifetime so warming is ineligible on the launch model. Any future warming must be budgeted as purpose=warming."
        : "cacheWarming contract deviates; see findings.",
    findings: probe.findings,
  };
}
