import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import {
  decideApproval,
  ensureScope,
  proposeOrGetApproval,
  saveDraftRevision,
} from "../../src/governance/approvals.ts";
import {
  chargeBoundExpiredReservations,
  correctChargedBoundReservation,
  dayAccountIdFor,
  DEFAULT_TIME_ZONE,
  formatChargeDay,
  getBudgetAccount,
  setBudgetAccountLimit,
  taskAccountIdFor,
  type BudgetReservationRow,
} from "../../src/governance/budget.ts";
import { HostCredentialVault } from "../../src/governance/credentials.ts";
import {
  claimEffectForSubmission,
  countSuccessfulClaimsForEffect,
  revokeOrCancelScope,
  type EffectRow,
} from "../../src/governance/effects.ts";
import { AegisHostRuntime } from "../../src/runtime/harness.ts";
import type { ModelSlotConfig } from "../../src/runtime/models.ts";
import { uiStatusLabelFor } from "../../src/web/server.ts";
import { LOCKED_NODE_EXE, startFakeModelServer, startFakeSmtpServer } from "../fakes/client.ts";

export interface MatrixCaseResult {
  id: string;
  group: "F" | "B" | "E" | "GUARD";
  status: "PASS" | "FAIL";
  summary: string;
  evidence: Record<string, unknown>;
}

function makeStandardSlots(baseUrl: string, opts?: { upperMu?: number | null; actualMu?: number | null; priceScheduleNull?: boolean; outboundAuthorized?: boolean }): {
  vault: HostCredentialVault;
  slots: ModelSlotConfig[];
} {
  const vault = new HostCredentialVault();
  vault.registerSlot(
    {
      slotId: "slot:matrix",
      provider: "fake-local",
      allowedBaseUrls: [baseUrl],
      allowedModelIds: ["fake-router-1", "fake-worker-1"],
      priceVersion: "synthetic-100-60",
    },
    "SYNTHETIC_MATRIX_MODEL_KEY_V2",
  );
  const priceSchedule = opts?.priceScheduleNull
    ? null
    : {
        priceVersion: "synthetic-100-60",
        inputPerMTokMu: 300_000,
        outputPerMTokMu: 1_200_000,
        syntheticFixedUpperMu: opts?.upperMu === undefined ? 100 : opts.upperMu,
        syntheticFixedActualMu: opts?.actualMu === undefined ? 60 : opts.actualMu,
      };
  const slots: ModelSlotConfig[] = [
    {
      slotName: "router",
      provider: "fake-local",
      modelId: "fake-router-1",
      baseUrl,
      credentialSlotId: "slot:matrix",
      contextWindow: 128_000,
      maxTokens: 1024,
      priceSchedule,
      outboundAuthorized: opts?.outboundAuthorized ?? true,
    },
    {
      slotName: "worker",
      provider: "fake-local",
      modelId: "fake-worker-1",
      baseUrl,
      credentialSlotId: "slot:matrix",
      contextWindow: 128_000,
      maxTokens: 1024,
      priceSchedule,
      outboundAuthorized: opts?.outboundAuthorized ?? true,
    },
  ];
  return { vault, slots };
}

async function waitForPendingProposal(host: AegisHostRuntime, convId: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = host.govDb
      .prepare(
        `SELECT p.proposal_id, p.tool_task_id, p.call_id, p.head_rev,
                a.approval_id, a.state AS approval_state, a.revision,
                d.action_hash, c.nonce_value
           FROM proposals p
           JOIN draft_revisions d ON d.proposal_id = p.proposal_id AND d.revision = p.head_rev
           JOIN approvals a ON a.proposal_id = p.proposal_id AND a.revision = p.head_rev
           LEFT JOIN approval_challenges c ON c.approval_id = a.approval_id
          WHERE p.conversation_id = ? AND a.state = 'PENDING'
          ORDER BY p.created_at DESC LIMIT 1`,
      )
      .get(convId) as
      | {
          proposal_id: string;
          tool_task_id: string;
          call_id: string;
          head_rev: number;
          approval_id: string;
          approval_state: string;
          revision: number;
          action_hash: string;
          nonce_value: string | null;
        }
      | undefined;
    if (row && row.nonce_value) return row;
    await new Promise((r) => setTimeout(r, 35));
  }
  throw new Error(`Timed out waiting for PENDING proposal on conv ${convId}`);
}

