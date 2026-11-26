import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
        constraints: { allowedRelPaths: ["reports/crash-test.md", "reports/spoof-check.md"] },
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

      // Pre-create spoof-check.md with v1 so formal host records v1 as its startup baseline!
      const spoofOrigText = "HOST_BASELINE_V1_ORIGINAL\n";
      mkdirSync(path.join(formalWorkspace, "reports"), { recursive: true });
      writeFileSync(path.join(formalWorkspace, "reports", "spoof-check.md"), spoofOrigText, "utf8");

      const connectorsCfgPath = path.join(formalDir, "connectors.json");
      writeFileSync(
        connectorsCfgPath,
        JSON.stringify(
          {
            workspace: {
              workspaceDir: formalWorkspace,
              approvedImageId,
              imageName: DEFAULT_SANDBOX_IMAGE,
              trackedBaselineRelPaths: ["reports/crash-test.md", "reports/spoof-check.md"],
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

        // Now prove host ignores model-spoofed baseSha256 when user modified spoof-check.md AFTER host startup snapshot!
        const userModifiedSpoof = "USER_MODIFIED_AFTER_HOST_SNAPSHOT\n";
        const userModifiedSpoofSha = sha256Text(userModifiedSpoof);
        writeFileSync(path.join(formalWorkspace, "reports", "spoof-check.md"), userModifiedSpoof, "utf8");

        await fakeModel.queue({
          clear: true,
          scripts: [
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
            { kind: "text", text: "Handled conflict." },
          ],
        });
        await fetch(`${hostCrash2.baseUrl}/api/conversations/${conv1.conversationId}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: cookie2, origin: hostCrash2.baseUrl },
          body: JSON.stringify({
            content: "Try writing spoof-check.md",
            chatKey: `v03-formal-spoof-${runId}`,
            runtimeEpoch: hostCrash2.runtimeEpoch,
          }),
        });
        const deadline = Date.now() + 20_000;
        let spoofImport: { state: string; conflictRelPath: string | null } | undefined;
        while (Date.now() < deadline) {
          const sp = (await (
            await fetch(`${hostCrash2.baseUrl}/api/conversations/${conv1.conversationId}/snapshot`, {
              headers: { cookie: cookie2 },
            })
          ).json()) as { fileImports: Array<{ targetRelPath: string; state: string; conflictRelPath: string | null }> };
          spoofImport = sp.fileImports.find((f) => f.targetRelPath === "reports/spoof-check.md");
          if (spoofImport) break;
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
      } finally {
        await hostCrash2.stop();
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
