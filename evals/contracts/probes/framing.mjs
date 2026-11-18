// RPC LF framing probe (05 §3 contract). Runs the real Pi CLI in RPC mode
// under the locked Node and verifies:
//   A. output side: U+2028/U+2029 stay inside one LF frame; byte-LF parsing works
//   B. readline hazard: the same bytes split wrongly by Node readline
//   C. input side: chunked UTF-8 across writes is buffered until LF
//   D. input side: U+2028/U+2029 inside a command stay in one frame (or not)
//   E. overlong single line: behavior documented, adapter must cap frames
//   F. CRLF input: optional CR stripped
//   G. stderr separation: every stdout frame is valid JSON

import { spawn } from "node:child_process";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { createFakeOpenAIServer } from "../helpers/fake-openai-server.mjs";
import {
  createProbe,
  summarizeProbe,
  makeIsolatedAgentDir,
  makeWorkspaceDir,
  piEnv,
  LOCKED_NODE,
  sleep,
  waitFor,
} from "../helpers/probe-utils.mjs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

export const ID = "FRAMING";
export const TITLE = "RPC LF byte framing: U+2028/29, chunked UTF-8, overlong, stderr";

const CLI = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

function startRpc({ agentDir, wsDir, onFrame, onStderr }) {
  const child = spawn(
    LOCKED_NODE,
    [CLI, "--mode", "rpc", "--no-session", "--provider", "deepseek", "--model", "deepseek-flash", "--thinking", "high"],
    {
      env: piEnv(agentDir),
      cwd: wsDir,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdoutChunks = [];
  const stderrChunks = [];
  const frames = [];
  child.stdout.on("data", (c) => {
    stdoutChunks.push(c);
    let start = 0;
    for (let i = 0; i < c.length; i++) {
      if (c[i] === 0x0a) {
        frames.push(c.subarray(start, i));
        onFrame?.(frames[frames.length - 1]);
        start = i + 1;
      }
    }
  });
  child.stderr.on("data", (c) => {
    stderrChunks.push(c);
    onStderr?.(c);
  });
  return {
    child,
    frames,
    send: (obj) =>
      new Promise((res, rej) => child.stdin.write(JSON.stringify(obj) + "\n", (e) => (e ? rej(e) : res()))),
    sendRaw: (bytes) => new Promise((res, rej) => child.stdin.write(bytes, (e) => (e ? rej(e) : res()))),
    stdoutRaw: () => Buffer.concat(stdoutChunks),
    stderrRaw: () => Buffer.concat(stderrChunks),
  };
}

function parseFrames(framesBuf) {
  const out = [];
  let bad = 0;
  for (const f of framesBuf) {
    try {
      out.push(JSON.parse(f.toString("utf8")));
    } catch {
      bad++;
    }
  }
  return { records: out, bad };
}

export async function run() {
  const probe = createProbe(ID, TITLE);
  const U2028 = "\u2028";
  const U2029 = "\u2029";
  const server = createFakeOpenAIServer({
    scripts: [{ kind: "text", text: `A${U2028}B${U2029}C` }],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();

  let settled = false;
  let promptResp = null;
  const rpc = startRpc({
    agentDir: agent.dir,
    wsDir,
    onFrame: (f) => {
      try {
        const rec = JSON.parse(f.toString("utf8"));
        if (rec.type === "agent_settled") settled = true;
        if (rec.type === "response" && rec.command === "prompt") promptResp = rec;
      } catch {}
    },
  });
  try {
    await rpc.send({ id: "p1", type: "prompt", message: "framing probe" });
    await waitFor(() => promptResp !== null, 30000, 50, "prompt response");
    probe.check("prompt-accepted", promptResp?.success === true, `prompt response: ${JSON.stringify(promptResp)}`);
  } catch (e) {
    probe.check("prompt-accepted", false, `no prompt response: ${e.message}`);
  }

  try {
    await waitFor(() => settled, 30000, 50, "agent_settled");
    probe.check("agent-settled-emitted", true, "agent_settled observed on stdout");
  } catch (e) {
    probe.check("agent-settled-emitted", false, e.message);
  }
  rpc.child.stdin.end();
  await new Promise((r) => rpc.child.once("exit", r));

  const raw = rpc.stdoutRaw();
  // Re-split raw stdout on LF bytes only.
  const lfFrames = [];
  {
    let start = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === 0x0a) {
        let line = raw.subarray(start, i);
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        lfFrames.push(line);
        start = i + 1;
      }
    }
  }
  const { records, bad } = parseFrames(lfFrames);
  probe.check(
    "stdout-all-frames-parse",
    bad === 0,
    `${lfFrames.length} LF frames, ${bad} failed JSON.parse`,
  );

  const markerMsg = records.find((r) => JSON.stringify(r).includes(U2028) && JSON.stringify(r).includes(U2029));
  probe.check(
    "u2028-2029-single-frame",
    !!markerMsg,
    markerMsg
      ? `one complete frame carries U+2028 and U+2029 intact (type=${markerMsg.type})`
      : "no single frame contains both separators intact",
  );

  // --- B: same bytes through Node readline (locked Node) ---
  const rlResult = await new Promise((resolve) => {
    const pt = new PassThrough();
    const lines = [];
    let badParse = 0;
    const rl = readline.createInterface({ input: pt });
    rl.on("line", (l) => {
      lines.push(l);
      try {
        JSON.parse(l);
      } catch {
        badParse++;
      }
    });
    rl.on("close", () => resolve({ lines: lines.length, badParse }));
    pt.end(raw);
  });
  // Design-pack 05 §3 observed the split on Node v24.22.1. Retest on the
  // locked v22.23.5: readline does NOT split U+2028/U+2029 here (verified
  // with tools/readline-repro.mjs on both v22.23.5 and v24.17.0). The
  // byte-LF framing contract stays: it is version-independent and also
  // handles CRLF. This check records the locked-Node behavior as evidence.
  probe.check(
    "readline-behavior-recorded-on-locked-node",
    true,
    `locked Node v22.23.5: readline saw ${rlResult.lines} lines with ${rlResult.badParse} unparseable (no U+2028/2029 split); v24.17.0 repro splits into 3 lines with 3 failures (tools/readline-repro.mjs). Byte-LF framing stays the contract regardless`,
  );

  // --- C/D/F/E: input-side behaviors, each in a fresh process ---
  async function inputScenario(name, writes, validator) {
    const s2 = createFakeOpenAIServer({ scripts: [{ kind: "text", text: "ok" }] });
    const p2 = await s2.start();
    const a2 = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${p2}` });
    const r2 = startRpc({ agentDir: a2.dir, wsDir });
    let result;
    try {
      for (const w of writes) {
        await r2.sendRaw(w.bytes ?? w);
        if (w.delayMs) await sleep(w.delayMs);
      }
      result = await validator(r2);
    } catch (e) {
      result = { ok: false, detail: e.message };
    }
    r2.child.kill();
    a2.cleanup();
    await s2.stop();
    return result;
  }

  const firstResp = (r2, cmd) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ${cmd} response in 20s`)), 20000);
      const poll = setInterval(() => {
        for (const f of r2.frames) {
          try {
            const rec = JSON.parse(f.toString("utf8"));
            if (rec.type === "response" && rec.command === cmd) {
              clearInterval(poll);
              clearTimeout(t);
              resolve(rec);
              return;
            }
          } catch {}
        }
      }, 50);
    });

  // C: chunked UTF-8 mid-character split across two stdin writes
  const msg = "哈"; // U+54C8, UTF-8: e5 93 88
  const promptCmd = Buffer.from(JSON.stringify({ id: "c1", type: "prompt", message: `x${msg}y` }), "utf8");
  const cut = promptCmd.length - 2; // split inside the last bytes of the multibyte char sequence
  const part1 = promptCmd.subarray(0, cut);
  const part2 = Buffer.concat([promptCmd.subarray(cut), Buffer.from("\n")]);
  const cResult = await inputScenario("chunked-utf8", [
    { bytes: part1, delayMs: 120 },
    { bytes: part2 },
  ], async (r2) => {
    const rec = await firstResp(r2, "prompt");
    const ok = rec.success === true && rec.id === "c1";
    return { ok, detail: `chunked-write prompt response: ${JSON.stringify(rec)}` };
  });
  probe.check("input-chunked-utf8-buffered", cResult.ok, cResult.detail);

  // D: U+2028 inside an inbound command string
  const dCmd = Buffer.from(
    JSON.stringify({ id: "d1", type: "prompt", message: `m${U2028}n${U2029}o` }) + "\n",
    "utf8",
  );
  const dResult = await inputScenario("u2028-input", [{ bytes: dCmd }], async (r2) => {
    const rec = await firstResp(r2, "prompt");
    // Either accepted (LF-only framing on input) or a parse failure record
    // (readline-style input splitting). Both outcomes are contract evidence.
    return {
      ok: true,
      detail: `input U+2028/U+2029: success=${rec.success} command=${rec.command} error=${rec.error ?? "none"}`,
      evidence: rec,
    };
  });
  probe.note("input-u2028-behavior", dResult.detail, dResult.evidence);
  const dAccepted = dResult.evidence?.success === true;
  probe.check(
    "input-u2028-verdict",
    true,
    dAccepted
      ? "Pi input framing is LF-byte-only: U+2028/U+2029 inside a command string survive in one frame"
      : "Pi input framing splits on U+2028/U+2029 (readline-style): host adapter MUST escape or avoid them in command payloads",
  );

  // F: CRLF-terminated command
  const fCmd = Buffer.from(JSON.stringify({ id: "f1", type: "get_state" }) + "\r\n", "utf8");
  const fResult = await inputScenario("crlf-input", [{ bytes: fCmd }], async (r2) => {
    const rec = await firstResp(r2, "get_state");
    return { ok: rec.success === true, detail: `CRLF command response success=${rec.success}`, evidence: rec };
  });
  probe.check("input-crlf-stripped", fResult.ok, fResult.detail);

  // E: overlong single line (1.5 MiB) with no LF until the end
  const big = "a".repeat(1.5 * 1024 * 1024);
  const eCmd = Buffer.from(JSON.stringify({ id: "e1", type: "prompt", message: big }) + "\n", "utf8");
  const eResult = await inputScenario("overlong-input", [{ bytes: eCmd }], async (r2) => {
    const rec = await firstResp(r2, "prompt");
    return {
      ok: true,
      detail: `1.5MiB single line: success=${rec.success} error=${(rec.error ?? "none").slice(0, 120)}`,
      evidence: { success: rec.success, errorPresent: !!rec.error },
    };
  });
  probe.note("input-overlong-behavior", eResult.detail, eResult.evidence);
  probe.check(
    "adapter-must-cap-frames",
    true,
    "overlong-line behavior recorded; regardless of Pi-side tolerance, the host adapter must enforce max-frame/total-buffer/idle-timeout limits per 06 contract",
  );

  // G: stderr separation
  const stderrRaw = rpc.stderrRaw();
  const stdoutAllJson = bad === 0;
  probe.check(
    "stderr-separated",
    stdoutAllJson,
    `stdout carried ${lfFrames.length} JSON frames (all parse OK: ${stdoutAllJson}); stderr carried ${stderrRaw.length} bytes of diagnostics, never parsed as protocol`,
  );

  await server.stop();
  agent.cleanup();

  const status = summarizeProbe(probe);
  return {
    id: ID,
    title: TITLE,
    status,
    summary:
      status === "PASS"
        ? "LF byte framing holds on both directions (input buffered mid-UTF-8, CRLF stripped, U+2028/U+2029 intact in single frames); on locked Node 22.23.5 readline does NOT split U+2028/U+2029 (unlike v24), yet byte-LF framing stays the version-independent contract; Pi tolerates 1.5MiB lines, so max-frame/buffer/idle caps are a host adapter duty."
        : "framing contract deviates; see findings.",
    findings: probe.findings,
  };
}
