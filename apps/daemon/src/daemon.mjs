// The daemon entry. Phase 2 runs a single daemon against a local SQLite file
// with fake/recorded inputs only — there is no real ingress adapter and no
// real upstream submitter here (Phase 3 concerns), and the loop says so rather
// than pretending. The startup order is fixed by 06 section 9 and the
// recovery module owns its action log:
//   lock -> integrity -> pre-migration backup -> migrate -> startup recovery
//   -> console (always; read-only mode keeps only diagnostics) -> loop.
// Holding the lock fails -> exit non-zero immediately.

import { mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadDaemonConfig, ConfigError } from "./config.mjs";
import { acquireDaemonLock } from "./db/lock.mjs";
import { openDatabase, checkDatabaseIntegrity } from "./db/connect.mjs";
import { loadCanonicalSchema, migrate, ensureModelRequestsTable } from "./db/migrate.mjs";
import { migrationPending, preMigrationBackup } from "./db/backup.mjs";
import { startupRecovery } from "./recovery.mjs";
import { createBudgetLedger } from "./budget.mjs";
import { dispatchEventToTask } from "./router.mjs";
import { dispatchKeyForInbox } from "./ingress.mjs";
import {
  claimNextTask,
  completeTask,
  heartbeat,
  workerStep,
  reapExpiredLeases,
  deliveryAckCheckpoint,
  deliveryDone,
} from "./scheduler.mjs";
import { processDueTimers, cancelSatisfiedFollowUpReminders } from "./timers.mjs";
import { expireApprovals } from "./approvals.mjs";
import { expireStaleNotifications, dueNotifications } from "./outbox.mjs";
import { insertObjectRow } from "./objects.mjs";
import { writeAudit } from "./audit.mjs";
import { createFakeRemote } from "./testing/fake-remote.mjs";
import { createHttpUpstream } from "./upstream-http.mjs";
import { dispatchEffect, autoRecoverUnknown, reproposeHeadChanged } from "./effects.mjs";
import { createAdapterUpstream, headPrecondition, AdapterRefused } from "./adapters.mjs";
import { createContainerExecutor, createAgentLauncher } from "./container-executor.mjs";
import { isLoopbackModelEndpoint } from "./model-call.mjs";
import { processPendingModelProposalsAsync } from "./model-requests.mjs";
import { diskWatermark, recordWatermark } from "./db/disk-water.mjs";
import { consistencyBackup, insideMaintenanceWindow, pruneExpiredBackups } from "./db/backup-window.mjs";
import {
  createConsoleApp,
  serveConsole,
  ensureConsoleToken,
  CONSOLE_DEFAULT_PORT,
} from "./console/api.mjs";

