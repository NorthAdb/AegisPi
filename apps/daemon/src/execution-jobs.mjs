// Offline execution jobs per 06 sections 2 and 9. A job is a manifest/oracle
// driven offline command; its exit code is EVIDENCE, never a Task conclusion
// (06 section 2: "退出码不是Task结论"). Recovery semantics: a RUNNING job with
// no trusted completion record is LOST and its orphan process is killed;
// the owning task re-does any read-only verification it needs.

import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { escapeComponent } from "./keys.mjs";
import { isPidAlive } from "./db/lock.mjs";

export class JobError extends Error {}

// Job ids are natural keys with ':' separators; Windows forbids ':' in file
// names, so sidecars use a sanitized form (lossless enough for recovery: it
// is derived from the id deterministically).
export function jobPidFileName(jobId) {
  return `${jobId.replace(/[^A-Za-z0-9._-]/g, "_")}.pid`;
}

export function jobIdFor(taskId, fence, label) {
  return `job:${escapeComponent(taskId, { allowSlash: true })}:${fence}:${escapeComponent(label)}`;
}

export function createJob(db, { id, taskId, attemptId, fence, manifestObjectId, oracleObjectId, deadlineAt, now }) {
  return withTx(db, () => {
    db.prepare(
      `INSERT INTO execution_jobs(id, task_id, attempt_id, fence, manifest_object_id, oracle_object_id,
        state, deadline_at, exit_code, artifact_object_id, created_at, ended_at)
       VALUES (?,?,?,?,?,?, 'QUEUED', ?, NULL, NULL, ?, NULL)`,
    ).run(id, taskId, attemptId, fence, manifestObjectId, oracleObjectId, deadlineAt, now);
    writeAudit(db, { code: "job_created", taskId, details: { job_id: id, deadline_at: deadlineAt }, now });
    return { id, state: "QUEUED" };
  });
}

export function startJob(db, { stateDir, jobId, pid, now }) {
  const jobsDir = join(stateDir, "jobs");
  mkdirSync(jobsDir, { recursive: true });
  const pidFile = join(jobsDir, jobPidFileName(jobId));
  if (existsSync(pidFile)) {
    throw new JobError(`job ${jobId} already has a pid sidecar`);
  }
  writeFileSync(pidFile, String(pid), "utf8");
  return withTx(db, () => {
    const changed = db
      .prepare("UPDATE execution_jobs SET state='RUNNING' WHERE id=? AND state='QUEUED'")
      .run(jobId).changes;
    if (changed !== 1) {
      rmSync(pidFile, { force: true });
      throw new JobError(`job ${jobId} is not QUEUED`);
    }
    writeAudit(db, { code: "job_started", details: { job_id: jobId, pid }, now });
    return { jobId, state: "RUNNING", pid };
  });
}

export function finishJob(db, { jobId, exitCode, artifactObjectId = null, now }) {
  return withTx(db, () => {
    const changed = db
      .prepare(
        "UPDATE execution_jobs SET state=?, exit_code=?, artifact_object_id=?, ended_at=? WHERE id=? AND state='RUNNING'",
      )
      .run(exitCode === 0 ? "SUCCEEDED" : "FAILED", exitCode, artifactObjectId, now, jobId).changes;
    if (changed !== 1) {
      throw new JobError(`job ${jobId} is not RUNNING`);
    }
    writeAudit(db, {
      code: exitCode === 0 ? "job_succeeded" : "job_failed",
      details: { job_id: jobId, exit_code: exitCode },
      now,
    });
    return { jobId, state: exitCode === 0 ? "SUCCEEDED" : "FAILED", exitCode };
  });
}

export function markTimedOutJob(db, { jobId, now }) {
  return withTx(db, () => {
    const changed = db
      .prepare("UPDATE execution_jobs SET state='TIMED_OUT', ended_at=? WHERE id=? AND state='RUNNING'")
      .run(now, jobId).changes;
    if (changed !== 1) throw new JobError(`job ${jobId} is not RUNNING`);
    writeAudit(db, { code: "job_timed_out", details: { job_id: jobId }, now });
    return { jobId, state: "TIMED_OUT" };
  });
}

// Recovery (06 section 9 row: "离线job运行中 | 无可信完成记录置LOST；杀孤儿
// 容器，重做只读验证"). Every RUNNING job at startup has no completion record
// this daemon can trust: mark LOST, kill the live orphan behind the sidecar,
// remove the sidecar. Phase 2 orphans are controlled fake processes.
export function reapLostJobs(db, { stateDir, now, killOrphans = true }) {
  const rows = db.prepare("SELECT id FROM execution_jobs WHERE state='RUNNING'").all();
  const reaped = [];
  for (const r of rows) {
    const pidFile = join(stateDir, "jobs", jobPidFileName(r.id));
    let pid = null;
    let killed = false;
    if (existsSync(pidFile)) {
      pid = Number(readFileSync(pidFile, "utf8").trim());
      if (killOrphans && isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
          killed = true;
        } catch {
          killed = false; // Died between probe and kill: already gone.
        }
      }
      rmSync(pidFile, { force: true });
    }
    withTx(db, () => {
      const changed = db
        .prepare(
          "UPDATE execution_jobs SET state='LOST', ended_at=?, exit_code=NULL WHERE id=? AND state='RUNNING'",
        )
        .run(now, r.id).changes;
      if (changed !== 1) return;
      writeAudit(db, {
        code: "job_lost_orphan_killed",
        details: { job_id: r.id, pid, killed },
        now,
      });
      reaped.push({ jobId: r.id, pid, killedOrphan: killed });
    });
  }
  return reaped;
}
