// PI-04: tool_call interception — block, reason, input mutation, and
// codemode nested-call visibility (nested ids `<parent>/<n>`).

import * as pi from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createFakeOpenAIServer } from "../helpers/fake-openai-server.mjs";
import {
  createProbe,
  summarizeProbe,
  makeIsolatedAgentDir,
  makeWorkspaceDir,
} from "../helpers/probe-utils.mjs";

export const ID = "PI-04";
export const TITLE = "tool_call interception: block/reason/mutate + nested codemode calls";

export async function run() {
  const probe = createProbe(ID, TITLE);
  const server = createFakeOpenAIServer({
    scripts: [
      { kind: "tool_call", name: "probe_blocker", args: { x: "will-be-blocked" } },
      { kind: "tool_call", name: "probe_mutate", args: { x: "original" } },
      { kind: "text", text: "probe four done" },
      { kind: "tool_call", name: "codemode", args: { code: 'const r = await tools.read({ path: "probe-pi04.txt" }); return r;' } },
      { kind: "text", text: "codemode turn done" },
    ],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();
  writeFileSync(join(wsDir, "probe-pi04.txt"), "probe file content", "utf8");

  const callEvents = [];
  const resultEvents = [];
  const executions = [];

  try {
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(agent.dir, "auth.json"),
      modelsPath: agent.modelsPath,
    });
    await modelRuntime.setRuntimeApiKey("deepseek", "probe-fake-key");

    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: wsDir,
      agentDir: agent.dir,
      extensionFactories: [
        (ext) => {
          ext.on("tool_call", async (event) => {
            callEvents.push({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              parentToolCallId: event.parentToolCallId,
              input: JSON.parse(JSON.stringify(event.input ?? {})),
            });
            if (event.toolName === "probe_blocker") {
              return { block: true, reason: "probe-pi04-block" };
            }
            if (event.toolName === "probe_mutate") {
              event.input.x = "mutated-by-extension";
              return undefined;
            }
            return undefined;
          });
          ext.on("tool_result", async (event) => {
            resultEvents.push({
              toolName: event.toolName,
              isError: event.isError,
              parentToolCallId: event.parentToolCallId,
              content: JSON.stringify(event.content ?? "").slice(0, 160),
            });
          });
          ext.registerTool({
            name: "probe_blocker",
            label: "Blocker",
            description: "blocked by the extension handler",
            parameters: { type: "object", properties: { x: { type: "string" } } },
            execute: async (_id, params) => {
              executions.push({ tool: "probe_blocker", params });
              return { content: [{ type: "text", text: "should not run" }], details: {} };
            },
          });
          ext.registerTool({
            name: "probe_mutate",
            label: "Mutate",
            description: "arguments mutated in place by the handler",
            parameters: { type: "object", properties: { x: { type: "string" } } },
            execute: async (_id, params) => {
              executions.push({ tool: "probe_mutate", params });
              return { content: [{ type: "text", text: "ran" }], details: {} };
            },
          });
        },
        pi.createCodemodeExtension(),
      ],
    });
    await resourceLoader.reload();

    const { session } = await pi.createAgentSession({
      agentDir: agent.dir,
      cwd: wsDir,
      model: modelRuntime.getModel("deepseek", "deepseek-flash"),
      thinkingLevel: "high",
      modelRuntime,
      resourceLoader,
      sessionManager: pi.SessionManager.inMemory(wsDir),
      settingsManager: pi.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        defaultTools: ["+codemode"],
      }),
    });

    // Turn 1: blocker call is blocked before execution.
    await session.prompt("turn one");
    probe.check(
      "blocker-not-executed",
      !executions.some((e) => e.tool === "probe_blocker"),
      `executions: ${JSON.stringify(executions)}`,
    );
    probe.check(
      "blocked-call-emits-no-tool-result-event",
      !resultEvents.some((r) => r.toolName === "probe_blocker"),
      `result events: ${JSON.stringify(resultEvents.map((r) => r.toolName))} — a blocked call surfaces tool_call but NOT tool_result in the extension pipeline`,
    );
    // The block reason becomes the tool result content in the next request.
    const followUpBody = JSON.stringify(server.requests.find((r, i) => i > 0 && JSON.stringify(r.body).includes("probe-pi04-block"))?.body ?? {});
    probe.check(
      "block-reason-becomes-tool-result",
      followUpBody.includes("probe-pi04-block"),
      `follow-up provider request carries the reason as the tool result content: ${followUpBody.slice(0, 200)}`,
    );

    // The agent loop continues after the blocked call (mutate turn follows).
    const mutateExec = executions.find((e) => e.tool === "probe_mutate");
    probe.check(
      "input-mutation-reaches-execute",
      !!mutateExec && mutateExec.params.x === "mutated-by-extension",
      `probe_mutate execution params: ${JSON.stringify(mutateExec?.params)}`,
    );

    // Turn 2: codemode nested tool call passes through the same handlers.
    await session.prompt("turn two codemode");
    const nestedRead = callEvents.find(
      (c) => c.toolName === "read" && c.parentToolCallId,
    );
    probe.check(
      "nested-codemode-call-visible",
      !!nestedRead,
      `nested read call event: ${JSON.stringify(nestedRead)}`,
    );
    const codemodeCall = callEvents.find((c) => c.toolName === "codemode");
    probe.check(
      "nested-parent-id-matches",
      !!codemodeCall && !!nestedRead && nestedRead.parentToolCallId === codemodeCall.toolCallId,
      `codemode toolCallId=${codemodeCall?.toolCallId}, nested read parentToolCallId=${nestedRead?.parentToolCallId}`,
    );
    const nestedResult = resultEvents.find(
      (r) => r.toolName === "read" && r.parentToolCallId,
    );
    probe.check(
      "nested-codemode-result-visible",
      !!nestedResult && nestedResult.content.includes("probe file content"),
      `nested read result event: ${JSON.stringify(nestedResult)}`,
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
        ? "tool_call intercepts block (with reason in the tool result), mutate input in place, and nested codemode calls flow through the same tool_call/tool_result pipeline with parentToolCallId. Host remains the security boundary regardless."
        : "interception contract deviates; see findings.",
    findings: probe.findings,
  };
}
