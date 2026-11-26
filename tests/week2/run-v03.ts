import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  cleanupTaskVolume,
  DEFAULT_SANDBOX_IMAGE,
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
import { grantSourceRead, revokeSourceReadGrant } from "../../src/governance/policy.ts";
import { ensureActiveEpochAndManifest } from "../../src/governance/recovery.ts";

function sha256Text(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
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
    // 1. Normal Import (zero-net, zero-cred container -> private volume -> RO export -> atomic install)
    // =========================================================================
    const expectedNormalText = `# Project Helios 周报差异核对 (${runId})\n- 邮件：2026-12-10\n- README：2026-12-03\n`;
    const expectedNormalSha = sha256Text(expectedNormalText);

    const normalRun = runTaskInDockerSandbox({
      inputSnapshotDir: inputSnapDir,
      nodeScript: `
        const fs = require("node:fs");
        // Verify /input is readable and read-only
        const inp = fs.readFileSync("/input/input.txt", "utf8");
        if (!inp.includes("Project Helios")) throw new Error("missing input snapshot");
        fs.mkdirSync("/out/reports", { recursive: true });
        fs.writeFileSync("/out/reports/weekly.md", ${JSON.stringify(expectedNormalText)}, "utf8");
      `,
    });
    volumesToClean.push(normalRun.volumeName);
    containersToClean.push(normalRun.containerName);
    assert.equal(normalRun.ok, true, `Normal sandbox container failed: ${normalRun.stderr}`);
    assert.equal(normalRun.networkMode, "none");
    assert.equal(
      normalRun.mounts.some((m) => m.destination === "/input" && m.rw === false),
      true,
      "Input snapshot must be mounted strictly read-only",
    );
    assert.equal(
      normalRun.mounts.some((m) => m.destination === "/out" && m.rw === true && m.source === normalRun.volumeName),
      true,
      "Task output must mount task-private named volume",
    );
    assert.equal(
      normalRun.mounts.some((m) => m.source.toLowerCase().includes(workspaceRoot.toLowerCase())),
      false,
      "Authoritative workspace must NEVER be mounted into container",
    );

    const normalImport = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-normal-${runId}`,
      volumeName: normalRun.volumeName,
      containerId: normalRun.containerId,
      targetRelPath: "reports/weekly.md",
      baseSha256: null,
      now,
    });
    assert.equal(normalImport.ok, true, JSON.stringify(normalImport));
    assert.equal(normalImport.state, "INSTALLED");
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
      containerId: conflictRun.containerId,
      targetRelPath: "reports/weekly.md",
      baseSha256: expectedNormalSha, // stale base before user edit!
      now: now + 10,
    });
    assert.equal(conflictImport.ok, false);
    assert.equal(conflictImport.code, "version_conflict");
    assert.equal(conflictImport.state, "CONFLICT_SAVED");
    assert.equal(conflictImport.currentTargetSha256After, userEditedSha, "User edited version MUST remain untouched");
    assert.ok(conflictImport.conflictRelPath, "Conflict candidate path must be created");
    const conflictAbs = path.join(workspaceRoot, ...conflictImport.conflictRelPath.split("/"));
    assert.equal(existsSync(conflictAbs), true);
    assert.equal(sha256FileIfExists(conflictAbs), candidateConflictSha, "Candidate bytes must match exact artifact");

    // 2b. Conflict when base was absent (null) and user created target file in meantime!
    const userCreatedNew = "USER_CREATED_NEW_FILE_BEFORE_IMPORT\n";
    const userCreatedNewSha = sha256Text(userCreatedNew);
    writeFileSync(path.join(workspaceRoot, "reports", "new-note.md"), userCreatedNew, "utf8");
    const newConflictRun = runTaskInDockerSandbox({
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
      targetRelPath: "reports/new-note.md",
      baseSha256: null,
      now: now + 20,
    });
    assert.equal(newConflictImport.state, "CONFLICT_SAVED");
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "new-note.md")), userCreatedNewSha);
    assert.ok(newConflictImport.conflictRelPath);

    // =========================================================================
    // 3. Active Writer Still Running on Volume -> ABORT IMPORT, target unchanged!
    // =========================================================================
    const lingeringRun = runTaskInDockerSandbox({
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
    // 4a. Symlink inside volume
    const symRun = runTaskInDockerSandbox({
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
      targetRelPath: "reports/weekly.md",
      baseSha256: userEditedSha,
      now: now + 40,
    });
    assert.equal(symImport.ok, false);
    assert.equal(symImport.code, "symlink_rejected");
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "weekly.md")), userEditedSha);

    // 4b. Hardlink (nlink > 1) inside volume
    const hardRun = runTaskInDockerSandbox({
      inputSnapshotDir: inputSnapDir,
      nodeScript: `
        const fs = require("node:fs");
        fs.mkdirSync("/out/reports", { recursive: true });
        fs.writeFileSync("/out/reports/a.md", "hardlinked");
        fs.linkSync("/out/reports/a.md", "/out/reports/weekly.md");
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
      targetRelPath: "reports/weekly.md",
      baseSha256: userEditedSha,
      now: now + 50,
    });
    assert.equal(hardImport.ok, false);
    assert.equal(hardImport.code, "hardlink_rejected");
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "weekly.md")), userEditedSha);

    // 4c. Quota overflow (> maxFileBytes)
    const bigRun = runTaskInDockerSandbox({
      inputSnapshotDir: inputSnapDir,
      nodeScript: `
        const fs = require("node:fs");
        fs.mkdirSync("/out/reports", { recursive: true });
        fs.writeFileSync("/out/reports/weekly.md", "X".repeat(2048));
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
      targetRelPath: "reports/weekly.md",
      baseSha256: userEditedSha,
      maxFileBytes: 512,
      now: now + 60,
    });
    assert.equal(bigImport.ok, false);
    assert.equal(bigImport.code, "file_size_quota_exceeded");
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "weekly.md")), userEditedSha);

    // 4d. Windows ADS, traversal, device name path jail rejections
    const adsRej = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-ads-${runId}`,
      volumeName: normalRun.volumeName,
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
      targetRelPath: "reports/CON.md",
      baseSha256: null,
      now: now + 67,
    });
    assert.equal(devRej.code, "windows_device_name_rejected");

    // =========================================================================
    // 5. Crash AFTER Atomic Install & BEFORE Gov Receipt -> Retry Does NOT Double-Write!
    // =========================================================================
    const crashContent = `CRASH_RECOVERY_ONCE_ONLY_CONTENT_${runId}\n`;
    const crashSha = sha256Text(crashContent);
    const crashRun = runTaskInDockerSandbox({
      inputSnapshotDir: inputSnapDir,
      nodeScript: `
        const fs = require("node:fs");
        fs.mkdirSync("/out/reports", { recursive: true });
        fs.writeFileSync("/out/reports/crash-test.md", ${JSON.stringify(crashContent)}, "utf8");
      `,
    });
    volumesToClean.push(crashRun.volumeName);
    containersToClean.push(crashRun.containerName);

    const crashLogicalKey = `imp-crash-receipt-loss-${runId}`;
    let crashedAfterInstall = false;
    try {
      await importer.importFileFromTaskVolume({
        govDb,
        runtimeEpoch: epoch.runtime_epoch,
        conversationId: "1",
        principalId: "owner",
        scopeId: "scope:default",
        logicalKey: crashLogicalKey,
        volumeName: crashRun.volumeName,
        targetRelPath: "reports/crash-test.md",
        baseSha256: null,
        now: now + 70,
        onAfterAtomicInstallBeforeReceipt: () => {
          crashedAfterInstall = true;
          throw new Error("SIMULATED_CRASH_AFTER_INSTALL_BEFORE_RECEIPT");
        },
      });
    } catch {
      // expected simulated crash!
    }
    assert.equal(crashedAfterInstall, true);
    const crashFileAbs = path.join(workspaceRoot, "reports", "crash-test.md");
    assert.equal(sha256FileIfExists(crashFileAbs), crashSha);
    const mtimeBeforeRetry = statSync(crashFileAbs).mtimeMs;

    // Wait 30ms so any accidental rewrite would change mtimeMs!
    await new Promise((r) => setTimeout(r, 30));

    // Retry with SAME logicalKey -> MUST verify SHA-256 on disk, backfill INSTALLED without second write!
    const crashRetry = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: crashLogicalKey,
      volumeName: crashRun.volumeName,
      targetRelPath: "reports/crash-test.md",
      baseSha256: null,
      now: now + 80,
    });
    assert.equal(crashRetry.ok, true);
    assert.equal(crashRetry.code, "reconciled_after_receipt_loss");
    assert.equal(crashRetry.state, "INSTALLED");
    assert.equal(crashRetry.installCount, 1, "Cumulative install count must be 1");
    assert.equal(statSync(crashFileAbs).mtimeMs, mtimeBeforeRetry, "Disk file MUST NOT be rewritten on retry");

    // =========================================================================
    // 6. Revoked Write Grant -> Rejected, target unchanged!
    // =========================================================================
    revokeSourceReadGrant(govDb, { grantId: writeGrant.grant_id, reason: "v03_revoke_write", now: now + 90 });
    const revokedWrite = await importer.importFileFromTaskVolume({
      govDb,
      runtimeEpoch: epoch.runtime_epoch,
      conversationId: "1",
      principalId: "owner",
      scopeId: "scope:default",
      logicalKey: `imp-revoked-${runId}`,
      volumeName: normalRun.volumeName,
      targetRelPath: "reports/weekly.md",
      baseSha256: userEditedSha,
      now: now + 95,
    });
    assert.equal(revokedWrite.ok, false);
    assert.equal(revokedWrite.code, "workspace_write_denied");
    assert.equal(sha256FileIfExists(path.join(workspaceRoot, "reports", "weekly.md")), userEditedSha);

    const report = {
      suite: "V03",
      runId,
      status: "PASS",
      dockerEnvironment: dockerEnv,
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
        activeWriter: { code: activeWriterImport.code, targetUnchanged: true },
        symlink: { code: symImport.code, targetUnchanged: true },
        hardlink: { code: hardImport.code, targetUnchanged: true },
        quotaOverflow: { code: bigImport.code, targetUnchanged: true },
        windowsAds: { code: adsRej.code },
        traversal: { code: travRej.code },
        windowsDevice: { code: devRej.code },
        revokedGrant: { code: revokedWrite.code, targetUnchanged: true },
      },
      receiptLossIdempotency: {
        code: crashRetry.code,
        installCount: crashRetry.installCount,
        diskRewrittenOnRetry: false,
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
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === new URL(`file:///${process.argv[1]!.replace(/\\/g, "/")}`).href) {
  const { report, evidencePath } = await runV03();
  console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
}
