// PI-05: RPC commands — prompt/steer/follow_up/clear_queue/abort payload and
// response shapes, correlated by id, against the real CLI in RPC mode.

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
  assertChildNodeLocked,
} from "../helpers/probe-utils.mjs";

export const ID = "PI-05";
export const TITLE = "RPC commands: payloads, responses, id correlation, queues";

const CLI = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

export async function run() {
  const probe = createProbe(ID, TITLE);
  assertChildNodeLocked(probe);
  const server = createFakeOpenAIServer({
    scripts: [
      { kind: "text", text: "probe five response" },
      { kind: "text", text: "slow stream", delayMs: 2500 },
      { kind: "text", text: "post-abort response" },
    ],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();

  const records = [];
  const rpc = spawnPiRpc({
    cliPath: CLI,
    agentDir: agent.dir,
    env: piEnv(agent.dir),
    cwd: wsDir,
    onFrame: (f) => {
      try {
        records.push(JSON.parse(f.toString("utf8")));
      } catch {}
    },
  });

  const resp = (id, cmd) =>
    waitFor(
      () => records.find((r) => r.type === "response" && (r.id === id || (!id && r.command === cmd))),
      25000,
      50,
      `response ${cmd} ${id ?? ""}`,
    );
  const events = (type) => records.filter((r) => r.type === type);

  try {
    // get_state
    await rpc.send({ id: "g1", type: "get_state" });
    const g1 = await resp("g1", "get_state");
    probe.check(
      "get_state-shape",
      g1.success === true &&
        g1.data?.model?.id === "deepseek-flash" &&
        g1.data?.thinkingLevel === "high" &&
        g1.data?.isStreaming === false,
      `get_state data: model=${g1.data?.model?.id} thinking=${g1.data?.thinkingLevel} streaming=${g1.data?.isStreaming}`,
    );

    // get_available_models
    await rpc.send({ id: "g2", type: "get_available_models" });
    const g2 = await resp("g2", "get_available_models");
    const ids = (g2.data?.models ?? []).map((m) => `${m.provider}/${m.id}`);
    probe.check(
      "available-models-list",
      ids.includes("deepseek/deepseek-flash"),
      `available: ${ids.slice(0, 6).join(", ")}${ids.length > 6 ? " …" : ""}`,
    );

    // set_model invalid
    await rpc.send({ id: "g3", type: "set_model", provider: "nope", modelId: "nope" });
    const g3 = await resp("g3", "set_model");
    probe.check(
      "set_model-invalid-rejected",
      g3.success === false && typeof g3.error === "string",
      `error: ${g3.error}`,
    );

    // prompt → disposition started → settled → last text
    await rpc.send({ id: "p1", type: "prompt", message: "probe five" });
    const p1 = await resp("p1", "prompt");
    probe.check(
      "prompt-disposition-started",
      p1.success === true && p1.data?.disposition === "started",
      `disposition=${p1.data?.disposition}`,
    );
    await waitFor(() => events("agent_settled").length > 0, 20000, 50, "agent_settled");
    await rpc.send({ id: "g4", type: "get_last_assistant_text" });
    const g4 = await resp("g4", "get_last_assistant_text");
    probe.check(
      "last-assistant-text",
      g4.data?.text === "probe five response",
      `text=${JSON.stringify(g4.data?.text)}`,
    );

    // id correlation with two outstanding commands
    await rpc.send({ id: "a1", type: "get_state" });
    await rpc.send({ id: "a2", type: "get_session_stats" });
    const [a1, a2] = await Promise.all([resp("a1", "get_state"), resp("a2", "get_session_stats")]);
    probe.check(
      "id-correlation",
      a1.id === "a1" && a2.id === "a2" && a1.command === "get_state" && a2.command === "get_session_stats",
      `out-of-order-safe correlation held: a1=${a1.command}, a2=${a2.command}`,
    );

    // steer / follow_up during streaming, then clear_queue + abort
    await rpc.send({ id: "p2", type: "prompt", message: "slow turn" });
    await resp("p2", "prompt");
    await waitFor(
      () => records.some((r) => r.type === "message_update"),
      20000,
      50,
      "streaming to start",
    );
    await rpc.send({ id: "s1", type: "steer", message: "steered instruction" });
    const s1 = await resp("s1", "steer");
    probe.check("steer-queued", s1.success === true && s1.data?.disposition === "queued", `steer disposition=${s1.data?.disposition}`);
    await rpc.send({ id: "f1", type: "follow_up", message: "follow up instruction" });
    const f1 = await resp("f1", "follow_up");
    probe.check(
      "follow_up-queued",
      f1.success === true && f1.data?.disposition === "queued",
      `follow_up disposition=${f1.data?.disposition}`,
    );
    const queued = await waitFor(
      () => events("queue_update").find((q) => (q.steering ?? []).length > 0 && (q.followUp ?? []).length > 0),
      10000,
      50,
      "queue_update with both",
    );
    probe.check(
      "queue_update-carries-both",
      queued.steering.includes("steered instruction") && queued.followUp.includes("follow up instruction"),
      `queue_update steering=${JSON.stringify(queued.steering)} followUp=${JSON.stringify(queued.followUp)}`,
    );
    await rpc.send({ id: "cq", type: "clear_queue" });
    const cq = await resp("cq", "clear_queue");
    probe.check(
      "clear_queue-returns-texts",
      cq.success === true &&
        cq.data?.steering?.includes("steered instruction") &&
        cq.data?.followUp?.includes("follow up instruction"),
      `cleared: ${JSON.stringify(cq.data)}`,
    );
    await rpc.send({ id: "ab", type: "abort" });
    const ab = await resp("ab", "abort");
    probe.check("abort-success-after-idle", ab.success === true, `abort response: ${JSON.stringify(ab)}`);

    // malformed JSON → parse response without request id
    await rpc.sendRaw(Buffer.from('{"type":"get_state", bad json\n', "utf8"));
    const parseResp = await waitFor(
      () => records.find((r) => r.type === "response" && r.command === "parse"),
      10000,
      50,
      "parse response",
    );
    probe.check(
      "malformed-json-parse-response",
      parseResp.success === false && parseResp.id === undefined,
      `parse error response: ${JSON.stringify(parseResp).slice(0, 140)}`,
    );

    // bash command with id-correlated stream events
    await rpc.send({ id: "b1", type: "bash", command: 'echo probe05-bash' });
    const b1 = await resp("b1", "bash");
    const bashEvents = records.filter((r) => r.type === "bash_execution_update" && r.id === "b1");
    probe.check(
      "bash-stream-and-result",
      b1.success === true && b1.data?.exitCode === 0 && String(b1.data?.output).includes("probe05-bash") && bashEvents.length > 0,
      `bash result: exit=${b1.data?.exitCode} output=${JSON.stringify(b1.data?.output).slice(0, 60)}; ${bashEvents.length} correlated update event(s)`,
    );

    // entries cursor
    await rpc.send({ id: "e1", type: "get_entries" });
    const e1 = await resp("e1", "get_entries");
    const leafId = e1.data?.leafId;
    await rpc.send({ id: "e2", type: "get_entries", since: leafId });
    const e2 = await resp("e2", "get_entries");
    probe.check(
      "entries-cursor",
      e1.success === true && e2.success === true && Array.isArray(e2.data?.entries),
      `entries=${e1.data?.entries?.length} leafId=${String(leafId).slice(0, 8)} after-cursor=${e2.data?.entries?.length}`,
    );

    // new_session + fork
    await rpc.send({ id: "ns", type: "new_session" });
    const ns = await resp("ns", "new_session");
    probe.check("new_session", ns.success === true && ns.data?.cancelled === false, `new_session: ${JSON.stringify(ns.data)}`);
    await rpc.send({ id: "p3", type: "prompt", message: "to fork" });
    await resp("p3", "prompt");
    await waitFor(
      () => records.filter((r) => r.type === "agent_settled").length >= 2,
      20000,
      50,
      "second settled",
    );
    await rpc.send({ id: "fm", type: "get_fork_messages" });
    const fm = await resp("fm", "get_fork_messages");
    const entryId = fm.data?.messages?.[0]?.entryId;
    probe.check(
      "get_fork_messages",
      fm.success === true && !!entryId,
      `fork candidates: ${fm.data?.messages?.length ?? 0}`,
    );
    if (entryId) {
      await rpc.send({ id: "fk", type: "fork", entryId });
      const fk = await resp("fk", "fork");
      probe.check(
        "fork-returns-text",
        fk.success === true && fk.data?.text === "to fork",
        `fork text: ${JSON.stringify(fk.data?.text)}`,
      );
    }

    // set_session_name
    await rpc.send({ id: "sn", type: "set_session_name", name: "probe-pi05" });
    const sn = await resp("sn", "set_session_name");
    await rpc.send({ id: "gs", type: "get_state" });
    const gs = await resp("gs", "get_state");
    probe.check(
      "set_session_name",
      sn.success === true && gs.data?.sessionName === "probe-pi05",
      `sessionName=${gs.data?.sessionName}`,
    );
  } catch (e) {
    probe.check("probe-run", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    rpc.child.stdin.end();
    await new Promise((r) => rpc.child.once("exit", r));
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
        ? "All core RPC commands verified live: dispositions (started/queued), id correlation under concurrent commands, queue_update contents, clear_queue returning texts, abort-after-idle, parse-error response without id, correlated bash streaming, entry cursors, fork and session naming."
        : "RPC command contract deviates; see findings.",
    findings: probe.findings,
  };
}
