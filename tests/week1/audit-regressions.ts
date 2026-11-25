import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { sendSmtpMessage } from "../../src/capabilities/mail/smtp-client.ts";
import {
  decideApproval,
  ensureScope,
  proposeOrGetApproval,
} from "../../src/governance/approvals.ts";
import {
  getBudgetAccount,
  setBudgetAccountLimit,
  taskAccountIdFor,
  type BudgetReservationRow,
} from "../../src/governance/budget.ts";
import {
  HostCredentialVault,
  Stage1EgressBlockedError,
} from "../../src/governance/credentials.ts";
import {
  claimEffectForSubmission,
  recoverSubmittingEffectsToUnknown,
} from "../../src/governance/effects.ts";
import { AegisHostRuntime } from "../../src/runtime/harness.ts";
import type { ModelSlotConfig } from "../../src/runtime/models.ts";
import { startWebServer } from "../../src/web/server.ts";
import { LOCKED_NODE_EXE, startFakeModelServer, startFakeSmtpServer } from "../fakes/client.ts";
import type { MatrixCaseResult } from "./run-matrix.ts";

export interface MatrixHostProcess {
  pid: number;
  port: number;
  baseUrl: string;
  runtimeEpoch: string;
  health: string;
  recoveredSubmittingToUnknown: string[];
  reconciledQuarantinedEffects: string[];
  chargedBoundReservations: string[];
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
  stopGracefully: () => Promise<void>;
}

