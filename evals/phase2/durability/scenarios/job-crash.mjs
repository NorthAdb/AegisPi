// Crash-matrix scenario child (offline job orphan). Creates a task, a
// manifest/oracle object pair, an execution job, spawns a DETACHED fake
// worker process, records its pid in the sidecar, marks the job RUNNING —
// then idles until the runner SIGKILLs THIS process. The orphan outlives it,
// exactly like a container outliving a crashed daemon. Startup recovery must
// kill the orphan and mark the job LOST.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireDaemonLock } from "../../../../apps/daemon/src/db/lock.mjs";
import { openDatabase } from "../../../../apps/daemon/src/db/connect.mjs";
import { loadCanonicalSchema, migrate } from "../../../../apps/daemon/src/db/migrate.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../../apps/daemon/src/scheduler.mjs";
import { insertObjectRow } from "../../../../apps/daemon/src/objects.mjs";
import { createJob, startJob } from "../../../../apps/daemon/src/execution-jobs.mjs";

const ws = process.env.AEGISPI_WS;
const now = Number(process.env.AEGISPI_NOW ?? Date.now());
mkdirSync(join(ws, "db"), { recursive: true });
const lock = acquireDaemonLock(ws);
if (!lock.ok) {
  console.error(`lock held by pid ${lock.heldBy}`);
  process.exit(3);
}
const db = openDatabase(join(ws, "db", "aegis.db"));
migrate(db, loadCanonicalSchema());

const ing = receiveEvent(db, ws, {
  now,
  source: "github",
  sourceEventId: "evt-job-1",
  principal: { platform: "github", subject: "42" },
  scope: { kind: "repo", domainKey: "repo:github.com/northadb/aegispi", channel: "git", repoId: "github.com/northadb/aegispi" },
  threadKey: "t-job",
  priority: 5,
  policyVersion: "pv1",
  payload: "run the offline verification job",
  verdict: "ADMIT",
});
const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
const d = dispatchEventToTask(db, {
  inboxId: ing.inboxId, dispatchKey: dispatchKeyForInbox(inbox),
  now, priority: 5, maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "skillset-v1",
});
const claim = claimNextTask(db, { now, leaseMs: 45000 });

const manifest = insertObjectRow(db, {
  scopeId: inbox.scope_id, kind: "job_manifest", sourceUri: `task:${d.taskId}`,
  sourceActor: "host", content: JSON.stringify({ cmd: "fake-verify", args: [] }),
  observedAt: now, requiredScopeIds: [inbox.scope_id],
});
const oracle = insertObjectRow(db, {
  scopeId: inbox.scope_id, kind: "job_oracle", sourceUri: `task:${d.taskId}`,
  sourceActor: "host", content: JSON.stringify({ expect: { exitCode: 0 } }),
  observedAt: now, requiredScopeIds: [inbox.scope_id],
});

const jobId = "job:crash-sim:1";
createJob(db, {
  id: jobId,
  taskId: d.taskId,
  attemptId: claim.attemptId,
  fence: claim.fence,
  manifestObjectId: manifest.id,
  oracleObjectId: oracle.id,
  deadlineAt: now + 90 * 1000,
  now,
});

const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
orphan.unref();
startJob(db, { stateDir: ws, jobId, pid: orphan.pid, now });
console.log(`ORPHAN ${orphan.pid}`);

// Idle as the "daemon" until the runner kills this process.
await new Promise(() => {});
