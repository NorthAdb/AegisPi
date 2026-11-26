import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * W2-S6: Strict minimal allowlisted environment for ALL Docker CLI child processes.
 * Prevents any host secret env vars (AEGISPI_*, MODEL_*, IMAP_*, GITHUB_*, SMTP_*, etc.)
 * from being inherited by `docker` CLI invocations.
 */
const DOCKER_CLI_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
] as const;

export function buildMinimalDockerCliEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const allowSet = new Set<string>(DOCKER_CLI_ENV_ALLOWLIST);
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (v === undefined) continue;
    if (allowSet.has(k.toUpperCase())) {
      out[k] = v;
    }
  }
  return out;
}

function execDockerSync(
  args: string[],
  opts?: { timeoutMs?: number; maxBuffer?: number },
): { status: number | null; stdout: string; stderr: string; cliEnvKeys: string[] } {
  const cliEnv = buildMinimalDockerCliEnv();
  const res = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: opts?.timeoutMs ?? 10_000,
    ...(opts?.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
    env: cliEnv,
    windowsHide: true,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? res.error.message : ""),
    cliEnvKeys: Object.keys(cliEnv).sort(),
  };
}

async function execDockerAsync(
  args: string[],
  timeoutMs = 25_000,
): Promise<{ status: number | null; stdout: string; stderr: string; cliEnvKeys: string[] }> {
  const cliEnv = buildMinimalDockerCliEnv();
  const cliEnvKeys = Object.keys(cliEnv).sort();
  return await new Promise((resolve) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: cliEnv,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (status: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, cliEnvKeys });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      stderr += "\ndocker_command_timeout";
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.once("error", (err) => {
      stderr += err.message;
      finish(1);
    });
    child.once("exit", (code) => finish(code));
  });
}

export const DEFAULT_SANDBOX_IMAGE = "node:22.23.5-bookworm-slim";
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

export interface DockerEnvironmentInfo {
  available: boolean;
  clientVersion: string | null;
  serverVersion: string | null;
  imageName: string;
  imageId: string | null;
}

/**
 * W2-G2: Verifies that an approved immutable image digest (sha256:...) is present locally
 * and matches the local Docker image ID STRICTLY BEFORE launching any executor or exporter container.
 */
export function verifyApprovedSandboxImageDigest(params: {
  approvedImageId?: string | null;
  imageName?: string;
}): { ok: true; immutableImageId: string; imageName: string } | { ok: false; code: string; reason: string } {
  const imageName = params.imageName ?? DEFAULT_SANDBOX_IMAGE;
  const approved = params.approvedImageId?.trim() ?? "";
  if (!approved || !SHA256_DIGEST_RE.test(approved)) {
    return {
      ok: false,
      code: "unapproved_or_missing_image_digest",
      reason: `Immutable approvedImageId (sha256:<64-hex>) is required before container launch; got '${approved}'`,
    };
  }
  const normalizedApproved = approved.toLowerCase();
  const insp = execDockerSync(["image", "inspect", normalizedApproved, "--format", "{{.Id}}"], { timeoutMs: 10_000 });
  if (insp.status !== 0) {
    return {
      ok: false,
      code: "approved_image_digest_not_found",
      reason: `Approved immutable image digest ${normalizedApproved} not found locally: ${insp.stderr.trim() || "inspect failed"}`,
    };
  }
  const resolvedId = insp.stdout.trim().toLowerCase();
  if (resolvedId !== normalizedApproved) {
    return {
      ok: false,
      code: "image_digest_mismatch",
      reason: `Resolved image ID ${resolvedId} does not match approved immutable digest ${normalizedApproved}`,
    };
  }
  return { ok: true, immutableImageId: resolvedId, imageName };
}