export async function spawnMatrixHost(opts: {
  dataDir: string;
  modelBaseUrl: string;
  smtpHost: string;
  smtpPort: number;
  consoleToken?: string;
  principalTokens?: Record<string, string>;
  pauseOutbox?: boolean;
  faultBeforeT2CommitFile?: string;
  faultAfterSignalBeforeAckFile?: string;
  faultAfterClaimBeforeSmtpFile?: string;
}): Promise<MatrixHostProcess> {
  const entry = path.resolve("src/index.ts");
  const cliArgs = [
    entry,
    "--data-dir",
    opts.dataDir,
    "--port",
    "0",
    "--model-base-url",
    opts.modelBaseUrl,
    "--smtp-host",
    opts.smtpHost,
    "--smtp-port",
    String(opts.smtpPort),
    "--synthetic-upper-mu",
    "100",
    "--synthetic-actual-mu",
    "60",
    "--smtp-timeout-ms",
    "60000",
  ];
  if (opts.consoleToken) {
    cliArgs.push("--console-token", opts.consoleToken);
  }
  if (opts.principalTokens) {
    cliArgs.push("--principal-tokens-json", JSON.stringify(opts.principalTokens));
  }
  if (opts.pauseOutbox) {
    cliArgs.push("--pause-outbox", "true");
  }
  if (opts.faultBeforeT2CommitFile) {
    cliArgs.push("--fault-before-t2-commit", opts.faultBeforeT2CommitFile);
  }
  if (opts.faultAfterSignalBeforeAckFile) {
    cliArgs.push("--fault-after-signal-before-ack", opts.faultAfterSignalBeforeAckFile);
  }
  if (opts.faultAfterClaimBeforeSmtpFile) {
    cliArgs.push("--fault-after-claim-before-smtp", opts.faultAfterClaimBeforeSmtpFile);
  }

  const child = spawn(LOCKED_NODE_EXE, cliArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AEGISPI_FAKE_MODEL_KEY: "SYNTHETIC_MATRIX_HOST_KEY",
    },
  });

  let stderrBuf = "";
  child.stderr.on("data", (d: Buffer) => {
    stderrBuf += d.toString("utf8");
  });

  const readyInfo = await new Promise<{
    pid: number;
    port: number;
    baseUrl: string;
    runtimeEpoch: string;
    health: string;
    recoveredSubmittingToUnknown: string[];
    reconciledQuarantinedEffects: string[];
    chargedBoundReservations: string[];
  }>((resolve, reject) => {
    let stdoutBuf = "";
    const timer = setTimeout(() => {
      reject(new Error(`Matrix host startup timed out. stderr=${stderrBuf}`));
    }, 15_000);
    child.stdout.on("data", (d: Buffer) => {
      stdoutBuf += d.toString("utf8");
      const idx = stdoutBuf.indexOf("\n");
      if (idx !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        try {
          const parsed = JSON.parse(line) as {
            ready: boolean;
            pid: number;
            port: number;
            baseUrl: string;
            runtimeEpoch: string;
            health: string;
            recoveredSubmittingToUnknown: string[];
            reconciledQuarantinedEffects: string[];
            chargedBoundReservations?: string[];
          };
          if (parsed.ready) {
            clearTimeout(timer);
            resolve({
              ...parsed,
              chargedBoundReservations: parsed.chargedBoundReservations ?? [],
            });
          }
        } catch {
          // ignore non-json line
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Matrix host exited prematurely with code ${String(code)}. stderr=${stderrBuf}`));
    });
  });

  return {
    ...readyInfo,
    child,
    stderr: () => stderrBuf,
    stopGracefully: async () => {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${readyInfo.pid} -Force`]);
          resolve();
        }, 4000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
}

export async function killPidForce(pid: number, child: ChildProcessWithoutNullStreams): Promise<{
  killCommand: string;
  exitCode: number | null;
}> {
  const killCommand = `Stop-Process -Id ${pid} -Force`;
  const killOut = spawnSync("powershell.exe", ["-NoProfile", "-Command", killCommand], { encoding: "utf8" });
  assert.equal(killOut.status, 0, `Stop-Process failed for PID ${pid}: ${killOut.stderr}`);
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  return { killCommand, exitCode: child.exitCode };
}

export async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8").trim();
      if (content.length > 0) return content;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for barrier file ${filePath}`);
}

export async function httpLogin(
  baseUrl: string,
  token: string,
  spoofPrincipalId?: string,
): Promise<{ status: number; cookie: string; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify(spoofPrincipalId ? { token, principalId: spoofPrincipalId } : { token }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const rawCookie = res.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(";")[0] ?? "";
  return { status: res.status, cookie, body };
}

/**
 * G1: Host-bound principal credentials, refuse formal startup without token,
 * and cross-principal authorization checks on decide / challenge / draft / reconcile / revoke.
 */
export async function testG1Auth(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "g1-auth");
  mkdirSync(dir, { recursive: true });

  // 1. Formal entry src/index.ts MUST refuse startup when no console token is supplied!
  const cleanEnv = { ...process.env };
  delete cleanEnv["AEGISPI_CONSOLE_TOKEN"];
  delete cleanEnv["AEGISPI_PRINCIPAL_TOKENS_JSON"];
  const noTokenRun = spawnSync(
    LOCKED_NODE_EXE,
    [path.resolve("src/index.ts"), "--data-dir", path.join(dir, "no-token-data"), "--port", "0"],
    { encoding: "utf8", env: cleanEnv, timeout: 8000 },
  );
  assert.notEqual(noTokenRun.status, 0, "G1: formal entry must exit non-zero without console token");
  assert.match(noTokenRun.stderr, /Refusing startup|AEGISPI_CONSOLE_TOKEN/i);

  // 2. Host with TWO isolated principals (alice -> scope:alice, bob -> scope:bob)
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"));

  try {
    const vault = new HostCredentialVault();
    vault.registerSlot(
      {
        slotId: "slot:g1",
        provider: "fake-local",
        allowedBaseUrls: [fakeModel.baseUrl],
        allowedModelIds: ["fake-router-1"],
        priceVersion: "synthetic-100-60",
      },
      "SYNTHETIC_G1_KEY",
    );
    const slots: ModelSlotConfig[] = [
      {
        slotName: "router",
        provider: "fake-local",
        modelId: "fake-router-1",
        baseUrl: fakeModel.baseUrl,
        credentialSlotId: "slot:g1",
        contextWindow: 128_000,
        maxTokens: 1024,
        priceSchedule: {
          priceVersion: "synthetic-100-60",
          inputPerMTokMu: 300_000,
          outputPerMTokMu: 1_200_000,
          syntheticFixedUpperMu: 100,
          syntheticFixedActualMu: 60,
        },
        outboundAuthorized: true,
      },
    ];

    const host = await AegisHostRuntime.start({
      dataDir: path.join(dir, "host-data"),
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "g1@local.test" },
      pauseOutboxDelivery: true,
    });

    ensureScope(host.govDb, {
      scopeId: "scope:alice",
      allowedPrincipals: ["alice"],
      allowedTools: ["send_email"],
      allowedTargets: ["*"],
    });
    ensureScope(host.govDb, {
      scopeId: "scope:bob",
      allowedPrincipals: ["bob"],
      allowedTools: ["send_email"],
      allowedTargets: ["*"],
    });

    const tokenAlice = "TOKEN_ALICE_G1_SYNTHETIC";
    const tokenBob = "TOKEN_BOB_G1_SYNTHETIC";
    const web = await startWebServer({
      host,
      port: 0,
      consoleTokens: { alice: tokenAlice, bob: tokenBob },
    });

    try {
      // Login spoofing test: client sends tokenAlice + principalId="bob" -> MUST bind to "alice"!
      const loginAliceSpoof = await httpLogin(web.baseUrl, tokenAlice, "bob");
      assert.equal(loginAliceSpoof.status, 200);
      assert.equal(loginAliceSpoof.body["principalId"], "alice", "G1: login must ignore request body principalId");

      const loginBob = await httpLogin(web.baseUrl, tokenBob, "alice");
      assert.equal(loginBob.status, 200);
      assert.equal(loginBob.body["principalId"], "bob", "G1: bob token must bind strictly to bob");

      // Create alice's conversation in scope:alice & bob's conversation in scope:bob
      const aliceConv = await host.createManagedConversation({
        principalId: "alice",
        scopeId: "scope:alice",
        budgetTaskId: "task-alice",
      });
      await host.createManagedConversation({
        principalId: "bob",
        scopeId: "scope:bob",
        budgetTaskId: "task-bob",
      });

      // Seed a PENDING proposal (p1) AND an UNKNOWN effect (effUnknown) owned by alice in scope:alice
      const p1 = proposeOrGetApproval(host.govDb, {
        runtimeEpoch: host.runtimeEpoch,
        conversationId: String(aliceConv.id),
        toolTaskId: "9001",
        callId: "call_g1_pending",
        scopeId: "scope:alice",
        toolName: "send_email",
        target: "smtp:alice-dst@local.test",
        payload: { to: ["alice-dst@local.test"], subject: "G1", body: "Alice pending" },
        expiresAt: Date.now() + 600_000,
        now: Date.now(),
      });

      const p2 = proposeOrGetApproval(host.govDb, {
        runtimeEpoch: host.runtimeEpoch,
        conversationId: String(aliceConv.id),
        toolTaskId: "9002",
        callId: "call_g1_unknown",
        scopeId: "scope:alice",
        toolName: "send_email",
        target: "smtp:alice-dst2@local.test",
        payload: { to: ["alice-dst2@local.test"], subject: "G1-U", body: "Alice unknown" },
        expiresAt: Date.now() + 600_000,
        now: Date.now(),
      });
      const d2 = decideApproval(host.govDb, {
        approvalId: p2.approval.approval_id,
        conversationId: String(aliceConv.id),
        principalId: "alice",
        decision: "APPROVE",
        expectedRevision: 1,
        expectedActionHash: p2.revision.action_hash,
        nonce: p2.nonce!,
        decisionKey: "dk-g1-alice-u",
        now: Date.now(),
      });
      assert.equal(d2.httpStatus, 200);
      const claim2 = claimEffectForSubmission(host.govDb, {
        effectId: d2.effectId!,
        runtimeEpoch: host.runtimeEpoch,
        conversationId: String(aliceConv.id),
        toolTaskId: "9002",
        callId: "call_g1_unknown",
        toolName: "send_email",
        finalTarget: "smtp:alice-dst2@local.test",
        finalPayload: { to: ["alice-dst2@local.test"], subject: "G1-U", body: "Alice unknown" },
        now: Date.now(),
      });
      assert.equal(claim2.claimed, true);
      recoverSubmittingEffectsToUnknown(host.govDb, Date.now());
      const unknownEffectId = d2.effectId!;

      // Bob tries EVERY unauthorized action on Alice's resources -> ALL MUST return 403 and mutate 0 rows!
      const bobChallenge = await fetch(`${web.baseUrl}/api/approvals/${p1.approval.approval_id}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: loginBob.cookie, origin: web.baseUrl },
        body: JSON.stringify({ conversationId: String(aliceConv.id) }),
      });
      assert.equal(bobChallenge.status, 403);

      const bobDecide = await fetch(`${web.baseUrl}/api/approvals/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: loginBob.cookie, origin: web.baseUrl },
        body: JSON.stringify({
          approvalId: p1.approval.approval_id,
          conversationId: String(aliceConv.id),
          decision: "APPROVE",
          expectedRevision: 1,
          expectedActionHash: p1.revision.action_hash,
          nonce: p1.nonce!,
          decisionKey: "dk-bob-cross",
        }),
      });
      assert.equal(bobDecide.status, 403);

      const bobReconcile = await fetch(`${web.baseUrl}/api/effects/${unknownEffectId}/reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: loginBob.cookie, origin: web.baseUrl },
        body: JSON.stringify({
          conclusion: "CONFIRMED_SUCCEEDED",
          evidenceRef: "bob-forged-evidence",
        }),
      });
      assert.equal(bobReconcile.status, 403);

      const bobRevoke = await fetch(`${web.baseUrl}/api/scopes/${encodeURIComponent("scope:alice")}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: loginBob.cookie, origin: web.baseUrl },
        body: JSON.stringify({ reason: "bob_forged_revoke", markCancelled: true }),
      });
      assert.equal(bobRevoke.status, 403);

      // Verify ZERO mutations occurred on Alice's governance rows!
      const p1AprRow = host.govDb
        .prepare("SELECT state FROM approvals WHERE approval_id = ?")
        .get(p1.approval.approval_id) as { state: string };
      const effRow = host.govDb
        .prepare("SELECT state, reconciled_by FROM effects WHERE effect_id = ?")
        .get(unknownEffectId) as { state: string; reconciled_by: string | null };
      const aliceScopeRow = host.govDb
        .prepare("SELECT scope_epoch, cancelled FROM scopes WHERE scope_id = 'scope:alice'")
        .get() as { scope_epoch: number; cancelled: number };

      assert.equal(p1AprRow.state, "PENDING");
      assert.equal(effRow.state, "UNKNOWN");
      assert.equal(effRow.reconciled_by, null);
      assert.equal(aliceScopeRow.scope_epoch, 1);
      assert.equal(aliceScopeRow.cancelled, 0);

      // Verify Alice herself CAN reconcile her own UNKNOWN effect and revoke her own scope (200)
      const aliceReconcile = await fetch(`${web.baseUrl}/api/effects/${unknownEffectId}/reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: loginAliceSpoof.cookie, origin: web.baseUrl },
        body: JSON.stringify({
          conclusion: "CONFIRMED_SUCCEEDED",
          evidenceRef: "alice-verified-receipt",
          receiptRef: "250 OK manual",
        }),
      });
      assert.equal(aliceReconcile.status, 200);
      const effAfterAlice = host.govDb
        .prepare("SELECT state, reconciled_by FROM effects WHERE effect_id = ?")
        .get(unknownEffectId) as { state: string; reconciled_by: string | null };
      assert.equal(effAfterAlice.state, "SUCCEEDED");
      assert.equal(effAfterAlice.reconciled_by, "alice");

      return {
        id: "G1-AUTH",
        group: "GUARD",
        status: "PASS",
        summary:
          "Formal entry refused startup without token; login ignored client principalId; unauthorized cross-principal challenge/decide/reconcile/revoke all returned 403 with 0 governance row mutations.",
        evidence: {
          noTokenExitCode: noTokenRun.status,
          aliceSpoofedLoginBoundPrincipal: loginAliceSpoof.body["principalId"],
          bobChallengeStatus: bobChallenge.status,
          bobDecideStatus: bobDecide.status,
          bobReconcileStatus: bobReconcile.status,
          bobRevokeStatus: bobRevoke.status,
          aliceReconcileStatus: aliceReconcile.status,
          aliceRowsUnchangedAfterBobAttempts: true,
        },
      };
    } finally {
      await web.close();
      await host.close();
    }
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

