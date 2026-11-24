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
import { dispatchEventBatchToTask } from "./router.mjs";
import { currentSkillSetHash } from "./skills.mjs";
import { dispatchKeyForInbox, ensurePrincipal } from "./ingress.mjs";
import { pullTelegramUpdates } from "./telegram-pull.mjs";
import { createCredentialService } from "./credentials.mjs";
import { pullMailMessages, createMailUpstream, splitMailCredential } from "./mail-adapter.mjs";
import { pullCalendarEvents, createCalendarUpstream, reproposeAfter412 } from "./calendar-adapter.mjs";
import { ingestInboundMail } from "./mail-triage.mjs";
import { processFiredFollowUpTimers, processFiredBriefingTimers } from "./briefing-followup.mjs";
import { runDreamingLoop } from "./dreaming.mjs";
import { withTx } from "./db/tx.mjs";
import {
  claimNextTask,
  completePendingDeliveryCheckpointInTx,
  completeTask,
  completeTaskInTx,
  completeInboxIfDone,
  heartbeat,
  workerStep,
  reapExpiredLeases,
  retryTask,
  updateScopeTurnCounts,
  deliveryAckCheckpoint,
  deliveryDone,
  deliveryReturnedInTx,
} from "./scheduler.mjs";
import { openScopeSession, assertSessionFresh } from "./memory.mjs";
import { writeAudit, authorizationRevision } from "./audit.mjs";
import { processDueTimers, cancelSatisfiedFollowUpReminders } from "./timers.mjs";
import { expireApprovals } from "./approvals.mjs";
import { expireStaleNotifications, dueNotifications } from "./outbox.mjs";
import { insertObjectRow } from "./objects.mjs";
import { createFakeRemote } from "./testing/fake-remote.mjs";
import { createHttpUpstream } from "./upstream-http.mjs";
import { createTelegramSendTransport } from "./telegram-send.mjs";
import { dispatchEffect, autoRecoverUnknown, reproposeHeadChanged } from "./effects.mjs";
import { createAdapterUpstream, headPrecondition, AdapterRefused } from "./adapters.mjs";
import { createContainerExecutor, createAgentLauncher, createAcquisitionLauncher } from "./container-executor.mjs";
import { isLoopbackModelEndpoint } from "./model-call.mjs";
import { cancelPreCallModelRequest, processPendingModelProposalsAsync } from "./model-requests.mjs";
import { parseRepoObservePayload, executeRepoObserveAcquisition } from "./repo-observe.mjs";
import { parseRepoTriagePayload, executeRepoTriageTask } from "./repo-triage.mjs";
import {
  translateTelegramCommandToPayload,
  formatGeneralUserPrompt,
  parseInboundMailPayload,
  maybeEnqueueTelegramTaskReply,
  executeMailTriageTask,
} from "./selfuse-dispatch.mjs";
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
  withTx(db, () => {
    ensurePrincipal(db, { platform: "local", subject: "owner" });
  });
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
  const telegramUpstream =
    !fakeUpstream && config.telegram?.apiBase
      ? createTelegramSendTransport({
          db,
          stateDir: dataDir,
          apiBase: config.telegram.apiBase,
          allowRealSend: config.telegram.allowRealSend,
          proxyUrl: config.telegram.proxyUrl ?? null,
          timeoutMs: config.telegram.timeoutMs,
          allowedRecipients: config.adapters.allowedRecipients,
        })
      : null;
  // Unit 5.3/5.4 dedicated child transports. Wiring one is a config fact —
  // each transport's own fail-closed ladder (allowRealMailSend /
  // allowRealCalendarWrite + credential slots) decides at submit time, so
  // a wired transport with closed gates sends zero bytes.
  const mailUpstream = !fakeUpstream && config.mail?.smtpHost
    ? createMailUpstream(db, { mail: config.mail })
    : null;
  const calendarUpstream = !fakeUpstream && config.calendar?.caldavUrl
    ? createCalendarUpstream(db, { calendar: config.calendar })
    : null;
  const adapterUpstream = baseUpstream || telegramUpstream || mailUpstream || calendarUpstream || config.model.baseUrl
    ? createAdapterUpstream(db, {
        baseUpstream,
        telegramUpstream,
        mailUpstream,
        calendarUpstream,
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

  // Unit 5.2 runtime state (in-memory only; everything durable lives in
  // the DB): the pull interval tracker, and the per-scope consecutive-turn
  // counter that backs the anti-starvation claim limit. The daemon-level
  // pull gate requires telegram.allowRealPull === true — an apiBase alone
  // only ever wired the OUTBOUND transport (Phase 4.3), and the send-only
  // fixtures must never see a getUpdates request. A loopback apiBase with
  // allowRealPull is the local verification seam, mirroring model.baseUrl.
  const credentials = createCredentialService(db);
  const telegramPullEnabled =
    config.telegram?.apiBase !== null &&
    config.telegram?.apiBase !== undefined &&
    config.telegram?.allowRealPull === true;
  let lastPullAt = 0;
  // Unit 5.3/5.4 runtime pull state (in-memory interval trackers; the gates
  // themselves are config-owned and fail closed inside the pull functions).
  const mailPullEnabled = config.mail?.imapHost !== null && config.mail?.imapHost !== undefined;
  const calendarPullEnabled = config.calendar?.caldavUrl !== null && config.calendar?.caldavUrl !== undefined;
  let lastMailPullAt = 0;
  let lastCalendarPullAt = 0;
  const scopeTurnCounts = new Map();
  // The merged model-input byte bound (Unit 5.2 batch semantics): the
  // ROUTER enforces it per attach, and the merge below re-checks it as
  // defense in depth. Both take the tighter of config.model.maxInputBytes
  // and the 128 KiB hard ceiling — a null config value means "no
  // deployment override", never "unbounded".
  const HARD_INPUT_CAP_BYTES = 128 * 1024;
  const mergedInputByteCap = Math.min(
    Number.isInteger(config.model.maxInputBytes) && config.model.maxInputBytes > 0
      ? config.model.maxInputBytes
      : HARD_INPUT_CAP_BYTES,
    HARD_INPUT_CAP_BYTES,
  );

  function parseImageLauncher(flagPrefix, label, createFn, { reapOnStart = false } = {}) {
    const flag = argv.find((a) => a.startsWith(flagPrefix));
    if (!flag) return null;
    try {
      const launcher = createFn(flag.slice(flagPrefix.length));
      if (reapOnStart) launcher.reapOrphanContainers();
      return launcher;
    } catch (e) {
      console.error(`${label} image flag invalid: ${e.message}`);
      process.exit(2);
    }
  }

  // Optional REAL container execution (Phase 3): the executor only exists
  // when the operator passes a digest-pinned image reference. Without the
  // flag the daemon says so honestly — QUEUED jobs stay durable.
  const executor = parseImageLauncher(
    "--execution-image=",
    "execution",
    (imageRef) =>
      createContainerExecutor(db, {
        stateDir: dataDir,
        imageRef,
        quotas: {
          cpus: config.containerPlaceholders.execution.cpus,
          memory: `${config.containerPlaceholders.execution.memoryGiB}g`,
          pids: config.containerPlaceholders.execution.pids,
          tmpfsSize: `${config.containerPlaceholders.execution.writableDiskGiB}g`,
        },
        machineWideMax: config.leases.maxOfflineJobsMachineWide,
      }),
    { reapOnStart: true },
  );

  // Optional production agent container launcher (Phase 4.1, ADR-0001 §2):
  // parallel to --execution-image, requires a digest-pinned agent image ref.
  const agentLauncher = parseImageLauncher(
    "--agent-image=",
    "agent",
    (imageRef) =>
      createAgentLauncher(db, {
        stateDir: dataDir,
        imageRef,
        quotas: {
          cpus: config.containerPlaceholders.agent.cpus,
          memory: `${config.containerPlaceholders.agent.memoryGiB}g`,
          pids: config.containerPlaceholders.agent.pids,
        },
      }),
    { reapOnStart: true },
  );
  const activeAgentContainers = new Map();

  const acquisitionLauncher = parseImageLauncher(
    "--acquisition-image=",
    "acquisition",
    (imageRef) =>
      createAcquisitionLauncher(db, {
        stateDir: dataDir,
        imageRef,
        enableHostGateway: config.acquisition.enableHostGateway,
      }),
    { reapOnStart: true },
  );

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
      const deadlineExpired = Boolean(info.deadlineAt && Date.now() >= info.deadlineAt);
      if (insp.running && taskRow?.state === "RUNNING" && !deadlineExpired) {
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
      const proposalFailed =
        mrRow?.state === "FAILED" ||
        mrRow?.state === "ORPHAN" ||
        (mrRow?.state === "EXECUTING" && Boolean(mrRow?.error_code));
      if (taskRow?.state === "RUNNING" && proposalFailed && (receipts.length > 0 || !insp.running)) {
        try {
          withTx(db, () => {
            completeTaskInTx(db, {
              taskId: info.taskId,
              attemptNo: info.attemptNo,
              leaseOwner: info.leaseOwner,
              fence: info.fence,
              now: Date.now(),
              resultClass: "infra_error",
              errorCode: mrRow?.error_code ?? "model_request_failed",
            });
          });
        } catch {}
      }
      const postTask = db.prepare("SELECT state FROM tasks WHERE id=?").get(info.taskId);
      if (postTask?.state === "SUCCEEDED" && !info.settledSeenAt) {
        info.settledSeenAt = Date.now();
      }
      const graceExpired = Boolean(info.settledSeenAt && Date.now() - info.settledSeenAt > 1500);
      const nonSuccessTerminal = postTask && postTask.state !== "RUNNING" && postTask.state !== "SUCCEEDED";
      if (receipts.length > 0 || !insp.running || graceExpired || nonSuccessTerminal || deadlineExpired) {
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

  // Every OPEN delivery of a failed task RETURNS (PENDING/ACKED ->
  // RETURNED, inbox closes if terminal) — a failed run never marks its
  // unread events DONE, and never strands them either. Caller owns the
  // transaction.
  function returnOpenDeliveries(db, { taskId, now, reason }) {
    const open = db
      .prepare("SELECT event_id FROM event_deliveries WHERE task_id=? AND state IN ('PENDING','ACKED')")
      .all(taskId);
    for (const d of open) {
      try {
        deliveryReturnedInTx(db, { eventId: d.event_id, taskId, now, reason });
      } catch {}
    }
    return open.length;
  }

  function enqueuePendingTelegramReplies() {
    if (config.telegram?.autoReplyOnTask !== true || !config.telegram?.apiBase) return 0;
    const rows = db
      .prepare(
        `SELECT t.id FROM tasks t
         JOIN scopes s ON s.id = t.scope_id
         WHERE t.state='SUCCEEDED' AND t.result_object_id IS NOT NULL
           AND (s.domain_key LIKE 'dm:telegram:%' OR s.domain_key LIKE 'group:telegram:%')
           AND NOT EXISTS (
             SELECT 1 FROM effects e WHERE e.task_id=t.id AND e.operation IN ('send_message', 'im.notify')
           )
         ORDER BY t.updated_at DESC LIMIT 20`,
      )
      .all();
    let enqueued = 0;
    for (const row of rows) {
      try {
        const res = maybeEnqueueTelegramTaskReply(db, dataDir, { config, taskId: row.id, now: Date.now() });
        if (res.enqueued) enqueued += 1;
      } catch (err) {
        console.error(`telegram-reply failed on ${row.id}: ${err.message}`);
      }
    }
    return enqueued;
  }

  // Watermark level changes stream an alert once per transition; the backup
  // runs once per window-day when the manifest key is configured.
  let lastDiskLevel = diskNow.level;
  let lastBackupDayKey = null;
  const backupKey = process.env.AEGISPI_BACKUP_MANIFEST_KEY ?? null;

  const tick = async () => {
    let now = Date.now();
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
    // 1. Sweeps: leases, abandoned pre-call RESERVED reservations, approvals, stale reminders, expired notifications.
    reapExpiredLeases(db, { now, maxAttempts: 3 });
    const abandonedReserved = db
      .prepare(
        `SELECT mr.request_id
         FROM model_requests mr
         JOIN attempts a ON a.id = mr.attempt_id
         JOIN tasks t ON t.id = mr.task_id
         WHERE mr.state='RESERVED' AND (a.state != 'ACTIVE' OR t.state != 'RUNNING')`,
      )
      .all();
    for (const r of abandonedReserved) {
      try {
        cancelPreCallModelRequest(db, { ledger, requestId: r.request_id, reason: "attempt_lost_pre_call", now });
      } catch {}
    }
    expireApprovals(db, { now });
    // The stateDir is REQUIRED: the sweep re-judges live follow-up reminders
    // through the contact_no_reply condition, which reads thread payloads
    // (fail closed without the reader — the F-3 wiring made this path live).
    cancelSatisfiedFollowUpReminders(db, { now, stateDir: dataDir });
    expireStaleNotifications(db, { now });
    // 2. Timers generate durable inbox events.
    const timers = processDueTimers(db, { now, stateDir: dataDir });
    // 2b. Telegram Route 1 pull (Unit 5.2): gated by config — without an
    //     apiBase (and, off loopback, allowRealPull + allowedChatIds + a
    //     live 'im' slot) this is a durable no-op. Interval-tracked in
    //     memory only; the durable cursor is system_state.
    let pullResult = null;
    if (telegramPullEnabled) {
      if (now - lastPullAt >= (config.telegram.pullIntervalMs ?? 5000)) {
        lastPullAt = now;
        try {
          pullResult = pullTelegramUpdates(db, dataDir, {
            telegram: config.telegram,
            credentials,
            now,
          });
          if (pullResult && typeof pullResult === "object" && !("skipped" in pullResult) && !("failed" in pullResult)) {
            console.error(
              `telegram-pull: admitted=${pullResult.admitted} dup=${pullResult.duplicates} unauthorized=${pullResult.skippedUnauthorized} offset=${pullResult.offsetBefore}->${pullResult.offsetAfter}`,
            );
          }
        } catch (e) {
          console.error(`telegram-pull: pull pass refused: ${String(e.message).slice(0, 160)}`);
        }
      }
    }
    // 2b2. Unit 5.3 mail pull (IMAP over TLS child): every gate is config-
    //      owned and re-checked inside pullMailMessages — null host or
    //      allowRealMailRead=false means zero IMAP calls. Fetched messages
    //      go straight into the triage ingest (F-3): one failed message is
    //      audited and skipped, never wedging the rest of the pass.
    let mailPullResult = null;
    if (mailPullEnabled) {
      if (now - lastMailPullAt >= (config.mail.pullIntervalMs ?? 15000)) {
        lastMailPullAt = now;
        try {
          mailPullResult = pullMailMessages(db, { mail: config.mail, now });
          if (mailPullResult && typeof mailPullResult === "object" && "fetched" in mailPullResult) {
            console.log(`mail-pull: fetched=${mailPullResult.fetched.length}`);
            const resolved = credentials.resolve("mail");
            const cred = resolved.ok ? splitMailCredential(resolved.value) : null;
            if (!cred) {
              console.error(`mail-ingest: skipped (${resolved.ok ? "credential slot unparseable" : resolved.reason}); the mailbox owner account is not resolvable`);
            } else {
              let ingested = 0;
              let refused = 0;
              for (const message of mailPullResult.fetched) {
                try {
                  const ing = ingestInboundMail(db, dataDir, {
                    now,
                    account: cred.user,
                    message,
                    ownerId: "prn:local:owner",
                    mailConfig: config.mail,
                  });
                  if (ing.admitted && !ing.duplicate) ingested += 1;
                } catch (e) {
                  refused += 1;
                  try {
                    withTx(db, () => {
                      writeAudit(db, {
                        code: "mail_ingest_refused",
                        details: { account: cred.user, error: String(e.message).slice(0, 200) },
                        now,
                      });
                    });
                  } catch {}
                }
              }
              if (ingested > 0 || refused > 0) {
                console.log(`mail-ingest: admitted=${ingested} refused=${refused}`);
              }
            }
          } else if (mailPullResult && typeof mailPullResult === "object" && "failed" in mailPullResult) {
            console.error(`mail-pull: failed: ${String(mailPullResult.failed).slice(0, 160)}`);
          }
        } catch (e) {
          console.error(`mail-pull: pass refused: ${String(e.message).slice(0, 160)}`);
        }
      }
    }
    // 2b3. Unit 5.4 calendar pull (CalDAV child): feeds the briefing
    //      composition; the write path is approval-only and lives in the
    //      dispatcher, never here.
    let calendarPullResult = null;
    if (calendarPullEnabled && now - lastCalendarPullAt >= (config.calendar.pullIntervalMs ?? 30000)) {
      lastCalendarPullAt = now;
      try {
        calendarPullResult = pullCalendarEvents(db, dataDir, { now, calendar: config.calendar });
        if (calendarPullResult && typeof calendarPullResult === "object" && "stored" in calendarPullResult) {
          console.log(`calendar-pull: stored=${calendarPullResult.stored}`);
        }
      } catch (e) {
        console.error(`calendar-pull: pass refused: ${String(e.message).slice(0, 160)}`);
      }
    }
    // 2b4. Unit 5.4 L3 Dreaming orchestration loop: quiet-hours gated,
    //      purpose='summary' independent-budget gated (dreaming.mjs).
    try {
      runDreamingLoop(db, dataDir, {
        now,
        quietHours: config.calendar?.quietHours ?? null,
        ledger,
        modelProvider: config.model.provider,
      });
    } catch (e) {
      console.error(`dreaming: pass refused: ${String(e.message).slice(0, 160)}`);
    }
    // 3. Pending inbox rows get their routing plan — recovery from any
    //    crash never depends on an in-memory wakeup. Unit 5.2: events are
    //    grouped per scope, ordered by aging-boosted effective priority,
    //    merged into a bounded batch anchored on the top event, and a live
    //    thread task can absorb a follow-up event only under the
    //    tighten-only rule (router.mjs).
    const pendingScopes = db
      .prepare("SELECT DISTINCT scope_id FROM inbox WHERE state='PENDING' AND verdict='ADMIT'")
      .all();
    for (const { scope_id: pendingScopeId } of pendingScopes) {
      try {
        dispatchEventBatchToTask(db, {
          scopeId: pendingScopeId,
          now,
          agingStepMs: config.router?.agingStepMs ?? null,
          maxBatchEvents: config.router?.batchMaxEvents ?? 8,
          maxSteps: config.budget.taskMaxSteps,
          deadlineAt: now + config.budget.taskMaxWallClockMs,
          skillSetHash: currentSkillSetHash(db, { scopeId: pendingScopeId }),
          dispatchKeyFor: dispatchKeyForInbox,
          // Byte-bounded, structured-exclusive merging: every attach
          // re-validates grants, closure, thread, task state and the
          // input cap; refusals stay PENDING and form their own task.
          stateDir: dataDir,
          inputByteCap: mergedInputByteCap,
        });
      } catch (e) {
        // One scope's dispatch failure (e.g. a CP4-blocked cross-scope
        // proposal) must not stop the other scopes from routing.
        console.error(`router: scope ${pendingScopeId} dispatch refused: ${String(e.message).slice(0, 160)}`);
      }
    }
    // 3b. Fired-timer orchestration (Unit 5.4, F-3): a FIRED follow-up timer
    //     becomes the owner's reminder effect/outbox (contact_no_reply), a
    //     FIRED morning_briefing timer becomes the structured digest — both
    //     anchored on the task that owns the timer's inbox event, both
    //     AT_MOST_ONCE, both cancelled as stale by the
    //     cancelSatisfiedFollowUpReminders sweep when the reply has landed.
    //     The wiring is STATE-driven, not tick-driven: the router anchors at
    //     most one batch per scope per tick, so a timer's task can land a
    //     tick AFTER the fire — the sweep below picks up every FIRED
    //     narrow-routine timer that has no notification outbox row yet, and
    //     the outbox-existence check makes the retry idempotent.
    let followupOutbox = [];
    let briefingOutbox = [];
    {
      const firedThisTick = new Set(timers.fired.map((f) => f.timer.id));
      const firedBacklog = db
        .prepare(
          `SELECT * FROM timers
           WHERE state='FIRED'
             AND (condition_json LIKE '%"type":"contact_no_reply"%' OR condition_json LIKE '%"type":"morning_briefing"%')
             AND NOT EXISTS (
               SELECT 1 FROM outbox o
               WHERE o.notify_reason = 'followup:' || timers.id OR o.notify_reason = 'briefing:' || timers.id
             )
           ORDER BY due_at ASC LIMIT 20`,
        )
        .all()
        .filter((t) => !firedThisTick.has(t.id))
        .map((t) => ({ timer: t, occurrence: t.occurrence_no, missedCount: 0 }));
      const wiredTimers = [...timers.fired, ...firedBacklog];
      if (wiredTimers.length > 0) {
        try {
          followupOutbox = processFiredFollowUpTimers(db, dataDir, {
            now,
            firedTimers: wiredTimers,
            destination: config.telegram?.ownerDestination ?? null,
            quietHours: config.calendar?.quietHours ?? null,
          });
        } catch (e) {
          console.error(`followup: pass refused: ${String(e.message).slice(0, 160)}`);
        }
        try {
          briefingOutbox = processFiredBriefingTimers(db, dataDir, {
            now,
            firedTimers: wiredTimers,
            destination: config.telegram?.ownerDestination ?? null,
            quietHours: config.calendar?.quietHours ?? null,
          });
        } catch (e) {
          console.error(`briefing: pass refused: ${String(e.message).slice(0, 160)}`);
        }
        for (const r of followupOutbox) {
          if (r.outboxId) console.log(`followup: timer ${r.timerId} -> outbox ${r.outboxId}${r.merged ? " (merged)" : ""}`);
        }
        for (const r of briefingOutbox) {
          if (r.outboxId) console.log(`briefing: timer ${r.timerId} -> outbox ${r.outboxId}${r.merged ? " (merged)" : ""}`);
        }
      }
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
    const excludeTriageTaskIds = new Set();
    const claimWithFairness = () =>
      claimNextTask(db, {
        now,
        leaseMs: config.leases.leaseMs,
        agingStepMs: config.router?.agingStepMs ?? null,
        scopeTurnState: scopeTurnCounts,
        scopeConsecutiveTurnLimit: config.router?.scopeConsecutiveTurnLimit ?? null,
      });
    const trackTurn = (claimed) => {
      // Per-scope consecutive-turn counting, never a whole-map wipe: two
      // chatty groups alternating claims accumulate independently, so the
      // saturated-filter eventually steps BOTH aside and the low-priority
      // lane finally claims (the old scope-switch clear() let them reset
      // each other forever — starvation).
      const eligibleScopeIds = new Set(
        db
          .prepare(
            `SELECT DISTINCT t.scope_id FROM tasks t JOIN scopes s ON s.id=t.scope_id
             WHERE t.state IN ('QUEUED','RETRY_WAIT') AND t.available_at<=? AND s.paused=0 AND s.epoch=t.scope_epoch`,
          )
          .all(now)
          .map((r) => r.scope_id),
      );
      updateScopeTurnCounts(scopeTurnCounts, {
        claimedScopeId: claimed ? claimed.scopeId : null,
        eligibleScopeIds,
      });
    };
    if (fakeUpstream) {
      claim = claimWithFairness();
      trackTurn(claim);
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
        // Consume EVERY pending delivery on the claimed task — a batch-
        // merged task (Unit 5.2: up to 8 same-scope events) must leave no
        // attached event stranded PENDING, or its inbox row can never
        // reach DONE.
        const pendingDeliveries = db
          .prepare("SELECT event_id FROM event_deliveries WHERE task_id=? AND state='PENDING' ORDER BY rowid ASC")
          .all(claim.taskId);
        for (const delivery of pendingDeliveries) {
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
    } else if (config.model.baseUrl || (executor && acquisitionLauncher && config.triage?.allowModelObserve === false)) {
      const canRunModel = Boolean(config.model.baseUrl) && (isLoopbackModelEndpoint(config.model.baseUrl) || config.model.allowRealModelCalls);
      const canRunModelFreeTriage = Boolean(executor && acquisitionLauncher && config.triage?.allowModelObserve === false);
      const peekNextClaimableIsTriage = () => {
        const cand = db
          .prepare(
            `SELECT t.id, s.paused AS scope_paused, s.epoch AS scope_epoch_now, t.scope_epoch,
               (SELECT count(*) FROM tasks t2 WHERE t2.scope_id=t.scope_id AND t2.state='RUNNING') AS running_in_scope
             FROM tasks t JOIN scopes s ON s.id=t.scope_id
             WHERE t.state IN ('QUEUED','RETRY_WAIT') AND t.available_at<=?
             ORDER BY t.priority DESC, t.available_at ASC, t.created_at ASC`,
          )
          .all(now);
        for (const row of cand) {
          if (row.scope_paused || row.scope_epoch_now !== row.scope_epoch || row.running_in_scope >= 1) continue;
          const del = db.prepare("SELECT event_id FROM event_deliveries WHERE task_id=? AND state='PENDING'").get(row.id);
          if (!del) return false;
          const inb = db.prepare("SELECT payload_object_id FROM inbox WHERE id=?").get(del.event_id);
          const obj = inb ? db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(inb.payload_object_id) : null;
          if (!obj?.storage_ref) return false;
          try {
            const p = JSON.parse(readFileSync(join(dataDir, ...obj.storage_ref.split("/")), "utf8"));
            return p?.kind === "repo_triage";
          } catch {
            return false;
          }
        }
        return false;
      };
      const awaitingModel = db
        .prepare("SELECT count(*) c FROM tasks WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELLED','DEAD')")
        .get().c;
      if (!canRunModel && !(canRunModelFreeTriage && peekNextClaimableIsTriage())) {
        if (awaitingModel > 0) {
          console.error(
            `worker: ${awaitingModel} task(s) await a model call but the configured baseUrl is not authorized (model.allowRealModelCalls is false and baseUrl is not loopback); nothing is claimed or settled`,
          );
        }
      } else {
        if (agentLauncher || canRunModelFreeTriage) {
          claim = claimWithFairness();
          trackTurn(claim);
          if (claim) {
            heartbeat(db, { ...claim, now, leaseMs: config.leases.leaseMs });
            const taskRow = db
              .prepare("SELECT scope_id, principal_id, skill_set_hash, deadline_at FROM tasks WHERE id=?")
              .get(claim.taskId);
            const scopeRow = db.prepare("SELECT domain_key FROM scopes WHERE id=?").get(taskRow.scope_id);
            // Session anchor (CP2 freshness, Unit 5.1): the attempt freezes
            // the scope's L0 + the CURRENT authorization_revision the
            // moment it claims. A principal with a live read grant gets a
            // real session (attempts.session_id; model-requests re-checks
            // assertSessionFresh before the call is issued). Without a
            // grant the run is memory-less and the anchor is the captured
            // revision, re-compared before launch — either way a mid-flight
            // revoke aborts the attempt instead of feeding a stale context.
            let sessionAnchor = null;
            try {
              const session = openScopeSession(db, dataDir, {
                sessionId: `ses:task:${claim.taskId}:${claim.attemptNo}`,
                scopeId: taskRow.scope_id,
                principalId: taskRow.principal_id,
                skillSetHash: taskRow.skill_set_hash,
                now,
              });
              withTx(db, () => {
                db.prepare("UPDATE attempts SET session_id=? WHERE id=?").run(session.sessionId, claim.attemptId);
              });
              sessionAnchor = { sessionId: session.sessionId };
            } catch {
              sessionAnchor = { revision: authorizationRevision(db) };
            }
            let callInput = null;
            // Unit 5.2 batch semantics: the model input joins EVERY pending
            // delivery's payload (a batch-merged task carries up to 8
            // same-scope events), byte-accounted against the SAME cap the
            // router enforced at attach time — whole payloads only, never a
            // mid-rune slice, so an unread event is never half-included.
            // Single-delivery tasks — every pre-5.2 suite — read exactly
            // as before.
            const pendingDeliveries = db
              .prepare("SELECT event_id FROM event_deliveries WHERE task_id=? AND state='PENDING' ORDER BY rowid ASC")
              .all(claim.taskId);
            const payloadTexts = [];
            let mergedBytes = 0;
            for (const delivery of pendingDeliveries) {
              const inboxRow = db.prepare("SELECT payload_object_id FROM inbox WHERE id=?").get(delivery.event_id);
              const obj = inboxRow
                ? db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(inboxRow.payload_object_id)
                : null;
              const payloadPath = obj?.storage_ref ? join(dataDir, ...obj.storage_ref.split("/")) : null;
              if (payloadPath && existsSync(payloadPath)) {
                try {
                  const text = readFileSync(payloadPath, "utf8");
                  const bytes = Buffer.byteLength(text, "utf8");
                  if (payloadTexts.length > 0 && mergedBytes + bytes > mergedInputByteCap) break;
                  payloadTexts.push(text);
                  mergedBytes += bytes;
                } catch {}
              }
            }
            if (payloadTexts.length === 1) {
              callInput = payloadTexts[0];
            } else if (payloadTexts.length > 1) {
              callInput = payloadTexts.join("\n");
            }
            let launchInput = callInput;
            let skipLaunch = false;
            // A single payload alone over the cap can never be launched:
            // the task fails infra_error and its delivery dies visibly
            // (never a silent half-truncation that would mark an unread
            // event DONE).
            if (callInput !== null && Buffer.byteLength(callInput, "utf8") > mergedInputByteCap) {
              writeAudit(db, {
                code: "event_payload_over_input_cap",
                taskId: claim.taskId,
                details: {
                  bytes: Buffer.byteLength(callInput, "utf8"),
                  cap: mergedInputByteCap,
                  deliveries: pendingDeliveries.length,
                },
                now: Date.now(),
              });
              withTx(db, () => {
                completeTaskInTx(db, {
                  ...claim,
                  now: Date.now(),
                  resultClass: "infra_error",
                  errorCode: "event_payload_over_input_cap",
                });
                for (const delivery of pendingDeliveries) {
                  db.prepare(
                    "UPDATE event_deliveries SET state='DEAD', updated_at=? WHERE event_id=? AND task_id=? AND state IN ('PENDING','ACKED')",
                  ).run(Date.now(), delivery.event_id, claim.taskId);
                  completeInboxIfDone(db, { eventId: delivery.event_id, now: Date.now() });
                }
              });
              skipLaunch = true;
            }
            const translatedInput = !skipLaunch && callInput !== null
              ? translateTelegramCommandToPayload(callInput, { scopeDomainKey: scopeRow.domain_key })
              : callInput;
            launchInput = translatedInput;
            const parsedTriage = skipLaunch ? { isTriage: false } : parseRepoTriagePayload(translatedInput);
            if (parsedTriage.isTriage) {
              excludeTriageTaskIds.add(claim.taskId);
              try {
                await executeRepoTriageTask(db, {
                  stateDir: dataDir,
                  config,
                  ledger,
                  acquisitionLauncher,
                  agentLauncher,
                  executor,
                  diskLevel: disk.level,
                  claim,
                  taskRow,
                  scopeRow,
                  parsed: parsedTriage,
                  now,
                });
              } catch (err) {
                console.error(`triage failed unexpectedly on ${claim.taskId}: ${err.message}`);
                try {
                  withTx(db, () => {
                    completeTaskInTx(db, {
                      ...claim,
                      now: Date.now(),
                      resultClass: "infra_error",
                      errorCode: "triage_unexpected_error",
                    });
                    // A failed triage never marks its events DONE (they
                    // were not processed): every open delivery RETURNS so
                    // the honest state is visible and re-routable.
                    returnOpenDeliveries(db, { taskId: claim.taskId, now: Date.now(), reason: "triage_unexpected_error" });
                  });
                } catch {}
              }
              skipLaunch = true;
            }
            const parsedMail = skipLaunch ? { isMail: false } : parseInboundMailPayload(launchInput);
            if (parsedMail.isMail && config.mail?.autoDraftReplies === true && !skipLaunch) {
              if (canRunModel && agentLauncher) {
                excludeTriageTaskIds.add(claim.taskId);
                try {
                  await executeMailTriageTask(db, {
                    stateDir: dataDir,
                    config,
                    ledger,
                    agentLauncher,
                    claim,
                    taskRow,
                    scopeRow,
                    mailPayload: parsedMail.mail,
                    now,
                  });
                } catch (err) {
                  console.error(`mail-triage failed unexpectedly on ${claim.taskId}: ${err.message}`);
                  try {
                    withTx(db, () => {
                      completeTaskInTx(db, {
                        ...claim,
                        now: Date.now(),
                        resultClass: "infra_error",
                        errorCode: "mail_triage_unexpected_error",
                      });
                      returnOpenDeliveries(db, { taskId: claim.taskId, now: Date.now(), reason: "mail_triage_unexpected_error" });
                    });
                  } catch {}
                }
              } else {
                try {
                  withTx(db, () => {
                    completeTaskInTx(db, {
                      ...claim,
                      now: Date.now(),
                      resultClass: "infra_error",
                      errorCode: "mail_triage_unavailable",
                    });
                    returnOpenDeliveries(db, { taskId: claim.taskId, now: Date.now(), reason: "mail_triage_unavailable" });
                  });
                } catch {}
              }
              skipLaunch = true;
            }
            const parsedObserve = skipLaunch ? { isObserve: false } : parseRepoObservePayload(translatedInput);
            if (!skipLaunch && !canRunModel) {
              skipLaunch = true;
            }
            if (parsedObserve.isObserve && !skipLaunch) {
              if (!parsedObserve.valid) {
                writeAudit(db, {
                  code: "acquisition_refused",
                  taskId: claim.taskId,
                  details: { reason_code: parsedObserve.code, reason: parsedObserve.reason },
                  now: Date.now(),
                });
                completeTask(db, {
                  ...claim,
                  now: Date.now(),
                  resultClass: "infra_error",
                  errorCode: parsedObserve.code,
                });
                skipLaunch = true;
              } else {
                const acqOut = await executeRepoObserveAcquisition(db, {
                  stateDir: dataDir,
                  config,
                  acquisitionLauncher,
                  taskId: claim.taskId,
                  attemptId: claim.attemptId,
                  attemptNo: claim.attemptNo,
                  fence: claim.fence,
                  scopeId: taskRow.scope_id,
                  targetId: parsedObserve.targetId,
                  question: parsedObserve.question,
                  now,
                  onProgress: () => heartbeat(db, { ...claim, now: Date.now(), leaseMs: config.leases.leaseMs }),
                });
                try {
                  heartbeat(db, { ...claim, now: Date.now(), leaseMs: config.leases.leaseMs });
                } catch {}
                if (!acqOut.ok) {
                  completeTask(db, {
                    ...claim,
                    now: Date.now(),
                    resultClass: "infra_error",
                    resultObjectId: acqOut.reportObjectId ?? null,
                    errorCode: acqOut.code,
                  });
                  // A failed acquisition never strands its deliveries:
                  // every OPEN delivery RETURNS, visibly, instead of
                  // lingering PENDING on a terminal task.
                  withTx(db, () => {
                    returnOpenDeliveries(db, { taskId: claim.taskId, now: Date.now(), reason: acqOut.code });
                  });
                  skipLaunch = true;
                } else {
                  launchInput = acqOut.promptText;
                }
              }
            }
            if (!skipLaunch) {
              // CP2 freshness gate before launch: a revoke since the claim
              // (or since the acquisition await above) invalidates the
              // attempt's anchor — the task requeues under the new
              // authorization revision instead of running on a stale
              // context ("please ignore" notes are not a mechanism).
              const anchorFresh = sessionAnchor.sessionId !== undefined
                ? assertSessionFresh(db, { sessionId: sessionAnchor.sessionId }).fresh
                : authorizationRevision(db) === sessionAnchor.revision;
              if (!anchorFresh) {
                writeAudit(db, {
                  code: "attempt_abandoned_authorization_changed",
                  taskId: claim.taskId,
                  details: {
                    attempt_id: claim.attemptId,
                    session_id: sessionAnchor.sessionId ?? null,
                    anchor_revision: sessionAnchor.revision ?? null,
                  },
                  now: Date.now(),
                });
                try {
                  retryTask(db, {
                    ...claim,
                    now: Date.now(),
                    backoffMs: 1000,
                    errorCode: "authorization_revision_changed_midflight",
                  });
                } catch (retryErr) {
                  console.error(`worker: stale attempt ${claim.attemptId} could not requeue: ${retryErr.message}`);
                }
                skipLaunch = true;
              } else {
                const modelKey = config.model.provider && config.model.modelId
                  ? `${config.model.provider}/${config.model.modelId}`
                  : "deepseek/deepseek-flash";
                const userPrompt = formatGeneralUserPrompt(launchInput);
                const launched = agentLauncher.launchAttempt({
                  taskId: claim.taskId,
                  attemptId: claim.attemptId,
                  attemptNo: claim.attemptNo,
                  fence: claim.fence,
                  scopeDomainKey: scopeRow.domain_key,
                  modelRequest: {
                    purpose: "worker",
                    modelId: modelKey,
                    messages: [{ role: "user", content: userPrompt ?? `task ${claim.taskId}` }],
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
          }
        }
        // Refresh wall clock after awaiting acquisition/triage so lease checks in model proposal processing never evaluate against stale tick start time.
        now = Date.now();
        if (canRunModel) {
          const batch = await processPendingModelProposalsAsync(db, {
            stateDir: dataDir,
            config,
            ledger,
            leaseMs: config.leases.leaseMs,
            heartbeatMs: config.leases.heartbeatMs,
            completeActiveTask: true,
            excludeTaskIds: excludeTriageTaskIds,
            now,
            useWallClockAfterCall: true,
          });
          proposalProcessed = batch.processed;
        }
      }
      now = Date.now();
      reclaimFinishedAgentContainers();
    } else {
      // No model path is configured: nothing is claimed, nothing settles.
      // Say so on the record instead of pretending the loop is production.
      const awaiting = db
        .prepare("SELECT count(*) c FROM tasks WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELLED','DEAD')")
        .get().c;
      if (awaiting > 0) {
        console.error(`worker: ${awaiting} task(s) await an execution path; no model baseUrl is configured (model.baseUrl is null) — nothing is claimed or settled (fixture settlements require --fake-upstream)`);
      }
    }
    const telegramRepliesEnqueued = enqueuePendingTelegramReplies();
    const canDispatchEffectRow = (row) =>
      Boolean(
        baseUpstream ||
          row.operation === "model.inference" ||
          (telegramUpstream &&
            (row.operation === "im.notify" || row.operation === "send_message") &&
            telegramUpstream.canHandle(row.resource)) ||
          (mailUpstream && row.operation === "mail.send" && mailUpstream.canHandle(row.resource)) ||
          (calendarUpstream && row.operation === "calendar.write" && calendarUpstream.canHandle(row.resource)),
      );
    // 5. Effect dispatch & UNKNOWN reconciler (non-model READY/UNKNOWN stay durable when baseUpstream is null).
    if (adapterUpstream) {
      const unknowns = db.prepare("SELECT id, retry_mode, operation, resource FROM effects WHERE state='UNKNOWN'").all().filter(canDispatchEffectRow);
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
      const ready = db.prepare("SELECT id, operation, resource FROM effects WHERE state='READY' AND next_attempt_at<=? ORDER BY next_attempt_at").all(now).filter(canDispatchEffectRow);
      for (const e of ready) {
        try {
          const row = db.prepare("SELECT * FROM effects WHERE id=?").get(e.id);
          // Head precondition (06 section 6: the CAS transaction re-checks the
          // target resource precondition) — INSIDE the dispatcher transaction.
          const precondition = adapterUpstream ? headPrecondition(adapterUpstream, row) : () => true;
          dispatchEffect(db, adapterUpstream, {
            effectId: e.id, now, precondition,
          });
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
      // Unit 5.4: a calendar.write that FAILED with a server-side 412 (the
      // race between the head precondition and the PUT) names head_changed;
      // the old card is cancelled and a NEW card pins the CURRENT ETag for
      // re-approval — zero silent overwrites, in either race order.
      const failedHeadChanged = db
        .prepare("SELECT id, resource FROM effects WHERE operation='calendar.write' AND state='FAILED' AND last_error LIKE 'head_changed:%'")
        .all();
      for (const f of failedHeadChanged) {
        try {
          const head = calendarUpstream.lookupHead({ targetResource: f.resource });
          if (!head.ok) {
            console.error(`calendar 412 repropose refused ${f.id}: ${head.reason}`);
            continue;
          }
          const out = reproposeAfter412(db, dataDir, { now, effectId: f.id, currentHead: head.head });
          console.log(`calendar-412: ${f.id} -> re-approval ${out.newApprovalId} pinned to ${head.head}`);
        } catch (e) {
          console.error(`calendar 412 repropose refused ${f.id}: ${String(e.message).slice(0, 160)}`);
        }
      }
    }
    if (!baseUpstream) {
      const unservedReady = db.prepare("SELECT resource, operation FROM effects WHERE state='READY' AND operation!='model.inference'").all().filter((r) => !canDispatchEffectRow(r));
      const unservedUnknown = db.prepare("SELECT resource, operation FROM effects WHERE state='UNKNOWN' AND operation!='model.inference'").all().filter((r) => !canDispatchEffectRow(r));
      if (unservedReady.length > 0) {
        console.error("dispatcher: READY effects exist but no submit transport is wired (upstream.submitUrl unset); they stay durable and dispatched later");
      } else if (unservedUnknown.length > 0) {
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
    const pendingScopeCount = pendingScopes.length;
    const scheduledNotifications = followupOutbox.filter((r) => r.outboxId).length + briefingOutbox.filter((r) => r.outboxId).length;
    if (timers.fired.length > 0 || pendingScopeCount > 0 || claim || proposalProcessed > 0 || due.length > 0 || scheduledNotifications > 0 || telegramRepliesEnqueued > 0) {
      console.log(
        `tick: timers=${timers.fired.length} dispatched_scopes=${pendingScopeCount} claimed=${claim ? claim.taskId : "none"} proposals=${proposalProcessed} reminders=${followupOutbox.filter((r) => r.outboxId).length} briefings=${briefingOutbox.filter((r) => r.outboxId).length} due_notifications=${due.length} tg_replies=${telegramRepliesEnqueued}`,
      );
    }
    return timers.fired.length + pendingScopeCount + (claim ? 1 : 0) + proposalProcessed + due.length + scheduledNotifications + telegramRepliesEnqueued;
  };

  if (args.has("--once")) {
    let exitCode = 0;
    try {
      let rounds = 0;
      while (rounds < 20) {
        const work = await tick();
        rounds += 1;
        const waitDeadline = Date.now() + Math.max(30000, (config.model.callTimeoutMs ?? 60000) + 15000);
        if (agentLauncher && activeAgentContainers.size > 0) {
          while (activeAgentContainers.size > 0 && Date.now() < waitDeadline) {
            reclaimFinishedAgentContainers();
            if (activeAgentContainers.size === 0) break;
            await processPendingModelProposalsAsync(db, {
              stateDir: dataDir,
              config,
              ledger,
              leaseMs: config.leases.leaseMs,
              heartbeatMs: config.leases.heartbeatMs,
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
          if (enqueuePendingTelegramReplies() > 0) {
            continue;
          }
          if (db.prepare("SELECT count(*) c FROM tasks WHERE state='QUEUED'").get().c > 0) {
            continue;
          }
        }
        if (enqueuePendingTelegramReplies() > 0) {
          continue;
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
  let loopTimer = null;
  const shutdownNow = () => {
    console.log("daemon: shutting down, stopping active agent containers & releasing lock");
    stopAllActiveAgentContainers();
    lock.release();
    process.exit(0);
  };
  const onSignal = () => {
    running = false;
    if (loopTimer) {
      clearTimeout(loopTimer);
      loopTimer = null;
      shutdownNow();
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const loop = async () => {
    if (!running) {
      shutdownNow();
      return;
    }
    try {
      await tick();
    } catch (e) {
      console.error(`tick error: ${e.message}`);
    }
    if (!running) {
      shutdownNow();
      return;
    }
    loopTimer = setTimeout(loop, Math.max(config.leases.heartbeatMs, 1000));
  };
  loop();
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("daemon.mjs")) {
  main();
}
