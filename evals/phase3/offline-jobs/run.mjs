// test:offline-jobs — Phase 3 gate (04 Phase 3: "真实无网络job可执行/超时/
// 取消"; 02 section 5: real container isolation, no mocks).
//
// Every case runs a REAL docker container at the digest-pinned execution
// image (evals/phase3/lib/image-gate.mjs refuses to run without recorded
// digests). The wall-clock deadline is enforced host-side; network is absent
// at the namespace level (--network none); quotas are real cgroup limits.
//
// Data sources: local SQLite workspace + the local docker daemon. No model
// calls, no external writes, no credentials anywhere near these jobs.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
  repoRoot,
} from "../lib/harness.mjs";
import { requireAppImageDigests, imageRef } from "../lib/image-gate.mjs";
import { loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../apps/daemon/src/scheduler.mjs";
import { insertObjectRow } from "../../../apps/daemon/src/objects.mjs";
import { createContainerExecutor } from "../../../apps/daemon/src/container-executor.mjs";

lockedNodeGuard();
const { digests } = await requireAppImageDigests();

const suite = makeSuite("offline-jobs");
const EXECUTION_REF = imageRef("execution", digests);
const AGENT_REF = imageRef("agent", digests);

function seedTask(db, stateDir, { label }) {
  const now = Date.now();
  const ing = receiveEvent(db, stateDir, {
    now,
    source: "telegram",
    sourceEventId: `evt-oj-${label}`,
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: `t-${label}`,
    priority: 5,
    policyVersion: "pv1",
    payload: `offline job case ${label}`,
    verdict: "ADMIT",
  });
  const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
  dispatchEventToTask(db, {
    inboxId: inbox.id,
    dispatchKey: dispatchKeyForInbox(inbox),
    now,
    priority: 5,
    maxSteps: 25,
    deadlineAt: now + 15 * 60 * 1000,
    skillSetHash: "skillset-phase3-test",
  });
  const claim = claimNextTask(db, { now, leaseMs: 45000 });
  return { task: db.prepare("SELECT * FROM tasks WHERE id=?").get(claim.taskId), now };
}

function freshExecutor(db, ws, quotas) {
  return createContainerExecutor(db, {
    stateDir: ws.stateDir,
    imageRef: EXECUTION_REF,
    quotas: quotas ?? { cpus: 1, memory: "2g", pids: 256, tmpfsSize: "4g" },
  });
}

function attemptIdOf(db, task) {
  return db.prepare("SELECT id FROM attempts WHERE task_id=? AND attempt_no=?").get(task.id, task.attempt_no).id;
}

function dockerJson(args) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { code: r.status, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFinish(executor, { jobId, maxMs = 30000 }) {
  const start = Date.now();
  for (;;) {
    const events = executor.pollOnce({ now: Date.now() });
    const mine = events.find((e) => e.jobId === jobId);
    if (mine) return mine;
    if (Date.now() - start > maxMs) return null;
    await sleep(500);
  }
}

function jobOutput(ws, jobId) {
  const dir = join(ws.stateDir, "jobs", jobId.replace(/[^A-Za-z0-9._-]/g, "_"), "output");
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  let result = null;
  if (existsSync(join(dir, "result.json"))) {
    try {
      result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    } catch {}
  }
  return { result, stdout: read("stdout.txt"), stderr: read("stderr.txt") };
}

// ---------------------------------------------------------------------------
// 1. Execute: a clean no-network job runs to completion and its evidence is
// honest (exit code 0 recorded, stdout captured).
{
  const ws = makeWorkspace("oj-execute");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const { task } = seedTask(db, ws.stateDir, { label: "exec" });
  const executor = freshExecutor(db, ws);
  const jobId = `job:oj:exec:${task.fence}:clean`;
  executor.submitJob({
    jobId,
    taskId: task.id,
    attemptId: attemptIdOf(db, task),
    fence: task.fence,
    manifest: { schemaVersion: 1, jobId, command: "node", args: ["-e", "console.log('offline ok')"], deadlineMs: 20000 },
    deadlineAt: Date.now() + 30000,
    now: Date.now(),
  });
  const event = await waitForFinish(executor, { jobId });
  const out = jobOutput(ws, jobId);
  const row = db.prepare("SELECT state, exit_code FROM execution_jobs WHERE id=?").get(jobId);
  suite.check(
    "real-no-network-job-executes",
    event?.state === "SUCCEEDED" &&
      row.state === "SUCCEEDED" &&
      row.exit_code === 0 &&
      out.result?.exitCode === 0 &&
      /offline ok/.test(out.stdout),
    `event=${event?.state} row=${row.state}/${row.exit_code} result.exit=${out.result?.exitCode} stdout=${JSON.stringify(out.stdout.trim().slice(0, 40))}`,
  );
  db.close();
}

// 2. Failing job: the exit code is EVIDENCE (7), recorded as FAILED.
{
  const ws = makeWorkspace("oj-fail");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const { task } = seedTask(db, ws.stateDir, { label: "fail" });
  const executor = freshExecutor(db, ws);
  const jobId = `job:oj:fail:${task.fence}:seven`;
  executor.submitJob({
    jobId,
    taskId: task.id,
    attemptId: attemptIdOf(db, task),
    fence: task.fence,
    manifest: { schemaVersion: 1, jobId, command: "node", args: ["-e", "process.exit(7)"], deadlineMs: 20000 },
    deadlineAt: Date.now() + 30000,
    now: Date.now(),
  });
  const event = await waitForFinish(executor, { jobId });
  const out = jobOutput(ws, jobId);
  const row = db.prepare("SELECT state, exit_code FROM execution_jobs WHERE id=?").get(jobId);
  suite.check(
    "failing-job-records-exit-code-as-evidence",
    event?.state === "FAILED" && row.state === "FAILED" && row.exit_code === 7 && out.result?.exitCode === 7,
    `row=${row.state}/${row.exit_code} evidence.exit=${out.result?.exitCode}`,
  );
  db.close();
}

// 3. No network at the namespace level: DNS and direct HTTP both fail inside
// the job's container.
{
  const ws = makeWorkspace("oj-network");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const { task } = seedTask(db, ws.stateDir, { label: "net" });
  const executor = freshExecutor(db, ws);
  const jobId = `job:oj:net:${task.fence}:blocked`;
  executor.submitJob({
    jobId,
    taskId: task.id,
    attemptId: attemptIdOf(db, task),
    fence: task.fence,
    manifest: {
      schemaVersion: 1,
      jobId,
      command: "node",
      args: [
        "-e",
        `require('dns').lookup('example.com', (e) => {
           const dns = e ? 'DNS_BLOCKED' : 'DNS_LEAK';
           fetch('http://192.0.2.1/').then(() => console.log(dns + ' HTTP_LEAK')).catch(() => console.log(dns + ' HTTP_BLOCKED'));
         });`,
      ],
      deadlineMs: 15000,
    },
    deadlineAt: Date.now() + 25000,
    now: Date.now(),
  });
  const event = await waitForFinish(executor, { jobId });
  const out = jobOutput(ws, jobId);
  suite.check(
    "job-namespace-has-no-network-dns-and-http-blocked",
    event?.state === "SUCCEEDED" && /DNS_BLOCKED/.test(out.stdout) && /HTTP_BLOCKED/.test(out.stdout),
    `stdout=${JSON.stringify(out.stdout.trim().slice(0, 60))}`,
  );
  db.close();
}

// 4. Timeout: the HOST kills the container at the deadline even though the
// job would happily sleep forever; the container is gone afterwards.
{
  const ws = makeWorkspace("oj-timeout");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const { task } = seedTask(db, ws.stateDir, { label: "timeout" });
  const executor = freshExecutor(db, ws);
  const jobId = `job:oj:timeout:${task.fence}:sleep`;
  executor.submitJob({
    jobId,
    taskId: task.id,
    attemptId: attemptIdOf(db, task),
    fence: task.fence,
    manifest: { schemaVersion: 1, jobId, command: "node", args: ["-e", "setTimeout(()=>{}, 600000)"], deadlineMs: 4000 },
    deadlineAt: Date.now() + 6000,
    now: Date.now(),
  });
  const event = await waitForFinish(executor, { jobId, maxMs: 20000 });
  const row = db.prepare("SELECT state FROM execution_jobs WHERE id=?").get(jobId);
  const containersLeft = dockerJson(["ps", "-aq", "-f", `name=aegispi-job-${jobId.replace(/[^A-Za-z0-9._-]/g, "-")}`]);
  suite.check(
    "host-enforced-deadline-times-out-and-reaps-container",
    event?.state === "TIMED_OUT" && row.state === "TIMED_OUT" && containersLeft.out === "",
    `event=${event?.state} row=${row.state} containers-left=${JSON.stringify(containersLeft.out)}`,
  );
  db.close();
}

// 5. Cancel: a running job cancels; the container is killed and removed.
{
  const ws = makeWorkspace("oj-cancel");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const { task } = seedTask(db, ws.stateDir, { label: "cancel" });
  const executor = freshExecutor(db, ws);
  const jobId = `job:oj:cancel:${task.fence}:stop`;
  executor.submitJob({
    jobId,
    taskId: task.id,
    attemptId: attemptIdOf(db, task),
    fence: task.fence,
    manifest: { schemaVersion: 1, jobId, command: "node", args: ["-e", "setTimeout(()=>{}, 600000)"], deadlineMs: 600000 },
    deadlineAt: Date.now() + 600000,
    now: Date.now(),
  });
  await sleep(1500); // let it reach RUNNING
  const cancelled = executor.cancelJob({ jobId, now: Date.now() });
  const row = db.prepare("SELECT state FROM execution_jobs WHERE id=?").get(jobId);
  const containersLeft = dockerJson(["ps", "-aq", "-f", `name=aegispi-job-${jobId.replace(/[^A-Za-z0-9._-]/g, "-")}`]);
  suite.check(
    "running-job-cancels-and-container-dies",
    cancelled.state === "CANCELLED" && row.state === "CANCELLED" && containersLeft.out === "",
    `cancel=${cancelled.state} row=${row.state} containers-left=${JSON.stringify(containersLeft.out)}`,
  );
  db.close();
}

// 6. Quota separation: the agent container and the offline job container run
// under DIFFERENT cgroup limits (agent 1 GiB vs execution 2 GiB per 06
// section 4), and the limits are visible inside the containers themselves.
{
  const ws = makeWorkspace("oj-quotas");
  const readLimit = (ref, dockerArgs, file) => {
    const r = spawnSync("docker", ["run", "--rm", ...dockerArgs, "--entrypoint", "cat", ref, file], {
      encoding: "utf8",
    });
    return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  };
  const agentMemory = readLimit(
    AGENT_REF,
    ["--memory", "1g", "--pids-limit", "256", "--cpus", "1"],
    "/sys/fs/cgroup/memory.max",
  );
  const executionMemory = readLimit(
    EXECUTION_REF,
    ["--memory", "2g", "--pids-limit", "256", "--cpus", "1"],
    "/sys/fs/cgroup/memory.max",
  );
  const executionPids = readLimit(
    EXECUTION_REF,
    ["--memory", "2g", "--pids-limit", "256", "--cpus", "1"],
    "/sys/fs/cgroup/pids.max",
  );
  suite.check(
    "agent-and-offline-job-carry-different-real-cgroup-limits",
    agentMemory === String(1024 * 1024 * 1024) &&
      executionMemory === String(2 * 1024 * 1024 * 1024) &&
      executionPids === "256",
    `agent memory.max=${agentMemory} execution memory.max=${executionMemory} pids.max=${executionPids}`,
  );
}

// 7. Quota enforcement is real: a job that exceeds its memory bound dies
// (cgroup OOM), and a job that exceeds its bounded work disk fails with
// ENOSPC — with SMALL bounds so the proof is cheap and the calibrated
// defaults stay in the calibration report, not here.
{
  const ws = makeWorkspace("oj-quota-enforce");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const { task } = seedTask(db, ws.stateDir, { label: "quota" });
  const executor = freshExecutor(db, ws, { cpus: 1, memory: "256m", pids: 64, tmpfsSize: "64m" });
  const oomJobId = `job:oj:quota:${task.fence}:oom`;
  executor.submitJob({
    jobId: oomJobId,
    taskId: task.id,
    attemptId: attemptIdOf(db, task),
    fence: task.fence,
    manifest: {
      schemaVersion: 1,
      jobId: oomJobId,
      command: "node",
      args: ["-e", "const bufs=[]; while(true){ const b=Buffer.alloc(64*1024*1024); b.fill(0x41); bufs.push(b); }"],
      deadlineMs: 20000,
    },
    deadlineAt: Date.now() + 30000,
    now: Date.now(),
  });
  const oomEvent = await waitForFinish(executor, { jobId: oomJobId, maxMs: 40000 });
  const oomRow = db.prepare("SELECT state FROM execution_jobs WHERE id=?").get(oomJobId);
  const diskJobId = `job:oj:quota:${task.fence}:disk`;
  executor.submitJob({
    jobId: diskJobId,
    taskId: task.id,
    attemptId: attemptIdOf(db, task),
    fence: task.fence,
    manifest: {
      schemaVersion: 1,
      jobId: diskJobId,
      command: "node",
      args: ["-e", "const fs=require('fs'); try { for(let i=0;i<40;i++) fs.writeFileSync('/job/work/chunk'+i, Buffer.alloc(4*1024*1024)); console.log('DISK_WROTE_ALL'); } catch(e){ console.log('DISK_BOUND_HIT:'+e.code); process.exit(9); }"],
      deadlineMs: 20000,
    },
    deadlineAt: Date.now() + 30000,
    now: Date.now(),
  });
  const diskEvent = await waitForFinish(executor, { jobId: diskJobId, maxMs: 40000 });
  const diskOut = jobOutput(ws, diskJobId);
  const diskRow = db.prepare("SELECT state, exit_code FROM execution_jobs WHERE id=?").get(diskJobId);
  suite.check(
    "memory-and-disk-quotas-are-enforced-not-advisory",
    oomRow.state === "FAILED" &&
      (oomEvent?.state === "FAILED" || oomEvent?.state === "TIMED_OUT") &&
      diskRow.state === "FAILED" &&
      diskRow.exit_code === 9 &&
      /DISK_BOUND_HIT:ENOSPC/.test(diskOut.stdout),
    `oom=${oomRow.state}(${oomEvent?.state}) disk=${diskRow.state}/${diskRow.exit_code} stdout=${JSON.stringify(diskOut.stdout.trim().slice(0, 40))} — the tmpfs SIZE bound must be the killer (EACCES or any other code means the mount contract broke, not the quota)`,
  );
  db.close();
}

// 8. Recovery: a RUNNING container job at startup has no trusted completion
// record — the reaper kills the container and the row is LOST (06 section 9).
{
  const ws = makeWorkspace("oj-recover");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const { task } = seedTask(db, ws.stateDir, { label: "recover" });
  const executor = freshExecutor(db, ws);
  const jobId = `job:oj:recover:${task.fence}:orphan`;
  const submitted = executor.submitJob({
    jobId,
    taskId: task.id,
    attemptId: attemptIdOf(db, task),
    fence: task.fence,
    manifest: { schemaVersion: 1, jobId, command: "node", args: ["-e", "setTimeout(()=>{}, 600000)"], deadlineMs: 600000 },
    deadlineAt: Date.now() + 600000,
    now: Date.now(),
  });
  await sleep(1500);
  // Daemon died: a fresh startup calls the reaper.
  const reaped = executor.reapOrphanContainers({ now: Date.now(), kill: true });
  const row = db.prepare("SELECT state FROM execution_jobs WHERE id=?").get(jobId);
  const containersLeft = dockerJson(["ps", "-aq", "-f", `name=aegispi-job-${jobId.replace(/[^A-Za-z0-9._-]/g, "-")}`]);
  suite.check(
    "startup-recovery-kills-orphan-container-and-marks-lost",
    reaped.length === 1 &&
      reaped[0].jobId === jobId &&
      reaped[0].killedOrphan === true &&
      row.state === "LOST" &&
      containersLeft.out === "",
    `reaped=${JSON.stringify(reaped)} row=${row.state} containers-left=${JSON.stringify(containersLeft.out)}`,
  );
  db.close();
}

// 9. Manifest refusal: the runner rejects an invalid manifest and the job
// records FAILED(126) — nothing executed.
{
  const ws = makeWorkspace("oj-refuse");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const { task } = seedTask(db, ws.stateDir, { label: "refuse" });
  const executor = freshExecutor(db, ws);
  const jobId = `job:oj:refuse:${task.fence}:bad`;
  executor.submitJob({
    jobId,
    taskId: task.id,
    attemptId: attemptIdOf(db, task),
    fence: task.fence,
    manifest: { schemaVersion: 1, jobId, command: "node", args: [], deadlineMs: "not-a-number" },
    deadlineAt: Date.now() + 30000,
    now: Date.now(),
  });
  const event = await waitForFinish(executor, { jobId });
  const out = jobOutput(ws, jobId);
  const row = db.prepare("SELECT state, exit_code FROM execution_jobs WHERE id=?").get(jobId);
  suite.check(
    "invalid-manifest-refused-nothing-executed",
    event?.state === "FAILED" && row.state === "FAILED" && row.exit_code === 126 && out.result?.refused === true,
    `row=${row.state}/${row.exit_code} refused=${out.result?.refused} reason=${JSON.stringify(out.result?.error ?? "").slice(0, 60)}`,
  );
  db.close();
}

// 10. Daemon-level integration: a QUEUED job with a persisted manifest is
// launched and reaped by the DAEMON's own tick when the operator wires the
// execution image. This is the production path, not the direct executor API.
{
  const ws = makeWorkspace("oj-daemon");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const { task } = seedTask(db, ws.stateDir, { label: "daemonjob" });
  // Seed the durable intent exactly the way the host executor does.
  const jobId = `job:oj:daemon:${task.fence}:tick`;
  const jobDir = join(ws.stateDir, "jobs", jobId.replace(/[^A-Za-z0-9._-]/g, "_"));
  mkdirSync(join(jobDir, "input"), { recursive: true });
  mkdirSync(join(jobDir, "output"), { recursive: true });
  writeFileSync(
    join(jobDir, "input", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1, jobId,
      command: "node", args: ["-e", "console.log('daemon tick job')"], deadlineMs: 20000,
    }) + "\n",
    "utf8",
  );
  // Durable intent exactly the way the host executor writes it: the manifest
  // and oracle are content-addressed OBJECTS, the row references them.
  const { insertObjectRow } = await import("../../../apps/daemon/src/objects.mjs");
  const scopeId = db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(task.id).scope_id;
  const manifestObj = insertObjectRow(db, {
    scopeId, kind: "job_manifest", sourceUri: `job:${jobId}`, sourceActor: "test",
    content: JSON.stringify({ schemaVersion: 1, jobId, command: "node", args: ["-e", "console.log('daemon tick job')"], deadlineMs: 20000 }),
    observedAt: Date.now(), requiredScopeIds: [scopeId],
  });
  const oracleObj = insertObjectRow(db, {
    scopeId, kind: "job_oracle", sourceUri: `job:${jobId}`, sourceActor: "test",
    content: JSON.stringify({ schemaVersion: 1, verdict: "exit-code-evidence-only" }),
    observedAt: Date.now(), requiredScopeIds: [scopeId],
  });
  db.prepare(
    `INSERT INTO execution_jobs(id, task_id, attempt_id, fence, manifest_object_id, oracle_object_id,
       state, deadline_at, exit_code, artifact_object_id, created_at, ended_at)
     VALUES (?,?,?,?,?,?,'QUEUED',?,NULL,NULL,?,NULL)`,
  ).run(jobId, task.id, attemptIdOf(db, task), task.fence, manifestObj.id, oracleObj.id, Date.now() + 30000, Date.now());
  db.close();
  const daemon = spawnSync(process.execPath, [
    join(repoRoot, "apps", "daemon", "src", "daemon.mjs"),
    "--once", `--data-dir=${ws.stateDir}`, `--execution-image=${EXECUTION_REF}`,
  ], { cwd: repoRoot, encoding: "utf8", timeout: 90000 });
  const daemonOut = (daemon.stdout ?? "") + (daemon.stderr ?? "");
  const db2 = openDatabase(ws.dbPath);
  const row = db2.prepare("SELECT state, exit_code FROM execution_jobs WHERE id=?").get(jobId);
  db2.close();
  const jobStdout = readFileSync(join(jobDir, "output", "stdout.txt"), "utf8");
  const containersLeft = dockerJson(["ps", "-aq", "-f", `name=aegispi-job-${jobId.replace(/[^A-Za-z0-9._-]/g, "-")}`]);
  suite.check(
    "daemon-tick-launches-and-reaps-queued-container-job",
    daemon.status === 0 &&
      row.state === "SUCCEEDED" &&
      row.exit_code === 0 &&
      containersLeft.out === "" &&
      /daemon tick job/.test(jobStdout) &&
      /-> SUCCEEDED/.test(daemonOut),
    `daemon exit=${daemon.status} job=${row.state}/${row.exit_code} containers=${JSON.stringify(containersLeft.out)} job-stdout-seen=${/daemon tick job/.test(jobStdout)} daemon-event-seen=${/-> SUCCEEDED/.test(daemonOut)}`,
  );
}

// 11. Disk-watermark WARN drill (audit F8: 常开前必须有实测触警演练; 06
// section 10). Same daemon path as case 10, same seeding — ONLY the
// injected threshold differs (AEGISPI_DISK_DRILL_WARN_GIB). The real statfs
// reads a healthy disk; the drill threshold trips warn, the tick must refuse
// to launch the QUEUED job, and --once must exit 5 at the deadline bound
// instead of hanging forever behind a launch policy.
{
  const ws = makeWorkspace("oj-disk-warn");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const { task } = seedTask(db, ws.stateDir, { label: "diskwarn" });
  const jobId = `job:oj:warn:${task.fence}:blocked`;
  const jobDir = join(ws.stateDir, "jobs", jobId.replace(/[^A-Za-z0-9._-]/g, "_"));
  mkdirSync(join(jobDir, "input"), { recursive: true });
  writeFileSync(
    join(jobDir, "input", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1, jobId,
      command: "node", args: ["-e", "console.log('never launched')"], deadlineMs: 20000,
    }) + "\n",
    "utf8",
  );
  const { insertObjectRow } = await import("../../../apps/daemon/src/objects.mjs");
  const scopeId = db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(task.id).scope_id;
  const manifestObj = insertObjectRow(db, {
    scopeId, kind: "job_manifest", sourceUri: `job:${jobId}`, sourceActor: "test",
    content: JSON.stringify({ schemaVersion: 1, jobId, command: "node", args: ["-e", "console.log('never launched')"], deadlineMs: 20000 }),
    observedAt: Date.now(), requiredScopeIds: [scopeId],
  });
  const oracleObj = insertObjectRow(db, {
    scopeId, kind: "job_oracle", sourceUri: `job:${jobId}`, sourceActor: "test",
    content: JSON.stringify({ schemaVersion: 1, verdict: "exit-code-evidence-only" }),
    observedAt: Date.now(), requiredScopeIds: [scopeId],
  });
  db.prepare(
    `INSERT INTO execution_jobs(id, task_id, attempt_id, fence, manifest_object_id, oracle_object_id,
       state, deadline_at, exit_code, artifact_object_id, created_at, ended_at)
     VALUES (?,?,?,?,?,?,'QUEUED',?,NULL,NULL,?,NULL)`,
  ).run(jobId, task.id, attemptIdOf(db, task), task.fence, manifestObj.id, oracleObj.id, Date.now() + 8000, Date.now());
  db.close();
  const daemon = spawnSync(process.execPath, [
    join(repoRoot, "apps", "daemon", "src", "daemon.mjs"),
    "--once", `--data-dir=${ws.stateDir}`, `--execution-image=${EXECUTION_REF}`,
  ], {
    cwd: repoRoot, encoding: "utf8", timeout: 120000,
    env: { ...process.env, AEGISPI_DISK_DRILL_WARN_GIB: "1000000" },
  });
  const daemonOut = (daemon.stdout ?? "") + (daemon.stderr ?? "");
  const db2 = openDatabase(ws.dbPath, { readOnly: true });
  const row = db2.prepare("SELECT state FROM execution_jobs WHERE id=?").get(jobId);
  db2.close();
  const containersLeft = dockerJson(["ps", "-aq", "-f", `name=aegispi-job-${jobId.replace(/[^A-Za-z0-9._-]/g, "-")}`]);
  suite.check(
    "disk-warn-drill-blocks-new-job-launches",
    daemon.status === 5 &&
      row.state === "QUEUED" &&
      /level=warn/.test(daemonOut) &&
      containersLeft.out === "",
    `daemon exit=${daemon.status} job=${row.state} warn-line=${/level=warn/.test(daemonOut)} containers=${JSON.stringify(containersLeft.out)} — the watermark read a REAL (healthy) disk and the injected threshold tripped the drill`,
  );
}

suite.note(
  "residual-risk-recorded",
  "容器级退出码与 result.json 是证据输入：同容器的恶意 job 可以伪造自己的 result.json（02 §5 明文承认）。宿主按容器退出码与证据字段映射 job 终态，job 的自述不作授权或成功标记；宿主墙钟 deadline 与容器回收不受影响。「Task 结论归可信 oracle 判定」的宿主侧比较尚未接线：本阶段如实记录为实现待接线，不宣称已验收。",
);

writeReport({
  suiteId: "offline-jobs",
  suite,
  label: "test:offline-jobs — 真实无网络 job 执行/超时/取消与配额强制（真实容器，digest 固定）",
  extra: {
    dataSources:
      "真实 docker 容器（execution/agent 镜像按记录 digest 运行，--network none，cgroup 限额）+ 本地 SQLite；无模型调用、无外部写、无凭据入容器",
    executionImage: EXECUTION_REF,
    agentImage: AGENT_REF,
  },
});
process.exit(suiteExit(suite, { label: "test:offline-jobs" }));