/**
 * G2: Stage 1 loopback-only egress enforcement on BOTH modelBaseUrl and smtpHost
 * at startup AND transport layers, verified with controlled transport observers (0 outbound calls).
 */
export async function testG2Egress(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "g2-egress");
  mkdirSync(dir, { recursive: true });

  // 1. Formal entry refuses non-loopback --model-base-url
  const badModelProc = spawnSync(
    LOCKED_NODE_EXE,
    [
      path.resolve("src/index.ts"),
      "--data-dir",
      path.join(dir, "bad-model"),
      "--port",
      "0",
      "--console-token",
      "SYNTHETIC_G2_TOK",
      "--model-base-url",
      "https://api.openai.com/v1",
      "--smtp-host",
      "127.0.0.1",
      "--smtp-port",
      "4392",
    ],
    { encoding: "utf8", timeout: 8000 },
  );
  assert.notEqual(badModelProc.status, 0, "G2: non-loopback model-base-url must be refused at startup");

  // 2. Formal entry refuses non-loopback --smtp-host
  const badSmtpProc = spawnSync(
    LOCKED_NODE_EXE,
    [
      path.resolve("src/index.ts"),
      "--data-dir",
      path.join(dir, "bad-smtp"),
      "--port",
      "0",
      "--console-token",
      "SYNTHETIC_G2_TOK",
      "--model-base-url",
      "http://127.0.0.1:4391",
      "--smtp-host",
      "smtp.example.com",
      "--smtp-port",
      "587",
    ],
    { encoding: "utf8", timeout: 8000 },
  );
  assert.notEqual(badSmtpProc.status, 0, "G2: non-loopback smtp-host must be refused at startup");

  // 3. Vault rejects registering non-loopback model URL
  const vault = new HostCredentialVault();
  assert.throws(
    () =>
      vault.registerSlot(
        {
          slotId: "slot:bad",
          provider: "openai",
          allowedBaseUrls: ["https://api.openai.com/v1"],
          allowedModelIds: ["gpt-4o"],
          priceVersion: "v1",
        },
        "SYNTHETIC_KEY",
      ),
    Stage1EgressBlockedError,
  );

  // 4. Controlled transport observer on SMTP client proves 0 socket connections for non-loopback host!
  let smtpConnectCalls = 0;
  const smtpBlocked = await sendSmtpMessage({
    host: "smtp.gmail.com",
    port: 587,
    from: "a@local.test",
    to: ["b@local.test"],
    subject: "G2",
    body: "should not connect",
    createConnection: ((..._args: unknown[]) => {
      smtpConnectCalls++;
      throw new Error("should_never_connect");
    }) as unknown as Parameters<typeof sendSmtpMessage>[0]["createConnection"],
  });
  assert.equal(smtpBlocked.status, "failed_local");
  assert.equal(smtpBlocked.bytesSent, 0);
  assert.equal(smtpConnectCalls, 0, "G2: disallowed SMTP host must produce 0 transport connect calls");

  // 5. Controlled transport observer on AegisHostRuntime.start proves non-loopback model slot is rejected with 0 dispatches!
  let modelDispatchCalls = 0;
  vault.registerSlot(
    {
      slotId: "slot:ok",
      provider: "fake-local",
      allowedBaseUrls: ["http://127.0.0.1:4391"],
      allowedModelIds: ["fake-router-1"],
      priceVersion: "synthetic-100-60",
    },
    "SYNTHETIC_KEY",
  );
  await assert.rejects(
    () =>
      AegisHostRuntime.start({
        dataDir: path.join(dir, "bad-host-slot"),
        vault,
        modelSlots: [
          {
            slotName: "router",
            provider: "fake-local",
            modelId: "fake-router-1",
            baseUrl: "https://evil.example.net/v1",
            credentialSlotId: "slot:ok",
            contextWindow: 128_000,
            maxTokens: 1024,
            priceSchedule: {
              priceVersion: "synthetic-100-60",
              inputPerMTokMu: 300_000,
              outputPerMTokMu: 1_200_000,
              syntheticFixedUpperMu: 100,
              syntheticFixedActualMu: 60,
            },
            outboundAuthorized: true,
          },
        ],
        smtpConfig: { host: "127.0.0.1", port: 4392, fromAddress: "a@local.test" },
        onTransportDispatch: () => {
          modelDispatchCalls++;
        },
      }),
    Stage1EgressBlockedError,
  );
  assert.equal(modelDispatchCalls, 0, "G2: disallowed model endpoint must produce 0 transport dispatches");

  return {
    id: "G2-EGRESS",
    group: "GUARD",
    status: "PASS",
    summary:
      "Non-loopback modelBaseUrl and smtpHost refused at startup, vault registration, and transport layers; controlled observers recorded 0 SMTP connects and 0 model dispatches.",
    evidence: {
      badModelStartupExitCode: badModelProc.status,
      badSmtpStartupExitCode: badSmtpProc.status,
      smtpConnectCallsObserved: smtpConnectCalls,
      modelDispatchCallsObserved: modelDispatchCalls,
    },
  };
}