export function inspectDockerEnvironment(imageName = DEFAULT_SANDBOX_IMAGE): DockerEnvironmentInfo {
  const ver = execDockerSync(["version", "--format", "{{.Client.Version}}|{{.Server.Version}}"], { timeoutMs: 10_000 });
  if (ver.status !== 0) {
    return {
      available: false,
      clientVersion: null,
      serverVersion: null,
      imageName,
      imageId: null,
    };
  }
  const [clientVersion = null, serverVersion = null] = ver.stdout.trim().split("|");
  const img = execDockerSync(["image", "inspect", imageName, "--format", "{{.Id}}"], { timeoutMs: 10_000 });
  return {
    available: img.status === 0,
    clientVersion,
    serverVersion,
    imageName,
    imageId: img.status === 0 ? img.stdout.trim() : null,
  };
}

export interface SandboxTaskRunOptions {
  imageName?: string;
  /** W2-G2: Required immutable sha256:... image digest verified BEFORE docker run. */
  approvedImageId: string;
  inputSnapshotDir: string;
  /** JavaScript body executed via `node -e` inside the zero-network, zero-credential container. */
  nodeScript: string;
  volumeName?: string;
  keepRunningDetached?: boolean;
  timeoutMs?: number;
}

export interface SandboxTaskRunResult {
  ok: boolean;
  code?: string;
  error?: string;
  volumeName: string;
  containerId: string;
  containerName: string;
  imageName: string;
  imageId: string | null;
  executorImageId: string | null;
  networkMode: "none";
  mounts: Array<{ source: string; destination: string; rw: boolean }>;
  envKeysInContainer: string[];
  dockerCliEnvKeys?: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a task inside a zero-network (`--network none`), zero-credential Docker container
 * launched strictly by verified immutable image digest (`sha256:...`),
 * with read-only input snapshot mount (`/input:ro`) and a task-private named volume (`/out:rw`).
 * Authoritative host workspace is NEVER mounted writable into the container.
 */
export function runTaskInDockerSandbox(opts: SandboxTaskRunOptions): SandboxTaskRunResult {
  const imageName = opts.imageName ?? DEFAULT_SANDBOX_IMAGE;
  const imgCheck = verifyApprovedSandboxImageDigest({
    approvedImageId: opts.approvedImageId,
    imageName,
  });
  if (!imgCheck.ok) {
    return {
      ok: false,
      code: imgCheck.code,
      error: imgCheck.reason,
      volumeName: opts.volumeName ?? "",
      containerId: "",
      containerName: "",
      imageName,
      imageId: null,
      executorImageId: null,
      networkMode: "none",
      mounts: [],
      envKeysInContainer: [],
      exitCode: null,
      stdout: "",
      stderr: imgCheck.reason,
    };
  }
  const volumeName = opts.volumeName ?? `aegis-w2-vol-${randomUUID().slice(0, 10)}`;
  const containerName = `aegis-w2-task-${randomUUID().slice(0, 10)}`;
  const absInput = path.resolve(opts.inputSnapshotDir);
  if (!existsSync(absInput)) {
    mkdirSync(absInput, { recursive: true });
  }

  const volCreate = execDockerSync(["volume", "create", volumeName], { timeoutMs: 10_000 });
  if (volCreate.status !== 0) {
    throw new Error(`docker volume create ${volumeName} failed: ${volCreate.stderr}`);
  }

  const dockerArgs = [
    "run",
    ...(opts.keepRunningDetached ? ["-d"] : []),
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--pids-limit",
    "64",
    "-v",
    `${absInput}:/input:ro`,
    "-v",
    `${volumeName}:/out:rw`,
    imgCheck.immutableImageId,
    "node",
    "-e",
    opts.nodeScript,
  ];

  const run = execDockerSync(dockerArgs, { timeoutMs: opts.timeoutMs ?? 25_000 });

  // Inspect container metadata (ID, mounts, image, env) strictly via Docker daemon
  const insp = execDockerSync(
    [
      "inspect",
      containerName,
      "--format",
      "{{.Id}}|||{{.Image}}|||{{json .Mounts}}|||{{json .Config.Env}}",
    ],
    { timeoutMs: 10_000 },
  );

  let containerId = "";
  let imageId: string | null = null;
  let mounts: Array<{ source: string; destination: string; rw: boolean }> = [];
  let envKeysInContainer: string[] = [];

  if (insp.status === 0) {
    const parts = insp.stdout.trim().split("|||");
    containerId = parts[0] ?? "";
    imageId = parts[1] ?? null;
    try {
      const rawMounts = JSON.parse(parts[2] ?? "[]") as Array<{
        Source?: string;
        Name?: string;
        Destination?: string;
        RW?: boolean;
      }>;
      mounts = rawMounts.map((m) => ({
        source: m.Name || m.Source || "",
        destination: m.Destination || "",
        rw: Boolean(m.RW),
      }));
    } catch {
      mounts = [];
    }
    try {
      const rawEnv = JSON.parse(parts[3] ?? "[]") as string[];
      envKeysInContainer = rawEnv.map((e) => e.split("=")[0] ?? "").filter(Boolean);
    } catch {
      envKeysInContainer = [];
    }
  }

  return {
    ok: run.status === 0,
    volumeName,
    containerId,
    containerName,
    imageName,
    imageId,
    executorImageId: imageId ?? imgCheck.immutableImageId,
    networkMode: "none",
    mounts,
    envKeysInContainer,
    dockerCliEnvKeys: run.cliEnvKeys,
    exitCode: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

export interface VolumeWriterCheck {
  allExited: boolean;
  volumeName: string;
  attachedContainers: Array<{
    id: string;
    name: string;
    state: string;
    hasWritableMount: boolean;
  }>;
  activeWriters: Array<{ id: string; name: string; state: string }>;
}

/**
 * Verifies via Docker daemon container & mount inspection that ALL containers
 * holding a writable mount to `volumeName` have completely exited.
 */
export function verifyAllVolumeWritersExited(volumeName: string): VolumeWriterCheck {
  const ps = execDockerSync(
    ["ps", "-a", "--filter", `volume=${volumeName}`, "--format", "{{.ID}}\t{{.Names}}\t{{.State}}"],
    { timeoutMs: 10_000 },
  );
  if (ps.status !== 0) {
    return {
      allExited: false,
      volumeName,
      attachedContainers: [],
      activeWriters: [{ id: "unknown", name: "docker_ps_failed", state: ps.stderr.trim() || "error" }],
    };
  }

  const lines = ps.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const attachedContainers: VolumeWriterCheck["attachedContainers"] = [];
  const activeWriters: VolumeWriterCheck["activeWriters"] = [];

  for (const line of lines) {
    const [id = "", name = "", state = ""] = line.split("\t");
    if (!id) continue;
    const insp = execDockerSync(["inspect", id, "--format", "{{.State.Status}}|||{{json .Mounts}}"], {
      timeoutMs: 10_000,
    });
    let liveStatus = state;
    let hasWritableMount = true; // fail closed if inspect fails
    if (insp.status === 0) {
      const [stStr, mountsJson] = insp.stdout.trim().split("|||");
      liveStatus = stStr || state;
      try {
        const mounts = JSON.parse(mountsJson ?? "[]") as Array<{ Name?: string; RW?: boolean }>;
        hasWritableMount = mounts.some((m) => m.Name === volumeName && m.RW === true);
      } catch {
        hasWritableMount = true;
      }
    }
    attachedContainers.push({ id, name, state: liveStatus, hasWritableMount });
    const exited = liveStatus === "exited" || liveStatus === "dead" || liveStatus === "created";
    if (hasWritableMount && !exited) {
      activeWriters.push({ id, name, state: liveStatus });
    }
  }

  return {
    allExited: activeWriters.length === 0,
    volumeName,
    attachedContainers,
    activeWriters,
  };
}

export interface ExportedRegularFile {
  relPath: string;
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
}

export type VolumeExportResult =
  | {
      ok: true;
      volumeName: string;
      exporterImageId: string;
      readOnlyMountVerified: true;
      files: ExportedRegularFile[];
      totalBytes: number;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      volumeName: string;
      exporterImageId?: string | null;
    };

/**
 * Runs a controlled read-only exporter container (`--network none`, `-v volumeName:/export:ro`)
 * launched strictly by verified immutable image digest (`sha256:...`),
 * inspecting every entry in the task volume via `lstatSync`, rejecting symlinks, hardlinks
 * (`nlink > 1`), FIFOs/sockets/devices, path traversal, and file count/byte quota overflows,
 * then returning verified regular file bytes to the host.
 */
export function exportRegularFilesFromVolumeReadOnly(params: {
  volumeName: string;
  imageName?: string;
  /** W2-G2: Required immutable sha256:... image digest verified BEFORE docker run. */
  approvedImageId: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
}): VolumeExportResult {
  const imageName = params.imageName ?? DEFAULT_SANDBOX_IMAGE;
  const imgCheck = verifyApprovedSandboxImageDigest({
    approvedImageId: params.approvedImageId,
    imageName,
  });
  if (!imgCheck.ok) {
    return {
      ok: false,
      code: imgCheck.code,
      reason: imgCheck.reason,
      volumeName: params.volumeName,
      exporterImageId: null,
    };
  }
  const maxFiles = params.maxFiles ?? 16;
  const maxFileBytes = params.maxFileBytes ?? 512 * 1024;
  const maxTotalBytes = params.maxTotalBytes ?? 1024 * 1024;

  const exporterScript = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = "/export";
const MAX_FILES = ${maxFiles};
const MAX_FILE_BYTES = ${maxFileBytes};
const MAX_TOTAL_BYTES = ${maxTotalBytes};
const files = [];
let totalBytes = 0;

function fail(code, reason) {
  process.stdout.write(JSON.stringify({ ok: false, code, reason }) + "\\n");
  process.exit(0);
}

function walk(dirAbs, relPrefix) {
  const entries = fs.readdirSync(dirAbs);
  entries.sort();
  for (const name of entries) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\\\") || name.includes(":") || name.includes("\\0")) {
      fail("invalid_entry_name", "Rejected entry name: " + name);
    }
    const full = path.join(dirAbs, name);
    const rel = relPrefix ? relPrefix + "/" + name : name;
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) {
      fail("symlink_rejected", "Symlink rejected in export volume: " + rel);
    }
    if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
      fail("non_regular_file_rejected", "Special device/FIFO/socket rejected in export volume: " + rel);
    }
    if (st.isDirectory()) {
      walk(full, rel);
      continue;
    }
    if (!st.isFile()) {
      fail("non_regular_file_rejected", "Unrecognized non-regular file type: " + rel);
    }
    if (st.nlink > 1) {
      fail("hardlink_rejected", "Hardlink rejected in export volume (nlink=" + st.nlink + "): " + rel);
    }
    if (files.length + 1 > MAX_FILES) {
      fail("file_count_quota_exceeded", "Export file count exceeds limit " + MAX_FILES);
    }
    if (st.size > MAX_FILE_BYTES) {
      fail("file_size_quota_exceeded", "File " + rel + " size " + st.size + " exceeds maxFileBytes " + MAX_FILE_BYTES);
    }
    if (totalBytes + st.size > MAX_TOTAL_BYTES) {
      fail("total_bytes_quota_exceeded", "Total export size exceeds maxTotalBytes " + MAX_TOTAL_BYTES);
    }
    const buf = fs.readFileSync(full);
    if (buf.length !== st.size) {
      fail("concurrent_mutation_detected", "File size changed during read-only export: " + rel);
    }
    totalBytes += buf.length;
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    files.push({ relPath: rel, sizeBytes: buf.length, sha256, contentBase64: buf.toString("base64") });
  }
}

