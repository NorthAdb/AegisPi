// PI-07: extension UI in RPC mode — confirm/select dialogs cross the process
// boundary as extension_ui_request/response records; timeout auto-resolves;
// nothing survives a process kill, so the host must own durable parking.

import { writeFileSync, mkdirSync, rmSync } from "node:fs";import { join } from "node:path";
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

export const ID = "PI-07";
export const TITLE = "extension UI: RPC dialogs, timeouts, no persistence across restart";

const CLI = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

const EXTENSION = `export default function (pi) {
  pi.registerCommand("probe_ui", {
    description: "exercise UI dialogs",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm({ title: "Probe confirm", message: "Allow?", timeout: 8000 });
      await ctx.ui.notify({ message: "probe-result confirmed=" + confirmed });
      const picked = await ctx.ui.select({ title: "Probe select", options: ["A", "B"], timeout: 8000 });
      await ctx.ui.notify({ message: "probe-result picked=" + picked });
      const edited = await ctx.ui.editor({ title: "Probe editor", prefill: "draft" });
      await ctx.ui.notify({ message: "probe-result edited=" + edited });
    },
  });
  pi.registerCommand("probe_ui_timeout", {
    description: "dialog that times out",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm({ title: "Probe timeout", message: "Ignore me", timeout: 1500 });
      await ctx.ui.notify({ message: "probe-timeout confirmed=" + confirmed });
    },
  });
}
`;

function uiRequests(records) {
  return records.filter((r) => r.type === "extension_ui_request");
}
function notifyTexts(records) {
  return uiRequests(records)
    .filter((r) => r.method === "notify")
    .map((r) => {
      // Actual wire shape: message is a nested object {"message": "..."}.
      const m = r.message;
      return typeof m === "string" ? m : (m?.message ?? JSON.stringify(m));
    });
}

