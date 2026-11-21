// Host-side container executor for offline jobs (02 section 5, 06 sections
// 2/4/9). The execution image runs with:
//   --network none            (no network interface in the namespace)
//   --cpus/--memory/--pids-limit (06 section 4 quota placeholders, calibrated)
//   --read-only root fs + bounded tmpfs work dir
//   --cap-drop ALL --security-opt no-new-privileges
//   three mounts: the manifest (host bind, ro), the output (a NAMED VOLUME
//   initialized from the image's own /job/output, owned by the image user),
//   the work tmpfs. Audit F2: the image declares the mount-point ownership,
//   so a Linux host's default umask can never deny the image user its own
//   evidence directory, and the host does no global chmod 777. Evidence
//   comes back with docker cp before the container is removed.
// No host secrets, no session tickets, no docker socket, no agent home.
//
// The wall-clock deadline is enforced TWICE: the in-container runner kills
// its child at the deadline, and the HOST kills the whole container at the
// deadline no matter what the job did to the runner. A job that forges or
// destroys evidence only loses its own evidence.
//
// Terminal states are HOST decisions (02 section 5): the container exit
// code and the runner's documented conventions (124/125/126/137) are the
// trusted inputs; result.json is evidence, never a state decision. Exit 0
// becomes SUCCEEDED only after the bound oracle (a host-authored,
// content-addressed acceptance definition) holds against the collected
// evidence; an unreadable oracle refuses success.
//
// Container sidecars are stored with a "container:" prefix so the legacy
// pid-based reaper ignores them and this module owns their lifecycle.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { withTx } from "./db/tx.mjs";
import { writeAudit } from "./audit.mjs";
import { insertObjectRow, putObjectContent } from "./objects.mjs";
import { evaluateJobOracle, loadJobOracleContent, validateJobOracle } from "./job-oracle.mjs";
import { isSafeRelativeReadPath } from "./repo-observe.mjs";
import {
  createJob,
  finishJob,
  jobPidFileName,
  markTimedOutJob,
  startJob,
} from "./execution-jobs.mjs";

export class ExecutorError extends Error {}

