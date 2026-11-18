// PI-02: virtual models — route(request, ctx), previous/failed/state, reason.
// Uses a local fake endpoint; no real provider is contacted.

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

export const ID = "PI-02";
export const TITLE = "virtual model route(): reason/previous/failed/state";

export async function run() {
  const probe = createProbe(ID, TITLE);
  const server = createFakeOpenAIServer({
    scripts: [
      { kind: "text", text: "first physical response" },
      { kind: "tool_call", name: "probe_pi02_tool", args: { x: "1" }, text: "calling tool" },
      { kind: "text", text: "after tool result" },
      { kind: "error", status: 500, body: { error: { message: "probe scripted 500" } } },
      { kind: "text", text: "recovered response" },
    ],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();

  const routeCalls = [];
  let routeError = null;

  try {
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(agent.dir, "auth.json"),
      modelsPath: agent.modelsPath,
    });
    await modelRuntime.setRuntimeApiKey("deepseek", "probe-fake-key");
    const physical = modelRuntime.getModel("deepseek", "deepseek-flash");
    probe.check(
      "physical-model-in-catalog",
      !!physical && physical.id === "deepseek-flash",
      `getModel('deepseek','deepseek-flash') = ${physical ? physical.id + " @ " + physical.baseUrl : "NOT FOUND"}`,
    );

    // 1.5.2 contract note: VirtualModelDefinition.route(request) takes ONE
    // parameter (dist/core/virtual-models.d.ts). The docs page's
    // route(request, ctx) example does not match the shipped types; the
    // router resolves physical models through a captured ModelRuntime.
    modelRuntime.registerVirtualModel({
      provider: "probe-router",
      id: "auto",
      name: "ProbeAuto",
      thinkingLevels: ["off", "high"],
      route(request) {
        const record = {
          reason: request.reason,
          model: request.model?.id,
          previous: request.previous ? { model: request.previous.model?.id, thinkingLevel: request.previous.thinkingLevel } : null,
          failed: request.failed ? { model: request.failed.model?.id, stopReason: request.failed.message?.stopReason } : null,
          state: request.state ?? null,
        };
        routeCalls.push(record);
        try {
          const sticky = request.failed ?? request.previous;
          if (request.reason !== "user" && sticky) {
            return {
              model: sticky.model,
              thinkingLevel: sticky.thinkingLevel ?? "off",
              state: request.state,
            };
          }
          return { model: modelRuntime.getModel("deepseek", "deepseek-flash"), thinkingLevel: "high", state: { n: 1 } };
        } catch (e) {
          routeError = e;
          throw e;
        }
      },
    });

    const vmodel = modelRuntime.getModel("probe-router", "auto");
    probe.check("virtual-model-registered", !!vmodel, `getModel('probe-router','auto') found`);

    const vmDts = readFileSync(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "virtual-models.d.ts"),
      "utf8",
    );
    probe.check(
      "route-signature-single-param",
      /route\(request: ModelRouteRequest<TState>\): ModelRoute<TState>/.test(vmDts),
      "dist/core/virtual-models.d.ts declares route(request) with one parameter; docs virtual-models.md example shows route(request, ctx) with ctx.modelRegistry, which does not match the shipped types",
    );

    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: wsDir,
      agentDir: agent.dir,
      extensionFactories: [
        (ext) => {
          ext.registerTool({
            name: "probe_pi02_tool",
            label: "Probe",
            description: "probe tool for continuation routing",
            parameters: { type: "object", properties: { x: { type: "string" } } },
            execute: async () => ({ content: [{ type: "text", text: "tool done" }], details: {} }),
          });
        },
      ],
    });
    await resourceLoader.reload();

    const { session } = await pi.createAgentSession({
      agentDir: agent.dir,
      cwd: wsDir,
      model: vmodel,
      thinkingLevel: "high",
      modelRuntime,
      resourceLoader,
      sessionManager: pi.SessionManager.inMemory(wsDir),
      settingsManager: pi.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1 },
      }),
      noTools: true,
    });

    // 1st prompt: one text response. route reason should be "user".
    await session.prompt("first user turn");
    probe.check("route-user-reason", routeCalls[0]?.reason === "user", `route call #1: ${JSON.stringify(routeCalls[0])}`);

    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    probe.check(
      "dispatch-records-physical-model",
      lastAssistant?.model === "deepseek-flash",
      `assistant message model = ${lastAssistant?.model} (virtual selection must not leak to provider)`,
    );

    // 2nd prompt: scripted tool_call then text -> a continuation route.
    const before = routeCalls.length;
    await session.prompt("second user turn with tool");
    const contCall = routeCalls.slice(before).find((c) => c.reason === "continuation");
    probe.check(
      "route-continuation-with-previous",
      !!contCall && contCall.previous?.model === "deepseek-flash",
      `continuation call: ${JSON.stringify(contCall)}`,
    );
    probe.check(
      "route-state-passed-back",
      routeCalls.slice(before).some((c) => c.state && c.state.n === 1),
      `state returned on later calls: ${JSON.stringify(routeCalls.slice(before).map((c) => c.state))}`,
    );

    // 3rd prompt: scripted 500 then success -> retry route with failed.
    const beforeRetry = routeCalls.length;
    await session.prompt("third user turn triggers retry");
    const retryCall = routeCalls.slice(beforeRetry).find((c) => c.reason === "retry");
    probe.check(
      "route-retry-with-failed",
      !!retryCall,
      `retry route call: ${JSON.stringify(retryCall)}`,
    );
    if (retryCall) {
      probe.check(
        "retry-failed-shape",
        retryCall.failed?.model === "deepseek-flash",
        `failed = ${JSON.stringify(retryCall.failed)}`,
      );
    }

    probe.check("route-no-error", routeError === null, routeError ? `route threw: ${routeError.message}` : "route never threw");
    probe.note(
      "server-hits",
      `fake endpoint hits=${server.hits}; each request body recorded in server.requests`,
      { hits: server.hits, paths: server.requests.map((r) => r.url) },
    );
    session.dispose();
  } catch (e) {
    probe.check("probe-run", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    await server.stop();
    agent.cleanup();
  }

  const status = summarizeProbe(probe);
  return {
    id: ID,
    title: TITLE,
    status,
    summary:
      status === "PASS"
        ? "route() contract verified: user/continuation/retry reasons, previous/failed stickiness, JSON state survives across calls, dispatch records the physical model."
        : "route() shape deviates from the documented contract; see findings.",
    findings: probe.findings,
  };
}
