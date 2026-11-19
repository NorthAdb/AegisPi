// PI-11: typebox schema support and complex-parameter validation.
// Register a tool with a strict typebox schema; scripted model calls hit it
// with valid, missing-required, and wrong-enum arguments. Validation must
// reject before execute; host-side business validation remains mandatory.

import * as pi from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { createFakeOpenAIServer } from "../helpers/fake-openai-server.mjs";
import {
  createProbe,
  summarizeProbe,
  makeIsolatedAgentDir,
  makeWorkspaceDir,
} from "../helpers/probe-utils.mjs";

export const ID = "PI-11";
export const TITLE = "typebox schema: complex params, negative cases rejected";

const params = Type.Object({
  mode: Type.Union([Type.Literal("fast"), Type.Literal("slow")]),
  target: Type.Object({
    repo: Type.String(),
    depth: Type.Optional(Type.Number()),
  }),
  reason: Type.String(),
});

export async function run() {
  const probe = createProbe(ID, TITLE);
  const server = createFakeOpenAIServer({
    scripts: [
      { kind: "tool_call", name: "probe_validated", args: { mode: "fast", target: { repo: "honojs/hono", depth: 2 }, reason: "ok" } },
      { kind: "tool_call", name: "probe_validated", args: { mode: "fast", target: { repo: "honojs/hono" } } },
      { kind: "tool_call", name: "probe_validated", args: { mode: "turbo", target: { repo: "x" }, reason: "bad enum" } },
      { kind: "text", text: "probe eleven done" },
    ],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();

  const executions = [];
  const resultEvents = [];

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
          ext.on("tool_result", async (event) => {
            if (event.toolName === "probe_validated") {
              resultEvents.push({
                isError: event.isError,
                content: JSON.stringify(event.content ?? "").slice(0, 240),
              });
            }
          });
          ext.registerTool({
            name: "probe_validated",
            label: "Validated",
            description: "strict typebox parameters",
            parameters: params,
            execute: async (_id, p) => {
              executions.push(p);
              return { content: [{ type: "text", text: `executed:${p.mode}:${p.target.repo}` }], details: {} };
            },
          });
        },
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
      }),
      noTools: true,
    });

    await session.prompt("probe eleven");
    probe.check(
      "valid-args-executed",
      executions.length === 1 && executions[0].mode === "fast" && executions[0].target.repo === "honojs/hono",
      `executions: ${JSON.stringify(executions)}`,
    );
    // Invalid calls: like blocked calls, validation failures surface as error
    // tool results in the transcript (visible in later provider request
    // bodies); the execute function never runs.
    const laterBodies = server.requests.slice(1).map((r) => r.body);
    const toolResults = laterBodies.flatMap((b) => (b?.messages ?? []).filter((m) => m.role === "tool"));
    const validationErrors = toolResults.map((m) => String(m.content)).filter((c) => c.toLowerCase().includes("required") || c.toLowerCase().includes("expected") || c.toLowerCase().includes("invalid") || c.toLowerCase().includes("enum"));
    probe.check(
      "missing-required-and-wrong-enum-rejected",
      executions.length === 1 && validationErrors.length >= 1,
      `executions stayed at 1; validation error tool results in later requests: ${JSON.stringify(validationErrors.slice(0, 2)).slice(0, 300)}`,
    );
    probe.check(
      "typebox-importable",
      typeof Type === "object" && Type !== null && typeof Type.Object === "function" && typeof Type.Union === "function" && typeof Type.Literal === "function",
      `typebox@1.3.27 exports Type as a namespace object with Object/Union/Literal builders`,
    );
    session.dispose();
  } catch (e) {
    probe.check("probe-run", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    await server.stop();
    agent.cleanup();
  }

  // Normative boundary statement (02/AGENTS) — a host duty, not a Pi fact.
  probe.note(
    "host-validation-still-mandatory",
    "typebox validation covers the declared schema only; business rules (ACL, budget, target allowlists) stay host-side — schema validation is not an authorization boundary",
  );

  const status = summarizeProbe(probe);
  return {
    id: ID,
    title: TITLE,
    status,
    summary:
      status === "PASS"
        ? "typebox (1.3.27) builds complex schemas (unions, nested objects, optionals) accepted by registerTool; invalid tool calls fail validation before execute and return error results; host business validation remains separate."
        : "schema contract deviates; see findings.",
    findings: probe.findings,
  };
}
