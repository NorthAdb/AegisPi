import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  repoRoot,
  suiteExit,
  writeReport,
} from "../lib/harness.mjs";
import { imageRef, requireAppImageDigests } from "../lib/image-gate.mjs";
import { loadDaemonConfig } from "../../../apps/daemon/src/config.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { ensureModelRequestsTable, loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { dispatchKeyForInbox, receiveEvent } from "../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { claimNextTask, heartbeat } from "../../../apps/daemon/src/scheduler.mjs";
import { createBudgetLedger } from "../../../apps/daemon/src/budget.mjs";
import { createCredentialService } from "../../../apps/daemon/src/credentials.mjs";
import { processModelRequest, processModelRequestAsync } from "../../../apps/daemon/src/model-requests.mjs";
import { authorizeAcquisitionTarget, buildSafeRepoExcerpt, executeRepoObserveAcquisition } from "../../../apps/daemon/src/repo-observe.mjs";
import { agentWorkAttemptDir, createAcquisitionLauncher, lockHostProposalsDir, safeTaskDirComponent } from "../../../apps/daemon/src/container-executor.mjs";

lockedNodeGuard();

const { digests } = await requireAppImageDigests();
const AGENT_REF = imageRef("agent", digests);
const ACQUISITION_REF = imageRef("acquisition", digests);

const suite = makeSuite("repo-observe");
process.env.AEGISPI_TEST_MODEL_KEY = "loopback-fixture-placeholder";

function tarEntry({ name, type = "0", content = Buffer.alloc(0), linkName = "", mode = "0000644" }) {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, "utf8");
  header.write(mode, 100, "utf8");
  header.write("0000000", 108, "utf8");
  header.write("0000000", 116, "utf8");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  header.write("00000000000", 136, "utf8");
  header.write(type, 156, "utf8");
  header.write(linkName.slice(0, 100), 157, "utf8");
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  let checksum = 0;
  for (let i = 0; i < 512; i += 1) {
    checksum += i >= 148 && i < 156 ? 32 : header[i];
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  const blocks = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(blocks);
  return Buffer.concat([header, blocks]);
}

function buildTarGz(entries) {
  const tar = Buffer.concat([...entries.map((e) => tarEntry(e)), Buffer.alloc(1024)]);
  const gz = gzipSync(tar);
  return { gz, sha256: createHash("sha256").update(gz).digest("hex") };
}

const goodArchive = buildTarGz([
  { name: "src/", type: "5", mode: "0000755" },
  {
    name: "src/app.mjs",
    type: "0",
    content: Buffer.from(
      "export const hint = 'sk-fixturesecretvalue987654321';\nexport function status() { return 'ok'; }\n",
      "utf8",
    ),
  },
  {
    name: "package-lock.json",
    type: "0",
    content: Buffer.from('{"name":"fixture-alpha","lockfileVersion":3}\n', "utf8"),
  },
]);

const symlinkArchive = buildTarGz([
  { name: "src/", type: "5", mode: "0000755" },
  { name: "src/app.mjs", type: "0", content: Buffer.from("export const ok = true;\n", "utf8") },
  { name: "src/escape-link", type: "2", linkName: "../../../../etc/passwd" },
]);

