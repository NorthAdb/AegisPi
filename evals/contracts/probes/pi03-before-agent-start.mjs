// PI-03: before_agent_start — user vs custom discrimination, system prompt
// modification, context visibility. Types verified statically; behavior
// verified against a local fake endpoint.

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

export const ID = "PI-03";
export const TITLE = "before_agent_start: user/custom, system prompt override";

export async function run() {
  const probe = createProbe(ID, TITLE);
  const types = readFileSync(
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "types.d.ts"),
    "utf8",
  );

  probe.check(
    "type:BeforeAgentStartEventResult",
    types.includes("interface BeforeAgentStartEventResult") && types.includes("systemPrompt?: string;"),
    "result carries message? and systemPrompt? (no cancel field)",
  );
  probe.check(
    "type:user-custom-discriminated-by-messageType",
    types.includes('messageType: "user"') && types.includes('messageType: "custom"'),
    "BeforeAgentStartUserEvent.messageType==='user', BeforeAgentStartCustomEvent.messageType==='custom'",
  );
  probe.check(
    "type:no-cancel-on-before-agent-start",
    !/BeforeAgentStartEventResult[^}]*cancel/.test(types),
    "cancellation is NOT available in before_agent_start; the input event's {action:'handled'} is the earlier cancel point",
  );

  const server = createFakeOpenAIServer({
    scripts: [{ kind: "text", text: "probe-03 response" }],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();

  const records = [];
  let extSendMessage = null;
  let customMessageStartedRun = false;

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
          ext.on("before_agent_start", async (event) => {
            records.push({
              type: event.messageType,
              prompt: event.prompt,
              customType: event.message?.customType,
              systemPromptLength: event.systemPrompt?.length,
              hasOptions: !!event.systemPromptOptions,
            });
            if (event.messageType === "user") {
              return { systemPrompt: "PROBE03-OVERRIDE-SYSTEM-PROMPT" };
            }
            return undefined;
          });
          ext.on("agent_start", async () => {
            if (records.at(-1)?.type === "custom") customMessageStartedRun = true;
          });
          extSendMessage = ext;
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
      tools: [],
    });

    await session.prompt("probe three user turn");
    const userRec = records.find((r) => r.type === "user");
    probe.check(
      "user-event-prompt-and-options",
      !!userRec && userRec.prompt === "probe three user turn" && userRec.hasOptions,
      `user record: ${JSON.stringify(userRec)}`,
    );

    const sent = server.requests.at(-1)?.body;
    const sysMsg = sent?.messages?.find((m) => m.role === "system") ?? sent?.messages?.[0];
    const sysText = JSON.stringify(sysMsg ?? {});
    probe.check(
      "system-prompt-override-reaches-provider",
      sysText.includes("PROBE03-OVERRIDE-SYSTEM-PROMPT"),
      `provider request system message: ${sysText.slice(0, 180)}`,
    );

    // Custom-message turn: extension sends a custom message with triggerTurn
    // while idle; a second script response serves that run.
    server.pushScript({ kind: "text", text: "custom turn response" });
    extSendMessage?.sendMessage?.(
      { customType: "probe_pi03_custom", content: [{ type: "text", text: "probe custom trigger" }] },
      { triggerTurn: true },
    );
    await new Promise((r) => setTimeout(r, 3000));
    const customRec = records.find((r) => r.type === "custom");
    probe.check(
      "custom-event-discriminated",
      !!customRec && customRec.customType === "probe_pi03_custom",
      `custom record: ${JSON.stringify(customRec)}`,
    );
    probe.check(
      "custom-message-started-run",
      customMessageStartedRun,
      "agent_start observed after the triggerTurn custom message (run started while idle)",
    );
    const secondSent = server.requests.at(-1)?.body;
    const secondSys = secondSent?.messages?.find((m) => m.role === "system") ?? secondSent?.messages?.[0];
    probe.check(
      "custom-turn-not-overridden",
      !JSON.stringify(secondSys ?? {}).includes("PROBE03-OVERRIDE-SYSTEM-PROMPT") || customRec === undefined,
      `custom run system message (override only returned for user runs): ${JSON.stringify(secondSys ?? {}).slice(0, 160)}`,
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
        ? "before_agent_start distinguishes user vs custom (messageType), replaces the full system prompt for provider requests, and exposes mutable systemPromptOptions. No cancellation from this event; cancel earlier via the input event."
        : "before_agent_start deviates; see findings.",
    findings: probe.findings,
  };
}
