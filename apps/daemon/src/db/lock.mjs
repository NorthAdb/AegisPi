// Exclusive single-daemon file lock (06 section 1: "只允许单机单活动 daemon 写
// 一个数据目录，以 OS 排他文件锁防止双启动；持锁失败直接退出").
//
// Node core has no cross-platform flock, so the lock is an atomically created
// lockfile plus a PID liveness probe. This is honest about its hazard: a PID can
// be reused by an unrelated process after a crash, in which case a stale lock
// would look held. Personal single-machine deployment accepts that residual
// risk; `force` exists for an operator who verifies and clears manually.
// The lockfile write is atomic (tmp file + rename), so it is either absent or
// complete.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function acquireDaemonLock(stateDir, { force = false } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, "daemon.lock");
  if (existsSync(lockPath)) {
    let existing = null;
    try {
      existing = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {
      existing = null;
    }
    const alive = existing ? isPidAlive(existing.pid) : false;
    if (!force && existing && alive) {
      return { ok: false, lockPath, heldBy: existing.pid, startedAt: existing.startedAt };
    }
    // Stale (crashed holder) or operator-forced: steal the lock.
    rmSync(lockPath, { force: true });
  }
  const claim = { pid: process.pid, startedAt: Date.now(), host: process.env.COMPUTERNAME ?? "" };
  const tmpPath = lockPath + ".tmp." + process.pid;
  writeFileSync(tmpPath, JSON.stringify(claim) + "\n", { encoding: "utf8", flag: "wx" });
  renameSync(tmpPath, lockPath);
  return {
    ok: true,
    lockPath,
    pid: claim.pid,
    release() {
      try {
        const current = JSON.parse(readFileSync(lockPath, "utf8"));
        if (current.pid !== claim.pid) {
          return false; // Never remove someone else's lock.
        }
      } catch {
        // Missing or unreadable: nothing to release.
      }
      rmSync(lockPath, { force: true });
      return true;
    },
  };
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === "ESRCH") return false;
    if (e && e.code === "EPERM") return true; // Alive but owned by another user.
    return true; // Unknown probe outcome: fail closed, assume alive.
  }
}