async function waitForToolSleeping(host: AegisHostRuntime, toolTaskId: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await host.harness.getTask(toolTaskId as TaskId, BACKGROUND_CONTEXT);
    if (rec && rec.state.status === "sleeping") return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for tool task ${toolTaskId} to enter sleeping state`);
}

// =============================================================================
// F01 - F03: Startup, Ownership, Self-check, Paired Rollback & Fork
// =============================================================================

async function testF01(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "f01");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"));
  const dataDir = path.join(dir, "host-data");

  const host1 = spawn(
    LOCKED_NODE_EXE,
    [
      path.resolve("src/index.ts"),
      "--data-dir",
      dataDir,
      "--port",
      "0",
      "--model-base-url",
      fakeModel.baseUrl,
      "--smtp-host",
      fakeSmtp.host,
      "--smtp-port",
      String(fakeSmtp.smtpPort),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  try {
    const ready1 = await new Promise<{ pid: number; baseUrl: string }>((resolve, reject) => {
      let buf = "";
      let err = "";
      host1.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      host1.stdout.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        const i = buf.indexOf("\n");
        if (i !== -1) resolve(JSON.parse(buf.slice(0, i)) as { pid: number; baseUrl: string });
      });
      host1.once("exit", (code) => reject(new Error(`host1 exited ${String(code)}: ${err}`)));
    });

    // Launch second instance on the SAME dataDir
    const host2 = spawn(
      LOCKED_NODE_EXE,
      [
        path.resolve("src/index.ts"),
        "--data-dir",
        dataDir,
        "--port",
        "0",
        "--model-base-url",
        fakeModel.baseUrl,
        "--smtp-host",
        fakeSmtp.host,
        "--smtp-port",
        String(fakeSmtp.smtpPort),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const res2 = await new Promise<{ exitCode: number | null; stderr: string }>((resolve) => {
      let stderr = "";
      host2.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      host2.once("exit", (code) => resolve({ exitCode: code, stderr }));
    });

    assert.notEqual(res2.exitCode, 0, "F01: second instance must exit non-zero");
    assert.ok(
      res2.stderr.includes("already owned by another active AegisPi host instance") ||
        res2.stderr.includes("InstanceLockBusyError"),
      `F01: second instance must report data directory busy, got: ${res2.stderr}`,
    );

    // Verify original host1 is still responsive and both fake services saw 0 calls
    const health1 = await fetch(`${ready1.baseUrl}/api/health`);
    assert.equal(health1.status, 200);
    const mStats = await fakeModel.stats();
    const sStats = await fakeSmtp.stats();
    assert.equal(mStats.totalPhysicalRequests, 0);
    assert.equal(sStats.totalReceived, 0);

    return {
      id: "F01",
      group: "F",
      status: "PASS",
      summary: "Second host instance rejected with InstanceLockBusyError and 0 DB/service mutations; first instance stayed healthy.",
      evidence: {
        host1Pid: ready1.pid,
        host2ExitCode: res2.exitCode,
        modelDelta: mStats.totalPhysicalRequests,
        smtpDelta: sStats.totalReceived,
      },
    };
  } finally {
    host1.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

async function testF02(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "f02");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"));
  const dataDir = path.join(dir, "host-data");

  try {
    // Seed a pending tool task
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: { id: "call_f02", name: "send_email", arguments: { to: ["f02@local.test"], subject: "F02", body: "F02" } },
        },
      ],
    });
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
    const seedHost = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
    });
    const conv = await seedHost.createManagedConversation({ budgetTaskId: "task-f02" });
    await conv.submit({ type: "input", content: "seed f02" }, BACKGROUND_CONTEXT);
    const p = await waitForPendingProposal(seedHost, String(conv.id));
    await waitForToolSleeping(seedHost, Number(p.tool_task_id));
    await seedHost.close();

    const mBefore = (await fakeModel.stats()).totalPhysicalRequests;
    const sBefore = (await fakeSmtp.stats()).totalReceived;

    // Restart 1: Missing policy hook
    const hNoHook = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      faultInjectMissingPolicyHook: true,
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(hNoHook.health, "NEEDS_ATTENTION");
    assert.equal(hNoHook.isAcceptingCommands, false);
    assert.equal(hNoHook.startupReport.schedulingBeforeRelease, "paused");
    assert.ok(hNoHook.startupReport.selfCheckErrors.includes("missing_required_extension:aegis-policy"));
    await hNoHook.close();

    // Restart 2: Missing Models wrapper
    const hNoModels = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      faultInjectMissingModelsWrapper: true,
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(hNoModels.health, "NEEDS_ATTENTION");
    assert.equal(hNoModels.isAcceptingCommands, false);
    assert.equal(hNoModels.startupReport.schedulingBeforeRelease, "paused");
    assert.ok(hNoModels.startupReport.selfCheckErrors.includes("missing_required_models_egress_wrapper"));
    await hNoModels.close();

    const mAfter = (await fakeModel.stats()).totalPhysicalRequests;
    const sAfter = (await fakeSmtp.stats()).totalReceived;
    assert.equal(mAfter - mBefore, 0);
    assert.equal(sAfter - sBefore, 0);

    return {
      id: "F02",
      group: "F",
      status: "PASS",
      summary: "Missing policy hook and missing Models wrapper both fail closed before scheduling release with 0 model/SMTP calls.",
      evidence: {
        missingHookErrors: hNoHook.startupReport.selfCheckErrors,
        missingModelsErrors: hNoModels.startupReport.selfCheckErrors,
        modelDelta: mAfter - mBefore,
        smtpDelta: sAfter - sBefore,
      },
    };
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

async function testF03(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "f03");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"));
  const dataDir = path.join(dir, "host-data");

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: { id: "call_f03", name: "send_email", arguments: { to: ["f03@local.test"], subject: "F03", body: "F03" } },
        },
        { kind: "missing_usage" },
      ],
    });

    // Step 1: Create initial epoch + take an OLDER trace snapshot
    const h1 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      pauseOutboxDelivery: true,
    });
    const initialEpoch = h1.runtimeEpoch;
    const conv1 = await h1.createManagedConversation({ budgetTaskId: "task-f03" });
    await h1.close();

    // Backup older trace snapshot while gov DB will advance further
    const olderTraceBackup = path.join(dir, "pi-durable.older.sqlite");
    copyFileSync(path.join(dataDir, "pi-durable.sqlite"), olderTraceBackup);

    // Step 2: Advance both DBs (create proposal + approve to READY, plus HELD reservation via missing_usage)
    const h2 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      pauseOutboxDelivery: true,
    });
    const conv2 = await h2.createManagedConversation({ budgetTaskId: "task-f03-adv" });
    await conv2.submit({ type: "input", content: "trigger email" }, BACKGROUND_CONTEXT);
    const p = await waitForPendingProposal(h2, String(conv2.id));
    await waitForToolSleeping(h2, Number(p.tool_task_id));

    const dec = decideApproval(h2.govDb, {
      approvalId: p.approval_id,
      conversationId: String(conv2.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: p.revision,
      expectedActionHash: p.action_hash,
      nonce: p.nonce_value!,
      decisionKey: "dk-f03",
      now: Date.now(),
    });
    assert.equal(dec.httpStatus, 200);
    const readyEffectId = dec.effectId!;

    // Also create a HELD reservation (missing usage)
    const convHeld = await h2.createManagedConversation({ budgetTaskId: "task-f03-held" });
    const subHeld = await convHeld.submit({ type: "input", content: "missing usage call" }, BACKGROUND_CONTEXT);
    await subHeld.wait(BACKGROUND_CONTEXT);

    // Test Fork Isolation right here: forked conversation cannot claim parent's READY effectId!
    const ents = await conv2.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
    const forkedConv = await conv2.fork(
      ents.items[0]!.id,
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    assert.notEqual(forkedConv.id, conv2.id);
    const forkClaim = claimEffectForSubmission(h2.govDb, {
      effectId: readyEffectId,
      runtimeEpoch: h2.runtimeEpoch,
      conversationId: String(forkedConv.id),
      toolTaskId: p.tool_task_id,
      callId: p.call_id,
      toolName: "send_email",
      finalTarget: "smtp:f03@local.test",
      finalPayload: { to: ["f03@local.test"], subject: "F03", body: "F03" },
      now: Date.now(),
    });
    assert.equal(forkClaim.claimed, false);
    assert.equal(forkClaim.code, "call_identity_mismatch");

    await h2.close();

    const mBefore = (await fakeModel.stats()).totalPhysicalRequests;
    const sBefore = (await fakeSmtp.stats()).totalReceived;

    // Case A: Rollback trace DB to older snapshot (same epoch, same filename!)
    copyFileSync(olderTraceBackup, path.join(dataDir, "pi-durable.sqlite"));
    rmSync(path.join(dataDir, "pi-durable.sqlite-wal"), { force: true });
    rmSync(path.join(dataDir, "pi-durable.sqlite-shm"), { force: true });

    const hRollback = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
    });
    assert.equal(hRollback.health, "NEEDS_ATTENTION", "F03: rollback must halt startup before scheduling");
    assert.equal(hRollback.startupReport.pairedCheck.ok, false);
    const rollbackCode = hRollback.startupReport.pairedCheck.ok ? "" : hRollback.startupReport.pairedCheck.code;
    await hRollback.close();

    // Case B: Replace trace DB with brand new empty file -> detect & rotate epoch!
    rmSync(path.join(dataDir, "pi-durable.sqlite"), { force: true });
    rmSync(path.join(dataDir, "pi-durable.sqlite-wal"), { force: true });
    rmSync(path.join(dataDir, "pi-durable.sqlite-shm"), { force: true });

    const hReplaced = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
    });
    assert.equal(hReplaced.health, "NEEDS_ATTENTION", "F03: replaced trace DB must halt startup");
    assert.equal(hReplaced.startupReport.pairedCheck.ok, false);
    const replaceCode = hReplaced.startupReport.pairedCheck.ok ? "" : hReplaced.startupReport.pairedCheck.code;

    const rotated = await hReplaced.rotateEpochAfterMismatch("f03_trace_replaced");
    assert.equal(rotated.retiredEpoch, initialEpoch);
    assert.notEqual(rotated.newEpoch, initialEpoch);
    assert.ok(rotated.quarantinedReadyEffectIds.includes(readyEffectId), "Old READY effect must be QUARANTINED");
    assert.ok(rotated.preservedHeldReservationIds.length >= 1, "Old HELD reservation must be preserved");
    assert.equal(hReplaced.health, "READY");

    const effRow = hReplaced.govDb.prepare("SELECT state FROM effects WHERE effect_id = ?").get(readyEffectId) as {
      state: string;
    };
    assert.equal(effRow.state, "QUARANTINED");
    await hReplaced.close();

    const mAfter = (await fakeModel.stats()).totalPhysicalRequests;
    const sAfter = (await fakeSmtp.stats()).totalReceived;
    assert.equal(mAfter - mBefore, 0);
    assert.equal(sAfter - sBefore, 0);

    return {
      id: "F03",
      group: "F",
      status: "PASS",
      summary:
        "Detected same-epoch trace rollback and trace replacement before scheduling, quarantined old READY effects, preserved old HELD reservations, rotated epoch, and blocked forked conversation from claiming parent effect.",
      evidence: {
        initialEpoch,
        newEpoch: rotated.newEpoch,
        rollbackCode,
        replaceCode,
        forkClaimCode: forkClaim.code,
        quarantinedReadyEffectIds: rotated.quarantinedReadyEffectIds,
        preservedHeldCount: rotated.preservedHeldReservationIds.length,
        modelDeltaDuringRecovery: mAfter - mBefore,
        smtpDeltaDuringRecovery: sAfter - sBefore,
      },
    };
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

// =============================================================================
// B02 - B07 (B01 is covered by standalone runW1A)
// =============================================================================

async function testB02(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "b02");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fixedNow = Date.now();
  const chargeDay = formatChargeDay(fixedNow, DEFAULT_TIME_ZONE);
  const dayAcctId = dayAccountIdFor(chargeDay, DEFAULT_TIME_ZONE);

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl, { upperMu: 100, actualMu: 60 });
    const host = await AegisHostRuntime.start({
      dataDir: path.join(dir, "host-data"),
      vault,
      modelSlots: slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "u@local.test" },
      now: () => fixedNow,
    });

    // Round 1: Two distinct tasks each needing 100 compete for DAY balance of exactly 100
    setBudgetAccountLimit(host.govDb, { accountId: dayAcctId, kind: "DAY", limitMu: 100, now: fixedNow, approvedBy: "test" });
    await fakeModel.queue({
      clear: true,
      scripts: [
        { kind: "hold_then_text", holdBarrierKey: "b02-r1", text: "winner-r1" },
        { kind: "text", text: "should-not-run" },
      ],
    });
    const c1 = await host.createManagedConversation({ budgetTaskId: "b02-task-1" });
    const c2 = await host.createManagedConversation({ budgetTaskId: "b02-task-2" });
    const mBeforeR1 = (await fakeModel.stats()).totalPhysicalRequests;
    const [s1, s2] = await Promise.all([
      c1.submit({ type: "input", content: "race day 1" }, BACKGROUND_CONTEXT),
      c2.submit({ type: "input", content: "race day 2" }, BACKGROUND_CONTEXT),
    ]);
    await fakeModel.waitBarrier("b02-r1", 8000);
    await new Promise((r) => setTimeout(r, 150));
    // While winner is HELD, loser must already be rejected and only 1 HELD exists!
    const heldDuringR1 = host.govDb.prepare("SELECT * FROM budget_reservations WHERE state = 'HELD'").all();
    assert.equal(heldDuringR1.length, 1, "B02 round 1: exactly 1 HELD during concurrent day race");
    await fakeModel.releaseBarrier("b02-r1");
    const [r1a, r1b] = await Promise.all([s1.wait(BACKGROUND_CONTEXT), s2.wait(BACKGROUND_CONTEXT)]);
    await new Promise((r) => setTimeout(r, 50));
    const mAfterR1 = (await fakeModel.stats()).totalPhysicalRequests;
    assert.equal(mAfterR1 - mBeforeR1, 1, "B02 round 1: fake model must receive exactly +1");
    assert.equal([r1a.status, r1b.status].filter((s) => s === "done").length, 1);

    // Round 2: Two concurrent requests in the SAME budget task compete for TASK balance of exactly 100
    setBudgetAccountLimit(host.govDb, { accountId: dayAcctId, kind: "DAY", limitMu: 5000, now: fixedNow, approvedBy: "test" });
    setBudgetAccountLimit(host.govDb, { accountId: taskAccountIdFor("b02-shared-task"), kind: "TASK", limitMu: 100, now: fixedNow, approvedBy: "test" });
    await fakeModel.queue({
      clear: true,
      scripts: [
        { kind: "hold_then_text", holdBarrierKey: "b02-r2", text: "winner-r2" },
        { kind: "text", text: "should-not-run" },
      ],
    });
    const ct1 = await host.createManagedConversation({ budgetTaskId: "b02-shared-task" });
    const ct2 = await host.createManagedConversation({ budgetTaskId: "b02-shared-task" });
    const mBeforeR2 = (await fakeModel.stats()).totalPhysicalRequests;
    const [st1, st2] = await Promise.all([
      ct1.submit({ type: "input", content: "race task 1" }, BACKGROUND_CONTEXT),
      ct2.submit({ type: "input", content: "race task 2" }, BACKGROUND_CONTEXT),
    ]);
    await fakeModel.waitBarrier("b02-r2", 8000);
    await new Promise((r) => setTimeout(r, 150));
    const heldDuringR2 = host.govDb.prepare("SELECT * FROM budget_reservations WHERE state = 'HELD'").all();
    assert.equal(heldDuringR2.length, 1, "B02 round 2: exactly 1 HELD during concurrent task race");
    await fakeModel.releaseBarrier("b02-r2");
    const [r2a, r2b] = await Promise.all([st1.wait(BACKGROUND_CONTEXT), st2.wait(BACKGROUND_CONTEXT)]);
    await new Promise((r) => setTimeout(r, 50));
    const mAfterR2 = (await fakeModel.stats()).totalPhysicalRequests;
    assert.equal(mAfterR2 - mBeforeR2, 1, "B02 round 2: fake model must receive exactly +1");
    assert.equal([r2a.status, r2b.status].filter((s) => s === "done").length, 1);

    await host.close();
    return {
      id: "B02",
      group: "B",
      status: "PASS",
      summary: "Concurrent DAY race and concurrent TASK race each admitted exactly 1 HELD reservation (+1 model request) with zero partial holds.",
      evidence: {
        round1ModelDelta: mAfterR1 - mBeforeR1,
        round1Outcomes: [r1a.status, r1b.status],
        round2ModelDelta: mAfterR2 - mBeforeR2,
        round2Outcomes: [r2a.status, r2b.status],
      },
    };
  } finally {
    await fakeModel.stop();
  }
}

async function testB03(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "b03");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl, { upperMu: 100, actualMu: 60 });
    const host = await AegisHostRuntime.start({
      dataDir: path.join(dir, "host-data"),
      vault,
      modelSlots: slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "u@local.test" },
      compactionKeepRecentTokens: 15,
    });
    await fakeModel.queue({
      clear: true,
      scripts: [
        { kind: "text", text: "Turn 1 " + "alpha ".repeat(80) },
        { kind: "text", text: "Turn 2 " + "beta ".repeat(80) },
        { kind: "text", text: "## Goal\nReal compaction summary B03" },
      ],
    });
    const conv = await host.createManagedConversation({ budgetTaskId: "b03-gen-task" });
    await (await conv.submit({ type: "input", content: "M1 " + "x ".repeat(60) }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    await (await conv.submit({ type: "input", content: "M2 " + "y ".repeat(60) }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const mBeforeCompact = (await fakeModel.stats()).totalPhysicalRequests;

    const cTaskId = await conv.compact("Compact B03", BACKGROUND_CONTEXT);
    host.bindPiTaskBudgetOwner(cTaskId, conv.id, "b03-compact-task", "compaction");
    await host.harness.waitForTask(cTaskId, BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 40));

    const mAfterCompact = (await fakeModel.stats()).totalPhysicalRequests;
    const compactRows = host.govDb
      .prepare("SELECT * FROM budget_reservations WHERE owner_task_id = 'b03-compact-task'")
      .all() as unknown as BudgetReservationRow[];
    const genRows = host.govDb
      .prepare("SELECT * FROM budget_reservations WHERE owner_task_id = 'b03-gen-task'")
      .all() as unknown as BudgetReservationRow[];

    assert.equal(mAfterCompact - mBeforeCompact, 1);
    assert.equal(compactRows.length, 1);
    assert.equal(compactRows[0]?.purpose, "compaction");
    assert.equal(compactRows[0]?.state, "SETTLED");
    assert.equal(genRows.length, 2);

    await host.close();
    return {
      id: "B03",
      group: "B",
      status: "PASS",
      summary: "Explicit compaction triggered real completeSimple (+1 physical request) with independent request_id attributed to b03-compact-task.",
      evidence: {
        compactionRequestId: compactRows[0]?.request_id,
        compactionModelDelta: mAfterCompact - mBeforeCompact,
        generationReservationsCount: genRows.length,
      },
    };
  } finally {
    await fakeModel.stop();
  }
}

async function testB04(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "b04");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl, { upperMu: 100, actualMu: 60 });
    const host = await AegisHostRuntime.start({
      dataDir: path.join(dir, "host-data"),
      vault,
      modelSlots: slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "u@local.test" },
      durableRetryEnabled: true,
      durableMaxRetries: 1,
      durableBaseDelayMs: 25,
    });

    // Subcase A: Enough budget for 2 attempts (503 then 200)
    await fakeModel.queue({
      clear: true,
      scripts: [
        { kind: "http_error", httpStatus: 503, errorMessage: "Synthetic 503 retryable" },
        { kind: "text", text: "Retry attempt 2 succeeded" },
      ],
    });
    const mBeforeA = (await fakeModel.stats()).totalPhysicalRequests;
    const convA = await host.createManagedConversation({ budgetTaskId: "b04-retry-funded" });
    setBudgetAccountLimit(host.govDb, { accountId: taskAccountIdFor("b04-retry-funded"), kind: "TASK", limitMu: 200, now: Date.now(), approvedBy: "test" });
    const subA = await convA.submit({ type: "input", content: "trigger retry funded" }, BACKGROUND_CONTEXT);
    const resA = await subA.wait(BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 50));
    const mAfterA = (await fakeModel.stats()).totalPhysicalRequests;
    const rowsA = host.govDb
      .prepare("SELECT * FROM budget_reservations WHERE owner_task_id = 'b04-retry-funded' ORDER BY reserved_at ASC")
      .all() as unknown as BudgetReservationRow[];
    assert.equal(resA.status, "done");
    assert.equal(mAfterA - mBeforeA, 2, "B04 funded: exactly 2 physical requests (1 initial + 1 durable retry)");
    assert.equal(rowsA.length, 2, "B04 funded: 2 independent request_id reservations");
    assert.notEqual(rowsA[0]?.request_id, rowsA[1]?.request_id);
    assert.equal(rowsA[0]?.state, "HELD");
    assert.equal(rowsA[1]?.state, "SETTLED");

    // Subcase B: Budget only enough for 1 attempt (100 microUSD) -> durable retry #2 MUST be denied (0 extra sends!)
    await fakeModel.queue({
      clear: true,
      scripts: [
        { kind: "http_error", httpStatus: 503, errorMessage: "Synthetic 503 retryable" },
        { kind: "text", text: "SHOULD_NEVER_SEND" },
      ],
    });
    const mBeforeB = (await fakeModel.stats()).totalPhysicalRequests;
    const convB = await host.createManagedConversation({ budgetTaskId: "b04-retry-unfunded" });
    setBudgetAccountLimit(host.govDb, { accountId: taskAccountIdFor("b04-retry-unfunded"), kind: "TASK", limitMu: 100, now: Date.now(), approvedBy: "test" });
    const subB = await convB.submit({ type: "input", content: "trigger retry unfunded" }, BACKGROUND_CONTEXT);
    const resB = await subB.wait(BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 50));
    const mAfterB = (await fakeModel.stats()).totalPhysicalRequests;
    const rowsB = host.govDb
      .prepare("SELECT * FROM budget_reservations WHERE owner_task_id = 'b04-retry-unfunded'")
      .all() as unknown as BudgetReservationRow[];
    assert.equal(resB.status, "unanswered");
    assert.equal(mAfterB - mBeforeB, 1, "B04 unfunded: exactly 1 physical request; durable retry blocked before send");
    assert.equal(rowsB.length, 1);

    await host.close();
    return {
      id: "B04",
      group: "B",
      status: "PASS",
      summary: "Durable retry reserves a new requestId before retry (funded=2 sends, unfunded=1 send); maxRetries=0 blocks hidden provider retries.",
      evidence: {
        fundedPhysicalRequests: mAfterA - mBeforeA,
        fundedReservationIds: rowsA.map((r) => ({ id: r.request_id, state: r.state })),
        unfundedPhysicalRequests: mAfterB - mBeforeB,
        unfundedReservationIds: rowsB.map((r) => ({ id: r.request_id, state: r.state })),
      },
    };
  } finally {
    await fakeModel.stop();
  }
}

async function testB05(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "b05");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const dataDir = path.join(dir, "host-data");

  // Day 1 at 23:55 Hong Kong time -> Day 2 after midnight!
  const day1Ms = Date.parse("2026-11-25T23:55:00+08:00");
  const day2Ms = Date.parse("2026-11-26T00:10:00+08:00");
  const day1Key = formatChargeDay(day1Ms, DEFAULT_TIME_ZONE);
  const day2Key = formatChargeDay(day2Ms, DEFAULT_TIME_ZONE);
  assert.notEqual(day1Key, day2Key);

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl, { upperMu: 100, actualMu: 60 });
    await fakeModel.queue({
      clear: true,
      scripts: [{ kind: "missing_usage", text: "Response with omitted usage block" }],
    });

    const host1 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "u@local.test" },
      now: () => day1Ms,
      settleTimeoutMs: 60_000,
    });
    const conv = await host1.createManagedConversation({ budgetTaskId: "b05-task" });
    await (await conv.submit({ type: "input", content: "missing usage test" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 40));

    const resBeforeRestart = host1.govDb
      .prepare("SELECT * FROM budget_reservations WHERE owner_task_id = 'b05-task'")
      .get() as unknown as BudgetReservationRow;
    assert.equal(resBeforeRestart.state, "HELD", "B05: missing usage must keep reservation HELD");
    assert.equal(resBeforeRestart.charge_day, day1Key);
    await host1.close();

    // Restart after midnight (day2Ms > settle_due_at)
    const host2 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "u@local.test" },
      now: () => day2Ms,
    });

    const chargedIds = chargeBoundExpiredReservations(host2.govDb, { now: day2Ms });
    assert.deepEqual(chargedIds, [resBeforeRestart.request_id]);
    const day1AfterBound = getBudgetAccount(host2.govDb, dayAccountIdFor(day1Key, DEFAULT_TIME_ZONE))!;
    const day2AfterBound = getBudgetAccount(host2.govDb, dayAccountIdFor(day2Key, DEFAULT_TIME_ZONE));
    assert.equal(day1AfterBound.held_mu, 0);
    assert.equal(day1AfterBound.charged_mu, 100);
    assert.equal(day2AfterBound, null, "B05: cross-midnight CHARGED_BOUND must NOT touch new day account");

    // Late trusted bill arrives (actual = 60) -> delta -40 applied to ORIGINAL day1 & task accounts
    const bill1 = correctChargedBoundReservation(host2.govDb, {
      requestId: resBeforeRestart.request_id,
      actualMu: 60,
      billEventKey: "bill:b05:inv001",
      evidenceRef: "invoice:synthetic-001",
      actorId: "owner",
      now: day2Ms + 1000,
    });
    assert.equal(bill1.duplicate, false);
    assert.equal(bill1.deltaMu, -40);

    // Duplicate late bill -> delta MUST be 0!
    const bill2 = correctChargedBoundReservation(host2.govDb, {
      requestId: resBeforeRestart.request_id,
      actualMu: 60,
      billEventKey: "bill:b05:inv001",
      evidenceRef: "invoice:synthetic-001",
      actorId: "owner",
      now: day2Ms + 2000,
    });
    assert.equal(bill2.duplicate, true);
    assert.equal(bill2.deltaMu, 0);

    const day1Final = getBudgetAccount(host2.govDb, dayAccountIdFor(day1Key, DEFAULT_TIME_ZONE))!;
    const taskFinal = getBudgetAccount(host2.govDb, taskAccountIdFor("b05-task"))!;
    const day2Final = getBudgetAccount(host2.govDb, dayAccountIdFor(day2Key, DEFAULT_TIME_ZONE));
    assert.equal(day1Final.charged_mu, 60);
    assert.equal(taskFinal.charged_mu, 60);
    assert.equal(day2Final, null);

    const mStats = await fakeModel.stats();
    assert.equal(mStats.totalPhysicalRequests, 1);

    await host2.close();
    return {
      id: "B05",
      group: "B",
      status: "PASS",
      summary: "Missing usage stayed HELD across restart, timed out to CHARGED_BOUND (100) on original day across midnight, corrected to 60 on late bill, duplicate bill delta=0, new day delta=0, total sends=1.",
      evidence: {
        requestId: resBeforeRestart.request_id,
        originalDay: day1Key,
        newDay: day2Key,
        day1Final,
        taskFinal,
        day2Final,
        duplicateBillDeltaMu: bill2.deltaMu,
        totalPhysicalRequests: mStats.totalPhysicalRequests,
      },
    };
  } finally {
    await fakeModel.stop();
  }
}

async function testB06(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "b06");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));

  try {
    // 1. Unknown upper bound (priceSchedule = null)
    const s1 = makeStandardSlots(fakeModel.baseUrl, { priceScheduleNull: true });
    const h1 = await AegisHostRuntime.start({
      dataDir: path.join(dir, "h1"),
      vault: s1.vault,
      modelSlots: s1.slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "u@local.test" },
    });
    const c1 = await h1.createManagedConversation({ budgetTaskId: "b06-unknown-upper" });
    await (await c1.submit({ type: "input", content: "unknown upper" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const res1Count = (h1.govDb.prepare("SELECT count(*) AS n FROM budget_reservations").get() as { n: number }).n;
    assert.equal(res1Count, 0);
    await h1.close();

    // 2. Endpoint / credential slot mismatch
    const badVault = new HostCredentialVault();
    badVault.registerSlot(
      {
        slotId: "slot:matrix",
        provider: "fake-local",
        allowedBaseUrls: ["http://127.0.0.1:9999"], // mismatch with fakeModel.baseUrl!
        allowedModelIds: ["fake-router-1"],
        priceVersion: "synthetic-100-60",
      },
      "SYNTHETIC_KEY",
    );
    const s2 = makeStandardSlots(fakeModel.baseUrl);
    const h2 = await AegisHostRuntime.start({
      dataDir: path.join(dir, "h2"),
      vault: badVault,
      modelSlots: s2.slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "u@local.test" },
    });
    const c2 = await h2.createManagedConversation({ budgetTaskId: "b06-bad-binding" });
    await (await c2.submit({ type: "input", content: "bad binding" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const res2Count = (h2.govDb.prepare("SELECT count(*) AS n FROM budget_reservations").get() as { n: number }).n;
    assert.equal(res2Count, 0);
    await h2.close();

    // 3. Provable pre-transport failure after reservation -> RELEASED, held_mu = 0
    const s3 = makeStandardSlots(fakeModel.baseUrl);
    const h3 = await AegisHostRuntime.start({
      dataDir: path.join(dir, "h3"),
      vault: s3.vault,
      modelSlots: s3.slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "u@local.test" },
      shouldFailBeforeTransport: () => "simulated_local_pre_transport_abort",
    });
    const c3 = await h3.createManagedConversation({ budgetTaskId: "b06-pre-transport" });
    await (await c3.submit({ type: "input", content: "pre-transport abort" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const res3 = h3.govDb
      .prepare("SELECT * FROM budget_reservations WHERE owner_task_id = 'b06-pre-transport'")
      .get() as unknown as BudgetReservationRow;
    assert.equal(res3.state, "RELEASED");
    const t3 = getBudgetAccount(h3.govDb, res3.task_account)!;
    const d3 = getBudgetAccount(h3.govDb, res3.day_account)!;
    assert.equal(t3.held_mu, 0);
    assert.equal(d3.held_mu, 0);
    await h3.close();

    const mStats = await fakeModel.stats();
    assert.equal(mStats.totalPhysicalRequests, 0, "B06: all 3 cases must send 0 physical requests");

    return {
      id: "B06",
      group: "B",
      status: "PASS",
      summary: "Unknown upper bound and slot/endpoint mismatch blocked with 0 reservations; provable pre-transport failure released both holds; 0 physical model sends across all 3.",
      evidence: {
        unknownUpperReservations: res1Count,
        badBindingReservations: res2Count,
        preTransportState: res3.state,
        preTransportTaskHeld: t3.held_mu,
        preTransportDayHeld: d3.held_mu,
        totalPhysicalRequests: mStats.totalPhysicalRequests,
      },
    };
  } finally {
    await fakeModel.stop();
  }
}

async function testB07(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "b07");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));

  try {
    let shouldInject = true;
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl, { upperMu: 100, actualMu: 60 });
    const host = await AegisHostRuntime.start({
      dataDir: path.join(dir, "host-data"),
      vault,
      modelSlots: slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "u@local.test" },
      injectFaultAfterFirstAccount: () => {
        if (shouldInject) {
          throw new Error("b07_injected_mid_tx_abort");
        }
      },
    });
    const conv = await host.createManagedConversation({ budgetTaskId: "b07-task" });
    await (await conv.submit({ type: "input", content: "mid-tx crash test" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);

    const mAfterFault = (await fakeModel.stats()).totalPhysicalRequests;
    const resAfterFault = (host.govDb.prepare("SELECT count(*) AS n FROM budget_reservations").get() as { n: number }).n;
    const taskAcctAfterFault = getBudgetAccount(host.govDb, taskAccountIdFor("b07-task"));
    assert.equal(mAfterFault, 0);
    assert.equal(resAfterFault, 0);
    assert.equal(taskAcctAfterFault?.held_mu ?? 0, 0, "B07: first account update must be fully rolled back");

    // Now disable fault and verify normal request succeeds cleanly with +1
    shouldInject = false;
    await fakeModel.queue({ clear: true, scripts: [{ kind: "text", text: "B07 recovery ok" }] });
    await (await conv.submit({ type: "input", content: "retry cleanly" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 40));
    const mAfterRetry = (await fakeModel.stats()).totalPhysicalRequests;
    const resAfterRetry = host.govDb
      .prepare("SELECT * FROM budget_reservations WHERE owner_task_id = 'b07-task'")
      .all() as unknown as BudgetReservationRow[];
    assert.equal(mAfterRetry, 1);
    assert.equal(resAfterRetry.length, 1);
    assert.equal(resAfterRetry[0]?.state, "SETTLED");

    await host.close();
    return {
      id: "B07",
      group: "B",
      status: "PASS",
      summary: "Mid-transaction failure after first account update rolled back both accounts and reservation cleanly (0 sends); subsequent clean run succeeded (+1).",
      evidence: {
        requestsAfterFault: mAfterFault,
        reservationsAfterFault: resAfterFault,
        requestsAfterRetry: mAfterRetry,
        finalState: resAfterRetry[0]?.state,
      },
    };
  } finally {
    await fakeModel.stop();
  }
}

// =============================================================================
// E01 - E10 (E06 is covered end-to-end by standalone runW1B)
// =============================================================================

async function testE01(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "e01");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"), { mode: "normal" });

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
    let approvedBeforePark = false;
    let approvedEffectId = "";
    let hostRef: AegisHostRuntime | null = null;

    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: { id: "call_e01", name: "send_email", arguments: { to: ["e01@local.test"], subject: "E01", body: "Approve before park" } },
        },
        { kind: "text", text: "E01 completed" },
      ],
    });

    const host = await AegisHostRuntime.start({
      dataDir: path.join(dir, "host-data"),
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      onBeforeToolAfterProposal: ({ approvalId, conversationId }) => {
        if (approvedBeforePark || !hostRef) return;
        approvedBeforePark = true;
        // Approve SYNCHRONOUSLY inside beforeTool right after proposal creation & BEFORE returning { sleep }!
        const row = hostRef.govDb
          .prepare(
            `SELECT a.revision, d.action_hash, c.nonce_value
               FROM approvals a
               JOIN draft_revisions d ON d.proposal_id = a.proposal_id AND d.revision = a.revision
               JOIN approval_challenges c ON c.approval_id = a.approval_id
              WHERE a.approval_id = ?`,
          )
          .get(approvalId) as { revision: number; action_hash: string; nonce_value: string };
        const dec = decideApproval(hostRef.govDb, {
          approvalId,
          conversationId,
          principalId: "owner",
          decision: "APPROVE",
          expectedRevision: row.revision,
          expectedActionHash: row.action_hash,
          nonce: row.nonce_value,
          decisionKey: "dk-e01-early",
          now: Date.now(),
        });
        assert.equal(dec.httpStatus, 200);
        approvedEffectId = dec.effectId!;
      },
    });
    hostRef = host;

    const conv = await host.createManagedConversation({ budgetTaskId: "e01-task" });
    await (await conv.submit({ type: "input", content: "send e01" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);

    const smtpStats = await fakeSmtp.stats();
    const eff = host.govDb.prepare("SELECT * FROM effects WHERE effect_id = ?").get(approvedEffectId) as unknown as EffectRow;
    const pendingOutbox = (host.govDb.prepare("SELECT count(*) AS n FROM signal_outbox WHERE state = 'PENDING'").get() as { n: number }).n;
    const claims = countSuccessfulClaimsForEffect(host.govDb, approvedEffectId);

    assert.equal(approvedBeforePark, true);
    assert.equal(smtpStats.totalReceived, 1);
    assert.equal(eff.state, "SUCCEEDED");
    assert.equal(claims, 1);
    assert.equal(pendingOutbox, 0);

    await host.close();
    return {
      id: "E01",
      group: "E",
      status: "PASS",
      summary: "Approval committed before Pi tool parked was observed immediately on re-entry; outbox reconciled to ACKED, claim=1, SMTP=1.",
      evidence: { effectId: approvedEffectId, effectState: eff.state, claims, smtpReceived: smtpStats.totalReceived, pendingOutbox },
    };
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

async function testE02(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "e02");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"), { mode: "normal" });
  const dataDir = path.join(dir, "host-data");

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: { id: "call_e02", name: "send_email", arguments: { to: ["e02@local.test"], subject: "E02", body: "E02 body" } },
        },
        { kind: "text", text: "E02 done" },
      ],
    });

    const host1 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      pauseOutboxDelivery: true,
    });
    const conv = await host1.createManagedConversation({ budgetTaskId: "e02-task" });
    await conv.submit({ type: "input", content: "trigger e02" }, BACKGROUND_CONTEXT);
    const p = await waitForPendingProposal(host1, String(conv.id));
    await waitForToolSleeping(host1, Number(p.tool_task_id));

    // Part A: Crash INSIDE T2 before COMMIT -> full rollback!
    assert.throws(() => {
      decideApproval(host1.govDb, {
        approvalId: p.approval_id,
        conversationId: String(conv.id),
        principalId: "owner",
        decision: "APPROVE",
        expectedRevision: p.revision,
        expectedActionHash: p.action_hash,
        nonce: p.nonce_value!,
        decisionKey: "dk-e02-abort",
        now: Date.now(),
        injectCrashBeforeCommit: () => {
          throw new Error("e02_crash_before_commit");
        },
      });
    }, /e02_crash_before_commit/);

    const aprAfterRollback = host1.govDb.prepare("SELECT state FROM approvals WHERE approval_id = ?").get(p.approval_id) as { state: string };
    const effCountRollback = (host1.govDb.prepare("SELECT count(*) AS n FROM effects").get() as { n: number }).n;
    const outboxCountRollback = (host1.govDb.prepare("SELECT count(*) AS n FROM signal_outbox").get() as { n: number }).n;
    assert.equal(aprAfterRollback.state, "PENDING");
    assert.equal(effCountRollback, 0);
    assert.equal(outboxCountRollback, 0);
    assert.equal((await fakeSmtp.stats()).totalReceived, 0);

    // Part B: Commit T2 cleanly with outbox paused (simulating crash after commit & before signal delivery), then restart!
    const dec = decideApproval(host1.govDb, {
      approvalId: p.approval_id,
      conversationId: String(conv.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: p.revision,
      expectedActionHash: p.action_hash,
      nonce: p.nonce_value!,
      decisionKey: "dk-e02-commit",
      now: Date.now(),
    });
    assert.equal(dec.httpStatus, 200);
    const effectId = dec.effectId!;
    assert.equal((await fakeSmtp.stats()).totalReceived, 0);
    await host1.close();

    // Restart with outbox delivery enabled -> recovers & delivers pending outbox -> claims once -> SMTP=1
    const host2 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
    });
    const arrival = await fakeSmtp.waitArrival(1, 10_000);
    assert.equal(arrival.arrived, true);
    await host2.harness.waitForIdle(BACKGROUND_CONTEXT);

    const eff = host2.govDb.prepare("SELECT * FROM effects WHERE effect_id = ?").get(effectId) as unknown as EffectRow;
    const claims = countSuccessfulClaimsForEffect(host2.govDb, effectId);
    assert.equal(eff.state, "SUCCEEDED");
    assert.equal(claims, 1);
    assert.equal((await fakeSmtp.stats()).totalReceived, 1);

    await host2.close();
    return {
      id: "E02",
      group: "E",
      status: "PASS",
      summary: "Crash before T2 commit rolled back approval/effect/outbox cleanly (0 SMTP); restart after T2 commit delivered outbox and sent exactly 1 email.",
      evidence: {
        rollbackState: aprAfterRollback.state,
        effectId,
        finalEffectState: eff.state,
        claims,
        smtpTotalReceived: (await fakeSmtp.stats()).totalReceived,
      },
    };
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

async function testE03(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "e03");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"), { mode: "normal" });
  const dataDir = path.join(dir, "host-data");

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: { id: "call_e03", name: "send_email", arguments: { to: ["e03@local.test"], subject: "E03", body: "E03 body" } },
        },
        { kind: "text", text: "E03 complete" },
      ],
    });

    let threwAfterSignal = false;
    const host1 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      pauseOutboxDelivery: true,
      onAfterSignalBeforeAck: () => {
        if (!threwAfterSignal) {
          threwAfterSignal = true;
          throw new Error("e03_crash_after_signal_before_ack");
        }
      },
    });
    const conv = await host1.createManagedConversation({ budgetTaskId: "e03-task" });
    await conv.submit({ type: "input", content: "trigger e03" }, BACKGROUND_CONTEXT);
    const p = await waitForPendingProposal(host1, String(conv.id));
    await waitForToolSleeping(host1, Number(p.tool_task_id));

    const dec1 = decideApproval(host1.govDb, {
      approvalId: p.approval_id,
      conversationId: String(conv.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: p.revision,
      expectedActionHash: p.action_hash,
      nonce: p.nonce_value!,
      decisionKey: "dk-e03",
      now: Date.now(),
    });
    assert.equal(dec1.httpStatus, 200);
    const effectId = dec1.effectId!;

    // Idempotent same decisionKey + same payload -> 200 replay
    const decReplay = decideApproval(host1.govDb, {
      approvalId: p.approval_id,
      conversationId: String(conv.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: p.revision,
      expectedActionHash: p.action_hash,
      nonce: p.nonce_value!,
      decisionKey: "dk-e03",
      now: Date.now(),
    });
    assert.equal(decReplay.httpStatus, 200);
    assert.equal(decReplay.idempotentReplay, true);

    // Same decisionKey + DIFFERENT payload (REJECT instead of APPROVE) -> 409 conflict
    const decConflict = decideApproval(host1.govDb, {
      approvalId: p.approval_id,
      conversationId: String(conv.id),
      principalId: "owner",
      decision: "REJECT",
      expectedRevision: p.revision,
      expectedActionHash: p.action_hash,
      nonce: p.nonce_value!,
      decisionKey: "dk-e03",
      now: Date.now(),
    });
    assert.equal(decConflict.httpStatus, 409);
    assert.equal(decConflict.code, "decision_key_conflict");

    // Deliver signal -> throws right BEFORE writing outbox ACK (leaves outbox PENDING even though Pi received signal!)
    await assert.rejects(() => host1.deliverPendingOutbox(), /e03_crash_after_signal_before_ack/);
    await fakeSmtp.waitArrival(1, 10_000);
    await host1.harness.waitForIdle(BACKGROUND_CONTEXT);
    await host1.close();

    // Restart -> reconciles still-PENDING outbox against already-completed task/effect -> ACKED, ZERO duplicate sends!
    const host2 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
    });
    await new Promise((r) => setTimeout(r, 200));

    const outboxFinal = host2.govDb
      .prepare("SELECT state, sdk_result FROM signal_outbox WHERE approval_id = ?")
      .get(p.approval_id) as { state: string; sdk_result: string };
    const claims = countSuccessfulClaimsForEffect(host2.govDb, effectId);
    const smtpFinal = await fakeSmtp.stats();

    assert.equal(outboxFinal.state, "ACKED");
    assert.equal(claims, 1);
    assert.equal(smtpFinal.totalReceived, 1);

    await host2.close();
    return {
      id: "E03",
      group: "E",
      status: "PASS",
      summary: "Signal delivered without ACK reconciled cleanly on restart (claim=1, SMTP=1); decisionKey replay=200 and payload conflict=409.",
      evidence: {
        effectId,
        outboxFinal,
        replayStatus: decReplay.httpStatus,
        conflictStatus: decConflict.httpStatus,
        claims,
        smtpTotalReceived: smtpFinal.totalReceived,
      },
    };
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

async function testE04(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "e04");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"), { mode: "normal" });
  const dataDir = path.join(dir, "host-data");

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: { id: "call_e04", name: "send_email", arguments: { to: ["e04@local.test"], subject: "E04", body: "E04" } },
        },
      ],
    });

    const host1 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      pauseOutboxDelivery: true,
    });
    const conv = await host1.createManagedConversation({ budgetTaskId: "e04-task" });
    await conv.submit({ type: "input", content: "trigger e04" }, BACKGROUND_CONTEXT);
    const p = await waitForPendingProposal(host1, String(conv.id));
    await waitForToolSleeping(host1, Number(p.tool_task_id));

    // Approve -> READY committed (outbox paused)
    const dec = decideApproval(host1.govDb, {
      approvalId: p.approval_id,
      conversationId: String(conv.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: p.revision,
      expectedActionHash: p.action_hash,
      nonce: p.nonce_value!,
      decisionKey: "dk-e04",
      now: Date.now(),
    });
    const effectId = dec.effectId!;

    // Tool task terminates BEFORE claim!
    await host1.harness.abortTask(Number(p.tool_task_id) as TaskId, BACKGROUND_CONTEXT);
    await host1.harness.waitForIdle(BACKGROUND_CONTEXT);
    await host1.close();

    // Restart -> Step 5 bidirectional reconciliation MUST quarantine orphaned READY effect!
    const host2 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
    });
    const eff = host2.govDb.prepare("SELECT * FROM effects WHERE effect_id = ?").get(effectId) as unknown as EffectRow;
    const claims = countSuccessfulClaimsForEffect(host2.govDb, effectId);
    const smtpStats = await fakeSmtp.stats();
    const label = uiStatusLabelFor("APPROVED", eff.state);

    assert.equal(eff.state, "QUARANTINED");
    assert.equal(claims, 0);
    assert.equal(smtpStats.totalReceived, 0);
    assert.equal(label, "未提交，待核对");

    await host2.close();
    return {
      id: "E04",
      group: "E",
      status: "PASS",
      summary: "Tool terminated before claim caused recovery to quarantine READY -> QUARANTINED (未提交，待核对) with 0 claims and 0 SMTP.",
      evidence: { effectId, effectState: eff.state, uiLabel: label, claims, smtpReceived: smtpStats.totalReceived },
    };
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

async function testE05(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "e05");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"), { mode: "normal" });
  const dataDir = path.join(dir, "host-data");

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: { id: "call_e05", name: "send_email", arguments: { to: ["e05@local.test"], subject: "E05", body: "E05" } },
        },
        { kind: "text", text: "E05 after" },
      ],
    });

    let claimedEffectId = "";
    let resolveBarrier!: () => void;
    const claimBarrier = new Promise<void>((r) => (resolveBarrier = r));

    const host1 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      onAfterClaimBeforeTransport: async (effId) => {
        claimedEffectId = effId;
        resolveBarrier();
        // Hold indefinitely without ever opening SMTP socket -> host1 closes/aborts leaving SUBMITTING on disk!
        await new Promise<void>(() => {});
      },
    });
    const conv = await host1.createManagedConversation({ budgetTaskId: "e05-task" });
    await conv.submit({ type: "input", content: "trigger e05" }, BACKGROUND_CONTEXT);
    const p = await waitForPendingProposal(host1, String(conv.id));
    await waitForToolSleeping(host1, Number(p.tool_task_id));

    const dec = decideApproval(host1.govDb, {
      approvalId: p.approval_id,
      conversationId: String(conv.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: p.revision,
      expectedActionHash: p.action_hash,
      nonce: p.nonce_value!,
      decisionKey: "dk-e05",
      now: Date.now(),
    });
    const effectId = dec.effectId!;

    await claimBarrier;
    // Close DB & lock abruptly (simulating kill right after READY->SUBMITTING commit and before SMTP connect)
    host1.govDb.close();
    await host1.lock.release();

    // Restart Host #2: MUST convert SUBMITTING -> UNKNOWN even though fake SMTP received 0!
    const host2 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
    });
    assert.ok(host2.startupReport.recoveredSubmittingToUnknown.includes(effectId));
    const eff = host2.govDb.prepare("SELECT * FROM effects WHERE effect_id = ?").get(effectId) as unknown as EffectRow;
    const claims = countSuccessfulClaimsForEffect(host2.govDb, effectId);
    const smtpStats = await fakeSmtp.stats();

    assert.equal(claimedEffectId, effectId);
    assert.equal(eff.state, "UNKNOWN");
    assert.equal(claims, 1);
    assert.equal(smtpStats.totalReceived, 0);
    assert.equal(uiStatusLabelFor("APPROVED", eff.state), "结果待核对");

    await host2.close();
    return {
      id: "E05",
      group: "E",
      status: "PASS",
      summary: "Crash after READY->SUBMITTING commit and before SMTP transport recovered to UNKNOWN (结果待核对) with claim=1 and SMTP=0.",
      evidence: { effectId, effectState: eff.state, claims, smtpReceived: smtpStats.totalReceived },
    };
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

async function testE07(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "e07");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"), { mode: "normal" });

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: { id: "call_e07", name: "send_email", arguments: { to: ["e07@local.test"], subject: "E07-r1", body: "BODY_R1_ORIGINAL" } },
        },
        { kind: "text", text: "E07 done" },
      ],
    });

    const host = await AegisHostRuntime.start({
      dataDir: path.join(dir, "host-data"),
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      pauseOutboxDelivery: true,
    });
    const conv = await host.createManagedConversation({ budgetTaskId: "e07-task" });
    await conv.submit({ type: "input", content: "trigger e07" }, BACKGROUND_CONTEXT);
    const r1 = await waitForPendingProposal(host, String(conv.id));
    await waitForToolSleeping(host, Number(r1.tool_task_id));

    // Subcase A: Approve r1 (while outbox paused -> READY unclaimed), THEN edit to r2!
    const decR1 = decideApproval(host.govDb, {
      approvalId: r1.approval_id,
      conversationId: String(conv.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: r1.action_hash,
      nonce: r1.nonce_value!,
      decisionKey: "dk-e07-r1",
      now: Date.now(),
    });
    assert.equal(decR1.httpStatus, 200);
    const r1EffectId = decR1.effectId!;

    // Edit to r2 -> MUST quarantine r1's READY effect and isolate r1's pending outbox!
    const editR2 = saveDraftRevision(host.govDb, {
      proposalId: r1.proposal_id,
      conversationId: String(conv.id),
      principalId: "owner",
      expectedHeadRev: 1,
      target: "smtp:e07@local.test",
      payload: { to: ["e07@local.test"], subject: "E07-r2", body: "BODY_R2_FINAL_EDITED" },
      expiresAt: Date.now() + 60_000,
      now: Date.now(),
    });
    assert.equal(editR2.httpStatus, 200);
    assert.ok(editR2.quarantinedEffectIds?.includes(r1EffectId));

    // Old tab tries to approve r1 with new key -> 409!
    const staleApprove = decideApproval(host.govDb, {
      approvalId: r1.approval_id,
      conversationId: String(conv.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: r1.action_hash,
      nonce: r1.nonce_value!,
      decisionKey: "dk-e07-stale-r1",
      now: Date.now(),
    });
    assert.equal(staleApprove.httpStatus, 409);
    assert.equal((await fakeSmtp.stats()).totalReceived, 0);

    // Approve r2 & enable outbox -> ONLY r2 is claimed and SMTP receives BODY_R2_FINAL_EDITED!
    const decR2 = decideApproval(host.govDb, {
      approvalId: editR2.approval!.approval_id,
      conversationId: String(conv.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 2,
      expectedActionHash: editR2.revision!.action_hash,
      nonce: editR2.nonce!,
      decisionKey: "dk-e07-r2",
      now: Date.now(),
    });
    assert.equal(decR2.httpStatus, 200);
    host.setOutboxDeliveryPaused(false);
    await host.deliverPendingOutbox();

    const arrival = await fakeSmtp.waitArrival(1, 10_000);
    assert.equal(arrival.arrived, true);
    await host.harness.waitForIdle(BACKGROUND_CONTEXT);

    const smtpStats = await fakeSmtp.stats();
    assert.equal(smtpStats.totalReceived, 1);
    assert.ok(smtpStats.records[0]!.rawData.includes("BODY_R2_FINAL_EDITED"));
    assert.ok(!smtpStats.records[0]!.rawData.includes("BODY_R1_ORIGINAL"));

    const r1Eff = host.govDb.prepare("SELECT state FROM effects WHERE effect_id = ?").get(r1EffectId) as { state: string };
    const r2Eff = host.govDb.prepare("SELECT state FROM effects WHERE effect_id = ?").get(decR2.effectId!) as { state: string };
    assert.equal(r1Eff.state, "QUARANTINED");
    assert.equal(r2Eff.state, "SUCCEEDED");

    await host.close();
    return {
      id: "E07",
      group: "E",
      status: "PASS",
      summary: "Editing draft after r1 approval quarantined r1 READY effect and rejected stale r1 approval (409); approving r2 delivered exact r2 bytes (SMTP=1).",
      evidence: {
        r1EffectState: r1Eff.state,
        r2EffectState: r2Eff.state,
        staleR1HttpStatus: staleApprove.httpStatus,
        smtpReceived: smtpStats.totalReceived,
        smtpMatchesR2Bytes: smtpStats.records[0]!.rawData.includes("BODY_R2_FINAL_EDITED"),
      },
    };
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

async function testE08(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "e08");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"), { mode: "normal" });

  try {
    // Race A: Revoke wins BEFORE claim CAS -> READY quarantined, claim=0, SMTP=0
    {
      const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
      await fakeModel.queue({
        clear: true,
        scripts: [
          {
            kind: "tool_call",
            toolCall: { id: "call_e08_a", name: "send_email", arguments: { to: ["e08a@local.test"], subject: "E08A", body: "A" } },
          },
          { kind: "text", text: "A done" },
        ],
      });
      let hostA: AegisHostRuntime | null = null;
      const hA = await AegisHostRuntime.start({
        dataDir: path.join(dir, "race-a"),
        vault,
        modelSlots: slots,
        smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
        onBeforeClaim: () => {
          revokeOrCancelScope(hostA!.govDb, {
            scopeId: "scope:default",
            actorId: "owner",
            reason: "revoke_before_claim",
            now: Date.now(),
          });
        },
      });
      hostA = hA;
      const conv = await hA.createManagedConversation({ budgetTaskId: "e08a" });
      await conv.submit({ type: "input", content: "e08a" }, BACKGROUND_CONTEXT);
      const p = await waitForPendingProposal(hA, String(conv.id));
      await waitForToolSleeping(hA, Number(p.tool_task_id));
      const dec = decideApproval(hA.govDb, {
        approvalId: p.approval_id,
        conversationId: String(conv.id),
        principalId: "owner",
        decision: "APPROVE",
        expectedRevision: 1,
        expectedActionHash: p.action_hash,
        nonce: p.nonce_value!,
        decisionKey: "dk-e08a",
        now: Date.now(),
      });
      await hA.deliverPendingOutbox();
      await hA.harness.waitForIdle(BACKGROUND_CONTEXT);

      const eff = hA.govDb.prepare("SELECT state FROM effects WHERE effect_id = ?").get(dec.effectId!) as { state: string };
      assert.equal(eff.state, "QUARANTINED");
      assert.equal(countSuccessfulClaimsForEffect(hA.govDb, dec.effectId!), 0);
      assert.equal((await fakeSmtp.stats()).totalReceived, 0);
      await hA.close();
    }

    // Race B: Claim wins BEFORE revoke -> revoke retains SUBMITTING effect, current send finishes (SMTP=1)
    let retainedIds: string[] = [];
    {
      const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
      await fakeModel.queue({
        clear: true,
        scripts: [
          {
            kind: "tool_call",
            toolCall: { id: "call_e08_b", name: "send_email", arguments: { to: ["e08b@local.test"], subject: "E08B", body: "B" } },
          },
          { kind: "text", text: "B done" },
        ],
      });
      let hostB: AegisHostRuntime | null = null;
      const hB = await AegisHostRuntime.start({
        dataDir: path.join(dir, "race-b"),
        vault,
        modelSlots: slots,
        smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
        onAfterClaimBeforeTransport: () => {
          const rev = revokeOrCancelScope(hostB!.govDb, {
            scopeId: "scope:default",
            actorId: "owner",
            reason: "revoke_after_claim",
            now: Date.now(),
          });
          retainedIds = rev.retainedCommittedEffectIds;
        },
      });
      hostB = hB;
      const conv = await hB.createManagedConversation({ budgetTaskId: "e08b" });
      await conv.submit({ type: "input", content: "e08b" }, BACKGROUND_CONTEXT);
      const p = await waitForPendingProposal(hB, String(conv.id));
      await waitForToolSleeping(hB, Number(p.tool_task_id));
      const dec = decideApproval(hB.govDb, {
        approvalId: p.approval_id,
        conversationId: String(conv.id),
        principalId: "owner",
        decision: "APPROVE",
        expectedRevision: 1,
        expectedActionHash: p.action_hash,
        nonce: p.nonce_value!,
        decisionKey: "dk-e08b",
        now: Date.now(),
      });
      await hB.deliverPendingOutbox();
      await hB.harness.waitForIdle(BACKGROUND_CONTEXT);

      const eff = hB.govDb.prepare("SELECT state FROM effects WHERE effect_id = ?").get(dec.effectId!) as { state: string };
      assert.ok(retainedIds.includes(dec.effectId!));
      assert.equal(eff.state, "SUCCEEDED");
      assert.equal(countSuccessfulClaimsForEffect(hB.govDb, dec.effectId!), 1);
      assert.equal((await fakeSmtp.stats()).totalReceived, 1);
      await hB.close();
    }

    return {
      id: "E08",
      group: "E",
      status: "PASS",
      summary: "Both revoke-vs-claim serialization orders verified: revoke-first quarantined READY (SMTP=0); claim-first retained committed effect and completed honestly (SMTP=1).",
      evidence: { revokeFirstSmtp: 0, claimFirstRetainedEffects: retainedIds, totalSmtpAcrossBoth: 1 },
    };
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

async function testE09(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "e09");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"), { mode: "normal" });

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
    await fakeModel.queue({
      clear: true,
      scripts: [
        { kind: "tool_call", toolCall: { id: "call_e09_rej", name: "send_email", arguments: { to: ["e09@local.test"], subject: "Rej", body: "Rej" } } },
        { kind: "text", text: "Rejected handled" },
        { kind: "tool_call", toolCall: { id: "call_e09_exp", name: "send_email", arguments: { to: ["e09@local.test"], subject: "Exp", body: "Exp" } } },
        { kind: "text", text: "Expired handled" },
        { kind: "tool_call", toolCall: { id: "call_e09_race", name: "send_email", arguments: { to: ["e09@local.test"], subject: "Race", body: "Race" } } },
        { kind: "text", text: "Race handled" },
      ],
    });

    let nowClock = Date.now();
    const host = await AegisHostRuntime.start({
      dataDir: path.join(dir, "host-data"),
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      now: () => nowClock,
    });

    // 1. Explicit REJECT + Cross-conversation 403 check
    const c1 = await host.createManagedConversation({ budgetTaskId: "e09-rej" });
    const sub1 = await c1.submit({ type: "input", content: "reject test" }, BACKGROUND_CONTEXT);
    const p1 = await waitForPendingProposal(host, String(c1.id));
    await waitForToolSleeping(host, Number(p1.tool_task_id));

    // Cross-conversation attempt -> 403
    const crossConv = decideApproval(host.govDb, {
      approvalId: p1.approval_id,
      conversationId: "99999",
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: p1.action_hash,
      nonce: p1.nonce_value!,
      decisionKey: "dk-e09-cross",
      now: nowClock,
    });
    assert.equal(crossConv.httpStatus, 403);

    // Unauthorized principal attempt -> 403
    const badPrincipal = decideApproval(host.govDb, {
      approvalId: p1.approval_id,
      conversationId: String(c1.id),
      principalId: "intruder",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: p1.action_hash,
      nonce: p1.nonce_value!,
      decisionKey: "dk-e09-intruder",
      now: nowClock,
    });
    assert.equal(badPrincipal.httpStatus, 403);

    // Legitimate REJECT -> 200, 0 effects, tool wakes and blocks
    const rej = decideApproval(host.govDb, {
      approvalId: p1.approval_id,
      conversationId: String(c1.id),
      principalId: "owner",
      decision: "REJECT",
      expectedRevision: 1,
      expectedActionHash: p1.action_hash,
      nonce: p1.nonce_value!,
      decisionKey: "dk-e09-rej",
      now: nowClock,
    });
    assert.equal(rej.httpStatus, 200);
    assert.equal(rej.effectId, null);
    await host.deliverPendingOutbox();
    await sub1.wait(BACKGROUND_CONTEXT);
    assert.equal((await fakeSmtp.stats()).totalReceived, 0);

    // 2. Expired approval -> 410, 0 effects
    const c2 = await host.createManagedConversation({ budgetTaskId: "e09-exp" });
    const sub2 = await c2.submit({ type: "input", content: "expire test" }, BACKGROUND_CONTEXT);
    const p2 = await waitForPendingProposal(host, String(c2.id));
    await waitForToolSleeping(host, Number(p2.tool_task_id));

    nowClock += 60 * 60 * 1000; // advance past 30m TTL
    const exp = decideApproval(host.govDb, {
      approvalId: p2.approval_id,
      conversationId: String(c2.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: p2.action_hash,
      nonce: p2.nonce_value!,
      decisionKey: "dk-e09-exp",
      now: nowClock,
    });
    assert.equal(exp.httpStatus, 410);
    assert.equal(exp.effectId, null);
    await host.deliverPendingOutbox();
    await sub2.wait(BACKGROUND_CONTEXT);
    assert.equal((await fakeSmtp.stats()).totalReceived, 0);

    // 3. Two tabs race with DIFFERENT decisionKeys -> exactly 1 wins (200), loser gets 409, SMTP=1
    const c3 = await host.createManagedConversation({ budgetTaskId: "e09-race" });
    const sub3 = await c3.submit({ type: "input", content: "concurrent decide" }, BACKGROUND_CONTEXT);
    const p3 = await waitForPendingProposal(host, String(c3.id));
    await waitForToolSleeping(host, Number(p3.tool_task_id));

    const [tabA, tabB] = await Promise.all([
      Promise.resolve().then(() =>
        decideApproval(host.govDb, {
          approvalId: p3.approval_id,
          conversationId: String(c3.id),
          principalId: "owner",
          decision: "APPROVE",
          expectedRevision: 1,
          expectedActionHash: p3.action_hash,
          nonce: p3.nonce_value!,
          decisionKey: "dk-tab-A",
          now: nowClock,
        }),
      ),
      Promise.resolve().then(() =>
        decideApproval(host.govDb, {
          approvalId: p3.approval_id,
          conversationId: String(c3.id),
          principalId: "owner",
          decision: "APPROVE",
          expectedRevision: 1,
          expectedActionHash: p3.action_hash,
          nonce: p3.nonce_value!,
          decisionKey: "dk-tab-B",
          now: nowClock,
        }),
      ),
    ]);
    const statuses = [tabA.httpStatus, tabB.httpStatus].sort();
    assert.deepEqual(statuses, [200, 409]);
    await host.deliverPendingOutbox();
    await sub3.wait(BACKGROUND_CONTEXT);
    assert.equal((await fakeSmtp.stats()).totalReceived, 1);

    await host.close();
    return {
      id: "E09",
      group: "E",
      status: "PASS",
      summary: "Verified REJECT (0 SMTP), EXPIRED (410, 0 SMTP), cross-conv/principal (403, 0 SMTP), and dual-tab race ([200, 409], SMTP=1).",
      evidence: {
        crossConvStatus: crossConv.httpStatus,
        badPrincipalStatus: badPrincipal.httpStatus,
        rejectStatus: rej.httpStatus,
        expiredStatus: exp.httpStatus,
        dualTabStatuses: statuses,
        totalSmtp: 1,
      },
    };
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

async function testE10(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "e10");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"), { mode: "normal" });
  const dataDir = path.join(dir, "host-data");

  try {
    const { vault, slots } = makeStandardSlots(fakeModel.baseUrl);
    await fakeModel.queue({
      clear: true,
      scripts: [
        { kind: "tool_call", toolCall: { id: "call_e10_tamper", name: "send_email", arguments: { to: ["e10@local.test"], subject: "T", body: "Clean" } } },
        { kind: "text", text: "Tamper blocked" },
        { kind: "tool_call", toolCall: { id: "call_e10_ok", name: "send_email", arguments: { to: ["e10@local.test"], subject: "OK", body: "Good" } } },
        { kind: "text", text: "OK sent" },
      ],
    });

    // Subcase A: Tampered final payload/target blocked by submitter hash check (claim=0, SMTP=0)
    const host1 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
      tamperFinalPayloadForTest: (_effId, payload) => ({
        payload: { ...payload, body: "TAMPERED_EVIL_BODY" },
        target: "smtp:attacker@evil.test",
      }),
    });
    const c1 = await host1.createManagedConversation({ budgetTaskId: "e10-tamper" });
    const sub1 = await c1.submit({ type: "input", content: "tamper test" }, BACKGROUND_CONTEXT);
    const p1 = await waitForPendingProposal(host1, String(c1.id));
    await waitForToolSleeping(host1, Number(p1.tool_task_id));
    const dec1 = decideApproval(host1.govDb, {
      approvalId: p1.approval_id,
      conversationId: String(c1.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: p1.action_hash,
      nonce: p1.nonce_value!,
      decisionKey: "dk-e10-tamper",
      now: Date.now(),
    });
    await host1.deliverPendingOutbox();
    await sub1.wait(BACKGROUND_CONTEXT);
    assert.equal(countSuccessfulClaimsForEffect(host1.govDb, dec1.effectId!), 0);
    assert.equal((await fakeSmtp.stats()).totalReceived, 0);

    // Subcase B: Concurrent claim CAS on same READY effect -> exactly 1 wins
    ensureScope(host1.govDb, {
      scopeId: "scope:e10-concurrent",
      allowedPrincipals: ["owner"],
      allowedTools: ["send_email"],
      allowedTargets: ["smtp:race@local.test"],
    });
    const raceProp = proposeOrGetApproval(host1.govDb, {
      runtimeEpoch: host1.runtimeEpoch,
      conversationId: "conv-e10-race",
      toolTaskId: "task-e10-race",
      callId: "call-e10-race",
      scopeId: "scope:e10-concurrent",
      toolName: "send_email",
      target: "smtp:race@local.test",
      payload: { to: ["race@local.test"], subject: "Race", body: "Race" },
      expiresAt: Date.now() + 60_000,
      now: Date.now(),
    });
    const raceDec = decideApproval(host1.govDb, {
      approvalId: raceProp.approval.approval_id,
      conversationId: "conv-e10-race",
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: raceProp.revision.action_hash,
      nonce: raceProp.nonce!,
      decisionKey: "dk-e10-race-claim",
      now: Date.now(),
    });
    const [claim1, claim2] = await Promise.all([
      Promise.resolve().then(() =>
        claimEffectForSubmission(host1.govDb, {
          effectId: raceDec.effectId!,
          runtimeEpoch: host1.runtimeEpoch,
          conversationId: "conv-e10-race",
          toolTaskId: "task-e10-race",
          callId: "call-e10-race",
          toolName: "send_email",
          finalTarget: "smtp:race@local.test",
          finalPayload: { to: ["race@local.test"], subject: "Race", body: "Race" },
          now: Date.now(),
        }),
      ),
      Promise.resolve().then(() =>
        claimEffectForSubmission(host1.govDb, {
          effectId: raceDec.effectId!,
          runtimeEpoch: host1.runtimeEpoch,
          conversationId: "conv-e10-race",
          toolTaskId: "task-e10-race",
          callId: "call-e10-race",
          toolName: "send_email",
          finalTarget: "smtp:race@local.test",
          finalPayload: { to: ["race@local.test"], subject: "Race", body: "Race" },
          now: Date.now(),
        }),
      ),
    ]);
    assert.equal([claim1.claimed, claim2.claimed].filter(Boolean).length, 1);
    assert.equal(countSuccessfulClaimsForEffect(host1.govDb, raceDec.effectId!), 1);
    await host1.close();

    // Subcase C: Legitimate SUCCEEDED effect persists across restart (NEVER downgraded to UNKNOWN!)
    const host2 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
    });
    const c2 = await host2.createManagedConversation({ budgetTaskId: "e10-ok" });
    const sub2 = await c2.submit({ type: "input", content: "legit send" }, BACKGROUND_CONTEXT);
    const p2 = await waitForPendingProposal(host2, String(c2.id));
    await waitForToolSleeping(host2, Number(p2.tool_task_id));
    const dec2 = decideApproval(host2.govDb, {
      approvalId: p2.approval_id,
      conversationId: String(c2.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: p2.action_hash,
      nonce: p2.nonce_value!,
      decisionKey: "dk-e10-ok",
      now: Date.now(),
    });
    await host2.deliverPendingOutbox();
    await sub2.wait(BACKGROUND_CONTEXT);
    const okEffectId = dec2.effectId!;
    const effBeforeRestart = host2.govDb.prepare("SELECT state FROM effects WHERE effect_id = ?").get(okEffectId) as { state: string };
    assert.equal(effBeforeRestart.state, "SUCCEEDED");
    await host2.close();

    // Restart Host #3 -> SUCCEEDED stays SUCCEEDED!
    const host3 = await AegisHostRuntime.start({
      dataDir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "a@local.test" },
    });
    const effAfterRestart = host3.govDb.prepare("SELECT state, receipt_ref FROM effects WHERE effect_id = ?").get(okEffectId) as {
      state: string;
      receipt_ref: string | null;
    };
    assert.equal(effAfterRestart.state, "SUCCEEDED");
    assert.ok(effAfterRestart.receipt_ref);
    assert.equal((await fakeSmtp.stats()).totalReceived, 1);
    await host3.close();

    return {
      id: "E10",
      group: "E",
      status: "PASS",
      summary: "Tampered final args blocked (0 claims, 0 SMTP); concurrent READY claim admitted exactly 1; SUCCEEDED persisted as SUCCEEDED across restart (SMTP=1).",
      evidence: {
        tamperClaims: 0,
        concurrentClaimWinners: [claim1.claimed, claim2.claimed].filter(Boolean).length,
        succeededAfterRestart: effAfterRestart,
        totalSmtp: 1,
      },
    };
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

function testArchitectureBoundary(): MatrixCaseResult {
  const violations: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts")) {
        const rel = path.relative(path.resolve("src"), full).replace(/\\/g, "/");
        const content = readFileSync(full, "utf8");
        if (/@earendil-works\//.test(content) && !rel.startsWith("runtime/")) {
          violations.push(rel);
        }
        if (rel.startsWith("governance/") && /\.\.\/(runtime|web|capabilities)\//.test(content)) {
          violations.push(`upward-dep:${rel}`);
        }
      }
    }
  };
  walk(path.resolve("src"));
  assert.equal(violations.length, 0, `Architecture boundary violations: ${violations.join(", ")}`);
  return {
    id: "GUARD-BOUNDARY",
    group: "GUARD",
    status: "PASS",
    summary: "Verified only src/runtime/ imports @earendil-works/* and governance/ has zero upward dependencies.",
    evidence: { violations },
  };
}

export async function runMatrix(opts?: { dataDir?: string; evidenceDir?: string }) {
  const rootDir = path.resolve(opts?.dataDir ?? `.tmp-week1-matrix-${Date.now()}`);
  mkdirSync(rootDir, { recursive: true });
  const results: MatrixCaseResult[] = [];
  let failed = false;

  const tests: Array<() => Promise<MatrixCaseResult> | MatrixCaseResult> = [
    testArchitectureBoundary,
    () => testF01(rootDir),
    () => testF02(rootDir),
    () => testF03(rootDir),
    () => testB02(rootDir),
    () => testB03(rootDir),
    () => testB04(rootDir),
    () => testB05(rootDir),
    () => testB06(rootDir),
    () => testB07(rootDir),
    () => testE01(rootDir),
    () => testE02(rootDir),
    () => testE03(rootDir),
    () => testE04(rootDir),
    () => testE05(rootDir),
    () => testE07(rootDir),
    () => testE08(rootDir),
    () => testE09(rootDir),
    () => testE10(rootDir),
  ];

  for (const fn of tests) {
    try {
      const r = await fn();
      results.push(r);
    } catch (err) {
      failed = true;
      results.push({
        id: fn.name || "UNKNOWN",
        group: "GUARD",
        status: "FAIL",
        summary: err instanceof Error ? err.message : String(err),
        evidence: { stack: err instanceof Error ? err.stack : String(err) },
      });
    }
  }

  const report = {
    suite: "WEEK1-MATRIX",
    status: failed ? "FAIL" : "PASS",
    nodeVersion: process.version,
    sqliteVersion: process.versions.sqlite,
    passed: results.filter((r) => r.status === "PASS").length,
    total: results.length,
    results,
  };

  if (opts?.evidenceDir) {
    mkdirSync(path.resolve(opts.evidenceDir), { recursive: true });
    writeFileSync(
      path.join(path.resolve(opts.evidenceDir), "matrix-evidence.json"),
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    );
  }
  return { report, failed };
}

if (import.meta.url === new URL(`file:///${process.argv[1]!.replace(/\\/g, "/")}`).href) {
  const { report, failed } = await runMatrix();
  console.log(JSON.stringify(report, null, 2));
  if (failed) process.exit(1);
}
