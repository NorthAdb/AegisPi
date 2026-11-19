// PI-02: virtual models — route contract has TWO registration paths in 1.5.2
// (audit round 1, P1-1):
//   Path A: ModelRuntime.registerVirtualModel(def) → the runtime wraps the
//     definition as route: (request) => definition.route(request) — the user's
//     route receives exactly ONE argument (dist/core/model-runtime.js:712).
//   Path B: extension pi.registerVirtualModel(model) → the extension loader
//     wraps it as route: (request) => model.route(request, runtime.createContext())
//     — the user's route receives (request, ctx) with ctx.modelRegistry
//     (dist/core/extensions/loader.js:418, types.d.ts ExtensionVirtualModel).
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
export const TITLE = "virtual model route(): two registration paths, reason/previous/failed/state";

export async function run() {
  const probe = createProbe(ID, TITLE);
  const server = createFakeOpenAIServer({
    scripts: [
      { kind: "text", text: "first physical response" },
      { kind: "tool_call", name: "probe_pi02_tool", args: { x: "1" }, text: "calling tool" },
      { kind: "text", text: "after tool result" },
      { kind: "error", status: 500, body: { error: { message: "probe scripted 500" } } },
      { kind: "text", text: "recovered response" },
      { kind: "text", text: "ext path response" },
    ],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();

  const routeCalls = [];      // Path A records
  const extRouteCalls = [];    // Path B records
  let routeError = null;
  let extRouteError = null;

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

    // Static evidence for the two-path contract (file content, falsifiable):
    const vmDts = readFileSync(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "virtual-models.d.ts"),
      "utf8",
    );
    const extTypes = readFileSync(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "types.d.ts"),
      "utf8",
    );
    const modelRuntimeJs = readFileSync(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "model-runtime.js"),
      "utf8",
    );
    const loaderJs = readFileSync(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "loader.js"),
      "utf8",
    );
    probe.check(
      "dts-two-route-signatures",
      /route\(request: ModelRouteRequest<TState>\): ModelRoute<TState>/.test(vmDts) &&
        /route\(request: ModelRouteRequest<TState>, ctx: ExtensionContext\)/.test(extTypes),
      "virtual-models.d.ts declares VirtualModelDefinition.route(request) single-param; extensions/types.d.ts declares ExtensionVirtualModel.route(request, ctx: ExtensionContext) — both signatures ship in 1.5.2",
    );
    probe.check(
      "runtime-single-param-wrapper",
      modelRuntimeJs.includes("route: (request) => definition.route(request)"),
      "model-runtime.js wraps ModelRuntime-registered VMs as route(request) => definition.route(request) — single argument",
    );
    probe.check(
      "loader-two-param-wrapper",
      loaderJs.includes("route: (request) => model.route(request, runtime.createContext())"),
      "extensions/loader.js wraps extension-registered VMs as route(request) => model.route(request, runtime.createContext()) — two arguments",
    );

    // ---------- Path A: ModelRuntime.registerVirtualModel ----------
    modelRuntime.registerVirtualModel({
      provider: "probe-router",
      id: "auto",
      name: "ProbeAuto",
      thinkingLevels: ["off", "high"],
      route(request) {
        const record = {
          reason: request.reason,
          model: request.model?.id,
          argsLength: arguments.length,
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
          // Path B: extension-registered virtual model. The loader wraps this
          // route so the handler receives (request, ctx) — see the static
          // checks above for the exact wrapper lines in the installed dist.
          ext.registerVirtualModel({
            provider: "probe-ext-router",
            id: "auto",
            name: "ProbeExtAuto",
            thinkingLevels: ["off", "high"],
            route(request, ctx) {
              const found = ctx?.modelRegistry?.find("deepseek", "deepseek-flash");
              extRouteCalls.push({
                reason: request.reason,
                model: request.model?.id,
                argsLength: arguments.length,
                ctxHasRegistry: !!ctx?.modelRegistry,
                foundId: found?.id ?? null,
              });
              try {
                if (!found) throw new Error("ctx.modelRegistry.find returned nothing");
                return { model: found, thinkingLevel: "high", state: { n: 2 } };
              } catch (e) {
                extRouteError = e;
                throw e;
              }
            },
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
    probe.check(
      "runtime-path-route-single-argument",
      routeCalls[0]?.argsLength === 1,
      `ModelRuntime-registered route received arguments.length=${routeCalls[0]?.argsLength} (ctx is undefined on this path; the router must resolve physical models through a captured ModelRuntime)`,
    );

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

    // ---------- Path B: extension pi.registerVirtualModel ----------
    // The extension registers the VM during session init; after
    // createAgentSession resolves it is visible on the model runtime. Switch
    // the live session to it with setModel, then prompt.
    const extVm = modelRuntime.getModel("probe-ext-router", "auto");
    probe.check(
      "ext-virtual-model-registered",
      !!extVm,
      `getModel('probe-ext-router','auto') after session init = ${extVm ? "found" : "NOT FOUND"}`,
    );
    if (extVm) {
      await session.setModel(extVm);
      await session.prompt("extension path turn");
      const extCall = extRouteCalls[0];
      probe.check(
        "ext-path-route-receives-ctx",
        extCall?.argsLength === 2 && extCall.ctxHasRegistry === true,
        `extension-registered route received arguments.length=${extCall?.argsLength}, ctx.modelRegistry present=${extCall?.ctxHasRegistry}`,
      );
      probe.check(
        "ext-path-ctx-resolves-physical-model",
        extCall?.foundId === "deepseek-flash",
        `ctx.modelRegistry.find('deepseek','deepseek-flash') inside route returned ${extCall?.foundId}`,
      );
      const extAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
      probe.check(
        "ext-path-dispatch-records-physical-model",
        extAssistant?.model === "deepseek-flash",
        `assistant message model after ext-path turn = ${extAssistant?.model}`,
      );
      probe.check("ext-route-no-error", extRouteError === null, extRouteError ? `ext route threw: ${extRouteError.message}` : "ext route never threw");
    }

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
        ? "Two route() paths verified live: ModelRuntime-registered VMs receive route(request) with exactly 1 argument, while extension-registered VMs receive route(request, ctx) with ctx.modelRegistry resolving physical models — both wrappers ship in the installed dist and both dispatch record the physical model. reasons (user/continuation/retry), previous/failed stickiness, and JSON state verified on the ModelRuntime path."
        : "route() contract deviates; see findings.",
    findings: probe.findings,
  };
}