export async function run() {
  const probe = createProbe(ID, TITLE);
  const server = createFakeOpenAIServer({ scripts: [] });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();
  // Agent-dir extension, registered through settings.json "extensions" so it
  // loads without project trust (RPC mode has no TTY to prompt).
  mkdirSync(join(agent.dir, "extensions"), { recursive: true });
  const extPath = join(agent.dir, "extensions", "probe-ui.mjs");
  writeFileSync(extPath, EXTENSION, "utf8");
  writeFileSync(
    join(agent.dir, "settings.json"),
    JSON.stringify({ extensions: [extPath] }, null, 2),
    "utf8",
  );

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
      () => records.find((r) => r.type === "response" && r.id === id && r.command === cmd),
      25000,
      50,
      `response ${cmd}`,
    );

  try {
    // The extension command runs three dialogs back-to-back and blocks until
    // all resolve; the prompt response arrives only after the last dialog.
    // Live wire shape (deviation from docs/rpc-extension-ui.md): every dialog
    // request nests its whole options object under a single field named after
    // the first option key, e.g. title={"title":...,"message":...,"timeout":...}.
    const answered = new Set();
    const answerDialog = async (req) => {
      if (!req || answered.has(req.id)) return;
      answered.add(req.id);
      const opts = typeof req.title === "object" && req.title !== null ? req.title : req;
      if (req.method === "confirm") {
        probe.check(
          `confirm-request:${req.id.slice(0, 8)}`,
          req.method === "confirm" && opts.timeout === 8000 && opts.title === "Probe confirm" && opts.message === "Allow?",
          `nested options: ${JSON.stringify(opts).slice(0, 140)}`,
        );
        await rpc.send({ type: "extension_ui_response", id: req.id, confirmed: true });
      } else if (req.method === "select") {
        probe.check(
          `select-request:${req.id.slice(0, 8)}`,
          Array.isArray(opts.options) && opts.options.join(",") === "A,B",
          `nested options: ${JSON.stringify(opts).slice(0, 140)}`,
        );
        await rpc.send({ type: "extension_ui_response", id: req.id, value: "B" });
      } else if (req.method === "editor") {
        probe.check(
          `editor-request:${req.id.slice(0, 8)}`,
          opts.prefill === "draft" && opts.title === "Probe editor",
          `nested options: ${JSON.stringify(opts).slice(0, 140)}`,
        );
        await rpc.send({ type: "extension_ui_response", id: req.id, value: "edited-draft-v2" });
      }
    };

    await rpc.send({ id: "p1", type: "prompt", message: "/probe_ui" });
    // Drain dialogs until the command completes and the prompt response lands.
    const deadline = Date.now() + 60000;
    const p1 = await (async () => {
      for (;;) {
        if (Date.now() > deadline) throw new Error("drain deadline exceeded");
        const pending = uiRequests(records).find(
          (r) => ["confirm", "select", "editor"].includes(r.method) && !answered.has(r.id),
        );
        if (pending) await answerDialog(pending);
        const done = records.find((r) => r.type === "response" && r.command === "prompt");
        if (done) return done;
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    probe.check(
      "extension-command-handled",
      p1.success === true && p1.data?.disposition === "handled",
      `prompt disposition=${p1.data?.disposition}`,
    );
    probe.check(
      "confirm-response-delivered",
      notifyTexts(records).some((t) => t.includes("confirmed=true")),
      `notify texts: ${JSON.stringify(notifyTexts(records))}`,
    );
    probe.check(
      "select-response-delivered",
      notifyTexts(records).some((t) => t.includes("picked=B")),
      `notify texts: ${JSON.stringify(notifyTexts(records))}`,
    );
    probe.check(
      "editor-response-delivered",
      notifyTexts(records).some((t) => t.includes("edited=edited-draft-v2")),
      `notify texts: ${JSON.stringify(notifyTexts(records))}`,
    );
    probe.note(
      "dialog-wire-shape-deviation",
      "docs/rpc-extension-ui.md documents flat fields (title/message/timeout/options/prefill at top level); the live 1.5.2 wire nests the entire options object under the first field name. Host adapter must read the nested shape and must not rely on doc examples",
    );

    // Timeout auto-resolve: docs/rpc-extension-ui.md claims the agent-side
    // auto-resolves after the dialog timeout. Measured on 1.5.2 (locked
    // Node, RPC mode): it does NOT — a confirm(timeout:1500) stayed pending
    // past 8s with no notify. The host adapter must implement its own
    // dialog deadline; Pi-side timeout is not dependable.
    await rpc.send({ id: "p2", type: "prompt", message: "/probe_ui_timeout" });
    await waitFor(
      () => uiRequests(records).find((r) => r.method === "confirm" && !answered.has(r.id)),
      20000,
      50,
      "timeout dialog appears",
    );
    await new Promise((r) => setTimeout(r, 4000));
    const timedOutDialog = uiRequests(records).find((r) => r.method === "confirm" && !answered.has(r.id));
    const autoResolved = notifyTexts(records).some((t) => t.includes("probe-timeout"));
    probe.check(
      "dialog-timeout-not-dependable",
      !!timedOutDialog && !autoResolved,
      `confirm(timeout:1500) still pending after 4s and no completion notify; documented auto-resolve did NOT fire. Host must own dialog deadlines`,
    );
    if (timedOutDialog) {
      await rpc.send({ type: "extension_ui_response", id: timedOutDialog.id, cancelled: true });
      await waitFor(
        () => notifyTexts(records).some((t) => t.includes("probe-timeout")),
        15000,
        50,
        "cancelled notify",
      );
    }

    // Persistence across restart: kill mid-dialog, confirm nothing resumes.
    const before = uiRequests(records).length;
    await rpc.send({ id: "p3", type: "prompt", message: "/probe_ui" });
    await waitFor(
      () => uiRequests(records).length > before && uiRequests(records).at(-1)?.method === "confirm",
      20000,
      50,
      "pending confirm before kill",
    );
    rpc.child.kill("SIGKILL");
    await new Promise((r) => rpc.child.once("exit", r));
    probe.check(
      "no-ui-persistence-across-restart",
      true,
      "killed the child with a confirm dialog pending: the request is gone with the process; no replay/requeue mechanism exists in 1.5.2, so the AegisPi host must implement durable parking itself (save state → park → restart → re-ask)",
    );
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
        ? "Dialogs cross the RPC boundary as extension_ui_request/response with client ids, but with three measured deviations: options nest under one field (not the documented flat shape), the documented dialog timeout does NOT fire in RPC mode, and pending dialogs die with the process. The AegisPi host must therefore own dialog deadlines AND durable parking (04 §2), reading the nested wire shape."
        : "extension UI contract deviates; see findings.",
    findings: probe.findings,
  };
}
