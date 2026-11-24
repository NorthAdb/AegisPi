import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { lockedNodeGuard, makeSuite, makeWorkspace, suiteExit, writeReport } from "../lib/harness.mjs";
import { grantPermission } from "../../../apps/daemon/src/acl.mjs";
import { createAdapterUpstream } from "../../../apps/daemon/src/adapters.mjs";
import { decideApproval } from "../../../apps/daemon/src/approvals.mjs";
import { processFiredFollowUpTimers } from "../../../apps/daemon/src/briefing-followup.mjs";
import { ConfigError, loadDaemonConfig } from "../../../apps/daemon/src/config.mjs";
import { createConsoleApp } from "../../../apps/daemon/src/console/api.mjs";
import { createCredentialService } from "../../../apps/daemon/src/credentials.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { ensureModelRequestsTable, loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { withTx } from "../../../apps/daemon/src/db/tx.mjs";
import { dispatchEffect, extraFieldsOfAction, proposeEffect } from "../../../apps/daemon/src/effects.mjs";
import { ensurePrincipal, ensureScope, receiveEvent } from "../../../apps/daemon/src/ingress.mjs";
import { createMailUpstream } from "../../../apps/daemon/src/mail-adapter.mjs";
import { buildMailSendIntent, ensureMailScope, proposeMailReplyEffect } from "../../../apps/daemon/src/mail-triage.mjs";
import { insertObjectRow, putObjectContent } from "../../../apps/daemon/src/objects.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { claimNextTask, completeTask } from "../../../apps/daemon/src/scheduler.mjs";
import {
  formatGeneralUserPrompt,
  maybeEnqueueTelegramTaskReply,
  translateTelegramCommandToPayload,
} from "../../../apps/daemon/src/selfuse-dispatch.mjs";
import { resolveVerifiedNotificationText } from "../../../apps/daemon/src/telegram-send.mjs";
import { createTimer, processDueTimers, timerIdFor } from "../../../apps/daemon/src/timers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");
const OWNER = "prn:local:owner";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

lockedNodeGuard();

const suite = makeSuite("selfuse");

function freshDb(tag) {
  const ws = makeWorkspace(`selfuse-${tag}`);
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  ensureModelRequestsTable(db);
  return { ws, db };
}

function baseDefaults(overrides = {}) {
  return {
    schemaVersion: 1,
    budget: {
      taskMicroUsd: 800000,
      taskMaxSteps: 25,
      taskMaxWallClockSeconds: 900,
      dayMicroUsd: 5000000,
      cacheWarming: "off",
      purposes: ["router", "worker", "summary", "classify"],
    },
    leases: {
      heartbeatSeconds: 10,
      leaseSeconds: 45,
      offlineJobDeadlineSeconds: 90,
      maxConcurrentAgentsPerScope: 1,
      maxOfflineJobsMachineWide: 2,
    },
    time: { timezoneIANA: "Asia/Hong_Kong", epochUnit: "unixMilliseconds" },
    sqlite: { driver: "node:sqlite", bundledSqlite: "3.54.1", journalMode: "WAL", synchronous: "FULL" },
    containerPlaceholders: {
      agent: { cpus: 1, memoryGiB: 1, pids: 256, writableDiskGiB: 2 },
      execution: { cpus: 1, memoryGiB: 2, pids: 256, writableDiskGiB: 4 },
    },
    ...overrides,
  };
}

function seedOwnerGrants(db, scopeId, now) {
  for (const permission of ["read", "request", "approve", "admin"]) {
    grantPermission(db, { scopeId, principalId: OWNER, permission, now });
  }
}

