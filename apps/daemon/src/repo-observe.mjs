import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeAudit } from "./audit.mjs";
import { isLoopbackModelEndpoint } from "./model-call.mjs";
import { insertObjectRow, putObjectContent } from "./objects.mjs";

const DEFAULT_OBSERVE_QUESTION =
  "Summarize the observed repository files read-only and highlight configuration, dependency, or security observations.";

function scrubSensitiveText(text) {
  return String(text)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
    .replace(/\bghp_[A-Za-z0-9]{16,}\b/g, "[REDACTED_GH_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_GH_PAT]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, "Bearer [REDACTED_TOKEN]");
}

export function observeManifestSourceUri(attemptId) {
  return `observe:${attemptId}`;
}

export function observeManifestObjectIdForAttempt(db, attemptId) {
  return (
    db.prepare("SELECT id FROM objects WHERE kind='repo_observe_manifest' AND source_uri=?").get(observeManifestSourceUri(attemptId))
      ?.id ?? null
  );
}

export function isHttpUrlWithoutCredentials(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
}

export function isSafeRelativeReadPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.startsWith("/") || relPath.includes("\\")) {
    return false;
  }
  return !relPath.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

function trimUtf8ToBytes(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

function fitPromptToMaxInputBytes(promptText, maxInputBytes) {
  const envelopeBytes = (s) => Buffer.byteLength(JSON.stringify([{ role: "user", content: s }]), "utf8");
  if (envelopeBytes(promptText) <= maxInputBytes) {
    return promptText;
  }
  let lo = 0;
  let hi = Buffer.byteLength(promptText, "utf8");
  let best = "";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = trimUtf8ToBytes(promptText, mid).text;
    if (envelopeBytes(candidate) <= maxInputBytes) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function parseRepoObservePayload(rawPayload) {
  if (typeof rawPayload !== "string") {
    return { isObserve: false };
  }
  const trimmed = rawPayload.trim();
  if (!trimmed.startsWith("{")) {
    return { isObserve: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { isObserve: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.kind !== "repo_observe") {
    return { isObserve: false };
  }
  if (typeof parsed.targetId !== "string" || parsed.targetId.trim().length === 0 || parsed.targetId.length > 128) {
    return { isObserve: true, valid: false, code: "invalid_observe_payload", reason: "repo_observe requires a non-empty targetId" };
  }
  if (parsed.question !== undefined && (typeof parsed.question !== "string" || parsed.question.length > 4096)) {
    return { isObserve: true, valid: false, code: "invalid_observe_payload", reason: "repo_observe question must be <= 4096 chars" };
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "kind" && key !== "targetId" && key !== "question") {
      return { isObserve: true, valid: false, code: "invalid_observe_payload", reason: `unknown repo_observe field: ${key}` };
    }
  }
  return {
    isObserve: true,
    valid: true,
    targetId: parsed.targetId.trim(),
    question: parsed.question?.trim() || DEFAULT_OBSERVE_QUESTION,
  };
}

export function authorizeAcquisitionTarget({ config, targetId, hasAcquisitionLauncher }) {
  const acq = config?.acquisition;
  const targets = acq?.targets;
  if (!targets || !Object.prototype.hasOwnProperty.call(targets, targetId)) {
    return {
      ok: false,
      code: "acquisition_target_not_allowed",
      reason: `target ${JSON.stringify(targetId)} is not registered in host acquisition.targets`,
    };
  }
  const target = targets[targetId];
  if (!isHttpUrlWithoutCredentials(target.url)) {
    return { ok: false, code: "acquisition_invalid_url", reason: "target URL must be http(s) without embedded credentials" };
  }
  const url = new URL(target.url);
  const allowedHosts = Array.isArray(acq.allowedHosts) ? acq.allowedHosts : [];
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    return {
      ok: false,
      code: "acquisition_host_not_allowed",
      reason: `target host ${url.hostname} is not in acquisition.allowedHosts`,
    };
  }
  if (!isLoopbackModelEndpoint(target.url) && acq.allowRealRepoFetch !== true) {
    return {
      ok: false,
      code: "acquisition_real_fetch_disabled",
      reason: "acquisition.allowRealRepoFetch is false for non-loopback target (fail closed)",
    };
  }
  for (const h of target.allowedRedirectHosts ?? []) {
    if (!allowedHosts.includes(String(h).toLowerCase())) {
      return {
        ok: false,
        code: "acquisition_redirect_host_not_allowed",
        reason: `redirect host ${h} is not in acquisition.allowedHosts`,
      };
    }
  }
  const maxFiles = Number.isInteger(acq.maxFiles) && acq.maxFiles > 0 ? acq.maxFiles : 32;
  if (!Array.isArray(target.readPaths) || target.readPaths.length === 0 || target.readPaths.length > maxFiles) {
    return {
      ok: false,
      code: "acquisition_invalid_read_paths",
      reason: `target readPaths must contain 1..${maxFiles} entries`,
    };
  }
  for (const p of target.readPaths) {
    if (!isSafeRelativeReadPath(p)) {
      return { ok: false, code: "acquisition_invalid_read_paths", reason: `unsafe readPath ${JSON.stringify(p)}` };
    }
  }
  if (!hasAcquisitionLauncher) {
    return {
      ok: false,
      code: "acquisition_image_not_wired",
      reason: "no acquisition image wired (--acquisition-image=<digest>)",
    };
  }
  return { ok: true, target };
}

function readContainedRegularFile(rootDir, relPath) {
  const resolvedRoot = resolve(rootDir);
  const parts = relPath.split("/");
  let cur = resolvedRoot;
  for (let i = 0; i < parts.length; i += 1) {
    cur = join(cur, parts[i]);
    if (!cur.startsWith(resolvedRoot + sep)) {
      return { ok: false, code: "acquisition_path_escape", reason: `readPath ${relPath} escapes root` };
    }
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return { ok: false, code: "acquisition_read_path_missing", reason: `readPath ${relPath} missing from fetched tree` };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, code: "acquisition_symlink_rejected", reason: `readPath ${relPath} traverses a symlink` };
    }
    const isLast = i === parts.length - 1;
    if (isLast && !st.isFile()) {
      return { ok: false, code: "acquisition_non_file_rejected", reason: `readPath ${relPath} is not a regular file` };
    }
    if (!isLast && !st.isDirectory()) {
      return { ok: false, code: "acquisition_invalid_path_component", reason: `readPath ${relPath} parent is not a directory` };
    }
  }
  const raw = readFileSync(cur);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  return { ok: true, raw, sha256 };
}

