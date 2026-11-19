// Container-side agent worker (02 section 1 Agent 工作容器). The agent
// container holds a FIXED Pi (exact 1.5.2) and a narrow, propose-only channel
// to the host. It must never hold: provider/API keys, a DB handle, the
// Docker socket, or a general-purpose outbound-write proxy, and it never
// executes repository code (that is the offline job container's job).
// Model calls are host-proxied in this architecture: PI_OFFLINE=1 here and
// no credential ever enters the image or a mount.
//
// Boot contract (host mounts):
//   /agent-work/context.json (ro):
//     { schemaVersion, taskId, attemptId, fence, scopeDomainKey }
//   /agent-work/proposals/ (rw): the ONLY outbound channel. The worker writes
//     structured proposal envelopes here; the host validates everything and
//     owns approval/submission. A proposal is never an authorization.
//   /agent-work/host-commands/ (ro): host->worker control files.
//
// Modes:
//   --self-check  verify the container boundary invariants and exit
//                 (0 green, 1 red). Used by the image build smoke test.
//   (default)     announce the attempt on the proposal channel, then process
//                 host command files until "stop".
//
// Image layout: this file lives at <workspace>/apps/containers/agent, with
// <workspace>/node_modules and <workspace>/apps/daemon next to it.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = join(HERE, "..", "..", "..");
const WORK_ROOT = "/agent-work";
const PROPOSALS_DIR = join(WORK_ROOT, "proposals");
const COMMANDS_DIR = join(WORK_ROOT, "host-commands");
const CONTEXT_PATH = join(WORK_ROOT, "context.json");

export const WORKER_VERSION = 1;

// Env names that must NEVER be set inside the agent container: a leaked key
// in the environment is the asset boundary tests care most about.
export const CREDENTIAL_ENV_DENYLIST = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "AEGISPI_GITHUB_PAT",
  "AEGISPI_DEEPSEEK_KEY",
  "AEGISPI_TELEGRAM_TOKEN",
  "AEGISPI_FEED_WEBHOOK_SECRET",
];

export function parseContext(raw) {
  let c;
  try {
    c = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `context is not valid JSON: ${e.message}` };
  }
  if (c === null || typeof c !== "object" || Array.isArray(c)) {
    return { ok: false, reason: "context must be a JSON object" };
  }
  if (c.schemaVersion !== 1) {
    return { ok: false, reason: `unsupported context schemaVersion ${JSON.stringify(c.schemaVersion)}` };
  }
  for (const key of ["taskId", "attemptId", "scopeDomainKey"]) {
    if (typeof c[key] !== "string" || c[key].length === 0 || c[key].length > 256) {
      return { ok: false, reason: `${key} must be a non-empty string (<=256 chars)` };
    }
  }
  if (!Number.isInteger(c.fence) || c.fence <= 0) {
    return { ok: false, reason: "fence must be a positive integer (fences are DB-minted, never chosen here)" };
  }
  return { ok: true, context: c };
}

