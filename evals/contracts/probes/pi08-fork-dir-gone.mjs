// PI-08: session fork when the original working directory is gone.
// 1.5.2 changelog: "Fork sessions whose folder is gone". Verifies the RPC
// resume error path and the --fork recovery path into a fresh cwd.

import { readdirSync, rmSync, existsSync, readFileSync } from "node:fs";
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

export const ID = "PI-08";
export const TITLE = "fork with original directory gone; resume error path";

const CLI = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

export async function run() {
  const probe = createProbe(ID, TITLE);
  assertChildNodeLocked(probe);
  const server = createFakeOpenAIServer({
    scripts: [
      { kind: "text", text: "pi08 original response" },
      { kind: "text", text: "pi08 forked response" },
    ],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsA = makeWorkspaceDir();
  const wsB = makeWorkspaceDir();
  const sessDir = makeWorkspaceDir();

  let sessionFile = null;

  // 1. Create a persistent session in wsA.
  const records = [];
  const rpc = spawnPiRpc({
    cliPath: CLI,
    agentDir: agent.dir,
    sessionDir: sessDir,
    noSession: false,
    extraArgs: ["--name", "pi08"],
    env: piEnv(agent.dir),
    cwd: wsA,
    onFrame: (f) => {
      try {
        records.push(JSON.parse(f.toString("utf8")));
      } catch {}
    },
  });
  try {
    await rpc.send({ id: "p1", type: "prompt", message: "pi08 original turn" });
    await waitFor(
      () => records.find((r) => r.type === "response" && r.command === "prompt"),
      25000,
      50,
      "prompt response",
    );
    await waitFor(() => records.some((r) => r.type === "agent_settled"), 25000, 50, "settled");
    await rpc.send({ id: "gs", type: "get_state" });
    const gs = await waitFor(
      () => records.find((r) => r.type === "response" && r.command === "get_state"),
      10000,
      50,
      "get_state",
    );
    sessionFile = gs.data?.sessionFile;
    probe.check("persistent-session-created", !!sessionFile && existsSync(sessionFile), `sessionFile=${sessionFile}`);
    rpc.child.stdin.end();
    await new Promise((r) => rpc.child.once("exit", r));
  } catch (e) {
    probe.check("persistent-session-created", false, `setup failed: ${e.message}`);
    rpc.child.kill();
  }

  // 2. Original directory disappears.
  rmSync(wsA, { recursive: true, force: true });
  probe.check("original-dir-removed", !existsSync(wsA), `wsA deleted; session file remains at ${sessionFile}`);

  // 3. RPC resume with the dir gone: per changelog, non-interactive modes
  //    exit with an error instead of offering Continue/Fork/Cancel.
    const resumeOut = await new Promise((resolve) => {
      const child = spawnPiRpc({
      cliPath: CLI,
      agentDir: agent.dir,
      sessionDir: sessDir,
      noSession: false,
      extraArgs: ["--session", sessionFile ?? "missing"],
      env: piEnv(agent.dir),
      cwd: wsB,
      onFrame: () => {},
      onStderr: () => {},
    });
    let stderrText = "";
    child.child.stderr.on("data", (c) => (stderrText += c.toString("utf8")));
    const timer = setTimeout(() => {
      child.child.kill();
      resolve({ code: "timeout", stderrText });
    }, 30000);
    child.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderrText });
    });
  });
  probe.check(
    "rpc-resume-with-gone-dir-errors",
    resumeOut.code !== 0,
    `RPC resume exit code=${resumeOut.code}; stderr: ${String(resumeOut.stderrText).trim().slice(0, 240)}`,
  );

  // 4. Fork into the current directory (--fork), the documented recovery.
  const forkRecords = [];
  const forkRpc = spawnPiRpc({
    cliPath: CLI,
    agentDir: agent.dir,
    sessionDir: sessDir,
    noSession: false,
    extraArgs: ["--fork", sessionFile ?? "missing"],
    env: piEnv(agent.dir),
    cwd: wsB,
    onFrame: (f) => {
      try {
        forkRecords.push(JSON.parse(f.toString("utf8")));
      } catch {}
    },
  });
  try {
    await forkRpc.send({ id: "gs2", type: "get_state" });
    const gs2 = await waitFor(
      () => forkRecords.find((r) => r.type === "response" && r.id === "gs2"),
      30000,
      50,
      "forked get_state",
    );
    const forkedFile = gs2.data?.sessionFile;
    probe.check(
      "fork-into-new-dir-works",
      gs2.success === true && !!forkedFile && forkedFile !== sessionFile,
      `forked session file=${forkedFile}`,
    );
    await forkRpc.send({ id: "ge", type: "get_entries" });
    const ge = await waitFor(
      () => forkRecords.find((r) => r.type === "response" && r.id === "ge"),
      15000,
      50,
      "forked entries",
    );
    const texts = JSON.stringify(ge.data?.entries ?? []);
    probe.check(
      "fork-preserves-conversation",
      texts.includes("pi08 original turn"),
      `forked entries contain the original prompt: ${texts.slice(0, 160)}`,
    );
    if (forkedFile && existsSync(forkedFile)) {
      const header = JSON.parse(readFileSync(forkedFile, "utf8").split("\n")[0]);
      probe.check(
        "fork-header-parent-session",
        !!header.parentSession,
        `header parentSession=${header.parentSession} cwd=${header.cwd}`,
      );
    }
    forkRpc.child.stdin.end();
    await new Promise((r) => forkRpc.child.once("exit", r));
  } catch (e) {
    probe.check("fork-into-new-dir-works", false, `fork failed: ${e.message}`);
    forkRpc.child.kill();
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
        ? "1.5.2 fork-when-folder-gone verified: RPC resume of a session whose cwd vanished errors out (no interactive offer), while --fork <path> from a new cwd creates a new session with the full conversation and a parentSession header. Workspace loss is recoverable by the host via fork; external state is NOT restored by this mechanism."
        : "fork contract deviates; see findings.",
    findings: probe.findings,
  };
}