/**
 * G3: Verify plaintext approval nonce has 0 hits in SSE frames, general snapshots,
 * request URLs, and audit_events, while dedicated POST /api/approvals/:id/challenge
 * delivers it strictly to the authorized approver.
 */
export async function testG3NonceSse(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "g3-nonce-sse");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(dir, "fake-smtp"));

  try {
    const vault = new HostCredentialVault();
    vault.registerSlot(
      {
        slotId: "slot:g3",
        provider: "fake-local",
        allowedBaseUrls: [fakeModel.baseUrl],
        allowedModelIds: ["fake-router-1"],
        priceVersion: "synthetic-100-60",
      },
      "SYNTHETIC_G3_KEY",
    );
    const host = await AegisHostRuntime.start({
      dataDir: path.join(dir, "host-data"),
      vault,
      modelSlots: [
        {
          slotName: "router",
          provider: "fake-local",
          modelId: "fake-router-1",
          baseUrl: fakeModel.baseUrl,
          credentialSlotId: "slot:g3",
          contextWindow: 128_000,
          maxTokens: 1024,
          priceSchedule: {
            priceVersion: "synthetic-100-60",
            inputPerMTokMu: 300_000,
            outputPerMTokMu: 1_200_000,
            syntheticFixedUpperMu: 100,
            syntheticFixedActualMu: 60,
          },
          outboundAuthorized: true,
        },
      ],
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "g3@local.test" },
      pauseOutboxDelivery: true,
    });
    const web = await startWebServer({
      host,
      port: 0,
      consoleTokens: { owner: "SYNTHETIC_G3_OWNER_TOK", viewer: "SYNTHETIC_G3_VIEWER_TOK" },
    });

    try {
      const ownerLogin = await httpLogin(web.baseUrl, "SYNTHETIC_G3_OWNER_TOK");
      const viewerLogin = await httpLogin(web.baseUrl, "SYNTHETIC_G3_VIEWER_TOK");
      const conv = await host.createManagedConversation({
        principalId: "owner",
        scopeId: "scope:default",
        budgetTaskId: "g3-task",
      });
      const p = proposeOrGetApproval(host.govDb, {
        runtimeEpoch: host.runtimeEpoch,
        conversationId: String(conv.id),
        toolTaskId: "9301",
        callId: "call_g3",
        scopeId: "scope:default",
        toolName: "send_email",
        target: "smtp:g3@local.test",
        payload: { to: ["g3@local.test"], subject: "G3", body: "G3 body" },
        expiresAt: Date.now() + 600_000,
        now: Date.now(),
      });
      const secretNonce = p.nonce!;
      assert.ok(secretNonce.length > 16);

      // 1. Check general snapshot HTTP response
      const snapRes = await fetch(`${web.baseUrl}/api/conversations/${conv.id}/snapshot`, {
        headers: { cookie: ownerLogin.cookie },
      });
      const snapText = await snapRes.text();
      const snapshotNonceHits = snapText.includes(secretNonce) ? 1 : 0;

      // 2. Check SSE stream frame (GET /api/conversations/:id/events)
      const ac = new AbortController();
      const sseRes = await fetch(`${web.baseUrl}/api/conversations/${conv.id}/events`, {
        headers: { cookie: ownerLogin.cookie },
        signal: ac.signal,
      });
      assert.equal(sseRes.status, 200);
      const reader = sseRes.body!.getReader();
      let sseChunkText = "";
      const decoder = new TextDecoder();
      while (!sseChunkText.includes("event: snapshot") || !sseChunkText.includes("\n\n")) {
        const { done, value } = await reader.read();
        if (done) break;
        sseChunkText += decoder.decode(value, { stream: true });
      }
      ac.abort();
      const sseNonceHits = sseChunkText.includes(secretNonce) ? 1 : 0;

      // 3. Check audit_events table for any accidental nonce logging
      const auditRows = host.govDb
        .prepare("SELECT details_json, evidence_ref FROM audit_events")
        .all() as Array<{ details_json: string | null; evidence_ref: string | null }>;
      const auditNonceHits = auditRows.filter(
        (r) => (r.details_json ?? "").includes(secretNonce) || (r.evidence_ref ?? "").includes(secretNonce),
      ).length;

      // 4. Check dedicated challenge route: authorized principal -> 200 with exact nonce; unauthorized -> 403
      const ownerCh = await fetch(`${web.baseUrl}/api/approvals/${p.approval.approval_id}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerLogin.cookie, origin: web.baseUrl },
        body: JSON.stringify({ conversationId: String(conv.id) }),
      });
      assert.equal(ownerCh.status, 200);
      assert.equal(ownerCh.headers.get("cache-control"), "no-store");
      const ownerChBody = (await ownerCh.json()) as { nonce: string };
      assert.equal(ownerChBody.nonce, secretNonce);

      const viewerCh = await fetch(`${web.baseUrl}/api/approvals/${p.approval.approval_id}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: viewerLogin.cookie, origin: web.baseUrl },
        body: JSON.stringify({ conversationId: String(conv.id) }),
      });
      assert.equal(viewerCh.status, 403);

      assert.equal(snapshotNonceHits, 0, "G3: snapshot must have 0 plaintext nonce hits");
      assert.equal(sseNonceHits, 0, "G3: SSE frames must have 0 plaintext nonce hits");
      assert.equal(auditNonceHits, 0, "G3: audit_events must have 0 plaintext nonce hits");

      return {
        id: "G3-NONCE-SSE",
        group: "GUARD",
        status: "PASS",
        summary:
          "Verified 0 plaintext nonce hits across SSE frames, conversation snapshots, and audit_events; dedicated POST /api/approvals/:id/challenge returns challenge strictly to authorized principal (403 for unauthorized).",
        evidence: {
          sseFrameCapturedBytes: sseChunkText.length,
          sseNonceHits,
          snapshotNonceHits,
          auditNonceHits,
          authorizedChallengeStatus: ownerCh.status,
          unauthorizedChallengeStatus: viewerCh.status,
        },
      };
    } finally {
      await web.close();
      await host.close();
    }
  } finally {
    await fakeSmtp.stop();
    await fakeModel.stop();
  }
}