let acqHits = [];
const acqServer = createServer((req, res) => {
  acqHits.push(req.url);
  if (req.url === "/good.tar.gz") {
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(goodArchive.gz);
    return;
  }
  if (req.url === "/symlink.tar.gz") {
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(symlinkArchive.gz);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((resolve) => acqServer.listen(0, "0.0.0.0", resolve));
const acqPort = acqServer.address().port;

const servicePath = join(repoRoot, "evals", "phase3", "security-unit", "helpers", "local-model-service.mjs");
const serviceWs = makeWorkspace("ro-loopback-svc");
const portFile = join(serviceWs.stateDir, "port.txt");
const logFile = join(serviceWs.stateDir, "log.jsonl");
const modeFile = join(serviceWs.stateDir, "mode.json");
const svc = spawn(process.execPath, [servicePath, portFile, logFile, modeFile], { stdio: "ignore" });
for (let i = 0; i < 100 && !existsSync(portFile); i += 1) {
  await new Promise((r) => setTimeout(r, 100));
}
if (!existsSync(portFile)) {
  svc.kill();
  acqServer.close();
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

function writeObserveConfig(
  ws,
  {
    modelBaseUrl = baseUrl,
    allowRealModelCalls = false,
    maxInputBytes = 4096,
    maxOutputTokens = 128,
    priceInput = 300000,
    priceOutput = 1200000,
    allowRealRepoFetch = true,
    enableHostGateway = true,
    allowedHosts = ["host.docker.internal"],
    targets = {},
  } = {},
) {
  const defaults = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
  defaults.model = {
    ...defaults.model,
    baseUrl: modelBaseUrl,
    allowedPurposes: ["worker"],
    allowedModelIds: ["deepseek/deepseek-flash"],
    allowRealModelCalls,
    callUpperMicrousd: 1000,
    callTimeoutMs: 10000,
    maxInputBytes,
    maxOutputTokens,
    priceCatalog: {
      inputPerMTokMicrousd: priceInput,
      outputPerMTokMicrousd: priceOutput,
      cacheReadPerMTokMicrousd: null,
      cacheWritePerMTokMicrousd: null,
    },
  };
  delete defaults.model.priceCatalog.$comment;
  defaults.acquisition = {
    ...defaults.acquisition,
    allowRealRepoFetch,
    enableHostGateway,
    allowedHosts,
    targets,
  };
  const p = join(ws.stateDir, "test-config.json");
  writeFileSync(p, JSON.stringify(defaults, null, 2), "utf8");
  return p;
}

function seedObserveWorkspace(tag, { payload, claimLeaseMs = null, now = Date.now() } = {}) {
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
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    verdict: "ADMIT",
  });
  const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
  const disp = dispatchEventToTask(db, {
    inboxId: inbox.id,
    dispatchKey: dispatchKeyForInbox(inbox),
    now,
    priority: 5,
    maxSteps: 25,
    deadlineAt: now + 15 * 60 * 1000,
    skillSetHash: "ss-p42",
  });
  createCredentialService(db).registerSlot({
    slot: "model",
    purpose: "model",
    source: "deepseek",
    envName: "AEGISPI_TEST_MODEL_KEY",
    actorId: "test-fixture",
    now,
  });
  if (claimLeaseMs === null) {
    db.close();
    return { ws, taskId: disp.taskId, now };
  }
  const claim = claimNextTask(db, { now, leaseMs: Math.max(claimLeaseMs, 10000) });
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
  const claimNow = Date.now();
  heartbeat(db, { ...claim, now: claimNow, leaseMs: claimLeaseMs });
  return { ws, db, canonical, ledger, claim, commandsDir, now: claimNow };
}

function runDaemonOnce(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [daemonPath, "--once", ...args], {
      cwd: repoRoot,
      env: { ...process.env, AEGISPI_TEST_MODEL_KEY: "loopback-fixture-placeholder", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 90000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

const GOOD_TARGET = {
  repo: "NorthAdb/fixture-alpha",
  url: `http://host.docker.internal:${acqPort}/good.tar.gz`,
  ref: "v1.0.0",
  sha256: goodArchive.sha256,
  mode: "tar",
  readPaths: ["src/app.mjs", "package-lock.json"],
};

try {
  {
    setServiceMode({ kind: "priced", promptTokens: 40, completionTokens: 13, reply: "OBSERVE_OK_SUMMARY" });
    const { ws, taskId } = seedObserveWorkspace("ro-e2e", {
      payload: { kind: "repo_observe", targetId: "fixture-alpha", question: "Check app.mjs and lockfile" },
    });
    const configPath = writeObserveConfig(ws, { targets: { "fixture-alpha": GOOD_TARGET } });
    const beforeHits = readServiceLog().length;
    const beforeAcq = acqHits.length;

    const dRun = await runDaemonOnce([
      `--data-dir=${ws.stateDir}`,
      `--config=${configPath}`,
      `--agent-image=${AGENT_REF}`,
      `--acquisition-image=${ACQUISITION_REF}`,
    ]);

    const hits = readServiceLog().slice(beforeHits);
    const acqDelta = acqHits.slice(beforeAcq);
    const db = openDatabase(ws.dbPath, { readOnly: true });
    const task = db.prepare("SELECT state, result_object_id FROM tasks WHERE id=?").get(taskId);
    const req = db.prepare("SELECT state, reservation_id FROM model_requests WHERE task_id=?").get(taskId);
    const resRow = req?.reservation_id
      ? db.prepare("SELECT state, actual_microusd FROM budget_reservations WHERE id=?").get(req.reservation_id)
      : null;
    const manifestObj = db
      .prepare("SELECT id, storage_ref FROM objects WHERE kind='repo_observe_manifest' ORDER BY observed_at DESC LIMIT 1")
      .get();
    const edgeRow =
      task?.result_object_id && manifestObj?.id
        ? db
            .prepare("SELECT relation FROM object_edges WHERE parent_id=? AND child_id=?")
            .get(manifestObj.id, task.result_object_id)
        : null;
    const acqDone = db
      .prepare("SELECT details_json FROM audit_log WHERE code='acquisition_completed' AND task_id=?")
      .get(taskId);
    db.close();

    const manifestJson = manifestObj?.storage_ref
      ? JSON.parse(readFileSync(join(ws.stateDir, ...manifestObj.storage_ref.split("/")), "utf8"))
      : null;
    const auditDetails = acqDone?.details_json ? JSON.parse(acqDone.details_json) : null;
    const excerptContent = manifestJson?.files?.[0]?.excerpt ?? "";
    const leftAcqWorkDirs = existsSync(join(ws.stateDir, "acquisitions"))
      ? readdirSync(join(ws.stateDir, "acquisitions"))
      : [];
    const leftoverContainers = spawnSync(
      "docker",
      ["ps", "-aq", "--filter", `label=aegispi.state_dir=${ws.stateDir}`],
      { encoding: "utf8" },
    );
    const volName = `aegispi-acq-out-${safeTaskDirComponent(`${taskId}:1`)}`.slice(0, 90);
    const leftoverVol = spawnSync("docker", ["volume", "ls", "-q", "--filter", `name=${volName}`], { encoding: "utf8" });

    const firstPrompt = hits[0]?.input ?? "";
    const excerptIdx = firstPrompt.indexOf("Sanitized Read-Only Excerpts:");
    const questionIdx = firstPrompt.indexOf("\n\nTask Question: Check app.mjs and lockfile");

    suite.check(
      "repo-observe-e2e-acquisition-to-settled-28",
      dRun.status === 0 &&
        acqDelta.includes("/good.tar.gz") &&
        hits.length === 1 &&
        hits[0].max_tokens === 128 &&
        hits[0].thinking?.type === "enabled" &&
        excerptIdx >= 0 &&
        questionIdx > excerptIdx &&
        task?.state === "SUCCEEDED" &&
        req?.state === "SETTLED" &&
        resRow?.state === "SETTLED" &&
        resRow?.actual_microusd === 28 &&
        manifestJson?.archiveSha256 === `sha256:${goodArchive.sha256}` &&
        manifestJson?.readOnly === true &&
        manifestJson?.repoWrites === 0 &&
        manifestJson?.fullRepoPersisted === false &&
        excerptContent.includes("[REDACTED_KEY]") &&
        !excerptContent.includes("sk-fixturesecretvalue987654321") &&
        edgeRow?.relation === "derived_from" &&
        auditDetails?.repo_writes === 0 &&
        leftAcqWorkDirs.length === 0 &&
        leftoverContainers.stdout.trim() === "" &&
        leftoverVol.stdout.trim() === "",
      `exit=${dRun.status} task=${task?.state} req=${req?.state} res=${resRow?.state}(${resRow?.actual_microusd}) maxTok=${hits[0]?.max_tokens} prefixBeforeQ=${excerptIdx < questionIdx} redacted=${excerptContent.includes("[REDACTED_KEY]")} edge=${edgeRow?.relation} leftDirs=${leftAcqWorkDirs.length} err=${dRun.stderr.slice(0, 200)}`,
    );
  }

  {
    const baseCfg = {
      acquisition: {
        allowRealRepoFetch: false,
        enableHostGateway: false,
        allowedHosts: ["host.docker.internal"],
        maxFiles: 32,
        targets: { "fixture-alpha": GOOD_TARGET },
      },
    };
    const rUnlisted = authorizeAcquisitionTarget({ config: baseCfg, targetId: "missing", hasAcquisitionLauncher: true });
    const rDisabled = authorizeAcquisitionTarget({ config: baseCfg, targetId: "fixture-alpha", hasAcquisitionLauncher: true });
    const rBadHost = authorizeAcquisitionTarget({
      config: { ...baseCfg, acquisition: { ...baseCfg.acquisition, allowRealRepoFetch: true, allowedHosts: [] } },
      targetId: "fixture-alpha",
      hasAcquisitionLauncher: true,
    });

    const { ws, db, ledger, claim, commandsDir, now } = seedObserveWorkspace("ro-failclosed-caps", {
      payload: "claim ro-failclosed-caps",
      claimLeaseMs: 120000,
    });
    const cfgPath = writeObserveConfig(ws, {
      modelBaseUrl: "https://api.deepseek.com",
      allowRealModelCalls: true,
      maxInputBytes: null,
      maxOutputTokens: null,
    });
    const cfg = loadDaemonConfig({ path: cfgPath });
    const beforeHits = readServiceLog().length;
    const capOut = processModelRequest(db, {
      stateDir: ws.stateDir,
      config: cfg,
      ledger,
      envelope: {
        schemaVersion: 1,
        kind: "model_request",
        requestId: randomUUID(),
        taskId: claim.taskId,
        attemptId: claim.attemptId,
        fence: claim.fence,
        scopeDomainKey: "dm:telegram:6101",
        purpose: "worker",
        modelId: "deepseek/deepseek-flash",
        messages: [{ role: "user", content: "hello" }],
      },
      hostCommandsDir: commandsDir,
      now,
    });
    const rowsAfter = db.prepare("SELECT count(*) c FROM model_requests").get().c;
    const resAfter = db.prepare("SELECT count(*) c FROM budget_reservations").get().c;
    db.close();

    const { ws: ws2, taskId: unlistedTaskId } = seedObserveWorkspace("ro-unlisted-daemon", {
      payload: { kind: "repo_observe", targetId: "not-in-allowlist" },
    });
    const cfgPath2 = writeObserveConfig(ws2, { targets: { "fixture-alpha": GOOD_TARGET } });
    const beforeAcq = acqHits.length;
    const beforeModel2 = readServiceLog().length;
    const dUnlisted = await runDaemonOnce([
      `--data-dir=${ws2.stateDir}`,
      `--config=${cfgPath2}`,
      `--agent-image=${AGENT_REF}`,
      `--acquisition-image=${ACQUISITION_REF}`,
    ]);
    const db2 = openDatabase(ws2.dbPath, { readOnly: true });
    const t2 = db2
      .prepare("SELECT t.state, a.error_code FROM tasks t LEFT JOIN attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no WHERE t.id=?")
      .get(unlistedTaskId);
    const req2Count = db2.prepare("SELECT count(*) c FROM model_requests").get().c;
    const refusedAudit = db2.prepare("SELECT count(*) c FROM audit_log WHERE code='acquisition_refused'").get().c;
    db2.close();

    suite.check(
      "fail-closed-targets-hosts-and-nonloopback-token-caps",
      rUnlisted.code === "acquisition_target_not_allowed" &&
        rDisabled.code === "acquisition_real_fetch_disabled" &&
        rBadHost.code === "acquisition_host_not_allowed" &&
        capOut.accepted === false &&
        capOut.code === "token_caps_not_configured" &&
        capOut.rowCreated === false &&
        rowsAfter === 0 &&
        resAfter === 0 &&
        readServiceLog().length === beforeHits &&
        dUnlisted.status === 0 &&
        t2?.state === "FAILED" &&
        t2?.error_code === "acquisition_target_not_allowed" &&
        req2Count === 0 &&
        refusedAudit === 1 &&
        acqHits.length === beforeAcq &&
        readServiceLog().length === beforeModel2,
      `unlisted=${rUnlisted.code} disabled=${rDisabled.code} badHost=${rBadHost.code} cap=${capOut.code} daemonTask=${t2?.state}/${t2?.error_code}`,
    );
  }

  {
    const { ws, db, ledger, claim, commandsDir, now } = seedObserveWorkspace("ro-input-cap", {
      payload: "claim ro-input-cap",
      claimLeaseMs: 120000,
    });
    const cfgPath = writeObserveConfig(ws, { maxInputBytes: 64, maxOutputTokens: 128 });
    const cfg = loadDaemonConfig({ path: cfgPath });
    const beforeHits = readServiceLog().length;
    const out = processModelRequest(db, {
      stateDir: ws.stateDir,
      config: cfg,
      ledger,
      envelope: {
        schemaVersion: 1,
        kind: "model_request",
        requestId: randomUUID(),
        taskId: claim.taskId,
        attemptId: claim.attemptId,
        fence: claim.fence,
        scopeDomainKey: "dm:telegram:6101",
        purpose: "worker",
        modelId: "deepseek/deepseek-flash",
        messages: [{ role: "user", content: "x".repeat(200) }],
      },
      hostCommandsDir: commandsDir,
      now,
    });
    const rows = db.prepare("SELECT count(*) c FROM model_requests").get().c;
    const res = db.prepare("SELECT count(*) c FROM budget_reservations").get().c;
    db.close();

    suite.check(
      "model-max-input-bytes-pre-row-refusal",
      out.accepted === false &&
        out.code === "input_bytes_exceeded" &&
        out.rowCreated === false &&
        rows === 0 &&
        res === 0 &&
        readServiceLog().length === beforeHits,
      `code=${out.code} rowCreated=${out.rowCreated} rows=${rows} res=${res}`,
    );
  }

  {
    const { ws: wsHash, taskId: hashTaskId } = seedObserveWorkspace("ro-bad-hash", {
      payload: { kind: "repo_observe", targetId: "bad-hash" },
    });
    const cfgHash = writeObserveConfig(wsHash, {
      targets: { "bad-hash": { ...GOOD_TARGET, sha256: "0".repeat(64) } },
    });
    const beforeModel = readServiceLog().length;
    const runHash = await runDaemonOnce([
      `--data-dir=${wsHash.stateDir}`,
      `--config=${cfgHash}`,
      `--agent-image=${AGENT_REF}`,
      `--acquisition-image=${ACQUISITION_REF}`,
    ]);
    const dbHash = openDatabase(wsHash.dbPath, { readOnly: true });
    const tHash = dbHash
      .prepare("SELECT t.state, a.error_code FROM tasks t LEFT JOIN attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no WHERE t.id=?")
      .get(hashTaskId);
    const reqHash = dbHash.prepare("SELECT count(*) c FROM model_requests").get().c;
    const failAudit = dbHash.prepare("SELECT count(*) c FROM audit_log WHERE code='acquisition_failed'").get().c;
    dbHash.close();

    const { ws: wsSym, taskId: symTaskId } = seedObserveWorkspace("ro-symlink-tar", {
      payload: { kind: "repo_observe", targetId: "sym-tar" },
    });
    const cfgSym = writeObserveConfig(wsSym, {
      targets: {
        "sym-tar": {
          repo: "NorthAdb/sym-tar",
          url: `http://host.docker.internal:${acqPort}/symlink.tar.gz`,
          ref: "v1.0.0",
          sha256: symlinkArchive.sha256,
          mode: "tar",
          readPaths: ["src/app.mjs"],
        },
      },
    });
    const runSym = await runDaemonOnce([
      `--data-dir=${wsSym.stateDir}`,
      `--config=${cfgSym}`,
      `--agent-image=${AGENT_REF}`,
      `--acquisition-image=${ACQUISITION_REF}`,
    ]);
    const dbSym = openDatabase(wsSym.dbPath, { readOnly: true });
    const tSym = dbSym
      .prepare("SELECT t.state, a.error_code FROM tasks t LEFT JOIN attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no WHERE t.id=?")
      .get(symTaskId);
    const reqSym = dbSym.prepare("SELECT count(*) c FROM model_requests").get().c;
    dbSym.close();

    const wsExcerpt = makeWorkspace("ro-excerpt-check");
    const repoDir = join(wsExcerpt.stateDir, "dl", "repo", "sub");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "env.txt"), "TOKEN=ghp_1234567890abcdef123456\nBearer abcdefghijklmnopqrstuvwx\n", "utf8");
    const scrubOut = buildSafeRepoExcerpt({
      downloadsDir: join(wsExcerpt.stateDir, "dl"),
      entryDestRelPath: "repo",
      mode: "tar",
      readPaths: ["sub/env.txt"],
      maxExcerptBytes: 1024,
    });
    const nonFileOut = buildSafeRepoExcerpt({
      downloadsDir: join(wsExcerpt.stateDir, "dl"),
      entryDestRelPath: "repo",
      mode: "tar",
      readPaths: ["sub"],
      maxExcerptBytes: 1024,
    });

    suite.check(
      "acquisition-rejects-bad-sha256-and-symlink-archive-before-agent",
      runHash.status === 0 &&
        tHash?.state === "FAILED" &&
        tHash?.error_code === "acquisition_failed" &&
        reqHash === 0 &&
        failAudit === 1 &&
        runSym.status === 0 &&
        tSym?.state === "FAILED" &&
        tSym?.error_code === "acquisition_failed" &&
        reqSym === 0 &&
        readServiceLog().length === beforeModel &&
        scrubOut.ok &&
        scrubOut.files[0].excerpt.includes("[REDACTED_GH_TOKEN]") &&
        scrubOut.files[0].excerpt.includes("Bearer [REDACTED_TOKEN]") &&
        nonFileOut.code === "acquisition_non_file_rejected",
      `hash=${tHash?.state}/${tHash?.error_code} sym=${tSym?.state}/${tSym?.error_code} hitsDelta=${readServiceLog().length - beforeModel} scrub=${scrubOut.ok} nonFile=${nonFileOut.code}`,
    );
  }

  {
    setServiceMode({ kind: "priced", promptTokens: 40, completionTokens: 13, reply: "OBSERVE_HELD" });
    const { ws, taskId } = seedObserveWorkspace("ro-held-stop", {
      payload: { kind: "repo_observe", targetId: "fixture-alpha" },
    });
    const configPath = writeObserveConfig(ws, {
      priceInput: null,
      priceOutput: null,
      targets: { "fixture-alpha": GOOD_TARGET },
    });
    const dRun = await runDaemonOnce([
      `--data-dir=${ws.stateDir}`,
      `--config=${configPath}`,
      `--agent-image=${AGENT_REF}`,
      `--acquisition-image=${ACQUISITION_REF}`,
    ]);
    const db = openDatabase(ws.dbPath, { readOnly: true });
    const task = db
      .prepare("SELECT t.state, a.error_code FROM tasks t LEFT JOIN attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no WHERE t.id=?")
      .get(taskId);
    const req = db.prepare("SELECT state, reservation_id FROM model_requests WHERE task_id=?").get(taskId);
    const resRow = req?.reservation_id
      ? db.prepare("SELECT state FROM budget_reservations WHERE id=?").get(req.reservation_id)
      : null;
    const heldAudit = db
      .prepare("SELECT count(*) c FROM audit_log WHERE code='observe_stopped_settlement_held' AND task_id=?")
      .get(taskId).c;
    db.close();

    suite.check(
      "observe-held-settlement-never-completes-succeeded",
      dRun.status === 0 &&
        task?.state === "FAILED" &&
        task?.error_code === "settlement_held_uncompleted" &&
        req?.state === "HELD" &&
        resRow?.state === "HELD" &&
        heldAudit === 1,
      `exit=${dRun.status} task=${task?.state}/${task?.error_code} req=${req?.state} res=${resRow?.state} audit=${heldAudit}`,
    );
  }

  {
    setServiceMode({ kind: "priced", promptTokens: 40, completionTokens: 13, delayMs: 2000, reply: "HEARTBEAT_ALIVE" });
    const { ws, db, ledger, claim, commandsDir, now } = seedObserveWorkspace("ro-heartbeat", {
      payload: "claim ro-heartbeat",
      claimLeaseMs: 1500,
    });
    const beforeTask = db.prepare("SELECT lease_expires_at FROM tasks WHERE id=?").get(claim.taskId);
    const cfgPath = writeObserveConfig(ws, { maxInputBytes: 4096, maxOutputTokens: 128 });
    const cfg = loadDaemonConfig({ path: cfgPath });
    const out = await processModelRequestAsync(db, {
      stateDir: ws.stateDir,
      config: cfg,
      ledger,
      leaseMs: 1500,
      heartbeatMs: 300,
      envelope: {
        schemaVersion: 1,
        kind: "model_request",
        requestId: randomUUID(),
        taskId: claim.taskId,
        attemptId: claim.attemptId,
        fence: claim.fence,
        scopeDomainKey: "dm:telegram:6101",
        purpose: "worker",
        modelId: "deepseek/deepseek-flash",
        messages: [{ role: "user", content: "slow heartbeat call" }],
      },
      hostCommandsDir: commandsDir,
      completeActiveTask: false,
      now,
      useWallClockAfterCall: true,
    });
    const afterTask = db.prepare("SELECT state, lease_expires_at FROM tasks WHERE id=?").get(claim.taskId);
    const req = db.prepare("SELECT state FROM model_requests WHERE attempt_id=?").get(claim.attemptId);
    db.close();

    const realEnv = { ...process.env };
    delete realEnv.AEGISPI_ALLOW_REAL_MODEL_ACCEPTANCE;
    const realGuard = spawnSync(
      process.execPath,
      [join(repoRoot, "evals", "phase3", "model-real", "run.mjs")],
      { cwd: repoRoot, env: realEnv, encoding: "utf8" },
    );

    suite.check(
      "async-heartbeat-extends-lease-and-model-real-optin-exit-4",
      out.status === "settled" &&
        out.settled === true &&
        out.orphan === false &&
        req?.state === "SETTLED" &&
        afterTask?.state === "RUNNING" &&
        Number(afterTask?.lease_expires_at) > Number(beforeTask?.lease_expires_at) &&
        realGuard.status === 4 &&
        /AEGISPI_ALLOW_REAL_MODEL_ACCEPTANCE=1/.test(realGuard.stderr),
      `status=${out.status} req=${req?.state} orphan=${out.orphan} task=${afterTask?.state} leaseDelta=${Number(afterTask?.lease_expires_at) - Number(beforeTask?.lease_expires_at)} realGuardExit=${realGuard.status}`,
    );
  }

  {
    const { ws: wsQ1, db: dbQ1, claim: c1, now: n1 } = seedObserveWorkspace("ro-kv-q1", {
      payload: { kind: "repo_observe", targetId: "fixture-alpha", question: "First KV question" },
      claimLeaseMs: 120000,
    });
    const { ws: wsQ2, db: dbQ2, claim: c2, now: n2 } = seedObserveWorkspace("ro-kv-q2", {
      payload: { kind: "repo_observe", targetId: "fixture-alpha", question: "Second slightly longer KV question" },
      claimLeaseMs: 120000,
    });
    const cfg1 = loadDaemonConfig({ path: writeObserveConfig(wsQ1, { maxInputBytes: 512, maxOutputTokens: 128, targets: { "fixture-alpha": GOOD_TARGET } }) });
    const cfg2 = loadDaemonConfig({ path: writeObserveConfig(wsQ2, { maxInputBytes: 512, maxOutputTokens: 128, targets: { "fixture-alpha": GOOD_TARGET } }) });
    const launcher1 = createAcquisitionLauncher(dbQ1, { stateDir: wsQ1.stateDir, imageRef: ACQUISITION_REF, enableHostGateway: true });
    const launcher2 = createAcquisitionLauncher(dbQ2, { stateDir: wsQ2.stateDir, imageRef: ACQUISITION_REF, enableHostGateway: true });
    const acq1 = await executeRepoObserveAcquisition(dbQ1, {
      stateDir: wsQ1.stateDir,
      config: cfg1,
      acquisitionLauncher: launcher1,
      taskId: c1.taskId,
      attemptId: c1.attemptId,
      attemptNo: c1.attemptNo,
      fence: c1.fence,
      scopeId: "scp:dm%3Atelegram%3A6101",
      targetId: "fixture-alpha",
      question: "First KV question",
      now: n1,
    });
    const acq2 = await executeRepoObserveAcquisition(dbQ2, {
      stateDir: wsQ2.stateDir,
      config: cfg2,
      acquisitionLauncher: launcher2,
      taskId: c2.taskId,
      attemptId: c2.attemptId,
      attemptNo: c2.attemptNo,
      fence: c2.fence,
      scopeId: "scp:dm%3Atelegram%3A6101",
      targetId: "fixture-alpha",
      question: "Second slightly longer KV question",
      now: n2,
    });
    const cfgTooSmall = loadDaemonConfig({ path: writeObserveConfig(wsQ1, { maxInputBytes: 64, maxOutputTokens: 128, targets: { "fixture-alpha": GOOD_TARGET } }) });
    const acqBeforeTooSmall = acqHits.length;
    const acqTooSmall = await executeRepoObserveAcquisition(dbQ1, {
      stateDir: wsQ1.stateDir,
      config: cfgTooSmall,
      acquisitionLauncher: launcher1,
      taskId: c1.taskId,
      attemptId: c1.attemptId,
      attemptNo: c1.attemptNo,
      fence: c1.fence,
      scopeId: "scp:dm%3Atelegram%3A6101",
      targetId: "fixture-alpha",
      question: "Too tiny cap",
      now: n1 + 1,
    });
    const acqTooSmallHits = acqHits.length - acqBeforeTooSmall;
    dbQ1.close();
    dbQ2.close();
    const tail1 = "\n\nTask Question: First KV question";
    const tail2 = "\n\nTask Question: Second slightly longer KV question";
    const prefix1 = acq1.ok && acq1.promptText.endsWith(tail1) ? acq1.promptText.slice(0, -tail1.length) : null;
    const prefix2 = acq2.ok && acq2.promptText.endsWith(tail2) ? acq2.promptText.slice(0, -tail2.length) : null;
    const envBytes1 = acq1.ok ? Buffer.byteLength(JSON.stringify([{ role: "user", content: acq1.promptText }]), "utf8") : -1;

    suite.check(
      "repo-observe-kv-prefix-stable-and-question-survives-cap",
      acq1.ok &&
        acq2.ok &&
        typeof prefix1 === "string" &&
        prefix1.length > 0 &&
        prefix1 === prefix2 &&
        envBytes1 <= 512 &&
        acq1.promptText.indexOf("Observe Repo:") === 0 &&
        acq1.promptText.indexOf("Sanitized Read-Only Excerpts:") < acq1.promptText.indexOf(tail1) &&
        acqTooSmall.ok === false &&
        acqTooSmall.code === "input_bytes_exceeded" &&
        acqTooSmallHits === 0,
      `prefixEqual=${prefix1 === prefix2} prefixLen=${prefix1?.length ?? 0} envBytes=${envBytes1} tooSmall=${acqTooSmall.code}/hits=${acqTooSmallHits}`,
    );
  }
} finally {
  acqServer.close();
  svc.kill();
}

writeReport({
  suiteId: "repo-observe",
  suite,
  label: "test:repo-observe — Phase 4.2 Permission 1 离线仓库 Observe 全链、fail-closed 门禁与 D-80 加固回归",
  extra: {
    dataSources:
      "digest 钉住 acquisition 与 agent 双容器 + 本地 throwaway HTTP archive + 本地 OpenAI SSE 环回 + pi-ai 1.5.2 + 真实 SQLite 账本；零真实仓库拉取、零真实模型调用、未读 .env",
  },
});
process.exit(suiteExit(suite, { label: "test:repo-observe" }));
