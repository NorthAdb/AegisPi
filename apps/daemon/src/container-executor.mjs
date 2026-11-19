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
// Container sidecars are stored with a "container:" prefix so the legacy
// pid-based reaper ignores them and this module owns their lifecycle.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withTx } from "./db/tx.mjs";
import { writeAudit } from "./audit.mjs";
import { insertObjectRow } from "./objects.mjs";
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

  function jobDir(jobId) {
    return join(jobsDir, jobId.replace(/[^A-Za-z0-9._-]/g, "_"));
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
  function submitJob({ jobId, taskId, attemptId, fence, manifest, oracle, deadlineAt, now }) {
    const task = db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(taskId);
    if (!task) {
      throw new ExecutorError(`task ${taskId} not found; an offline job belongs to a task`);
    }
    const manifestObject = insertObjectRow(db, {
      scopeId: task.scope_id,
      kind: "job_manifest",
      sourceUri: `job:${jobId}`,
      sourceActor: "host-executor",
      content: JSON.stringify(manifest),
      observedAt: now,
      requiredScopeIds: [task.scope_id],
    });
    const oracleObject = insertObjectRow(db, {
      scopeId: task.scope_id,
      kind: "job_oracle",
      sourceUri: `job:${jobId}`,
      sourceActor: "host-executor",
      content: JSON.stringify(oracle ?? {
        schemaVersion: 1,
        verdict: "exit-code-evidence-only",
        note: "the exit code is evidence, never the Task conclusion (06 section 2)",
      }),
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
      removeOutputVolume(jobId);
      rmSync(join(jobsDir, jobPidFileName(jobId)), { force: true });
    }
    return out;
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
        rmSync(join(jobsDir, jobPidFileName(job.id)), { force: true });
        removeOutputVolume(job.id);
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
          removeOutputVolume(job.id);
          rmSync(join(jobsDir, jobPidFileName(job.id)), { force: true });
          events.push({ jobId: job.id, state: "TIMED_OUT", hostEnforced: true });
        }
        continue;
      }
      // Exited: collect the runner's evidence from the volume BEFORE the
      // container goes away, then decide by OUR rules. A null exitCode with
      // a signal is a killed child (OOM, pid-limit) — a FAILED job even when
      // the runner itself exited cleanly after recording it.
      const exitCode = Number(exitCodeStr);
      collectOutput(containerId, join(jobDir(job.id), "output"));
      docker(dockerBin, ["rm", "-f", containerId]);
      removeOutputVolume(job.id);
      rmSync(join(jobsDir, jobPidFileName(job.id)), { force: true });
      const resultPath = join(jobDir(job.id), "output", "result.json");
      let evidence = null;
      if (existsSync(resultPath)) {
        try {
          evidence = JSON.parse(readFileSync(resultPath, "utf8"));
        } catch {}
      }
      if (exitCode === 124 || evidence?.timedOut === true) {
        markTimedOutJob(db, { jobId: job.id, now });
        events.push({ jobId: job.id, state: "TIMED_OUT", exitCode });
        continue;
      }
      if (exitCode === 125 || evidence?.cancelled === true) {
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
      if (evidence && evidence.exitCode === null && evidence.signal) {
        withTx(db, () => {
          db.prepare("UPDATE execution_jobs SET state='FAILED', ended_at=?, exit_code=NULL WHERE id=? AND state='RUNNING'")
            .run(now, job.id);
          writeAudit(db, {
            code: "container_job_child_killed_by_signal",
            details: { job_id: job.id, signal: evidence.signal, container_exit: exitCode },
            now,
          });
        });
        events.push({ jobId: job.id, state: "FAILED", signal: evidence.signal });
        continue;
      }
      finishJob(db, { jobId: job.id, exitCode, now });
      events.push({ jobId: job.id, state: exitCode === 0 ? "SUCCEEDED" : "FAILED", exitCode });
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
      removeOutputVolume(r.id);
      rmSync(join(jobsDir, jobPidFileName(r.id)), { force: true });
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