function docker(dockerBin, args, { capture = false } = {}) {
  const r = spawnSync(dockerBin, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
    shell: false,
  });
  return { code: r.status, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

export function createContainerExecutor(db, {
  stateDir,
  imageRef, // must be a digest-pinned reference (image-gate enforced by callers)
  // 06 section 4 placeholder quotas; values carry docker units so tests can
  // use small bounds without pretending they are the calibrated defaults.
  quotas = { cpus: 1, memory: "2g", pids: 256, tmpfsSize: "4g" },
  dockerBin = "docker",
  network = "none",
  machineWideMax = 2,
}) {
  if (typeof imageRef !== "string" || !/@sha256:[0-9a-f]{64}$/.test(imageRef)) {
    throw new ExecutorError(
      `execution image must be digest-pinned, got ${imageRef}; a floating tag is never an isolation reference`,
    );
  }
  const jobsDir = join(stateDir, "jobs");

  function safeJobDirName(jobId) {
    if (typeof jobId !== "string" || jobId.length === 0) {
      throw new ExecutorError("jobId must be a non-empty string");
    }
    const sanitized = jobId.replace(/[^A-Za-z0-9._-]/g, "_");
    if (sanitized === "." || sanitized === "..") {
      throw new ExecutorError(`jobId ${JSON.stringify(jobId)} resolves to invalid directory component`);
    }
    return sanitized;
  }

  function jobDir(jobId) {
    const resolvedJobs = resolve(jobsDir);
    const target = resolve(resolvedJobs, safeJobDirName(jobId));
    if (!target.startsWith(resolvedJobs + sep)) {
      throw new ExecutorError(`jobDir escaped jobs root for ${JSON.stringify(jobId)}`);
    }
    return target;
  }

  function stagedInputDir(jobId) {
    const inputsRoot = resolve(stateDir, "job-inputs");
    const target = resolve(inputsRoot, safeTaskDirComponent(jobId));
    if (!target.startsWith(inputsRoot + sep)) {
      throw new ExecutorError(`stagedInputDir escaped staging root for ${JSON.stringify(jobId)}`);
    }
    return target;
  }

  function prepareStagedInputFiles(jobId, inputFiles) {
    if (inputFiles === null || inputFiles === undefined) return null;
    if (typeof inputFiles !== "object" || Array.isArray(inputFiles)) {
      throw new ExecutorError(`job ${jobId} inputFiles must be a plain object mapping safe paths to contents`);
    }
    const entries = Object.entries(inputFiles);
    if (entries.length > 4096) {
      throw new ExecutorError(`job ${jobId} inputFiles exceeds max entry count (4096)`);
    }
    const prepared = [];
    let totalBytes = 0;
    const seenPaths = new Set();
    for (const [relPath, content] of entries) {
      if (!isSafeRelativeReadPath(relPath) || relPath.toLowerCase() === "manifest.json") {
        throw new ExecutorError(`job ${jobId} invalid staged input path ${JSON.stringify(relPath)}`);
      }
      if (typeof content !== "string" && !Buffer.isBuffer(content)) {
        throw new ExecutorError(`job ${jobId} staged input ${relPath} must be string or Buffer`);
      }
      if (seenPaths.has(relPath)) {
        throw new ExecutorError(`job ${jobId} duplicate staged input path ${relPath}`);
      }
      seenPaths.add(relPath);
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      totalBytes += buf.byteLength;
      if (totalBytes > 16 * 1024 * 1024) {
        throw new ExecutorError(`job ${jobId} staged inputFiles exceed 16 MiB bound`);
      }
      prepared.push({ relPath, buf });
    }
    return prepared;
  }

  function writePreparedStagedFiles(jobId, prepared) {
    const stageRoot = stagedInputDir(jobId);
    rmSync(stageRoot, { recursive: true, force: true });
    if (!prepared || prepared.length === 0) return;
    const inputsRoot = resolve(stateDir, "job-inputs");
    mkdirSync(inputsRoot, { recursive: true });
    const stageTmp = `${stageRoot}.tmp.${process.pid}.${Date.now()}`;
    rmSync(stageTmp, { recursive: true, force: true });
    try {
      mkdirSync(stageTmp, { recursive: true });
      const realTmpRoot = realpathSync(stageTmp);
      for (const { relPath, buf } of prepared) {
        const dest = resolve(stageTmp, relPath);
        if (!dest.startsWith(resolve(stageTmp) + sep)) {
          throw new ExecutorError(`job ${jobId} staged input escaped staging boundary`);
        }
        const parent = dirname(dest);
        mkdirSync(parent, { recursive: true });
        const realParent = realpathSync(parent);
        if (realParent !== realTmpRoot && !realParent.startsWith(realTmpRoot + sep)) {
          throw new ExecutorError(`job ${jobId} staged input parent resolved outside staging directory`);
        }
        writeFileSync(dest, buf);
      }
      renameSync(stageTmp, stageRoot);
    } catch (e) {
      rmSync(stageTmp, { recursive: true, force: true });
      if (e instanceof ExecutorError) throw e;
      throw new ExecutorError(`job ${jobId} failed staging input files (${e.code ?? "fs"}): ${e.message}`);
    }
  }

  function removeStagedInputDir(jobId) {
    rmSync(stagedInputDir(jobId), { recursive: true, force: true });
  }

  // One disposable, image-owned output volume per job attempt: a fresh volume
  // mounts over the image's /job/output and initializes from it (uid 999).
  function outputVolumeName(jobId) {
    return `aegispi-job-out-${jobId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 72)}`;
  }

  // Copy the container's evidence out BEFORE the container is removed; the
  // volume goes away with it. Best effort by design: a job that destroyed
  // its own evidence keeps the container's exit code as the surviving fact.
  function collectOutput(containerId, hostOutputDir) {
    return docker(dockerBin, ["cp", `${containerId}:/job/output/.`, hostOutputDir], { capture: true });
  }

  function removeOutputVolume(jobId) {
    docker(dockerBin, ["volume", "rm", "-f", outputVolumeName(jobId)]);
  }

  // Shared launch path: write the manifest, run the container, record the
  // sidecar. The row must already exist (QUEUED) — submitJob creates it,
  // tick relaunches persisted rows.
  function launchExisting({ jobId, taskId, attemptId, fence, manifest, now }) {
    const dir = jobDir(jobId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "input"), { recursive: true });
    mkdirSync(join(dir, "output"), { recursive: true });
    const stageRoot = stagedInputDir(jobId);
    if (existsSync(stageRoot)) {
      cpSync(stageRoot, join(dir, "input"), { recursive: true, dereference: false });
    }
    writeFileSync(join(dir, "input", "manifest.json"), JSON.stringify(manifest) + "\n", "utf8");
    const containerName = `aegispi-job-${jobId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80)}`;
    const volume = outputVolumeName(jobId);
    // A retry must not inherit a previous attempt's evidence directory.
    docker(dockerBin, ["volume", "rm", "-f", volume]);
    const run = docker(dockerBin, [
      "run",
      "--detach",
      "--name", containerName,
      "--network", network,
      // --init: tini becomes PID 1 and reaps orphaned zombies + forwards
      // signals. Without it the runner-as-PID-1 cannot wait() for children
      // the JOB abandons, and a job that spawns-and-kills fills the pids
      // budget with zombies, blocking every later spawn (measured by the
      // escape battery). Docker bundles tini; no new dependency.
      "--init",
      "--cpus", String(quotas.cpus),
      "--memory", String(quotas.memory),
      // memory-swap == memory: NO swap for the job container, or an
      // allocation storm pages out to swap and outlives its deadline.
      "--memory-swap", String(quotas.memory),
      "--pids-limit", String(quotas.pids),
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      // The work dir is a tmpfs whose WRITABILITY is declared by the mount
      // contract (mode=1777), not inherited from the image or the host: a
      // pre-existing image directory would otherwise give the tmpfs root
      // root:root 0755 and the image user EACCES (measured). noexec stays:
      // the tmpfs holds data, never executables.
      "--tmpfs", `/job/work:rw,noexec,size=${quotas.tmpfsSize},mode=1777`,
      "-v", `${join(dir, "input")}:/job/input:ro`,
      // The output is an image-owned volume (audit F2): the image's
      // /job/output (uid 999) initializes a fresh volume, so the mount is
      // writable by the image user on ANY engine regardless of host umask.
      "--mount", `type=volume,src=${volume},dst=/job/output`,
      imageRef,
    ], { capture: true });
    if (run.code !== 0) {
      throw new ExecutorError(`docker run failed for ${jobId}: ${run.out.slice(0, 300)}`);
    }
    const containerId = run.out.split("\n").pop().trim();
    // The sidecar records "container:<id>" so the pid-based reaper never
    // mistakes a container id for a process id.
    try {
      startJob(db, { stateDir, jobId, pid: `container:${containerId}`, now });
    } catch (e) {
      // Never leave a detached container unowned: kill what we started.
      docker(dockerBin, ["kill", containerId]);
      docker(dockerBin, ["rm", "-f", containerId]);
      removeOutputVolume(jobId);
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    writeAudit(db, {
      code: "container_job_launched",
      taskId,
      details: { job_id: jobId, container: containerId, image: imageRef, quotas, network, output: "image-owned-volume" },
      now,
    });
    return { jobId, containerId, containerName };
  }

  // Submit a NEW offline job: durable intent first (manifest and oracle are
  // content-addressed OBJECTS per 06 section 2 — "manifest与oracle指向
  // objects"), then the launch.
  //
  // The oracle is REQUIRED (02 section 5, re-review P1): the container exit
  // code is evidence, never the business conclusion, so a job without a
  // host-authored acceptance definition has nothing the host could verify
  // success against and is refused before anything runs. The definition is
  // validated at this boundary and stored as a content-addressed object the
  // job can never touch.
  function submitJob({ jobId, taskId, attemptId, fence, manifest, oracle, deadlineAt, now, inputFiles = null }) {
    const task = db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(taskId);
    if (!task) {
      throw new ExecutorError(`task ${taskId} not found; an offline job belongs to a task`);
    }
    if (oracle === undefined || oracle === null) {
      throw new ExecutorError(
        `job ${jobId} has no oracle: an offline job requires a host-authored acceptance definition (02 section 5); the exit code alone is evidence, never success`,
      );
    }
    try {
      validateJobOracle(oracle);
    } catch (e) {
      throw new ExecutorError(`job ${jobId} oracle is not a valid acceptance definition: ${e.message}`);
    }
    safeJobDirName(jobId);
    stagedInputDir(jobId);
    const preparedInputs = prepareStagedInputFiles(jobId, inputFiles);
    const manifestObject = insertObjectRow(db, {
      scopeId: task.scope_id,
      kind: "job_manifest",
      sourceUri: `job:${jobId}`,
      sourceActor: "host-executor",
      content: JSON.stringify(manifest),
      observedAt: now,
      requiredScopeIds: [task.scope_id],
    });
    // The acceptance definition must be READABLE at finish time: store the
    // content-addressed bytes and bind the row to them (a hash-only row
    // would leave the host nothing to compare against).
    const storedOracle = putObjectContent(stateDir, JSON.stringify(oracle));
    const oracleObject = insertObjectRow(db, {
      scopeId: task.scope_id,
      kind: "job_oracle",
      sourceUri: `job:${jobId}`,
      sourceActor: "host-executor",
      contentHash: storedOracle.contentHash,
      storageRef: storedOracle.storageRef,
      observedAt: now,
      requiredScopeIds: [task.scope_id],
    });
    createJob(db, {
      id: jobId,
      taskId,
      attemptId,
      fence,
      manifestObjectId: manifestObject.id,
      oracleObjectId: oracleObject.id,
      deadlineAt,
      now,
    });
    writePreparedStagedFiles(jobId, preparedInputs);
    const launched = launchExisting({ jobId, taskId, attemptId, fence, manifest, now });
    return { jobId, state: "RUNNING", ...launched };
  }

  function containerIdOf(jobId) {
    const sidecar = join(jobsDir, jobPidFileName(jobId));
    if (!existsSync(sidecar)) return null;
    const content = readFileSync(sidecar, "utf8").trim();
    if (!content.startsWith("container:")) return null;
    return content.slice("container:".length);
  }

  function markCancelledJob({ jobId, now }) {
    return withTx(db, () => {
      const changed = db
        .prepare("UPDATE execution_jobs SET state='CANCELLED', ended_at=? WHERE id=? AND state IN ('QUEUED','RUNNING')")
        .run(now, jobId).changes;
      if (changed !== 1) {
        throw new ExecutorError(`job ${jobId} is not QUEUED/RUNNING; cannot cancel`);
      }
      writeAudit(db, { code: "job_cancelled", details: { job_id: jobId }, now });
      return { jobId, state: "CANCELLED" };
    });
  }

  function cancelJob({ jobId, now }) {
    const out = markCancelledJob({ jobId, now });
    const containerId = containerIdOf(jobId);
    if (containerId) {
      // docker stop gives the runner a SIGTERM grace so it can record the
      // cancellation; the -f fallback is for jobs that trap SIGTERM.
      docker(dockerBin, ["stop", "--time", "5", containerId]);
      docker(dockerBin, ["rm", "-f", containerId]);
    }
    cleanupTerminalJobArtifacts(jobId);
    return out;
  }

  function cleanupTerminalJobArtifacts(jobId) {
    removeOutputVolume(jobId);
    removeStagedInputDir(jobId);
    rmSync(join(jobDir(jobId), "input"), { recursive: true, force: true });
    rmSync(join(jobsDir, jobPidFileName(jobId)), { force: true });
  }

  // Poll RUNNING jobs once: collect finished ones, enforce host-side
  // deadlines, map the container's evidence to execution_jobs states.
  function pollOnce({ now }) {
    const rows = db.prepare("SELECT * FROM execution_jobs WHERE state='RUNNING'").all();
    const events = [];
    for (const job of rows) {
      const containerId = containerIdOf(job.id);
      if (!containerId) {
        // A RUNNING row without a container sidecar is a pid-era orphan;
        // the legacy reaper owns it.
        continue;
      }
      const inspect = docker(dockerBin, ["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", containerId], { capture: true });
      if (inspect.code !== 0) {
        // Container vanished (daemon restart wiped it): LOST, on the record.
        withTx(db, () => {
          const changed = db
            .prepare("UPDATE execution_jobs SET state='LOST', ended_at=?, exit_code=NULL WHERE id=? AND state='RUNNING'")
            .run(now, job.id).changes;
          if (changed === 1) {
            writeAudit(db, { code: "container_job_lost", details: { job_id: job.id, container: containerId }, now });
          }
        });
        cleanupTerminalJobArtifacts(job.id);
        events.push({ jobId: job.id, state: "LOST" });
        continue;
      }
      const [running, exitCodeStr] = inspect.out.split(" ");
      if (running === "true") {
        if (now >= job.deadline_at) {
          // HOST-enforced deadline: the job cannot outlive its window by
          // killing or lying to the in-container runner. Evidence written
          // before the kill is still collected best effort.
          docker(dockerBin, ["kill", containerId]);
          markTimedOutJob(db, { jobId: job.id, now });
          collectOutput(containerId, join(jobDir(job.id), "output"));
          docker(dockerBin, ["rm", "-f", containerId]);
          cleanupTerminalJobArtifacts(job.id);
          events.push({ jobId: job.id, state: "TIMED_OUT", hostEnforced: true });
        }
        continue;
      }
      // Exited: collect the runner's evidence from the volume BEFORE the
      // container goes away. From here the HOST decides by its own rules
      // (02 section 5): result.json fields are evidence INPUTS, never state
      // decisions — a job that forges timedOut/cancelled/signal in its own
      // output only changes its own evidence file, never the terminal state
      // (re-review P1). The trusted facts are the container exit code
      // (daemon-reported, not job-reported) and the runner's documented exit
      // conventions: 124 deadline, 125 cancelled, 126 invalid manifest,
      // 137 child died by signal.
      const exitCode = Number(exitCodeStr);
      collectOutput(containerId, join(jobDir(job.id), "output"));
      docker(dockerBin, ["rm", "-f", containerId]);
      cleanupTerminalJobArtifacts(job.id);
      if (exitCode === 124) {
        markTimedOutJob(db, { jobId: job.id, now });
        events.push({ jobId: job.id, state: "TIMED_OUT", exitCode });
        continue;
      }
      if (exitCode === 125) {
        withTx(db, () => {
          db.prepare("UPDATE execution_jobs SET state='CANCELLED', ended_at=?, exit_code=? WHERE id=? AND state='RUNNING'")
            .run(now, exitCode, job.id);
          writeAudit(db, { code: "container_job_cancel_completed", details: { job_id: job.id, exit_code: exitCode }, now });
        });
        events.push({ jobId: job.id, state: "CANCELLED", exitCode });
        continue;
      }
      if (exitCode === 126) {
        withTx(db, () => {
          db.prepare("UPDATE execution_jobs SET state='FAILED', ended_at=?, exit_code=126 WHERE id=? AND state='RUNNING'")
            .run(now, job.id);
          writeAudit(db, { code: "container_job_refused_manifest", details: { job_id: job.id }, now });
        });
        events.push({ jobId: job.id, state: "FAILED", exitCode: 126 });
        continue;
      }
      if (exitCode !== 0) {
        finishJob(db, { jobId: job.id, exitCode, state: "FAILED", now });
        events.push({ jobId: job.id, state: "FAILED", exitCode });
        continue;
      }
      // Container exit 0: success exists only after the host compares the
      // bound acceptance definition (02 section 5 — the exit code alone is
      // evidence, never the conclusion). An unreadable oracle refuses
      // success rather than guessing.
      const oracle = loadJobOracleContent(db, stateDir, job.oracle_object_id);
      const stdoutPath = join(jobDir(job.id), "output", "stdout.txt");
      const stdoutBytes = existsSync(stdoutPath) ? readFileSync(stdoutPath) : null;
      const verdict = oracle === null ? null : evaluateJobOracle(oracle, { containerExitCode: exitCode, stdoutBytes });
      if (verdict === null) {
        writeAudit(db, {
          code: "job_oracle_mismatch",
          taskId: job.task_id,
          details: { job_id: job.id, failure: "the bound oracle content is unreadable or malformed; success is refused", exit_code: 0 },
          now,
        });
        finishJob(db, { jobId: job.id, exitCode, state: "FAILED", now });
        events.push({ jobId: job.id, state: "FAILED", exitCode, reason: "oracle_unreadable" });
        continue;
      }
      if (verdict.ok) {
        finishJob(db, { jobId: job.id, exitCode, state: "SUCCEEDED", now });
        events.push({ jobId: job.id, state: "SUCCEEDED", exitCode });
      } else {
        writeAudit(db, {
          code: "job_oracle_mismatch",
          taskId: job.task_id,
          details: {
            job_id: job.id,
            failure: `assertion(s) ${verdict.failedIds.join(", ")} do not hold against the collected evidence`,
            exit_code: 0,
            checked: verdict.checkedIds,
          },
          now,
        });
        finishJob(db, { jobId: job.id, exitCode, state: "FAILED", now });
        events.push({ jobId: job.id, state: "FAILED", exitCode, reason: "oracle_mismatch" });
      }
    }
    return events;
  }

  // Launch QUEUED jobs up to the machine-wide concurrency, then poll.
  // allowLaunch=false keeps polling and reaping but launches nothing (the
  // disk watermark's "warn" stance: no NEW workspace on a tight disk).
  function tick({ now, allowLaunch = true }) {
    const events = pollOnce({ now });
    if (!allowLaunch) {
      return events;
    }
    const running = db.prepare("SELECT count(*) c FROM execution_jobs WHERE state='RUNNING'").get().c;
    const capacity = Math.max(0, machineWideMax - running);
    if (capacity > 0) {
      const queued = db
        .prepare("SELECT * FROM execution_jobs WHERE state='QUEUED' ORDER BY created_at LIMIT ?")
        .all(capacity);
      for (const job of queued) {
        // A QUEUED row without a persisted manifest cannot be launched; it
        // stays durable and a human sees the audit line.
        const dir = jobDir(job.id);
        const manifestPath = join(dir, "input", "manifest.json");
        if (!existsSync(manifestPath)) {
          writeAudit(db, {
            code: "container_job_unlaunchable",
            details: { job_id: job.id, reason: "no manifest file for this QUEUED row" },
            now,
          });
          continue;
        }
        try {
          launchExisting({
            jobId: job.id,
            taskId: job.task_id,
            attemptId: job.attempt_id,
            fence: job.fence,
            manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
            now,
          });
        } catch (e) {
          writeAudit(db, {
            code: "container_job_launch_failed",
            details: { job_id: job.id, error: e.message.slice(0, 200) },
            now,
          });
        }
      }
    }
    return events;
  }

  // Startup: every RUNNING container job has no trusted completion record —
  // kill the container, mark LOST (06 section 9: "无可信完成记录置LOST；杀孤
  // 儿容器"). Only rows this executor owns (container sidecars).
  function reapOrphanContainers({ now, kill = true }) {
    const rows = db.prepare("SELECT id FROM execution_jobs WHERE state='RUNNING'").all();
    const reaped = [];
    for (const r of rows) {
      const containerId = containerIdOf(r.id);
      if (!containerId) continue;
      let killed = false;
      if (kill) {
        const k = docker(dockerBin, ["kill", containerId]);
        killed = k.code === 0;
        docker(dockerBin, ["rm", "-f", containerId]);
      }
      cleanupTerminalJobArtifacts(r.id);
      withTx(db, () => {
        const changed = db
          .prepare("UPDATE execution_jobs SET state='LOST', ended_at=?, exit_code=NULL WHERE id=? AND state='RUNNING'")
          .run(now, r.id).changes;
        if (changed === 1) {
          writeAudit(db, {
            code: "container_orphan_killed",
            details: { job_id: r.id, container: containerId, killed },
            now,
          });
          reaped.push({ jobId: r.id, container: containerId, killedOrphan: killed });
        }
      });
    }
    return reaped;
  }

  return {
    imageRef,
    quotas,
    network,
    submitJob,
    cancelJob,
    pollOnce,
    tick,
    reapOrphanContainers,
  };
}

export function safeTaskDirComponent(taskId) {
  const raw = String(taskId ?? "");
  if (raw.length === 0) {
    throw new ExecutorError("taskId must be a non-empty string");
  }
  const prefix = raw.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "").slice(0, 28) || "task";
  const hash = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  return `${prefix}_${hash}`;
}

