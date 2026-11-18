// PI-06: settled signal, auto-retry, manual compaction, and abort's
// relationship to the event stream (05 §2 contract: prompt accepted is not
// completion; agent_settled is the "no automatic continuation" signal).
//
// Compaction needs a session large relative to its context window, so it runs
// in a second child on a custom tiny-window model; retry/abort run on the
// real deepseek-flash catalog entry against the fake endpoint.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeOpenAIServer } from "../helpers/fake-openai-server.mjs";
import {
  createProbe,
  summarizeProbe,
  makeIsolatedAgentDir,
  makeWorkspaceDir,
  piEnv,
  spawnPiRpc,
  waitFor,
} from "../helpers/probe-utils.mjs";

export const ID = "PI-06";
export const TITLE = "agent_settled vs agent_end, auto-retry, compaction, abort";

const CLI = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

function makeRecorder() {
  const records = [];
  const onFrame = (f) => {
    try {
      records.push(JSON.parse(f.toString("utf8")));
    } catch {}
  };
  return { records, onFrame };
}

export async function run() {
  const probe = createProbe(ID, TITLE);

  // ---------- Phase 1: retry + abort on deepseek-flash ----------
  const server = createFakeOpenAIServer({
    scripts: [
      { kind: "error", status: 500, body: { error: { message: "probe scripted 500" } } },
      { kind: "text", text: "recovered after retry" },
      { kind: "text", text: "slow for abort", streamDelayMs: 700 },
    ],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();
  const rec = makeRecorder();
  const rpc = spawnPiRpc({
    cliPath: CLI,
    agentDir: agent.dir,
    env: piEnv(agent.dir),
    cwd: wsDir,
    onFrame: rec.onFrame,
  });
  const records = rec.records;
  const resp = (id, cmd) =>
    waitFor(
      () => records.find((r) => r.type === "response" && r.id === id && r.command === cmd),
      30000,
      50,
      `response ${cmd}`,
    );
  const events = (type) => records.filter((r) => r.type === type);
  const firstIdx = (type) => records.findIndex((r) => r.type === type);

  try {
    await rpc.send({ id: "sr", type: "set_auto_retry", enabled: true });
    const sr = await resp("sr", "set_auto_retry");
    probe.check("set_auto_retry", sr.success === true, `set_auto_retry: ${JSON.stringify(sr)}`);

    await rpc.send({ id: "p1", type: "prompt", message: "trigger retry" });
    await resp("p1", "prompt");
    await waitFor(() => events("agent_settled").length > 0, 40000, 50, "settled after retry");

    const retryStart = events("auto_retry_start")[0];
    const retryEnd = events("auto_retry_end")[0];
    const willRetryEnd = events("agent_end").find((e) => e.willRetry === true);
    probe.check(
      "auto-retry-events",
      !!retryStart && !!retryEnd && retryEnd.success === true,
      `auto_retry_start attempt=${retryStart?.attempt} maxAttempts=${retryStart?.maxAttempts} delayMs=${retryStart?.delayMs}; auto_retry_end success=${retryEnd?.success}`,
    );
    probe.check(
      "agent_end-willRetry-precedes-retry",
      !!willRetryEnd && firstIdx("agent_end") < firstIdx("auto_retry_start"),
      `first agent_end has willRetry=${willRetryEnd?.willRetry}; ordering agent_end < auto_retry_start: ${firstIdx("agent_end")} < ${firstIdx("auto_retry_start")}`,
    );
    probe.check(
      "agent_end-before-agent-settled",
      firstIdx("agent_end") < firstIdx("agent_settled"),
      `agent_end idx ${firstIdx("agent_end")} < agent_settled idx ${firstIdx("agent_settled")}`,
    );
    await rpc.send({ id: "t1", type: "get_last_assistant_text" });
    const t1 = await resp("t1", "get_last_assistant_text");
    probe.check(
      "retry-recovers-response",
      t1.data?.text === "recovered after retry",
      `text after retry: ${JSON.stringify(t1.data?.text)}`,
    );

    // abort mid-stream: capture the settled count BEFORE sending abort,
    // because the abort response itself resolves only after idle.
    const settledBeforeAbort = events("agent_settled").length;
    await rpc.send({ id: "p3", type: "prompt", message: "slow turn to abort" });
    await resp("p3", "prompt");
    await waitFor(() => records.some((r) => r.type === "message_update"), 20000, 50, "stream start");
    await rpc.send({ id: "ab", type: "abort" });
    const ab = await resp("ab", "abort");
    probe.check("abort-resolves-after-idle", ab.success === true, `abort response: ${JSON.stringify(ab)}`);
    const settledAfterAbort = await waitFor(
      () =>
        (events("agent_settled").length > settledBeforeAbort && events("agent_settled").at(-1)) ||
        events("agent_settled").at(-1)?.aborted === true,
      15000,
      50,
      "settled after abort",
    );
    probe.check(
      "settled-carries-aborted-flag",
      settledAfterAbort.aborted === true,
      `agent_settled after abort: ${JSON.stringify(settledAfterAbort)}`,
    );
    const hitsBeforeAbort = server.hits;
    await new Promise((r) => setTimeout(r, 2500));
    probe.check(
      "abort-stops-provider-work",
      server.hits === hitsBeforeAbort,
      `fake endpoint hits stayed at ${server.hits} after abort`,
    );
  } catch (e) {
    probe.check("phase-1", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    rpc.child.stdin.end();
    await new Promise((r) => rpc.child.once("exit", r));
    await server.stop();
    agent.cleanup();
  }

  // ---------- Phase 2: compaction on a small-window custom model ----------
  // Compaction needs tokensBefore > keepRecentTokens (default 20000). One
  // huge scripted response (~56k tokens) plus a small second turn gives a
  // compactable session while staying under the automatic-compaction
  // threshold of the declared window.
  const filler = "compaction filler text. ".repeat(9400); // ~263k chars ≈ 66k tokens
  const small = "small second turn";
  const server2 = createFakeOpenAIServer({
    scripts: [
      { kind: "text", text: filler },
      { kind: "text", text: small + " reply" },
      { kind: "text", text: "the summarized conversation so far" },
    ],
  });
  const port2 = await server2.start();
  const agent2 = makeIsolatedAgentDir({ modelsProvider: "probe-tiny", baseUrl: `http://127.0.0.1:${port2}` });
  writeFileSync(
    agent2.modelsPath,
    JSON.stringify(
      {
        $schema: "https://pi.dev/schemas/models.schema.json",
        providers: {
          "probe-tiny": {
            baseUrl: `http://127.0.0.1:${port2}`,
            api: "openai-completions",
            apiKey: "tiny-dummy",
            models: [{ id: "tiny-window-model", name: "Tiny", reasoning: false, contextWindow: 120000, maxTokens: 16384 }],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const wsDir2 = makeWorkspaceDir();
  const rec2 = makeRecorder();
  const rpc2 = spawnPiRpc({
    cliPath: CLI,
    agentDir: agent2.dir,
    env: piEnv(agent2.dir),
    cwd: wsDir2,
    provider: "probe-tiny",
    model: "tiny-window-model",
    thinking: null,
    onFrame: rec2.onFrame,
  });
  const records2 = rec2.records;
  const resp2 = (id, cmd) =>
    waitFor(
      () => records2.find((r) => r.type === "response" && r.id === id && r.command === cmd),
      40000,
      50,
      `response ${cmd}`,
    );
  try {
    await rpc2.send({ id: "q1", type: "prompt", message: "turn one long enough to matter" });
    await resp2("q1", "prompt");
    await waitFor(() => records2.some((r) => r.type === "agent_settled"), 40000, 50, "settled 1");
    await rpc2.send({ id: "q2", type: "prompt", message: "turn two to grow the context past the tiny window" });
    await resp2("q2", "prompt");
    await waitFor(
      () => records2.filter((r) => r.type === "agent_settled").length >= 2,
      40000,
      50,
      "settled 2",
    );
    await rpc2.send({ id: "c1", type: "compact" });
    const c1 = await resp2("c1", "compact");
    const cStart = records2.find((r) => r.type === "compaction_start");
    const cEnd = records2.find((r) => r.type === "compaction_end");
    probe.check(
      "manual-compaction-events",
      !!cStart && cStart.reason === "manual" && !!cEnd,
      `compaction_start reason=${cStart?.reason}; compaction_end present=${!!cEnd}`,
    );
    probe.check(
      "compact-response-usage",
      c1.success === true && !!c1.data?.summary && !!c1.data?.usage,
      `compact response: ${JSON.stringify(c1).slice(0, 300)}`,
    );
  } catch (e) {
    probe.check("phase-2-compaction", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    rpc2.child.stdin.end();
    await new Promise((r) => rpc2.child.once("exit", r));
    await server2.stop();
    agent2.cleanup();
  }

  const status = summarizeProbe(probe);
  return {
    id: ID,
    title: TITLE,
    status,
    summary:
      status === "PASS"
        ? "agent_settled is the only 'will not continue automatically' signal; agent_end(willRetry) precedes auto_retry_start/end; abort resolves after idle, marks settled.aborted, and stops provider work; manual compaction on a small context window emits start/end with summary and usage."
        : "lifecycle contract deviates; see findings.",
    findings: probe.findings,
  };
}
