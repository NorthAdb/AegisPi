// Container-side offline job runner (02 section 1 offline execution sandbox).
// Contract with the host:
//   /job/input/manifest.json  (ro mount, host-generated):
//     { schemaVersion, jobId, command, args[], deadlineMs, envAllowlist? }
//   /job/work  (rw tmpfs, bounded by the container's disk quota)
//   /job/output (rw mount, host reads after the container exits):
//     result.json { runnerVersion, jobId, exitCode|null, timedOut, cancelled,
//                   startedAt, endedAt, stdoutBytes, stderrBytes,
//                   stdoutTruncated, stderrTruncated }
// The runner enforces the deadline itself, but the host ALSO enforces a hard
// wall-clock kill on the whole container: a malicious job that kills the
// runner or forges result.json only loses its own evidence, never the
// deadline or the container's exit (02 section 5: stdout and files are
// evidence inputs, never an authorization or an automatic success mark).
// Runner exit codes: 0 ran to completion (the job's exit code is recorded in
// result.json, not propagated — "退出码不是Task结论", 06 section 2),
// 124 deadline hit, 125 cancelled (SIGTERM), 126 invalid manifest.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const RUNNER_VERSION = 1;
const INPUT_MANIFEST = "/job/input/manifest.json";
const WORK_DIR = "/job/work";
const OUTPUT_DIR = "/job/output";
const RESULT_PATH = join(OUTPUT_DIR, "result.json");
const STREAM_CAP_BYTES = 2 * 1024 * 1024;

export function parseManifest(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `manifest is not valid JSON: ${e.message}` };
  }
  if (m === null || typeof m !== "object" || Array.isArray(m)) {
    return { ok: false, reason: "manifest must be a JSON object" };
  }
  if (m.schemaVersion !== 1) {
    return { ok: false, reason: `unsupported manifest schemaVersion ${JSON.stringify(m.schemaVersion)}` };
  }
  if (typeof m.jobId !== "string" || m.jobId.length === 0 || m.jobId.length > 256) {
    return { ok: false, reason: "jobId must be a non-empty string (<=256 chars)" };
  }
  if (typeof m.command !== "string" || m.command.length === 0 || /[\0\r\n]/.test(m.command)) {
    return { ok: false, reason: "command must be a non-empty single-line string" };
  }
  if (!Array.isArray(m.args) || m.args.some((a) => typeof a !== "string" || a.includes("\0"))) {
    return { ok: false, reason: "args must be an array of NUL-free strings" };
  }
  if (!Number.isInteger(m.deadlineMs) || m.deadlineMs <= 0 || m.deadlineMs > 60 * 60 * 1000) {
    return { ok: false, reason: "deadlineMs must be a positive integer of at most one hour" };
  }
  if (m.envAllowlist !== undefined) {
    if (!Array.isArray(m.envAllowlist) || m.envAllowlist.some((a) => typeof a !== "string" || a.includes("\0"))) {
      return { ok: false, reason: "envAllowlist must be an array of NUL-free strings" };
    }
  }
  return { ok: true, manifest: m };
}

function cappedSink(file) {
  let bytes = 0;
  let truncated = false;
  return {
    write(chunk) {
      if (truncated) {
        bytes += chunk.length;
        return;
      }
      if (bytes + chunk.length > STREAM_CAP_BYTES) {
        const room = Math.max(0, STREAM_CAP_BYTES - bytes);
        if (room > 0) {
          try {
            writeFileSync(file, chunk.subarray(0, room), { flag: "a" });
          } catch {}
        }
        bytes += chunk.length;
        truncated = true;
        try {
          writeFileSync(file + ".truncated", `capped at ${STREAM_CAP_BYTES} bytes\n`, { flag: "a" });
        } catch {}
        return;
      }
      try {
        writeFileSync(file, chunk, { flag: "a" });
      } catch {}
      bytes += chunk.length;
    },
    bytes: () => bytes,
    truncated: () => truncated,
  };
}

