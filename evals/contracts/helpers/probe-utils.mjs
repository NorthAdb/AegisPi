// Shared helpers for Phase 1 contract probes.
// All probes run under the locked Node (v22.23.5) and use an isolated
// agent directory so the user's real Pi config is never touched.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Locked Node binary. The default is the Windows install path; on other
// hosts (e.g. the Linux audit environment) set AEGISPI_NODE_BIN to a real
// v22.23.5 binary. RPC probes verify the child's actual version via
// childNodeVersion() so an override pointing at another Node fails the run.
export const LOCKED_NODE =
  process.env.AEGISPI_NODE_BIN ?? "D:\\AegisPi\\tools\\node-v22.23.5\\node.exe";
export const SPEC_PACK_DIR = process.env.AEGISPI_SPEC_PACK ?? "D:\\AegisPi\\aegis-pi-design-pack-v1.4.1";
export const PROBE_TMP_ROOT = join(tmpdir(), "aegispi-phase1-probes");

export function assertLockedNode(probe) {
  const v = process.version;
  const ok = v === "v22.23.5";
  probe.check("locked-node", ok, `process.version=${v}`, { version: v, expected: "v22.23.5" });
  return ok;
}

// Version of the Node binary that RPC probes spawn children with. Cached
// after the first exec so the check costs one process launch per run.
import { execFileSync } from "node:child_process";
let cachedChildVersion = null;
export function childNodeVersion() {
  if (cachedChildVersion === null) {
    cachedChildVersion = execFileSync(LOCKED_NODE, ["--version"], { encoding: "utf8" }).trim();
  }
  return cachedChildVersion;
}

export function assertChildNodeLocked(probe) {
  const v = childNodeVersion();
  probe.check(
    "child-node-locked",
    v === "v22.23.5",
    `spawned CLI node is ${v} (LOCKED_NODE=${LOCKED_NODE}${process.env.AEGISPI_NODE_BIN ? ", via AEGISPI_NODE_BIN" : ""})`,
  );
  return v === "v22.23.5";
}

export function createProbe(id, title) {
  const findings = [];
  const p = {
    id,
    title,
    startTime: Date.now(),
    findings,
    check(name, ok, detail, evidence = undefined) {
      findings.push({ name, status: ok ? "PASS" : "FAIL", detail, evidence });
      return ok;
    },
    note(name, detail, evidence = undefined) {
      findings.push({ name, status: "INFO", detail, evidence });
    },
    skip(name, detail) {
      findings.push({ name, status: "SKIP", detail });
    },
    result(status, summary) {
      p.finalStatus = status;
      p.summary = summary;
    },
  };
  return p;
}

export function summarizeProbe(probe) {
  const failed = probe.findings.filter((f) => f.status === "FAIL");
  if (failed.length > 0) return "FAIL";
  if (probe.finalStatus) return probe.finalStatus;
  // A probe with no real (falsifiable) PASS finding cannot count as PASS:
  // notes and skips are not evidence (audit round 1, P1-2).
  if (!probe.findings.some((f) => f.status === "PASS")) return "SKIP";
  return "PASS";
}

// Isolated agent dir with a models.json that reroutes only the provider's
// baseUrl, keeping the real bundled catalog metadata (models.md proxy pattern).
export function makeIsolatedAgentDir({ modelsProvider = "deepseek", baseUrl }) {
  mkdirSync(PROBE_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(PROBE_TMP_ROOT, "agent-"));
  const models = {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: {
      [modelsProvider]: { baseUrl },
    },
  };
  writeFileSync(join(dir, "models.json"), JSON.stringify(models, null, 2), "utf8");
  return {
    dir,
    modelsPath: join(dir, "models.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function makeWorkspaceDir() {
  mkdirSync(PROBE_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(PROBE_TMP_ROOT, "ws-"));
  return dir;
}

export function piEnv(agentDir, extra = {}) {
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    DEEPSEEK_API_KEY: "probe-fake-key",
    ...extra,
  };
}

// Byte-level LF frame reader. Splits only on 0x0A, strips one optional
// trailing 0x0D, and never decodes partial UTF-8 (06/05 contract:
// RPC only frames on LF bytes; U+2028/U+2029 stay inside frames).
export class FrameReader {
  constructor(onFrame) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.bytesSeen = 0;
  }
  feed(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this.bytesSeen += chunk.length;
    let idx;
    while ((idx = this.buf.indexOf(0x0a)) !== -1) {
      let line = this.buf.subarray(0, idx);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      this.buf = this.buf.subarray(idx + 1);
      this.onFrame(line);
    }
  }
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Spawn the Pi CLI (bundle entry) as the locked Node child in RPC mode.
export function spawnPiRpc({ cliPath, agentDir, sessionDir, extraArgs = [], env, cwd, onFrame, onStderr, provider = "deepseek", model = "deepseek-flash", thinking = "high", noSession = true }) {
  const args = [
    cliPath,
    "--mode",
    "rpc",
    ...(noSession ? ["--no-session"] : []),
    "--provider",
    provider,
    "--model",
    model,
  ];
  if (thinking) args.push("--thinking", thinking);
  args.push(...(sessionDir ? ["--session-dir", sessionDir] : []), ...extraArgs);
  const child = spawn(LOCKED_NODE, args, {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = new FrameReader((frameBytes) => onFrame?.(frameBytes, child));
  const stdoutChunks = [];
  child.stdout.on("data", (c) => {
    stdoutChunks.push(c);
    reader.feed(c);
  });
  const stderrChunks = [];
  child.stderr.on("data", (c) => {
    stderrChunks.push(c);
    onStderr?.(c);
  });
  return {
    child,
    send(obj) {
      return new Promise((resolve, reject) => {
        child.stdin.write(JSON.stringify(obj) + "\n", (err) => (err ? reject(err) : resolve()));
      });
    },
    sendRaw(bytes) {
      return new Promise((resolve, reject) => {
        child.stdin.write(bytes, (err) => (err ? reject(err) : resolve()));
      });
    },
    stderrText() {
      return Buffer.concat(stderrChunks).toString("utf8");
    },
    stdoutRaw() {
      return Buffer.concat(stdoutChunks);
    },
  };
}

export function waitFor(predicate, timeoutMs = 20000, pollMs = 25, label = "waitFor") {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let v;
      try {
        v = predicate();
      } catch (e) {
        reject(e);
        return;
      }
      if (v) {
        resolve(v);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timeout waiting for ${label}`));
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
