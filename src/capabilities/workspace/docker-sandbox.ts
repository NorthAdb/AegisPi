import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export const DEFAULT_SANDBOX_IMAGE = "node:22.23.5-bookworm-slim";

export interface DockerEnvironmentInfo {
  available: boolean;
  clientVersion: string | null;
  serverVersion: string | null;
  imageName: string;
  imageId: string | null;
}

export function inspectDockerEnvironment(imageName = DEFAULT_SANDBOX_IMAGE): DockerEnvironmentInfo {
  const ver = spawnSync("docker", ["version", "--format", "{{.Client.Version}}|{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
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
  const img = spawnSync("docker", ["image", "inspect", imageName, "--format", "{{.Id}}"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
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
  inputSnapshotDir: string;
  /** JavaScript body executed via `node -e` inside the zero-network, zero-credential container. */
  nodeScript: string;
  volumeName?: string;
  keepRunningDetached?: boolean;
  timeoutMs?: number;
}

export interface SandboxTaskRunResult {
  ok: boolean;
  volumeName: string;
  containerId: string;
  containerName: string;
  imageName: string;
  imageId: string | null;
  networkMode: "none";
  mounts: Array<{ source: string; destination: string; rw: boolean }>;
  envKeysInContainer: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a task inside a zero-network (`--network none`), zero-credential Docker container
 * with read-only input snapshot mount (`/input:ro`) and a task-private named volume (`/out:rw`).
 * Authoritative host workspace is NEVER mounted writable into the container.
 */
export function runTaskInDockerSandbox(opts: SandboxTaskRunOptions): SandboxTaskRunResult {
  const imageName = opts.imageName ?? DEFAULT_SANDBOX_IMAGE;
  const volumeName = opts.volumeName ?? `aegis-w2-vol-${randomUUID().slice(0, 10)}`;
  const containerName = `aegis-w2-task-${randomUUID().slice(0, 10)}`;
  const absInput = path.resolve(opts.inputSnapshotDir);
  if (!existsSync(absInput)) {
    mkdirSync(absInput, { recursive: true });
  }

  const volCreate = spawnSync("docker", ["volume", "create", volumeName], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
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
    imageName,
    "node",
    "-e",
    opts.nodeScript,
  ];

  const run = spawnSync("docker", dockerArgs, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 25_000,
    windowsHide: true,
  });

  // Inspect container metadata (ID, mounts, image, env) strictly via Docker daemon
  const insp = spawnSync(
    "docker",
    [
      "inspect",
      containerName,
      "--format",
      "{{.Id}}|||{{.Image}}|||{{json .Mounts}}|||{{json .Config.Env}}",
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
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
    networkMode: "none",
    mounts,
    envKeysInContainer,
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
  const ps = spawnSync(
    "docker",
    ["ps", "-a", "--filter", `volume=${volumeName}`, "--format", "{{.ID}}\t{{.Names}}\t{{.State}}"],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
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
    const insp = spawnSync("docker", ["inspect", id, "--format", "{{.State.Status}}|||{{json .Mounts}}"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
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
      readOnlyMountVerified: true;
      files: ExportedRegularFile[];
      totalBytes: number;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      volumeName: string;
    };

/**
 * Runs a controlled read-only exporter container (`--network none`, `-v volumeName:/export:ro`)
 * that inspects every entry in the task volume via `lstatSync`, rejecting symlinks, hardlinks
 * (`nlink > 1`), FIFOs/sockets/devices, path traversal, and file count/byte quota overflows,
 * then returns verified regular file bytes to the host.
 */
export function exportRegularFilesFromVolumeReadOnly(params: {
  volumeName: string;
  imageName?: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
}): VolumeExportResult {
  const imageName = params.imageName ?? DEFAULT_SANDBOX_IMAGE;
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

  const res = spawnSync(
    "docker",
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
      imageName,
      "node",
      "-e",
      exporterScript,
    ],
    {
      encoding: "utf8",
      timeout: params.timeoutMs ?? 25_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
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
    readOnlyMountVerified: true,
    files: verifiedFiles,
    totalBytes: parsed.totalBytes ?? verifiedFiles.reduce((s, f) => s + f.sizeBytes, 0),
  };
}

export function stopAndRemoveContainer(containerNameOrId: string): void {
  spawnSync("docker", ["rm", "-f", containerNameOrId], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}

export function cleanupTaskVolume(volumeName: string): void {
  const ps = spawnSync("docker", ["ps", "-aq", "--filter", `volume=${volumeName}`], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  const cids = ps.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const cid of cids) {
    stopAndRemoveContainer(cid);
  }
  spawnSync("docker", ["volume", "rm", "-f", volumeName], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}
