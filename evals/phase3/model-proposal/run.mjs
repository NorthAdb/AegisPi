// test:model-proposal — Phase 4.1 acceptance suite (ADR-0001 + task spec §3).
//
// Proves the full container->host->pi-ai->ledger->container loop and the
// ten-row state-machine/settlement matrix T1..T10 against the real SQLite
// ledger, real daemon tick, real crashpoint SIGKILLs, and digest-pinned
// networkless agent containers, with ZERO real inference service calls.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
  repoRoot,
} from "../lib/harness.mjs";
import { requireAppImageDigests, imageRef } from "../lib/image-gate.mjs";
import { loadCanonicalSchema, migrate, ensureModelRequestsTable } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../apps/daemon/src/scheduler.mjs";
import { createBudgetLedger } from "../../../apps/daemon/src/budget.mjs";
import { createCredentialService } from "../../../apps/daemon/src/credentials.mjs";
import { startupRecovery } from "../../../apps/daemon/src/recovery.mjs";
import { createAdapterUpstream } from "../../../apps/daemon/src/adapters.mjs";
import { callModelOnce, microusdForUsage, ModelCallError } from "../../../apps/daemon/src/model-call.mjs";
import {
  processModelRequest,
  cancelPreCallModelRequest,
  settleLateModelUsage,
  modelResultFileName,
} from "../../../apps/daemon/src/model-requests.mjs";
import {
  agentWorkAttemptDir,
  inspectHostProposalsAcl,
  lockHostProposalsDir,
  safeTaskDirComponent,
} from "../../../apps/daemon/src/container-executor.mjs";

lockedNodeGuard();

// Acceptance gate: runs on the digest-pinned agent image via image-gate.
const { digests } = await requireAppImageDigests();
const AGENT_REF = imageRef("agent", digests);

const suite = makeSuite("model-proposal");

// Start local OpenAI SSE loopback fixture server (separate child process so
// spawnSync callers never deadlock the event loop).
const servicePath = join(repoRoot, "evals", "phase3", "security-unit", "helpers", "local-model-service.mjs");
const serviceWs = makeWorkspace("mp-loopback-svc");
const portFile = join(serviceWs.stateDir, "port.txt");
const logFile = join(serviceWs.stateDir, "log.jsonl");
const modeFile = join(serviceWs.stateDir, "mode.json");
const svc = spawn(process.execPath, [servicePath, portFile, logFile, modeFile], { stdio: "ignore" });
for (let i = 0; i < 100 && !existsSync(portFile); i++) {
  await new Promise((r) => setTimeout(r, 100));
}
if (!existsSync(portFile)) {
  console.error("loopback model service failed to start");
  process.exit(1);
}
const modelPort = readFileSync(portFile, "utf8").trim();
const baseUrl = `http://127.0.0.1:${modelPort}`;
const daemonPath = join(repoRoot, "apps", "daemon", "src", "daemon.mjs");

function setServiceMode(cfg) {
  writeFileSync(modeFile, JSON.stringify(cfg), "utf8");
}

