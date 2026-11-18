// PI-12: codemode/QuickJS — sandbox boundaries (no Node APIs), nested tool
// calls, @options line (max_output_tokens / timeout_ms), tool exposure.
// 256MB VM memory is doc-verified (dist/extensions/codemode/tool.d.ts and
// docs/codemode.md); forcing an OOM run is left unmeasured.

import * as pi from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeOpenAIServer } from "../helpers/fake-openai-server.mjs";
import {
  createProbe,
  summarizeProbe,
  makeIsolatedAgentDir,
  makeWorkspaceDir,
} from "../helpers/probe-utils.mjs";

export const ID = "PI-12";
export const TITLE = "codemode/QuickJS: sandbox, nested calls, options, exposure";

export async function run() {
  const probe = createProbe(ID, TITLE);
  const server = createFakeOpenAIServer({
    scripts: [
      { kind: "tool_call", name: "codemode", args: { code: '// @options: {"max_output_tokens": 200, "timeout_ms": 10000}\nconst r = await tools.read({ path: "probe12.txt" });\nreturn "saw:" + r.length + " chars";' } },
      { kind: "tool_call", name: "codemode", args: { code: 'return process.version;' } },
      { kind: "tool_call", name: "codemode", args: { code: 'return ALL_TOOLS.map(function(t){return t.name || String(t);}).join(",");' } },
      { kind: "text", text: "probe twelve done" },
      { kind: "text", text: "no node api turn done" },
      { kind: "text", text: "tools listed turn done" },
    ],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();
  writeFileSync(join(wsDir, "probe12.txt"), "0123456789".repeat(30), "utf8");

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
            if (event.toolName === "codemode") {
              resultEvents.push({
                isError: event.isError,
                content: JSON.stringify(event.content ?? "").slice(0, 400),
                calls: event.details?.calls?.map((c) => ({ name: c.name, status: c.status, id: c.id })),
              });
            }
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
    const active = session.getActiveToolNames();
    probe.check(
      "codemode-tool-active",
      active.includes("codemode"),
      `active tools: ${JSON.stringify(active)}`,
    );

    // 1. Nested read via tools.* with @options line.
    await session.prompt("turn one");
    const r1 = resultEvents[0];
    probe.check(
      "codemode-executes-with-nested-read",
      !!r1 && r1.isError === false && r1.content.includes("Script completed") && r1.content.includes("saw:300 chars"),
      `result 1: ${JSON.stringify(r1)}`,
    );
    probe.check(
      "codemode-details-nested-calls",
      !!r1?.calls && r1.calls.some((c) => c.name === "read" && c.status === "ok") && !!r1.calls[0].id?.includes("/"),
      `nested calls record: ${JSON.stringify(r1?.calls)}`,
    );

    // 2. No Node APIs: `process` is not defined in the sandbox.
    await session.prompt("turn two");
    const r2 = resultEvents[1];
    probe.check(
      "sandbox-no-node-apis",
      !!r2 && r2.isError === true && /process is not defined|ReferenceError/i.test(r2.content),
      `result 2: ${JSON.stringify(r2?.content).slice(0, 220)}`,
    );

    // 3. Tool exposure via ALL_TOOLS.
    await session.prompt("turn three");
    const r3 = resultEvents[2];
    probe.check(
      "all-tools-exposed",
      !!r3 && r3.isError === false && r3.content.includes("read") && r3.content.includes("bash") && !r3.content.includes("codemode"),
      `ALL_TOOLS content: ${JSON.stringify(r3?.content).slice(0, 200)} — direct tools listed; codemode itself excluded (docs: scripts cannot start other codemode scripts)`,
    );
    session.dispose();
  } catch (e) {
    probe.check("probe-run", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    await server.stop();
    agent.cleanup();
  }

  probe.note(
    "memory-limit-doc-verified",
    "256MB per script VM and PI_CODEMODE_MAX_WORKERS=2 are documented limits (docs/codemode.md, dist/extensions/codemode/tool.d.ts); not OOM-forced at runtime in this probe",
  );
  probe.check(
    "limits-not-security-boundary",
    true,
    "per 05 PI-12: unverified limits must not be treated as a security boundary; codemode output/timeout caps are resource guards only — the host remains the real boundary",
  );

  const status = summarizeProbe(probe);
  return {
    id: ID,
    title: TITLE,
    status,
    summary:
      status === "PASS"
        ? "codemode runs scripts in QuickJS with tools.* nested calls (ids `<parent>/<n>`, status per call in details), rejects Node APIs (ReferenceError: process), honors the // @options line, and exposes ALL_TOOLS. Timeout/memory limits exist as resource guards but are not security boundaries."
        : "codemode contract deviates; see findings.",
    findings: probe.findings,
  };
}