// Every invariant the image and its runtime mounts must hold. One red line
// here is a P0/P1 boundary finding, not a warning.
export async function selfCheck({
  env = process.env,
  home = process.env.HOME ?? "/home/aegis",
  workspaceRoot = WORKSPACE_ROOT,
} = {}) {
  const findings = [];
  if (env.PI_OFFLINE !== "1") {
    findings.push(`PI_OFFLINE=${JSON.stringify(env.PI_OFFLINE)}; the agent container never holds a provider endpoint`);
  }
  for (const name of CREDENTIAL_ENV_DENYLIST) {
    if (env[name] !== undefined) {
      findings.push(`credential env ${name} is set inside the agent container; keys never enter this trust zone`);
    }
  }
  const piHome = join(home, ".pi");
  if (existsSync(piHome)) {
    const entries = readdirSync(piHome);
    if (entries.length > 0) {
      findings.push(`~/.pi exists with ${entries.length} entries; no credentials directory is ever mounted here`);
    }
  }
  if (existsSync("/var/run/docker.sock")) {
    findings.push("docker socket is mounted; the agent container must never own it");
  }
  // Fixed Pi, exact 1.5.2.
  let piVersion;
  try {
    piVersion = JSON.parse(
      readFileSync(join(workspaceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
    ).version;
  } catch (e) {
    findings.push(`cannot resolve the bundled Pi: ${e.message}`);
  }
  if (piVersion !== undefined && piVersion !== "1.5.2") {
    findings.push(`bundled Pi is ${piVersion}; the container must carry exact 1.5.2`);
  }
  // The D-11 loader mapping is part of the boundary: warming must be off.
  try {
    const loaderPath = join(workspaceRoot, "apps", "daemon", "config", "load-pi-settings.mjs");
    const mod = await import(pathToFileURL(loaderPath).href);
    const defaults = JSON.parse(
      readFileSync(join(workspaceRoot, "apps", "daemon", "config", "defaults.json"), "utf8"),
    );
    const settings = mod.piSettingsFromDefaults(defaults);
    if (settings.cacheWarming !== "off") {
      findings.push(`settings mapping yields cacheWarming=${JSON.stringify(settings.cacheWarming)}; policy requires off`);
    }
  } catch (e) {
    findings.push(`defaults->Pi settings mapping failed: ${e.message}`);
  }
  return { ok: findings.length === 0, findings, piVersion: piVersion ?? null };
}

export function announce(context, { now = Date.now(), proposalsDir = PROPOSALS_DIR } = {}) {
  mkdirSync(proposalsDir, { recursive: true });
  const envelope = {
    workerVersion: WORKER_VERSION,
    kind: "worker_announcement",
    taskId: context.taskId,
    attemptId: context.attemptId,
    fence: context.fence,
    scopeDomainKey: context.scopeDomainKey,
    channel: "proposals-dir",
    semantics: "propose-only: the host validates, approves and submits; a proposal is never an authorization",
    bootedAt: now,
  };
  const tmp = join(proposalsDir, "worker-announcement.json.tmp");
  writeFileSync(tmp, JSON.stringify(envelope) + "\n", "utf8");
  renameSync(tmp, join(proposalsDir, "worker-announcement.json"));
  return envelope;
}

// Minimal host->worker command loop. The channel is deliberately boring:
// files in a mounted dir, structured JSON, nothing executable.
export async function serveCommands({
  pollMs = 500,
  stopFile = join(COMMANDS_DIR, "stop"),
  proposalsDir = PROPOSALS_DIR,
  commandsDir = COMMANDS_DIR,
  now = Date.now,
} = {}) {
  const handled = [];
  for (;;) {
    if (existsSync(stopFile)) {
      return { stopped: "stop", handled };
    }
    let files = [];
    try {
      files = readdirSync(commandsDir).filter((f) => f.endsWith(".json")).sort();
    } catch {
      files = [];
    }
    for (const f of files) {
      const p = join(commandsDir, f);
      let cmd;
      try {
        cmd = JSON.parse(readFileSync(p, "utf8"));
      } catch (e) {
        cmd = { kind: "invalid", parseError: e.message };
      }
      const response = {
        workerVersion: WORKER_VERSION,
        kind: "command_receipt",
        commandFile: f,
        command: cmd.kind,
        accepted: cmd.kind === "ping",
        at: now(),
      };
      mkdirSync(proposalsDir, { recursive: true });
      const tmp = join(proposalsDir, `receipt-${f}.tmp`);
      writeFileSync(tmp, JSON.stringify(response) + "\n", "utf8");
      renameSync(tmp, join(proposalsDir, `receipt-${f}`));
      handled.push({ file: f, kind: cmd.kind, accepted: response.accepted });
      rmSync(p, { force: true });
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--self-check")) {
    const check = await selfCheck();
    for (const f of check.findings) {
      console.error(`self-check RED: ${f}`);
    }
    if (check.ok) {
      console.log(`self-check: green (pi ${check.piVersion})`);
      process.exit(0);
    }
    process.exit(1);
  }
  const check = await selfCheck();
  if (!check.ok) {
    console.error(`agent worker: refusing to boot, boundary findings: ${check.findings.join("; ")}`);
    process.exit(1);
  }
  if (!existsSync(CONTEXT_PATH)) {
    console.error(`agent worker: no context at ${CONTEXT_PATH}; refusing to run`);
    process.exit(126);
  }
  const parsed = parseContext(readFileSync(CONTEXT_PATH, "utf8"));
  if (!parsed.ok) {
    console.error(`agent worker: refusing context: ${parsed.reason}`);
    process.exit(126);
  }
  announce(parsed.context);
  console.log(
    `agent worker: announced ${parsed.context.taskId} attempt ${parsed.context.attemptId} fence ${parsed.context.fence} on the proposals channel`,
  );
  const result = await serveCommands();
  console.log(`agent worker: stopped (${result.stopped}), handled ${result.handled.length} command(s)`);
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("worker.mjs") && !process.env.AEGISPI_AGENT_WORKER_IMPORT_ONLY) {
  main();
}