function readServiceLog() {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeTestConfig(ws, {
  baseUrl: cfgBaseUrl = baseUrl,
  allowedPurposes = ["worker"],
  allowedModelIds = ["deepseek/deepseek-flash"],
  priceInput = 300000,
  priceOutput = 1200000,
  priceCacheRead = null,
  priceCacheWrite = null,
  callUpperMicrousd = 1000,
  callTimeoutMs = 10000,
  allowRealModelCalls = false,
} = {}) {
  const defaults = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
  defaults.model = {
    ...defaults.model,
    baseUrl: cfgBaseUrl,
    allowedPurposes,
    allowedModelIds,
    allowRealModelCalls,
    callUpperMicrousd,
    callTimeoutMs,
    priceCatalog: {
      inputPerMTokMicrousd: priceInput,
      outputPerMTokMicrousd: priceOutput,
      cacheReadPerMTokMicrousd: priceCacheRead,
      cacheWritePerMTokMicrousd: priceCacheWrite,
    },
  };
  delete defaults.model.priceCatalog.$comment;
  const p = join(ws.stateDir, "test-config.json");
  writeFileSync(p, JSON.stringify(defaults, null, 2), "utf8");
  return p;
}

function loadConfigObj(configPath) {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  return {
    model: raw.model,
    budget: raw.budget,
    timezone: raw.time.timezoneIANA,
  };
}

function seedRunningClaim(tag, { now = Date.now(), registerSlot = true } = {}) {
  const ws = makeWorkspace(tag);
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  const canonical = loadCanonicalSchema();
  migrate(db, canonical);
  ensureModelRequestsTable(db);
  const ing = receiveEvent(db, ws.stateDir, {
    now,
    source: "telegram",
    sourceEventId: `evt-${tag}`,
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: `t-${tag}`,
    priority: 5,
    policyVersion: "pv1",
    payload: `model proposal ${tag}`,
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
    skillSetHash: "ss-p41",
  });
  const claim = claimNextTask(db, { now, leaseMs: 120000 });
  if (registerSlot) {
    createCredentialService(db).registerSlot({
      slot: "model",
      purpose: "model",
      source: "deepseek",
      envName: "AEGISPI_TEST_MODEL_KEY",
      actorId: "test-fixture",
      now,
    });
  }
  const ledger = createBudgetLedger(db, {
    taskLimitMicrousd: 800000,
    dayLimitMicrousd: 5000000,
    warmingEnabled: false,
    timeZone: "Asia/Hong_Kong",
  });
  const attemptDir = agentWorkAttemptDir(ws.stateDir, claim.taskId, claim.attemptNo);
  const proposalsDir = join(attemptDir, "proposals");
  const commandsDir = join(attemptDir, "host-commands");
  mkdirSync(commandsDir, { recursive: true });
  lockHostProposalsDir(proposalsDir);
  return { ws, db, canonical, ledger, claim, attemptDir, proposalsDir, commandsDir, now };
}

function makeEnvelope(claim, { requestId = randomUUID(), purpose = "worker", modelId = "deepseek/deepseek-flash", scopeDomainKey = "dm:telegram:6101", messages = [{ role: "user", content: "hello" }] } = {}) {
  return {
    schemaVersion: 1,
    kind: "model_request",
    requestId,
    taskId: claim.taskId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    scopeDomainKey,
    purpose,
    modelId,
    messages,
  };
}

process.env.AEGISPI_TEST_MODEL_KEY = "loopback-fixture-placeholder";

// ---------------------------------------------------------------------------
// 0. §2a Fixture Checks: baseUrl root enforcement + 3-state usage + 40/13=28 & 10/0=3
{
  let badRootRejected = false;
  try {
    callModelOnce({ baseUrl: `${baseUrl}/chat/completions`, model: "deepseek/deepseek-flash", messages: [{ role: "user", content: "x" }], bearer: "k" });
  } catch (e) {
    badRootRejected = e instanceof ModelCallError;
  }
  const cat = { inputPerMTokMicrousd: 300000, outputPerMTokMicrousd: 1200000, cacheReadPerMTokMicrousd: null, cacheWritePerMTokMicrousd: null };
  setServiceMode({ kind: "no-usage", reply: "no usage reply" });
  const noUsageRes = callModelOnce({ baseUrl, model: "deepseek/deepseek-flash", messages: [{ role: "user", content: "u0" }], bearer: "k" });
  setServiceMode({ kind: "priced", promptTokens: 0, completionTokens: 0, reply: "all zero reply" });
  const zeroRes = callModelOnce({ baseUrl, model: "deepseek/deepseek-flash", messages: [{ role: "user", content: "u1" }], bearer: "k" });
  setServiceMode({ kind: "priced", promptTokens: 40, completionTokens: 13, reply: "ok 40/13" });
  const okRes = callModelOnce({ baseUrl, model: "deepseek/deepseek-flash", messages: [{ role: "user", content: "u2" }], bearer: "k" });

  suite.check(
    "core-root-baseurl-and-usage-three-states",
    badRootRejected &&
      noUsageRes.ok &&
      !("totalFromProvider" in noUsageRes.usage) &&
      microusdForUsage(noUsageRes.usage, cat) === null &&
      zeroRes.ok &&
      typeof zeroRes.usage.totalFromProvider === "boolean" &&
      microusdForUsage(zeroRes.usage, cat) === null &&
      okRes.ok &&
      typeof okRes.usage.totalFromProvider === "boolean" &&
      microusdForUsage(okRes.usage, cat) === 28,
    `badRootRejected=${badRootRejected} noUsageKey=${"totalFromProvider" in (noUsageRes.usage ?? {})} zeroPriced=${microusdForUsage(zeroRes.usage, cat)} okPriced=${microusdForUsage(okRes.usage, cat)}`,
  );
}

// ---------------------------------------------------------------------------
// 1. Anchor E2E (§3.1-3.6 + T1 + §2c bind-mount production form)
// Real agent container on digest-pinned AGENT_REF (--network none, PI_OFFLINE=1,
// read-only rootfs, cap-drop ALL, locked host proposals dir, ro host-commands
// & context.json) -> worker.mjs writes model_request -> real daemon --once ->
// pi-ai child -> loopback /chat/completions -> same-tx SETTLED 28 u$ ->
// host writes model-result-<requestId>.json -> container serveCommands
// consumes & receipts reply body!
{
  const replyBody = "ANCHOR_E2E_REPLY_" + "x".repeat(4200);
  setServiceMode({ kind: "priced", promptTokens: 40, completionTokens: 13, reply: replyBody });
  const { ws, db, claim, attemptDir, proposalsDir, commandsDir } = seedRunningClaim("mp-anchor");
  const contextPath = join(attemptDir, "context.json");
  writeFileSync(
    contextPath,
    JSON.stringify({
      schemaVersion: 1,
      taskId: claim.taskId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      scopeDomainKey: "dm:telegram:6101",
      modelRequest: {
        purpose: "worker",
        modelId: "deepseek/deepseek-flash",
        messages: [{ role: "user", content: "anchor e2e test" }],
      },
    }) + "\n",
    "utf8",
  );
  db.close();

  const aclBefore = inspectHostProposalsAcl(proposalsDir);
  const configPath = writeTestConfig(ws);
  const cname = "aegispi-mp-anchor";
  spawnSync("docker", ["rm", "-f", cname], { stdio: "ignore" });
  const container = spawn(
    "docker",
    [
      "run", "--name", cname, "--network", "none", "--init",
      "--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,noexec,size=64m,mode=1777",
      "-v", `${proposalsDir}:/agent-work/proposals:rw`,
      "-v", `${commandsDir}:/agent-work/host-commands:ro`,
      "-v", `${contextPath}:/agent-work/context.json:ro`,
      AGENT_REF,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let containerOut = "";
  container.stdout.on("data", (d) => (containerOut += d));
  container.stderr.on("data", (d) => (containerOut += d));

  // Wait for worker.mjs to write model-request-<uuid>.json
  let propFiles = [];
  for (let i = 0; i < 100; i++) {
    propFiles = readdirSync(proposalsDir).filter((f) => f.startsWith("model-request-") && f.endsWith(".json"));
    if (propFiles.length > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const beforeHits = readServiceLog().length;
  const dRun = spawnSync(
    process.execPath,
    [daemonPath, "--once", `--data-dir=${ws.stateDir}`, `--config=${configPath}`],
    { cwd: repoRoot, encoding: "utf8", timeout: 60000, env: { ...process.env, AEGISPI_TEST_MODEL_KEY: "loopback-fixture-placeholder" } },
  );

  // Wait for container serveCommands to write receipt-model-result-<uuid>.json
  let receiptFiles = [];
  for (let i = 0; i < 100; i++) {
    receiptFiles = readdirSync(proposalsDir).filter((f) => f.startsWith("receipt-model-result-") && f.endsWith(".json"));
    if (receiptFiles.length > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  writeFileSync(join(commandsDir, "stop"), "stop\n", "utf8");
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 10000);
    container.on("exit", () => { clearTimeout(t); resolve(); });
  });
  spawnSync("docker", ["rm", "-f", cname], { stdio: "ignore" });

  const hits = readServiceLog().slice(beforeHits);
  const propJson = propFiles.length > 0 ? JSON.parse(readFileSync(join(proposalsDir, propFiles[0]), "utf8")) : null;
  const requestId = propJson?.requestId ?? null;
  const receiptJson = receiptFiles.length > 0 ? JSON.parse(readFileSync(join(proposalsDir, receiptFiles[0]), "utf8")) : null;

  const db2 = openDatabase(ws.dbPath, { readOnly: true });
  const reqRow = requestId ? db2.prepare("SELECT * FROM model_requests WHERE request_id=?").get(requestId) : null;
  const resRow = reqRow?.reservation_id ? db2.prepare("SELECT * FROM budget_reservations WHERE id=?").get(reqRow.reservation_id) : null;
  const settledAudit = db2.prepare("SELECT count(*) c FROM audit_log WHERE code='budget_settled'").get().c;
  const resultObj = db2.prepare("SELECT storage_ref FROM objects WHERE kind='task_result' ORDER BY observed_at DESC LIMIT 1").get();
  const task = db2.prepare("SELECT state FROM tasks WHERE id=?").get(claim.taskId);
  db2.close();
  const evidence = resultObj?.storage_ref ? JSON.parse(readFileSync(join(ws.stateDir, ...resultObj.storage_ref.split("/")), "utf8")) : null;

  suite.check(
    "anchor-e2e-t1-container-daemon-pi-ledger-receipt",
    propFiles.length === 1 &&
      dRun.status === 0 &&
      aclBefore.ok &&
      hits.length === 1 &&
      hits[0].path === "/chat/completions" &&
      hits[0].model === "deepseek-flash" &&
      hits[0].thinking?.type === "enabled" &&
      reqRow?.state === "SETTLED" &&
      resRow?.state === "SETTLED" &&
      resRow?.actual_microusd === 28 &&
      settledAudit === 1 &&
      task?.state === "SUCCEEDED" &&
      evidence?.reply?.length === 4000 &&
      receiptJson?.accepted === true &&
      receiptJson?.requestId === requestId &&
      receiptJson?.reply === replyBody,
    `props=${propFiles.length} daemon=${dRun.status} aclOk=${aclBefore.ok} hits=${hits.length}(${hits[0]?.path}/${hits[0]?.model}/thinking=${hits[0]?.thinking?.type}) req=${reqRow?.state} res=${resRow?.state}/${resRow?.actual_microusd}u$ task=${task?.state} evReplyLen=${evidence?.reply?.length} receipt=${receiptJson?.accepted}/replyMatch=${receiptJson?.reply === replyBody}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Production --agent-image launcher (§2c) + bind-mount isolation assertions
{
  setServiceMode({ kind: "priced", promptTokens: 40, completionTokens: 13, reply: "prod-launcher-ok" });
  const ws = makeWorkspace("mp-prod-launcher");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  ensureModelRequestsTable(db);
  const now = Date.now();
  const ing = receiveEvent(db, ws.stateDir, {
    now, source: "telegram", sourceEventId: "evt-mp-prod",
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: "t-prod", priority: 5, policyVersion: "pv1", payload: "launch via --agent-image", verdict: "ADMIT",
  });
  const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
  const dispatched = dispatchEventToTask(db, {
    inboxId: inbox.id, dispatchKey: dispatchKeyForInbox(inbox), now, priority: 5,
    maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "ss-prod",
  });
  createCredentialService(db).registerSlot({
    slot: "model", purpose: "model", source: "deepseek",
    envName: "AEGISPI_TEST_MODEL_KEY", actorId: "test-fixture", now,
  });
  db.close();

  const configPath = writeTestConfig(ws);
  const beforeHits = readServiceLog().length;
  const r = spawnSync(
    process.execPath,
    [daemonPath, "--once", `--data-dir=${ws.stateDir}`, `--config=${configPath}`, `--agent-image=${AGENT_REF}`],
    { cwd: repoRoot, encoding: "utf8", timeout: 90000, env: { ...process.env, AEGISPI_TEST_MODEL_KEY: "loopback-fixture-placeholder" } },
  );
  const hits = readServiceLog().slice(beforeHits);
  const db2 = openDatabase(ws.dbPath, { readOnly: true });
  const task = db2.prepare("SELECT state, attempt_no FROM tasks WHERE id=?").get(dispatched.taskId);
  const reqRow = db2.prepare("SELECT state FROM model_requests WHERE task_id=?").get(dispatched.taskId);
  const resRow = db2.prepare("SELECT state, actual_microusd FROM budget_reservations WHERE task_id=?").get(dispatched.taskId);
  db2.close();
  const attemptDirProd = agentWorkAttemptDir(ws.stateDir, dispatched.taskId, task.attempt_no);
  const proposalsDir = join(attemptDirProd, "proposals");
  const commandsDirProd = join(attemptDirProd, "host-commands");
  const contextPathProd = join(attemptDirProd, "context.json");
  const attemptAcl = inspectHostProposalsAcl(attemptDirProd);
  const acl = inspectHostProposalsAcl(proposalsDir);
  const leftContainers = spawnSync("docker", ["ps", "-aq", "-f", `name=aegispi-agent-`], { encoding: "utf8" }).stdout.trim();

  const isoProbe = spawnSync(
    "docker",
    [
      "run", "--rm", "--network", "none",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-v", `${proposalsDir}:/agent-work/proposals:rw`,
      "-v", `${commandsDirProd}:/agent-work/host-commands:ro`,
      "-v", `${contextPathProd}:/agent-work/context.json:ro`,
      "--entrypoint", "node",
      AGENT_REF,
      "-e", `
        const fs = require('fs');
        const out = [];
        try { fs.writeFileSync('/workspace/x', '1'); out.push('rootfs=RW'); } catch (e) { out.push('rootfs=RO:' + e.code); }
        try { fs.writeFileSync('/agent-work/host-commands/x', '1'); out.push('cmds=RW'); } catch (e) { out.push('cmds=RO:' + e.code); }
        try { fs.writeFileSync('/agent-work/context.json', '{}'); out.push('ctx=RW'); } catch (e) { out.push('ctx=RO:' + e.code); }
        try { fs.writeFileSync('/agent-work/proposals/probe.tmp', '1'); fs.unlinkSync('/agent-work/proposals/probe.tmp'); out.push('prop=RW'); } catch (e) { out.push('prop=ERR:' + e.code); }
        console.log(out.join(' '));
      `,
    ],
    { encoding: "utf8" },
  );
  let nonUuidRejected = false;
  try {
    modelResultFileName("../etc/passwd");
  } catch {
    nonUuidRejected = true;
  }

  suite.check(
    "production-agent-launcher-acl-and-bind-isolation",
    r.status === 0 &&
      task?.state === "SUCCEEDED" &&
      reqRow?.state === "SETTLED" &&
      resRow?.state === "SETTLED" &&
      resRow?.actual_microusd === 28 &&
      hits.length === 1 &&
      attemptAcl.ok === true &&
      acl.ok === true &&
      leftContainers === "" &&
      /rootfs=RO:EROFS/.test(isoProbe.stdout) &&
      /cmds=RO:EROFS/.test(isoProbe.stdout) &&
      /ctx=RO:EROFS/.test(isoProbe.stdout) &&
      /prop=RW/.test(isoProbe.stdout) &&
      nonUuidRejected,
    `daemon=${r.status} task=${task?.state} req=${reqRow?.state} res=${resRow?.state}/${resRow?.actual_microusd} attemptAcl=${attemptAcl.ok} aclOk=${acl.ok} iso="${isoProbe.stdout.trim()}" nonUuidRejected=${nonUuidRejected}`,
  );
}

// ---------------------------------------------------------------------------
// 3. T2 — Refused input: 6 validation triggers (0 request rows, 0 reservations)
//         + budget rejection subcase (RECEIVED -> FAILED, 0 reservations)
{
  const { ws, db, ledger, claim, commandsDir, now } = seedRunningClaim("mp-t2");
  const configPath = writeTestConfig(ws);
  const config = loadConfigObj(configPath);
  const beforeHits = readServiceLog().length;

  const triggers = [
    ["bad-purpose", makeEnvelope(claim, { purpose: "bogus" })],
    ["bad-modelId", makeEnvelope(claim, { modelId: "openai/gpt-4o" })],
    ["bad-scope", makeEnvelope(claim, { scopeDomainKey: "dm:telegram:9999" })],
    ["bad-fence", { ...makeEnvelope(claim), fence: claim.fence + 1 }],
    ["unknown-field", { ...makeEnvelope(claim), endpoint: "http://evil.invalid" }],
    ["oversize-128kib", makeEnvelope(claim, { messages: [{ role: "user", content: "a".repeat(129 * 1024) }] })],
  ];

  const triggerOutcomes = [];
  for (const [label, env] of triggers) {
    const out = processModelRequest(db, { stateDir: ws.stateDir, config, ledger, envelope: env, hostCommandsDir: commandsDir, now });
    triggerOutcomes.push({ label, accepted: out.accepted, status: out.status, rowCreated: out.rowCreated });
  }
  const rowsAfter6 = db.prepare("SELECT count(*) c FROM model_requests").get().c;
  const resAfter6 = db.prepare("SELECT count(*) c FROM budget_reservations").get().c;
  const refusedAudits = db.prepare("SELECT count(*) c FROM audit_log WHERE code='model_request_refused'").get().c;

  // Subcase 2: budget rejection (exhaust/freeze task account before valid proposal)
  const taskAcc = ledger.ensureTaskAccount({ taskId: claim.taskId, now }).accountId;
  ledger.freezeAccount({ accountId: taskAcc, reason: "t2-budget-freeze", now });
  const budgetReqId = randomUUID();
  const budgetOut = processModelRequest(db, {
    stateDir: ws.stateDir,
    config,
    ledger,
    envelope: makeEnvelope(claim, { requestId: budgetReqId }),
    hostCommandsDir: commandsDir,
    now,
  });
  const budgetReqRow = db.prepare("SELECT state FROM model_requests WHERE request_id=?").get(budgetReqId);
  const resAfterBudget = db.prepare("SELECT count(*) c FROM budget_reservations").get().c;
  const refusedAfterBudget = db.prepare("SELECT count(*) c FROM audit_log WHERE code='model_request_refused'").get().c;
  const afterHits = readServiceLog().length;
  db.close();

  suite.check(
    "t2-refused-inputs-and-budget-rejection",
    triggerOutcomes.every((o) => o.accepted === false && o.status === "refused" && o.rowCreated === false) &&
      rowsAfter6 === 0 &&
      resAfter6 === 0 &&
      refusedAudits === 6 &&
      budgetOut.status === "budget_refused" &&
      budgetReqRow?.state === "FAILED" &&
      resAfterBudget === 0 &&
      refusedAfterBudget === 7 &&
      afterHits === beforeHits,
    `triggers=${triggerOutcomes.map((o) => `${o.label}:${o.status}`).join(",")} rows6=${rowsAfter6} budgetReq=${budgetReqRow?.state} res=${resAfterBudget} calls=${afterHits - beforeHits}`,
  );
}

// ---------------------------------------------------------------------------
// 4. T3 — Duplicate requestId (idempotent PK read, 0 second reservation, 1 cumulative call)
{
  setServiceMode({ kind: "priced", promptTokens: 40, completionTokens: 13, reply: "t3-ok" });
  const { ws, db, ledger, claim, commandsDir, now } = seedRunningClaim("mp-t3");
  const config = loadConfigObj(writeTestConfig(ws));
  const reqId = randomUUID();
  const env = makeEnvelope(claim, { requestId: reqId });
  const beforeHits = readServiceLog().length;

  const first = processModelRequest(db, { stateDir: ws.stateDir, config, ledger, envelope: env, hostCommandsDir: commandsDir, completeActiveTask: true, now });
  const second = processModelRequest(db, { stateDir: ws.stateDir, config, ledger, envelope: env, hostCommandsDir: commandsDir, completeActiveTask: true, now: now + 10 });
  const reqCount = db.prepare("SELECT count(*) c FROM model_requests WHERE request_id=?").get(reqId).c;
  const resCount = db.prepare("SELECT count(*) c FROM budget_reservations").get().c;
  const dupAudits = db.prepare("SELECT count(*) c FROM audit_log WHERE code='model_request_duplicate'").get().c;
  const afterHits = readServiceLog().length;
  db.close();

  suite.check(
    "t3-duplicate-request-idempotent-single-call-single-reserve",
    first.status === "settled" &&
      second.duplicate === true &&
      second.state === "SETTLED" &&
      reqCount === 1 &&
      resCount === 1 &&
      dupAudits === 1 &&
      afterHits - beforeHits === 1,
    `first=${first.status} second=${second.status}(${second.state}) reqCount=${reqCount} resCount=${resCount} dupAudits=${dupAudits} calls=${afterHits - beforeHits}`,
  );
}

// ---------------------------------------------------------------------------
// 5. T4 — Pre-call cancel (between RESERVED and EXECUTING -> FAILED + RELEASED, 0 fee, 0 calls)
{
  const { ws, db, ledger, claim, commandsDir, now } = seedRunningClaim("mp-t4");
  const config = loadConfigObj(writeTestConfig(ws));
  const reqId = randomUUID();
  const beforeHits = readServiceLog().length;
  const out = processModelRequest(db, {
    stateDir: ws.stateDir,
    config,
    ledger,
    envelope: makeEnvelope(claim, { requestId: reqId }),
    hostCommandsDir: commandsDir,
    preCallCancelled: true,
    now,
  });
  const reqRow = db.prepare("SELECT state, reservation_id FROM model_requests WHERE request_id=?").get(reqId);
  const resRow = db.prepare("SELECT state FROM budget_reservations WHERE id=?").get(reqRow.reservation_id);
  const taskAcc = ledger.accountRow(`acct:task:${claim.taskId}`);
  const dayAcc = ledger.accountRow(ledger.ensureDayAccount({ now }).accountId);
  const releaseAudit = db.prepare("SELECT count(*) c FROM audit_log WHERE code='budget_released'").get().c;
  const afterHits = readServiceLog().length;
  db.close();

  suite.check(
    "t4-pre-call-cancel-releases-held-zero-fee-zero-calls",
    out.released === true &&
      reqRow?.state === "FAILED" &&
      resRow?.state === "RELEASED" &&
      taskAcc.held_microusd === 0 &&
      taskAcc.spent_microusd === 0 &&
      dayAcc.held_microusd === 0 &&
      dayAcc.spent_microusd === 0 &&
      releaseAudit === 1 &&
      afterHits === beforeHits,
    `req=${reqRow?.state} res=${resRow?.state} taskHeld=${taskAcc.held_microusd} dayHeld=${dayAcc.held_microusd} releaseAudit=${releaseAudit} calls=${afterHits - beforeHits}`,
  );
}

// ---------------------------------------------------------------------------
// 6. T5 & T6 & T7 — Real SIGKILL crashpoints + recovery/late-settlement
// Helper child runner script for crashpoints.
const crashHelperPath = join(repoRoot, "workspace-state", "phase3", "mp-crash-helper.mjs");
writeFileSync(
  crashHelperPath,
  `
import { readFileSync } from "node:fs";
import { openDatabase } from ${JSON.stringify(pathToFileURL(join(repoRoot, "apps", "daemon", "src", "db", "connect.mjs")).href)};
import { createBudgetLedger } from ${JSON.stringify(pathToFileURL(join(repoRoot, "apps", "daemon", "src", "budget.mjs")).href)};
import { processModelRequest } from ${JSON.stringify(pathToFileURL(join(repoRoot, "apps", "daemon", "src", "model-requests.mjs")).href)};

const [dbPath, stateDir, configPath, envPath, commandsDir] = process.argv.slice(2);
const db = openDatabase(dbPath);
const rawCfg = JSON.parse(readFileSync(configPath, "utf8"));
const env = JSON.parse(readFileSync(envPath, "utf8"));
const ledger = createBudgetLedger(db, { taskLimitMicrousd: 800000, dayLimitMicrousd: 5000000, warmingEnabled: false, timeZone: rawCfg.time.timezoneIANA });
processModelRequest(db, { stateDir, config: { model: rawCfg.model }, ledger, envelope: env, hostCommandsDir: commandsDir, now: Date.now() });
`,
  "utf8",
);

// T5: Crash between RESERVED and EXECUTING -> stays RESERVED + HELD across restart (even past 15m timeout, NEVER CHARGED_BOUND!), 0 calls, then release on abandon.
{
  const { ws, db, canonical, claim, commandsDir, now } = seedRunningClaim("mp-t5");
  const configPath = writeTestConfig(ws);
  const reqId = randomUUID();
  const envPath = join(ws.stateDir, "env.json");
  writeFileSync(envPath, JSON.stringify(makeEnvelope(claim, { requestId: reqId })), "utf8");
  db.close();

  const marker = join(ws.stateDir, "crash.marker");
  const beforeHits = readServiceLog().length;
  const child = spawnSync(
    process.execPath,
    [crashHelperPath, ws.dbPath, ws.stateDir, configPath, envPath, commandsDir],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AEGISPI_CRASH_POINT: "model_requests:after-reserve-before-executing",
        AEGISPI_CRASH_MARKER: marker,
      },
    },
  );
  const markerOk = existsSync(marker) && readFileSync(marker, "utf8") === "model_requests:after-reserve-before-executing";

  // Restart recovery even past unknownUsageTimeoutMs: T5 MUST remain RESERVED + HELD (never CHARGED_BOUND!).
  const db2 = openDatabase(ws.dbPath);
  startupRecovery(db2, { stateDir: ws.stateDir, canonical, now: now + 20 * 60 * 1000, unknownUsageTimeoutMs: 15 * 60 * 1000 });
  const reqRestart = db2.prepare("SELECT state, reservation_id FROM model_requests WHERE request_id=?").get(reqId);
  const resRestart = db2.prepare("SELECT state, actual_microusd FROM budget_reservations WHERE id=?").get(reqRestart.reservation_id);

  // Abandon attempt -> release pre-call reservation -> FAILED + RELEASED, zero fee.
  const ledger2 = createBudgetLedger(db2, { taskLimitMicrousd: 800000, dayLimitMicrousd: 5000000, warmingEnabled: false, timeZone: "Asia/Hong_Kong" });
  const abandoned = cancelPreCallModelRequest(db2, { ledger: ledger2, requestId: reqId, reason: "attempt_abandoned", now: now + 21 * 60 * 1000 });
  const reqAfter = db2.prepare("SELECT state FROM model_requests WHERE request_id=?").get(reqId);
  const resAfter = db2.prepare("SELECT state FROM budget_reservations WHERE id=?").get(reqRestart.reservation_id);
  const taskAcc = ledger2.accountRow(`acct:task:${claim.taskId}`);
  const afterHits = readServiceLog().length;
  db2.close();

  suite.check(
    "t5-crash-between-reserve-and-executing-keeps-held-never-charged-bound-releases-on-abandon",
    markerOk &&
      child.status !== 0 &&
      reqRestart?.state === "RESERVED" &&
      resRestart?.state === "HELD" &&
      abandoned.released === true &&
      reqAfter?.state === "FAILED" &&
      resAfter?.state === "RELEASED" &&
      taskAcc.held_microusd === 0 &&
      taskAcc.spent_microusd === 0 &&
      afterHits === beforeHits,
    `marker=${markerOk} restart=${reqRestart?.state}/${resRestart?.state} abandoned=${reqAfter?.state}/${resAfter?.state} spent=${taskAcc.spent_microusd} calls=${afterHits - beforeHits}`,
  );
}

// T6: Crash after EXECUTING commit -> stays EXECUTING + HELD, conservative timeout -> CHARGED_BOUND 1000 u$ (split 500/500), never released or replayed.
{
  const { ws, db, canonical, claim, commandsDir, now } = seedRunningClaim("mp-t6");
  const configPath = writeTestConfig(ws);
  const reqId = randomUUID();
  const envPath = join(ws.stateDir, "env.json");
  writeFileSync(envPath, JSON.stringify(makeEnvelope(claim, { requestId: reqId })), "utf8");
  db.close();

  const marker = join(ws.stateDir, "crash.marker");
  const child = spawnSync(
    process.execPath,
    [crashHelperPath, ws.dbPath, ws.stateDir, configPath, envPath, commandsDir],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AEGISPI_CRASH_POINT: "model_requests:after-executing-before-call",
        AEGISPI_CRASH_MARKER: marker,
      },
    },
  );
  const markerOk = existsSync(marker) && readFileSync(marker, "utf8") === "model_requests:after-executing-before-call";

  const db2 = openDatabase(ws.dbPath);
  startupRecovery(db2, { stateDir: ws.stateDir, canonical, now: now + 1000, unknownUsageTimeoutMs: 15 * 60 * 1000 });
  const reqPreTimeout = db2.prepare("SELECT state, reservation_id FROM model_requests WHERE request_id=?").get(reqId);
  const resPreTimeout = db2.prepare("SELECT state FROM budget_reservations WHERE id=?").get(reqPreTimeout.reservation_id);

  // Conservative timeout -> CHARGED_BOUND (1000 u$ split across task & day accounts)
  startupRecovery(db2, { stateDir: ws.stateDir, canonical, now: now + 20 * 60 * 1000, unknownUsageTimeoutMs: 15 * 60 * 1000 });
  const reqPostTimeout = db2.prepare("SELECT state FROM model_requests WHERE request_id=?").get(reqId);
  const resPostTimeout = db2.prepare("SELECT state, actual_microusd FROM budget_reservations WHERE id=?").get(reqPreTimeout.reservation_id);
  const taskAcc = db2.prepare("SELECT spent_microusd, held_microusd FROM budget_accounts WHERE id=?").get(`acct:task:${claim.taskId}`);
  let releaseBlocked = false;
  try {
    const ledger2 = createBudgetLedger(db2, {});
    cancelPreCallModelRequest(db2, { ledger: ledger2, requestId: reqId, now });
  } catch {
    releaseBlocked = true;
  }
  db2.close();

  suite.check(
    "t6-crash-after-executing-stays-executing-then-charged-bound-1000",
    markerOk &&
      child.status !== 0 &&
      reqPreTimeout?.state === "EXECUTING" &&
      resPreTimeout?.state === "HELD" &&
      reqPostTimeout?.state === "EXECUTING" &&
      resPostTimeout?.state === "CHARGED_BOUND" &&
      resPostTimeout?.actual_microusd === 1000 &&
      taskAcc?.spent_microusd === 500 &&
      taskAcc?.held_microusd === 0 &&
      releaseBlocked,
    `preTimeout=${reqPreTimeout?.state}/${resPreTimeout?.state} postTimeout=${reqPostTimeout?.state}/${resPostTimeout?.state}(${resPostTimeout?.actual_microusd}u$) taskSpent=${taskAcc?.spent_microusd} releaseBlocked=${releaseBlocked}`,
  );
}

// T7: Crash after call completed & usage obtained, before write-back commit ->
// late usage pure ledger settle once (28 u$, zero second loopback call), replay dropped & audited.
{
  setServiceMode({ kind: "priced", promptTokens: 40, completionTokens: 13, reply: "t7-late-reply" });
  const { ws, db, canonical, claim, commandsDir, now } = seedRunningClaim("mp-t7");
  const configPath = writeTestConfig(ws);
  const reqId = randomUUID();
  const envPath = join(ws.stateDir, "env.json");
  const capturePath = join(ws.stateDir, "t7-capture.json");
  writeFileSync(envPath, JSON.stringify(makeEnvelope(claim, { requestId: reqId })), "utf8");
  db.close();

  const marker = join(ws.stateDir, "crash.marker");
  const beforeHits = readServiceLog().length;
  spawnSync(
    process.execPath,
    [crashHelperPath, ws.dbPath, ws.stateDir, configPath, envPath, commandsDir],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AEGISPI_CRASH_POINT: "model_requests:after-call-before-writeback",
        AEGISPI_CRASH_MARKER: marker,
        AEGISPI_T7_CAPTURE_PATH: capturePath,
      },
    },
  );
  const markerOk = existsSync(marker) && readFileSync(marker, "utf8") === "model_requests:after-call-before-writeback";
  const captured = JSON.parse(readFileSync(capturePath, "utf8"));
  const hitsAfterCrash = readServiceLog().length - beforeHits;

  const db2 = openDatabase(ws.dbPath);
  startupRecovery(db2, { stateDir: ws.stateDir, canonical, now: now + 1000, unknownUsageTimeoutMs: 15 * 60 * 1000 });
  const ledger2 = createBudgetLedger(db2, { taskLimitMicrousd: 800000, dayLimitMicrousd: 5000000, warmingEnabled: false, timeZone: "Asia/Hong_Kong" });
  const config2 = loadConfigObj(configPath);
  const reqBefore = db2.prepare("SELECT state FROM model_requests WHERE request_id=?").get(reqId);
  const resBefore = db2.prepare("SELECT state FROM budget_reservations WHERE request_key=?").get(`model:${reqId}`);

  const late1 = settleLateModelUsage(db2, {
    stateDir: ws.stateDir,
    ledger: ledger2,
    requestId: reqId,
    usage: captured.call.usage,
    reply: captured.call.reply,
    priceCatalog: config2.model.priceCatalog,
    hostCommandsDir: commandsDir,
    now: now + 2000,
  });
  const late2 = settleLateModelUsage(db2, {
    stateDir: ws.stateDir,
    ledger: ledger2,
    requestId: reqId,
    usage: captured.call.usage,
    reply: captured.call.reply,
    priceCatalog: config2.model.priceCatalog,
    hostCommandsDir: commandsDir,
    now: now + 3000,
  });
  const reqAfter = db2.prepare("SELECT state FROM model_requests WHERE request_id=?").get(reqId);
  const resAfter = db2.prepare("SELECT state, actual_microusd FROM budget_reservations WHERE request_key=?").get(`model:${reqId}`);
  const lateAudits = db2.prepare("SELECT count(*) c FROM audit_log WHERE code='model_late_usage_settled'").get().c;
  const droppedAudits = db2.prepare("SELECT count(*) c FROM audit_log WHERE code='model_late_usage_dropped'").get().c;
  const totalHits = readServiceLog().length - beforeHits;
  db2.close();

  suite.check(
    "t7-late-usage-pure-ledger-settles-once-zero-second-call",
    markerOk &&
      hitsAfterCrash === 1 &&
      reqBefore?.state === "EXECUTING" &&
      resBefore?.state === "HELD" &&
      late1.settled === true &&
      late1.state === "SETTLED" &&
      late2.settled === false &&
      late2.status === "dropped" &&
      reqAfter?.state === "SETTLED" &&
      resAfter?.state === "SETTLED" &&
      resAfter?.actual_microusd === 28 &&
      lateAudits === 1 &&
      droppedAudits === 1 &&
      totalHits === 1,
    `hitsAfterCrash=${hitsAfterCrash} totalHits=${totalHits} before=${reqBefore?.state}/${resBefore?.state} after=${reqAfter?.state}/${resAfter?.state}(${resAfter?.actual_microusd}u$) lateAudits=${lateAudits} dropped=${droppedAudits}`,
  );
}

rmSync(crashHelperPath, { force: true });

// ---------------------------------------------------------------------------
// 7. T8 — Missing usage & all-zero usage -> request HELD + ledger HELD (dual namespace)
{
  const { ws, db, ledger, claim, commandsDir, now } = seedRunningClaim("mp-t8");
  const config = loadConfigObj(writeTestConfig(ws));
  const beforeHits = readServiceLog().length;

  setServiceMode({ kind: "no-usage", reply: "no-usage-t8" });
  const r1Id = randomUUID();
  const out1 = processModelRequest(db, { stateDir: ws.stateDir, config, ledger, envelope: makeEnvelope(claim, { requestId: r1Id }), hostCommandsDir: commandsDir, now });

  setServiceMode({ kind: "priced", promptTokens: 0, completionTokens: 0, reply: "all-zero-t8" });
  const r2Id = randomUUID();
  const out2 = processModelRequest(db, { stateDir: ws.stateDir, config, ledger, envelope: makeEnvelope(claim, { requestId: r2Id }), hostCommandsDir: commandsDir, now: now + 10 });

  // Duplicate usage arriving at request-HELD must drop (late entry only accepts EXECUTING+HELD).
  const dupLate = settleLateModelUsage(db, {
    stateDir: ws.stateDir,
    ledger,
    requestId: r1Id,
    usage: { inputTokens: 40, outputTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, totalFromProvider: false },
    priceCatalog: config.model.priceCatalog,
    now: now + 20,
  });

  const row1 = db.prepare("SELECT state, reservation_id FROM model_requests WHERE request_id=?").get(r1Id);
  const res1 = db.prepare("SELECT state FROM budget_reservations WHERE id=?").get(row1.reservation_id);
  const row2 = db.prepare("SELECT state, reservation_id FROM model_requests WHERE request_id=?").get(r2Id);
  const res2 = db.prepare("SELECT state FROM budget_reservations WHERE id=?").get(row2.reservation_id);
  const notSettledCount = db.prepare("SELECT count(*) c FROM audit_log WHERE code='model_usage_not_settled'").get().c;
  const afterHits = readServiceLog().length;
  db.close();

  suite.check(
    "t8-missing-and-zero-usage-both-namespaces-held",
    out1.state === "HELD" &&
      row1?.state === "HELD" &&
      res1?.state === "HELD" &&
      out2.state === "HELD" &&
      row2?.state === "HELD" &&
      res2?.state === "HELD" &&
      dupLate.status === "dropped" &&
      notSettledCount === 2 &&
      afterHits - beforeHits === 2,
    `missing=${row1?.state}/${res1?.state} zero=${row2?.state}/${res2?.state} dupLate=${dupLate.status} notSettled=${notSettledCount} calls=${afterHits - beforeHits}`,
  );
}

// ---------------------------------------------------------------------------
// 8. T9 — Legal zeros (10/0 -> 3 u$) & per-category pricing (cacheWrite>0 with null -> HELD)
{
  const { ws, db, ledger, claim, commandsDir, now } = seedRunningClaim("mp-t9");
  const config = loadConfigObj(writeTestConfig(ws));
  const beforeHits = readServiceLog().length;

  setServiceMode({ kind: "priced", promptTokens: 10, completionTokens: 0, reply: "t9-sub1" });
  const r1Id = randomUUID();
  const out1 = processModelRequest(db, { stateDir: ws.stateDir, config, ledger, envelope: makeEnvelope(claim, { requestId: r1Id }), hostCommandsDir: commandsDir, now });

  setServiceMode({ kind: "priced", promptTokens: 10, completionTokens: 0, cacheWriteTokens: 5, reply: "t9-sub2" });
  const r2Id = randomUUID();
  const out2 = processModelRequest(db, { stateDir: ws.stateDir, config, ledger, envelope: makeEnvelope(claim, { requestId: r2Id }), hostCommandsDir: commandsDir, now: now + 10 });

  const row1 = db.prepare("SELECT state, reservation_id FROM model_requests WHERE request_id=?").get(r1Id);
  const res1 = db.prepare("SELECT state, actual_microusd FROM budget_reservations WHERE id=?").get(row1.reservation_id);
  const row2 = db.prepare("SELECT state, reservation_id FROM model_requests WHERE request_id=?").get(r2Id);
  const res2 = db.prepare("SELECT state FROM budget_reservations WHERE id=?").get(row2.reservation_id);
  const notSettled = db.prepare("SELECT count(*) c FROM audit_log WHERE code='model_usage_not_settled'").get().c;
  const afterHits = readServiceLog().length;
  db.close();

  suite.check(
    "t9-legal-zero-output-settles-3-and-missing-category-rate-held",
    out1.settled === true &&
      row1?.state === "SETTLED" &&
      res1?.state === "SETTLED" &&
      res1?.actual_microusd === 3 &&
      out2.settled === false &&
      row2?.state === "HELD" &&
      res2?.state === "HELD" &&
      notSettled === 1 &&
      afterHits - beforeHits === 2,
    `sub1=${row1?.state}/${res1?.state}(${res1?.actual_microusd}u$) sub2=${row2?.state}/${res2?.state} calls=${afterHits - beforeHits}`,
  );
}

// ---------------------------------------------------------------------------
// 9. T10 — Terminal task & cost separation (ORPHAN delivery + normal billing)
{
  const { ws, db, canonical, ledger, claim, commandsDir, now } = seedRunningClaim("mp-t10");
  const config = loadConfigObj(writeTestConfig(ws));

  // Subcase 1: EXECUTING committed, task turns CANCELLED before write-back, valid usage 40/13 -> ORPHAN + ledger SETTLED 28 u$
  const r1Id = randomUUID();
  const res1 = ledger.reserve({
    requestKey: `model:${r1Id}`, taskId: claim.taskId, purpose: "worker", provider: "deepseek", priceVersion: "catalog-v1", upperMicrousd: 1000,
    accounts: [
      { accountId: ledger.ensureTaskAccount({ taskId: claim.taskId, now }).accountId, amountMicrousd: 500 },
      { accountId: ledger.ensureDayAccount({ now }).accountId, amountMicrousd: 500 },
    ],
    now,
  });
  db.prepare("INSERT INTO model_requests(request_id,task_id,attempt_id,fence,scope_domain_key,purpose,model_id,state,reservation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'EXECUTING',?,?,?)")
    .run(r1Id, claim.taskId, claim.attemptId, claim.fence, "dm:telegram:6101", "worker", "deepseek/deepseek-flash", res1.reservationId, now, now);

  // Subcase 2: EXECUTING committed, invalid usage -> ORPHAN + ledger HELD -> conservative CHARGED_BOUND 1000 u$
  const r2Id = randomUUID();
  const res2 = ledger.reserve({
    requestKey: `model:${r2Id}`, taskId: claim.taskId, purpose: "worker", provider: "deepseek", priceVersion: "catalog-v1", upperMicrousd: 1000,
    accounts: [
      { accountId: ledger.ensureTaskAccount({ taskId: claim.taskId, now }).accountId, amountMicrousd: 500 },
      { accountId: ledger.ensureDayAccount({ now }).accountId, amountMicrousd: 500 },
    ],
    now,
  });
  db.prepare("INSERT INTO model_requests(request_id,task_id,attempt_id,fence,scope_domain_key,purpose,model_id,state,reservation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'EXECUTING',?,?,?)")
    .run(r2Id, claim.taskId, claim.attemptId, claim.fence, "dm:telegram:6101", "worker", "deepseek/deepseek-flash", res2.reservationId, now, now);

  // Task becomes terminal before write-back
  db.prepare("UPDATE tasks SET state='CANCELLED', updated_at=? WHERE id=?").run(now + 5, claim.taskId);

  const out1 = settleLateModelUsage(db, {
    stateDir: ws.stateDir,
    ledger,
    requestId: r1Id,
    usage: { inputTokens: 40, outputTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, totalFromProvider: false },
    reply: "orphan valid reply",
    priceCatalog: config.model.priceCatalog,
    hostCommandsDir: commandsDir,
    now: now + 10,
  });
  const out2 = settleLateModelUsage(db, {
    stateDir: ws.stateDir,
    ledger,
    requestId: r2Id,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    reply: "orphan invalid reply",
    priceCatalog: config.model.priceCatalog,
    hostCommandsDir: commandsDir,
    now: now + 20,
  });

  // Timeout recovery charges bound on subcase 2's HELD reservation
  startupRecovery(db, { stateDir: ws.stateDir, canonical, now: now + 20 * 60 * 1000, unknownUsageTimeoutMs: 15 * 60 * 1000 });

  const req1 = db.prepare("SELECT state FROM model_requests WHERE request_id=?").get(r1Id);
  const ldg1 = db.prepare("SELECT state, actual_microusd FROM budget_reservations WHERE id=?").get(res1.reservationId);
  const req2 = db.prepare("SELECT state FROM model_requests WHERE request_id=?").get(r2Id);
  const ldg2 = db.prepare("SELECT state, actual_microusd FROM budget_reservations WHERE id=?").get(res2.reservationId);
  const orphanAudits = db.prepare("SELECT count(*) c FROM audit_log WHERE code='model_result_orphan'").get().c;
  const cmdFiles = readdirSync(commandsDir).filter((f) => f.startsWith("model-result-"));
  db.close();

  suite.check(
    "t10-terminal-task-orphan-delivery-with-normal-billing",
    out1.orphan === true &&
      out2.orphan === true &&
      req1?.state === "ORPHAN" &&
      ldg1?.state === "SETTLED" &&
      ldg1?.actual_microusd === 28 &&
      req2?.state === "ORPHAN" &&
      ldg2?.state === "CHARGED_BOUND" &&
      ldg2?.actual_microusd === 1000 &&
      orphanAudits === 2 &&
      cmdFiles.length === 0,
    `sub1=${req1?.state}/${ldg1?.state}(${ldg1?.actual_microusd}u$) sub2=${req2?.state}/${ldg2?.state}(${ldg2?.actual_microusd}u$) orphanAudits=${orphanAudits} deliveredFiles=${cmdFiles.length}`,
  );
}

// ---------------------------------------------------------------------------
// 10. Remaining boundaries: timeout -> CHARGED_BOUND, overcharge -> freeze,
//     and adapters.mjs model.inference unified execution core dispatch
{
  // (a) Timeout + Overcharge
  const { ws, db, canonical, ledger, claim, commandsDir, now } = seedRunningClaim("mp-bounds");
  const configTimeout = loadConfigObj(writeTestConfig(ws, { callTimeoutMs: 600 }));
  setServiceMode({ kind: "timeout", delayMs: 4000 });
  const tOutId = randomUUID();
  const tOutRes = processModelRequest(db, {
    stateDir: ws.stateDir,
    config: configTimeout,
    ledger,
    envelope: makeEnvelope(claim, { requestId: tOutId }),
    hostCommandsDir: commandsDir,
    now,
  });
  startupRecovery(db, { stateDir: ws.stateDir, canonical, now: now + 20 * 60 * 1000, unknownUsageTimeoutMs: 15 * 60 * 1000 });
  const tOutReq = db.prepare("SELECT state, reservation_id FROM model_requests WHERE request_id=?").get(tOutId);
  const tOutLdg = db.prepare("SELECT state, actual_microusd FROM budget_reservations WHERE id=?").get(tOutReq.reservation_id);
  const callFailedCount = db.prepare("SELECT count(*) c FROM audit_log WHERE code='model_call_failed'").get().c;

  // Overcharge: actual 2040 > upper 1000 -> SETTLED + account frozen + budget_overcharge_frozen (fresh claim so timeout recovery above doesn't reap its lease)
  const over = seedRunningClaim("mp-overcharge");
  setServiceMode({ kind: "priced", promptTokens: 2000, completionTokens: 1200, reply: "overcharge-reply" });
  const configOver = loadConfigObj(writeTestConfig(over.ws, { callUpperMicrousd: 1000 }));
  const overId = randomUUID();
  const overOut = processModelRequest(over.db, {
    stateDir: over.ws.stateDir,
    config: configOver,
    ledger: over.ledger,
    envelope: makeEnvelope(over.claim, { requestId: overId }),
    hostCommandsDir: over.commandsDir,
    now: over.now,
  });
  const overFrozen = over.db.prepare("SELECT count(*) c FROM audit_log WHERE code='budget_overcharge_frozen'").get().c;
  const taskAccOver = over.ledger.accountRow(`acct:task:${over.claim.taskId}`);
  over.db.close();

  // (b) adapters.mjs model.inference routes through the exact same pi-ai core
  setServiceMode({ kind: "priced", promptTokens: 40, completionTokens: 13, reply: "adapter-unified-reply" });
  const freshTaskAcc = ledger.ensureAccount({ id: "acct:adapter-test", periodKey: "adapter", limitMicrousd: 50000, kind: "task", now });
  const adapterRes = ledger.reserve({
    requestKey: "adp:model:1",
    taskId: claim.taskId,
    purpose: "worker",
    provider: "deepseek",
    priceVersion: "catalog-v1",
    upperMicrousd: 1000,
    accounts: [{ accountId: freshTaskAcc.accountId, amountMicrousd: 1000 }],
    now: now + 1,
  });
  const adapter = createAdapterUpstream(db, {
    baseUpstream: null,
    transportKind: "real",
    modelConfig: configOver.model,
  });
  const beforeAdapterHits = readServiceLog().length;
  const adapterOut = adapter.submit({
    businessKey: "adp:bk:1",
    idempotencyKey: "adp:idem:1",
    operation: {
      operation: "model.inference",
      provider: "deepseek",
      resource: "model://deepseek/deepseek-flash",
      action_json: JSON.stringify({
        operation: "model.inference",
        target_resource: "model://deepseek/deepseek-flash",
        purpose: "worker",
        prompt: "adapter path prompt",
      }),
    },
    reservationId: adapterRes.reservationId,
    now: now + 2,
  });
  const adapterHits = readServiceLog().slice(beforeAdapterHits);
  db.close();

  suite.check(
    "remaining-boundaries-timeout-overcharge-and-adapter-unified-core",
    tOutOut(tOutRes) &&
      tOutReq?.state === "EXECUTING" &&
      tOutLdg?.state === "CHARGED_BOUND" &&
      tOutLdg?.actual_microusd === 1000 &&
      callFailedCount === 1 &&
      overOut.settled === true &&
      overFrozen >= 1 &&
      taskAccOver.frozen === 1 &&
      adapterOut.status === "succeeded" &&
      adapterOut.model === "deepseek-flash" &&
      adapterHits.length === 1 &&
      adapterHits[0].path === "/chat/completions" &&
      adapterHits[0].thinking?.type === "enabled",
    `timeout=${tOutReq?.state}/${tOutLdg?.state}(${tOutLdg?.actual_microusd}) overchargeFrozen=${taskAccOver.frozen}/${overFrozen} adapter=${adapterOut.status}/${adapterOut.model}/${adapterHits[0]?.path}`,
  );
  function tOutOut(x) {
    return x.status === "call_failed";
  }
}

{
  const prevAmbientKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-ambient-must-never-leak";
  const { ws, db, ledger, claim, commandsDir, now } = seedRunningClaim("mp-hardening");
  createCredentialService(db).revokeSlot({ slot: "model", actorId: "audit", now: now + 1 });
  const cfgPath = writeTestConfig(ws, { allowedPurposes: ["worker", "warming"] });
  const cfg = loadConfigObj(cfgPath);
  const hitsBefore = readServiceLog().length;

  const revId = randomUUID();
  const revOut = processModelRequest(db, {
    stateDir: ws.stateDir,
    config: cfg,
    ledger,
    envelope: makeEnvelope(claim, { requestId: revId }),
    hostCommandsDir: commandsDir,
    now: now + 2,
  });
  const revHits = readServiceLog().length - hitsBefore;

  const warmId = randomUUID();
  const warmOut = processModelRequest(db, {
    stateDir: ws.stateDir,
    config: cfg,
    ledger,
    envelope: makeEnvelope(claim, { requestId: warmId, purpose: "warming" }),
    hostCommandsDir: commandsDir,
    now: now + 3,
  });

  const upperId = randomUUID().toUpperCase();
  const upperOut = processModelRequest(db, {
    stateDir: ws.stateDir,
    config: cfg,
    ledger,
    envelope: makeEnvelope(claim, { requestId: upperId }),
    hostCommandsDir: commandsDir,
    now: now + 4,
  });

  const { ws: wsExp, db: dbExp, ledger: ledgerExp, claim: claimExp, commandsDir: cmdExp, now: nowExp } = seedRunningClaim("mp-lease-exp");
  setServiceMode({ kind: "priced", promptTokens: 40, completionTokens: 13, reply: "lease-exp-reply" });
  const cfgExp = loadConfigObj(writeTestConfig(wsExp));
  dbExp.prepare("UPDATE tasks SET lease_expires_at=? WHERE id=?").run(nowExp + 100, claimExp.taskId);
  const origPrepareExp = dbExp.prepare.bind(dbExp);
  let expiredInjected = false;
  dbExp.prepare = (sql) => {
    const st = origPrepareExp(sql);
    if (!expiredInjected && sql.includes("UPDATE model_requests SET state='EXECUTING'")) {
      expiredInjected = true;
      origPrepareExp("UPDATE tasks SET lease_expires_at=? WHERE id=?").run(nowExp - 10, claimExp.taskId);
    }
    return st;
  };
  const expId = randomUUID();
  const expOut = processModelRequest(dbExp, {
    stateDir: wsExp.stateDir,
    config: cfgExp,
    ledger: ledgerExp,
    envelope: makeEnvelope(claimExp, { requestId: expId }),
    hostCommandsDir: cmdExp,
    completeActiveTask: true,
    now: nowExp,
  });
  const expReq = origPrepareExp("SELECT state FROM model_requests WHERE request_id=?").get(expId);
  const expRes = origPrepareExp("SELECT state, actual_microusd FROM budget_reservations WHERE request_key=?").get(`model:${expId}`);
  dbExp.close();

  const compA = safeTaskDirComponent("tsk:inb%3Agithub%3Aorg/repo-long-name-12345/pr/1:opened");
  const compB = safeTaskDirComponent("tsk:inb%3Agithub%3Aorg/repo-long-name-12345/pr/1:sync");
  const compSlash = safeTaskDirComponent("tsk:a/b");
  const compColon = safeTaskDirComponent("tsk:a:b");
  const aclExplicitDir = join(ws.stateDir, "acl-explicit-probe");
  mkdirSync(aclExplicitDir, { recursive: true });
  if (process.platform === "win32") {
    spawnSync("icacls", [aclExplicitDir, "/grant", "NT AUTHORITY\\INTERACTIVE:(OI)(CI)F"], { encoding: "utf8" });
  }
  lockHostProposalsDir(aclExplicitDir);
  const aclExplicitVerified = inspectHostProposalsAcl(aclExplicitDir);

  const hitsAfter = readServiceLog().length;
  db.close();
  if (prevAmbientKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = prevAmbientKey;

  suite.check(
    "adversarial-hardening-invariants",
    revOut.status === "call_failed" &&
      revHits === 0 &&
      hitsAfter === hitsBefore + 1 &&
      warmOut.code === "warming_disabled" &&
      warmOut.rowCreated === false &&
      upperOut.code === "invalid_request_id" &&
      upperOut.rowCreated === false &&
      expOut.orphan === true &&
      expReq?.state === "ORPHAN" &&
      expRes?.state === "SETTLED" &&
      expRes?.actual_microusd === 28 &&
      compA !== compB &&
      compSlash !== compColon &&
      compA.length <= 45 &&
      aclExplicitVerified.ok === true,
    `revoked=${revOut.status} warm=${warmOut.code} upper=${upperOut.code} leaseExp=${expReq?.state}/${expRes?.state}(${expRes?.actual_microusd}) compsUnique=${compA !== compB && compSlash !== compColon} explicitAclCleaned=${aclExplicitVerified.ok}`,
  );
}

svc.kill();

writeReport({
  suiteId: "model-proposal",
  suite,
  label: "test:model-proposal — Phase 4.1 模型提议链路全量本地闭环与 T1–T10 矩阵",
  extra: {
    dataSources: "digest 钉住 agent 容器（--network none / PI_OFFLINE=1 / 只读 rootfs / 宿主 ACL 锁定 proposals）+ 真实 daemon tick + pi-ai 1.5.2 子进程 + 本地 OpenAI SSE 环回服务 + 真实 SQLite 账本与 crashpoint 注入；零真实推理服务调用，未读 .env",
  },
});
process.exit(suiteExit(suite, { label: "test:model-proposal" }));