export async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv.filter((a) => a.startsWith("--")));
  const dataDirFlag = argv.find((a) => a.startsWith("--data-dir="));
  const dataDir = dataDirFlag ? dataDirFlag.slice("--data-dir=".length) : join(process.cwd(), "workspace-state");
  const fakeUpstream = args.has("--fake-upstream");
  // --config=<path>: the same channel tests use (local controllable services)
  // and a deployment uses (real endpoints + authorizations). It only selects
  // a JSON file the loader reads; every trust decision still lives in the
  // adapter gates, never in this file's contents.
  const configFlag = argv.find((a) => a.startsWith("--config="));

  // A config that refuses to load (a loosened drill seam, a broken value)
  // refuses STARTUP with a clean exit rather than running on a guess
  // (re-review F8: the drill invariant is a boot condition).
  let config;
  try {
    config = configFlag
      ? loadDaemonConfig({ path: configFlag.slice("--config=".length) })
      : loadDaemonConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`config: refusing to start — ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const portFlag = argv.find((a) => a.startsWith("--port="));
  const consolePort = portFlag ? Number(portFlag.slice("--port=".length)) : CONSOLE_DEFAULT_PORT;

  mkdirSync(join(dataDir, "db"), { recursive: true });
  const lock = acquireDaemonLock(dataDir);
  if (!lock.ok) {
    console.error(`another daemon (pid ${lock.heldBy}) holds ${lock.lockPath}; refusing to start`);
    process.exit(1);
  }

  const dbPath = join(dataDir, "db", "aegis.db");
  const db = openDatabase(dbPath);
  const canonical = loadCanonicalSchema();

  // Integrity before anything else. The PRE-migration snapshot comes strictly
  // BEFORE migrate() — it must hold the pre-apply state so a failed apply can
  // be rolled back (06 section 9 startup order). No snapshot is minted when
  // the schema is already current, because nothing will be applied.
  const integrity = checkDatabaseIntegrity(db);
  if (!integrity.ok) {
    console.error(`integrity check failed: ${integrity.detail}; opening read-only diagnostics only`);
    process.exit(2);
  }
  if (migrationPending(db)) {
    const backup = preMigrationBackup(db, { backupsDir: join(dataDir, "backups"), now: Date.now() });
    console.log(`backup: pre-migration snapshot ${backup.path} (${backup.bytes} bytes, integrity ${backup.integrity})`);
  }
  migrate(db, canonical);

  const recovery = startupRecovery(db, {
    stateDir: dataDir,
    canonical,
    now: Date.now(),
    maxAttempts: 3,
    unknownUsageTimeoutMs: 15 * 60 * 1000,
  });
  for (const a of recovery.actions) {
    console.log(`recovery ${a.ok ? "ok " : "FAIL"} ${a.step}: ${a.detail}`);
  }
  // Disk watermark (06 section 10): a critically full disk is a recovery-level
  // failure — only read-only diagnostics open, containers never auto-start.
  const diskNow = diskWatermark(dataDir, {
    warnFreeBytes: config.disk.warnFreeBytes,
    criticalFreeBytes: config.disk.criticalFreeBytes,
  });
  const openMode = recovery.mode === "open" && diskNow.level !== "critical";
  if (diskNow.level !== "ok") {
    console.error(`disk: level=${diskNow.level} free=${Math.round(diskNow.freeBytes / 1024 / 1024 / 1024)}GiB ratio=${diskNow.freeRatio}`);
  }
  if (recovery.mode === "open" && diskNow.level === "critical") {
    console.error("disk: CRITICAL watermark; opening read-only diagnostics only");
  }
  if (recovery.mode !== "open") {
    console.error(`recovery failed at ${recovery.failedStep}; read-only diagnostics only`);
  }

  // The console (Phase 2 minimal diagnostics + Phase 3 approval/cancel/
  // authorize/budget surfaces) starts in EVERY mode: open mode serves the
  // full surface, read-only mode keeps exactly the diagnostics reachable
  // and everything else answers 503.
  const { token } = ensureConsoleToken(dataDir);
  // Owner-configured webhook secret (re-review P1): unset = the endpoint
  // fails closed with 503; set-but-malformed (<16 chars) refuses startup.
  const telegramWebhookSecret = process.env.AEGISPI_TELEGRAM_WEBHOOK_SECRET ?? null;
  const consoleApp = createConsoleApp(db, {
    recovery,
    mode: openMode ? "open" : recovery.mode,
    token,
    port: consolePort,
    stateDir: dataDir,
    ownerPrincipalId: "prn:local:owner",
    telegramWebhookSecret,
  });
  const served = await serveConsole(consoleApp, { port: consolePort });
  console.log(`console: ${served.bind}:${served.port} (auth: local bearer token; diagnostics${openMode ? "" : " only"})`);

  if (args.has("--check")) {
    console.log(`check: mode=${openMode ? "open" : "read-only"} steps=${recovery.actions.length} disk=${diskNow.level} ${openMode ? "GREEN" : "RED"}`);
    served.server.close();
    lock.release();
    process.exit(openMode ? 0 : 3);
  }

  if (!openMode) {
    console.error("daemon loop not started: recovery or disk watermark keeps the daemon read-only; the console serves diagnostics only");
    let staying = true;
    process.on("SIGINT", () => {
      staying = false;
    });
    const hold = () => {
      if (!staying) {
        served.server.close();
        lock.release();
        process.exit(3);
      }
      setTimeout(hold, 1000);
    };
    hold();
    return 3;
  }

  ensureModelRequestsTable(db);
  const ledger = createBudgetLedger(db, {
    taskLimitMicrousd: config.budget.taskLimitMicrousd,
    dayLimitMicrousd: config.budget.dayLimitMicrousd,
    warmingEnabled: config.budget.warmingEnabled,
    timeZone: config.timezone,
  });
  // The transport layer: under --fake-upstream the declared test fixture;
  // in production the REAL HTTP transport whenever the host configured a
  // submit endpoint (re-review P1: the code path exists — the
  // no-authorization default still sends zero bytes because the ADAPTER
  // refuses before the transport sees anything). No submitUrl configured =
  // no transport wired: READY effects stay durable with the honest log.
  const upstream = fakeUpstream ? createFakeRemote(dataDir, { label: "daemon-fake-upstream" }) : null;
  const httpTransport =
    !fakeUpstream && config.upstream.submitUrl
      ? createHttpUpstream({ endpoint: config.upstream.submitUrl, timeoutMs: config.upstream.timeoutMs })
      : null;
  const baseUpstream = upstream ?? httpTransport;
  // The production dispatch path is the ADAPTER upstream, never the raw
  // transport: the trusted registry gates every operation (unknown operations
  // refuse; real external writes stay fail-closed; chargeable submits need a
  // live reservation; adapter-owned templates, never model-assembled URLs).
  // transportKind is declared HERE (fake exactly under --fake-upstream, real
  // otherwise), never sniffed from a label.
  const adapterUpstream = baseUpstream || config.model.baseUrl
    ? createAdapterUpstream(db, {
        baseUpstream,
        transportKind: fakeUpstream ? "fake" : "real",
        policy: { allowRealExternalWrites: config.policy.allowRealExternalWrites },
        credentials: config.credentials,
        config: {
          fixedSendingIdentity: config.adapters.fixedSendingIdentity,
          allowedRecipients: config.adapters.allowedRecipients,
          allowedRepos: config.adapters.allowedRepos,
          allowedBranches: config.adapters.allowedBranches,
        },
        modelConfig: config.model,
      })
    : null;

  // Optional REAL container execution (Phase 3): the executor only exists
  // when the operator passes a digest-pinned image reference. Without the
  // flag the daemon says so honestly — QUEUED jobs stay durable.
  const executionImageFlag = argv.find((a) => a.startsWith("--execution-image="));
  let executor = null;
  if (executionImageFlag) {
    try {
      executor = createContainerExecutor(db, {
        stateDir: dataDir,
        imageRef: executionImageFlag.slice("--execution-image=".length),
        quotas: {
          cpus: config.containerPlaceholders.execution.cpus,
          memory: `${config.containerPlaceholders.execution.memoryGiB}g`,
          pids: config.containerPlaceholders.execution.pids,
          tmpfsSize: `${config.containerPlaceholders.execution.writableDiskGiB}g`,
        },
        machineWideMax: config.leases.maxOfflineJobsMachineWide,
      });
    } catch (e) {
      console.error(`execution image flag invalid: ${e.message}`);
      process.exit(2);
    }
  }

  // Optional production agent container launcher (Phase 4.1, ADR-0001 §2):
  // parallel to --execution-image, requires a digest-pinned agent image ref.
  const agentImageFlag = argv.find((a) => a.startsWith("--agent-image="));
  let agentLauncher = null;
  if (agentImageFlag) {
    try {
      agentLauncher = createAgentLauncher(db, {
        stateDir: dataDir,
        imageRef: agentImageFlag.slice("--agent-image=".length),
        quotas: {
          cpus: config.containerPlaceholders.agent.cpus,
          memory: `${config.containerPlaceholders.agent.memoryGiB}g`,
          pids: config.containerPlaceholders.agent.pids,
          tmpfsSize: `${config.containerPlaceholders.agent.writableDiskGiB}g`,
        },
      });
    } catch (e) {
      console.error(`agent image flag invalid: ${e.message}`);
      process.exit(2);
    }
  }
  const activeAgentContainers = new Map();
  if (agentLauncher) {
    agentLauncher.reapOrphanContainers();
  }

  function reclaimFinishedAgentContainers() {
    if (!agentLauncher) return 0;
    let reclaimed = 0;
    for (const [key, info] of activeAgentContainers.entries()) {
      let receipts = [];
      try {
        receipts = readdirSync(info.proposalsDir).filter((f) => f.startsWith("receipt-model-result-") && f.endsWith(".json"));
      } catch {}
      const taskRow = db.prepare("SELECT state FROM tasks WHERE id=?").get(info.taskId);
      const mrRow = db
        .prepare("SELECT state, error_code FROM model_requests WHERE attempt_id=? ORDER BY updated_at DESC LIMIT 1")
        .get(info.attemptId);
      const insp = agentLauncher.inspectContainer(info.containerId);
      if (insp.running && taskRow?.state === "RUNNING") {
        try {
          heartbeat(db, {
            taskId: info.taskId,
            attemptNo: info.attemptNo,
            leaseOwner: info.leaseOwner,
            fence: info.fence,
            now: Date.now(),
            leaseMs: config.leases.leaseMs,
          });
        } catch {}
      }
      const proposalFailed = mrRow?.state === "FAILED" || mrRow?.state === "ORPHAN";
      if (taskRow?.state === "RUNNING" && proposalFailed && (receipts.length > 0 || !insp.running)) {
        try {
          completeTask(db, {
            taskId: info.taskId,
            attemptNo: info.attemptNo,
            leaseOwner: info.leaseOwner,
            fence: info.fence,
            now: Date.now(),
            resultClass: "infra_error",
            errorCode: mrRow?.error_code ?? "model_request_failed",
          });
        } catch {}
      }
      const postTask = db.prepare("SELECT state FROM tasks WHERE id=?").get(info.taskId);
      if (postTask?.state === "SUCCEEDED" && !info.settledSeenAt) {
        info.settledSeenAt = Date.now();
      }
      const graceExpired = Boolean(info.settledSeenAt && Date.now() - info.settledSeenAt > 1500);
      const nonSuccessTerminal = postTask && postTask.state !== "RUNNING" && postTask.state !== "SUCCEEDED";
      if (receipts.length > 0 || !insp.running || graceExpired || nonSuccessTerminal) {
        agentLauncher.stopAttempt({ containerId: info.containerId, commandsDir: info.commandsDir });
        activeAgentContainers.delete(key);
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  function stopAllActiveAgentContainers() {
    if (!agentLauncher) return;
    for (const [key, info] of activeAgentContainers.entries()) {
      agentLauncher.stopAttempt({ containerId: info.containerId, commandsDir: info.commandsDir });
      activeAgentContainers.delete(key);
    }
  }

  // Watermark level changes stream an alert once per transition; the backup
  // runs once per window-day when the manifest key is configured.
  let lastDiskLevel = diskNow.level;
  let lastBackupDayKey = null;
  const backupKey = process.env.AEGISPI_BACKUP_MANIFEST_KEY ?? null;

  const tick = async () => {
    const now = Date.now();
    // 0. Disk watermark: warn blocks NEW job launches; critical never reaches
    //    here (startup already opened read-only).
    const disk = diskWatermark(dataDir, {
      warnFreeBytes: config.disk.warnFreeBytes,
      criticalFreeBytes: config.disk.criticalFreeBytes,
    });
    if (disk.level !== lastDiskLevel) {
      recordWatermark(db, { state: disk, previousLevel: lastDiskLevel, now });
      console.error(`disk: watermark ${lastDiskLevel} -> ${disk.level}`);
      lastDiskLevel = disk.level;
    }
    // 1. Sweeps: leases, approvals, stale reminders, expired notifications.
    reapExpiredLeases(db, { now, maxAttempts: 3 });
    expireApprovals(db, { now });
    cancelSatisfiedFollowUpReminders(db, { now });
    expireStaleNotifications(db, { now });
    // 2. Timers generate durable inbox events.
    const timers = processDueTimers(db, { now });
    // 3. Pending inbox rows get their default dispatch plan — recovery from
    //    any crash never depends on an in-memory wakeup.
    const pending = db.prepare("SELECT * FROM inbox WHERE state='PENDING' AND verdict='ADMIT'").all();
    for (const row of pending) {
      dispatchEventToTask(db, {
        inboxId: row.id,
        dispatchKey: dispatchKeyForInbox(row),
        now,
        priority: row.priority,
        maxSteps: config.budget.taskMaxSteps,
        deadlineAt: now + config.budget.taskMaxWallClockMs,
        skillSetHash: "skillset-phase2-default",
      });
    }
    // 4. Worker paths. The fixture worker exists EXCLUSIVELY under
    //    --fake-upstream: it is a test seam, so the no-authorization path
    //    never fabricates usage (audit F6 — the constant 300 must not
    //    masquerade as a provider bill). Its settlement is labeled fixture
    //    usage in the audit row; real settlements need a real provider
    //    bill or stay HELD. Outside the fixture, the REAL model worker runs
    //    when the host configured an authorized endpoint (re-review P1).
    let claim = null;
    let proposalProcessed = 0;
    if (fakeUpstream) {
      claim = claimNextTask(db, { now, leaseMs: config.leases.leaseMs });
      if (claim) {
        heartbeat(db, { ...claim, now, leaseMs: config.leases.leaseMs });
        const taskAcc = ledger.ensureTaskAccount({ taskId: claim.taskId, now }).accountId;
        const dayAcc = ledger.ensureDayAccount({ now }).accountId;
        const res = ledger.reserve({
          requestKey: `worker:${claim.taskId}:${claim.attemptNo}`,
          taskId: claim.taskId,
          purpose: "worker",
          provider: config.model.provider,
          priceVersion: "catalog-v1",
          upperMicrousd: 1000,
          accounts: [
            { accountId: taskAcc, amountMicrousd: 500 },
            { accountId: dayAcc, amountMicrousd: 500 },
          ],
          now,
        });
        workerStep(db, { ...claim, now, budgetReservationId: res.reservationId });
        ledger.settle({
          reservationId: res.reservationId,
          usage: {
            actualMicrousd: 300,
            source: "fake-worker-fixture",
            basis: "phase2 fake worker constant under --fake-upstream; not a provider bill",
          },
          now,
          actorId: "fake-worker",
        });
        const scopeId = db.prepare("SELECT scope_id FROM tasks WHERE id=?").get(claim.taskId).scope_id;
        const evidence = insertObjectRow(db, {
          scopeId,
          kind: "task_result",
          sourceUri: `task:${claim.taskId}`,
          sourceActor: "fake-worker",
          content: JSON.stringify({ done: true, at: now, worker: "phase2-fake" }),
          observedAt: now,
          requiredScopeIds: [scopeId],
        });
        completeTask(db, {
          taskId: claim.taskId,
          attemptNo: claim.attemptNo,
          leaseOwner: claim.leaseOwner,
          fence: claim.fence,
          now,
          resultClass: "not_applicable",
          resultObjectId: evidence.id,
        });
        const delivery = db
          .prepare("SELECT event_id FROM event_deliveries WHERE task_id=? AND state='PENDING'")
          .get(claim.taskId);
        if (delivery) {
          const ck = insertObjectRow(db, {
            scopeId,
            kind: "session_checkpoint",
            sourceUri: `cmd:${delivery.event_id}:${claim.taskId}`,
            sourceActor: "host",
            content: "fake worker consumed the event",
            observedAt: now,
            requiredScopeIds: [scopeId],
          });
          deliveryAckCheckpoint(db, { eventId: delivery.event_id, taskId: claim.taskId, checkpointObjectId: ck.id, now });
          deliveryDone(db, { eventId: delivery.event_id, taskId: claim.taskId, now });
        }
      }
    } else if (config.model.baseUrl) {
      // Production model proposal path (ADR-0001 §2/§3/§4/§7): the host
      // validates model_request proposals on the propose-only channel, checks
      // identity against RUNNING claims and dual whitelists, reserves before
      // executing the single pi-ai 1.5.2 core, settles/holds by four-field
      // usage, and delivers model_result via host-commands. When --agent-image
      // is wired, claimable tasks launch a networkless agent container.
      const authorizedForModel = isLoopbackModelEndpoint(config.model.baseUrl) || config.model.allowRealModelCalls;
      const awaitingModel = db
        .prepare("SELECT count(*) c FROM tasks WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED','LOST')")
        .get().c;
      if (!authorizedForModel) {
        if (awaitingModel > 0) {
          console.error(
            `worker: ${awaitingModel} task(s) await a model call but the configured baseUrl is not authorized (model.allowRealModelCalls is false and baseUrl is not loopback); nothing is claimed or settled`,
          );
        }
      } else {
        if (agentLauncher) {
          claim = claimNextTask(db, { now, leaseMs: config.leases.leaseMs });
          if (claim) {
            heartbeat(db, { ...claim, now, leaseMs: config.leases.leaseMs });
            const taskRow = db.prepare("SELECT scope_id, deadline_at FROM tasks WHERE id=?").get(claim.taskId);
            const scopeRow = db.prepare("SELECT domain_key FROM scopes WHERE id=?").get(taskRow.scope_id);
            let callInput = null;
            const delivery = db
              .prepare("SELECT event_id FROM event_deliveries WHERE task_id=? AND state='PENDING'")
              .get(claim.taskId);
            if (delivery) {
              const inboxRow = db.prepare("SELECT payload_object_id FROM inbox WHERE id=?").get(delivery.event_id);
              const obj = inboxRow
                ? db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(inboxRow.payload_object_id)
                : null;
              const payloadPath = obj?.storage_ref ? join(dataDir, ...obj.storage_ref.split("/")) : null;
              if (payloadPath && existsSync(payloadPath)) {
                try {
                  callInput = readFileSync(payloadPath, "utf8");
                } catch {}
              }
            }
            const modelKey = config.model.provider && config.model.modelId
              ? `${config.model.provider}/${config.model.modelId}`
              : "deepseek/deepseek-flash";
            const launched = agentLauncher.launchAttempt({
              taskId: claim.taskId,
              attemptId: claim.attemptId,
              attemptNo: claim.attemptNo,
              fence: claim.fence,
              scopeDomainKey: scopeRow.domain_key,
              modelRequest: {
                purpose: "worker",
                modelId: modelKey,
                messages: [{ role: "user", content: callInput ?? `task ${claim.taskId}` }],
              },
              now,
            });
            try {
              heartbeat(db, { ...claim, now: Date.now(), leaseMs: config.leases.leaseMs });
            } catch {}
            activeAgentContainers.set(`${claim.taskId}:${claim.attemptNo}`, {
              ...launched,
              taskId: claim.taskId,
              attemptId: claim.attemptId,
              attemptNo: claim.attemptNo,
              fence: claim.fence,
              leaseOwner: claim.leaseOwner,
              deadlineAt: taskRow.deadline_at,
            });
          }
        }
        const batch = await processPendingModelProposalsAsync(db, {
          stateDir: dataDir,
          config,
          ledger,
          leaseMs: config.leases.leaseMs,
          completeActiveTask: true,
          now,
          useWallClockAfterCall: true,
        });
        proposalProcessed = batch.processed;
      }
      reclaimFinishedAgentContainers();
    } else {
      // No model path is configured: nothing is claimed, nothing settles.
      // Say so on the record instead of pretending the loop is production.
      const awaiting = db
        .prepare("SELECT count(*) c FROM tasks WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED','LOST')")
        .get().c;
      if (awaiting > 0) {
        console.error(`worker: ${awaiting} task(s) await an execution path; no model baseUrl is configured (model.baseUrl is null) — nothing is claimed or settled (fixture settlements require --fake-upstream)`);
      }
    }
    // 5. Effect dispatch & UNKNOWN reconciler (non-model READY/UNKNOWN stay durable when baseUpstream is null).
    if (adapterUpstream) {
      const unknowns = baseUpstream
        ? db.prepare("SELECT id, retry_mode FROM effects WHERE state='UNKNOWN'").all()
        : db.prepare("SELECT id, retry_mode FROM effects WHERE state='UNKNOWN' AND operation='model.inference'").all();
      for (const u of unknowns) {
        try {
          const action = autoRecoverUnknown(db, adapterUpstream, { effectId: u.id, now, backoffMs: 0 });
          if (action.action !== "none") {
            console.log(`reconcile: ${u.id} (${u.retry_mode}) -> ${action.action}`);
          }
        } catch (err) {
          console.error(`reconcile refused ${u.id}: ${err.message}`);
        }
      }
      const ready = baseUpstream
        ? db.prepare("SELECT id FROM effects WHERE state='READY' AND next_attempt_at<=? ORDER BY next_attempt_at").all(now)
        : db.prepare("SELECT id FROM effects WHERE state='READY' AND operation='model.inference' AND next_attempt_at<=? ORDER BY next_attempt_at").all(now);
      for (const e of ready) {
        try {
          const row = db.prepare("SELECT * FROM effects WHERE id=?").get(e.id);
          // Head precondition (06 section 6: the CAS transaction re-checks the
          // target resource precondition) — INSIDE the dispatcher transaction.
          const precondition = adapterUpstream ? headPrecondition(adapterUpstream, row) : () => true;
          dispatchEffect(db, adapterUpstream, { effectId: e.id, now, precondition });
        } catch (err) {
          if (
            err instanceof AdapterRefused &&
            err.message.startsWith("head_changed:") &&
            adapterUpstream
          ) {
            // HEAD drifted between approval and dispatch: the old action is
            // cancelled, a NEW card is minted against the CURRENT head and
            // the task parks for re-approval (06 section 5: "HEAD变化返回
            // 需重审"). The human sees fresh facts, never a silent mismatch.
            const row = db.prepare("SELECT action_json FROM effects WHERE id=?").get(e.id);
            const target = JSON.parse(row.action_json).target_resource;
            const head = adapterUpstream.lookupHead({ targetResource: target });
            if (head.ok) {
              const out = reproposeHeadChanged(db, dataDir, {
                now,
                effectId: e.id,
                currentHead: head.head,
                actorId: "daemon-dispatcher",
                expiresAt: now + 60 * 60 * 1000,
              });
              console.log(`dispatcher: ${e.id} head changed -> re-approval ${out.newApprovalId} pinned to ${head.head}`);
            } else {
              console.error(`dispatcher: ${e.id} head changed and the transport cannot read the new head; effect stays READY, refusing to submit`);
            }
            continue;
          }
          console.error(`dispatcher refused ${e.id}: ${err.message}`);
        }
      }
    }
    if (!baseUpstream) {
      if (db.prepare("SELECT count(*) c FROM effects WHERE state='READY' AND operation!='model.inference'").get().c > 0) {
        console.error("dispatcher: READY effects exist but no submit transport is wired (upstream.submitUrl unset); they stay durable and dispatched later");
      } else if (db.prepare("SELECT count(*) c FROM effects WHERE state='UNKNOWN' AND operation!='model.inference'").get().c > 0) {
        // UNKNOWN without an upstream stays UNKNOWN, on the record: the daemon
        // never converts uncertainty into a success or a blind resend.
        console.error("reconcile: UNKNOWN effects present but no upstream adapter is wired; they stay UNKNOWN for a human or a later phase");
      }
    }
    // 6. Outbox: only a report — delivery status lives in effects.state.
    const due = dueNotifications(db, { now });
    // 7. Offline container jobs: poll always, launch only while the disk has
    //    room (the watermark's warn stance blocks NEW workspaces, not
    //    reaping).
    if (executor) {
      const events = executor.tick({ now, allowLaunch: disk.level === "ok" });
      for (const ev of events) {
        console.log(`job: ${ev.jobId} -> ${ev.state}`);
      }
    } else if (db.prepare("SELECT count(*) c FROM execution_jobs WHERE state='QUEUED'").get().c > 0) {
      console.error("jobs: QUEUED offline jobs exist but no execution image is wired (--execution-image=<digest ref>); they stay durable");
    }
    // 8. Scheduled consistency backup: once per maintenance-window day, and
    //    ONLY with the manifest key configured — without it the backup would
    //    be an unsealable promise, so it is skipped with the reason on record.
    const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: config.backup.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
    const backupWindow = {
      windowStartHour: config.backup.windowStartHour,
      windowEndHour: config.backup.windowEndHour,
      timeZone: config.backup.timeZone,
    };
    if (insideMaintenanceWindow(now, backupWindow) && lastBackupDayKey !== dayKey) {
      if (!backupKey || !/^[0-9a-f]{64}$/.test(backupKey)) {
        console.error("backup: inside the maintenance window but AEGISPI_BACKUP_MANIFEST_KEY is not configured; the consistency backup is skipped (fail closed, not silently unsealed)");
      } else {
        try {
          const backup = consistencyBackup(db, {
            stateDir: dataDir,
            backupsDir: join(dataDir, "backups"),
            now,
            manifestKeyHex: backupKey,
            window: backupWindow,
          });
          lastBackupDayKey = dayKey;
          // Retention is real housekeeping (audit F8): when a fresh backup
          // lands, pairs older than retentionDays are deleted and the prune
          // is audited.
          const pruned = pruneExpiredBackups(join(dataDir, "backups"), {
            retentionDays: config.backup.retentionDays,
            now,
          });
          if (pruned.pruned.length > 0) {
            writeAudit(db, {
              code: "backup_retention_pruned",
              details: { pruned: pruned.pruned, kept: pruned.kept.length, retention_days: config.backup.retentionDays },
              now,
            });
            console.log(`backup: pruned ${pruned.pruned.length} expired backup(s) beyond ${config.backup.retentionDays} days`);
          }
          console.log(`backup: consistency snapshot ${backup.path} (${backup.bytes} bytes, manifest sealed with dbSha256, ledger entries=${backup.entries})`);
        } catch (e) {
          console.error(`backup: consistency backup refused: ${e.message}`);
        }
      }
    }
    if (timers.fired.length > 0 || pending.length > 0 || claim || proposalProcessed > 0 || due.length > 0) {
      console.log(
        `tick: timers=${timers.fired.length} dispatched_pending=${pending.length} claimed=${claim ? claim.taskId : "none"} proposals=${proposalProcessed} due_notifications=${due.length}`,
      );
    }
    return timers.fired.length + pending.length + (claim ? 1 : 0) + proposalProcessed + due.length;
  };

  if (args.has("--once")) {
    let exitCode = 0;
    try {
      let rounds = 0;
      const waitDeadline = Date.now() + Math.max(30000, (config.model.callTimeoutMs ?? 60000) + 15000);
      while (rounds < 20) {
        const work = await tick();
        rounds += 1;
        if (agentLauncher && activeAgentContainers.size > 0) {
          while (activeAgentContainers.size > 0 && Date.now() < waitDeadline) {
            reclaimFinishedAgentContainers();
            if (activeAgentContainers.size === 0) break;
            await processPendingModelProposalsAsync(db, {
              stateDir: dataDir,
              config,
              ledger,
              leaseMs: config.leases.leaseMs,
              completeActiveTask: true,
              now: Date.now(),
              useWallClockAfterCall: true,
            });
            reclaimFinishedAgentContainers();
            if (activeAgentContainers.size > 0) {
              await new Promise((r) => setTimeout(r, 200));
            }
          }
          stopAllActiveAgentContainers();
          if (db.prepare("SELECT count(*) c FROM tasks WHERE state='QUEUED'").get().c > 0) {
            continue;
          }
        }
        if (work === 0) break;
      }
      // Offline container jobs are async by nature: a once-run that launched
      // them WAITS for their completion, bounded by each job's host-enforced
      // deadline. Never exit --once with a live container behind us. The bound
      // is the OUTSTANDING work's own deadlines: a launch policy (the disk
      // watermark's warn stance) can keep a job QUEUED forever, and --once
      // must say so and exit honestly instead of hanging.
      if (executor) {
        let waited = 0;
        for (;;) {
          const outstanding = db
            .prepare("SELECT count(*) c, max(deadline_at) d FROM execution_jobs WHERE state IN ('QUEUED','RUNNING')")
            .get();
          if (outstanding.c === 0) break;
          if (outstanding.d && Date.now() > Number(outstanding.d) + 5000) {
            console.error(
              `once: ${outstanding.c} offline job(s) still QUEUED/RUNNING after the deadline bound (a launch policy — disk warn, watermark gate — can keep work queued); exit 5`,
            );
            exitCode = 5;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
          waited += 500;
          const diskOnce = diskWatermark(dataDir, {
            warnFreeBytes: config.disk.warnFreeBytes,
            criticalFreeBytes: config.disk.criticalFreeBytes,
          });
          const events = executor.tick({ now: Date.now(), allowLaunch: diskOnce.level === "ok" });
          for (const ev of events) {
            console.log(`job: ${ev.jobId} -> ${ev.state}`);
          }
        }
        if (exitCode === 0) {
          console.log(`once: waited ${Math.round(waited / 1000)}s for offline jobs to reach terminal state`);
        }
      }
      if (exitCode === 0) {
        console.log(`once: ${rounds} tick(s) to drain the durable backlog`);
        const unknownLeft = db.prepare("SELECT count(*) c FROM effects WHERE state='UNKNOWN'").get().c;
        if (unknownLeft > 0) {
          console.error(`once: ${unknownLeft} UNKNOWN effect(s) unresolved at drain end; exit 4`);
          exitCode = 4;
        }
      }
    } finally {
      stopAllActiveAgentContainers();
      lock.release();
    }
    process.exit(exitCode);
  }

  // Continuous mode: drain until idle, then keep a slow heartbeat loop.
  console.log(`daemon: open (pid ${process.pid}) on ${dbPath}; fake upstream=${fakeUpstream}; loop every ${Math.max(config.leases.heartbeatMs, 1000)}ms`);
  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });
  const loop = async () => {
    if (!running) {
      console.log("daemon: shutting down, stopping active agent containers & releasing lock");
      stopAllActiveAgentContainers();
      lock.release();
      process.exit(0);
    }
    try {
      await tick();
    } catch (e) {
      console.error(`tick error: ${e.message}`);
    }
    if (!running) {
      stopAllActiveAgentContainers();
      lock.release();
      process.exit(0);
    }
    setTimeout(loop, Math.max(config.leases.heartbeatMs, 1000));
  };
  loop();
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("daemon.mjs")) {
  main();
}
