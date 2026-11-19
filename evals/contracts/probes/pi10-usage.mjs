// PI-10: usage fields and cost math — provider-reported usage parsed from
// the final SSE chunk, cost computed from catalog prices, and the
// missing-usage case (zeros, not "unknown") that the host ledger must treat
// conservatively.

import * as pi from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createFakeOpenAIServer } from "../helpers/fake-openai-server.mjs";
import {
  createProbe,
  summarizeProbe,
  makeIsolatedAgentDir,
  makeWorkspaceDir,
} from "../helpers/probe-utils.mjs";

export const ID = "PI-10";
export const TITLE = "usage parsing, catalog-based cost, missing-usage zeros";

export async function run() {
  const probe = createProbe(ID, TITLE);
  const server = createFakeOpenAIServer({
    scripts: [{ kind: "text", text: "pi10 reply", usage: { prompt_tokens: 100, completion_tokens: 50 } }],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();

  try {
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(agent.dir, "auth.json"),
      modelsPath: agent.modelsPath,
    });
    await modelRuntime.setRuntimeApiKey("deepseek", "probe-fake-key");

    const messageEnds = [];
    const messageUpdates = [];
    const { session } = await pi.createAgentSession({
      agentDir: agent.dir,
      cwd: wsDir,
      model: modelRuntime.getModel("deepseek", "deepseek-flash"),
      thinkingLevel: "high",
      modelRuntime,
      resourceLoader: new pi.DefaultResourceLoader({ cwd: wsDir, agentDir: agent.dir, extensionFactories: [] }),
      sessionManager: pi.SessionManager.inMemory(wsDir),
      settingsManager: pi.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      tools: [],
    });
    const unsub = session.subscribe((event) => {
      if (event.type === "message_end") messageEnds.push(event);
      if (event.type === "message_update") messageUpdates.push(event);
    });

    await session.prompt("pi10 turn");
    const msg = messageEnds.at(-1)?.message;
    probe.check(
      "usage-fields-present",
      !!msg?.usage && typeof msg.usage.input === "number" && typeof msg.usage.output === "number",
      `usage: ${JSON.stringify(msg?.usage)}`,
    );
    if (msg?.usage) {
      const u = msg.usage;
      probe.check(
        "usage-values-from-final-chunk",
        u.input === 100 && u.output === 50 && u.totalTokens === 150,
        `input=${u.input} output=${u.output} totalTokens=${u.totalTokens}`,
      );
      const expectedInputCost = (100 / 1e6) * 0.3;
      const expectedOutputCost = (50 / 1e6) * 1.2;
      const expectedTotal = expectedInputCost + expectedOutputCost;
      probe.check(
        "cost-computed-from-catalog-prices",
        Math.abs(u.cost.input - expectedInputCost) < 1e-12 &&
          Math.abs(u.cost.output - expectedOutputCost) < 1e-12 &&
          Math.abs(u.cost.total - expectedTotal) < 1e-12,
        `cost.input=${u.cost.input} (expected ${expectedInputCost}), cost.output=${u.cost.output} (expected ${expectedOutputCost}), cost.total=${u.cost.total}`,
      );
      // Measured shape (audit round 1, P1-2): cost.totalFromProvider EXISTS
      // as an optional boolean — false on the standard path (pi-ai models.js
      // sets it false; openrouter-cost.js sets true when the provider
      // reports cost). It is never a number, so a ledger must not sum from
      // it. This assertion fails if the field's type ever changes.
      probe.check(
        "cost-totalFromProvider-is-boolean-false",
        typeof u.cost.totalFromProvider === "boolean" && u.cost.totalFromProvider === false,
        `cost.totalFromProvider = ${JSON.stringify(u.cost.totalFromProvider)} (typeof ${typeof u.cost.totalFromProvider}); declared totalFromProvider?: boolean in pi-ai dist/types.d.ts; ledger sums input+output+cache itself per 06 §8`,
      );
    }
    probe.check(
      "sdk-message_update-no-usage",
      messageUpdates.length > 0 && messageUpdates.every((m) => m.usage === undefined || m.usage === null),
      `SDK message_update events (${messageUpdates.length}) do not carry usage; usage is authoritative on message_end.message.usage (JSON/RPC mode adds usage to message_update records per docs/json.md)`,
    );
    unsub();
    session.dispose();
  } catch (e) {
    probe.check("scenario-usage", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    await server.stop();
    agent.cleanup();
  }

  // Missing usage: provider streams no usage chunk at all.
  const server2 = createFakeOpenAIServer({ scripts: [] });
  // raw_sse with no chunks produces only [DONE]; craft minimal valid stream
  // without usage:
  const noUsageChunks = [
    `data: ${JSON.stringify({
      id: "chatcmpl-pi10b",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: { role: "assistant", content: "no usage here" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-pi10b",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  ];
  server2.pushScript({ kind: "raw_sse", chunks: noUsageChunks });
  const port2 = await server2.start();
  const agent2 = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port2}` });
  try {
    const runtime2 = await pi.ModelRuntime.create({
      authPath: join(agent2.dir, "auth.json"),
      modelsPath: agent2.modelsPath,
    });
    await runtime2.setRuntimeApiKey("deepseek", "probe-fake-key");
    const { session } = await pi.createAgentSession({
      agentDir: agent2.dir,
      cwd: wsDir,
      model: runtime2.getModel("deepseek", "deepseek-flash"),
      modelRuntime: runtime2,
      resourceLoader: new pi.DefaultResourceLoader({ cwd: wsDir, agentDir: agent2.dir, extensionFactories: [] }),
      sessionManager: pi.SessionManager.inMemory(wsDir),
      settingsManager: pi.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      tools: [],
    });
    const ends = [];
    const unsub = session.subscribe((e) => {
      if (e.type === "message_end") ends.push(e);
    });
    await session.prompt("pi10 no usage");
    unsub();
    const u = ends.at(-1)?.message?.usage;
    // Assert the ACTUAL measured shape (audit round 2 N3): with provider
    // omission the token/cost numbers are all zero AND cost carries no
    // totalFromProvider key at all (pi-ai only sets that flag on the
    // usage-present path). Zeros here are indistinguishable from "provider
    // omitted usage" — this is NOT settlement evidence, and the check name
    // and detail must not frame it as a successful zero-cost settlement.
    probe.check(
      "missing-usage-shape-zeros-no-provider-total",
      !!u && u.input === 0 && u.output === 0 && !!u.cost && !("totalFromProvider" in u.cost),
      `usage with provider omission: ${JSON.stringify(u)} — numbers are all zero AND cost has no totalFromProvider key (absent, not false, not a number). Nothing here proves a zero-cost outcome; the host ledger (Phase 2, not yet implemented) must hold such responses un-settled (HELD) until a trustworthy usage or bill arrives (06 §8)`,
    );
    session.dispose();
  } catch (e) {
    probe.check("scenario-missing-usage", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    await server2.stop();
    agent2.cleanup();
  }

  // Normative ledger rule (06 §8) — a host duty, not a Pi property. It is
  // a note here BY DESIGN: the real HELD gate lives in the host ledger,
  // which does not exist yet (Phase 2). Until then this stays an open item,
  // NOT a satisfied requirement — see phase1-open-items.md. The falsifiable
  // shape facts live in cost-totalFromProvider-is-boolean-false and
  // missing-usage-shape-zeros-no-provider-total above.
  probe.note(
    "ledger-sums-itself",
    "usage carries per-field numbers only (input/output/cache*, cost.total) with cost.totalFromProvider as a boolean flag on the usage-present path and ABSENT on the omission path — never a provider-reported total; the Phase 2 ledger must sum input+output+cache itself and treat missing usage as un-settled (HELD). The host-side HELD gate is not implemented in Phase 1 and is not claimed as done.",
  );

  const status = summarizeProbe(probe);
  return {
    id: ID,
    title: TITLE,
    status,
    summary:
      status === "PASS"
        ? "Usage parses from the final streamed chunk (input/output/totalTokens), cost derives from catalog prices (deepseek-flash 0.3/1.2), cost.totalFromProvider is a boolean false on the usage-present path, and the provider-omission path yields all-zero numbers with NO totalFromProvider key on cost — an untrustworthy shape for settlement, recorded as such. The host-side HELD ledger is Phase 2 work, explicitly not claimed as done here."
        : "usage contract deviates; see findings.",
    findings: probe.findings,
  };
}
