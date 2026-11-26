import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  cleanupTaskVolume,
  DEFAULT_SANDBOX_IMAGE,
  exportRegularFilesFromVolumeReadOnly,
  inspectDockerEnvironment,
  runTaskInDockerSandbox,
  stopAndRemoveContainer,
} from "../../src/capabilities/workspace/docker-sandbox.ts";
import {
  ManagedWorkspaceImporter,
  sha256FileIfExists,
} from "../../src/capabilities/workspace/importer.ts";
import { ensureScope } from "../../src/governance/approvals.ts";
import { openGovernanceDb } from "../../src/governance/db.ts";
import {
  grantModelDisclosure,
  grantSourceRead,
  recordConversationSource,
  revokeSourceReadGrant,
} from "../../src/governance/policy.ts";
import { ensureActiveEpochAndManifest } from "../../src/governance/recovery.ts";
import { LOCKED_NODE_EXE, startFakeModelServer, startFakeSmtpServer } from "../fakes/client.ts";
import { parseWeek2CliArgs, rmDirWithRetry } from "./cli-helpers.ts";

function sha256Text(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

function forceKillWindowsPid(pid: number): void {
  spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
}

async function waitForFile(filePath: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const txt = readFileSync(filePath, "utf8").trim();
      if (txt.length > 0) return txt;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`Timed out waiting for barrier file: ${filePath}`);
}

interface SpawnedFormalHost {
  pid: number;
  baseUrl: string;
  runtimeEpoch: string;
  reconciledFileImports: Array<{
    importId: string;
    logicalKey: string;
    conversationId: string;
    targetRelPath: string;
    outcome: string;
    installCount: number;
    diskRewritten: boolean;
  }>;
  stop: () => Promise<void>;
}