export function agentWorkAttemptDir(stateDir, taskId, attemptNo) {
  const n = Number(attemptNo);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ExecutorError(`attemptNo must be a positive integer, got ${JSON.stringify(attemptNo)}`);
  }
  const workRoot = resolve(stateDir, "agent-work");
  const target = resolve(workRoot, safeTaskDirComponent(taskId), String(n));
  if (!target.startsWith(workRoot + sep)) {
    throw new ExecutorError(`agentWorkAttemptDir escaped agent-work boundary: ${target}`);
  }
  return target;
}

function currentWindowsAccount() {
  const who = spawnSync("whoami", { encoding: "utf8", shell: false });
  const account = who.status === 0 && who.stdout.trim()
    ? who.stdout.trim()
    : (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME);
  if (!account) {
    throw new ExecutorError("cannot resolve current Windows account to lock host directory");
  }
  return account;
}

function parseIcaclsEntries(raw, dirPath) {
  const entries = [];
  const prefixLower = dirPath.toLowerCase();
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^Successfully processed\b/i.test(trimmed) || /^No mapping\b/i.test(trimmed)) {
      continue;
    }
    let acePart = trimmed;
    if (trimmed.toLowerCase().startsWith(prefixLower)) {
      acePart = trimmed.slice(dirPath.length).trim();
    }
    const colonIdx = acePart.indexOf(":");
    if (colonIdx <= 0) continue;
    const principal = acePart.slice(0, colonIdx).trim();
    const perms = acePart.slice(colonIdx + 1).trim();
    entries.push({ principal, perms });
  }
  return entries;
}