export function buildSafeRepoExcerpt({
  downloadsDir,
  entryDestRelPath,
  mode,
  readPaths,
  maxExcerptBytes,
}) {
  const rootDir = mode === "tar" ? join(downloadsDir, entryDestRelPath) : downloadsDir;
  if (!existsSync(rootDir)) {
    return { ok: false, code: "acquisition_output_missing", reason: `extracted directory missing at ${entryDestRelPath}` };
  }
  const files = [];
  let remainingBytes = maxExcerptBytes;
  let lockfileHash = null;
  for (const rel of readPaths) {
    const res = readContainedRegularFile(rootDir, rel);
    if (!res.ok) return res;
    if (rel === "package-lock.json" || rel.endsWith("/package-lock.json")) {
      lockfileHash = `sha256:${res.sha256}`;
    }
    const sanitized = scrubSensitiveText(res.raw.toString("utf8"));
    const budgetForFile = Math.max(0, remainingBytes);
    const trimmed = trimUtf8ToBytes(sanitized, budgetForFile);
    remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(trimmed.text, "utf8"));
    files.push({
      path: rel,
      sha256: `sha256:${res.sha256}`,
      bytes: res.raw.byteLength,
      truncated: trimmed.truncated,
      excerpt: trimmed.text,
    });
  }
  return { ok: true, files, lockfileHash };
}