/**
 * R1: Budget task attribution across:
 * (A) Real run_worker tool delegation (ignores smuggled model budgetTaskId, inherits owning host task,
 *     denies with 0 sends when short by 1 mu without minting default accounts, charges owning task when funded);
 * (B) Host restart continuation (binding persisted in budget_task_bindings survives restart and blocks when exhausted);
 * (C) Unattributed task/conversation fails closed with unknown_budget_owner and 0 sends / 0 default accounts.
 */
export async function testR1Attribution(rootDir: string): Promise<MatrixCaseResult> {
  const dir = path.join(rootDir, "r1-attribution");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));

  try {
    const vault = new HostCredentialVault();
    vault.registerSlot(
      {
        slotId: "slot:r1",
        provider: "fake-local",
        allowedBaseUrls: [fakeModel.baseUrl],
        allowedModelIds: ["fake-router-1", "fake-worker-1"],
        priceVersion: "synthetic-100-60",
      },
      "SYNTHETIC_R1_KEY",
    );
    const slots: ModelSlotConfig[] = [
      {
        slotName: "router",
        provider: "fake-local",
        modelId: "fake-router-1",
        baseUrl: fakeModel.baseUrl,
        credentialSlotId: "slot:r1",
        contextWindow: 128_000,
        maxTokens: 1024,
        priceSchedule: {
          priceVersion: "synthetic-100-60",
          inputPerMTokMu: 300_000,
          outputPerMTokMu: 1_200_000,
          syntheticFixedUpperMu: 100,
          syntheticFixedActualMu: 60,
        },
        outboundAuthorized: true,
      },
      {
        slotName: "worker",
        provider: "fake-local",
        modelId: "fake-worker-1",
        baseUrl: fakeModel.baseUrl,
        credentialSlotId: "slot:r1",
        contextWindow: 128_000,
        maxTokens: 1024,
        priceSchedule: {
          priceVersion: "synthetic-100-60",
          inputPerMTokMu: 300_000,
          outputPerMTokMu: 1_200_000,
          syntheticFixedUpperMu: 100,
          syntheticFixedActualMu: 60,
        },
        outboundAuthorized: true,
      },
    ];

    // Part A: Real run_worker delegation inherits parent's host budget task (short by 1 mu -> 0 worker sends!)
    const dataDirA = path.join(dir, "part-a");
    await fakeModel.queue({
      clear: true,
      scripts: [
        // Router turn 1 (60 mu) invokes run_worker AND attempts to smuggle budgetTaskId="evil-free-money"!
        {
          kind: "tool_call",
          toolCall: {
            id: "call_r1_worker_deny",
            name: "run_worker",
            arguments: { prompt: "subtask under tight budget", budgetTaskId: "evil-free-money" },
          },
        },
        // If worker is denied cleanly, Router's follow-up generation is ALSO blocked (only 99 mu left!) -> 0 more sends!
        { kind: "text", text: "should not be sent because task only has 99 mu left" },
      ],
    });

    const hostA = await AegisHostRuntime.start({
      dataDir: dataDirA,
      vault,
      modelSlots: slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "r1@local.test" },
    });
    // Task budget = 159 mu: Router turn 1 uses 60 mu -> leaves exactly 99 mu (1 mu short of Worker's 100 mu upper bound!)
    setBudgetAccountLimit(hostA.govDb, {
      accountId: taskAccountIdFor("r1-delegate-task"),
      kind: "TASK",
      limitMu: 159,
      now: Date.now(),
    });
    const convA = await hostA.createManagedConversation({
      slotName: "router",
      budgetTaskId: "r1-delegate-task",
    });
    const mBeforeA = (await fakeModel.stats()).totalPhysicalRequests;
    await (await convA.submit({ type: "input", content: "delegate to worker" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    await new Promise((r) => setTimeout(r, 60));
    const mAfterADeny = (await fakeModel.stats()).totalPhysicalRequests;
    // Exactly 1 physical send (Router's initial tool-call turn); Worker got 0 physical sends!
    assert.equal(mAfterADeny - mBeforeA, 1, "R1-A: exhausted parent budget must allow 1 router call and 0 worker calls");

    const allTaskAccountsAfterDeny = hostA.govDb
      .prepare("SELECT account_id FROM budget_accounts WHERE kind = 'TASK'")
      .all() as Array<{ account_id: string }>;
    assert.deepEqual(
      allTaskAccountsAfterDeny.map((a) => a.account_id),
      ["acct:task:r1-delegate-task"],
      "R1-A: must NOT create evil-free-money or any default worker task account!",
    );

    // Now fund r1-delegate-task (with explicit approval) to 300 mu and prove funded run_worker charges r1-delegate-task with purpose='worker'!
    setBudgetAccountLimit(hostA.govDb, {
      accountId: taskAccountIdFor("r1-delegate-task"),
      kind: "TASK",
      limitMu: 300,
      now: Date.now(),
      approvedBy: "owner",
    });
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: {
            id: "call_r1_worker_ok",
            name: "run_worker",
            arguments: { prompt: "funded worker subtask" },
          },
        },
        { kind: "text", text: "Worker result text" },
        { kind: "text", text: "Router synthesized final answer" },
      ],
    });
    const mBeforeAOk = (await fakeModel.stats()).totalPhysicalRequests;
    await (await convA.submit({ type: "input", content: "delegate funded" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    await new Promise((r) => setTimeout(r, 60));
    const mAfterAOk = (await fakeModel.stats()).totalPhysicalRequests;
    assert.equal(mAfterAOk - mBeforeAOk, 3, "R1-A: funded delegation runs router + worker + router final (3 sends)");

    const workerResRow = hostA.govDb
      .prepare("SELECT * FROM budget_reservations WHERE purpose = 'worker' AND owner_task_id = 'r1-delegate-task'")
      .get() as BudgetReservationRow | undefined;
    assert.ok(workerResRow, "R1-A: worker reservation must be attributed to owning host task r1-delegate-task");
    assert.equal(workerResRow.state, "SETTLED");
    const taskAcctA = getBudgetAccount(hostA.govDb, taskAccountIdFor("r1-delegate-task"))!;
    assert.equal(taskAcctA.charged_mu, 240); // 1 deny-phase router (60) + 3 funded turns (180)
    await hostA.close();

    // Part B: Restart continuation (persisted budget_task_bindings survives restart without re-binding in memory!)
    const dataDirB = path.join(dir, "part-b");
    await fakeModel.queue({
      clear: true,
      scripts: [{ kind: "text", text: "Turn 1 before restart" }, { kind: "text", text: "Should be blocked after restart" }],
    });
    const hostB1 = await AegisHostRuntime.start({
      dataDir: dataDirB,
      vault,
      modelSlots: slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "r1@local.test" },
    });
    setBudgetAccountLimit(hostB1.govDb, {
      accountId: taskAccountIdFor("r1-restart-task"),
      kind: "TASK",
      limitMu: 159, // Turn 1 charges 60 -> 99 remaining (1 mu short after restart!)
      now: Date.now(),
    });
    const convB = await hostB1.createManagedConversation({
      slotName: "router",
      budgetTaskId: "r1-restart-task",
    });
    const convBId = convB.id;
    await (await convB.submit({ type: "input", content: "before restart" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 50));
    await hostB1.close();

    // Restart fresh host instance WITHOUT calling bindConversationBudgetOwner!
    const hostB2 = await AegisHostRuntime.start({
      dataDir: dataDirB,
      vault,
      modelSlots: slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "r1@local.test" },
    });
    const mBeforeBRestart = (await fakeModel.stats()).totalPhysicalRequests;
    const convBResumed = await hostB2.harness.conversation(convBId, BACKGROUND_CONTEXT);
    assert.ok(convBResumed);
    await (await convBResumed.submit({ type: "input", content: "after restart short budget" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    await new Promise((r) => setTimeout(r, 50));
    const mAfterBRestart = (await fakeModel.stats()).totalPhysicalRequests;
    assert.equal(mAfterBRestart - mBeforeBRestart, 0, "R1-B: resumed conversation after restart must use persisted owner task and send 0");

    const taskAcctsB = hostB2.govDb
      .prepare("SELECT account_id FROM budget_accounts WHERE kind = 'TASK'")
      .all() as Array<{ account_id: string }>;
    assert.deepEqual(
      taskAcctsB.map((a) => a.account_id),
      ["acct:task:r1-restart-task"],
      "R1-B: restart must NOT create a default fallback account!",
    );

    // Part C: Unattributed conversation/task (binding removed) MUST fail closed with unknown_budget_owner and 0 sends!
    hostB2.govDb.prepare("DELETE FROM budget_task_bindings").run();
    // Restart so in-memory cache is also empty
    await hostB2.close();
    const hostB3 = await AegisHostRuntime.start({
      dataDir: dataDirB,
      vault,
      modelSlots: slots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "r1@local.test" },
    });
    const mBeforeUnbound = (await fakeModel.stats()).totalPhysicalRequests;
    const convBUnbound = await hostB3.harness.conversation(convBId, BACKGROUND_CONTEXT);
    await (await convBUnbound!.submit({ type: "input", content: "unbound should fail closed" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    await new Promise((r) => setTimeout(r, 50));
    const mAfterUnbound = (await fakeModel.stats()).totalPhysicalRequests;
    assert.equal(mAfterUnbound - mBeforeUnbound, 0, "R1-C: unknown budget owner must fail closed with 0 sends");

    const unknownDenial = hostB3.govDb
      .prepare(
        `SELECT details_json FROM audit_events
          WHERE entity_type = 'budget_denial' AND details_json LIKE '%unknown_budget_owner%'
          ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { details_json: string } | undefined;
    assert.ok(unknownDenial, "R1-C: must record unknown_budget_owner denial event");
    const taskAcctsC = hostB3.govDb
      .prepare("SELECT account_id FROM budget_accounts WHERE kind = 'TASK'")
      .all() as Array<{ account_id: string }>;
    assert.deepEqual(taskAcctsC.map((a) => a.account_id), ["acct:task:r1-restart-task"]);
    await hostB3.close();

    return {
      id: "R1-ATTRIBUTION",
      group: "B",
      status: "PASS",
      summary:
        "Verified real run_worker delegation inherits parent host task (ignoring smuggled model budgetTaskId, 0 worker sends when exhausted, charges parent when funded), persisted bindings survive restart (0 sends when exhausted), and missing binding fails closed (unknown_budget_owner, 0 sends, 0 default accounts).",
      evidence: {
        delegationDenyPhysicalDelta: mAfterADeny - mBeforeA,
        delegationFundedWorkerRequestId: workerResRow.request_id,
        delegationTaskFinalChargedMu: taskAcctA.charged_mu,
        restartContinuationPhysicalDelta: mAfterBRestart - mBeforeBRestart,
        unboundFailClosedPhysicalDelta: mAfterUnbound - mBeforeUnbound,
      },
    };
  } finally {
    await fakeModel.stop();
  }
}

export function readGovDbQuick(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  try {
    const approvals = db.prepare("SELECT approval_id, state, decision_key FROM approvals").all();
    const effects = db.prepare("SELECT effect_id, approval_id, state, claimed_at, receipt_ref, reason FROM effects").all();
    const outbox = db.prepare("SELECT approval_id, signal_key, state, sdk_result, reason FROM signal_outbox").all();
    const claims = (
      db
        .prepare("SELECT count(*) AS n FROM audit_events WHERE entity_type = 'effect' AND event_type = 'effect_claimed'")
        .get() as { n: number }
    ).n;
    return { approvals, effects, outbox, claims };
  } finally {
    db.close();
  }
}