async function startFixtureHost() {
  const portsFile = join(makeWorkspace("selfuse-fixtures").stateDir, "ports.json");
  const fixturePath = join(REPO_ROOT, "evals", "phase5", "scenarios", "fixtures", "serve-fixtures.mjs");
  const child = spawn(process.execPath, [fixturePath, portsFile], { stdio: "ignore" });
  const close = () => {
    try {
      child.kill("SIGKILL");
    } catch {}
  };
  let ports = null;
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(portsFile)) {
      ports = JSON.parse(readFileSync(portsFile, "utf8"));
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ports) {
    close();
    throw new Error("fixture host did not report ports");
  }
  let pendingId = 0;
  const pending = new Map();
  const bufferParts = [];
  const sock = netConnect({ host: "127.0.0.1", port: ports.controlPort });
  sock.on("data", (d) => {
    bufferParts.push(d);
    let buf = Buffer.concat(bufferParts);
    bufferParts.length = 0;
    while (true) {
      const idx = buf.indexOf(0x0a);
      if (idx === -1) break;
      const line = buf.subarray(0, idx).toString("utf8");
      buf = buf.subarray(idx + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg.result);
          pending.delete(msg.id);
        }
      } catch {}
    }
    if (buf.length > 0) bufferParts.push(buf);
  });
  const control = (op, args = {}) =>
    new Promise((resolve) => {
      const id = (pendingId += 1);
      pending.set(id, resolve);
      sock.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  return {
    smtpPort: ports.smtpPort,
    smtpCount: async () => (await control("smtpStats")).count,
    close: () => {
      try {
        sock.destroy();
      } catch {}
      close();
    },
  };
}

// ---------------------------------------------------------------------------
// 1. config.mjs boundary normalization & validation
{
  const ws = makeWorkspace("selfuse-config");
  const validPath = join(ws.stateDir, "valid.json");
  writeFileSync(
    validPath,
    JSON.stringify(
      baseDefaults({
        telegram: {
          allowedChatIds: ["123"],
          ownerDestination: "dm:telegram:123",
          pullIntervalMs: 5000,
        },
        mail: {
          allowedSenders: ["  Alice@Example.Test ", "DM:Telegram:123"],
          allowedRecipients: ["Bob@Example.Test"],
          pullIntervalMs: 1000,
        },
        calendar: {
          pullIntervalMs: 600000,
        },
        adapters: {
          fixedSendingIdentity: "aegispi@local",
          allowedRecipients: ["Carol@Example.Test", "dm:telegram:999", "group:telegram:-100123"],
        },
      }),
      null,
      2,
    ),
  );
  const cfg = loadDaemonConfig({ path: validPath });
  suite.check(
    "config-recipient-normalization",
    cfg.mail.allowedSenders[0] === "alice@example.test" &&
      cfg.mail.allowedRecipients[0] === "bob@example.test" &&
      cfg.adapters.allowedRecipients[0] === "carol@example.test" &&
      cfg.adapters.allowedRecipients[1] === "dm:telegram:999" &&
      cfg.adapters.allowedRecipients[2] === "group:telegram:-100123",
    JSON.stringify({
      mailSenders: cfg.mail.allowedSenders,
      mailRecipients: cfg.mail.allowedRecipients,
      adapterRecipients: cfg.adapters.allowedRecipients,
    }),
  );
  suite.check(
    "config-owner-destination-valid",
    cfg.telegram.ownerDestination === "dm:telegram:123" &&
      cfg.mail.pullIntervalMs === 1000 &&
      cfg.calendar.pullIntervalMs === 600000,
    JSON.stringify({
      ownerDestination: cfg.telegram.ownerDestination,
      mailPull: cfg.mail.pullIntervalMs,
      calPull: cfg.calendar.pullIntervalMs,
    }),
  );

  const expectConfigError = (name, overrides) => {
    const p = join(ws.stateDir, `${name}.json`);
    writeFileSync(p, JSON.stringify(baseDefaults(overrides), null, 2));
    let threw = false;
    try {
      loadDaemonConfig({ path: p });
    } catch (err) {
      threw = err instanceof ConfigError;
    }
    suite.check(name, threw, `expected ConfigError for ${name}`);
  };

  expectConfigError("config-owner-destination-invalid", {
    telegram: { ownerDestination: "invalid-dest" },
  });
  expectConfigError("config-mail-pull-interval-too-low", {
    mail: { pullIntervalMs: 500 },
  });
  expectConfigError("config-calendar-pull-interval-non-int", {
    calendar: { pullIntervalMs: 1500.5 },
  });
}

// ---------------------------------------------------------------------------
// 2. adapters.mjs + mail-adapter.mjs mixed-case recipients over loopback SMTP
{
  const fx = await startFixtureHost();
  const { ws, db } = freshDb("mail-case");
  const prevMailCred = process.env.AEGISPI_MAIL_CREDENTIAL;
  try {
    const now = Date.now();
    withTx(db, () => ensurePrincipal(db, { platform: "local", subject: "owner" }));
    const mailScope = ensureMailScope(db, { account: "owner@example.test", ownerId: OWNER, policyVersion: "pv1" });
    seedOwnerGrants(db, mailScope.id, now);

    const creds = createCredentialService(db);
    creds.registerSlot({
      slot: "mail",
      purpose: "mail",
      source: "imap-smtp",
      envName: "AEGISPI_MAIL_CREDENTIAL",
      actorId: OWNER,
      now,
    });
    process.env.AEGISPI_MAIL_CREDENTIAL = "owner@example.test:fixture-mail-pass";

    const mailConfig = {
      imapHost: "127.0.0.1",
      imapPort: 993,
      imapTls: true,
      smtpHost: "127.0.0.1",
      smtpPort: fx.smtpPort,
      smtpTls: true,
      allowRealMailRead: false,
      allowRealMailSend: true,
      allowedFolders: ["INBOX"],
      allowedSenders: ["alice@example.test"],
      allowedRecipients: ["alice@example.test"],
      approvalTtlMs: 14400000,
      maxAttachmentBytes: 4194304,
    };
    const adaptersConfig = {
      fixedSendingIdentity: "aegispi@local",
      allowedRecipients: ["alice@example.test"],
      allowedRepos: [],
      allowedBranches: [],
    };
    const mailUpstream = createMailUpstream(db, { mail: mailConfig, now: () => Date.now() });
    const adapterUpstream = createAdapterUpstream(db, {
      baseUpstream: null,
      mailUpstream,
      transportKind: "real",
      policy: { allowRealExternalWrites: true },
      credentials: { mail: "slot-wired" },
      config: adaptersConfig,
    });

    const bodyText = "Mixed-case recipient verification body.";
    const contentHash = createHash("sha256").update(bodyText, "utf8").digest("hex");
    const vOk = adapterUpstream.validateIntent("mail.send", {
      targetResource: "mail:Alice@Example.Test",
      contentHash,
      extra: {
        recipients: ["Alice@Example.Test"],
        sendingIdentity: "aegispi@local",
      },
    });
    const vBad = adapterUpstream.validateIntent("mail.send", {
      targetResource: "mail:Mallory@Example.Test",
      contentHash,
      extra: {
        recipients: ["Mallory@Example.Test"],
        sendingIdentity: "aegispi@local",
      },
    });
    suite.check(
      "adapter-mixed-case-validate-intent",
      vOk.ok === true && vBad.ok === false,
      JSON.stringify({ vOk, vBad }),
    );

    const inbound = receiveEvent(db, ws.stateDir, {
      now,
      source: "mail",
      sourceEventId: "<case-1@example.test>",
      principal: { platform: "local", subject: "owner" },
      scope: {
        kind: "owner_dm",
        domainKey: "dm:mail:owner@example.test",
        channel: "mail",
        conversationId: "owner@example.test",
      },
      threadKey: "mail:<case-1@example.test>",
      priority: 5,
      policyVersion: "pv1",
      payload: { kind: "mail", envelopeFrom: "alice@example.test", subject: "Case test" },
      verdict: "ADMIT",
    });
    const dispatched = dispatchEventToTask(db, {
      inboxId: inbound.inboxId,
      dispatchKey: "mail-case",
      now,
      priority: 5,
      maxSteps: 10,
      deadlineAt: now + 3600_000,
      skillSetHash: "mail-test",
    });
    const claim = claimNextTask(db, { now, leaseMs: 60_000 });
    const evidence = withTx(db, () =>
      insertObjectRow(db, {
        scopeId: mailScope.id,
        kind: "mail_draft",
        sourceUri: "selfuse:case",
        sourceActor: "host",
        content: bodyText,
        observedAt: now,
        requiredScopeIds: [mailScope.id],
      }),
    );
    const evidenceHash = db.prepare("SELECT content_hash FROM objects WHERE id=?").get(evidence.id).content_hash;
    const proposed = proposeEffect(db, ws.stateDir, {
      now,
      taskId: dispatched.taskId,
      attemptId: claim.attemptId,
      effectType: "mail",
      domainKey: "dm:mail:owner@example.test",
      naturalKey: "case-mixed-send",
      operationIntent: {
        targetResource: "mail:Alice@Example.Test",
        operation: "mail.send",
        contentHash,
        evidenceManifestHash: evidenceHash,
        parentObjectIds: [evidence.id],
        payloadContent: bodyText,
        extra: {
          to: ["Alice@Example.Test"],
          cc: [],
          bcc: [],
          recipients: ["Alice@Example.Test"],
          sendingIdentity: "aegispi@local",
          subject: "Re: Case test",
          bodyText,
        },
      },
      retryMode: "AT_MOST_ONCE",
      provider: "smtp",
      resource: "dm:mail:owner@example.test",
      requiresApproval: true,
      approverPrincipalId: OWNER,
      expiresAt: now + 3600_000,
    });
    const approved = decideApproval(db, {
      approvalId: proposed.approvalId,
      decision: "approve",
      actionHash: proposed.actionHash,
      nonce: proposed.approvalNonce,
      approverId: OWNER,
      now,
    });
    const beforeCount = await fx.smtpCount();
    const sent = dispatchEffect(db, adapterUpstream, { effectId: proposed.effectId, now });
    const afterCount = await fx.smtpCount();
    suite.check(
      "mail-mixed-case-loopback-smtp-dispatch",
      approved.accepted === true && sent.state === "SUCCEEDED" && afterCount === beforeCount + 1,
      JSON.stringify({ approved: approved.accepted, state: sent.state, err: sent.lastError, beforeCount, afterCount }),
    );
  } finally {
    if (prevMailCred === undefined) delete process.env.AEGISPI_MAIL_CREDENTIAL;
    else process.env.AEGISPI_MAIL_CREDENTIAL = prevMailCred;
    db.close();
    fx.close();
  }
}

// ---------------------------------------------------------------------------
// 3. briefing-followup.mjs: evidence_manifest_hash, destination, no double-push
{
  const { ws, db } = freshDb("followup");
  try {
    const now = Date.now();
    withTx(db, () => ensurePrincipal(db, { platform: "local", subject: "owner" }));
    const scope = withTx(db, () =>
      ensureScope(db, {
        ownerId: OWNER,
        kind: "owner_dm",
        domainKey: "dm:telegram:12345",
        channel: "telegram",
        conversationId: "12345",
        policyVersion: "pv1",
      }),
    );
    seedOwnerGrants(db, scope.id, now);

    const seedStored = putObjectContent(ws.stateDir, JSON.stringify({ kind: "followup_seed" }));
    const seedObj = withTx(db, () =>
      insertObjectRow(db, {
        scopeId: scope.id,
        kind: "event_payload",
        sourceUri: "timer:seed",
        sourceActor: OWNER,
        contentHash: seedStored.contentHash,
        storageRef: seedStored.storageRef,
        observedAt: now,
        requiredScopeIds: [scope.id],
      }),
    );

    const tId = timerIdFor("followup-case-1");
    createTimer(db, {
      id: tId,
      scopeId: scope.id,
      principalId: OWNER,
      scopeEpoch: 1,
      threadKey: "mail:thread-1",
      condition: {
        type: "contact_no_reply",
        threadKey: "mail:thread-1",
        expectedSender: "alice@example.test",
        sinceMs: now - 60_000,
      },
      dueAt: now - 1000,
      recurrence: null,
      payloadObjectId: seedObj.id,
      now: now - 10_000,
    });
    const due = processDueTimers(db, { now, stateDir: ws.stateDir });
    const inboxRow = db.prepare("SELECT id FROM inbox WHERE source='timer' AND source_event_id=?").get(`${tId}:1`);
    const routed = dispatchEventToTask(db, {
      inboxId: inboxRow.id,
      dispatchKey: "followup-1",
      now,
      priority: 5,
      maxSteps: 5,
      deadlineAt: now + 3600_000,
      skillSetHash: "followup-test",
    });

    const out1 = processFiredFollowUpTimers(db, ws.stateDir, {
      now,
      firedTimers: due.fired,
      channel: "telegram",
      destination: "dm:telegram:12345",
    });
    const eff1 = db.prepare("SELECT * FROM effects WHERE id=?").get(out1[0].effectId);
    const action1 = JSON.parse(eff1.action_json);
    const obx1 = db.prepare("SELECT * FROM outbox WHERE id=?").get(out1[0].outboxId);
    const task1 = db.prepare("SELECT result_object_id FROM tasks WHERE id=?").get(routed.taskId);
    const payloadObj = db.prepare("SELECT content_hash FROM objects WHERE id=?").get(task1.result_object_id);
    suite.check(
      "followup-evidence-hash-and-destination",
      out1.length === 1 &&
        action1.target_resource === "dm:telegram:12345" &&
        obx1.destination === "dm:telegram:12345" &&
        action1.evidence_manifest_hash === payloadObj.content_hash &&
        action1.evidence_manifest_hash !== EMPTY_SHA256,
      JSON.stringify({
        len: out1.length,
        target: action1.target_resource,
        obxDest: obx1.destination,
        manifest: action1.evidence_manifest_hash,
        objHash: payloadObj.content_hash,
      }),
    );

    // Move existing reminder effect to a non-supersedeable state (SUCCEEDED)
    // and route a second task for the same timer to exercise !oldOutbox.
    db.prepare("UPDATE effects SET state='SUCCEEDED' WHERE id=?").run(eff1.id);
    const secondInbox = receiveEvent(db, ws.stateDir, {
      now: now + 1000,
      source: "timer",
      sourceEventId: `${tId}:2`,
      principal: { platform: "local", subject: "owner" },
      scope: {
        kind: "owner_dm",
        domainKey: "dm:telegram:12345",
        channel: "telegram",
        conversationId: "12345",
      },
      threadKey: "mail:thread-1",
      priority: 5,
      policyVersion: "pv1",
      payload: { kind: "followup_beat" },
      verdict: "ADMIT",
    });
    dispatchEventToTask(db, {
      inboxId: secondInbox.inboxId,
      dispatchKey: "followup-2",
      now: now + 1000,
      priority: 5,
      maxSteps: 5,
      deadlineAt: now + 3600_000,
      skillSetHash: "followup-test",
    });
    const out2 = processFiredFollowUpTimers(db, ws.stateDir, {
      now: now + 1000,
      firedTimers: [{ timer: { id: tId }, occurrence: 2, missedCount: 0 }],
      channel: "telegram",
      destination: "dm:telegram:12345",
    });
    suite.check(
      "followup-non-supersedeable-no-double-push",
      out2.length === 1 && out2[0].skipped === "reminder already live in a non-supersedeable state",
      JSON.stringify(out2),
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 4. selfuse-dispatch.mjs: command translation, prompt formatting, Telegram auto-reply
{
  const obsPayload = JSON.parse(
    translateTelegramCommandToPayload(JSON.stringify({ update_id: 1, text: "/observe repo1 why?" }), {
      scopeDomainKey: "dm:telegram:12345",
    }),
  );
  const triagePayload = JSON.parse(
    translateTelegramCommandToPayload(JSON.stringify({ update_id: 2, text: "/triage preset1 check" }), {
      scopeDomainKey: "dm:telegram:12345",
    }),
  );
  const plainRaw = JSON.stringify({ update_id: 3, text: "just a normal message" });
  const plainOut = translateTelegramCommandToPayload(plainRaw, { scopeDomainKey: "dm:telegram:12345" });
  suite.check(
    "selfuse-translate-telegram-commands",
    obsPayload.kind === "repo_observe" &&
      obsPayload.targetId === "repo1" &&
      obsPayload.question === "why?" &&
      triagePayload.kind === "repo_triage" &&
      triagePayload.presetId === "preset1" &&
      triagePayload.notifyChannel === "dm:telegram:12345" &&
      triagePayload.question === "check" &&
      plainOut === plainRaw,
    JSON.stringify({ obsPayload, triagePayload, plainSame: plainOut === plainRaw }),
  );

  const tgPrompt = formatGeneralUserPrompt(JSON.stringify({ update_id: 4, text: "Summarize status" }));
  const nonTgJson = JSON.stringify({ kind: "mail", text: "keep raw" });
  const nonTgPrompt = formatGeneralUserPrompt(nonTgJson);
  suite.check(
    "selfuse-format-general-user-prompt",
    tgPrompt === "Summarize status" && nonTgPrompt === nonTgJson,
    JSON.stringify({ tgPrompt, nonTgPrompt }),
  );

  const { ws, db } = freshDb("tg-reply");
  try {
    const now = Date.now();
    withTx(db, () => ensurePrincipal(db, { platform: "local", subject: "owner" }));
    const scope = withTx(db, () =>
      ensureScope(db, {
        ownerId: OWNER,
        kind: "owner_dm",
        domainKey: "dm:telegram:12345",
        channel: "telegram",
        conversationId: "12345",
        policyVersion: "pv1",
      }),
    );
    seedOwnerGrants(db, scope.id, now);
    const ev = receiveEvent(db, ws.stateDir, {
      now,
      source: "telegram",
      sourceEventId: "tg-upd-100",
      principal: { platform: "local", subject: "owner" },
      scope: { kind: "owner_dm", domainKey: "dm:telegram:12345", channel: "telegram", conversationId: "12345" },
      threadKey: "tg:12345",
      priority: 5,
      policyVersion: "pv1",
      payload: { update_id: 100, text: "hello" },
      verdict: "ADMIT",
    });
    const dispatched = dispatchEventToTask(db, {
      inboxId: ev.inboxId,
      dispatchKey: "tg-reply-test",
      now,
      priority: 5,
      maxSteps: 10,
      deadlineAt: now + 3600_000,
      skillSetHash: "tg-test",
    });
    const claim = claimNextTask(db, { now, leaseMs: 60_000 });
    const storedReply = putObjectContent(ws.stateDir, JSON.stringify({ reply: "Task finished cleanly." }));
    const resultObj = withTx(db, () =>
      insertObjectRow(db, {
        scopeId: scope.id,
        kind: "agent_result",
        sourceUri: `task:${dispatched.taskId}`,
        sourceActor: "worker",
        contentHash: storedReply.contentHash,
        storageRef: storedReply.storageRef,
        observedAt: now,
        requiredScopeIds: [scope.id],
      }),
    );
    completeTask(db, {
      ...claim,
      now,
      resultClass: "affected",
      resultObjectId: resultObj.id,
    });

    const disabled = maybeEnqueueTelegramTaskReply(db, ws.stateDir, {
      config: { telegram: { autoReplyOnTask: false, apiBase: "http://127.0.0.1:4001" }, adapters: { allowedRecipients: ["dm:telegram:12345"] } },
      taskId: dispatched.taskId,
      now,
    });
    const refusedScope = maybeEnqueueTelegramTaskReply(db, ws.stateDir, {
      config: { telegram: { autoReplyOnTask: true, apiBase: "http://127.0.0.1:4001" }, adapters: { allowedRecipients: ["dm:telegram:99999"] } },
      taskId: dispatched.taskId,
      now,
    });
    const enabled = maybeEnqueueTelegramTaskReply(db, ws.stateDir, {
      config: { telegram: { autoReplyOnTask: true, apiBase: "http://127.0.0.1:4001" }, adapters: { allowedRecipients: ["dm:telegram:12345"] } },
      taskId: dispatched.taskId,
      now,
    });
    const repeat = maybeEnqueueTelegramTaskReply(db, ws.stateDir, {
      config: { telegram: { autoReplyOnTask: true, apiBase: "http://127.0.0.1:4001" }, adapters: { allowedRecipients: ["dm:telegram:12345"] } },
      taskId: dispatched.taskId,
      now,
    });
    const eff = db.prepare("SELECT * FROM effects WHERE id=?").get(enabled.effectId);
    const obx = db.prepare("SELECT * FROM outbox WHERE id=?").get(enabled.outboxId);
    const action = JSON.parse(eff.action_json);
    const verified = resolveVerifiedNotificationText({
      stateDir: ws.stateDir,
      contentHash: action.content_hash,
      extra: extraFieldsOfAction(action),
    });
    suite.check(
      "selfuse-telegram-auto-reply",
      disabled.enqueued === false &&
        disabled.reason === "disabled" &&
        refusedScope.enqueued === false &&
        refusedScope.reason === "scope_not_eligible" &&
        enabled.enqueued === true &&
        repeat.enqueued === false &&
        repeat.reason === "already_enqueued" &&
        eff.operation === "send_message" &&
        eff.state === "READY" &&
        obx.destination === "dm:telegram:12345" &&
        verified.ok === true &&
        verified.text === "Task finished cleanly.",
      JSON.stringify({ disabled, refusedScope, enabled, repeat, verified }),
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 5. console/api.mjs + console/ui.mjs draft roundtrip
{
  const { ws, db } = freshDb("console-draft");
  try {
    const now = Date.now();
    withTx(db, () => ensurePrincipal(db, { platform: "local", subject: "owner" }));
    const mailScope = ensureMailScope(db, { account: "owner@example.test", ownerId: OWNER, policyVersion: "pv1" });
    seedOwnerGrants(db, mailScope.id, now);

    const ev = receiveEvent(db, ws.stateDir, {
      now,
      source: "mail",
      sourceEventId: "<draft-1@example.test>",
      principal: { platform: "local", subject: "owner" },
      scope: {
        kind: "owner_dm",
        domainKey: "dm:mail:owner@example.test",
        channel: "mail",
        conversationId: "owner@example.test",
      },
      threadKey: "mail:<draft-1@example.test>",
      priority: 5,
      policyVersion: "pv1",
      payload: { kind: "mail", envelopeFrom: "alice@example.test", subject: "Quarterly status" },
      verdict: "ADMIT",
    });
    const dispatched = dispatchEventToTask(db, {
      inboxId: ev.inboxId,
      dispatchKey: "console-draft",
      now,
      priority: 5,
      maxSteps: 10,
      deadlineAt: now + 3600_000,
      skillSetHash: "console-test",
    });
    const claim = claimNextTask(db, { now, leaseMs: 60_000 });
    const draftObj = withTx(db, () =>
      insertObjectRow(db, {
        scopeId: mailScope.id,
        kind: "mail_draft",
        sourceUri: `task:${dispatched.taskId}`,
        sourceActor: "host-triage",
        content: JSON.stringify({ draft: "Thanks, looks good." }),
        observedAt: now,
        requiredScopeIds: [mailScope.id],
      }),
    );
    const draftHash = db.prepare("SELECT content_hash FROM objects WHERE id=?").get(draftObj.id).content_hash;
    const proposed = proposeMailReplyEffect(db, ws.stateDir, {
      now,
      taskId: dispatched.taskId,
      attemptId: claim.attemptId,
      account: "owner@example.test",
      approverPrincipalId: OWNER,
      intent: buildMailSendIntent({
        to: ["alice@example.test"],
        subject: "Re: Quarterly status",
        bodyText: "Thanks, looks good.",
        sendingIdentity: "aegispi@local",
        threadKey: "mail:<draft-1@example.test>",
        messageId: "<draft-1@example.test>",
      }),
      mailConfig: { allowedRecipients: ["alice@example.test"], approvalTtlMs: 3600_000, maxAttachmentBytes: 4194304 },
      adaptersConfig: { fixedSendingIdentity: "aegispi@local", allowedRecipients: ["alice@example.test"] },
      evidenceManifestHash: draftHash,
      parentObjectIds: [draftObj.id],
    });

    const token = "fixture-console-token-0001";
    const app = createConsoleApp(db, {
      recovery: { failedStep: null, actions: [] },
      mode: "open",
      token,
      port: 4310,
      stateDir: ws.stateDir,
      ownerPrincipalId: OWNER,
    });
    const req = async (path, { method = "GET", headers = {}, body } = {}) => {
      const res = await app.fetch(
        new Request(`http://127.0.0.1:4310${path}`, {
          method,
          headers: { host: "127.0.0.1:4310", ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
      );
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json, text };
    };

    const sess = await req("/api/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: { token },
    });
    const detail = await req(`/api/approvals/${encodeURIComponent(proposed.approvalId)}`, {
      headers: { authorization: `Bearer ${sess.json?.sessionId ?? ""}` },
    });
    const dm = detail.json?.decisionMaterials ?? null;
    const decide = dm
      ? await req(`/api/approvals/${encodeURIComponent(proposed.approvalId)}/decide`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${sess.json?.sessionId ?? ""}`,
            "x-csrf-token": sess.json?.csrfToken ?? "",
            "content-type": "application/json",
          },
          body: {
            decision: "approve",
            actionHash: dm.actionHash,
            nonce: dm.nonce,
          },
        })
      : { status: 0, json: null };
    const tasksRes = await req("/api/tasks", {
      headers: { authorization: `Bearer ${sess.json?.sessionId ?? ""}` },
    });
    const uiRes = await req("/");
    const effAfter = db.prepare("SELECT state FROM effects WHERE id=?").get(proposed.effectId);
    const taskRow = tasksRes.json?.tasks?.find((t) => t.id === dispatched.taskId);

    suite.check(
      "console-draft-preview-approve-roundtrip",
      sess.status === 200 &&
        detail.status === 200 &&
        detail.json?.action?.extra?.subject === "Re: Quarterly status" &&
        detail.json?.action?.extra?.bodyText === "Thanks, looks good." &&
        Boolean(dm?.nonce) &&
        decide.status === 200 &&
        decide.json?.accepted === true &&
        effAfter.state === "READY" &&
        taskRow !== undefined &&
        "result_object_id" in taskRow &&
        uiRes.status === 200 &&
        uiRes.text.includes("editmsg") &&
        uiRes.text.includes("extra.subject") &&
        uiRes.text.includes("extra.bodyText"),
      JSON.stringify({
        sessStatus: sess.status,
        detailStatus: detail.status,
        extraSubject: detail.json?.action?.extra?.subject,
        extraBody: detail.json?.action?.extra?.bodyText,
        decideStatus: decide.status,
        effState: effAfter?.state,
        hasResultObjCol: taskRow ? "result_object_id" in taskRow : false,
      }),
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 6. scripts/selfuse.mjs init + idempotency + zero secret leak
{
  const ws = makeWorkspace("selfuse-cli");
  const configPath = join(ws.stateDir, "selfuse.config.json");
  const envPath = join(ws.stateDir, ".env");
  const dataDir = join(ws.stateDir, "data");
  const secrets = [
    "dummy-deepseek-key-9911",
    "123456:dummy-tg-token-9911",
    "dummy-mail-pass-9911",
  ];
  writeFileSync(
    configPath,
    JSON.stringify(
      baseDefaults({
        model: {
          baseUrl: "http://127.0.0.1:4000",
          allowedPurposes: ["worker"],
          allowedModelIds: ["deepseek/deepseek-flash"],
          allowRealModelCalls: false,
        },
        telegram: {
          apiBase: "http://127.0.0.1:4001",
          allowedChatIds: ["12345", "-100999"],
          ownerDestination: "dm:telegram:12345",
        },
        mail: {
          imapHost: "127.0.0.1",
          smtpHost: "127.0.0.1",
          allowedSenders: ["alice@example.test"],
          allowedRecipients: ["alice@example.test"],
        },
        adapters: {
          fixedSendingIdentity: "aegispi@local",
          allowedRecipients: ["dm:telegram:12345", "group:telegram:-100999", "alice@example.test"],
        },
      }),
      null,
      2,
    ),
  );
  writeFileSync(
    envPath,
    [
      `DEEPSEEK_API_KEY=${secrets[0]}`,
      `TELEGRAM_BOT_TOKEN=${secrets[1]}`,
      `TELEGRAM_OWNER_USER_ID=12345`,
      `MAIL_USER=owner@example.test`,
      `MAIL_APP_PASSWORD=${secrets[2]}`,
    ].join("\n") + "\n",
  );

  const cliArgs = [
    join(REPO_ROOT, "scripts", "selfuse.mjs"),
    "init",
    `--config=${configPath}`,
    `--data-dir=${dataDir}`,
    `--env-file=${envPath}`,
    "--briefing-time=08:30",
  ];
  const cleanEnv = { ...process.env };
  delete cleanEnv.AEGISPI_MAIL_CREDENTIAL;
  delete cleanEnv.DEEPSEEK_API_KEY;
  delete cleanEnv.TELEGRAM_BOT_TOKEN;
  delete cleanEnv.MAIL_USER;
  delete cleanEnv.MAIL_APP_PASSWORD;

  const run1 = spawnSync(process.execPath, cliArgs, { encoding: "utf8", env: cleanEnv });
  const run2 = spawnSync(process.execPath, cliArgs, { encoding: "utf8", env: cleanEnv });
  const combinedOut = `${run1.stdout ?? ""}\n${run1.stderr ?? ""}\n${run2.stdout ?? ""}\n${run2.stderr ?? ""}`;
  const leaked = secrets.filter((s) => combinedOut.includes(s));

  const dbPath = join(dataDir, "db", "aegis.db");
  const db = openDatabase(dbPath);
  try {
    const slots = db
      .prepare("SELECT slot FROM credential_slots WHERE revoked_at IS NULL ORDER BY slot")
      .all()
      .map((r) => r.slot);
    const grantsFor = (domainKey) =>
      db
        .prepare(
          `SELECT g.permission FROM acl_grants g JOIN scopes s ON s.id=g.scope_id
           WHERE s.domain_key=? AND g.principal_id=? AND g.revoked_at IS NULL`,
        )
        .all(domainKey, OWNER)
        .map((r) => r.permission)
        .sort();
    const timer = db.prepare("SELECT state, recurrence_json FROM timers WHERE id=?").get(timerIdFor("selfuse-morning-briefing"));
    const recurrence = timer?.recurrence_json ? JSON.parse(timer.recurrence_json) : null;
    const expectedPerms = ["admin", "approve", "read", "request"];
    const grantsOk =
      JSON.stringify(grantsFor("dm:telegram:12345")) === JSON.stringify(expectedPerms) &&
      JSON.stringify(grantsFor("group:telegram:-100999")) === JSON.stringify(expectedPerms) &&
      JSON.stringify(grantsFor("dm:mail:owner@example.test")) === JSON.stringify(expectedPerms);

    suite.check(
      "selfuse-cli-init-idempotent-no-secret-leak",
      run1.status === 0 &&
        run2.status === 0 &&
        JSON.stringify(slots) === JSON.stringify(["im", "mail", "model"]) &&
        grantsOk &&
        timer?.state === "SCHEDULED" &&
        recurrence?.type === "daily_wall_clock" &&
        recurrence?.timeOfDay === "08:30" &&
        /grantsAdded=0/.test(run2.stdout ?? "") &&
        /created=false/.test(run2.stdout ?? "") &&
        leaked.length === 0,
      JSON.stringify({
        s1: run1.status,
        s2: run2.status,
        slots,
        grantsOk,
        timerState: timer?.state,
        recurrence,
        leakedCount: leaked.length,
        run2Out: (run2.stdout ?? "").trim(),
      }),
    );
  } finally {
    db.close();
  }
}

writeReport({
  suiteId: "selfuse",
  label: "Selfuse behavior end-to-end",
  suite,
  extra: { dataSources: "Offline loopback SMTP/DB/HTTP fixtures with example.test data only" },
});

process.exit(suiteExit(suite, { label: "selfuse" }));