export async function executeRepoObserveAcquisition(db, {
  stateDir,
  config,
  acquisitionLauncher,
  taskId,
  attemptId,
  attemptNo,
  fence,
  scopeId,
  targetId,
  question,
  now,
  onProgress = null,
}) {
  const auth = authorizeAcquisitionTarget({
    config,
    targetId,
    hasAcquisitionLauncher: Boolean(acquisitionLauncher),
  });
  if (!auth.ok) {
    writeAudit(db, {
      code: "acquisition_refused",
      taskId,
      details: { target_id: targetId, reason_code: auth.code, reason: auth.reason, attempt_id: attemptId, fence },
      now,
    });
    return { ok: false, code: auth.code, reason: auth.reason };
  }

  const target = auth.target;
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

  writeAudit(db, {
    code: "acquisition_started",
    taskId,
    details: {
      target_id: targetId,
      repo: target.repo,
      ref: target.ref,
      mode: target.mode,
      read_paths: target.readPaths,
      image: acquisitionLauncher.imageRef,
    },
    now,
  });

  const run = await acquisitionLauncher.runPlan({
    jobKey: `${taskId}:${attemptNo}`,
    taskId,
    plan,
    timeoutMs: config.acquisition.timeoutMs,
    onProgress,
  });
  const finishedAt = Math.max(now, Date.now());

  try {
    const firstResult = run.report?.results?.[0] ?? null;
    if (run.timedOut || run.exitCode !== 0 || run.report?.failures !== 0 || !firstResult?.ok) {
      const reason = run.timedOut
        ? `acquisition timed out after ${config.acquisition.timeoutMs}ms`
        : firstResult?.reason ?? run.report?.error ?? `acquisition exited with code ${run.exitCode}`;
      const storedFail = putObjectContent(
        stateDir,
        JSON.stringify({
          schemaVersion: 1,
          targetId,
          repo: target.repo,
          ref: target.ref,
          timedOut: run.timedOut,
          exitCode: run.exitCode,
          reason,
        }),
      );
      const failObj = insertObjectRow(db, {
        scopeId,
        kind: "acquisition_report",
        sourceUri: `acq-fail:${attemptId}`,
        sourceActor: "acquisition-host",
        contentHash: storedFail.contentHash,
        storageRef: storedFail.storageRef,
        observedAt: finishedAt,
        requiredScopeIds: [scopeId],
      });
      writeAudit(db, {
        code: "acquisition_failed",
        taskId,
        details: { target_id: targetId, reason, exit_code: run.exitCode, timed_out: run.timedOut, report_object_id: failObj.id },
        now: finishedAt,
      });
      return { ok: false, code: "acquisition_failed", reason, reportObjectId: failObj.id };
    }

    const archiveSha256 = firstResult.sha256 ? `sha256:${firstResult.sha256}` : null;
    const header = [
      `Observe Repo: ${target.repo} (ref=${target.ref}, archive=${archiveSha256 ?? "unpinned"}, readOnly=true)`,
      `Question: ${question}`,
      "Sanitized Read-Only Excerpts:",
    ].join("\n");
    const fixedEnvelopeBytes = Buffer.byteLength(JSON.stringify([{ role: "user", content: `${header}\n` }]), "utf8");
    const perFileHeaderBytes = target.readPaths.reduce(
      (sum, p) => sum + Buffer.byteLength(`--- ${p} (sha256:${"0".repeat(64)}, bytes=9999999, truncated=true) ---\n\n`, "utf8"),
      0,
    );
    const hasInputCap = config.model.maxInputBytes !== null && config.model.maxInputBytes !== undefined;
    const capLimit = hasInputCap
      ? Math.max(0, Math.min(config.acquisition.maxExcerptBytes, config.model.maxInputBytes - fixedEnvelopeBytes - perFileHeaderBytes - 32))
      : config.acquisition.maxExcerptBytes;

    const excerpt = buildSafeRepoExcerpt({
      downloadsDir: run.downloadsDir,
      entryDestRelPath: "repo",
      mode: target.mode,
      readPaths: target.readPaths,
      maxExcerptBytes: capLimit,
    });
    if (!excerpt.ok) {
      writeAudit(db, {
        code: "acquisition_failed",
        taskId,
        details: { target_id: targetId, reason_code: excerpt.code, reason: excerpt.reason },
        now: finishedAt,
      });
      return { ok: false, code: excerpt.code, reason: excerpt.reason };
    }

    const manifestPayload = {
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
      observedAt: finishedAt,
    };
    const storedManifest = putObjectContent(stateDir, JSON.stringify(manifestPayload));
    const manifestRow = insertObjectRow(db, {
      scopeId,
      kind: "repo_observe_manifest",
      sourceUri: observeManifestSourceUri(attemptId),
      sourceActor: "acquisition-host",
      contentHash: storedManifest.contentHash,
      storageRef: storedManifest.storageRef,
      observedAt: finishedAt,
      metadata: {
        targetId,
        repo: target.repo,
        ref: target.ref,
        archiveSha256,
        readOnly: true,
        repoWrites: 0,
      },
      requiredScopeIds: [scopeId],
    });
    writeAudit(db, {
      code: "acquisition_completed",
      taskId,
      details: {
        target_id: targetId,
        repo: target.repo,
        ref: target.ref,
        manifest_object_id: manifestRow.id,
        archive_sha256: archiveSha256,
        files_read: excerpt.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
        read_only: true,
        repo_writes: 0,
      },
      now: finishedAt,
    });

    const body = excerpt.files
      .map((f) => `--- ${f.path} (${f.sha256}, bytes=${f.bytes}, truncated=${f.truncated}) ---\n${f.excerpt}`)
      .join("\n");
    let promptText = `${header}\n${body}`;
    if (hasInputCap) {
      promptText = fitPromptToMaxInputBytes(promptText, config.model.maxInputBytes);
    }

    return { ok: true, manifestObjectId: manifestRow.id, promptText };
  } finally {
    rmSync(run.workDir, { recursive: true, force: true });
  }
}