// Writes result.json atomically (tmp + rename) so the host never reads a
// torn file.
function writeResult(result) {
  const tmp = join(OUTPUT_DIR, "result.json.tmp");
  writeFileSync(tmp, JSON.stringify(result) + "\n", "utf8");
  renameSync(tmp, RESULT_PATH);
}

export function runJob(manifest, { activeChild } = {}) {
  return new Promise((resolveRun) => {
    const stdoutPath = join(OUTPUT_DIR, "stdout.txt");
    const stderrPath = join(OUTPUT_DIR, "stderr.txt");
    const startedAt = Date.now();
    const out = cappedSink(stdoutPath);
    const err = cappedSink(stderrPath);
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: WORK_DIR, LANG: "C.UTF-8" };
    for (const key of manifest.envAllowlist ?? []) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        env[key] = "1"; // Values stay host-side; the runner forwards names only.
      }
    }
    const child = spawn(manifest.command, manifest.args, {
      cwd: WORK_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (activeChild) activeChild.child = child;
    child.stdout.on("data", (c) => out.write(c));
    child.stderr.on("data", (c) => err.write(c));
    let done = false;
    let cancelled = false;
    const finish = ({ exitCode, timedOut, signal = null }) => {
      if (done) return;
      done = true;
      clearTimeout(deadlineTimer);
      writeResult({
        runnerVersion: RUNNER_VERSION,
        jobId: manifest.jobId,
        exitCode: exitCode === undefined ? null : exitCode,
        signal,
        timedOut: timedOut === true,
        cancelled,
        startedAt,
        endedAt: Date.now(),
        stdoutBytes: out.bytes(),
        stderrBytes: err.bytes(),
        stdoutTruncated: out.truncated(),
        stderrTruncated: err.truncated(),
      });
      resolveRun({ exitCode, timedOut, cancelled, signal });
    };
    const deadlineTimer = setTimeout(() => {
      finish({ exitCode: null, timedOut: true });
      try {
        child.kill("SIGKILL");
      } catch {}
    }, manifest.deadlineMs);
    // A null exitCode means the child died by SIGNAL (OOM kill, pid-limit
    // kill): that is abnormal termination evidence, never a success.
    child.on("exit", (code, signal) => finish({ exitCode: code, timedOut: false, signal: signal ?? null }));
    child.on("error", (e) => {
      try {
        writeFileSync(stderrPath + ".spawn-error", `${e.message}\n`, { flag: "a" });
      } catch {}
      finish({ exitCode: null, timedOut: false });
    });
    if (activeChild) {
      activeChild.cancel = () => {
        cancelled = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      };
    }
  });
}

export async function main() {
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!existsSync(INPUT_MANIFEST)) {
    console.error(`runner: no manifest at ${INPUT_MANIFEST}; nothing to do`);
    process.exit(126);
  }
  const parsed = parseManifest(readFileSync(INPUT_MANIFEST, "utf8"));
  if (!parsed.ok) {
    console.error(`runner: refusing manifest: ${parsed.reason}`);
    writeResult({ runnerVersion: RUNNER_VERSION, jobId: null, error: parsed.reason, refused: true });
    process.exit(126);
  }
  const activeChild = { child: null, cancel: null };
  process.on("SIGTERM", () => {
    // docker stop sends SIGTERM: cancel the child, let its exit handler write
    // result.json, and mark the run cancelled.
    if (activeChild.cancel) activeChild.cancel();
    else process.exit(125);
  });
  const result = await runJob(parsed.manifest, { activeChild });
  // The runner propagates the JOB's exit code: the container-level exit code
  // is then the job's own fate, owned by OUR runner code — a malicious job
  // cannot turn its failure into a clean container exit (killing PID 1 only
  // produces 137). result.json remains the detailed evidence either way.
  //   0..255 job exit | 124 deadline | 125 cancelled | 126 invalid manifest
  //   137 child died by signal (OOM kill, pid-limit kill)
  const exitCode = result.timedOut
    ? 124
    : result.cancelled
      ? 125
      : typeof result.exitCode === "number"
        ? result.exitCode
        : 137;
  process.exit(exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("runner.mjs") && !process.env.AEGISPI_RUNNER_IMPORT_ONLY) {
  main();
}