export function lockHostProposalsDir(proposalsDir) {
  mkdirSync(proposalsDir, { recursive: true });
  if (process.platform === "win32") {
    const account = currentWindowsAccount();
    const disableInherit = spawnSync("icacls", [proposalsDir, "/inheritance:r"], { encoding: "utf8", shell: false });
    if (disableInherit.status !== 0) {
      throw new ExecutorError(`icacls /inheritance:r failed on ${proposalsDir}: ${(disableInherit.stderr || disableInherit.stdout || "").trim()}`);
    }
    const before = spawnSync("icacls", [proposalsDir], { encoding: "utf8", shell: false });
    if (before.status === 0) {
      const seen = new Set();
      for (const entry of parseIcaclsEntries(before.stdout, proposalsDir)) {
        if (entry.principal.toLowerCase() !== account.toLowerCase() && !seen.has(entry.principal.toLowerCase())) {
          seen.add(entry.principal.toLowerCase());
          spawnSync("icacls", [proposalsDir, "/remove", entry.principal], { encoding: "utf8", shell: false });
        }
      }
    }
    spawnSync("icacls", [proposalsDir, "/remove:d", account], { encoding: "utf8", shell: false });
    const grant = spawnSync(
      "icacls",
      [proposalsDir, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`],
      { encoding: "utf8", shell: false },
    );
    if (grant.status !== 0) {
      throw new ExecutorError(`icacls lockdown failed on ${proposalsDir}: ${(grant.stderr || grant.stdout || "").trim()}`);
    }
    const verify = inspectHostProposalsAcl(proposalsDir);
    if (!verify.ok) {
      throw new ExecutorError(`host proposals directory ACL verification failed on ${proposalsDir}: ${verify.reason}`);
    }
    return { platform: "win32", account, aclText: verify.raw };
  }
  chmodSync(proposalsDir, 0o770);
  return { platform: process.platform, mode: "0770" };
}

export function inspectHostProposalsAcl(proposalsDir) {
  if (process.platform !== "win32") {
    try {
      const mode = statSync(proposalsDir).mode & 0o1777;
      if ((mode & 0o007) !== 0) {
        return {
          ok: false,
          platform: process.platform,
          reason: `proposals dir mode ${mode.toString(8)} grants other-user access`,
          raw: mode.toString(8),
        };
      }
      return { ok: true, platform: process.platform, raw: mode.toString(8) };
    } catch (e) {
      return { ok: false, platform: process.platform, reason: `stat failed: ${e.message}`, raw: "" };
    }
  }
  const account = currentWindowsAccount();
  const r = spawnSync("icacls", [proposalsDir], { encoding: "utf8", shell: false });
  const raw = (r.stdout ?? "") + (r.stderr ?? "");
  if (r.status !== 0) {
    return { ok: false, reason: `icacls read failed: ${raw.trim()}`, raw };
  }
  const entries = parseIcaclsEntries(raw, proposalsDir);
  if (entries.length === 0) {
    return { ok: false, reason: "no parsable ACL entries found", raw };
  }
  let hasDaemonAllow = false;
  for (const { principal, perms } of entries) {
    if (/\(N\)/i.test(perms) || /\bDENY\b/i.test(perms) || /\(D,/i.test(perms) || /,D\)/i.test(perms)) {
      return { ok: false, reason: `deny ACE present for ${principal}: ${perms}`, raw };
    }
    if (principal.toLowerCase() !== account.toLowerCase()) {
      return { ok: false, reason: `unexpected principal ${principal} present in ACL`, raw };
    }
    if (/\(F\)/i.test(perms)) {
      hasDaemonAllow = true;
    }
  }
  if (!hasDaemonAllow) {
    return { ok: false, reason: `daemon account ${account} lacks full-control allow ACE`, raw };
  }
  return { ok: true, platform: "win32", account: account.toLowerCase(), raw };
}

// Production agent attempt launcher (parallel to createContainerExecutor for --execution-image, ADR-0001 §2 & §9).
export function createAgentLauncher(db, {
  stateDir,
  imageRef,
  quotas = { cpus: 1, memory: "1g", pids: 256, tmpfsSize: "2g" },
  dockerBin = "docker",
  network = "none",
}) {
  if (typeof imageRef !== "string" || !/@sha256:[0-9a-f]{64}$/.test(imageRef)) {
    throw new ExecutorError(
      `agent image must be digest-pinned, got ${imageRef}; a floating tag is never an isolation reference`,
    );
  }

  function containerNameFor(taskId, attemptNo) {
    return `aegispi-agent-${safeTaskDirComponent(taskId)}-${attemptNo}`.slice(0, 90);
  }

  function launchAttempt({ taskId, attemptId, attemptNo, fence, scopeDomainKey, modelRequest = null, now = Date.now() }) {
    const attemptDir = agentWorkAttemptDir(stateDir, taskId, attemptNo);
    const proposalsDir = join(attemptDir, "proposals");
    const commandsDir = join(attemptDir, "host-commands");
    const contextPath = join(attemptDir, "context.json");
    rmSync(attemptDir, { recursive: true, force: true });
    lockHostProposalsDir(attemptDir);
    mkdirSync(commandsDir, { recursive: true });
    lockHostProposalsDir(proposalsDir);
    const context = {
      schemaVersion: 1,
      taskId,
      attemptId,
      fence,
      scopeDomainKey,
      ...(modelRequest ? { modelRequest } : {}),
    };
    writeFileSync(contextPath, JSON.stringify(context) + "\n", "utf8");

    const containerName = containerNameFor(taskId, attemptNo);
    docker(dockerBin, ["rm", "-f", containerName]);
    const run = docker(dockerBin, [
      "run",
      "--detach",
      "--name", containerName,
      "--label", "aegispi.role=agent",
      "--label", `aegispi.state_dir=${resolve(stateDir)}`,
      "--label", `aegispi.task_id=${taskId}`,
      "--label", `aegispi.attempt_no=${attemptNo}`,
      "--network", network,
      "--init",
      "--cpus", String(quotas.cpus),
      "--memory", String(quotas.memory),
      "--memory-swap", String(quotas.memory),
      "--pids-limit", String(quotas.pids),
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,noexec,size=64m,mode=1777",
      "-v", `${proposalsDir}:/agent-work/proposals:rw`,
      "-v", `${commandsDir}:/agent-work/host-commands:ro`,
      "-v", `${contextPath}:/agent-work/context.json:ro`,
      imageRef,
    ], { capture: true });
    if (run.code !== 0) {
      throw new ExecutorError(`docker run agent failed for ${taskId}#${attemptNo}: ${run.out.slice(0, 300)}`);
    }
    const containerId = run.out.split("\n").pop().trim();
    try {
      writeAudit(db, {
        code: "agent_container_launched",
        taskId,
        details: { attempt_id: attemptId, attempt_no: attemptNo, fence, container: containerId, image: imageRef, network },
        now,
      });
    } catch (e) {
      stopAttempt({ containerId, commandsDir });
      throw e;
    }
    return { containerId, containerName, attemptDir, proposalsDir, commandsDir, contextPath };
  }

  function stopAttempt({ containerId, commandsDir }) {
    if (commandsDir && existsSync(commandsDir)) {
      writeFileSync(join(commandsDir, "stop"), "stop\n", "utf8");
    }
    if (containerId) {
      docker(dockerBin, ["stop", "--time", "3", containerId]);
      docker(dockerBin, ["rm", "-f", containerId]);
    }
  }

  function inspectContainer(containerId) {
    const insp = docker(dockerBin, ["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", containerId], { capture: true });
    if (insp.code !== 0) return { exists: false, running: false, exitCode: null };
    const [running, exitCode] = insp.out.split(" ");
    return { exists: true, running: running === "true", exitCode: Number(exitCode) };
  }

  function reapOrphanContainers({ activeIds = new Set() } = {}) {
    const listed = docker(dockerBin, [
      "ps", "-aq",
      "--filter", "label=aegispi.role=agent",
      "--filter", `label=aegispi.state_dir=${resolve(stateDir)}`,
    ], { capture: true });
    if (listed.code !== 0 || !listed.out) return [];
    const reaped = [];
    for (const id of listed.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (activeIds.has(id)) continue;
      docker(dockerBin, ["stop", "--time", "2", id]);
      docker(dockerBin, ["rm", "-f", id]);
      reaped.push(id);
    }
    return reaped;
  }

  return {
    imageRef,
    quotas,
    network,
    launchAttempt,
    stopAttempt,
    inspectContainer,
    reapOrphanContainers,
  };
}

export function createAcquisitionLauncher(db, {
  stateDir,
  imageRef,
  quotas = { cpus: 1, memory: "512m", pids: 128 },
  dockerBin = "docker",
  network = "bridge",
  enableHostGateway = false,
}) {
  if (typeof imageRef !== "string" || !/@sha256:[0-9a-f]{64}$/.test(imageRef)) {
    throw new ExecutorError(
      `acquisition image must be digest-pinned, got ${imageRef}; a floating tag is never an isolation reference`,
    );
  }

  async function runPlan({ jobKey, taskId, plan, timeoutMs = 30000, onProgress = null, progressIntervalMs = 5000 }) {
    const safeKey = safeTaskDirComponent(jobKey);
    const workDir = join(stateDir, "acquisitions", safeKey);
    const planDir = join(workDir, "plan");
    const downloadsDir = join(workDir, "downloads");
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(planDir, { recursive: true });
    mkdirSync(downloadsDir, { recursive: true });
    writeFileSync(join(planDir, "plan.json"), JSON.stringify(plan) + "\n", "utf8");

    const containerName = `aegispi-acq-${safeKey}`.slice(0, 90);
    const volume = `aegispi-acq-out-${safeKey}`.slice(0, 90);
    docker(dockerBin, ["rm", "-f", containerName]);
    docker(dockerBin, ["volume", "rm", "-f", volume]);

    const args = [
      "run",
      "--detach",
      "--name", containerName,
      "--label", "aegispi.role=acquisition",
      "--label", `aegispi.state_dir=${resolve(stateDir)}`,
      "--label", `aegispi.task_id=${taskId}`,
      "--network", network,
      ...(enableHostGateway ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      "--init",
      "--cpus", String(quotas.cpus),
      "--memory", String(quotas.memory),
      "--memory-swap", String(quotas.memory),
      "--pids-limit", String(quotas.pids),
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "-v", `${planDir}:/plan:ro`,
      "--mount", `type=volume,src=${volume},dst=/downloads`,
      imageRef,
    ];
    const launched = docker(dockerBin, args, { capture: true });
    if (launched.code !== 0) {
      docker(dockerBin, ["volume", "rm", "-f", volume]);
      rmSync(workDir, { recursive: true, force: true });
      throw new ExecutorError(`docker run acquisition failed for ${jobKey}: ${launched.out.slice(0, 300)}`);
    }
    const containerId = launched.out.split("\n").pop().trim();
    let exitCode = null;
    let timedOut = false;
    let lastProgressAt = Date.now();
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const insp = docker(dockerBin, ["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", containerId], { capture: true });
        if (insp.code !== 0) break;
        const [running, codeStr] = insp.out.split(" ");
        if (running !== "true") {
          exitCode = Number(codeStr);
          break;
        }
        if (Date.now() >= deadline) {
          timedOut = true;
          docker(dockerBin, ["kill", containerId]);
          exitCode = 124;
          break;
        }
        if (onProgress && Date.now() - lastProgressAt >= progressIntervalMs) {
          lastProgressAt = Date.now();
          try {
            onProgress();
          } catch (e) {
            if (e?.name === "StaleWorker") {
              docker(dockerBin, ["kill", containerId]);
              exitCode = 125;
              break;
            }
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      docker(dockerBin, ["cp", `${containerId}:/downloads/.`, downloadsDir], { capture: true });
    } finally {
      docker(dockerBin, ["rm", "-f", containerId]);
      docker(dockerBin, ["volume", "rm", "-f", volume]);
    }
    let report = null;
    const reportPath = join(downloadsDir, "report.json");
    if (existsSync(reportPath)) {
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch {}
    }
    return { exitCode, timedOut, report, downloadsDir, workDir };
  }

  function reapOrphanContainers() {
    const listed = docker(dockerBin, [
      "ps", "-aq",
      "--filter", "label=aegispi.role=acquisition",
      "--filter", `label=aegispi.state_dir=${resolve(stateDir)}`,
    ], { capture: true });
    if (listed.code !== 0 || !listed.out) return [];
    const reaped = [];
    for (const id of listed.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      docker(dockerBin, ["kill", id]);
      docker(dockerBin, ["rm", "-f", id]);
      reaped.push(id);
    }
    return reaped;
  }

  return { imageRef, quotas, network, runPlan, reapOrphanContainers };
}