async function spawnFormalHost(opts: {
  dataDir: string;
  modelBaseUrl: string;
  smtpHost: string;
  smtpPort: number;
  consoleToken: string;
  connectorsConfigPath: string;
  extraArgs?: string[];
}): Promise<SpawnedFormalHost> {
  const child = spawn(
    LOCKED_NODE_EXE,
    [
      path.resolve("src/index.ts"),
      "--data-dir",
      opts.dataDir,
      "--port",
      "0",
      "--model-base-url",
      opts.modelBaseUrl,
      "--smtp-host",
      opts.smtpHost,
      "--smtp-port",
      String(opts.smtpPort),
      "--console-token",
      opts.consoleToken,
      "--connectors-config",
      opts.connectorsConfigPath,
      ...(opts.extraArgs ?? []),
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );

  let stderr = "";
  let buf = "";
  const ready = await new Promise<{
    pid: number;
    baseUrl: string;
    runtimeEpoch: string;
    reconciledFileImports: SpawnedFormalHost["reconciledFileImports"];
  }>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Formal host start timeout. stderr=${stderr}`)), 25_000);
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    const onOut = (d: Buffer): void => {
      buf += d.toString("utf8");
      for (const line of buf.split(/\r?\n/)) {
        const tr = line.trim();
        if (!tr.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(tr) as {
            ready?: boolean;
            pid: number;
            baseUrl: string;
            runtimeEpoch: string;
            reconciledFileImports?: SpawnedFormalHost["reconciledFileImports"];
          };
          if (parsed.ready) {
            clearTimeout(t);
            child.stdout.off("data", onOut);
            resolve({
              pid: parsed.pid,
              baseUrl: parsed.baseUrl,
              runtimeEpoch: parsed.runtimeEpoch,
              reconciledFileImports: parsed.reconciledFileImports ?? [],
            });
            return;
          }
        } catch {
          // keep scanning
        }
      }
    };
    child.stdout.on("data", onOut);
    child.once("exit", (c) => {
      clearTimeout(t);
      reject(new Error(`Formal host exited early (${String(c)}). stderr=${stderr}`));
    });
  });

  return {
    pid: ready.pid,
    baseUrl: ready.baseUrl,
    runtimeEpoch: ready.runtimeEpoch,
    reconciledFileImports: ready.reconciledFileImports,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          forceKillWindowsPid(ready.pid);
          resolve();
        }, 4000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

async function httpLogin(baseUrl: string, token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ token }),
  });
  assert.equal(res.status, 200, `Login failed: ${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

export async function runV03(opts?: { dataDir?: string; evidenceDir?: string }) {
  const runId = `v03_${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(opts?.dataDir ?? `.tmp-week2-v03-${Date.now()}`);
  const evidenceDir = path.resolve(opts?.evidenceDir ?? path.join(rootDir, "evidence"));
  const workspaceRoot = path.join(rootDir, "workspace");
  const inputSnapDir = path.join(rootDir, "input-snapshot");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(inputSnapDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const dockerEnv = inspectDockerEnvironment(DEFAULT_SANDBOX_IMAGE);
  assert.equal(
    dockerEnv.available,
    true,
    `Docker + ${DEFAULT_SANDBOX_IMAGE} must be available for V03: ${JSON.stringify(dockerEnv)}`,
  );
  const approvedImageId = dockerEnv.imageId!;
  assert.ok(approvedImageId && approvedImageId.startsWith("sha256:"), "Immutable image digest required");

  const { db: govDb } = openGovernanceDb(path.join(rootDir, "aegis-gov.sqlite"));
  const volumesToClean: string[] = [];
  const containersToClean: string[] = [];

  try {
    const now = Date.now();
    const { epoch } = ensureActiveEpochAndManifest(govDb, now);
    ensureScope(govDb, {
      scopeId: "scope:default",
      allowedPrincipals: ["owner"],
      allowedTools: ["workspace_write_managed"],
      allowedTargets: ["*"],
    });

    const writeGrant = grantSourceRead(govDb, {
      principalId: "owner",
      scopeId: "scope:default",
      sourceType: "workspace_write",
      resourceId: "workspace",
      operations: ["write"],
      constraints: {
        allowedRelPaths: ["reports/weekly.md", "reports/new-note.md", "reports/crash-test.md"],
      },
      now,
    });

    const importer = new ManagedWorkspaceImporter(workspaceRoot);
    writeFileSync(path.join(inputSnapDir, "input.txt"), "Project Helios snapshot input\n", "utf8");

    // =========================================================================
    // 0. W2-G2: Missing or mismatched immutable image digest MUST fail BEFORE docker run!
    // =========================================================================
    const missingDigestExec = runTaskInDockerSandbox({
      approvedImageId: "",
      inputSnapshotDir: inputSnapDir,
      nodeScript: `process.exit(0);`,
    });
    assert.equal(missingDigestExec.ok, false);
    assert.equal(missingDigestExec.code, "unapproved_or_missing_image_digest");
    assert.equal(missingDigestExec.containerId, "");

    const wrongDigest = "sha256:" + "0".repeat(64);
    const wrongDigestExec = runTaskInDockerSandbox({
      approvedImageId: wrongDigest,
      inputSnapshotDir: inputSnapDir,
      nodeScript: `process.exit(0);`,
    });
    assert.equal(wrongDigestExec.ok, false);
    assert.equal(wrongDigestExec.code, "approved_image_digest_not_found");
    assert.equal(wrongDigestExec.containerId, "");

    const wrongDigestExp = exportRegularFilesFromVolumeReadOnly({
      volumeName: "unused-vol",
      approvedImageId: wrongDigest,
    });
    assert.equal(wrongDigestExp.ok, false);
    if (!wrongDigestExp.ok) {
      assert.equal(wrongDigestExp.code, "approved_image_digest_not_found");
    }

    // =========================================================================
    // 1. Normal Import (zero-net, zero-cred container by immutable digest -> private volume -> RO export -> atomic install)
    // =========================================================================
    const expectedNormalText = `# Project Helios 周报差异核对 (${runId})\n- 邮件：2026-12-10\n- README：2026-12-03\n`;
    const expectedNormalSha = sha256Text(expectedNormalText);

    const normalRun = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: inputSnapDir,
      nodeScript: `
        const fs = require("node:fs");
        const inp = fs.readFileSync("/input/input.txt", "utf8");
        if (!inp.includes("Project Helios")) throw new Error("missing input snapshot");
        fs.mkdirSync("/out/reports", { recursive: true });
        fs.writeFileSync("/out/reports/weekly.md", ${JSON.stringify(expectedNormalText)}, "utf8");
      `,
    });
    volumesToClean.push(normalRun.volumeName);
    containersToClean.push(normalRun.containerName);
    assert.equal(normalRun.ok, true, `Normal sandbox container failed: ${normalRun.stderr}`);
    assert.equal(normalRun.executorImageId?.toLowerCase(), approvedImageId.toLowerCase());
    assert.equal(normalRun.networkMode, "none");
    assert.equal(
      normalRun.mounts.some((m) => m.destination === "/input" && m.rw === false),
      true,
    );
    assert.equal(
      normalRun.mounts.some((m) => m.destination === "/out" && m.rw === true && m.source === normalRun.volumeName),
      true,
    );
    assert.equal(
      normalRun.mounts.some((m) => m.source.toLowerCase().includes(workspaceRoot.toLowerCase())),
      false,
    );

    const normalImport = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-normal-${runId}`,
      volumeName: normalRun.volumeName,
      approvedImageId,
      containerId: normalRun.containerId,
      targetRelPath: "reports/weekly.md",
      baseSha256: null,
      now,
    });
    assert.equal(normalImport.ok, true, JSON.stringify(normalImport));
    assert.equal(normalImport.state, "INSTALLED");
    assert.equal(normalImport.exporterImageId?.toLowerCase(), approvedImageId.toLowerCase());
    assert.equal(normalImport.artifactSha256, expectedNormalSha);
    assert.equal(normalImport.currentTargetSha256After, expectedNormalSha);
    assert.equal(normalImport.installCount, 1);
    assert.equal(normalImport.writerCheck?.allExited, true);
    assert.equal(readFileSync(path.join(workspaceRoot, "reports", "weekly.md"), "utf8"), expectedNormalText);

    // =========================================================================
    // 2. Conflict: User edited target file AFTER snapshot -> preserve BOTH versions!
    // =========================================================================
    const userEditedText = "USER_MANUAL_EDIT_AFTER_SNAPSHOT_MUST_BE_PRESERVED\n";
    const userEditedSha = sha256Text(userEditedText);
    writeFileSync(path.join(workspaceRoot, "reports", "weekly.md"), userEditedText, "utf8");

    const candidateConflictText = "CANDIDATE_FROM_TASK_VOLUME_CONFLICT_VERSION\n";
    const candidateConflictSha = sha256Text(candidateConflictText);
    const conflictRun = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: inputSnapDir,
      nodeScript: `
        const fs = require("node:fs");
        fs.mkdirSync("/out/reports", { recursive: true });
        fs.writeFileSync("/out/reports/weekly.md", ${JSON.stringify(candidateConflictText)}, "utf8");
      `,
    });
    volumesToClean.push(conflictRun.volumeName);
    containersToClean.push(conflictRun.containerName);
    assert.equal(conflictRun.ok, true);

    const conflictImport = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-conflict-edit-${runId}`,
      volumeName: conflictRun.volumeName,
      approvedImageId,
      containerId: conflictRun.containerId,
      targetRelPath: "reports/weekly.md",
      baseSha256: expectedNormalSha,
      now: now + 10,
    });
    assert.equal(conflictImport.ok, false);
    assert.equal(conflictImport.code, "version_conflict");
    assert.equal(conflictImport.state, "CONFLICT_SAVED");
    assert.equal(conflictImport.currentTargetSha256After, userEditedSha);
    assert.ok(conflictImport.conflictRelPath);
    const conflictAbs = path.join(workspaceRoot, ...conflictImport.conflictRelPath.split("/"));
    assert.equal(existsSync(conflictAbs), true);
    assert.equal(sha256FileIfExists(conflictAbs), candidateConflictSha);

    // 2b. Conflict when base was absent (null) and user created target file in meantime!
    const userCreatedNew = "USER_CREATED_NEW_FILE_BEFORE_IMPORT\n";
    const userCreatedNewSha = sha256Text(userCreatedNew);
    writeFileSync(path.join(workspaceRoot, "reports", "new-note.md"), userCreatedNew, "utf8");
    const newConflictRun = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: inputSnapDir,
      nodeScript: `
        const fs = require("node:fs");
        fs.mkdirSync("/out/reports", { recursive: true });
        fs.writeFileSync("/out/reports/new-note.md", "CANDIDATE_NEW_NOTE\\n", "utf8");
      `,
    });
    volumesToClean.push(newConflictRun.volumeName);
    containersToClean.push(newConflictRun.containerName);
    const newConflictImport = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-conflict-new-${runId}`,
      volumeName: newConflictRun.volumeName,
      approvedImageId,
      targetRelPath: "reports/new-note.md",
      baseSha256: null,
      now: now + 20,
    });
    assert.equal(newConflictImport.state, "CONFLICT_SAVED");
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "new-note.md")), userCreatedNewSha);
    assert.ok(newConflictImport.conflictRelPath);

    // =========================================================================
    // 2c. W2-S2: Parent source read grant revoked (while workspace_write stays ACTIVE)
    //     -> BOTH normal import AND conflict import MUST reject with 0 bytes changed & 0 new conflict files!
    // =========================================================================
    const parentMemGrant = grantSourceRead(govDb, {
      principalId: "owner",
      scopeId: "scope:default",
      sourceType: "memory",
      resourceId: "memory:projects",
      operations: ["read"],
      now: now + 22,
    });
    recordConversationSource(govDb, {
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "2",
      principalId: "owner",
      sourceType: "memory",
      sourceId: "memory:v03-parent-note",
      versionRef: "v1",
      title: "Parent Source for V03",
      contentDigest: "b".repeat(64),
      metadata: { domain: "projects", tier: "L1" },
      now: now + 23,
    });
    revokeSourceReadGrant(govDb, {
      grantId: parentMemGrant.grant_id,
      reason: "w2_s2_revoke_parent_source_before_import",
      now: now + 24,
    });
    const reportsBeforeSrcRev = readdirSync(path.join(workspaceRoot, "reports")).sort();
    const revokedParentImport = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "2",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-revoked-parent-${runId}`,
      volumeName: conflictRun.volumeName,
      approvedImageId,
      targetRelPath: "reports/weekly.md",
      baseSha256: expectedNormalSha, // would otherwise create a conflict file!
      now: now + 25,
    });
    assert.equal(revokedParentImport.ok, false);
    assert.equal(revokedParentImport.code, "source_read_revoked");
    assert.equal(revokedParentImport.state, "REJECTED");
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "weekly.md")), userEditedSha);
    assert.deepEqual(
      readdirSync(path.join(workspaceRoot, "reports")).sort(),
      reportsBeforeSrcRev,
      "W2-S2: Revoked parent source MUST NOT write target OR create any conflict candidate file",
    );

    // =========================================================================
    // 3. Active Writer Still Running on Volume -> ABORT IMPORT, target unchanged!
    // =========================================================================
    const lingeringRun = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: inputSnapDir,
      keepRunningDetached: true,
      nodeScript: `
        const fs = require("node:fs");
        fs.mkdirSync("/out/reports", { recursive: true });
        fs.writeFileSync("/out/reports/weekly.md", "WRITER_STILL_RUNNING\\n", "utf8");
        setInterval(() => {}, 1000);
      `,
    });
    volumesToClean.push(lingeringRun.volumeName);
    containersToClean.push(lingeringRun.containerName);
    await new Promise((r) => setTimeout(r, 400));

    const activeWriterImport = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-active-writer-${runId}`,
      volumeName: lingeringRun.volumeName,
      approvedImageId,
      targetRelPath: "reports/weekly.md",
      baseSha256: userEditedSha,
      now: now + 30,
    });
    stopAndRemoveContainer(lingeringRun.containerName);
    assert.equal(activeWriterImport.ok, false);
    assert.equal(activeWriterImport.code, "active_volume_writers");
    assert.equal(activeWriterImport.state, "REJECTED");
    assert.equal(activeWriterImport.writerCheck?.allExited, false);
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "weekly.md")), userEditedSha);

    // =========================================================================
    // 4. Non-Regular Files (Symlink, Hardlink) & Quota Overflow & Path Jail Rejections
    // =========================================================================
    const symRun = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: inputSnapDir,
      nodeScript: `
        const fs = require("node:fs");
        fs.mkdirSync("/out/reports", { recursive: true });
        fs.symlinkSync("/etc/passwd", "/out/reports/weekly.md");
      `,
    });
    volumesToClean.push(symRun.volumeName);
    containersToClean.push(symRun.containerName);
    const symImport = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-symlink-${runId}`,
      volumeName: symRun.volumeName,
      approvedImageId,
      targetRelPath: "reports/weekly.md",
      baseSha256: userEditedSha,
      now: now + 40,
    });
    assert.equal(symImport.ok, false);
    assert.equal(symImport.code, "symlink_rejected");
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "weekly.md")), userEditedSha);

    const hardRun = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: inputSnapDir,
      nodeScript: `
        const fs = require("node:fs");
        fs.mkdirSync("/out/reports", { recursive: true });
        fs.writeFileSync("/out/reports/orig.md", "hardlink payload", "utf8");
        fs.linkSync("/out/reports/orig.md", "/out/reports/weekly.md");
      `,
    });
    volumesToClean.push(hardRun.volumeName);
    containersToClean.push(hardRun.containerName);
    const hardImport = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-hardlink-${runId}`,
      volumeName: hardRun.volumeName,
      approvedImageId,
      targetRelPath: "reports/weekly.md",
      baseSha256: userEditedSha,
      now: now + 50,
    });
    assert.equal(hardImport.ok, false);
    assert.equal(hardImport.code, "hardlink_rejected");
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "weekly.md")), userEditedSha);

    const bigRun = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: inputSnapDir,
      nodeScript: `
        const fs = require("node:fs");
        fs.mkdirSync("/out/reports", { recursive: true });
        fs.writeFileSync("/out/reports/weekly.md", "A".repeat(4096), "utf8");
      `,
    });
    volumesToClean.push(bigRun.volumeName);
    containersToClean.push(bigRun.containerName);
    const bigImport = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-quota-${runId}`,
      volumeName: bigRun.volumeName,
      approvedImageId,
      targetRelPath: "reports/weekly.md",
      baseSha256: userEditedSha,
      maxFileBytes: 1024,
      now: now + 60,
    });
    assert.equal(bigImport.ok, false);
    assert.equal(bigImport.code, "file_size_quota_exceeded");
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "weekly.md")), userEditedSha);

    const adsRej = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-ads-${runId}`,
      volumeName: normalRun.volumeName,
      approvedImageId,
      targetRelPath: "reports/weekly.md:hidden",
      baseSha256: null,
      now: now + 65,
    });
    assert.equal(adsRej.code, "windows_ads_or_drive_rejected");

    const travRej = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-trav-${runId}`,
      volumeName: normalRun.volumeName,
      approvedImageId,
      targetRelPath: "../outside.md",
      baseSha256: null,
      now: now + 66,
    });
    assert.equal(travRej.code, "path_traversal_or_empty_segment");

    const devRej = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-dev-${runId}`,
      volumeName: normalRun.volumeName,
      approvedImageId,
      targetRelPath: "reports/CON.md",
      baseSha256: null,
      now: now + 67,
    });
    assert.equal(devRej.code, "windows_device_name_rejected");

    // Revoked Write Grant -> Rejected, target unchanged!
    revokeSourceReadGrant(govDb, { grantId: writeGrant.grant_id, reason: "v03_revoke_write", now: now + 90 });
    const revokedWrite = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-revoked-${runId}`,
      volumeName: normalRun.volumeName,
      approvedImageId,
      targetRelPath: "reports/weekly.md",
      baseSha256: userEditedSha,
      now: now + 95,
    });
    assert.equal(revokedWrite.ok, false);
    assert.equal(revokedWrite.code, "workspace_write_denied");
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "weekly.md")), userEditedSha);

    // =========================================================================
    // 4b. W2-S3 Round 3 Hardening Checks:
    //     (a) Overlapping same-path tasks with isolated per-task frozen input snapshots & baselines
    //     (b) Revocation DURING async export window (onBeforeCommitWrite) -> 0 bytes written to target OR conflict
    //     (c) baseSha256 === artifactSha256: both no-op short-circuit AND ambiguous PREPARED startup recovery!
    // =========================================================================
    const overlapGrant = grantSourceRead(govDb, {
      principalId: "owner",
      scopeId: "scope:default",
      sourceType: "workspace_write",
      resourceId: "workspace",
      operations: ["write"],
      constraints: { allowedRelPaths: ["reports/overlap.md", "reports/mid-revoke.md", "reports/same-hash.md"] },
      now: now + 100,
    });
    const overlapPath = path.join(workspaceRoot, "reports", "overlap.md");
    const overlapV0 = "OVERLAP_V0_INITIAL\n";
    writeFileSync(overlapPath, overlapV0, "utf8");
    const overlapV0Sha = sha256Text(overlapV0);

    // Place BOTH an unauthorized host secret file AND an ungranted tracked path in workspaceRoot!
    mkdirSync(path.join(workspaceRoot, "secrets"), { recursive: true });
    writeFileSync(path.join(workspaceRoot, "secrets", "host-private.txt"), "TOP_SECRET_MUST_NEVER_MOUNT_IN_INPUT\n", "utf8");
    writeFileSync(path.join(workspaceRoot, "reports", "ungranted-tracked.md"), "UNGRANTED_FILE_MUST_NEVER_MOUNT_IN_INPUT\n", "utf8");

    // Freeze TWO independent per-task snapshots while overlap.md == V0!
    // Also verify snapshots include ONLY authorized paths (NEVER secrets/host-private.txt or reports/ungranted-tracked.md)!
    const snapRoot = path.join(rootDir, "per-task-snaps");
    const taskSnapA = importer.createTaskFrozenSnapshot({
      snapshotRootDir: snapRoot,
      govDb,
      principalId: "owner",
      scopeId: "scope:default",
      candidateRelPaths: ["reports/overlap.md", "reports/ungranted-tracked.md", "secrets/host-private.txt"],
    });
    const taskSnapB = importer.createTaskFrozenSnapshot({
      snapshotRootDir: snapRoot,
      govDb,
      principalId: "owner",
      scopeId: "scope:default",
      candidateRelPaths: ["reports/overlap.md", "reports/ungranted-tracked.md", "secrets/host-private.txt"],
    });
    assert.notEqual(taskSnapA.snapshotDir, taskSnapB.snapshotDir, "W2-S3: Concurrent tasks MUST NOT share one input snapshot directory");
    assert.equal(taskSnapA.getBaseline("reports/overlap.md"), overlapV0Sha);
    assert.equal(taskSnapB.getBaseline("reports/overlap.md"), overlapV0Sha);
    assert.equal(existsSync(path.join(taskSnapA.snapshotDir, "reports", "overlap.md")), true);
    assert.equal(existsSync(path.join(taskSnapA.snapshotDir, "secrets", "host-private.txt")), false, "W2-S3: Unauthorized file MUST NOT enter frozen /input");
    assert.equal(existsSync(path.join(taskSnapA.snapshotDir, "reports", "ungranted-tracked.md")), false, "W2-S3: Ungranted tracked file MUST NOT enter frozen /input");

    const overlapV1 = `OVERLAP_TASK_A_V1_${runId}\n`;
    const overlapV1Sha = sha256Text(overlapV1);
    const runOverlapA = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: taskSnapA.snapshotDir,
      nodeScript: `
        const fs = require('fs');
        const path = require('path');
        const seen = [];
        function walk(dir, rel) {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const r = rel ? rel + '/' + ent.name : ent.name;
            if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
            else seen.push(r);
          }
        }
        walk('/input', '');
        if (seen.some(p => p.includes('host-private') || p.includes('ungranted-tracked'))) {
          throw new Error('Unauthorized file visible in /input: ' + JSON.stringify(seen));
        }
        process.stdout.write('INPUT_FILES=' + JSON.stringify(seen.sort()) + '\\n');
        fs.mkdirSync('/out/reports', { recursive: true });
        fs.writeFileSync('/out/reports/overlap.md', ${JSON.stringify(overlapV1)}, 'utf8');
      `,
    });
    volumesToClean.push(runOverlapA.volumeName);
    containersToClean.push(runOverlapA.containerName);
    assert.equal(runOverlapA.ok, true, `Overlap A sandbox failed: ${runOverlapA.stderr}`);
    assert.ok(runOverlapA.stdout.includes("INPUT_FILES="));
    const observedContainerInputLine = runOverlapA.stdout.split(/\r?\n/).find((l) => l.startsWith("INPUT_FILES="))!;
    const observedContainerInputFiles = JSON.parse(observedContainerInputLine.slice("INPUT_FILES=".length)) as string[];
    assert.equal(observedContainerInputFiles.includes("reports/overlap.md"), true);
    assert.equal(observedContainerInputFiles.includes("secrets/host-private.txt"), false);
    assert.equal(observedContainerInputFiles.includes("reports/ungranted-tracked.md"), false);

    const overlapV2 = `OVERLAP_TASK_B_V2_${runId}\n`;
    const runOverlapB = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: taskSnapB.snapshotDir,
      nodeScript: `const fs=require('fs');fs.mkdirSync('/out/reports',{recursive:true});fs.writeFileSync('/out/reports/overlap.md',${JSON.stringify(overlapV2)},'utf8');`,
    });
    volumesToClean.push(runOverlapB.volumeName);
    containersToClean.push(runOverlapB.containerName);
    assert.equal(runOverlapB.ok, true);

    // Task A installs V1 cleanly against Task A's frozen V0 baseline (using fresh conversation without revoked weekly.md source)
    const impOverlapA = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "overlap-conv-a",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-overlap-a-${runId}`,
      volumeName: runOverlapA.volumeName,
      approvedImageId,
      targetRelPath: "reports/overlap.md",
      baseSha256: taskSnapA.getBaseline("reports/overlap.md"),
      now: now + 101,
    });
    assert.equal(impOverlapA.ok, true);
    assert.equal(impOverlapA.state, "INSTALLED");
    assert.equal(sha256FileIfExists(overlapPath), overlapV1Sha);

    // Task B STILL holds its own frozen V0 baseline (NOT advanced by Task A!) -> detects conflict and preserves BOTH!
    assert.equal(taskSnapB.getBaseline("reports/overlap.md"), overlapV0Sha);
    const impOverlapB = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "overlap-conv-b",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-overlap-b-${runId}`,
      volumeName: runOverlapB.volumeName,
      approvedImageId,
      targetRelPath: "reports/overlap.md",
      baseSha256: taskSnapB.getBaseline("reports/overlap.md"),
      now: now + 102,
    });
    assert.equal(impOverlapB.ok, false);
    assert.equal(impOverlapB.state, "CONFLICT_SAVED");
    assert.ok(impOverlapB.conflictRelPath);
    assert.equal(sha256FileIfExists(overlapPath), overlapV1Sha, "W2-S3: Overlapping Task B MUST preserve Task A's installed version");
    taskSnapA.cleanup();
    taskSnapB.cleanup();

    // (b) Revocation DURING async export window (right before install/conflict write):
    //     Verify BOTH target bytes AND conflict candidate count stay strictly unchanged!
    const midRevPath = path.join(workspaceRoot, "reports", "mid-revoke.md");
    const midRevOrig = "MID_EXPORT_REVOKE_ORIGINAL\n";
    writeFileSync(midRevPath, midRevOrig, "utf8");
    const midRevOrigSha = sha256Text(midRevOrig);
    const midRevSrcGrant = grantSourceRead(govDb, {
      principalId: "owner",
      scopeId: "scope:default",
      sourceType: "memory",
      resourceId: "memory:mid-export-domain",
      operations: ["read"],
      now: now + 103,
    });
    recordConversationSource(govDb, {
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "mid-rev-conv",
      principalId: "owner",
      sourceType: "memory",
      sourceId: "memory:mid-note",
      versionRef: "v1",
      title: "Mid-export source",
      contentDigest: "c".repeat(64),
      metadata: { domain: "mid-export-domain", tier: "L1" },
      now: now + 103,
    });
    const runMidRev = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: inputSnapDir,
      nodeScript: `const fs=require('fs');fs.mkdirSync('/out/reports',{recursive:true});fs.writeFileSync('/out/reports/mid-revoke.md','SHOULD_NOT_WRITE_AFTER_MID_EXPORT_REVOKE\\n','utf8');`,
    });
    volumesToClean.push(runMidRev.volumeName);
    containersToClean.push(runMidRev.containerName);
    assert.equal(runMidRev.ok, true);
    const reportsFilesBeforeMidRev = readdirSync(path.join(workspaceRoot, "reports")).length;
    const impMidRev = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "mid-rev-conv",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-mid-rev-${runId}`,
      volumeName: runMidRev.volumeName,
      approvedImageId,
      targetRelPath: "reports/mid-revoke.md",
      // Even with a differing baseSha256 (which would normally trigger conflict candidate write!), MUST write 0 bytes!
      baseSha256: "0".repeat(64),
      now: now + 104,
      onBeforeCommitWrite: () => {
        revokeSourceReadGrant(govDb, {
          grantId: midRevSrcGrant.grant_id,
          reason: "w2_s3_revoke_during_export",
          now: now + 104,
        });
      },
    });
    assert.equal(impMidRev.ok, false);
    assert.equal(impMidRev.code, "source_read_revoked");
    assert.equal(sha256FileIfExists(midRevPath), midRevOrigSha, "W2-S3: Target bytes MUST NOT change on mid-export source revocation");
    assert.equal(
      readdirSync(path.join(workspaceRoot, "reports")).length,
      reportsFilesBeforeMidRev,
      "W2-S3: Conflict candidate MUST NOT be written on mid-export source revocation",
    );

    // Also test workspace_write grant revoked during async export!
    const runMidWriteRev = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: inputSnapDir,
      nodeScript: `const fs=require('fs');fs.mkdirSync('/out/reports',{recursive:true});fs.writeFileSync('/out/reports/mid-revoke.md','SHOULD_NOT_WRITE_AFTER_WRITE_REVOKE\\n','utf8');`,
    });
    volumesToClean.push(runMidWriteRev.volumeName);
    containersToClean.push(runMidWriteRev.containerName);
    assert.equal(runMidWriteRev.ok, true);
    const impMidWriteRev = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "mid-write-rev-conv",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-mid-write-rev-${runId}`,
      volumeName: runMidWriteRev.volumeName,
      approvedImageId,
      targetRelPath: "reports/mid-revoke.md",
      baseSha256: midRevOrigSha,
      now: now + 105,
      onBeforeCommitWrite: () => {
        revokeSourceReadGrant(govDb, {
          grantId: overlapGrant.grant_id,
          reason: "w2_s3_revoke_write_during_export",
          now: now + 105,
        });
      },
    });
    assert.equal(impMidWriteRev.ok, false);
    assert.equal(impMidWriteRev.code, "workspace_write_denied");
    assert.equal(sha256FileIfExists(midRevPath), midRevOrigSha);
    assert.equal(readdirSync(path.join(workspaceRoot, "reports")).length, reportsFilesBeforeMidRev);

    // (c) baseSha256 === artifactSha256:
    //     (i) Normal path short-circuits cleanly to noop_unchanged (installCount=0, no disk rewrite)
    //     (ii) Crash recovery on PREPARED row with base_sha256 === artifact_sha256 -> PENDING_RECONCILE (ambiguous_same_hash_without_install_proof)!
    grantSourceRead(govDb, {
      principalId: "owner",
      scopeId: "scope:default",
      sourceType: "workspace_write",
      resourceId: "workspace",
      operations: ["write"],
      constraints: { allowedRelPaths: ["reports/same-hash.md"] },
      now: now + 106,
    });
    const sameHashPath = path.join(workspaceRoot, "reports", "same-hash.md");
    const sameHashText = "IDENTICAL_BASELINE_AND_ARTIFACT\n";
    writeFileSync(sameHashPath, sameHashText, "utf8");
    const sameHashSha = sha256Text(sameHashText);
    const sameHashMtimeBefore = statSync(sameHashPath).mtimeMs;
    const runSameHash = runTaskInDockerSandbox({
      approvedImageId,
      inputSnapshotDir: inputSnapDir,
      nodeScript: `const fs=require('fs');fs.mkdirSync('/out/reports',{recursive:true});fs.writeFileSync('/out/reports/same-hash.md',${JSON.stringify(sameHashText)},'utf8');`,
    });
    volumesToClean.push(runSameHash.volumeName);
    containersToClean.push(runSameHash.containerName);
    assert.equal(runSameHash.ok, true);
    const impSameHashNoop = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "same-hash-conv",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-same-hash-noop-${runId}`,
      volumeName: runSameHash.volumeName,
      approvedImageId,
      targetRelPath: "reports/same-hash.md",
      baseSha256: sameHashSha,
      now: now + 107,
    });
    assert.equal(impSameHashNoop.ok, true);
    assert.equal(impSameHashNoop.code, "noop_unchanged");
    assert.equal(impSameHashNoop.installCount, 0);
    assert.equal(statSync(sameHashPath).mtimeMs, sameHashMtimeBefore, "W2-S3: Same-hash no-op MUST NOT touch disk");

    // Seed an ambiguous PREPARED row where base_sha256 === artifact_sha256 and run startup reconciliation!
    const ambigKey = `imp-same-hash-ambig-${runId}`;
    govDb
      .prepare(
        `INSERT INTO managed_file_imports(
           import_id, logical_key, runtime_epoch, conversation_id, principal_id, scope_id,
           target_rel_path, base_sha256, artifact_sha256, artifact_bytes, volume_name, container_id,
           state, conflict_rel_path, install_count, reason, parent_source_ids_json, created_at, updated_at
         ) VALUES (?, ?, ?, '1', 'owner', 'scope:default', 'reports/same-hash.md', ?, ?, ?, 'vol-ambig', NULL,
                   'PREPARED', NULL, 0, NULL, '[]', ?, ?)`,
      )
      .run(
        `imp_ambig_${runId}`,
        ambigKey,
        epoch.runtime_epoch,
        sameHashSha,
        sameHashSha,
        Buffer.byteLength(sameHashText),
        now + 108,
        now + 108,
      );
    const ambigRec = importer.reconcilePendingImportsOnStartup(govDb, epoch.runtime_epoch, now + 109);
    const ambigItem = ambigRec.find((r) => r.logicalKey === ambigKey);
    assert.ok(ambigItem);
    assert.equal(
      ambigItem.outcome,
      "pending_reconcile",
      "W2-S3: PREPARED row with base_sha256 === artifact_sha256 MUST reconcile conservatively to pending_reconcile",
    );
    const ambigDbRow = govDb
      .prepare("SELECT state, reason FROM managed_file_imports WHERE logical_key = ?")
      .get(ambigKey) as { state: string; reason: string };
    assert.equal(ambigDbRow.state, "PENDING_RECONCILE");
    assert.equal(ambigDbRow.reason, "ambiguous_same_hash_without_install_proof");

    // =========================================================================
    // 5. W2-S3: REAL FORMAL HOST (src/index.ts) Crash AFTER Atomic Install & BEFORE Gov Receipt
    //    + Real Windows Stop-Process -Force + Normal Startup Step 5c Recovery
    //    + Host Baseline Snapshot Ignores Model-Spoofed baseSha256!
    // =========================================================================
    const formalDir = path.join(rootDir, "formal-host-v03");
    const formalDataDir = path.join(formalDir, "host-data");
    const formalWorkspace = path.join(formalDir, "workspace");
    mkdirSync(formalDataDir, { recursive: true });
    mkdirSync(formalWorkspace, { recursive: true });
    const fakeModel = await startFakeModelServer(path.join(formalDir, "fake-model"));
    const fakeSmtp = await startFakeSmtpServer(path.join(formalDir, "fake-smtp"), { mode: "normal" });

    let formalHostKillPid = 0;
    let formalRestartedPid = 0;
    let formalCrashLogicalKey = "";
    let formalCrashSha = "";
    let formalConflictRelPath: string | null = null;
    let sequentialV1Sha = "";
    let sequentialV2Sha = "";
    let sequentialAuthorizedInputs: string[] = [];
    try {
      // Pre-seed write grant in formal host governance DB
      const { db: seedDb } = openGovernanceDb(path.join(formalDataDir, "aegis-gov.sqlite"));
      ensureActiveEpochAndManifest(seedDb, now);
      ensureScope(seedDb, {
        scopeId: "scope:default",
        allowedPrincipals: ["owner"],
        allowedTools: ["send_email", "run_worker", "workspace_write_managed"],
        allowedTargets: ["*"],
      });
      grantSourceRead(seedDb, {
        principalId: "owner",
        scopeId: "scope:default",
        sourceType: "workspace_write",
        resourceId: "workspace",
        operations: ["write"],
        constraints: { allowedRelPaths: ["reports/crash-test.md", "reports/spoof-check.md", "reports/seq-update.md"] },
        now,
      });
      grantModelDisclosure(seedDb, {
        principalId: "owner",
        scopeId: "scope:default",
        sourceType: "*",
        sourceId: "*",
        provider: "fake-local",
        modelId: "*",
        baseUrl: fakeModel.baseUrl,
        slotName: "*",
        now,
      });
      seedDb.close();

      // Pre-create spoof-check.md with v1 AND an unauthorized host secret file that MUST NOT enter /input!
      const spoofOrigText = "HOST_BASELINE_V1_ORIGINAL\n";
      mkdirSync(path.join(formalWorkspace, "reports"), { recursive: true });
      mkdirSync(path.join(formalWorkspace, "secrets"), { recursive: true });
      writeFileSync(path.join(formalWorkspace, "reports", "spoof-check.md"), spoofOrigText, "utf8");
      writeFileSync(path.join(formalWorkspace, "secrets", "formal-ungranted.txt"), "FORMAL_UNGRANTED_SECRET\n", "utf8");

      const connectorsCfgPath = path.join(formalDir, "connectors.json");
      writeFileSync(
        connectorsCfgPath,
        JSON.stringify(
          {
            workspace: {
              workspaceDir: formalWorkspace,
              approvedImageId,
              imageName: DEFAULT_SANDBOX_IMAGE,
              trackedBaselineRelPaths: [
                "reports/crash-test.md",
                "reports/spoof-check.md",
                "reports/seq-update.md",
                "secrets/formal-ungranted.txt",
              ],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const formalToken = `SYNTH_V03_FORMAL_${runId}`;
      const barrierFile = path.join(formalDir, "barrier-after-install.json");
      const crashContent = `FORMAL_HOST_CRASH_RECOVERY_ONCE_${runId}\n`;
      formalCrashSha = sha256Text(crashContent);

      await fakeModel.queue({
        clear: true,
        scripts: [
          {
            kind: "tool_call",
            toolCall: {
              id: `tc_v03_crash_${runId}`,
              name: "workspace_write_managed",
              arguments: {
                relPath: "reports/crash-test.md",
                content: crashContent,
                // Deliberately spoof baseSha256 from model -> host MUST ignore it!
                baseSha256: "f".repeat(64),
              },
            },
          },
          { kind: "text", text: "Import completed." },
        ],
      });

      const hostCrash1 = await spawnFormalHost({
        dataDir: formalDataDir,
        modelBaseUrl: fakeModel.baseUrl,
        smtpHost: fakeSmtp.host,
        smtpPort: fakeSmtp.smtpPort,
        consoleToken: formalToken,
        connectorsConfigPath: connectorsCfgPath,
        extraArgs: ["--fault-after-import-install-before-receipt", barrierFile],
      });
      formalHostKillPid = hostCrash1.pid;

      const cookie1 = await httpLogin(hostCrash1.baseUrl, formalToken);
      const conv1 = (await (
        await fetch(`${hostCrash1.baseUrl}/api/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: cookie1, origin: hostCrash1.baseUrl },
          body: JSON.stringify({ slotName: "router" }),
        })
      ).json()) as { conversationId: string; runtimeEpoch: string };

      const chatRes = await fetch(`${hostCrash1.baseUrl}/api/conversations/${conv1.conversationId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookie1, origin: hostCrash1.baseUrl },
        body: JSON.stringify({
          content: "Write crash-test.md via managed importer",
          chatKey: `v03-formal-crash-${runId}`,
          runtimeEpoch: conv1.runtimeEpoch,
        }),
      });
      assert.equal(chatRes.status, 200);

      // Wait for real formal host to hit barrier strictly AFTER atomic disk install and BEFORE gov receipt!
      const barrierPayload = JSON.parse(await waitForFile(barrierFile, 25_000)) as {
        pid: number;
        logicalKey: string;
        importId: string;
        artifactSha256: string;
      };
      formalCrashLogicalKey = barrierPayload.logicalKey;
      assert.equal(barrierPayload.artifactSha256, formalCrashSha);
      const formalCrashFile = path.join(formalWorkspace, "reports", "crash-test.md");
      assert.equal(sha256FileIfExists(formalCrashFile), formalCrashSha, "File must exist on disk before kill");
      const mtimeBeforeKill = statSync(formalCrashFile).mtimeMs;

      // Force-kill real Windows host PID!
      forceKillWindowsPid(hostCrash1.pid);
      await new Promise((r) => setTimeout(r, 400));

      // Verify governance DB row is still PREPARED before restart!
      const { db: preCheckDb } = openGovernanceDb(path.join(formalDataDir, "aegis-gov.sqlite"));
      const preRow = preCheckDb
        .prepare("SELECT state, install_count FROM managed_file_imports WHERE logical_key = ?")
        .get(formalCrashLogicalKey) as { state: string; install_count: number } | undefined;
      preCheckDb.close();
      assert.equal(preRow?.state, "PREPARED", "Row MUST still be PREPARED right after force kill");
      assert.equal(preRow?.install_count, 0);

      // Restart real formal host via normal startup path (Step 5c reconciles PREPARED -> INSTALLED + workspace_file source!)
      const hostCrash2 = await spawnFormalHost({
        dataDir: formalDataDir,
        modelBaseUrl: fakeModel.baseUrl,
        smtpHost: fakeSmtp.host,
        smtpPort: fakeSmtp.smtpPort,
        consoleToken: formalToken,
        connectorsConfigPath: connectorsCfgPath,
      });
      formalRestartedPid = hostCrash2.pid;
      try {
        const recItem = hostCrash2.reconciledFileImports.find((r) => r.logicalKey === formalCrashLogicalKey);
        assert.ok(recItem, `Expected startup Step 5c to reconcile ${formalCrashLogicalKey}`);
        assert.equal(recItem.outcome, "reconciled_installed");
        assert.equal(recItem.installCount, 1);
        assert.equal(recItem.diskRewritten, false);
        assert.equal(statSync(formalCrashFile).mtimeMs, mtimeBeforeKill, "Disk file MUST NOT be rewritten on startup recovery");

        // Verify original conversation snapshot shows BOTH INSTALLED import (installCount=1) AND reconciled workspace_file source!
        const cookie2 = await httpLogin(hostCrash2.baseUrl, formalToken);
        const snap2 = (await (
          await fetch(`${hostCrash2.baseUrl}/api/conversations/${conv1.conversationId}/snapshot`, {
            headers: { cookie: cookie2 },
          })
        ).json()) as {
          fileImports: Array<{ logicalKey: string; state: string; installCount: number; artifactSha256: string }>;
          sources: Array<{ sourceType: string; sourceId: string; contentDigest: string }>;
        };
        const impSnap = snap2.fileImports.find((f) => f.logicalKey === formalCrashLogicalKey);
        assert.equal(impSnap?.state, "INSTALLED");
        assert.equal(impSnap?.installCount, 1);
        assert.equal(impSnap?.artifactSha256, formalCrashSha);
        const srcSnap = snap2.sources.find(
          (s) => s.sourceType === "workspace_file" && s.sourceId === "workspace:reports/crash-test.md",
        );
        assert.ok(srcSnap, "Reconciled workspace_file source MUST appear in original conversation snapshot");
        assert.equal(srcSnap.contentDigest, formalCrashSha);

        // Now prove WITHIN ONE TASK, frozen snapshot & baseline ignore model-spoofed baseSha256:
        // Step 1 (tool_call 1 of task): writes reports/crash-test.md -> freezes THIS task's snapshot holding spoof-check.md == V1!
        // Step 2 (immediately after tool 1 writes crash-test.md on disk, BEFORE tool 2 completes Docker sandbox):
        //   user edits spoof-check.md on disk to V2!
        // Step 3 (tool_call 2 inside SAME execution task): tries to write spoof-check.md while spoofing baseSha256 = V2
        //   -> host compares against THIS task's frozen V1 baseline -> CONFLICT_SAVED!
        const userModifiedSpoof = "USER_MODIFIED_AFTER_HOST_SNAPSHOT\n";
        const userModifiedSpoofSha = sha256Text(userModifiedSpoof);
        const freezeTriggerContent = `CONV1_FREEZE_TRIGGER_${runId}\n`;
        const freezeTriggerSha = sha256Text(freezeTriggerContent);

        await fakeModel.queue({
          clear: true,
          scripts: [
            {
              kind: "tool_call",
              toolCall: {
                id: `tc_v03_freeze_${runId}`,
                name: "workspace_write_managed",
                arguments: {
                  relPath: "reports/crash-test.md",
                  content: freezeTriggerContent,
                },
              },
            },
            {
              kind: "tool_call",
              toolCall: {
                id: `tc_v03_spoof_${runId}`,
                name: "workspace_write_managed",
                arguments: {
                  relPath: "reports/spoof-check.md",
                  content: "MODEL_ATTEMPTING_TO_OVERWRITE_BY_SPOOFING_BASE\n",
                  // Model tries to pass current file SHA to bypass conflict detection -> host MUST IGNORE it!
                  baseSha256: userModifiedSpoofSha,
                },
              },
            },
            { kind: "text", text: "Handled conflict within same execution task." },
          ],
        });
        await fetch(`${hostCrash2.baseUrl}/api/conversations/${conv1.conversationId}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: cookie2, origin: hostCrash2.baseUrl },
          body: JSON.stringify({
            content: "Freeze per-task snapshot in step 1 then attempt spoofed write to spoof-check.md in step 2",
            chatKey: `v03-formal-freeze-and-spoof-${runId}`,
            runtimeEpoch: hostCrash2.runtimeEpoch,
          }),
        });
        const crashTestDiskPath = path.join(formalWorkspace, "reports", "crash-test.md");
        const freezeDeadline = Date.now() + 25_000;
        let sawFreezeDiskWrite = false;
        while (Date.now() < freezeDeadline) {
          if (sha256FileIfExists(crashTestDiskPath) === freezeTriggerSha) {
            sawFreezeDiskWrite = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 30));
        }
        assert.equal(sawFreezeDiskWrite, true, "Tool 1 MUST freeze per-task snapshot and write crash-test.md");

        // Now user edits spoof-check.md on disk BEFORE Tool 2 inside the SAME task installs!
        writeFileSync(path.join(formalWorkspace, "reports", "spoof-check.md"), userModifiedSpoof, "utf8");

        const deadline = Date.now() + 25_000;
        let spoofImport: { state: string; conflictRelPath: string | null } | undefined;
        while (Date.now() < deadline) {
          const sp = (await (
            await fetch(`${hostCrash2.baseUrl}/api/conversations/${conv1.conversationId}/snapshot`, {
              headers: { cookie: cookie2 },
            })
          ).json()) as {
            fileImports: Array<{ targetRelPath: string; state: string; conflictRelPath: string | null }>;
            messages?: Array<{ role: string; content: unknown }>;
          };
          spoofImport = sp.fileImports.find((f) => f.targetRelPath === "reports/spoof-check.md");
          const turnFinished = Boolean(sp.messages?.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("Handled conflict")));
          if (spoofImport && turnFinished) break;
          await new Promise((r) => setTimeout(r, 120));
        }
        assert.equal(spoofImport?.state, "CONFLICT_SAVED", "W2-S3: Host baseline MUST detect conflict even if model spoofs baseSha256");
        assert.ok(spoofImport?.conflictRelPath);
        formalConflictRelPath = spoofImport.conflictRelPath;
        assert.equal(
          sha256FileIfExists(path.join(formalWorkspace, "reports", "spoof-check.md")),
          userModifiedSpoofSha,
          "User modified file MUST remain preserved",
        );

        // W2-S3 Round 4: Submit TWO sequential updates on the SAME conversation (`seqConv`)
        // WITHOUT any external edits -> BOTH MUST install cleanly (NO spurious CONFLICT_SAVED)!
        const seqConv = (await (
          await fetch(`${hostCrash2.baseUrl}/api/conversations`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: cookie2, origin: hostCrash2.baseUrl },
            body: JSON.stringify({ slotName: "router" }),
          })
        ).json()) as { conversationId: string; runtimeEpoch: string };

        const seqV1Content = `SEQ_SAME_CONV_V1_${runId}\n`;
        const seqV2Content = `SEQ_SAME_CONV_V2_${runId}\n`;
        sequentialV1Sha = sha256Text(seqV1Content);
        sequentialV2Sha = sha256Text(seqV2Content);

        await fakeModel.queue({
          clear: true,
          scripts: [
            {
              kind: "tool_call",
              toolCall: {
                id: `tc_v03_seq1_${runId}`,
                name: "workspace_write_managed",
                arguments: { relPath: "reports/seq-update.md", content: seqV1Content },
              },
            },
            { kind: "text", text: "Sequential update 1 installed." },
          ],
        });
        await fetch(`${hostCrash2.baseUrl}/api/conversations/${seqConv.conversationId}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: cookie2, origin: hostCrash2.baseUrl },
          body: JSON.stringify({
            content: "Sequential write v1",
            chatKey: `v03-seq-1-${runId}`,
            runtimeEpoch: seqConv.runtimeEpoch,
          }),
        });
        const seq1Deadline = Date.now() + 25_000;
        let seq1Imp: { state: string; installCount: number } | undefined;
        while (Date.now() < seq1Deadline) {
          const sp = (await (
            await fetch(`${hostCrash2.baseUrl}/api/conversations/${seqConv.conversationId}/snapshot`, {
              headers: { cookie: cookie2 },
            })
          ).json()) as {
            fileImports: Array<{ targetRelPath: string; state: string; installCount: number }>;
            messages?: Array<{ role: string; content: unknown }>;
          };
          seq1Imp = sp.fileImports.find((f) => f.targetRelPath === "reports/seq-update.md");
          const turn1Finished = Boolean(
            sp.messages?.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("Sequential update 1 installed")),
          );
          if (seq1Imp && turn1Finished) break;
          await new Promise((r) => setTimeout(r, 120));
        }
        assert.equal(seq1Imp?.state, "INSTALLED");
        assert.equal(sha256FileIfExists(path.join(formalWorkspace, "reports", "seq-update.md")), sequentialV1Sha);

        // Command #2 sequentially in SAME conversation -> MUST capture latest V1 baseline & install V2 cleanly!
        await fakeModel.queue({
          clear: true,
          scripts: [
            {
              kind: "tool_call",
              toolCall: {
                id: `tc_v03_seq2_${runId}`,
                name: "workspace_write_managed",
                arguments: { relPath: "reports/seq-update.md", content: seqV2Content },
              },
            },
            { kind: "text", text: "Sequential update 2 installed." },
          ],
        });
        await fetch(`${hostCrash2.baseUrl}/api/conversations/${seqConv.conversationId}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: cookie2, origin: hostCrash2.baseUrl },
          body: JSON.stringify({
            content: "Sequential write v2",
            chatKey: `v03-seq-2-${runId}`,
            runtimeEpoch: seqConv.runtimeEpoch,
          }),
        });
        const seq2Deadline = Date.now() + 20_000;
        let seqImports: Array<{ targetRelPath: string; state: string; installCount: number; baseSha256: string | null; artifactSha256: string }> = [];
        while (Date.now() < seq2Deadline) {
          const sp = (await (
            await fetch(`${hostCrash2.baseUrl}/api/conversations/${seqConv.conversationId}/snapshot`, {
              headers: { cookie: cookie2 },
            })
          ).json()) as {
            fileImports: Array<{
              targetRelPath: string;
              state: string;
              installCount: number;
              baseSha256: string | null;
              artifactSha256: string;
            }>;
          };
          seqImports = sp.fileImports.filter((f) => f.targetRelPath === "reports/seq-update.md");
          if (seqImports.length >= 2) break;
          await new Promise((r) => setTimeout(r, 120));
        }
        assert.equal(seqImports.length, 2);
        assert.equal(seqImports[0]!.state, "INSTALLED");
        assert.equal(seqImports[0]!.baseSha256, null);
        assert.equal(seqImports[1]!.state, "INSTALLED", "W2-S3: Sequential command #2 in same conversation MUST install cleanly without CONFLICT_SAVED");
        assert.equal(seqImports[1]!.baseSha256, sequentialV1Sha, "W2-S3: Sequential command #2 MUST use V1 authoritative SHA as its baseline");
        assert.equal(seqImports[1]!.installCount, 1);
        assert.equal(sha256FileIfExists(path.join(formalWorkspace, "reports", "seq-update.md")), sequentialV2Sha);
      } finally {
        await hostCrash2.stop();
      }
      const { db: postFormalDb } = openGovernanceDb(path.join(formalDataDir, "aegis-gov.sqlite"));
      const sboxAudits = postFormalDb
        .prepare("SELECT details_json FROM audit_events WHERE event_type = 'docker_sandbox_observed' ORDER BY occurred_at DESC")
        .all() as Array<{ details_json: string }>;
      postFormalDb.close();
      assert.ok(sboxAudits.length >= 2);
      const lastSbox = JSON.parse(sboxAudits[0]!.details_json) as { inputAuthorizedFiles: string[] };
      sequentialAuthorizedInputs = lastSbox.inputAuthorizedFiles;
      assert.equal(sequentialAuthorizedInputs.includes("secrets/formal-ungranted.txt"), false);

      // W2-S3 Round 5: Same-round crash-recovery across 2 tools in ONE logical execution task + post-cache path revocation + missing snapshot fail-closed!
      const srDir = path.join(rootDir, "formal-host-v03-sameround");
      const srDataDir = path.join(srDir, "data");
      const srWorkspace = path.join(srDir, "workspace");
      mkdirSync(path.join(srWorkspace, "reports"), { recursive: true });
      mkdirSync(srDataDir, { recursive: true });

      const origSrB = `ORIG_SAME_ROUND_B_V1_${runId}\n`;
      const origSrBSha = sha256Text(origSrB);
      const userOfflineSrB = `USER_OFFLINE_EDIT_DURING_DOWNTIME_B_${runId}\n`;
      const userOfflineSrBSha = sha256Text(userOfflineSrB);
      const modelOverwriteSrB = `MODEL_OVERWRITE_SAME_ROUND_B_${runId}\n`;
      const modelOverwriteSrBSha = sha256Text(modelOverwriteSrB);
      writeFileSync(path.join(srWorkspace, "reports", "same-round-b.md"), origSrB, "utf8");
      writeFileSync(path.join(srWorkspace, "reports", "revoked-cached.md"), `SENSITIVE_REVOKED_CACHED_${runId}\n`, "utf8");

      let revokedCachedGrantId = "";
      {
        const { db: srSeedDb } = openGovernanceDb(path.join(srDataDir, "aegis-gov.sqlite"));
        ensureActiveEpochAndManifest(srSeedDb, now);
        ensureScope(srSeedDb, {
          scopeId: "scope:default",
          allowedPrincipals: ["owner"],
          allowedTools: ["workspace_write_managed"],
          allowedTargets: ["*"],
        });
        grantSourceRead(srSeedDb, {
          principalId: "owner",
          scopeId: "scope:default",
          sourceType: "workspace_write",
          resourceId: "workspace",
          operations: ["write"],
          constraints: { allowedRelPaths: ["reports/same-round-a.md", "reports/same-round-b.md"] },
          now,
        });
        const revCachedGrant = grantSourceRead(srSeedDb, {
          principalId: "owner",
          scopeId: "scope:default",
          sourceType: "workspace_write",
          resourceId: "workspace",
          operations: ["write"],
          constraints: { allowedRelPaths: ["reports/revoked-cached.md"] },
          now,
        });
        revokedCachedGrantId = revCachedGrant.grant_id;
        grantModelDisclosure(srSeedDb, {
          principalId: "owner",
          scopeId: "scope:default",
          sourceType: "*",
          sourceId: "*",
          provider: "fake-local",
          modelId: "*",
          baseUrl: fakeModel.baseUrl,
          slotName: "*",
          now,
        });
        srSeedDb.close();
      }

      const srCfgPath = path.join(srDir, "connectors.json");
      writeFileSync(
        srCfgPath,
        JSON.stringify(
          {
            workspace: {
              workspaceDir: srWorkspace,
              approvedImageId,
              imageName: DEFAULT_SANDBOX_IMAGE,
              trackedBaselineRelPaths: [
                "reports/same-round-a.md",
                "reports/same-round-b.md",
                "reports/revoked-cached.md",
              ],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const srToken = `SYNTH_V03_SAMEROUND_${runId}`;
      const srBarrierFile = path.join(srDir, "barrier-sr-a.json");
      const srAContent = `SAME_ROUND_A_${runId}\n`;
      await fakeModel.queue({
        clear: true,
        scripts: [
          {
            kind: "tool_call",
            toolCall: {
              id: `tc_sr_a_${runId}`,
              name: "workspace_write_managed",
              arguments: { relPath: "reports/same-round-a.md", content: srAContent },
            },
          },
          {
            kind: "tool_call",
            toolCall: {
              id: `tc_sr_b_${runId}`,
              name: "workspace_write_managed",
              arguments: {
                relPath: "reports/same-round-b.md",
                content: modelOverwriteSrB,
                baseSha256: userOfflineSrBSha,
              },
            },
          },
          { kind: "text", text: "Same-round recovery finished." },
        ],
      });

      const hostSr1 = await spawnFormalHost({
        dataDir: srDataDir,
        modelBaseUrl: fakeModel.baseUrl,
        smtpHost: fakeSmtp.host,
        smtpPort: fakeSmtp.smtpPort,
        consoleToken: srToken,
        connectorsConfigPath: srCfgPath,
        extraArgs: ["--fault-after-import-install-before-receipt", srBarrierFile],
      });
      const srCookie1 = await httpLogin(hostSr1.baseUrl, srToken);
      const srConv = (await (
        await fetch(`${hostSr1.baseUrl}/api/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: srCookie1, origin: hostSr1.baseUrl },
          body: JSON.stringify({ slotName: "router" }),
        })
      ).json()) as { conversationId: string; runtimeEpoch: string };

      const srChatRes = await fetch(`${hostSr1.baseUrl}/api/conversations/${srConv.conversationId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: srCookie1, origin: hostSr1.baseUrl },
        body: JSON.stringify({
          content: "Write index a then update report b in same execution round",
          chatKey: `v03-sr-${runId}`,
          runtimeEpoch: srConv.runtimeEpoch,
        }),
      });
      assert.equal(srChatRes.status, 200);
      await waitForFile(srBarrierFile, 25_000);
      forceKillWindowsPid(hostSr1.pid);
      await new Promise((r) => setTimeout(r, 400));

      // During downtime: user modifies same-round-b.md AND revokes reports/revoked-cached.md BEFORE host restarts!
      writeFileSync(path.join(srWorkspace, "reports", "same-round-b.md"), userOfflineSrB, "utf8");
      {
        const { db: srDownDb } = openGovernanceDb(path.join(srDataDir, "aegis-gov.sqlite"));
        revokeSourceReadGrant(srDownDb, {
          grantId: revokedCachedGrantId,
          reason: "w2_s3_post_cache_revoke",
          now: Date.now(),
        });
        srDownDb.close();
      }

      const hostSr2 = await spawnFormalHost({
        dataDir: srDataDir,
        modelBaseUrl: fakeModel.baseUrl,
        smtpHost: fakeSmtp.host,
        smtpPort: fakeSmtp.smtpPort,
        consoleToken: srToken,
        connectorsConfigPath: srCfgPath,
      });
      try {
        const srCookie2 = await httpLogin(hostSr2.baseUrl, srToken);
        const srDeadline = Date.now() + 25_000;
        let srImpB: { targetRelPath: string; state: string; baseSha256: string | null; conflictRelPath: string | null } | undefined;
        let srFinished = false;
        while (Date.now() < srDeadline) {
          const sp = (await (
            await fetch(`${hostSr2.baseUrl}/api/conversations/${srConv.conversationId}/snapshot`, {
              headers: { cookie: srCookie2 },
            })
          ).json()) as {
            fileImports: Array<{ targetRelPath: string; state: string; baseSha256: string | null; conflictRelPath: string | null }>;
            messages?: Array<{ role: string; content: unknown }>;
          };
          srImpB = sp.fileImports.find((f) => f.targetRelPath === "reports/same-round-b.md");
          srFinished = Boolean(
            sp.messages?.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("Same-round recovery finished")),
          );
          if (srImpB && srFinished) break;
          await new Promise((r) => setTimeout(r, 120));
        }
        assert.equal(srFinished, true, "W2-S3: Same-round resumed run must finish tool 2");
        assert.equal(srImpB?.state, "CONFLICT_SAVED", "W2-S3: Resumed same-round tool 2 MUST keep pre-crash frozen baseline -> CONFLICT_SAVED");
        assert.equal(srImpB?.baseSha256, origSrBSha, "W2-S3: Resumed same-round baseline must equal pre-crash origSrBSha");
        assert.ok(srImpB?.conflictRelPath, "W2-S3: Conflict candidate must be saved");
        assert.equal(
          sha256FileIfExists(path.join(srWorkspace, "reports", "same-round-b.md")),
          userOfflineSrBSha,
          "W2-S3: User's downtime edit MUST NOT be overwritten after restart!",
        );
        assert.equal(
          sha256FileIfExists(path.join(srWorkspace, srImpB.conflictRelPath!)),
          modelOverwriteSrBSha,
        );
      } finally {
        await hostSr2.stop();
      }

      const { db: postSrDb } = openGovernanceDb(path.join(srDataDir, "aegis-gov.sqlite"));
      try {
        const srSboxRows = postSrDb
          .prepare("SELECT details_json FROM audit_events WHERE event_type = 'docker_sandbox_observed' ORDER BY occurred_at DESC")
          .all() as Array<{ details_json: string }>;
        assert.ok(srSboxRows.length >= 1);
        const latestSrSbox = JSON.parse(srSboxRows[0]!.details_json) as {
          inputAuthorizedFiles: string[];
          excludedInputFiles?: string[];
        };
        assert.equal(
          latestSrSbox.inputAuthorizedFiles.includes("reports/revoked-cached.md"),
          false,
          "W2-S3: Post-cache revoked path MUST be excluded before launching resumed container!",
        );
        assert.equal(
          (latestSrSbox.excludedInputFiles ?? []).includes("reports/revoked-cached.md"),
          true,
          "W2-S3: Excluded post-cache revoked path must be audited",
        );

        // Fail-closed test: delete persisted snapshot directory -> getOrCreateTaskFrozenSnapshot MUST fail closed!
        const snapRow = postSrDb
          .prepare("SELECT snapshot_key, runtime_epoch, snapshot_dir FROM task_frozen_snapshots LIMIT 1")
          .get() as {
            snapshot_key: string;
            runtime_epoch: string;
            snapshot_dir: string;
          } | undefined;
        assert.ok(snapRow, "W2-S3: Persisted task_frozen_snapshots row must exist in govDb");
        rmSync(snapRow.snapshot_dir, { recursive: true, force: true });
        const srImporter = new ManagedWorkspaceImporter(srWorkspace);
        const missingRes = srImporter.getOrCreateTaskFrozenSnapshot({
          snapshotKey: snapRow.snapshot_key,
          snapshotRootDir: path.join(srDataDir, "sandbox-task-snapshots"),
          govDb: postSrDb,
          runtimeEpoch: snapRow.runtime_epoch,
          executionRootTaskId: "resumed",
          principalId: "owner",
          scopeId: "scope:default",
          candidateRelPaths: ["reports/same-round-b.md"],
        });
        assert.equal(missingRes.ok, false, "W2-S3: Missing persisted frozen snapshot MUST fail closed");
        assert.equal(!missingRes.ok ? missingRes.code : null, "frozen_snapshot_missing");
      } finally {
        postSrDb.close();
      }
    } finally {
      await fakeSmtp.stop().catch(() => {});
      await fakeModel.stop().catch(() => {});
    }

    const report = {
      suite: "V03",
      runId,
      status: "PASS",
      dockerEnvironment: dockerEnv,
      immutableDigestChecks: {
        approvedImageId,
        executorImageId: normalRun.executorImageId,
        exporterImageId: normalImport.exporterImageId,
        missingDigestRejectedCode: missingDigestExec.code,
        wrongDigestExecutorRejectedCode: wrongDigestExec.code,
        wrongDigestExporterRejectedCode: !wrongDigestExp.ok ? wrongDigestExp.code : null,
      },
      normalImport: {
        targetRelPath: normalImport.targetRelPath,
        expectedSha256: expectedNormalSha,
        actualSha256: normalImport.currentTargetSha256After,
        installCount: normalImport.installCount,
        networkMode: normalRun.networkMode,
        mounts: normalRun.mounts,
        allWritersExited: normalImport.writerCheck?.allExited,
      },
      conflictEdit: {
        state: conflictImport.state,
        userVersionPreserved: conflictImport.currentTargetSha256After === userEditedSha,
        conflictRelPath: conflictImport.conflictRelPath,
        candidateSha256: candidateConflictSha,
      },
      conflictNewFile: {
        state: newConflictImport.state,
        conflictRelPath: newConflictImport.conflictRelPath,
      },
      rejections: {
        revokedParentSource: {
          code: revokedParentImport.code,
          targetUnchanged: true,
          conflictFilesCreatedDelta: 0,
        },
        activeWriter: { code: activeWriterImport.code, targetUnchanged: true },
        symlink: { code: symImport.code, targetUnchanged: true },
        hardlink: { code: hardImport.code, targetUnchanged: true },
        quotaOverflow: { code: bigImport.code, targetUnchanged: true },
        windowsAds: { code: adsRej.code },
        traversal: { code: travRej.code },
        windowsDevice: { code: devRej.code },
        revokedGrant: { code: revokedWrite.code, targetUnchanged: true },
      },
      perTaskAndMidExportHardening: {
        overlappingSamePathTasksConflictSaved: true,
        overlappingConflictRelPath: impOverlapB.conflictRelPath,
        containerInputOnlyAuthorizedPaths: observedContainerInputFiles,
        unauthorizedFilesExcludedFromInput: true,
        midExportSourceRevokedCode: impMidRev.code,
        midExportSourceRevokedTargetAndConflictUnchanged: true,
        midExportWriteRevokedCode: impMidWriteRev.code,
        sameHashNoopCode: impSameHashNoop.code,
        sameHashNoopInstallCount: impSameHashNoop.installCount,
        sameHashPreparedStartupReconcileOutcome: ambigItem.outcome,
        sameHashPreparedStartupReconcileReason: ambigDbRow.reason,
      },
      formalHostReceiptLossAndBaseline: {
        killedFormalHostPid: formalHostKillPid,
        restartedFormalHostPid: formalRestartedPid,
        logicalKey: formalCrashLogicalKey,
        artifactSha256: formalCrashSha,
        reconciledOutcome: "reconciled_installed",
        installCount: 1,
        diskRewrittenOnRestart: false,
        workspaceFileSourceReconciledInSnapshot: true,
        modelSpoofedBaseSha256IgnoredConflictSaved: true,
        spoofConflictRelPath: formalConflictRelPath,
        sequentialSameConversationUpdatesInstalled: true,
        sequentialV1Sha256: sequentialV1Sha,
        sequentialV2Sha256: sequentialV2Sha,
        formalContainerAuthorizedInputs: sequentialAuthorizedInputs,
        sameRoundCrashRecoveryConflictPreserved: true,
        sameRoundPostCacheRevokedExcluded: true,
        missingFrozenSnapshotFailClosedVerified: true,
      },
    };
    const evidencePath = path.join(evidenceDir, "v03-evidence.json");
    writeFileSync(evidencePath, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { report, evidencePath };
  } finally {
    for (const c of containersToClean) {
      stopAndRemoveContainer(c);
    }
    for (const v of volumesToClean) {
      cleanupTaskVolume(v);
    }
    govDb.close();
    if (!opts?.dataDir) {
      await rmDirWithRetry(rootDir);
    }
  }
}

if (import.meta.url === new URL(`file:///${process.argv[1]!.replace(/\\/g, "/")}`).href) {
  const cli = parseWeek2CliArgs(process.argv.slice(2));
  const { report, evidencePath } = await runV03({ dataDir: cli.dataDir, evidenceDir: cli.evidenceDir });
  console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
}