try {
  // Verify /export mount is genuinely read-only
  try {
    fs.writeFileSync(path.join(ROOT, ".ro-probe-" + Date.now()), "x");
    fail("export_mount_not_readonly", "Expected /export to be read-only");
  } catch (roErr) {
    if (roErr && roErr.code !== "EROFS" && roErr.code !== "EACCES" && roErr.code !== "EPERM") {
      // ignore only expected RO errors
    }
  }
  walk(ROOT, "");
  process.stdout.write(JSON.stringify({ ok: true, readOnlyMountVerified: true, totalBytes, files }) + "\\n");
} catch (err) {
  fail("exporter_error", err && err.message ? err.message : String(err));
}
`;

  const res = execDockerSync(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "128m",
      "--pids-limit",
      "32",
      "-v",
      `${params.volumeName}:/export:ro`,
      imgCheck.immutableImageId,
      "node",
      "-e",
      exporterScript,
    ],
    {
      timeoutMs: params.timeoutMs ?? 25_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  if (res.status !== 0) {
    return {
      ok: false,
      code: "exporter_container_failed",
      reason: res.stderr.trim() || `Exporter exited with status ${String(res.status)}`,
      volumeName: params.volumeName,
    };
  }

  const lastLine = res.stdout.trim().split(/\r?\n/).pop() ?? "";
  let parsed: {
    ok: boolean;
    code?: string;
    reason?: string;
    totalBytes?: number;
    files?: Array<{ relPath: string; sizeBytes: number; sha256: string; contentBase64: string }>;
  };
  try {
    parsed = JSON.parse(lastLine) as typeof parsed;
  } catch {
    return {
      ok: false,
      code: "exporter_malformed_output",
      reason: `Exporter returned non-JSON output: ${lastLine.slice(0, 200)}`,
      volumeName: params.volumeName,
    };
  }

  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code ?? "exporter_rejected",
      reason: parsed.reason ?? "Exporter rejected volume contents",
      volumeName: params.volumeName,
    };
  }

  const verifiedFiles: ExportedRegularFile[] = [];
  for (const f of parsed.files ?? []) {
    const bytes = Buffer.from(f.contentBase64, "base64");
    const hostSha = createHash("sha256").update(bytes).digest("hex");
    if (hostSha !== f.sha256 || bytes.length !== f.sizeBytes) {
      return {
        ok: false,
        code: "export_digest_mismatch",
        reason: `Host SHA-256 mismatch on exported file ${f.relPath}`,
        volumeName: params.volumeName,
      };
    }
    verifiedFiles.push({
      relPath: f.relPath,
      bytes,
      sizeBytes: bytes.length,
      sha256: hostSha,
    });
  }

  return {
    ok: true,
    volumeName: params.volumeName,
    exporterImageId: imgCheck.immutableImageId,
    readOnlyMountVerified: true,
    files: verifiedFiles,
    totalBytes: parsed.totalBytes ?? verifiedFiles.reduce((s, f) => s + f.sizeBytes, 0),
  };
}

export async function verifyApprovedSandboxImageDigestAsync(params: {
  approvedImageId?: string | null;
  imageName?: string;
}): Promise<{ ok: true; immutableImageId: string; imageName: string } | { ok: false; code: string; reason: string }> {
  const imageName = params.imageName ?? DEFAULT_SANDBOX_IMAGE;
  const approved = params.approvedImageId?.trim() ?? "";
  if (!approved || !SHA256_DIGEST_RE.test(approved)) {
    return {
      ok: false,
      code: "unapproved_or_missing_image_digest",
      reason: `Immutable approvedImageId (sha256:<64-hex>) is required before container launch; got '${approved}'`,
    };
  }
  const normalizedApproved = approved.toLowerCase();
  const insp = await execDockerAsync(["image", "inspect", normalizedApproved, "--format", "{{.Id}}"], 10_000);
  if (insp.status !== 0) {
    return {
      ok: false,
      code: "approved_image_digest_not_found",
      reason: `Approved immutable image digest ${normalizedApproved} not found locally: ${insp.stderr.trim() || "inspect failed"}`,
    };
  }
  const resolvedId = insp.stdout.trim().toLowerCase();
  if (resolvedId !== normalizedApproved) {
    return {
      ok: false,
      code: "image_digest_mismatch",
      reason: `Resolved image ID ${resolvedId} does not match approved immutable digest ${normalizedApproved}`,
    };
  }
  return { ok: true, immutableImageId: resolvedId, imageName };
}

export async function runTaskInDockerSandboxAsync(opts: SandboxTaskRunOptions): Promise<SandboxTaskRunResult> {
  const imageName = opts.imageName ?? DEFAULT_SANDBOX_IMAGE;
  const imgCheck = await verifyApprovedSandboxImageDigestAsync({
    approvedImageId: opts.approvedImageId,
    imageName,
  });
  if (!imgCheck.ok) {
    return {
      ok: false,
      code: imgCheck.code,
      error: imgCheck.reason,
      volumeName: opts.volumeName ?? "",
      containerId: "",
      containerName: "",
      imageName,
      imageId: null,
      executorImageId: null,
      networkMode: "none",
      mounts: [],
      envKeysInContainer: [],
      exitCode: null,
      stdout: "",
      stderr: imgCheck.reason,
    };
  }
  const volumeName = opts.volumeName ?? `aegis-w2-vol-${randomUUID().slice(0, 10)}`;
  const containerName = `aegis-w2-task-${randomUUID().slice(0, 10)}`;
  const absInput = path.resolve(opts.inputSnapshotDir);
  if (!existsSync(absInput)) {
    mkdirSync(absInput, { recursive: true });
  }

  const volCreate = await execDockerAsync(["volume", "create", volumeName], 10_000);
  if (volCreate.status !== 0) {
    throw new Error(`docker volume create ${volumeName} failed: ${volCreate.stderr}`);
  }

  const dockerArgs = [
    "run",
    ...(opts.keepRunningDetached ? ["-d"] : []),
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--pids-limit",
    "64",
    "-v",
    `${absInput}:/input:ro`,
    "-v",
    `${volumeName}:/out:rw`,
    imgCheck.immutableImageId,
    "node",
    "-e",
    opts.nodeScript,
  ];

  const run = await execDockerAsync(dockerArgs, opts.timeoutMs ?? 25_000);
  const insp = await execDockerAsync(
    ["inspect", containerName, "--format", "{{.Id}}|||{{.Image}}|||{{json .Mounts}}|||{{json .Config.Env}}"],
    10_000,
  );

  let containerId = "";
  let imageId: string | null = null;
  let mounts: Array<{ source: string; destination: string; rw: boolean }> = [];
  let envKeysInContainer: string[] = [];

  if (insp.status === 0) {
    const parts = insp.stdout.trim().split("|||");
    containerId = parts[0] ?? "";
    imageId = parts[1] ?? null;
    try {
      const rawMounts = JSON.parse(parts[2] ?? "[]") as Array<{
        Source?: string;
        Name?: string;
        Destination?: string;
        RW?: boolean;
      }>;
      mounts = rawMounts.map((m) => ({
        source: m.Name || m.Source || "",
        destination: m.Destination || "",
        rw: Boolean(m.RW),
      }));
    } catch {
      mounts = [];
    }
    try {
      const rawEnv = JSON.parse(parts[3] ?? "[]") as string[];
      envKeysInContainer = rawEnv.map((e) => e.split("=")[0] ?? "").filter(Boolean);
    } catch {
      envKeysInContainer = [];
    }
  }

  return {
    ok: run.status === 0,
    volumeName,
    containerId,
    containerName,
    imageName,
    imageId,
    executorImageId: imageId ?? imgCheck.immutableImageId,
    networkMode: "none",
    mounts,
    envKeysInContainer,
    dockerCliEnvKeys: run.cliEnvKeys,
    exitCode: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

export async function verifyAllVolumeWritersExitedAsync(volumeName: string): Promise<VolumeWriterCheck> {
  const ps = await execDockerAsync(
    ["ps", "-a", "--filter", `volume=${volumeName}`, "--format", "{{.ID}}\t{{.Names}}\t{{.State}}"],
    10_000,
  );
  if (ps.status !== 0) {
    return {
      allExited: false,
      volumeName,
      attachedContainers: [],
      activeWriters: [{ id: "unknown", name: "docker_ps_failed", state: ps.stderr.trim() || "error" }],
    };
  }
  const lines = ps.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const attachedContainers: VolumeWriterCheck["attachedContainers"] = [];
  const activeWriters: VolumeWriterCheck["activeWriters"] = [];

  for (const line of lines) {
    const [id = "", name = "", state = ""] = line.split("\t");
    if (!id) continue;
    const insp = await execDockerAsync(["inspect", id, "--format", "{{.State.Status}}|||{{json .Mounts}}"], 10_000);
    let liveStatus = state;
    let hasWritableMount = true;
    if (insp.status === 0) {
      const [stStr, mountsJson] = insp.stdout.trim().split("|||");
      liveStatus = stStr || state;
      try {
        const mounts = JSON.parse(mountsJson ?? "[]") as Array<{ Name?: string; RW?: boolean }>;
        hasWritableMount = mounts.some((m) => m.Name === volumeName && m.RW === true);
      } catch {
        hasWritableMount = true;
      }
    }
    attachedContainers.push({ id, name, state: liveStatus, hasWritableMount });
    const exited = liveStatus === "exited" || liveStatus === "dead" || liveStatus === "created";
    if (hasWritableMount && !exited) {
      activeWriters.push({ id, name, state: liveStatus });
    }
  }
  return {
    allExited: activeWriters.length === 0,
    volumeName,
    attachedContainers,
    activeWriters,
  };
}

export async function exportRegularFilesFromVolumeReadOnlyAsync(params: {
  volumeName: string;
  imageName?: string;
  approvedImageId: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
}): Promise<VolumeExportResult> {
  const imageName = params.imageName ?? DEFAULT_SANDBOX_IMAGE;
  const imgCheck = await verifyApprovedSandboxImageDigestAsync({
    approvedImageId: params.approvedImageId,
    imageName,
  });
  if (!imgCheck.ok) {
    return {
      ok: false,
      code: imgCheck.code,
      reason: imgCheck.reason,
      volumeName: params.volumeName,
      exporterImageId: null,
    };
  }
  const maxFiles = params.maxFiles ?? 16;
  const maxFileBytes = params.maxFileBytes ?? 512 * 1024;
  const maxTotalBytes = params.maxTotalBytes ?? 1024 * 1024;
  const exporterScript = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = "/export";
const MAX_FILES = ${maxFiles};
const MAX_FILE_BYTES = ${maxFileBytes};
const MAX_TOTAL_BYTES = ${maxTotalBytes};
const files = [];
let totalBytes = 0;
function fail(code, reason) {
  process.stdout.write(JSON.stringify({ ok: false, code, reason }) + "\\n");
  process.exit(0);
}
function walk(dirAbs, relPrefix) {
  const entries = fs.readdirSync(dirAbs);
  entries.sort();
  for (const name of entries) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\\\") || name.includes(":") || name.includes("\\0")) {
      fail("invalid_entry_name", "Rejected entry name: " + name);
    }
    const full = path.join(dirAbs, name);
    const rel = relPrefix ? relPrefix + "/" + name : name;
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) fail("symlink_rejected", "Symlink rejected in export volume: " + rel);
    if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) fail("non_regular_file_rejected", "Special device/FIFO/socket rejected in export volume: " + rel);
    if (st.isDirectory()) { walk(full, rel); continue; }
    if (!st.isFile()) fail("non_regular_file_rejected", "Unrecognized non-regular file type: " + rel);
    if (st.nlink > 1) fail("hardlink_rejected", "Hardlink rejected in export volume (nlink=" + st.nlink + "): " + rel);
    if (files.length + 1 > MAX_FILES) fail("file_count_quota_exceeded", "Export file count exceeds limit " + MAX_FILES);
    if (st.size > MAX_FILE_BYTES) fail("file_size_quota_exceeded", "File " + rel + " size " + st.size + " exceeds maxFileBytes " + MAX_FILE_BYTES);
    if (totalBytes + st.size > MAX_TOTAL_BYTES) fail("total_bytes_quota_exceeded", "Total export size exceeds maxTotalBytes " + MAX_TOTAL_BYTES);
    const buf = fs.readFileSync(full);
    if (buf.length !== st.size) fail("concurrent_mutation_detected", "File size changed during read-only export: " + rel);
    totalBytes += buf.length;
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    files.push({ relPath: rel, sizeBytes: buf.length, sha256, contentBase64: buf.toString("base64") });
  }
}
try {
  try {
    fs.writeFileSync(path.join(ROOT, ".ro-probe-" + Date.now()), "x");
    fail("export_mount_not_readonly", "Expected /export to be read-only");
  } catch (roErr) {
    if (roErr && roErr.code !== "EROFS" && roErr.code !== "EACCES" && roErr.code !== "EPERM") {}
  }
  walk(ROOT, "");
  process.stdout.write(JSON.stringify({ ok: true, readOnlyMountVerified: true, totalBytes, files }) + "\\n");
} catch (err) {
  fail("exporter_error", err && err.message ? err.message : String(err));
}
`;
  const res = await execDockerAsync(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "128m",
      "--pids-limit",
      "32",
      "-v",
      `${params.volumeName}:/export:ro`,
      imgCheck.immutableImageId,
      "node",
      "-e",
      exporterScript,
    ],
    params.timeoutMs ?? 25_000,
  );
  if (res.status !== 0) {
    return {
      ok: false,
      code: "exporter_container_failed",
      reason: res.stderr.trim() || `Exporter exited with status ${String(res.status)}`,
      volumeName: params.volumeName,
      exporterImageId: imgCheck.immutableImageId,
    };
  }
  const lastLine = res.stdout.trim().split(/\r?\n/).pop() ?? "";
  let parsed: {
    ok: boolean;
    code?: string;
    reason?: string;
    totalBytes?: number;
    files?: Array<{ relPath: string; sizeBytes: number; sha256: string; contentBase64: string }>;
  };
  try {
    parsed = JSON.parse(lastLine) as typeof parsed;
  } catch {
    return {
      ok: false,
      code: "exporter_malformed_output",
      reason: `Exporter returned non-JSON output: ${lastLine.slice(0, 200)}`,
      volumeName: params.volumeName,
    };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code ?? "exporter_rejected",
      reason: parsed.reason ?? "Exporter rejected volume contents",
      volumeName: params.volumeName,
    };
  }
  const verifiedFiles: ExportedRegularFile[] = [];
  for (const f of parsed.files ?? []) {
    const bytes = Buffer.from(f.contentBase64, "base64");
    const hostSha = createHash("sha256").update(bytes).digest("hex");
    if (hostSha !== f.sha256 || bytes.length !== f.sizeBytes) {
      return {
        ok: false,
        code: "export_digest_mismatch",
        reason: `Host SHA-256 mismatch on exported file ${f.relPath}`,
        volumeName: params.volumeName,
      };
    }
    verifiedFiles.push({ relPath: f.relPath, bytes, sizeBytes: bytes.length, sha256: hostSha });
  }
  return {
    ok: true,
    volumeName: params.volumeName,
    exporterImageId: imgCheck.immutableImageId,
    readOnlyMountVerified: true,
    files: verifiedFiles,
    totalBytes: parsed.totalBytes ?? verifiedFiles.reduce((s, f) => s + f.sizeBytes, 0),
  };
}

export async function stopAndRemoveContainerAsync(containerNameOrId: string): Promise<void> {
  if (!containerNameOrId) return;
  await execDockerAsync(["rm", "-f", containerNameOrId], 10_000);
}

export async function cleanupTaskVolumeAsync(volumeName: string): Promise<void> {
  if (!volumeName) return;
  const ps = await execDockerAsync(["ps", "-aq", "--filter", `volume=${volumeName}`], 10_000);
  const cids = ps.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const cid of cids) {
    await stopAndRemoveContainerAsync(cid);
  }
  await execDockerAsync(["volume", "rm", "-f", volumeName], 10_000);
}

export function stopAndRemoveContainer(containerNameOrId: string): void {
  execDockerSync(["rm", "-f", containerNameOrId], { timeoutMs: 10_000 });
}

export function cleanupTaskVolume(volumeName: string): void {
  const ps = execDockerSync(["ps", "-aq", "--filter", `volume=${volumeName}`], { timeoutMs: 10_000 });
  const cids = ps.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const cid of cids) {
    stopAndRemoveContainer(cid);
  }
  execDockerSync(["volume", "rm", "-f", volumeName], { timeoutMs: 10_000 });
}
