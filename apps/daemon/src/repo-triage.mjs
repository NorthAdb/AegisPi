import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeAudit } from "./audit.mjs";
import { withTx } from "./db/tx.mjs";
import { draftToReadyInTx, proposeEffectInTx } from "./effects.mjs";
import { validateJobOracle } from "./job-oracle.mjs";
import { isLoopbackModelEndpoint, MAX_MODEL_MESSAGES_BYTES } from "./model-call.mjs";
import { fenceAttemptProposals, processPendingModelProposalsAsync } from "./model-requests.mjs";
import { insertObjectRow, putObjectContent } from "./objects.mjs";
import { finalizeTaskWithNotificationInTx } from "./outbox.mjs";
import {
  authorizeAcquisitionTarget,
  buildSafeRepoExcerpt,
  fitPromptToMaxInputBytes,
  isSafeRelativeReadPath,
  jsonEnvelopeBytes,
  resolveContainedEntry,
  trimUtf8ToBytes,
} from "./repo-observe.mjs";
import { completePendingDeliveryCheckpointInTx, completeTaskInTx, heartbeat } from "./scheduler.mjs";
import { parseTelegramTargetResource } from "./telegram-send.mjs";

const ALLOWED_TRIAGE_PAYLOAD_KEYS = new Set(["kind", "presetId", "notifyChannel", "question"]);
const ALLOWED_MODES = new Set(["dependency_advisory", "snapshot_regression"]);
const ALLOWED_JOB_KINDS = new Set(["security_repro", "regression_check", "self_check", "config_verify"]);
const PRESET_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256Hex(content) {
  return createHash("sha256").update(Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8")).digest("hex");
}

function isLeaseRevokedError(err) {
  return Boolean(err && (err.name === "StaleWorker" || /lease|fence|stale/i.test(String(err.message ?? ""))));
}

function parseCommandSpec(raw, name) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${name} must be an object`);
  }
  if (typeof raw.command !== "string" || raw.command.length === 0 || raw.command.length > 256) {
    throw new Error(`${name}.command must be a non-empty string`);
  }
  if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string")) {
    throw new Error(`${name}.args must be an array of strings`);
  }
  const deadlineMs = raw.deadlineMs ?? 60000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 120_000) {
    throw new Error(`${name}.deadlineMs must be an integer 1000..120000`);
  }
  return { command: raw.command, args: [...raw.args], deadlineMs };
}

function parseInputFilesMap(rawMap, name) {
  if (rawMap === undefined || rawMap === null) return {};
  if (typeof rawMap !== "object" || Array.isArray(rawMap)) {
    throw new Error(`${name} must be a plain object`);
  }
  const entries = Object.entries(rawMap);
  if (entries.length > 256) {
    throw new Error(`${name} exceeds max entry count (256)`);
  }
  let totalBytes = 0;
  const out = {};
  for (const [k, v] of entries) {
    const lower = String(k).toLowerCase();
    if (!isSafeRelativeReadPath(k) || lower === "manifest.json" || lower === "snapshot" || lower.startsWith("snapshot/") || typeof v !== "string") {
      throw new Error(`${name} has invalid entry ${JSON.stringify(k)}`);
    }
    totalBytes += Buffer.byteLength(v, "utf8");
    if (totalBytes > 2 * 1024 * 1024) {
      throw new Error(`${name} exceeds 2 MiB preset fixture limit`);
    }
    out[k] = v;
  }
  return out;
}

export function validateTriagePreset(id, raw) {
  if (!PRESET_ID_RE.test(id)) {
    throw new Error(`triage preset id ${JSON.stringify(id)} is malformed`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`triage preset ${id} must be an object`);
  }
  if (typeof raw.baselineTargetId !== "string" || raw.baselineTargetId.length === 0) {
    throw new Error(`triage preset ${id} missing baselineTargetId`);
  }
  if (typeof raw.targetTargetId !== "string" || raw.targetTargetId.length === 0) {
    throw new Error(`triage preset ${id} missing targetTargetId`);
  }
  const mode = raw.mode ?? "snapshot_regression";
  if (!ALLOWED_MODES.has(mode)) {
    throw new Error(`triage preset ${id} invalid mode ${JSON.stringify(mode)}`);
  }
  const jobKind = raw.jobKind ?? "security_repro";
  if (!ALLOWED_JOB_KINDS.has(jobKind)) {
    throw new Error(`triage preset ${id} invalid jobKind ${JSON.stringify(jobKind)}`);
  }
  const baselineCommand = parseCommandSpec(raw.baselineCommand, `triage.presets.${id}.baselineCommand`);
  const targetCommand = parseCommandSpec(raw.targetCommand, `triage.presets.${id}.targetCommand`);
  validateJobOracle(raw.oracle);
  if (raw.baselineExpectedExitCode !== undefined && raw.baselineExpectedExitCode !== 0) {
    throw new Error(`triage preset ${id} baselineExpectedExitCode must be 0`);
  }
  const reproExitCode = raw.reproExitCode ?? 1;
  if (
    !Number.isInteger(reproExitCode) ||
    reproExitCode < 0 ||
    reproExitCode > 255 ||
    reproExitCode === 2 ||
    reproExitCode >= 124 ||
    (mode === "snapshot_regression" && reproExitCode === 0)
  ) {
    throw new Error(`triage preset ${id} invalid reproExitCode`);
  }
  let stageSubpaths = null;
  if (raw.stageSubpaths !== undefined && raw.stageSubpaths !== null) {
    if (raw.stageSnapshotPaths === false) {
      throw new Error(`triage preset ${id} cannot set stageSubpaths when stageSnapshotPaths=false`);
    }
    if (!Array.isArray(raw.stageSubpaths) || raw.stageSubpaths.length === 0 || raw.stageSubpaths.length > 64) {
      throw new Error(`triage preset ${id} stageSubpaths must be a non-empty array of <= 64 safe paths`);
    }
    for (const p of raw.stageSubpaths) {
      if (!isSafeRelativeReadPath(p)) {
        throw new Error(`triage preset ${id} stageSubpaths contains unsafe path ${JSON.stringify(p)}`);
      }
    }
    stageSubpaths = [...raw.stageSubpaths];
  }
  return {
    baselineTargetId: raw.baselineTargetId,
    targetTargetId: raw.targetTargetId,
    mode,
    jobKind,
    baselineCommand,
    targetCommand,
    baselineExpectedExitCode: 0,
    reproExitCode,
    oracle: raw.oracle,
    baselineInputFiles: parseInputFilesMap(raw.baselineInputFiles, `triage.presets.${id}.baselineInputFiles`),
    targetInputFiles: parseInputFilesMap(raw.targetInputFiles, `triage.presets.${id}.targetInputFiles`),
    stageSnapshotPaths: raw.stageSnapshotPaths !== false,
    stageSubpaths,
    baselineCommitSha: typeof raw.baselineCommitSha === "string" && raw.baselineCommitSha.length >= 7 ? raw.baselineCommitSha : null,
    targetCommitSha: typeof raw.targetCommitSha === "string" && raw.targetCommitSha.length >= 7 ? raw.targetCommitSha : null,
    advisoryMeta: raw.advisoryMeta && typeof raw.advisoryMeta === "object" && !Array.isArray(raw.advisoryMeta) ? raw.advisoryMeta : null,
    question: typeof raw.question === "string" && raw.question.trim().length > 0 ? raw.question.trim() : null,
  };
}

export function parseTriageConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("triage config must be an object");
  }
  const presetsRaw = raw.presets ?? {};
  if (!presetsRaw || typeof presetsRaw !== "object" || Array.isArray(presetsRaw)) {
    throw new Error("triage.presets must be a plain object");
  }
  const presets = {};
  for (const [id, spec] of Object.entries(presetsRaw)) {
    presets[id] = validateTriagePreset(id, spec);
  }
  return {
    allowRealTriage: raw.allowRealTriage === true,
    allowModelObserve: raw.allowModelObserve !== false,
    presets,
  };
}

export function parseRepoTriagePayload(rawPayload) {
  if (typeof rawPayload !== "string") return { isTriage: false };
  const trimmed = rawPayload.trim();
  if (!trimmed.startsWith("{")) return { isTriage: false };
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { isTriage: false };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || obj.kind !== "repo_triage") {
    return { isTriage: false };
  }
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_TRIAGE_PAYLOAD_KEYS.has(k)) {
      return { isTriage: true, valid: false, code: "triage_invalid_payload", reason: `disallowed payload key ${k}` };
    }
  }
  if (typeof obj.presetId !== "string" || !PRESET_ID_RE.test(obj.presetId)) {
    return { isTriage: true, valid: false, code: "triage_invalid_payload", reason: "presetId must match [A-Za-z0-9._:-]{1,128}" };
  }
  let notifyChannel = null;
  if (obj.notifyChannel !== undefined && obj.notifyChannel !== null) {
    if (typeof obj.notifyChannel !== "string" || obj.notifyChannel.trim().length === 0 || obj.notifyChannel.length > 128) {
      return { isTriage: true, valid: false, code: "triage_invalid_payload", reason: "notifyChannel must be a non-empty string <= 128 chars" };
    }
    notifyChannel = obj.notifyChannel.trim();
  }
  let question = null;
  if (obj.question !== undefined && obj.question !== null) {
    if (typeof obj.question !== "string" || obj.question.trim().length === 0 || obj.question.length > 512) {
      return { isTriage: true, valid: false, code: "triage_invalid_payload", reason: "question must be 1..512 chars" };
    }
    question = obj.question.trim();
  }
  return { isTriage: true, valid: true, presetId: obj.presetId, notifyChannel, question };
}

function collectContainedSnapshotFiles({ downloadsDir, entryDestRelPath, mode, prefix = "snapshot", stageSubpaths = null, maxBytes = 12 * 1024 * 1024, maxFiles = 2048 }) {
  if (mode === "file") {
    if (!isSafeRelativeReadPath(entryDestRelPath)) {
      return { ok: false, code: "acquisition_invalid_read_paths", reason: `unsafe entry path ${entryDestRelPath}` };
    }
    const targetPath = resolve(downloadsDir, entryDestRelPath);
    if (!targetPath.startsWith(resolve(downloadsDir) + sep) || !existsSync(targetPath)) {
      return { ok: false, code: "acquisition_output_missing", reason: `downloaded file missing at ${entryDestRelPath}` };
    }
    const st = lstatSync(targetPath);
    if (st.isSymbolicLink()) {
      return { ok: false, code: "acquisition_symlink_rejected", reason: `snapshot file ${entryDestRelPath} is a symlink` };
    }
    if (!st.isFile()) {
      return { ok: false, code: "acquisition_non_file_rejected", reason: `snapshot file ${entryDestRelPath} is not a regular file` };
    }
    if (st.size > maxBytes) {
      return { ok: false, code: "triage_snapshot_too_large", reason: `staged file exceeds ${maxBytes} bytes` };
    }
    const raw = readFileSync(targetPath);
    if (raw.byteLength > maxBytes) {
      return { ok: false, code: "triage_snapshot_too_large", reason: `staged file exceeds ${maxBytes} bytes` };
    }
    return { ok: true, files: { [`${prefix}/${entryDestRelPath}`]: raw }, totalBytes: raw.byteLength, fileCount: 1 };
  }

  const rootDir = join(downloadsDir, entryDestRelPath);
  const resolvedRoot = resolve(rootDir);
  if (!existsSync(resolvedRoot)) {
    return { ok: false, code: "acquisition_output_missing", reason: `extracted directory missing at ${entryDestRelPath}` };
  }
  const rootStat = lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink()) {
    return { ok: false, code: "acquisition_symlink_rejected", reason: `extracted root ${entryDestRelPath} is a symlink` };
  }
  if (!rootStat.isDirectory()) {
    return { ok: false, code: "acquisition_non_file_rejected", reason: `extracted root ${entryDestRelPath} is not a directory` };
  }

  const files = {};
  let totalBytes = 0;
  let count = 0;

  function stageFile(stagedKey, absPath, st) {
    if (Object.prototype.hasOwnProperty.call(files, stagedKey)) return { ok: true };
    count += 1;
    if (count > maxFiles) {
      return { ok: false, code: "triage_snapshot_too_many_files", reason: `staged snapshot exceeds ${maxFiles} files` };
    }
    if (st.size > maxBytes - totalBytes) {
      return { ok: false, code: "triage_snapshot_too_large", reason: `staged snapshot exceeds ${maxBytes} bytes` };
    }
    const raw = readFileSync(absPath);
    totalBytes += raw.byteLength;
    if (totalBytes > maxBytes) {
      return { ok: false, code: "triage_snapshot_too_large", reason: `staged snapshot exceeds ${maxBytes} bytes` };
    }
    files[stagedKey] = raw;
    return { ok: true };
  }

  function walk(absDir, relPrefix) {
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childAbs = join(absDir, entry.name);
      if (!childAbs.startsWith(resolvedRoot + sep)) {
        return { ok: false, code: "acquisition_path_escape", reason: `entry ${entry.name} escapes snapshot root` };
      }
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (!isSafeRelativeReadPath(rel)) {
        return { ok: false, code: "acquisition_invalid_read_paths", reason: `unsafe snapshot relative path ${rel}` };
      }
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        return { ok: false, code: "acquisition_symlink_rejected", reason: `snapshot contains symlink ${rel}` };
      }
      if (st.isDirectory()) {
        const sub = walk(childAbs, rel);
        if (!sub.ok) return sub;
      } else if (st.isFile()) {
        const staged = stageFile(`${prefix}/${rel}`, childAbs, st);
        if (!staged.ok) return staged;
      } else {
        return { ok: false, code: "acquisition_non_file_rejected", reason: `snapshot contains unsupported special entry ${rel}` };
      }
    }
    return { ok: true };
  }

  if (Array.isArray(stageSubpaths) && stageSubpaths.length > 0) {
    for (const sub of stageSubpaths) {
      const checked = resolveContainedEntry(resolvedRoot, sub, { expectType: "any" });
      if (!checked.ok) return checked;
      if (checked.stat.isDirectory()) {
        const subWalk = walk(checked.absPath, sub);
        if (!subWalk.ok) return subWalk;
      } else {
        const staged = stageFile(`${prefix}/${sub}`, checked.absPath, checked.stat);
        if (!staged.ok) return staged;
      }
    }
    return { ok: true, files, totalBytes, fileCount: count };
  }

  const walkRes = walk(resolvedRoot, "");
  if (!walkRes.ok) return walkRes;
  return { ok: true, files, totalBytes, fileCount: count };
}

export function evaluateTriageResultClass({
  mode,
  baselineJob,
  targetJob,
  baselineExpectedExitCode = 0,
  reproExitCode = 1,
  advisoryMeta = null,
}) {
  const isInfra = (job) =>
    !job || ["TIMED_OUT", "CANCELLED", "LOST"].includes(job.state) || job.exitCode === null || job.exitCode === 2 || job.exitCode >= 124;

  if (isInfra(baselineJob) || baselineJob.exitCode !== baselineExpectedExitCode || baselineJob.state !== "SUCCEEDED") {
    return {
      resultClass: "infra_error",
      errorCode: isInfra(baselineJob) ? "triage_baseline_infra_error" : "triage_baseline_failed",
      reason: `baseline execution did not establish healthy baseline (state=${baselineJob?.state ?? "missing"}, exit=${baselineJob?.exitCode ?? "null"})`,
    };
  }
  if (isInfra(targetJob)) {
    return {
      resultClass: "infra_error",
      errorCode: "triage_target_infra_error",
      reason: `target execution hit infra error (state=${targetJob?.state ?? "missing"}, exit=${targetJob?.exitCode ?? "null"})`,
    };
  }
  if (mode === "dependency_advisory") {
    const depAffected = advisoryMeta?.dependencyAffected;
    const targetOutcomeOk = targetJob.exitCode === reproExitCode && (reproExitCode !== 0 || targetJob.state === "SUCCEEDED");
    if (!targetOutcomeOk || typeof depAffected !== "boolean") {
      return {
        resultClass: "unknown",
        errorCode: "triage_advisory_indeterminate",
        reason: `target exit=${targetJob.exitCode} (expected repro=${reproExitCode}) or dependencyAffected=${JSON.stringify(depAffected)} is indeterminate`,
      };
    }
    return depAffected
      ? {
          resultClass: "affected",
          errorCode: null,
          reason: "baseline holds, target advisory PoC reproduces, and monitored dependency surface falls inside affected range",
        }
      : {
          resultClass: "unaffected",
          errorCode: null,
          reason: "baseline holds, vulnerable target PoC reproduces, and locked baseline dependency version lies outside affected range",
        };
  }
  if (mode === "snapshot_regression") {
    if (targetJob.exitCode === reproExitCode && (reproExitCode !== 0 || targetJob.state === "SUCCEEDED")) {
      return {
        resultClass: "affected",
        errorCode: null,
        reason: `baseline passed and target snapshot reproduced regression (exit ${targetJob.exitCode})`,
      };
    }
    if (targetJob.exitCode === 0 && targetJob.state === "SUCCEEDED") {
      return {
        resultClass: "unaffected",
        errorCode: null,
        reason: "baseline and target snapshots both passed host oracle verification",
      };
    }
    return {
      resultClass: "unknown",
      errorCode: "triage_unexpected_target_exit",
      reason: `target exited ${targetJob.exitCode} (${targetJob.state}), not matching expected pass/repro outcomes`,
    };
  }
  return {
    resultClass: "unknown",
    errorCode: "triage_unsupported_mode",
    reason: `unsupported triage mode ${mode}`,
  };
}

function extractDigestFromImageRef(imageRef) {
  const idx = String(imageRef ?? "").lastIndexOf("@");
  return idx >= 0 ? imageRef.slice(idx + 1) : String(imageRef ?? "");
}

export function buildCanonicalTriageManifest({
  preset,
  baselineTarget,
  targetTarget,
  baselineAcq,
  targetAcq,
  executionImageDigest,
  inputFixtureHash,
  timezone,
  now,
}) {
  const ensureShaLabel = (raw) =>
    typeof raw === "string" && raw.length > 0
      ? raw.startsWith("sha256:")
        ? raw
        : `sha256:${raw}`
      : `sha256:${sha256Hex("unpinned")}`;
  const commitLabel = (explicit, refFallback) => {
    const val = explicit ?? refFallback ?? "unknown-ref";
    return val.length >= 7 ? val : val.padEnd(7, "0");
  };
  return {
    schemaVersion: 1,
    jobKind: preset.jobKind,
    baseline: {
      repo: baselineTarget.repo,
      commitSha: commitLabel(preset.baselineCommitSha, baselineTarget.ref),
      sourceArchiveHash: ensureShaLabel(baselineAcq.archiveSha256),
      lockfileHash: ensureShaLabel(baselineAcq.lockfileHash ?? baselineAcq.archiveSha256),
      dependencyIntegrity: [],
    },
    target: {
      repo: targetTarget.repo,
      commitSha: commitLabel(preset.targetCommitSha, targetTarget.ref),
      sourceArchiveHash: ensureShaLabel(targetAcq.archiveSha256),
      lockfileHash: ensureShaLabel(targetAcq.lockfileHash ?? targetAcq.archiveSha256),
      dependencyIntegrity: [],
    },
    execution: {
      imageDigest: extractDigestFromImageRef(executionImageDigest),
      cpuArch: "amd64",
      toolchain: { node: process.versions.node, pi: "@earendil-works/pi-coding-agent 1.5.2" },
      commands: [
        [preset.baselineCommand.command, ...preset.baselineCommand.args],
        [preset.targetCommand.command, ...preset.targetCommand.args],
      ],
      inputFixtureHash,
      randomSeed: null,
      controllableClock: null,
      writableDeadlineSeconds: Math.max(1, Math.ceil(preset.targetCommand.deadlineMs / 1000)),
      timezone,
      restrictedEnv: {
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    },
    oracleRef: preset.oracle.oracleId,
    createdAt: now,
  };
}

function buildBaselineAndTargetOracles(preset) {
  const assertions = Array.isArray(preset.oracle.assertions) ? preset.oracle.assertions : [];
  const baseAssertion = assertions[0] ?? null;
  const targetAssertion = assertions.length > 1 ? assertions[1] : null;
  const baseOracle = {
    schemaVersion: 1,
    oracleId: `${preset.oracle.oracleId}:baseline`,
    proposition: `Baseline invariant check for ${preset.oracle.oracleId}`,
    assertions: [
      {
        id: "A1-baseline",
        kind: "baseline_passes",
        description: `Baseline must exit ${preset.baselineExpectedExitCode}`,
        expectedExitCode: preset.baselineExpectedExitCode,
        requiredOutputHash: baseAssertion?.expectedExitCode === 0 ? (baseAssertion?.requiredOutputHash ?? null) : null,
      },
    ],
    resultClassRules: preset.oracle.resultClassRules,
  };
  const targetOracle = {
    schemaVersion: 1,
    oracleId: `${preset.oracle.oracleId}:target`,
    proposition: preset.oracle.proposition,
    assertions: [
      {
        id: "A2-target",
        kind: preset.mode === "dependency_advisory" ? "target_affected" : "target_unaffected",
        description: "Target verification execution",
        expectedExitCode: 0,
        requiredOutputHash: targetAssertion?.expectedExitCode === 0 ? (targetAssertion?.requiredOutputHash ?? null) : null,
      },
    ],
    resultClassRules: preset.oracle.resultClassRules,
  };
  return { baseOracle, targetOracle };
}

async function acquireSnapshotSide(db, {
  stateDir,
  config,
  acquisitionLauncher,
  taskId,
  attemptId,
  scopeId,
  targetId,
  jobKeySuffix,
  stageSnapshotPaths,
  stageSubpaths = null,
  now,
  onProgress,
}) {
  const target = config.acquisition.targets[targetId];
  const maxDownloadBytes = target.maxDownloadBytes ?? config.acquisition.maxDownloadBytes;
  const plan = {
    schemaVersion: 1,
    entries: [
      {
        url: target.url,
        destRelPath: "repo",
        mode: target.mode,
        maxSizeBytes: maxDownloadBytes,
        ...(target.sha256 ? { sha256: target.sha256 } : {}),
        ...(target.allowedRedirectHosts.length > 0 ? { allowedRedirectHosts: target.allowedRedirectHosts } : {}),
      },
    ],
  };
  const progressIntervalMs = Math.max(500, Math.min(5000, Math.floor((config.leases?.leaseMs ?? 45000) / 3)));
  const run = await acquisitionLauncher.runPlan({
    jobKey: `${taskId}:${jobKeySuffix}`,
    taskId,
    plan,
    timeoutMs: config.acquisition.timeoutMs,
    onProgress,
    progressIntervalMs,
  });
  try {
    const first = run.report?.results?.[0] ?? null;
    if (run.timedOut || run.exitCode !== 0 || run.report?.failures !== 0 || !first?.ok) {
      return {
        ok: false,
        code: "acquisition_failed",
        reason: run.timedOut ? `acquisition timed out after ${config.acquisition.timeoutMs}ms` : first?.reason ?? `acquisition exit ${run.exitCode}`,
      };
    }
    const effectiveMaxInput = Number.isInteger(config.model?.maxInputBytes) && config.model.maxInputBytes > 0
      ? Math.min(config.model.maxInputBytes, MAX_MODEL_MESSAGES_BYTES)
      : MAX_MODEL_MESSAGES_BYTES;
    const promptSideLimit = Math.max(256, Math.floor(effectiveMaxInput * 0.34));
    const excerpt = buildSafeRepoExcerpt({
      downloadsDir: run.downloadsDir,
      entryDestRelPath: "repo",
      mode: target.mode,
      readPaths: target.readPaths,
      maxExcerptBytes: Math.min(config.acquisition.maxExcerptBytes, promptSideLimit),
    });
    if (!excerpt.ok) return excerpt;

    let stagedFiles = {};
    if (stageSnapshotPaths) {
      const collected = collectContainedSnapshotFiles({
        downloadsDir: run.downloadsDir,
        entryDestRelPath: "repo",
        mode: target.mode,
        stageSubpaths,
      });
      if (!collected.ok) return collected;
      stagedFiles = collected.files;
    }

    const archiveSha256 = first.sha256 ? `sha256:${first.sha256}` : null;
    const payload = {
      schemaVersion: 1,
      taskId,
      attemptId,
      targetId,
      repo: target.repo,
      ref: target.ref,
      imageDigest: acquisitionLauncher.imageRef,
      archiveSha256,
      lockfileHash: excerpt.lockfileHash,
      readOnly: true,
      repoWrites: 0,
      fullRepoPersisted: false,
      files: excerpt.files,
      observedAt: Math.max(now, Date.now()),
    };
    const stored = putObjectContent(stateDir, JSON.stringify(payload));
    const manifestRow = insertObjectRow(db, {
      scopeId,
      kind: "repo_observe_manifest",
      sourceUri: `triage:${attemptId}:${jobKeySuffix}`,
      sourceActor: "acquisition-host",
      contentHash: stored.contentHash,
      storageRef: stored.storageRef,
      observedAt: payload.observedAt,
      metadata: { targetId, repo: target.repo, ref: target.ref, archiveSha256 },
      requiredScopeIds: [scopeId],
    });
    return {
      ok: true,
      target,
      archiveSha256,
      lockfileHash: excerpt.lockfileHash,
      files: excerpt.files,
      manifestObjectId: manifestRow.id,
      stagedFiles,
    };
  } finally {
    rmSync(run.workDir, { recursive: true, force: true });
  }
}

async function runModelTriageSummary(db, {
  stateDir,
  config,
  ledger,
  agentLauncher,
  taskId,
  attemptId,
  attemptNo,
  leaseOwner,
  fence,
  taskDeadlineAt,
  scopeDomainKey,
  promptText,
}) {
  const modelKey = config.model.provider && config.model.modelId ? `${config.model.provider}/${config.model.modelId}` : "deepseek/deepseek-flash";
  if (taskDeadlineAt && Date.now() >= taskDeadlineAt) {
    return { ok: false, errorCode: "triage_deadline_exceeded", replyObjectId: null, actualMicrousd: 0 };
  }
  const tryHeartbeat = () => {
    try {
      heartbeat(db, { taskId, attemptNo, leaseOwner, fence, now: Date.now(), leaseMs: config.leases.leaseMs });
      return true;
    } catch (e) {
      if (isLeaseRevokedError(e)) return false;
      throw e;
    }
  };
  if (!tryHeartbeat()) {
    return { ok: false, errorCode: "triage_lease_lost", leaseLost: true, replyObjectId: null, actualMicrousd: 0 };
  }
  const launched = agentLauncher.launchAttempt({
    taskId,
    attemptId,
    attemptNo,
    fence,
    scopeDomainKey,
    modelRequest: {
      purpose: "worker",
      modelId: modelKey,
      messages: [{ role: "user", content: promptText }],
    },
    now: Date.now(),
  });
  const wallLimit = Date.now() + (config.model.callTimeoutMs ?? 60000) + 15000;
  const deadline = taskDeadlineAt ? Math.min(wallLimit, taskDeadlineAt) : wallLimit;
  try {
    while (Date.now() < deadline) {
      if (!tryHeartbeat()) {
        return { ok: false, errorCode: "triage_lease_lost", leaseLost: true, replyObjectId: null, actualMicrousd: 0 };
      }
      await processPendingModelProposalsAsync(db, {
        stateDir,
        config,
        ledger,
        leaseMs: config.leases.leaseMs,
        heartbeatMs: config.leases.heartbeatMs,
        completeActiveTask: false,
        onlyTaskId: taskId,
        now: Date.now(),
        useWallClockAfterCall: true,
      });
      const mr = db
        .prepare("SELECT request_id, state, error_code, reply_object_id, reservation_id FROM model_requests WHERE attempt_id=? ORDER BY created_at DESC LIMIT 1")
        .get(attemptId);
      if (mr) {
        if (mr.state === "SETTLED") {
          let reply = "";
          let stopReason = null;
          if (mr.reply_object_id) {
            const obj = db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(mr.reply_object_id);
            if (obj?.storage_ref) {
              try {
                const parsed = JSON.parse(readFileSync(join(stateDir, ...obj.storage_ref.split("/")), "utf8"));
                reply = typeof parsed.reply === "string" ? parsed.reply : "";
                stopReason = parsed.stopReason ?? null;
              } catch {}
            }
          }
          const resRow = mr.reservation_id ? db.prepare("SELECT actual_microusd FROM budget_reservations WHERE id=?").get(mr.reservation_id) : null;
          if (reply.trim().length === 0) {
            return {
              ok: false,
              errorCode: stopReason === "length" ? "model_output_truncated_empty" : "model_empty_reply",
              replyObjectId: mr.reply_object_id,
              actualMicrousd: resRow?.actual_microusd ?? 0,
            };
          }
          return { ok: true, reply: reply.trim(), replyObjectId: mr.reply_object_id, actualMicrousd: resRow?.actual_microusd ?? 0 };
        }
        if (mr.state === "HELD") {
          return { ok: false, errorCode: "settlement_held_uncompleted", replyObjectId: mr.reply_object_id, actualMicrousd: null };
        }
        if (mr.state === "FAILED" || mr.state === "ORPHAN" || (mr.state === "EXECUTING" && mr.error_code)) {
          return { ok: false, errorCode: mr.error_code ?? "triage_model_failed", replyObjectId: mr.reply_object_id, actualMicrousd: 0 };
        }
      }
      const insp = agentLauncher.inspectContainer(launched.containerId);
      if (!insp.running && !mr) {
        return { ok: false, errorCode: "triage_agent_exited_early", replyObjectId: null, actualMicrousd: 0 };
      }
      await sleep(150);
    }
    return { ok: false, errorCode: "triage_model_timeout", replyObjectId: null, actualMicrousd: 0 };
  } finally {
    agentLauncher.stopAttempt({ containerId: launched.containerId, commandsDir: launched.commandsDir });
    fenceAttemptProposals(launched.attemptDir, "triageStopped");
  }
}

async function runSingleExecutionJob(db, {
  executor,
  taskId,
  attemptId,
  attemptNo,
  leaseOwner,
  fence,
  leaseMs,
  taskDeadlineAt,
  jobId,
  manifest,
  oracle,
  inputFiles,
  deadlineMs,
  allowLaunch,
}) {
  const startNow = Date.now();
  if (taskDeadlineAt && startNow >= taskDeadlineAt) {
    return { jobId, state: "TIMED_OUT", exitCode: null };
  }
  const boundedMs = taskDeadlineAt ? Math.max(1000, Math.min(deadlineMs, taskDeadlineAt - startNow)) : deadlineMs;
  executor.submitJob({
    jobId,
    taskId,
    attemptId,
    fence,
    manifest: { ...manifest, deadlineMs: boundedMs },
    oracle,
    inputFiles,
    deadlineAt: startNow + boundedMs,
    now: startNow,
  });
  const loopLimit = startNow + boundedMs + 10000;
  while (Date.now() < loopLimit) {
    try {
      heartbeat(db, { taskId, attemptNo, leaseOwner, fence, now: Date.now(), leaseMs });
    } catch (e) {
      if (isLeaseRevokedError(e)) {
        try {
          executor.cancelJob({ jobId, now: Date.now() });
        } catch {}
        return { jobId, state: "CANCELLED", exitCode: null, leaseLost: true };
      }
      throw e;
    }
    const rowPre = db.prepare("SELECT state, exit_code FROM execution_jobs WHERE id=?").get(jobId);
    if (rowPre?.state === "QUEUED") {
      executor.tick({ now: Date.now(), allowLaunch });
    } else {
      executor.pollOnce({ now: Date.now() });
    }
    const row = db.prepare("SELECT state, exit_code FROM execution_jobs WHERE id=?").get(jobId);
    if (row && !["QUEUED", "RUNNING"].includes(row.state)) {
      return { jobId, state: row.state, exitCode: row.exit_code };
    }
    await sleep(250);
  }
  try {
    executor.cancelJob({ jobId, now: Date.now() });
  } catch {}
  const last = db.prepare("SELECT state, exit_code FROM execution_jobs WHERE id=?").get(jobId);
  return { jobId, state: last?.state ?? "LOST", exitCode: last?.exit_code ?? null };
}

function finishTriageOutcome(db, {
  stateDir,
  taskId,
  attemptId,
  attemptNo,
  leaseOwner,
  fence,
  scopeId,
  scopeDomainKey,
  resultClass,
  errorCode,
  reportObjectId,
  notifyChannel,
  notifyText,
  manifestHash,
  now,
}) {
  const storedNote = notifyChannel ? putObjectContent(stateDir, notifyText) : null;
  try {
    return withTx(db, () => {
      if (!notifyChannel) {
        completeTaskInTx(db, {
          taskId,
          attemptNo,
          leaseOwner,
          fence,
          now,
          resultClass,
          resultObjectId: reportObjectId,
          errorCode,
        });
        completePendingDeliveryCheckpointInTx(db, {
          taskId,
          scopeId,
          content: `repo_triage completed (${resultClass})`,
          insertObjectRowFn: insertObjectRow,
          now,
        });
        return { notified: false, leaseLost: false };
      }
      const effect = proposeEffectInTx(db, stateDir, {
        now,
        taskId,
        attemptId,
        effectType: "notify",
        domainKey: scopeDomainKey,
        naturalKey: `triage:${taskId}:${attemptNo}:${fence}`,
        operationIntent: {
          targetResource: notifyChannel,
          operation: "im.notify",
          contentHash: storedNote.contentHash,
          evidenceManifestHash: manifestHash,
        },
        retryMode: "AT_MOST_ONCE",
        provider: parseTelegramTargetResource(notifyChannel) !== null ? "telegram" : "upstream",
        resource: notifyChannel,
        requiresApproval: false,
        expiresAt: now + 60 * 60 * 1000,
      });
      draftToReadyInTx(db, {
        effectId: effect.effectId,
        routineRef: "result-notification",
        approvedRoutines: ["result-notification"],
        now,
      });
      finalizeTaskWithNotificationInTx(db, {
        now,
        taskId,
        attemptNo,
        leaseOwner,
        fence,
        resultClass,
        resultObjectId: reportObjectId,
        errorCode,
        notification: {
          effectId: effect.effectId,
          channel: parseTelegramTargetResource(notifyChannel) !== null ? "telegram" : "upstream",
          destination: notifyChannel,
          notBefore: now,
          notifyReason: `triage:${resultClass}`,
        },
      });
      completePendingDeliveryCheckpointInTx(db, {
        taskId,
        scopeId,
        content: `repo_triage completed (${resultClass})`,
        insertObjectRowFn: insertObjectRow,
        now,
      });
      return { notified: true, effectId: effect.effectId, leaseLost: false };
    });
  } catch (e) {
    if (isLeaseRevokedError(e)) {
      return { notified: false, leaseLost: true };
    }
    throw e;
  }
}

function formatTriageNotification({ presetId, repo, resultClass, reason, actualMicrousd, reportHash }) {
  const verdictTag = resultClass.toUpperCase();
  const costText = Number.isInteger(actualMicrousd) ? `${actualMicrousd}u$` : "held";
  const line = `[AegisPi] triage=${presetId} repo=${repo} result=${verdictTag} cost=${costText} ref=${reportHash.slice(0, 12)} - ${reason}`;
  return line.slice(0, 380);
}

export async function executeRepoTriageTask(db, {
  stateDir,
  config,
  ledger,
  acquisitionLauncher,
  agentLauncher,
  executor,
  diskLevel,
  claim,
  taskRow,
  scopeRow,
  parsed,
  now,
}) {
  let leaseRevoked = false;
  const finishPreFail = (code, reason) => {
    const finishNow = Math.max(now, Date.now());
    writeAudit(db, { code: "triage_refused", taskId: claim.taskId, details: { reason_code: code, reason }, now: finishNow });
    if (leaseRevoked) {
      return { resultClass: "infra_error", errorCode: code };
    }
    const obj = putObjectContent(stateDir, JSON.stringify({ ok: false, code, reason, at: finishNow }));
    try {
      withTx(db, () => {
        const errRow = insertObjectRow(db, {
          scopeId: taskRow.scope_id,
          kind: "task_result",
          sourceUri: `triage-fail:${claim.attemptId}`,
          sourceActor: "host-triage",
          contentHash: obj.contentHash,
          storageRef: obj.storageRef,
          observedAt: finishNow,
          requiredScopeIds: [taskRow.scope_id],
        });
        completeTaskInTx(db, {
          ...claim,
          now: finishNow,
          resultClass: "infra_error",
          resultObjectId: errRow.id,
          errorCode: code,
        });
        completePendingDeliveryCheckpointInTx(db, {
          taskId: claim.taskId,
          scopeId: taskRow.scope_id,
          content: `repo_triage completed (infra_error)`,
          insertObjectRowFn: insertObjectRow,
          now: finishNow,
        });
      });
    } catch (e) {
      if (isLeaseRevokedError(e)) {
        leaseRevoked = true;
        return { resultClass: "infra_error", errorCode: "triage_lease_lost" };
      }
      throw e;
    }
    return { resultClass: "infra_error", errorCode: code };
  };

  if (!parsed.valid) {
    return finishPreFail(parsed.code, parsed.reason);
  }
  const preset = config.triage?.presets?.[parsed.presetId] ?? null;
  if (!preset) {
    return finishPreFail("triage_preset_not_allowed", `preset ${parsed.presetId} is not registered in triage.presets`);
  }
  if (!executor || !acquisitionLauncher || (config.triage.allowModelObserve && !agentLauncher)) {
    return finishPreFail("triage_missing_launcher", "triage requires --acquisition-image, --execution-image, and --agent-image");
  }
  if (diskLevel !== "ok") {
    return finishPreFail("disk_watermark_blocked", `disk watermark (${diskLevel}) blocks new triage execution jobs`);
  }
  const authBase = authorizeAcquisitionTarget({ config, targetId: preset.baselineTargetId, hasAcquisitionLauncher: true });
  if (!authBase.ok) return finishPreFail(authBase.code, authBase.reason);
  const authTgt = authorizeAcquisitionTarget({ config, targetId: preset.targetTargetId, hasAcquisitionLauncher: true });
  if (!authTgt.ok) return finishPreFail(authTgt.code, authTgt.reason);

  const nonLoopbackFetch = config.acquisition.allowRealRepoFetch || !isLoopbackModelEndpoint(config.model.baseUrl ?? "http://127.0.0.1");
  if (nonLoopbackFetch && config.triage.allowRealTriage !== true) {
    return finishPreFail("triage_real_disabled", "triage.allowRealTriage is false for non-loopback operation");
  }
  if (parsed.notifyChannel) {
    const recipients = config.adapters?.allowedRecipients ?? [];
    if (!Array.isArray(recipients) || !recipients.includes(parsed.notifyChannel)) {
      return finishPreFail("triage_notify_target_not_allowed", `notifyChannel ${parsed.notifyChannel} is not in adapters.allowedRecipients`);
    }
  }

  const onProgress = () => {
    try {
      heartbeat(db, { ...claim, now: Date.now(), leaseMs: config.leases.leaseMs });
    } catch (e) {
      if (isLeaseRevokedError(e)) {
        leaseRevoked = true;
      }
      throw e;
    }
  };
  const checkLease = () => {
    try {
      onProgress();
      return true;
    } catch (e) {
      if (leaseRevoked || isLeaseRevokedError(e)) return false;
      throw e;
    }
  };

  const baseAcq = await acquireSnapshotSide(db, {
    stateDir,
    config,
    acquisitionLauncher,
    taskId: claim.taskId,
    attemptId: claim.attemptId,
    scopeId: taskRow.scope_id,
    targetId: preset.baselineTargetId,
    jobKeySuffix: `${claim.attemptNo}-base`,
    stageSnapshotPaths: preset.stageSnapshotPaths,
    stageSubpaths: preset.stageSubpaths,
    now,
    onProgress,
  });
  if (leaseRevoked || !checkLease()) return finishPreFail("triage_lease_lost", "task lease lost during baseline acquisition");
  if (!baseAcq.ok) {
    return finishPreFail(baseAcq.code, baseAcq.reason);
  }
  const tgtAcq = await acquireSnapshotSide(db, {
    stateDir,
    config,
    acquisitionLauncher,
    taskId: claim.taskId,
    attemptId: claim.attemptId,
    scopeId: taskRow.scope_id,
    targetId: preset.targetTargetId,
    jobKeySuffix: `${claim.attemptNo}-tgt`,
    stageSnapshotPaths: preset.stageSnapshotPaths,
    stageSubpaths: preset.stageSubpaths,
    now: Date.now(),
    onProgress,
  });
  if (leaseRevoked || !checkLease()) return finishPreFail("triage_lease_lost", "task lease lost during target acquisition");
  if (!tgtAcq.ok) {
    return finishPreFail(tgtAcq.code, tgtAcq.reason);
  }

  let modelOutcome = { ok: true, reply: "model observe disabled by host config", replyObjectId: null, actualMicrousd: 0 };
  if (config.triage.allowModelObserve) {
    const questionText =
      parsed.question ??
      preset.question ??
      `Analyze the baseline vs target repository diffs for preset ${parsed.presetId} read-only.`;
    const header = [
      `Observe Repo Triage: ${tgtAcq.target.repo} (baseline=${baseAcq.target.ref}, target=${tgtAcq.target.ref}, readOnly=true)`,
      "Sanitized Read-Only Excerpts:",
    ].join("\n");
    const formatSide = (label, side) =>
      `== ${label} (${side.archiveSha256 ?? "unpinned"}) ==\n` +
      side.files.map((f) => `--- ${f.path} (${f.sha256}, bytes=${f.bytes}, truncated=${f.truncated}) ---\n${f.excerpt}`).join("\n");
    const questionTail = `\n\nTask Question: ${questionText}`;
    const maxInput = config.model.maxInputBytes;
    const effectiveMaxInput = maxInput !== null && maxInput !== undefined
      ? Math.min(maxInput, MAX_MODEL_MESSAGES_BYTES)
      : MAX_MODEL_MESSAGES_BYTES;
    const minBytes = jsonEnvelopeBytes(`${header}\n${questionTail}`);
    if (minBytes > effectiveMaxInput) {
      return finishPreFail("input_bytes_exceeded", `triage prompt envelope (${minBytes}B) exceeds maxInputBytes (${effectiveMaxInput}B)`);
    }
    const baseText = formatSide("BASELINE", baseAcq);
    const tgtText = formatSide("TARGET", tgtAcq);
    const sideBudgetBytes = Math.max(0, Math.floor((effectiveMaxInput - minBytes - 64) / 2));
    const fitSideToJsonBytes = (rawSide) => {
      if (jsonEnvelopeBytes(`${header}\n${rawSide}${questionTail}`) - minBytes <= sideBudgetBytes) {
        return rawSide;
      }
      let lo = 0;
      let hi = Buffer.byteLength(rawSide, "utf8");
      let best = "";
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const cand = trimUtf8ToBytes(rawSide, mid).text;
        const delta = Buffer.byteLength(JSON.stringify(cand), "utf8") - 2;
        if (delta <= sideBudgetBytes) {
          best = cand;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return best;
    };
    const symmetricPrefix = `${header}\n${fitSideToJsonBytes(baseText)}\n${fitSideToJsonBytes(tgtText)}`;
    const promptText = fitPromptToMaxInputBytes(symmetricPrefix, effectiveMaxInput, questionTail);

    modelOutcome = await runModelTriageSummary(db, {
      stateDir,
      config,
      ledger,
      agentLauncher,
      taskId: claim.taskId,
      attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      leaseOwner: claim.leaseOwner,
      fence: claim.fence,
      taskDeadlineAt: taskRow.deadline_at,
      scopeDomainKey: scopeRow.domain_key,
      promptText,
      now: Date.now(),
    });
    if (modelOutcome.leaseLost) {
      leaseRevoked = true;
      return finishPreFail("triage_lease_lost", "task lease lost during model triage step");
    }
    if (!modelOutcome.ok) {
      return finishPreFail(modelOutcome.errorCode, `model triage step failed: ${modelOutcome.errorCode}`);
    }
  }

  const baseInputFiles = { ...preset.baselineInputFiles, ...baseAcq.stagedFiles };
  const tgtInputFiles = { ...preset.targetInputFiles, ...tgtAcq.stagedFiles };
  const fixtureDigestSeed = Object.entries({ ...baseInputFiles, ...tgtInputFiles })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${sha256Hex(v)}`)
    .join("\n");
  const inputFixtureHash = sha256Hex(fixtureDigestSeed);

  const canonicalManifest = buildCanonicalTriageManifest({
    preset,
    baselineTarget: baseAcq.target,
    targetTarget: tgtAcq.target,
    baselineAcq: baseAcq,
    targetAcq: tgtAcq,
    executionImageDigest: executor.imageRef,
    inputFixtureHash,
    timezone: config.timezone,
    now: Date.now(),
  });
  const storedManifest = putObjectContent(stateDir, JSON.stringify(canonicalManifest));
  const manifestObj = insertObjectRow(db, {
    scopeId: taskRow.scope_id,
    kind: "job_manifest",
    sourceUri: `triage-manifest:${claim.attemptId}`,
    sourceActor: "host-triage",
    contentHash: storedManifest.contentHash,
    storageRef: storedManifest.storageRef,
    observedAt: Date.now(),
    requiredScopeIds: [taskRow.scope_id],
    parents: [
      { parentId: baseAcq.manifestObjectId, relation: "derived_from" },
      { parentId: tgtAcq.manifestObjectId, relation: "derived_from" },
    ],
  });

  const storedOracle = putObjectContent(stateDir, JSON.stringify(preset.oracle));
  const oracleObj = insertObjectRow(db, {
    scopeId: taskRow.scope_id,
    kind: "job_oracle",
    sourceUri: `triage-oracle:${claim.attemptId}`,
    sourceActor: "host-triage",
    contentHash: storedOracle.contentHash,
    storageRef: storedOracle.storageRef,
    observedAt: Date.now(),
    requiredScopeIds: [taskRow.scope_id],
  });

  const { baseOracle, targetOracle } = buildBaselineAndTargetOracles(preset);
  const allowLaunch = diskLevel === "ok";

  const baseJobId = `tr:${claim.taskId}:${claim.attemptNo}:${claim.fence}:b`;
  const baselineJob = await runSingleExecutionJob(db, {
    executor,
    taskId: claim.taskId,
    attemptId: claim.attemptId,
    attemptNo: claim.attemptNo,
    leaseOwner: claim.leaseOwner,
    fence: claim.fence,
    leaseMs: config.leases.leaseMs,
    taskDeadlineAt: taskRow.deadline_at,
    jobId: baseJobId,
    manifest: {
      schemaVersion: 1,
      jobId: baseJobId,
      command: preset.baselineCommand.command,
      args: preset.baselineCommand.args,
      deadlineMs: preset.baselineCommand.deadlineMs,
    },
    oracle: baseOracle,
    inputFiles: baseInputFiles,
    deadlineMs: preset.baselineCommand.deadlineMs,
    allowLaunch,
  });
  if (baselineJob.leaseLost) {
    leaseRevoked = true;
    return finishPreFail("triage_lease_lost", "task lease lost during baseline execution job");
  }

  let targetJob = { jobId: null, state: "SKIPPED", exitCode: null };
  if (baselineJob.state === "SUCCEEDED" && baselineJob.exitCode === preset.baselineExpectedExitCode) {
    const tgtJobId = `tr:${claim.taskId}:${claim.attemptNo}:${claim.fence}:t`;
    targetJob = await runSingleExecutionJob(db, {
      executor,
      taskId: claim.taskId,
      attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      leaseOwner: claim.leaseOwner,
      fence: claim.fence,
      leaseMs: config.leases.leaseMs,
      taskDeadlineAt: taskRow.deadline_at,
      jobId: tgtJobId,
      manifest: {
        schemaVersion: 1,
        jobId: tgtJobId,
        command: preset.targetCommand.command,
        args: preset.targetCommand.args,
        deadlineMs: preset.targetCommand.deadlineMs,
      },
      oracle: targetOracle,
      inputFiles: tgtInputFiles,
      deadlineMs: preset.targetCommand.deadlineMs,
      allowLaunch,
    });
    if (targetJob.leaseLost) {
      leaseRevoked = true;
      return finishPreFail("triage_lease_lost", "task lease lost during target execution job");
    }
  }

  const verdict = evaluateTriageResultClass({
    mode: preset.mode,
    baselineJob,
    targetJob,
    baselineExpectedExitCode: preset.baselineExpectedExitCode,
    reproExitCode: preset.reproExitCode,
    advisoryMeta: preset.advisoryMeta,
  });

  const reportPayload = {
    schemaVersion: 1,
    presetId: parsed.presetId,
    mode: preset.mode,
    repo: tgtAcq.target.repo,
    baselineRef: baseAcq.target.ref,
    targetRef: tgtAcq.target.ref,
    resultClass: verdict.resultClass,
    errorCode: verdict.errorCode,
    reason: verdict.reason,
    advisorySummary: modelOutcome.reply.slice(0, 2000),
    modelActualMicrousd: modelOutcome.actualMicrousd,
    baselineJob,
    targetJob,
    canonicalManifestObjectId: manifestObj.id,
    oracleObjectId: oracleObj.id,
    at: Date.now(),
  };
  const storedReport = putObjectContent(stateDir, JSON.stringify(reportPayload));
  const parents = [
    { parentId: manifestObj.id, relation: "derived_from" },
    { parentId: oracleObj.id, relation: "derived_from" },
    { parentId: baseAcq.manifestObjectId, relation: "derived_from" },
    { parentId: tgtAcq.manifestObjectId, relation: "derived_from" },
  ];
  if (modelOutcome.replyObjectId) {
    parents.push({ parentId: modelOutcome.replyObjectId, relation: "derived_from" });
  }
  const reportObj = insertObjectRow(db, {
    scopeId: taskRow.scope_id,
    kind: "task_result",
    sourceUri: `triage-report:${claim.attemptId}`,
    sourceActor: "host-triage",
    contentHash: storedReport.contentHash,
    storageRef: storedReport.storageRef,
    observedAt: reportPayload.at,
    metadata: { resultClass: verdict.resultClass, presetId: parsed.presetId },
    requiredScopeIds: [taskRow.scope_id],
    parents,
  });

  writeAudit(db, {
    code: "triage_completed",
    taskId: claim.taskId,
    details: {
      preset_id: parsed.presetId,
      result_class: verdict.resultClass,
      error_code: verdict.errorCode,
      baseline_job: baselineJob,
      target_job: targetJob,
      manifest_object_id: manifestObj.id,
      report_object_id: reportObj.id,
    },
    now: reportPayload.at,
  });

  const notifyText = formatTriageNotification({
    presetId: parsed.presetId,
    repo: tgtAcq.target.repo,
    resultClass: verdict.resultClass,
    reason: verdict.reason,
    actualMicrousd: modelOutcome.actualMicrousd,
    reportHash: storedReport.contentHash,
  });

  const outcome = finishTriageOutcome(db, {
    stateDir,
    taskId: claim.taskId,
    attemptId: claim.attemptId,
    attemptNo: claim.attemptNo,
    leaseOwner: claim.leaseOwner,
    fence: claim.fence,
    scopeId: taskRow.scope_id,
    scopeDomainKey: scopeRow.domain_key,
    resultClass: verdict.resultClass,
    errorCode: verdict.errorCode,
    reportObjectId: reportObj.id,
    notifyChannel: parsed.notifyChannel,
    notifyText,
    manifestHash: storedManifest.contentHash,
    now: reportPayload.at,
  });
  if (outcome.leaseLost) {
    leaseRevoked = true;
    return finishPreFail("triage_lease_lost", "task lease lost before final triage completion");
  }

  return {
    resultClass: verdict.resultClass,
    errorCode: verdict.errorCode,
    reportObjectId: reportObj.id,
    manifestObjectId: manifestObj.id,
    oracleObjectId: oracleObj.id,
  };
}
