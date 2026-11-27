import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sendSmtpMessage } from "../../src/capabilities/mail/smtp-client.ts";
import {
  getOrLockConversationSkillSet,
  readSkillDisclosure,
  registerSkillVersion,
  resolveVerifiedSkillScript,
  revokeSkill,
  setSkillActiveVersion,
} from "../../src/capabilities/skills/store.ts";
import {
  createRoutineWithGovernance,
  parseNaturalLanguageRoutine,
  pauseRoutine,
  recordRoutineTriggerCompletion,
} from "../../src/capabilities/timers/routines.ts";
import {
  decideApproval,
  ensureScope,
  fetchAuthorizedApprovalChallenge,
  proposeOrGetApproval,
  saveDraftRevision,
} from "../../src/governance/approvals.ts";
import { setBudgetAccountLimit, taskAccountIdFor } from "../../src/governance/budget.ts";
import {
  HostCredentialVault,
  validateModelPriceScheduleForEndpoint,
} from "../../src/governance/credentials.ts";
import { countSuccessfulClaimsForEffect, revokeOrCancelScope } from "../../src/governance/effects.ts";
import { scanBufferInMemory } from "../../src/governance/leak-scanner.ts";
import {
  approveMcpToolDefinition,
  approveStoredMcpToolPin,
  getMcpToolPin,
  inspectStoredMcpToolPin,
  pinMcpServerBinary,
  revokeMcpTool,
  sha256File,
} from "../../src/governance/mcp-pin.ts";
import {
  grantModelDisclosure,
  grantSourceRead,
  recordConversationSource,
  revokeSourceReadGrant,
} from "../../src/governance/policy.ts";
import {
  evaluateGithubWritePolicy,
  listRememberedRules,
  revokeRememberedRule,
  upgradeStage2ScopeAllowedTools,
  validateEmailEnvelopeSingleLine,
  validateEmailRecipientsAllowlist,
  validateStage2PlainTextEmail,
  type GithubWriteAllowlistEntry,
} from "../../src/governance/rules.ts";
import { AegisHostRuntime } from "../../src/runtime/harness.ts";
import { GitHubMcpBridge } from "../../src/runtime/mcp-bridge.ts";
import type { ModelSlotConfig } from "../../src/runtime/models.ts";
import { startWebServer } from "../../src/web/server.ts";
import {
  LOCKED_NODE_EXE,
  startFakeConnectProxy,
  startFakeModelServer,
  startFakeSmtpServer,
} from "../fakes/client.ts";
import { parseWeek2CliArgs, rmDirWithRetry } from "../week2/cli-helpers.ts";

async function startTlsFakeSmtp(opts: {
  dataDir: string;
  tlsCn: string;
  authUser: string;
  authPass: string;
}): Promise<{
  pid: number;
  host: string;
  smtpPort: number;
  controlPort: number;
  certPem: string;
  stats: () => Promise<{ totalReceived: number; records: Array<{ seq: number; rawData: string }> }>;
  stop: () => Promise<void>;
}> {
  const scriptPath = path.resolve("tests/fakes/fake-smtp-server.ts");
  const child = spawn(
    LOCKED_NODE_EXE,
    [
      scriptPath,
      "--data-dir",
      opts.dataDir,
      "--tls-cn",
      opts.tlsCn,
      "--auth-user",
      opts.authUser,
      "--auth-pass",
      opts.authPass,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const ready = await new Promise<{
    pid: number;
    host: string;
    smtpPort: number;
    controlPort: number;
    certPath: string;
  }>((resolve, reject) => {
    let out = "";
    let err = "";
    const t = setTimeout(() => reject(new Error(`TLS fake SMTP start timeout: ${err}`)), 10_000);
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      const idx = out.indexOf("\n");
      if (idx !== -1) {
        clearTimeout(t);
        resolve(JSON.parse(out.slice(0, idx).trim()));
      }
    });
  });
  return {
    pid: ready.pid,
    host: ready.host,
    smtpPort: ready.smtpPort,
    controlPort: ready.controlPort,
    certPem: readFileSync(ready.certPath, "utf8"),
    stats: async () => {
      const r = await fetch(`http://${ready.host}:${ready.controlPort}/__control/stats`);
      return (await r.json()) as { totalReceived: number; records: Array<{ seq: number; rawData: string }> };
    },
    stop: async () => {
      await fetch(`http://${ready.host}:${ready.controlPort}/__control/shutdown`, { method: "POST" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}

function readMcpJsonl(logPath: string): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitFor<T>(fn: () => Promise<T> | T, pred: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  let last: T;
  for (;;) {
    last = await fn();
    if (pred(last)) return last;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}

export async function runStage2P0Core(opts?: { dataDir?: string; evidenceDir?: string }) {
  const runId = `s2_p0_${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(opts?.dataDir ?? `.tmp-stage2-p0-${Date.now()}`);
  const evidenceDir = path.resolve(opts?.evidenceDir ?? path.join(rootDir, "evidence"));
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const fakeModel = await startFakeModelServer(path.join(rootDir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(rootDir, "fake-smtp"), { mode: "normal" });
  const tlsSmtpSecret = `SYNTH_TLS_SMTP_PASS_${runId}`;
  const tlsSmtp = await startTlsFakeSmtp({
    dataDir: path.join(rootDir, "fake-tls-smtp"),
    tlsCn: "smtp.stage2.local.test",
    authUser: "sender@stage2.local.test",
    authPass: tlsSmtpSecret,
  });
  const connectProxy = await startFakeConnectProxy(path.join(rootDir, "fake-proxy"));

  const routerKey = `SYNTH_S2_ROUTER_KEY_${runId}`;
  const workerKey = `SYNTH_S2_WORKER_KEY_${runId}`;
  const mcpPat = `SYNTH_S2_MCP_PAT_${runId}`;
  const consoleToken = `SYNTH_S2_CONSOLE_TOKEN_${runId}`;

  const mcpCopyDir = path.join(rootDir, "mcp-bin");
  mkdirSync(mcpCopyDir, { recursive: true });
  const mcpScriptCopy = path.join(mcpCopyDir, "fake-github-mcp-server.ts");
  copyFileSync(path.resolve("tests/fakes/fake-github-mcp-server.ts"), mcpScriptCopy);
  // Adjust relative import path because copy lives in rootDir/mcp-bin
  const origSrc = readFileSync(mcpScriptCopy, "utf8");
  const absScannerImport = path.resolve("src/governance/leak-scanner.ts").replace(/\\/g, "/");
  writeFileSync(
    mcpScriptCopy,
    origSrc.replace("../../src/governance/leak-scanner.ts", `file:///${absScannerImport}`),
    "utf8",
  );
  const mcpShaInitial = sha256File(mcpScriptCopy);
  const mcpLogPath = path.join(rootDir, "fake-mcp", "mcp-calls.jsonl");
  const tamperFlagPath = path.join(rootDir, "fake-mcp", "tamper.flag");
  const dropReadFlagPath = path.join(rootDir, "fake-mcp", "drop-read.flag");
  const notifyFlagPath = path.join(rootDir, "fake-mcp", "notify.flag");
  const echoSecretFlagPath = path.join(rootDir, "fake-mcp", "echo-secret.flag");
  mkdirSync(path.dirname(mcpLogPath), { recursive: true });

  const githubWriteAllowlist: GithubWriteAllowlistEntry[] = [
    {
      repoId: "NorthAdb/aegis-stage2-test",
      operations: ["create_or_update_file"],
      allowedRefs: ["refs/heads/stage2-test"],
      confirmedNonProtectedRefs: ["refs/heads/stage2-test"],
      allowedPaths: ["docs/status.md", "notes/"],
      tier: 0,
    },
    {
      repoId: "external-org/collab-repo",
      operations: ["create_or_update_file"],
      allowedRefs: ["refs/heads/pr-draft"],
      allowedPaths: ["README.md"],
      tier: 2,
    },
  ];

  const evidence: Record<string, unknown> = {
    runId,
    executedAt: new Date().toISOString(),
  };

  let host: AegisHostRuntime | null = null;
  let bridge: GitHubMcpBridge | null = null;

  try {
    // =========================================================================
    // 1. Direct & CONNECT Tunneled Verified TLS SMTP + Plain-Text Validation
    // =========================================================================
    const plainRejectCc = validateStage2PlainTextEmail({
      to: ["a@test.local"],
      cc: ["b@test.local"],
      subject: "test",
      body: "hi",
    });
    assert.equal(plainRejectCc.ok, false);
    const plainRejectAttach = validateStage2PlainTextEmail({
      to: ["a@test.local"],
      subject: "test",
      body: "hi",
      attachmentDigests: [{ name: "x.pdf", sha256: "abc", sizeBytes: 10 }],
    });
    assert.equal(plainRejectAttach.ok, false);

    const directTlsRes = await sendSmtpMessage({
      host: tlsSmtp.host,
      port: tlsSmtp.smtpPort,
      from: "sender@stage2.local.test",
      to: ["rcpt@stage2.local.test"],
      subject: "Stage 2 Direct TLS SMTP",
      body: "Direct verified TLS body.",
      egressPolicy: { stage: 2 },
      tlsMode: "direct_tls",
      servername: "smtp.stage2.local.test",
      caPem: tlsSmtp.certPem,
      auth: { username: "sender@stage2.local.test", password: tlsSmtpSecret },
    });
    assert.equal(directTlsRes.status, "succeeded", `Direct TLS SMTP failed: ${directTlsRes.reason}`);
    assert.equal(directTlsRes.tlsVerified, true);

    const tunnelTlsRes = await sendSmtpMessage({
      host: tlsSmtp.host,
      port: tlsSmtp.smtpPort,
      from: "sender@stage2.local.test",
      to: ["rcpt@stage2.local.test"],
      subject: "Stage 2 CONNECT Tunnel TLS SMTP",
      body: "Tunneled verified TLS body.",
      egressPolicy: { stage: 2 },
      tlsMode: "direct_tls",
      servername: "smtp.stage2.local.test",
      caPem: tlsSmtp.certPem,
      proxy: { host: connectProxy.host, port: connectProxy.proxyPort },
      auth: { username: "sender@stage2.local.test", password: tlsSmtpSecret },
    });
    assert.equal(tunnelTlsRes.status, "succeeded", `CONNECT TLS SMTP failed: ${tunnelTlsRes.reason}`);
    assert.equal(tunnelTlsRes.tlsVerified, true);

    // Negative: wrong servername MUST fail TLS verification BEFORE auth/send!
    const badCertRes = await sendSmtpMessage({
      host: tlsSmtp.host,
      port: tlsSmtp.smtpPort,
      from: "sender@stage2.local.test",
      to: ["rcpt@stage2.local.test"],
      subject: "Should fail TLS",
      body: "Never sent",
      egressPolicy: { stage: 2 },
      tlsMode: "direct_tls",
      servername: "wrong.smtp.test",
      caPem: tlsSmtp.certPem,
      auth: { username: "sender@stage2.local.test", password: tlsSmtpSecret },
    });
    assert.equal(badCertRes.status, "failed_local");
    assert.equal(badCertRes.reason?.includes(tlsSmtpSecret), false, "SMTP secret must NEVER appear in error reason");
    assert.equal((await tlsSmtp.stats()).totalReceived, 2);

    evidence["smtpTls"] = {
      directTlsOk: directTlsRes.status === "succeeded",
      connectTunnelTlsOk: tunnelTlsRes.status === "succeeded",
      badHostnameRejectedBeforeSend: badCertRes.status === "failed_local",
      fakeTlsSmtpTotalReceived: (await tlsSmtp.stats()).totalReceived,
      plainTextGuardRejectedCcAndAttachments: !plainRejectCc.ok && !plainRejectAttach.ok,
    };

    // =========================================================================
    // 2. Boot Stage 2 Host with Token-Based Budget Estimation, Skills, Routines & MCP
    // =========================================================================
    const hostDataDir = path.join(rootDir, "host-data");
    const vault = new HostCredentialVault();
    const deepSeekBaseUrl = "https://api.deepseek.com";
    const egressPolicy = { stage: 2 as const, allowedRemoteModelHosts: [new URL(deepSeekBaseUrl).hostname] };
    const fetchDeepSeekFixture: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.origin, deepSeekBaseUrl);
      assert.equal(url.pathname, "/chat/completions");
      return fetch(new URL(url.pathname, fakeModel.baseUrl), init);
    };
    const tokenPriceSchedule = {
      priceVersion: "deepseek-flash-v4.1-peak-2026-11",
      provider: "deepseek",
      modelId: "deepseek-flash",
      boundContractVersion: "deepseek-flash-v4.1-2026-11",
      inputPerMTokMu: 300_000,
      outputPerMTokMu: 1_200_000,
      cacheReadPerMTokMu: 6_000,
      allowTokenBoundEstimation: true,
    };
    vault.registerSlot(
      {
        slotId: "slot:model-router",
        provider: "deepseek",
        allowedBaseUrls: [deepSeekBaseUrl],
        allowedModelIds: ["deepseek-flash"],
        priceVersion: tokenPriceSchedule.priceVersion,
      },
      routerKey,
      egressPolicy,
    );
    vault.registerSlot(
      {
        slotId: "slot:model-worker",
        provider: "deepseek",
        allowedBaseUrls: [deepSeekBaseUrl],
        allowedModelIds: ["deepseek-flash"],
        priceVersion: tokenPriceSchedule.priceVersion,
      },
      workerKey,
      egressPolicy,
    );

    const mcpArgs = [
      mcpScriptCopy,
      "--log-path",
      mcpLogPath,
      "--tamper-flag-path",
      tamperFlagPath,
      "--drop-read-flag-path",
      dropReadFlagPath,
      "--notify-flag-path",
      notifyFlagPath,
      "--echo-secret-flag-path",
      echoSecretFlagPath,
      "--allow-write",
      "true",
    ];
    vault.registerConnectorSlot({
      slotId: "slot:github-mcp-pat",
      kind: "github_mcp",
      target: "github-s2",
      secretValue: mcpPat,
      githubMcpBinding: {
        serverId: "github-s2",
        command: LOCKED_NODE_EXE,
        args: mcpArgs,
        executablePath: mcpScriptCopy,
        executableSha256: mcpShaInitial,
        readOnlyRequired: false,
      },
    });

    const modelSlots: ModelSlotConfig[] = [
      {
        slotName: "router",
        provider: "deepseek",
        modelId: "deepseek-flash",
        baseUrl: deepSeekBaseUrl,
        credentialSlotId: "slot:model-router",
        contextWindow: 1_000_000,
        maxTokens: 1024,
        priceSchedule: tokenPriceSchedule,
        outboundAuthorized: true,
      },
      {
        slotName: "worker",
        provider: "deepseek",
        modelId: "deepseek-flash",
        baseUrl: deepSeekBaseUrl,
        credentialSlotId: "slot:model-worker",
        contextWindow: 1_000_000,
        maxTokens: 1024,
        priceSchedule: tokenPriceSchedule,
        outboundAuthorized: true,
      },
    ];

    let fixedNow = Date.now();
    const observedStreamPartials: string[] = [];

    host = await AegisHostRuntime.start({
      dataDir: hostDataDir,
      vault,
      modelSlots,
      smtpConfig: {
        host: fakeSmtp.host,
        port: fakeSmtp.smtpPort,
        fromAddress: "owner@local.test",
      },
      egressPolicy,
      fetchImpl: fetchDeepSeekFixture,
      strictPlainTextEmail: true,
      githubWriteAllowlist,
      skillsEnabled: true,
      routinesEnabled: true,
      routinePollIntervalMs: 60_000,
      githubMcpBridge: () => bridge,
      now: () => fixedNow,
      beforeResume: async (readyHost) => {
        grantModelDisclosure(readyHost.govDb, {
          principalId: "owner",
          scopeId: "scope:default",
          sourceType: "*",
          sourceId: "*",
          provider: "deepseek",
          modelId: "*",
          baseUrl: deepSeekBaseUrl,
          slotName: "*",
          now: fixedNow,
        });
        grantSourceRead(readyHost.govDb, {
          principalId: "owner",
          scopeId: "scope:default",
          sourceType: "github_mcp",
          resourceId: "github:NorthAdb/project-helios",
          operations: ["read_file"],
          constraints: { allowedRefs: ["refs/heads/main"], allowedPaths: ["README.md"] },
          now: fixedNow,
        });
        pinMcpServerBinary(readyHost.govDb, {
          serverId: "github-s2",
          executablePath: mcpScriptCopy,
          executableSha256: mcpShaInitial,
          command: LOCKED_NODE_EXE,
          args: mcpArgs,
          readOnlyMode: false,
          approvedBy: "owner",
          now: fixedNow,
        });
        approveMcpToolDefinition(readyHost.govDb, {
          serverId: "github-s2",
          def: {
            name: "get_file_contents",
            description: "Read a file from an approved read-only GitHub repository.",
            inputSchema: {
              type: "object",
              properties: { repo: { type: "string" }, ref: { type: "string" }, path: { type: "string" } },
              required: ["repo", "ref", "path"],
            },
          },
          now: fixedNow,
        });
        approveMcpToolDefinition(readyHost.govDb, {
          serverId: "github-s2",
          def: {
            name: "create_or_update_file",
            description: "Create or update a file in an allowlisted GitHub repository branch.",
            inputSchema: {
              type: "object",
              properties: {
                repo: { type: "string" },
                ref: { type: "string" },
                branch: { type: "string" },
                path: { type: "string" },
                content: { type: "string" },
                message: { type: "string" },
              },
              required: ["repo", "path", "content", "message"],
            },
          },
          now: fixedNow,
        });
        bridge = new GitHubMcpBridge({
          serverId: "github-s2",
          command: LOCKED_NODE_EXE,
          args: mcpArgs,
          pinnedArtifactPath: mcpScriptCopy,
          credentialSlotId: "slot:github-mcp-pat",
          stage: 2,
          govDb: readyHost.govDb,
          vault,
          now: () => fixedNow,
        });
        const c = await bridge.connect();
        assert.equal(c.ok, true, `MCP connect failed: ${c.code} ${c.reason}`);
        assert.deepEqual(c.quarantinedTools, []);
      },
    });

    host.onConversationChange((ev) => {
      if (ev.kind === "pi_view" && ev.detail?.["streaming"] === true) {
        observedStreamPartials.push(String(ev.detail["chars"] ?? ""));
      }
    });

    // =========================================================================
    // 3. P0-2 Budget (Real-Adapter Token Estimation + Progressive Streaming + Shortfall=0)
    // =========================================================================
    const modelBeforeStream = (await fakeModel.stats()).totalPhysicalRequests;
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "text",
          chunks: ["[段1] 正在核对本周进度。", "\n[段2] 邮件与仓库记录已对齐。", "\n[段3] 全部核对完成。"],
          chunkDelayMs: 70,
          usage: { prompt_tokens: 400, completion_tokens: 120 },
        },
      ],
    });
    const convStream = await host.createManagedConversation({ principalId: "owner", slotName: "router" });
    const streamSub = await host.submitChatCommand({
      principalId: "owner",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convStream.id),
      chatKey: `stream-${runId}`,
      content: "请流式输出三段总结",
    });
    assert.equal(streamSub.ok, true);
    await waitFor(
      () => host!.getLastStreamMetrics(String(convStream.id)),
      (m) => m !== null,
      10_000,
    );
    const streamMetrics = host.getLastStreamMetrics(String(convStream.id))!;
    assert.ok(observedStreamPartials.length >= 2, `Expected >=2 progressive stream deltas, got ${observedStreamPartials.length}`);
    assert.ok(streamMetrics.firstTokenMs !== null && streamMetrics.firstTokenMs >= 0);

    const modelAfterStream = (await fakeModel.stats()).totalPhysicalRequests;
    assert.equal(modelAfterStream - modelBeforeStream, 1);

    // Budget shortfall on token-estimated path -> 0 physical sends!
    const convShort = await host.createManagedConversation({ principalId: "owner", slotName: "router" });
    const shortTaskId = host.getConversationBudgetTaskId(String(convShort.id))!;
    setBudgetAccountLimit(host.govDb, {
      accountId: taskAccountIdFor(shortTaskId),
      kind: "TASK",
      limitMu: 1, // guaranteed below conservative token bound
      now: fixedNow,
    });
    await fakeModel.queue({ clear: true, scripts: [{ kind: "text", text: "Should never be sent" }] });
    await host.submitChatCommand({
      principalId: "owner",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convShort.id),
      chatKey: `short-${runId}`,
      content: "Trigger budget denial on token bound",
    });
    await new Promise((r) => setTimeout(r, 350));
    const modelAfterShort = (await fakeModel.stats()).totalPhysicalRequests;
    assert.equal(modelAfterShort - modelAfterStream, 0, "Shortfall on token-estimated path MUST send 0 requests");

    evidence["p0_2_budget_streaming"] = {
      progressiveDeltasObserved: observedStreamPartials.length,
      firstTokenMs: streamMetrics.firstTokenMs,
      totalMs: streamMetrics.totalMs,
      controlSendDelta: modelAfterStream - modelBeforeStream,
      shortfallSendDelta: modelAfterShort - modelAfterStream,
    };

    // =========================================================================
    // 4. P0-1 Two-CAS: Tier 0 GitHub Positive Allowlist Auto-Issue + Tier 2 Escalation + Default-Deny
    // =========================================================================
    // Pure policy checks: protected branch, workflow, delete, unlisted repo
    assert.equal(
      evaluateGithubWritePolicy({
        repoId: "NorthAdb/aegis-stage2-test",
        operation: "create_or_update_file",
        ref: "refs/heads/main",
        path: "docs/status.md",
        allowlist: githubWriteAllowlist,
      }).allowed,
      false,
    );
    assert.equal(
      evaluateGithubWritePolicy({
        repoId: "NorthAdb/aegis-stage2-test",
        operation: "create_or_update_file",
        ref: "refs/heads/stage2-test",
        path: ".github/workflows/ci.yml",
        allowlist: githubWriteAllowlist,
      }).allowed,
      false,
    );
    assert.equal(
      evaluateGithubWritePolicy({
        repoId: "NorthAdb/aegis-stage2-test",
        operation: "create_or_update_file",
        ref: "refs/heads/stage2-test",
        path: "docs/status.md",
        allowlist: githubWriteAllowlist,
      }).tier,
      0,
    );
    // S2-P0-3c negative checks: empty allowedPaths denied, unconfirmed non-protected ref escalated to Tier 2
    assert.equal(
      evaluateGithubWritePolicy({
        repoId: "NorthAdb/aegis-stage2-test",
        operation: "create_or_update_file",
        ref: "refs/heads/stage2-test",
        path: "any/file.md",
        allowlist: [
          {
            repoId: "NorthAdb/aegis-stage2-test",
            operations: ["create_or_update_file"],
            allowedRefs: ["refs/heads/stage2-test"],
            confirmedNonProtectedRefs: ["refs/heads/stage2-test"],
            allowedPaths: [],
            tier: 0,
          },
        ],
      }).allowed,
      false,
      "Empty allowedPaths MUST NOT permit file writes",
    );
    const unconfirmedRefDecision = evaluateGithubWritePolicy({
      repoId: "NorthAdb/aegis-stage2-test",
      operation: "create_or_update_file",
      ref: "refs/heads/develop",
      path: "docs/status.md",
      allowlist: [
        {
          repoId: "NorthAdb/aegis-stage2-test",
          operations: ["create_or_update_file"],
          allowedRefs: ["refs/heads/develop"],
          allowedPaths: ["docs/status.md"],
          tier: 0,
        },
      ],
    });
    assert.equal(unconfirmedRefDecision.tier, 2, "Unconfirmed ref MUST escalate to Tier 2 (never Tier 0)");
    assert.equal(unconfirmedRefDecision.code, "github_write_escalated_unconfirmed_ref");

    assert.equal(
      evaluateGithubWritePolicy({
        repoId: "external-org/collab-repo",
        operation: "create_or_update_file",
        ref: "refs/heads/pr-draft",
        path: "README.md",
        allowlist: githubWriteAllowlist,
      }).tier,
      2,
    );

    // Live Tier 0 auto-issue end-to-end: 0 popup, 2 CAS (auto-issued T2 + submitter T4), 1 fake MCP write!
    // Also inject echoed secret marker in MCP server response to prove S2-P0-4 reduces receipt to `github:commit:<sha>`!
    const ECHOED_MCP_SECRET = `ECHOED_REMOTE_MCP_SECRET_${runId}`;
    writeFileSync(echoSecretFlagPath, ECHOED_MCP_SECRET, "utf8");
    const mcpWritesBefore = readMcpJsonl(mcpLogPath).filter((e) => e["kind"] === "tool_call" && e["isWrite"]).length;
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: {
            id: "gh_t0_1",
            name: "github_write_file",
            arguments: {
              repoId: "NorthAdb/aegis-stage2-test",
              ref: "refs/heads/stage2-test",
              path: "docs/status.md",
              content: "# Stage 2 Status\nAll green.\n",
              message: "stage2 tier0 test",
            },
          },
        },
        { kind: "text", text: "Tier 0 GitHub write committed." },
      ],
    });
    const convGhT0 = await host.createManagedConversation({ principalId: "owner", slotName: "router" });
    await host.submitChatCommand({
      principalId: "owner",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convGhT0.id),
      chatKey: `gh-t0-${runId}`,
      content: "Update docs/status.md on stage2-test branch",
    });
    const t0Effect = await waitFor(
      () =>
        host!.govDb
          .prepare(
            `SELECT e.effect_id, e.state, e.receipt_ref, a.decision_key
               FROM effects e
               JOIN approvals a ON a.approval_id = e.approval_id
               JOIN proposals p ON p.proposal_id = a.proposal_id
              WHERE p.conversation_id = ? AND p.tool_name = 'github_write_file'`,
          )
          .get(String(convGhT0.id)) as { effect_id: string; state: string; receipt_ref: string | null; decision_key: string } | undefined,
      (row) => Boolean(row && row.state === "SUCCEEDED"),
      12_000,
    );
    assert.ok(t0Effect!.decision_key.startsWith("auto:tier0:"));
    assert.ok(t0Effect!.receipt_ref?.startsWith("github:commit:"), `Expected reduced github:commit:<sha> receipt, got ${t0Effect!.receipt_ref}`);
    assert.ok(!String(t0Effect!.receipt_ref).includes(ECHOED_MCP_SECRET));
    assert.equal(countSuccessfulClaimsForEffect(host.govDb, t0Effect!.effect_id), 1);
    rmSync(echoSecretFlagPath, { force: true });
    const mcpWritesAfterT0 = readMcpJsonl(mcpLogPath).filter((e) => e["kind"] === "tool_call" && e["isWrite"]).length;
    assert.equal(mcpWritesAfterT0 - mcpWritesBefore, 1);

    // Negative: unallowlisted write (protected branch) -> 0 MCP writes!
    const modelBeforeDeny = (await fakeModel.stats()).totalPhysicalRequests;
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: {
            id: "gh_deny_1",
            name: "github_write_file",
            arguments: {
              repoId: "NorthAdb/aegis-stage2-test",
              ref: "refs/heads/main",
              path: "docs/status.md",
              content: "blocked",
              message: "should block",
            },
          },
        },
        { kind: "text", text: "Blocked protected branch write." },
      ],
    });
    await host.submitChatCommand({
      principalId: "owner",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convGhT0.id),
      chatKey: `gh-deny-${runId}`,
      content: "Try writing main branch",
    });
    await waitFor(
      async () => (await fakeModel.stats()).totalPhysicalRequests,
      (n) => n >= modelBeforeDeny + 2,
      10_000,
    );
    const mcpWritesAfterDeny = readMcpJsonl(mcpLogPath).filter((e) => e["kind"] === "tool_call" && e["isWrite"]).length;
    assert.equal(mcpWritesAfterDeny, mcpWritesAfterT0, "Protected branch write MUST produce 0 MCP calls");

    // Tier 2 email draft edit -> old revision 409 -> duplicate decisionKey idempotent -> cancel before claim -> final approve=1 SMTP
    const smtpBefore = (await fakeSmtp.stats()).totalReceived;
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: {
            id: "mail_t2_1",
            name: "send_email",
            arguments: {
              to: ["reviewer@local.test"],
              subject: "Initial Draft Subject",
              body: "Initial body text",
            },
          },
        },
        { kind: "text", text: "Email sent after draft edit." },
      ],
    });
    const convMail = await host.createManagedConversation({ principalId: "owner", slotName: "router" });
    await host.submitChatCommand({
      principalId: "owner",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convMail.id),
      chatKey: `mail-t2-${runId}`,
      content: "Send weekly update email",
    });
    const mailProp = await waitFor(
      () =>
        host!.govDb
          .prepare(
            `SELECT p.proposal_id, p.head_rev, a.approval_id, d.action_hash
               FROM proposals p
               JOIN approvals a ON a.proposal_id = p.proposal_id AND a.revision = p.head_rev
               JOIN draft_revisions d ON d.proposal_id = p.proposal_id AND d.revision = p.head_rev
              WHERE p.conversation_id = ? AND p.tool_name = 'send_email'`,
          )
          .get(String(convMail.id)) as
          | { proposal_id: string; head_rev: number; approval_id: string; action_hash: string }
          | undefined,
      (r) => Boolean(r),
      10_000,
    );
    const oldChal = fetchAuthorizedApprovalChallenge(host.govDb, {
      approvalId: mailProp!.approval_id,
      conversationId: String(convMail.id),
      principalId: "owner",
      now: fixedNow,
    });
    assert.equal(oldChal.ok, true);

    // Edit draft -> creates rev 2 and supersedes rev 1
    const saved = saveDraftRevision(host.govDb, {
      proposalId: mailProp!.proposal_id,
      conversationId: String(convMail.id),
      principalId: "owner",
      expectedHeadRev: 1,
      payload: {
        to: ["reviewer@local.test"],
        subject: "Edited Final Subject",
        body: "Edited final verified body!",
      },
      expiresAt: fixedNow + 600_000,
      now: fixedNow,
    });
    assert.equal(saved.ok, true);

    // Old revision decision MUST fail with 409!
    const oldDecide = decideApproval(host.govDb, {
      approvalId: mailProp!.approval_id,
      conversationId: String(convMail.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: mailProp!.action_hash,
      nonce: oldChal.nonce!,
      decisionKey: `dk-old-${runId}`,
      now: fixedNow,
    });
    assert.equal(oldDecide.ok, false);
    assert.equal(oldDecide.httpStatus, 409);

    // Approve rev 2 + duplicate decisionKey idempotency
    const newChal = fetchAuthorizedApprovalChallenge(host.govDb, {
      approvalId: saved.approval!.approval_id,
      conversationId: String(convMail.id),
      principalId: "owner",
      now: fixedNow,
    });
    const dkFinal = `dk-final-${runId}`;
    const dec1 = decideApproval(host.govDb, {
      approvalId: saved.approval!.approval_id,
      conversationId: String(convMail.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: saved.revision!.revision,
      expectedActionHash: saved.revision!.action_hash,
      nonce: newChal.nonce!,
      decisionKey: dkFinal,
      now: fixedNow,
    });
    assert.equal(dec1.ok, true);
    const decDup = decideApproval(host.govDb, {
      approvalId: saved.approval!.approval_id,
      conversationId: String(convMail.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: saved.revision!.revision,
      expectedActionHash: saved.revision!.action_hash,
      nonce: newChal.nonce!,
      decisionKey: dkFinal,
      now: fixedNow,
    });
    assert.equal(decDup.ok, true);
    assert.equal(decDup.idempotentReplay, true);
    await host.deliverPendingOutbox();
    await waitFor(
      async () => (await fakeSmtp.stats()).totalReceived,
      (n) => n === smtpBefore + 1,
      10_000,
    );
    const smtpAfter = await fakeSmtp.stats();
    assert.equal(smtpAfter.totalReceived - smtpBefore, 1);
    assert.ok(smtpAfter.records[smtpAfter.records.length - 1]!.rawData.includes("Edited final verified body!"));

    evidence["p0_1_two_cas"] = {
      tier0GithubAutoIssued: true,
      tier0ClaimCount: countSuccessfulClaimsForEffect(host.govDb, t0Effect!.effect_id),
      tier0FakeMcpWriteDelta: mcpWritesAfterT0 - mcpWritesBefore,
      protectedBranchWriteDelta: mcpWritesAfterDeny - mcpWritesAfterT0,
      oldRevisionRejected409: oldDecide.httpStatus === 409,
      duplicateDecisionKeyReplayed: Boolean(decDup.idempotentReplay),
      editedEmailFakeSmtpDelta: smtpAfter.totalReceived - smtpBefore,
    };

    const { submitApprovedGithubWriteEffect, submitApprovedEmailEffect } = await import("../../src/runtime/submitter.ts");

    // Both dropped IPC and an upstream tool error can leave an applied write unconfirmed.
    const writePin = host.govDb
      .prepare("SELECT schema_sha256 FROM mcp_tool_pins WHERE server_id = ? AND tool_name = ?")
      .get("github-s2", "create_or_update_file") as { schema_sha256: string };
    const unknownGithubWrites = [];
    for (const { mode, reason } of [
      { mode: "DROP_AFTER_WRITE", reason: "mcp_connection_closed" },
      { mode: "ERROR_AFTER_WRITE", reason: "mcp_remote_write_unconfirmed" },
    ]) {
      const filePath = `notes/${mode.toLowerCase()}.md`;
      const target = `github:NorthAdb/aegis-stage2-test@refs/heads/stage2-test:${filePath}`;
      const callId = `gh_${mode.toLowerCase()}`;
      const prop = proposeOrGetApproval(host.govDb, {
        runtimeEpoch: host.runtimeEpoch,
        conversationId: String(convGhT0.id),
        toolTaskId: "98990",
        callId,
        scopeId: "scope:default",
        toolName: "github_write_file",
        target,
        payload: {
          repoId: "NorthAdb/aegis-stage2-test",
          operation: "create_or_update_file",
          ref: "refs/heads/stage2-test",
          path: filePath,
          content: "write outcome fixture",
          message: "test: unconfirmed write outcome",
          mcpServerId: "github-s2",
          mcpToolName: "create_or_update_file",
          mcpSchemaSha256: writePin.schema_sha256,
        },
        expiresAt: fixedNow + 600_000,
        now: fixedNow,
      });
      const decision = decideApproval(host.govDb, {
        approvalId: prop.approval.approval_id,
        conversationId: String(convGhT0.id),
        principalId: "owner",
        decision: "APPROVE",
        expectedRevision: prop.revision.revision,
        expectedActionHash: prop.revision.action_hash,
        nonce: prop.nonce!,
        decisionKey: `dk-${callId}-${runId}`,
        now: fixedNow,
      });
      assert.equal(decision.ok, true);
      const submission: Parameters<typeof submitApprovedGithubWriteEffect>[0] = {
        govDb: host.govDb,
        runtimeEpoch: host.runtimeEpoch,
        effectId: decision.effectId!,
        conversationId: String(convGhT0.id),
        toolTaskId: "98990",
        callId,
        toolName: "github_write_file",
        finalTarget: target,
        finalPayload: JSON.parse(prop.revision.canonical_snapshot).payload,
        allowlist: githubWriteAllowlist,
        bridge: bridge!,
        now: () => fixedNow,
      };
      const countFakeEvents = (kind: string) => readMcpJsonl(mcpLogPath).filter(
        (event) => event["kind"] === kind && event["path"] === filePath,
      ).length;
      writeFileSync(echoSecretFlagPath, mode, "utf8");
      const result = await submitApprovedGithubWriteEffect(submission);
      rmSync(echoSecretFlagPath, { force: true });
      assert.equal(result.claimed, true);
      assert.equal(result.code, "unknown");
      assert.equal(result.effectState, "UNKNOWN");
      const row = host.govDb
        .prepare("SELECT state, reason FROM effects WHERE effect_id = ?")
        .get(decision.effectId!) as { state: string; reason: string };
      assert.deepEqual({ ...row }, { state: "UNKNOWN", reason });
      assert.equal(countFakeEvents("write_applied"), 1);
      if (mode === "DROP_AFTER_WRITE") {
        assert.equal((await bridge!.reconnect()).ok, true);
      }
      assert.equal((await submitApprovedGithubWriteEffect(submission)).claimed, false);
      const dispatchCount = countFakeEvents("tool_call");
      const appliedCount = countFakeEvents("write_applied");
      assert.equal(dispatchCount, 1, "UNKNOWN effect must never resend");
      assert.equal(appliedCount, 1);
      unknownGithubWrites.push({ mode, reason, dispatchCount, appliedCount, proposalId: prop.proposal.proposal_id });
    }

    // =========================================================================
    // 5. P0-3 MCP Pin C4: Drift, Missing Tool, Revocation & Binary Tamper (0 remote calls!)
    // =========================================================================
    // 5a. Queued/READY pending-claim GitHub write effect MUST re-verify live pin & original schemaSha256!
    const origWritePin = host.govDb
      .prepare("SELECT schema_sha256 FROM mcp_tool_pins WHERE server_id = ? AND tool_name = ?")
      .get("github-s2", "create_or_update_file") as { schema_sha256: string };
    const pendingWriteProp = proposeOrGetApproval(host.govDb, {
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convGhT0.id),
      toolTaskId: "99001",
      callId: "c4_pending_write_1",
      scopeId: "scope:default",
      toolName: "github_write_file",
      target: "github:external-org/collab-repo@refs/heads/pr-draft:README.md",
      payload: {
        repoId: "external-org/collab-repo",
        operation: "create_or_update_file",
        ref: "refs/heads/pr-draft",
        path: "README.md",
        content: "pending write",
        message: "pending write",
        mcpServerId: "github-s2",
        mcpToolName: "create_or_update_file",
        mcpSchemaSha256: origWritePin.schema_sha256,
      },
      expiresAt: fixedNow + 600_000,
      now: fixedNow,
    });
    const pendingDec = decideApproval(host.govDb, {
      approvalId: pendingWriteProp.approval.approval_id,
      conversationId: String(convGhT0.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: pendingWriteProp.revision.revision,
      expectedActionHash: pendingWriteProp.revision.action_hash,
      nonce: pendingWriteProp.nonce!,
      decisionKey: `dk-c4-pending-${runId}`,
      now: fixedNow,
    });
    assert.equal(pendingDec.ok, true);
    assert.ok(pendingDec.effectId);

    // S2-P0-4: MCP read-only remote error echoing secret MUST be reduced at bridge boundary (0 leaks)!
    const ECHOED_MCP_READ_SECRET = `ECHOED_MCP_READ_ERR_SECRET_${runId}`;
    writeFileSync(echoSecretFlagPath, `READ_ERROR:${ECHOED_MCP_READ_SECRET}`, "utf8");
    const mcpReadErrRes = await bridge!.callReadOnlyTool(
      "get_file_contents",
      { repo: "NorthAdb/project-helios", ref: "refs/heads/main", path: "README.md" },
      {
        principalId: "owner",
        scopeId: "scope:default",
        repoId: "NorthAdb/project-helios",
        operation: "read_file",
        ref: "refs/heads/main",
        path: "README.md",
      },
    );
    rmSync(echoSecretFlagPath, { force: true });
    assert.equal(mcpReadErrRes.ok, false);
    assert.equal(mcpReadErrRes.code, "mcp_remote_tool_error");
    assert.equal(mcpReadErrRes.reason, "mcp_remote_tool_error:get_file_contents");
    assert.ok(!JSON.stringify(mcpReadErrRes).includes(ECHOED_MCP_READ_SECRET));

    // S2-P0-4 (Round 4): Normal View ② connectivity check & manual recheck failing on remote tools/list error
    // MUST reduce to controlled host enum in testConnectivity(), #lastPauseReason, and subsequent deny audit_events!
    const ECHOED_MCP_LIST_SECRET = `ECHOED_MCP_LIST_ERR_SECRET_${runId}`;
    writeFileSync(echoSecretFlagPath, `LIST_ERROR:${ECHOED_MCP_LIST_SECRET}`, "utf8");
    const mcpConnErrRes = await bridge!.testConnectivity();
    assert.equal(mcpConnErrRes.ok, false);
    assert.equal(mcpConnErrRes.code, "mcp_jsonrpc_error");
    assert.equal(mcpConnErrRes.message, "mcp_jsonrpc_error");
    assert.ok(!JSON.stringify(mcpConnErrRes).includes(ECHOED_MCP_LIST_SECRET));
    assert.equal(bridge!.getStatus().pauseReason, "mcp_jsonrpc_error");
    const denyDuringListErr = await bridge!.callReadOnlyTool(
      "get_file_contents",
      { repo: "NorthAdb/project-helios", ref: "refs/heads/main", path: "README.md" },
      {
        principalId: "owner",
        scopeId: "scope:default",
        repoId: "NorthAdb/project-helios",
        operation: "read_file",
        ref: "refs/heads/main",
        path: "README.md",
      },
    );
    assert.equal(denyDuringListErr.ok, false);
    assert.equal(denyDuringListErr.code, "mcp_admission_paused");
    assert.ok(!JSON.stringify(denyDuringListErr).includes(ECHOED_MCP_LIST_SECRET));
    rmSync(echoSecretFlagPath, { force: true });
    await bridge!.recheckToolPins();
    assert.equal(bridge!.isAdmissionPaused, false);

    const mcpCallsAfterReadErr = readMcpJsonl(mcpLogPath).filter((e) => e["kind"] === "tool_call").length;

    // 5b. Tool definition drift (v1 -> v2) -> recheck quarantines -> both read AND pending-claim write refused (0 remote calls!)
    writeFileSync(tamperFlagPath, "tampered", "utf8");
    // S2-P0-3a: Trigger LIVE mid-session `notifications/tools/list_changed` after tampering!
    writeFileSync(notifyFlagPath, `notify-1-${Date.now()}`, "utf8");
    await waitFor(
      () => bridge!.listChangedNotificationCount,
      (n) => n >= 1,
      5_000,
    );
    await bridge!.waitForPendingRecheck();
    assert.equal(getMcpToolPin(host.govDb, "github-s2", "get_file_contents")?.state, "QUARANTINED");
    assert.equal(getMcpToolPin(host.govDb, "github-s2", "create_or_update_file")?.state, "QUARANTINED");
    const v2WritePinView = inspectStoredMcpToolPin(getMcpToolPin(host.govDb, "github-s2", "create_or_update_file")!);

    // S2-P0-3 (Round 3): Second drift (v2 -> v3) while ALREADY QUARANTINED MUST update persisted review definition
    // AND reject stale v2 approval (409), allowing approval ONLY with latest v3 fingerprint!
    writeFileSync(tamperFlagPath, "tampered-v3", "utf8");
    writeFileSync(notifyFlagPath, `notify-2-${Date.now()}`, "utf8");
    await waitFor(
      () => bridge!.listChangedNotificationCount,
      (n) => n >= 2,
      5_000,
    );
    await bridge!.waitForPendingRecheck();
    const v3WritePinView = inspectStoredMcpToolPin(getMcpToolPin(host.govDb, "github-s2", "create_or_update_file")!);
    assert.notEqual(
      v3WritePinView.observedSchemaSha256,
      v2WritePinView.observedSchemaSha256,
      "Redrift while QUARANTINED MUST refresh stored observed definition and fingerprint to v3",
    );
    assert.ok(v3WritePinView.canonicalDefJson.includes("TAMPERED WRITE TOOL V3"));

    const callAfterDrift = await bridge!.callReadOnlyTool(
      "get_file_contents",
      { repo: "NorthAdb/project-helios", ref: "refs/heads/main", path: "README.md" },
      { principalId: "owner", scopeId: "scope:default", repoId: "NorthAdb/project-helios", operation: "read_file", ref: "refs/heads/main", path: "README.md" },
    );
    assert.equal(callAfterDrift.ok, false);
    assert.equal(callAfterDrift.code, "mcp_tool_quarantined");

    const pendingPayload = JSON.parse(pendingWriteProp.revision.canonical_snapshot).payload;
    const claimWhileQuarantined = await submitApprovedGithubWriteEffect({
      govDb: host.govDb,
      runtimeEpoch: host.runtimeEpoch,
      effectId: pendingDec.effectId!,
      conversationId: String(convGhT0.id),
      toolTaskId: "99001",
      callId: "c4_pending_write_1",
      toolName: "github_write_file",
      finalTarget: "github:external-org/collab-repo@refs/heads/pr-draft:README.md",
      finalPayload: pendingPayload,
      allowlist: githubWriteAllowlist,
      bridge: bridge!,
      now: () => fixedNow,
    });
    assert.equal(claimWhileQuarantined.claimed, false);
    assert.equal(claimWhileQuarantined.code, "mcp_tool_quarantined");

    // S2-P0-3c: Tampered mcpToolName diverging from policy-checked operation MUST be refused before claim!
    const claimToolMismatch = await submitApprovedGithubWriteEffect({
      govDb: host.govDb,
      runtimeEpoch: host.runtimeEpoch,
      effectId: pendingDec.effectId!,
      conversationId: String(convGhT0.id),
      toolTaskId: "99001",
      callId: "c4_pending_write_1",
      toolName: "github_write_file",
      finalTarget: "github:external-org/collab-repo@refs/heads/pr-draft:README.md",
      finalPayload: { ...pendingPayload, mcpToolName: "delete_repository" },
      allowlist: githubWriteAllowlist,
      bridge: bridge!,
      now: () => fixedNow,
    });
    assert.equal(claimToolMismatch.claimed, false);
    assert.equal(claimToolMismatch.code, "github_write_tool_mismatch");

    // S2-P0-3b: Human Pin approval MUST reject stale v1 AND stale v2 fingerprints (409), and succeed ONLY with v3!
    const writePinRow = getMcpToolPin(host.govDb, "github-s2", "create_or_update_file")!;
    const writePinView = inspectStoredMcpToolPin(writePinRow);
    assert.equal(writePinView.drifted, true);
    assert.equal(writePinView.presentInLastList, true);
    const staleV1Approve = approveStoredMcpToolPin(host.govDb, {
      serverId: "github-s2",
      toolName: "create_or_update_file",
      expectedSchemaSha256: writePinView.pinnedSchemaSha256,
      approvedBy: "owner",
      now: fixedNow,
    });
    assert.equal(staleV1Approve.ok, false);
    assert.equal(staleV1Approve.httpStatus, 409);
    const staleV2Approve = approveStoredMcpToolPin(host.govDb, {
      serverId: "github-s2",
      toolName: "create_or_update_file",
      expectedSchemaSha256: v2WritePinView.observedSchemaSha256,
      approvedBy: "owner",
      now: fixedNow,
    });
    assert.equal(staleV2Approve.ok, false);
    assert.equal(staleV2Approve.httpStatus, 409);

    const reappWrite = approveStoredMcpToolPin(host.govDb, {
      serverId: "github-s2",
      toolName: "create_or_update_file",
      expectedSchemaSha256: writePinView.observedSchemaSha256,
      expectedCanonicalDefJson: writePinView.canonicalDefJson,
      approvedBy: "owner",
      now: fixedNow,
    });
    assert.equal(reappWrite.ok, true);
    const claimWithStaleFingerprint = await submitApprovedGithubWriteEffect({
      govDb: host.govDb,
      runtimeEpoch: host.runtimeEpoch,
      effectId: pendingDec.effectId!,
      conversationId: String(convGhT0.id),
      toolTaskId: "99001",
      callId: "c4_pending_write_1",
      toolName: "github_write_file",
      finalTarget: "github:external-org/collab-repo@refs/heads/pr-draft:README.md",
      finalPayload: pendingPayload,
      allowlist: githubWriteAllowlist,
      bridge: bridge!,
      now: () => fixedNow,
    });
    assert.equal(claimWithStaleFingerprint.claimed, false);
    assert.equal(claimWithStaleFingerprint.code, "mcp_tool_fingerprint_changed");

    // 5d. Human approves drifted read tool, then immediate revoke blocks execution (0 remote calls)
    const readPinView = inspectStoredMcpToolPin(getMcpToolPin(host.govDb, "github-s2", "get_file_contents")!);
    const reapp = approveStoredMcpToolPin(host.govDb, {
      serverId: "github-s2",
      toolName: "get_file_contents",
      expectedSchemaSha256: readPinView.observedSchemaSha256,
      expectedCanonicalDefJson: readPinView.canonicalDefJson,
      approvedBy: "owner",
      now: fixedNow,
    });
    assert.equal(reapp.ok, true);
    revokeMcpTool(host.govDb, {
      serverId: "github-s2",
      toolName: "get_file_contents",
      reason: "c4_revoke_test",
      now: fixedNow,
    });
    const callAfterRevoke = await bridge!.callReadOnlyTool(
      "get_file_contents",
      { repo: "NorthAdb/project-helios", ref: "refs/heads/main", path: "README.md" },
      { principalId: "owner", scopeId: "scope:default", repoId: "NorthAdb/project-helios", operation: "read_file", ref: "refs/heads/main", path: "README.md" },
    );
    assert.equal(callAfterRevoke.ok, false);
    assert.equal(callAfterRevoke.code, "mcp_tool_revoked");

    // 5e. Missing tool on reconnect -> quarantined & present_in_last_list=0 -> approval refused (409)!
    rmSync(tamperFlagPath, { force: true });
    const readPinView2 = inspectStoredMcpToolPin(getMcpToolPin(host.govDb, "github-s2", "get_file_contents")!);
    approveStoredMcpToolPin(host.govDb, {
      serverId: "github-s2",
      toolName: "get_file_contents",
      expectedSchemaSha256: readPinView2.observedSchemaSha256,
      approvedBy: "owner",
      now: fixedNow,
    });
    writeFileSync(dropReadFlagPath, "drop", "utf8");
    const missingRes = await bridge!.reconnect();
    assert.equal(missingRes.ok, true);
    assert.ok(missingRes.missingQuarantinedTools?.includes("get_file_contents"));
    const missingPinView = inspectStoredMcpToolPin(getMcpToolPin(host.govDb, "github-s2", "get_file_contents")!);
    assert.equal(missingPinView.presentInLastList, false);
    const approveAbsentRes = approveStoredMcpToolPin(host.govDb, {
      serverId: "github-s2",
      toolName: "get_file_contents",
      expectedSchemaSha256: missingPinView.observedSchemaSha256,
      approvedBy: "owner",
      now: fixedNow,
    });
    assert.equal(approveAbsentRes.ok, false);
    assert.equal(approveAbsentRes.httpStatus, 409);
    assert.equal(approveAbsentRes.code, "mcp_tool_not_present");
    rmSync(dropReadFlagPath, { force: true });

    // 5f. Binary tamper on reconnect -> binary SHA-256 mismatch -> admission paused, 0 calls!
    writeFileSync(mcpScriptCopy, readFileSync(mcpScriptCopy, "utf8") + "\n// tampered\n", "utf8");
    const tamperedConn = await bridge!.reconnect();
    assert.equal(tamperedConn.ok, false);
    assert.equal(tamperedConn.code, "mcp_binary_sha256_mismatch");
    assert.equal(bridge!.isAdmissionPaused, true);
    const callWhilePaused = await bridge!.callReadOnlyTool(
      "get_file_contents",
      { repo: "NorthAdb/project-helios", ref: "refs/heads/main", path: "README.md" },
      { principalId: "owner", scopeId: "scope:default", repoId: "NorthAdb/project-helios", operation: "read_file", ref: "refs/heads/main", path: "README.md" },
    );
    assert.equal(callWhilePaused.ok, false);
    assert.equal(callWhilePaused.code, "mcp_admission_paused");

    const mcpTotalAfterC4 = readMcpJsonl(mcpLogPath).filter((e) => e["kind"] === "tool_call").length;
    assert.equal(mcpTotalAfterC4 - mcpCallsAfterReadErr, 0, "Drifted/revoked/paused MCP calls MUST produce 0 remote tool_calls");

    evidence["p0_3_mcp_c4"] = {
      listChangedNotificationPausedAndQuarantined: true,
      redriftWhileQuarantinedUpdatedToV3: true,
      absentToolApprovalRejected409: true,
      stalePinApprovalRejected409: true,
      toolMismatchBlockedBeforeClaim: claimToolMismatch.code,
      driftQuarantined: true,
      pendingClaimBlockedOnDrift: claimWhileQuarantined.code,
      pendingClaimBlockedOnFingerprintChangeAfterReapprove: claimWithStaleFingerprint.code,
      revokedCallBlocked: callAfterRevoke.code,
      missingToolQuarantined: Boolean(missingRes.missingQuarantinedTools?.includes("get_file_contents")),
      binaryTamperRejected: tamperedConn.code,
      remoteToolCallDeltaDuringC4: mcpTotalAfterC4 - mcpCallsAfterReadErr,
    };

    // =========================================================================
    // 6. P0-5 Skills 3-Level + Auth (3d) + Same-Conv Task Lock (P1-2) + Routines + Mobile HTTPS
    // =========================================================================
    const task1Key = `${String(convStream.id)}#cmd:task1`;
    const task2Key = `${String(convStream.id)}#cmd:task2`;
    const lock1 = getOrLockConversationSkillSet(host.govDb, {
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convStream.id),
      lockKey: task1Key,
      now: fixedNow,
    });
    assert.ok(lock1.renderedL1Index.includes("weekly-brief-helper v1"));
    const l2 = readSkillDisclosure(host.govDb, {
      skillId: "weekly-brief-helper",
      principalId: "owner",
      scopeId: "scope:default",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convStream.id),
      lockKey: task1Key,
    });
    assert.equal(l2.ok, true);
    assert.equal(l2.scripts.length, 1);

    // S2-P0-3d: Unauthorized principal denied L2 body read; L3 script denied without independent execute_script grant!
    const l2Unauth = readSkillDisclosure(host.govDb, {
      skillId: "weekly-brief-helper",
      principalId: "untrusted-guest",
      scopeId: "scope:default",
    });
    assert.equal(l2Unauth.ok, false);
    assert.equal(l2Unauth.code, "skill_read_denied");

    const l3NoExecGrant = resolveVerifiedSkillScript(host.govDb, {
      skillId: "weekly-brief-helper",
      scriptId: "format-weekly-brief",
      principalId: "owner",
      scopeId: "scope:default",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convStream.id),
      lockKey: task1Key,
    });
    assert.equal(l3NoExecGrant.ok, false);
    assert.equal(l3NoExecGrant.code, "skill_script_execution_denied");

    registerSkillVersion(host.govDb, {
      skillId: "weekly-brief-helper",
      name: "Weekly Brief & Schedule Diff Helper",
      version: 2,
      summary: "v2 summary",
      body: "v2 instructions",
      reviewedBy: "owner",
      activate: true,
      now: fixedNow + 1000,
    });
    // S2-P1-2: In the SAME conversation, Task 1 stays locked to v1 while Task 2 acquires v2!
    const l2OldTaskSameConv = readSkillDisclosure(host.govDb, {
      skillId: "weekly-brief-helper",
      principalId: "owner",
      scopeId: "scope:default",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convStream.id),
      lockKey: task1Key,
    });
    assert.equal(l2OldTaskSameConv.ok && l2OldTaskSameConv.version, 1);
    const lock2SameConv = getOrLockConversationSkillSet(host.govDb, {
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convStream.id),
      lockKey: task2Key,
      now: fixedNow + 1100,
    });
    assert.ok(lock2SameConv.renderedL1Index.includes("weekly-brief-helper v2"));
    const l2NewTaskSameConv = readSkillDisclosure(host.govDb, {
      skillId: "weekly-brief-helper",
      principalId: "owner",
      scopeId: "scope:default",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convStream.id),
      lockKey: task2Key,
    });
    assert.equal(l2NewTaskSameConv.ok && l2NewTaskSameConv.version, 2);

    // Revoke immediately blocks BOTH old and new!
    revokeSkill(host.govDb, { skillId: "weekly-brief-helper", actorId: "owner", reason: "test_revoke", now: fixedNow + 2000 });
    assert.equal(
      readSkillDisclosure(host.govDb, {
        skillId: "weekly-brief-helper",
        principalId: "owner",
        scopeId: "scope:default",
        runtimeEpoch: host.runtimeEpoch,
        conversationId: String(convStream.id),
        lockKey: task1Key,
      }).ok,
      false,
    );
    setSkillActiveVersion(host.govDb, { skillId: "weekly-brief-helper", version: 1, actorId: "owner", now: fixedNow + 3000 });

    // 6b. Routines: Tier 1 rule -> revoke forces re-confirmation; idempotency across repeated polls + missed periods + pause
    const preview = parseNaturalLanguageRoutine(host.govDb, {
      text: "每天 08:30 生成安全周报草稿",
      principalId: "owner",
      scopeId: "scope:default",
      timezone: "Asia/Hong_Kong",
      now: fixedNow,
    });
    assert.equal(preview.requiresConfirmation, true);
    const unconfirmed = createRoutineWithGovernance(host.govDb, {
      principalId: "owner",
      scopeId: "scope:default",
      name: preview.name,
      prompt: preview.prompt,
      timezone: preview.timezone,
      scheduleSpec: preview.scheduleSpec,
      confirmed: false,
      now: fixedNow,
    });
    assert.equal(unconfirmed.ok, false);

    // Create confirmed + rememberRule, then create second via rule, then revoke rule -> third requires confirmation again!
    const created1 = createRoutineWithGovernance(host.govDb, {
      principalId: "owner",
      scopeId: "scope:default",
      name: "Idempotent Routine",
      prompt: "Summarize daily status",
      timezone: "Asia/Hong_Kong",
      scheduleSpec: { kind: "daily", hour: 8, minute: 30 },
      nextRunUtcMs: fixedNow - 3 * 24 * 60 * 60 * 1000, // 3 missed periods!
      confirmed: true,
      rememberRule: true,
      now: fixedNow,
    });
    assert.equal(created1.ok, true);
    assert.ok(created1.ruleCreatedId);

    const rulesBeforeRevoke = listRememberedRules(host.govDb, { principalId: "owner" });
    assert.equal(rulesBeforeRevoke.length, 1);
    const revRule = revokeRememberedRule(host.govDb, {
      ruleId: created1.ruleCreatedId!,
      principalId: "owner",
      reason: "test_rule_revoke",
      now: fixedNow + 100,
    });
    assert.equal(revRule.ok, true);

    const afterRuleRevoke = createRoutineWithGovernance(host.govDb, {
      principalId: "owner",
      scopeId: "scope:default",
      name: "Blocked After Revoke",
      prompt: "Should require confirm",
      timezone: "Asia/Hong_Kong",
      scheduleSpec: { kind: "daily", hour: 9, minute: 0 },
      confirmed: false,
      now: fixedNow + 200,
    });
    assert.equal(afterRuleRevoke.ok, false);
    assert.equal(afterRuleRevoke.code, "tier1_confirmation_required");

    // Poll twice right now: 3 missed periods collapse to ONLY 1 latest trigger, second poll admits 0!
    await fakeModel.queue({ clear: true, scripts: [{ kind: "text", text: "Routine executed once." }] });
    const poll1 = await host.routinePoller!.pollOnce();
    const poll2 = await host.routinePoller!.pollOnce();
    assert.equal(poll1.admittedCount, 1);
    assert.equal(poll2.admittedCount, 0);
    const triggersCount = (
      host.govDb
        .prepare("SELECT count(*) AS n FROM routine_triggers WHERE routine_id = ?")
        .get(created1.routine.routine_id) as { n: number }
    ).n;
    assert.equal(triggersCount, 1, "3 missed periods + 2 polls MUST produce exactly 1 trigger");

    // Pause stops future triggers even when clock advances
    pauseRoutine(host.govDb, { routineId: created1.routine.routine_id, principalId: "owner", now: fixedNow + 500 });
    fixedNow += 48 * 60 * 60 * 1000;
    const pollPaused = await host.routinePoller!.pollOnce();
    assert.equal(pollPaused.admittedCount, 0);

    // 6c. Mobile HTTPS Profile fail-closed + __Host- Secure Cookie + Cross-Origin 403 + Logout revokes SSE
    let badHttpsRejected = false;
    try {
      await startWebServer({
        host,
        port: 0,
        consoleToken,
        mobileHttps: { enabled: true, publicOrigin: "http://insecure.example.com" },
      });
    } catch {
      badHttpsRejected = true;
    }
    assert.equal(badHttpsRejected, true, "Non-HTTPS publicOrigin MUST fail closed");

    const httpsOrigin = "https://aegis.tailnet.test";
    const mobileWeb = await startWebServer({
      host,
      port: 0,
      consoleToken,
      uiMode: "stage2",
      mobileHttps: { enabled: true, publicOrigin: httpsOrigin },
    });
    try {
      // Cross-origin login MUST be 403
      const badOriginRes = await fetch(`${mobileWeb.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "aegis.tailnet.test",
          origin: "https://evil.attacker.test",
        },
        body: JSON.stringify({ token: consoleToken }),
      });
      assert.equal(badOriginRes.status, 403);

      // Valid trusted HTTPS origin login issues __Host- Secure HttpOnly SameSite=Strict Path=/ cookie with NO Domain
      const okLogin = await fetch(`${mobileWeb.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "aegis.tailnet.test",
          origin: httpsOrigin,
        },
        body: JSON.stringify({ token: consoleToken }),
      });
      assert.equal(okLogin.status, 200);
      const setCookie = okLogin.headers.get("set-cookie") ?? "";
      assert.ok(setCookie.startsWith("__Host-aegispi_session="));
      assert.ok(setCookie.includes("Secure"));
      assert.ok(setCookie.includes("HttpOnly"));
      assert.ok(setCookie.includes("SameSite=Strict"));
      assert.ok(setCookie.includes("Path=/"));
      assert.equal(/;\s*Domain=/i.test(setCookie), false, "__Host- cookie MUST omit Domain attribute");

      const cookiePair = setCookie.split(";")[0]!;
      const logoutRes = await fetch(`${mobileWeb.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { host: "aegis.tailnet.test", origin: httpsOrigin, cookie: cookiePair },
      });
      assert.equal(logoutRes.status, 200);
      const afterLogout = await fetch(`${mobileWeb.baseUrl}/api/auth/me`, {
        headers: { host: "aegis.tailnet.test", cookie: cookiePair },
      });
      assert.equal(afterLogout.status, 401);

      // 6d. Hono Decoupling: submit background task, CLOSE Hono Web server, verify task completes & reconciles!
      const convBg = await host.createManagedConversation({ principalId: "owner", slotName: "router" });
      await fakeModel.queue({
        clear: true,
        scripts: [{ kind: "hold_then_text", holdBarrierKey: "hono_close_barrier", text: "Completed after Hono closed!" }],
      });
      await host.submitChatCommand({
        principalId: "owner",
        runtimeEpoch: host.runtimeEpoch,
        conversationId: String(convBg.id),
        chatKey: `bg-hono-${runId}`,
        content: "Run decoupled background task",
      });
      const arrived = await fakeModel.waitBarrier("hono_close_barrier", 10_000);
      assert.equal(arrived.arrived, true);
      // Close Hono HTTP server completely BEFORE releasing model barrier!
      await mobileWeb.close();
      await fakeModel.releaseBarrier("hono_close_barrier");
      await waitFor(
        async () => await host!.readConversationMessages(String(convBg.id)),
        (msgs) => msgs.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("Completed after Hono closed!")),
        10_000,
      );
    } finally {
      await mobileWeb.close().catch(() => {});
    }

    // =========================================================================
    // 6.5 Round 1 Security Audit Targeted Regressions (S2-P0-1, 2, 3b, 4, 5 & P1-1, 3, 4)
    // =========================================================================
    const crlfValidate = validateStage2PlainTextEmail({
      to: ["safe@local.test"],
      subject: "Normal\r\nBcc: evil@attacker.test",
      body: "hi",
    });
    assert.equal(crlfValidate.ok, false);
    assert.equal(crlfValidate.code, "invalid_email_subject_multiline");
    assert.equal(
      validateEmailEnvelopeSingleLine({ to: ["a@local.test"], subject: "Line1\nLine2" }).ok,
      false,
    );
    const crlfSmtp = await sendSmtpMessage({
      host: fakeSmtp.host,
      port: fakeSmtp.smtpPort,
      from: "owner@local.test",
      to: ["safe@local.test"],
      subject: "Inject\r\nBcc: attacker@evil.test",
      body: "body",
      egressPolicy,
    });
    assert.equal(crlfSmtp.status, "failed_local");
    assert.equal(crlfSmtp.bytesSent, 0);
    assert.equal(
      validateEmailRecipientsAllowlist({ to: ["a@gmail.com"], allowedRecipients: ["*"], smtpHost: "smtp.gmail.com" }).ok,
      false,
    );
    assert.equal(
      validateEmailRecipientsAllowlist({
        to: ["evil@gmail.com"],
        allowedRecipients: ["approved@gmail.com"],
        smtpHost: "smtp.gmail.com",
      }).ok,
      false,
    );

    // S2-P0-1 (Round 3): Stage 2 cannot disable strictPlainTextEmail at host startup OR submitter, and rejects extra fields!
    assert.equal(
      validateStage2PlainTextEmail({
        to: ["approved@local.test"],
        subject: "Extra field test",
        body: "Plain text",
        html: "<b>unsupported</b>",
      }).ok,
      false,
    );
    let stage2DisableStrictRejected = false;
    try {
      await AegisHostRuntime.start({
        dataDir: path.join(rootDir, "reject-non-strict"),
        vault,
        modelSlots,
        smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "owner@local.test" },
        egressPolicy: { stage: 2 },
        strictPlainTextEmail: false,
      });
    } catch {
      stage2DisableStrictRejected = true;
    }
    assert.equal(stage2DisableStrictRejected, true, "Stage 2 MUST refuse strictPlainTextEmail=false");

    // S2-P0-2 (Round 4):
    // 1. Stage 2 formal entry with loopback URL & NO modelProfile & NO --allow-synthetic-fake-model MUST refuse startup!
    const stage2NoProfileProc = spawnSync(
      LOCKED_NODE_EXE,
      [
        path.resolve("src/index.ts"),
        "--stage",
        "2",
        "--data-dir",
        path.join(rootDir, "reject-stage2-no-profile"),
        "--port",
        "0",
        "--model-base-url",
        fakeModel.baseUrl,
        "--smtp-host",
        fakeSmtp.host,
        "--smtp-port",
        String(fakeSmtp.smtpPort),
        "--console-token",
        consoleToken,
      ],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
    assert.notEqual(
      stage2NoProfileProc.status,
      0,
      "Stage 2 without modelProfile and without --allow-synthetic-fake-model MUST refuse startup",
    );
    assert.ok(stage2NoProfileProc.stderr.includes("stage2_model_profile_required"));

    const realProfile = {
      provider: "deepseek",
      routerModelId: "deepseek-flash",
      workerModelId: "deepseek-flash",
      apiKeyEnvVar: "AEGISPI_STAGE2_TEST_MODEL_KEY",
      allowedRemoteHosts: ["api.deepseek.com", "unverified.example"],
      priceSchedule: tokenPriceSchedule,
    };
    const modelRequestsBeforeInvalidProfiles = (await fakeModel.stats()).totalPhysicalRequests;
    const invalidModelProfiles = [];
    for (const { name, baseUrl, code } of [
      { name: "missing", baseUrl: undefined, code: "stage2_real_model_base_url_required" },
      { name: "blank", baseUrl: " ", code: "stage2_real_model_base_url_required" },
      { name: "loopback", baseUrl: fakeModel.baseUrl, code: "unverified_model_endpoint" },
      { name: "unverified", baseUrl: "https://unverified.example", code: "unverified_model_endpoint" },
    ]) {
      const dataDir = path.join(rootDir, `reject-model-${name}`);
      const configPath = `${dataDir}.json`;
      writeFileSync(configPath, JSON.stringify({ modelProfile: { ...realProfile, baseUrl } }));
      const attempt = spawnSync(LOCKED_NODE_EXE, [
        path.resolve("src/index.ts"), "--stage", "2", "--data-dir", dataDir, "--port", "0",
        "--connectors-config", configPath, "--model-base-url", fakeModel.baseUrl,
        "--allow-synthetic-fake-model", "--console-token", consoleToken,
      ], {
        encoding: "utf8", timeout: 15_000, windowsHide: true,
        env: { ...process.env, AEGISPI_STAGE2_TEST_MODEL_KEY: routerKey },
      });
      assert.equal(attempt.status, 1, `Stage 2 real profile with ${name} base URL must refuse startup`);
      assert.ok(attempt.stderr.includes(code));
      assert.ok(!attempt.stderr.includes(routerKey));
      assert.ok(!existsSync(dataDir), "Real endpoint validation must happen before opening the data stores");
      invalidModelProfiles.push({ name, code, exitCode: attempt.status });
    }
    const invalidModelProfileHttpDelta = (await fakeModel.stats()).totalPhysicalRequests - modelRequestsBeforeInvalidProfiles;
    assert.equal(invalidModelProfileHttpDelta, 0);

    // 2. Retired `deepseek-chat`, unproven models, zero/below-floor rates, and unverified remote endpoints MUST fail closed!
    assert.equal(
      validateModelPriceScheduleForEndpoint("http://127.0.0.1:7890/v1", null, {
        provider: "deepseek",
        modelId: "deepseek-flash",
      }).ok,
      false,
    );
    assert.equal(
      validateModelPriceScheduleForEndpoint(
        "http://127.0.0.1:7890/v1",
        {
          priceVersion: "synthetic-v1",
          inputPerMTokMu: 300_000,
          outputPerMTokMu: 1_200_000,
          syntheticFixedUpperMu: 100,
        },
        { provider: "deepseek", modelId: "deepseek-flash" },
      ).ok,
      false,
    );
    // Retired alias deepseek-chat (2026-07-24) MUST be rejected!
    assert.equal(
      validateModelPriceScheduleForEndpoint(
        "https://api.deepseek.com",
        {
          priceVersion: "deepseek-2026-11",
          provider: "deepseek",
          modelId: "deepseek-chat",
          inputPerMTokMu: 300_000,
          outputPerMTokMu: 1_200_000,
          cacheReadPerMTokMu: 6_000,
          allowTokenBoundEstimation: true,
        },
        { provider: "deepseek", modelId: "deepseek-chat" },
      ).ok,
      false,
    );
    // All-zero rates MUST be rejected!
    assert.equal(
      validateModelPriceScheduleForEndpoint(
        "https://api.deepseek.com",
        {
          priceVersion: "deepseek-flash-v4.1-zero",
          provider: "deepseek",
          modelId: "deepseek-flash",
          boundContractVersion: "deepseek-flash-v4.1-2026-11",
          inputPerMTokMu: 0,
          outputPerMTokMu: 0,
          cacheReadPerMTokMu: 0,
          allowTokenBoundEstimation: true,
        },
        { provider: "deepseek", modelId: "deepseek-flash" },
      ).ok,
      false,
    );
    // Off-peak / underpriced rates below Peak floor MUST be rejected!
    assert.equal(
      validateModelPriceScheduleForEndpoint(
        "https://api.deepseek.com",
        {
          priceVersion: "deepseek-flash-offpeak-only",
          provider: "deepseek",
          modelId: "deepseek-flash",
          boundContractVersion: "deepseek-flash-v4.1-2026-11",
          inputPerMTokMu: 150_000,
          outputPerMTokMu: 600_000,
          cacheReadPerMTokMu: 3_000,
          allowTokenBoundEstimation: true,
        },
        { provider: "deepseek", modelId: "deepseek-flash" },
      ).ok,
      false,
    );
    // Unverified remote host claiming provider=deepseek MUST be rejected!
    assert.equal(
      validateModelPriceScheduleForEndpoint(
        "https://evil-proxy.example.com/v1",
        {
          priceVersion: "deepseek-flash-v4.1-peak",
          provider: "deepseek",
          modelId: "deepseek-flash",
          boundContractVersion: "deepseek-flash-v4.1-2026-11",
          inputPerMTokMu: 300_000,
          outputPerMTokMu: 1_200_000,
          cacheReadPerMTokMu: 6_000,
          allowTokenBoundEstimation: true,
        },
        { provider: "deepseek", modelId: "deepseek-flash" },
      ).ok,
      false,
    );
    // Official DeepSeek V4.1 Flash contract with Peak rates MUST pass!
    assert.equal(
      validateModelPriceScheduleForEndpoint(
        "https://api.deepseek.com",
        {
          priceVersion: "deepseek-flash-v4.1-peak-2026-11",
          provider: "deepseek",
          modelId: "deepseek-flash",
          boundContractVersion: "deepseek-flash-v4.1-2026-11",
          inputPerMTokMu: 300_000,
          outputPerMTokMu: 1_200_000,
          cacheReadPerMTokMu: 6_000,
          allowTokenBoundEstimation: true,
        },
        { provider: "deepseek", modelId: "deepseek-flash" },
      ).ok,
      true,
    );

    // 3. End-to-end real-contract `deepseek/deepseek-flash` proof against local fakeModel:
    //    - Normal task fits inside 800_000 mu task limit (upperMu = 301_229 mu), sends wire `thinking: { type: "disabled" }` + `max_tokens: 1024`, settles actual usage!
    //    - Budget-exhausted task (limit = 200_000 < 301_229) is blocked BEFORE transport with physical HTTP delta = 0!
    const dsDataDir = path.join(rootDir, "deepseek-contract-host");
    const dsVault = new HostCredentialVault();
    const dsSchedule = {
      priceVersion: "deepseek-flash-v4.1-peak-2026-11",
      provider: "deepseek",
      modelId: "deepseek-flash",
      boundContractVersion: "deepseek-flash-v4.1-2026-11",
      inputPerMTokMu: 300_000,
      outputPerMTokMu: 1_200_000,
      cacheReadPerMTokMu: 6_000,
      allowTokenBoundEstimation: true,
    };
    dsVault.registerSlot(
      {
        slotId: "slot:ds-router",
        provider: "deepseek",
        allowedBaseUrls: [deepSeekBaseUrl],
        allowedModelIds: ["deepseek-flash"],
        priceVersion: dsSchedule.priceVersion,
      },
      routerKey,
      egressPolicy,
    );
    dsVault.registerSlot(
      {
        slotId: "slot:ds-worker",
        provider: "deepseek",
        allowedBaseUrls: [deepSeekBaseUrl],
        allowedModelIds: ["deepseek-flash"],
        priceVersion: dsSchedule.priceVersion,
      },
      workerKey,
      egressPolicy,
    );
    const dsHost = await AegisHostRuntime.start({
      dataDir: dsDataDir,
      vault: dsVault,
      modelSlots: [
        {
          slotName: "router",
          provider: "deepseek",
          modelId: "deepseek-flash",
          baseUrl: deepSeekBaseUrl,
          credentialSlotId: "slot:ds-router",
          contextWindow: 1_000_000,
          maxTokens: 1024,
          priceSchedule: dsSchedule,
          outboundAuthorized: true,
        },
        {
          slotName: "worker",
          provider: "deepseek",
          modelId: "deepseek-flash",
          baseUrl: deepSeekBaseUrl,
          credentialSlotId: "slot:ds-worker",
          contextWindow: 1_000_000,
          maxTokens: 1024,
          priceSchedule: dsSchedule,
          outboundAuthorized: true,
        },
      ],
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "owner@local.test" },
      egressPolicy,
      fetchImpl: fetchDeepSeekFixture,
      strictPlainTextEmail: true,
      defaultTaskLimitMu: 800_000,
      defaultDayLimitMu: 5_000_000,
      now: () => fixedNow,
    });
    let dsWireThinkingDisabledVerified = false;
    let dsWireMaxTokensVerified = false;
    let dsNormalUpperMu = 0;
    let dsExhaustedHttpDelta = -1;
    try {
      const dsBeforeOk = (await fakeModel.stats()).totalPhysicalRequests;
      await fakeModel.queue({
        clear: true,
        scripts: [
          {
            kind: "text",
            text: "DeepSeek V4.1 Flash contract ok.",
            usage: { prompt_tokens: 1000, completion_tokens: 200 },
          },
        ],
      });
      const dsConvOk = await dsHost.createManagedConversation({ principalId: "owner", slotName: "router" });
      const dsOkSub = await dsHost.submitChatCommand({
        principalId: "owner",
        runtimeEpoch: dsHost.runtimeEpoch,
        conversationId: String(dsConvOk.id),
        chatKey: `ds-ok-${runId}`,
        content: "Summarize today's standup notes.",
      });
      assert.equal(dsOkSub.ok, true);
      await waitFor(
        async () => (await fakeModel.stats()).totalPhysicalRequests,
        (n) => n === dsBeforeOk + 1,
        10_000,
      );
      const dsResRow = await waitFor(
        () =>
          dsHost.govDb
            .prepare("SELECT upper_mu, actual_mu, state FROM budget_reservations WHERE conversation_id = ? LIMIT 1")
            .get(String(dsConvOk.id)) as { upper_mu: number; actual_mu: number | null; state: string } | undefined,
        (r) => Boolean(r && r.state === "SETTLED"),
        10_000,
      );
      dsNormalUpperMu = dsResRow!.upper_mu;
      // 1_000_000 * 300_000 / 1_000_000 + ceil(1024 * 1_200_000 / 1_000_000) = 300_000 + 1_229 = 301_229
      assert.equal(dsResRow!.upper_mu, 301_229);
      assert.equal(dsResRow!.actual_mu, 540);
      const dsStatsAfterOk = await fakeModel.stats();
      const lastDsReq = dsStatsAfterOk.records[dsStatsAfterOk.records.length - 1]!;
      assert.equal(lastDsReq.model, "deepseek-flash");
      assert.equal(lastDsReq.maxTokens, 1024);
      assert.deepEqual(lastDsReq.thinking, { type: "disabled" });
      dsWireThinkingDisabledVerified = true;
      dsWireMaxTokensVerified = true;

      // Now run a task whose task budget limit (200_000 mu) is below 301_229 mu -> MUST block BEFORE transport (0 HTTP!)
      const dsConvDenied = await dsHost.createManagedConversation({ principalId: "owner", slotName: "router" });
      const dsDeniedTaskId = dsHost.getConversationBudgetTaskId(String(dsConvDenied.id))!;
      setBudgetAccountLimit(dsHost.govDb, {
        accountId: taskAccountIdFor(dsDeniedTaskId),
        kind: "TASK",
        limitMu: 200_000,
        now: fixedNow,
      });
      const dsBeforeTight = (await fakeModel.stats()).totalPhysicalRequests;
      await fakeModel.queue({ clear: true, scripts: [{ kind: "text", text: "Should never be sent on exhausted DeepSeek budget" }] });
      const dsDeniedSub = await dsHost.submitChatCommand({
        principalId: "owner",
        runtimeEpoch: dsHost.runtimeEpoch,
        conversationId: String(dsConvDenied.id),
        chatKey: `ds-denied-${runId}`,
        content: "This task must be denied before transport due to insufficient budget.",
      });
      assert.equal(dsDeniedSub.ok, true);
      await waitFor(
        () =>
          dsHost.govDb
            .prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'budget_denied'")
            .get() as { n: number },
        (r) => r.n >= 1,
        10_000,
      );
      const dsAfterTight = (await fakeModel.stats()).totalPhysicalRequests;
      dsExhaustedHttpDelta = dsAfterTight - dsBeforeTight;
      assert.equal(dsExhaustedHttpDelta, 0, "Budget-exhausted DeepSeek task MUST produce 0 physical HTTP requests");
    } finally {
      await dsHost.close().catch(() => {});
    }

    // S2-P0-4 (Round 3): Malicious remote model HTTP 401 echoing secret during a routine run -> reduced to controlled code!
    const ECHOED_MODEL_SECRET = `ECHOED_MODEL_HTTP401_SECRET_${runId}`;
    const errRoutine = createRoutineWithGovernance(host.govDb, {
      principalId: "owner",
      scopeId: "scope:default",
      name: "Model Error Boundary Routine",
      prompt: "Trigger provider HTTP 401 echo check",
      timezone: "Asia/Hong_Kong",
      scheduleSpec: { kind: "once", onceAtUtcMs: fixedNow - 10_000 },
      nextRunUtcMs: fixedNow - 10_000,
      confirmed: true,
      now: fixedNow,
    });
    assert.equal(errRoutine.ok, true);
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "http_error",
          httpStatus: 401,
          errorMessage: `Invalid API key echoed by provider: ${ECHOED_MODEL_SECRET}`,
        },
      ],
    });
    const errPoll = await host.routinePoller!.pollOnce();
    assert.equal(errPoll.admittedCount, 1);
    const errTrigRow = await waitFor(
      () =>
        host!.govDb
          .prepare("SELECT * FROM routine_triggers WHERE routine_id = ? LIMIT 1")
          .get(errRoutine.routine.routine_id) as { state: string; reason: string | null; conversation_id: string | null } | undefined,
      (r) => Boolean(r && r.state === "FAILED"),
      10_000,
    );
    assert.equal(errTrigRow!.reason, "model_provider_http_401");
    const errRoutineRow = host.govDb
      .prepare("SELECT last_status, last_result_summary FROM routines WHERE routine_id = ?")
      .get(errRoutine.routine.routine_id) as { last_status: string; last_result_summary: string | null };
    assert.equal(errRoutineRow.last_status, "FAILED");
    assert.ok(errRoutineRow.last_result_summary?.includes("model_provider_http_401"));
    assert.ok(!JSON.stringify(errRoutineRow).includes(ECHOED_MODEL_SECRET));

    // S2-P0-4 (Round 4): Malicious remote model HTTP 200 SSE in-stream error spoofing `model_transport_error:<secret>`
    // MUST reduce strictly to `model_provider_stream_error` (0 characters extracted from stream body!)
    const ECHOED_MODEL_STREAM_SECRET = `STREAMSEC${runId.replace(/[^A-Za-z0-9]/g, "")}`;
    const streamErrRoutine = createRoutineWithGovernance(host.govDb, {
      principalId: "owner",
      scopeId: "scope:default",
      name: "Model HTTP 200 Stream Error Boundary Routine",
      prompt: "Trigger provider HTTP 200 in-stream error check",
      timezone: "Asia/Hong_Kong",
      scheduleSpec: { kind: "once", onceAtUtcMs: fixedNow - 10_000 },
      nextRunUtcMs: fixedNow - 10_000,
      confirmed: true,
      now: fixedNow,
    });
    assert.equal(streamErrRoutine.ok, true);
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "stream_error",
          errorMessage: `model_transport_error:${ECHOED_MODEL_STREAM_SECRET}`,
        },
      ],
    });
    const streamErrPoll = await host.routinePoller!.pollOnce();
    assert.equal(streamErrPoll.admittedCount, 1);
    const streamErrTrigRow = await waitFor(
      () =>
        host!.govDb
          .prepare("SELECT * FROM routine_triggers WHERE routine_id = ? LIMIT 1")
          .get(streamErrRoutine.routine.routine_id) as { state: string; reason: string | null } | undefined,
      (r) => Boolean(r && r.state === "FAILED"),
      10_000,
    );
    assert.equal(
      streamErrTrigRow!.reason,
      "model_provider_stream_error",
      "HTTP 200 in-stream error MUST NEVER extract untrusted alphanumeric tokens",
    );
    const streamErrRoutineRow = host.govDb
      .prepare("SELECT last_status, last_result_summary FROM routines WHERE routine_id = ?")
      .get(streamErrRoutine.routine.routine_id) as { last_status: string; last_result_summary: string | null };
    assert.equal(streamErrRoutineRow.last_status, "FAILED");
    assert.ok(streamErrRoutineRow.last_result_summary?.includes("model_provider_stream_error"));
    assert.ok(!JSON.stringify(streamErrRoutineRow).includes(ECHOED_MODEL_STREAM_SECRET));

    // S2-P0-4 (Round 3): Malicious remote SMTP echoing alphanumeric `queued as <secret>` in 250 OK AND 550 error -> 0 persisted/projected leaks!
    const ECHOED_SMTP_SECRET = `QIDSECRET-${runId.replace(/[^A-Za-z0-9]/g, "")}`;
    const smtpCtrlBase = `http://${fakeSmtp.host}:${fakeSmtp.controlPort}`;
    await fetch(`${smtpCtrlBase}/__control/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "normal", echoText: `queued as ${ECHOED_SMTP_SECRET}` }),
    });
    const convEcho = await host.createManagedConversation({ principalId: "owner", slotName: "router" });
    // S2-P0-1: Even if caller passes strictPlainTextEmail: false in Stage 2, submitter MUST still reject cc/extra fields BEFORE T4 claim!
    const smtpBeforeUnsupported = (await fakeSmtp.stats()).totalReceived;
    const ccProp = proposeOrGetApproval(host.govDb, {
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convEcho.id),
      toolTaskId: "88000",
      callId: "echo_smtp_cc_bypass_1",
      scopeId: "scope:default",
      toolName: "send_email",
      target: "smtp:approved@local.test",
      payload: { to: ["approved@local.test"], subject: "Boundary check", body: "Plain text" },
      expiresAt: fixedNow + 60_000,
      now: fixedNow,
    });
    const ccDec = decideApproval(host.govDb, {
      approvalId: ccProp.approval.approval_id,
      conversationId: String(convEcho.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: ccProp.revision.action_hash,
      nonce: ccProp.nonce!,
      decisionKey: `dk-cc-bypass-${runId}`,
      now: fixedNow,
    });
    assert.equal(ccDec.ok, true);
    const ccBypassSubRes = await submitApprovedEmailEffect({
      govDb: host.govDb,
      runtimeEpoch: host.runtimeEpoch,
      effectId: ccDec.effectId!,
      conversationId: String(convEcho.id),
      toolTaskId: "88000",
      callId: "echo_smtp_cc_bypass_1",
      toolName: "send_email",
      finalTarget: "smtp:approved@local.test",
      finalPayload: {
        to: ["approved@local.test"],
        cc: ["hidden@local.test"],
        subject: "Boundary check",
        body: "Plain text",
      },
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "owner@local.test" },
      egressPolicy: { stage: 2 },
      strictPlainTextEmail: false,
      allowedEmailRecipients: ["approved@local.test"],
      now: () => fixedNow,
    });
    assert.equal(ccBypassSubRes.claimed, false);
    assert.equal(ccBypassSubRes.code, "unsupported_email_field_cc");
    assert.equal((await fakeSmtp.stats()).totalReceived, smtpBeforeUnsupported);

    const echoProp = proposeOrGetApproval(host.govDb, {
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convEcho.id),
      toolTaskId: "88001",
      callId: "echo_smtp_ok_1",
      scopeId: "scope:default",
      toolName: "send_email",
      target: "smtp:approved@local.test",
      payload: { to: ["approved@local.test"], subject: "Boundary check", body: "Plain text" },
      expiresAt: fixedNow + 60_000,
      now: fixedNow,
    });
    const echoDec = decideApproval(host.govDb, {
      approvalId: echoProp.approval.approval_id,
      conversationId: String(convEcho.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: echoProp.revision.action_hash,
      nonce: echoProp.nonce!,
      decisionKey: `dk-echo-ok-${runId}`,
      now: fixedNow,
    });
    assert.equal(echoDec.ok, true);
    const echoSubRes = await submitApprovedEmailEffect({
      govDb: host.govDb,
      runtimeEpoch: host.runtimeEpoch,
      effectId: echoDec.effectId!,
      conversationId: String(convEcho.id),
      toolTaskId: "88001",
      callId: "echo_smtp_ok_1",
      toolName: "send_email",
      finalTarget: "smtp:approved@local.test",
      finalPayload: { to: ["approved@local.test"], subject: "Boundary check", body: "Plain text" },
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "owner@local.test" },
      egressPolicy,
      strictPlainTextEmail: true,
      allowedEmailRecipients: ["approved@local.test"],
      now: () => fixedNow,
    });
    assert.equal(echoSubRes.ok, true, `echoSubRes failed: ${JSON.stringify(echoSubRes)}`);
    assert.equal(echoSubRes.receiptRef, "smtp:250:accepted");
    assert.ok(!JSON.stringify(echoSubRes).includes(ECHOED_SMTP_SECRET));

    await fetch(`${smtpCtrlBase}/__control/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "reject_550", echoText: ECHOED_SMTP_SECRET }),
    });
    const echoErrProp = proposeOrGetApproval(host.govDb, {
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convEcho.id),
      toolTaskId: "88002",
      callId: "echo_smtp_err_1",
      scopeId: "scope:default",
      toolName: "send_email",
      target: "smtp:approved@local.test",
      payload: { to: ["approved@local.test"], subject: "Boundary err check", body: "Plain text" },
      expiresAt: fixedNow + 60_000,
      now: fixedNow,
    });
    const echoErrDec = decideApproval(host.govDb, {
      approvalId: echoErrProp.approval.approval_id,
      conversationId: String(convEcho.id),
      principalId: "owner",
      decision: "APPROVE",
      expectedRevision: 1,
      expectedActionHash: echoErrProp.revision.action_hash,
      nonce: echoErrProp.nonce!,
      decisionKey: `dk-echo-err-${runId}`,
      now: fixedNow,
    });
    const echoErrRes = await submitApprovedEmailEffect({
      govDb: host.govDb,
      runtimeEpoch: host.runtimeEpoch,
      effectId: echoErrDec.effectId!,
      conversationId: String(convEcho.id),
      toolTaskId: "88002",
      callId: "echo_smtp_err_1",
      toolName: "send_email",
      finalTarget: "smtp:approved@local.test",
      finalPayload: { to: ["approved@local.test"], subject: "Boundary err check", body: "Plain text" },
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "owner@local.test" },
      egressPolicy,
      strictPlainTextEmail: true,
      allowedEmailRecipients: ["approved@local.test"],
      now: () => fixedNow,
    });
    assert.equal(echoErrRes.ok, false);
    assert.ok(!JSON.stringify(echoErrRes).includes(ECHOED_SMTP_SECRET));
    await fetch(`${smtpCtrlBase}/__control/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "normal", echoText: "" }),
    });

    // S2-P0-5, S2-P0-1 draft edit, S2-P0-3b HTTP Pin API, S2-P1-1 scope upgrade, S2-P1-4 billing day aggregation
    const auditWeb = await startWebServer({
      host,
      port: 0,
      uiMode: "stage2",
      consoleTokens: { owner: consoleToken, guest: `guest-tok-${runId}` },
      defaultPrincipalId: "owner",
      now: () => fixedNow,
    });
    try {
      const loginR = await fetch(`${auditWeb.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: auditWeb.baseUrl },
        body: JSON.stringify({ token: consoleToken }),
      });
      assert.equal(loginR.status, 200);
      const cookieHdr = (loginR.headers.get("set-cookie") ?? "").split(";")[0]!;
      const authHeaders = { cookie: cookieHdr, "content-type": "application/json", origin: auditWeb.baseUrl };

      // S2-P0-3d over HTTP: guest principal without skill grant gets 403 on GET /api/skills/:id/body
      const guestLogin = await fetch(`${auditWeb.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: auditWeb.baseUrl },
        body: JSON.stringify({ token: `guest-tok-${runId}` }),
      });
      assert.equal(guestLogin.status, 200);
      const guestCookie = (guestLogin.headers.get("set-cookie") ?? "").split(";")[0]!;
      const guestSkillRes = await fetch(`${auditWeb.baseUrl}/api/skills/weekly-brief-helper/body`, {
        headers: { cookie: guestCookie },
      });
      assert.equal(guestSkillRes.status, 403);

      const convRev = await host.createManagedConversation({ principalId: "owner", slotName: "router" });
      const memGrant = grantSourceRead(host.govDb, {
        principalId: "owner",
        scopeId: "scope:default",
        sourceType: "memory",
        resourceId: "memory:rev-test-domain",
        operations: ["read"],
        now: fixedNow,
      });
      recordConversationSource(host.govDb, {
        runtimeEpoch: host.runtimeEpoch,
        conversationId: String(convRev.id),
        principalId: "owner",
        sourceType: "memory",
        sourceId: "memory:secret-note-r1",
        versionRef: "v1",
        title: "Secret Source",
        contentDigest: "deadbeef",
        metadata: { domain: "rev-test-domain" },
        now: fixedNow,
      });
      const revProp = proposeOrGetApproval(host.govDb, {
        runtimeEpoch: host.runtimeEpoch,
        conversationId: String(convRev.id),
        toolTaskId: "88009",
        callId: "rev_draft_1",
        scopeId: "scope:default",
        toolName: "send_email",
        target: "smtp:confidential@local.test",
        payload: { to: ["confidential@local.test"], subject: "TOP_SECRET_SUBJECT", body: "TOP_SECRET_BODY" },
        expiresAt: fixedNow + 60_000,
        now: fixedNow,
      });
      const badDraftRes = await fetch(`${auditWeb.baseUrl}/api/proposals/${revProp.proposal.proposal_id}/draft`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          conversationId: String(convRev.id),
          expectedHeadRev: 1,
          target: "smtp:confidential@local.test",
          payload: { to: ["confidential@local.test"], subject: "Evil\r\nBcc: x@y.z", body: "x" },
        }),
      });
      assert.equal(badDraftRes.status, 400);

      // S2-P0-5 (Round 3): Also attach an approved effect with receipt/reason/reconcile_evidence on convRev
      // AND a completed routine linked to a conversation reading the SAME source grant!
      const revEffProp = proposeOrGetApproval(host.govDb, {
        runtimeEpoch: host.runtimeEpoch,
        conversationId: String(convRev.id),
        toolTaskId: "88010",
        callId: "rev_eff_1",
        scopeId: "scope:default",
        toolName: "send_email",
        target: "smtp:confidential@local.test",
        payload: { to: ["confidential@local.test"], subject: "EFF_SECRET_SUBJ", body: "EFF_SECRET_BODY" },
        expiresAt: fixedNow + 60_000,
        now: fixedNow,
      });
      const revEffDec = decideApproval(host.govDb, {
        approvalId: revEffProp.approval.approval_id,
        conversationId: String(convRev.id),
        principalId: "owner",
        decision: "APPROVE",
        expectedRevision: 1,
        expectedActionHash: revEffProp.revision.action_hash,
        nonce: revEffProp.nonce!,
        decisionKey: `dk-rev-eff-${runId}`,
        now: fixedNow,
      });
      assert.equal(revEffDec.ok, true);
      host.govDb
        .prepare(
          `UPDATE effects
              SET state = 'SUCCEEDED',
                  receipt_ref = 'SENSITIVE_EFFECT_RECEIPT',
                  reason = 'SENSITIVE_EFFECT_REASON',
                  reconciled_by = 'owner',
                  reconcile_evidence = 'SENSITIVE_RECONCILE_EVIDENCE'
            WHERE effect_id = ?`,
        )
        .run(revEffDec.effectId!);

      const revRoutine = createRoutineWithGovernance(host.govDb, {
        principalId: "owner",
        scopeId: "scope:default",
        name: "Revocation Guarded Routine",
        prompt: "Summarize sensitive domain",
        timezone: "Asia/Hong_Kong",
        scheduleSpec: { kind: "once", onceAtUtcMs: fixedNow + 86_400_000 },
        nextRunUtcMs: fixedNow + 86_400_000,
        confirmed: true,
        now: fixedNow,
      });
      assert.equal(revRoutine.ok, true);
      const revTrigId = `trig_rev_${runId}`;
      host.govDb
        .prepare(
          `INSERT INTO routine_triggers(
             trigger_id, routine_id, scheduled_instant_utc, correlation_key, conversation_id,
             pi_request_id, submission_id, state, reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'ADMITTED', NULL, ?, ?)`,
        )
        .run(
          revTrigId,
          revRoutine.routine.routine_id,
          fixedNow,
          `rk:rev:${runId}`,
          String(convRev.id),
          fixedNow,
          fixedNow,
        );
      recordRoutineTriggerCompletion(host.govDb, {
        triggerId: revTrigId,
        routineId: revRoutine.routine.routine_id,
        conversationId: String(convRev.id),
        status: "SUCCEEDED",
        summary: "SENSITIVE_ROUTINE_SUMMARY_TEXT",
        now: fixedNow,
      });

      // S2-P0-5 (Round 4): Out-of-order routine completions — earlier run (convRev, revoked) finishes AFTER newer run (convClean, authorized)!
      // Summary provenance MUST follow exact producing trigger_id (older revoked trigger), NOT newest scheduled trigger!
      const convClean = await host.createManagedConversation({ principalId: "owner", slotName: "router" });
      const oooRoutine = createRoutineWithGovernance(host.govDb, {
        principalId: "owner",
        scopeId: "scope:default",
        name: "Out-Of-Order Provenance Routine",
        prompt: "Check out-of-order completion authorization",
        timezone: "Asia/Hong_Kong",
        scheduleSpec: { kind: "daily", hour: 9, minute: 0 },
        nextRunUtcMs: fixedNow + 86_400_000,
        confirmed: true,
        now: fixedNow,
      });
      assert.equal(oooRoutine.ok, true);
      const oooOlderTrigId = `trig_ooo_old_${runId}`;
      const oooNewerTrigId = `trig_ooo_new_${runId}`;
      host.govDb
        .prepare(
          `INSERT INTO routine_triggers(
             trigger_id, routine_id, scheduled_instant_utc, correlation_key, conversation_id,
             pi_request_id, submission_id, state, reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'ADMITTED', NULL, ?, ?),
                    (?, ?, ?, ?, ?, NULL, NULL, 'ADMITTED', NULL, ?, ?)`,
        )
        .run(
          oooOlderTrigId,
          oooRoutine.routine.routine_id,
          fixedNow - 60_000,
          `rk:ooo-old:${runId}`,
          String(convRev.id),
          fixedNow - 60_000,
          fixedNow - 60_000,
          oooNewerTrigId,
          oooRoutine.routine.routine_id,
          fixedNow,
          `rk:ooo-new:${runId}`,
          String(convClean.id),
          fixedNow,
          fixedNow,
        );
      // Newer authorized run finishes FIRST...
      recordRoutineTriggerCompletion(host.govDb, {
        triggerId: oooNewerTrigId,
        routineId: oooRoutine.routine.routine_id,
        conversationId: String(convClean.id),
        status: "SUCCEEDED",
        summary: "CLEAN_NEWER_AUTHORIZED_SUMMARY",
        now: fixedNow + 100,
      });
      // ...then older run (which read the revoked source) finishes SECOND, overwriting last_result_summary!
      recordRoutineTriggerCompletion(host.govDb, {
        triggerId: oooOlderTrigId,
        routineId: oooRoutine.routine.routine_id,
        conversationId: String(convRev.id),
        status: "SUCCEEDED",
        summary: "OLDER_REVOKED_OUT_OF_ORDER_SUMMARY_SECRET",
        now: fixedNow + 200,
      });

      // Also verify fail-closed redaction when summary provenance (last_result_trigger_id) is missing/unknown!
      const legacyNullProvRoutine = createRoutineWithGovernance(host.govDb, {
        principalId: "owner",
        scopeId: "scope:default",
        name: "Unknown Provenance Legacy Routine",
        prompt: "Legacy routine without trigger provenance",
        timezone: "Asia/Hong_Kong",
        scheduleSpec: { kind: "once", onceAtUtcMs: fixedNow + 86_400_000 },
        nextRunUtcMs: fixedNow + 86_400_000,
        confirmed: true,
        now: fixedNow,
      });
      assert.equal(legacyNullProvRoutine.ok, true);
      host.govDb
        .prepare("UPDATE routines SET last_status = 'SUCCEEDED', last_result_summary = 'UNPROVEN_SUMMARY_SECRET', last_result_trigger_id = NULL WHERE routine_id = ?")
        .run(legacyNullProvRoutine.routine.routine_id);

      revokeSourceReadGrant(host.govDb, { grantId: memGrant.grant_id, reason: "p0_5_test", now: fixedNow + 1 });
      const snapAfterRev = (await (
        await fetch(`${auditWeb.baseUrl}/api/conversations/${convRev.id}/snapshot`, { headers: { cookie: cookieHdr } })
      ).json()) as {
        proposals: Array<{
          proposalId: string;
          target: string;
          draftRedacted?: boolean;
          hasChallenge: boolean;
          snapshot: Record<string, unknown>;
          effect: { receiptRef: string | null; reason: string | null; reconcileEvidence: string | null } | null;
        }>;
      };
      const view1Prop = snapAfterRev.proposals.find((p) => p.proposalId === revProp.proposal.proposal_id)!;
      assert.equal(view1Prop.draftRedacted, true);
      assert.equal(view1Prop.hasChallenge, false);
      assert.equal(view1Prop.target, "[redacted_after_source_revocation]");
      assert.ok(!JSON.stringify(view1Prop.snapshot).includes("TOP_SECRET_BODY"));
      const view1EffProp = snapAfterRev.proposals.find((p) => p.proposalId === revEffProp.proposal.proposal_id)!;
      assert.equal(view1EffProp.effect?.receiptRef, "[redacted_after_source_revocation]");
      assert.equal(view1EffProp.effect?.reason, "[redacted_after_source_revocation]");
      assert.equal(view1EffProp.effect?.reconcileEvidence, null);
      assert.ok(!JSON.stringify(snapAfterRev).includes("SENSITIVE_EFFECT_RECEIPT"));
      assert.ok(!JSON.stringify(snapAfterRev).includes("SENSITIVE_EFFECT_REASON"));
      assert.ok(!JSON.stringify(snapAfterRev).includes("SENSITIVE_RECONCILE_EVIDENCE"));

      const view3AfterRev = (await (
        await fetch(`${auditWeb.baseUrl}/api/approvals`, { headers: { cookie: cookieHdr } })
      ).json()) as {
        approvals: Array<{
          proposalId: string;
          target: string;
          uiStatusLabel?: string;
          draftRedacted?: boolean;
          hasChallenge: boolean;
          snapshot: Record<string, unknown>;
          effect: { state?: string; receiptRef: string | null; reason: string | null; reconcileEvidence: string | null } | null;
        }>;
      };
      const view3Prop = view3AfterRev.approvals.find((p) => p.proposalId === revProp.proposal.proposal_id)!;
      assert.equal(view3Prop.draftRedacted, true);
      assert.equal(view3Prop.hasChallenge, false);
      assert.equal(view3Prop.target, "[redacted_after_source_revocation]");
      assert.ok(!JSON.stringify(view3Prop.snapshot).includes("TOP_SECRET_BODY"));
      assert.ok(!JSON.stringify(view3AfterRev).includes("SENSITIVE_EFFECT_RECEIPT"));
      assert.ok(!JSON.stringify(view3AfterRev).includes("SENSITIVE_RECONCILE_EVIDENCE"));
      const ghSnapObj = (await (
        await fetch(`${auditWeb.baseUrl}/api/conversations/${convGhT0.id}/snapshot`, { headers: { cookie: cookieHdr } })
      ).json()) as {
        proposals: Array<{ proposalId: string; uiStatusLabel?: string; effect: { state?: string } | null }>;
      };
      for (const { proposalId } of unknownGithubWrites) {
        const view3Write = view3AfterRev.approvals.find((p) => p.proposalId === proposalId);
        const view1Write = ghSnapObj.proposals.find((p) => p.proposalId === proposalId);
        assert.equal(view3Write?.effect?.state, "UNKNOWN");
        assert.equal(view3Write?.uiStatusLabel, "结果待核对");
        assert.equal(view1Write?.effect?.state, "UNKNOWN");
        assert.equal(view1Write?.uiStatusLabel, "结果待核对");
      }

      const view2RoutinesAfterRev = (await (
        await fetch(`${auditWeb.baseUrl}/api/routines`, { headers: { cookie: cookieHdr } })
      ).json()) as {
        routines: Array<{
          routineId: string;
          lastResultTriggerId?: string | null;
          lastResultSummary: string | null;
          resultRedacted?: boolean;
          triggers: Array<{ triggerId: string; reason: string | null; redacted?: boolean }>;
        }>;
      };
      const revRoutineView = view2RoutinesAfterRev.routines.find(
        (r) => r.routineId === revRoutine.routine.routine_id,
      )!;
      assert.equal(revRoutineView.resultRedacted, true);
      assert.equal(revRoutineView.lastResultSummary, "[redacted_after_source_revocation]");
      assert.equal(revRoutineView.triggers[0]?.redacted, true);
      assert.equal(revRoutineView.triggers[0]?.reason, "[redacted_after_source_revocation]");
      // Out-of-order completion check: newest trigger (T2) is authorized, older trigger (T1) is revoked & produced summary -> MUST redact!
      const oooRoutineView = view2RoutinesAfterRev.routines.find(
        (r) => r.routineId === oooRoutine.routine.routine_id,
      )!;
      assert.equal(oooRoutineView.triggers[0]?.triggerId, oooNewerTrigId);
      assert.equal(oooRoutineView.triggers[0]?.redacted, false);
      assert.equal(oooRoutineView.triggers[1]?.triggerId, oooOlderTrigId);
      assert.equal(oooRoutineView.triggers[1]?.redacted, true);
      assert.equal(oooRoutineView.lastResultTriggerId, oooOlderTrigId);
      assert.equal(oooRoutineView.resultRedacted, true);
      assert.equal(oooRoutineView.lastResultSummary, "[redacted_after_source_revocation]");
      // Unknown provenance (NULL last_result_trigger_id) MUST fail closed!
      const nullProvView = view2RoutinesAfterRev.routines.find(
        (r) => r.routineId === legacyNullProvRoutine.routine.routine_id,
      )!;
      assert.equal(nullProvView.resultRedacted, true);
      assert.equal(nullProvView.lastResultSummary, "[redacted_after_source_revocation]");
      assert.ok(!JSON.stringify(view2RoutinesAfterRev).includes("SENSITIVE_ROUTINE_SUMMARY_TEXT"));
      assert.ok(!JSON.stringify(view2RoutinesAfterRev).includes("OLDER_REVOKED_OUT_OF_ORDER_SUMMARY_SECRET"));
      assert.ok(!JSON.stringify(view2RoutinesAfterRev).includes("UNPROVEN_SUMMARY_SECRET"));
      assert.ok(!JSON.stringify(view2RoutinesAfterRev).includes(ECHOED_MODEL_SECRET));
      assert.ok(!JSON.stringify(view2RoutinesAfterRev).includes(ECHOED_MODEL_STREAM_SECRET));

      const editAfterRev = await fetch(`${auditWeb.baseUrl}/api/proposals/${revProp.proposal.proposal_id}/draft`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          conversationId: String(convRev.id),
          expectedHeadRev: 1,
          target: "smtp:confidential@local.test",
          payload: { to: ["confidential@local.test"], subject: "Safe", body: "Safe" },
        }),
      });
      assert.equal(editAfterRev.status, 403);
      // APPROVE MUST be blocked with 403 source_read_revoked while REJECT remains available to cancel
      const chalAfterRev = (await (
        await fetch(`${auditWeb.baseUrl}/api/approvals/${revProp.approval.approval_id}/challenge`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ conversationId: String(convRev.id) }),
        })
      ).json()) as { ok: boolean; nonce?: string; revision: number; actionHash: string };
      assert.equal(chalAfterRev.ok, true);
      const approveAfterRev = await fetch(`${auditWeb.baseUrl}/api/approvals/decide`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          approvalId: revProp.approval.approval_id,
          conversationId: String(convRev.id),
          decision: "APPROVE",
          expectedRevision: chalAfterRev.revision,
          expectedActionHash: chalAfterRev.actionHash,
          nonce: chalAfterRev.nonce,
          decisionKey: `dk-rev-app-s2-${runId}`,
        }),
      });
      assert.equal(approveAfterRev.status, 403);

      // Verify Web projections contain 0 echoed SMTP, MCP, or Model secrets
      assert.ok(!JSON.stringify(view3AfterRev).includes(ECHOED_SMTP_SECRET));
      assert.ok(!JSON.stringify(view3AfterRev).includes(ECHOED_MCP_SECRET));
      assert.ok(!JSON.stringify(view3AfterRev).includes(ECHOED_MODEL_SECRET));
      const echoSnapText = await (
        await fetch(`${auditWeb.baseUrl}/api/conversations/${convEcho.id}/snapshot`, { headers: { cookie: cookieHdr } })
      ).text();
      assert.ok(!echoSnapText.includes(ECHOED_SMTP_SECRET));
      const ghSnapText = await (
        await fetch(`${auditWeb.baseUrl}/api/conversations/${convGhT0.id}/snapshot`, { headers: { cookie: cookieHdr } })
      ).text();
      assert.ok(!ghSnapText.includes(ECHOED_MCP_SECRET));

      const pinsJson = (await (
        await fetch(`${auditWeb.baseUrl}/api/mcp/pins`, { headers: { cookie: cookieHdr } })
      ).json()) as { tools: Array<{ canonicalDefJson: string; observedSchemaSha256: string }> };
      assert.ok(pinsJson.tools.length > 0 && pinsJson.tools[0]!.canonicalDefJson.length > 10 && pinsJson.tools[0]!.observedSchemaSha256.length === 64);
      const missingShaApprove = await fetch(`${auditWeb.baseUrl}/api/mcp/pins/github-s2/get_file_contents/approve`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      assert.equal(missingShaApprove.status, 400);

      ensureScope(host.govDb, {
        scopeId: "scope:stage1-legacy-upgrade",
        allowedPrincipals: ["owner"],
        allowedTools: ["send_email", "run_worker"],
        allowedTargets: ["*"],
      });
      assert.equal(
        upgradeStage2ScopeAllowedTools(host.govDb, {
          scopeId: "scope:stage1-legacy-upgrade",
          requiredTools: ["send_email", "run_worker", "github_write_file", "skill_read_body"],
          now: fixedNow,
        }),
        true,
      );
      const upgradedRow = host.govDb
        .prepare("SELECT allowed_tools_json FROM scopes WHERE scope_id = ?")
        .get("scope:stage1-legacy-upgrade") as { allowed_tools_json: string };
      assert.ok((JSON.parse(upgradedRow.allowed_tools_json) as string[]).includes("github_write_file"));

      const budgetBefore = (await (
        await fetch(`${auditWeb.baseUrl}/api/budget/summary`, { headers: { cookie: cookieHdr } })
      ).json()) as { chargeDay: string; totals: { settledMu: number } };
      host.govDb
        .prepare(
          `INSERT OR IGNORE INTO budget_accounts(account_id, kind, limit_mu, held_mu, charged_mu, frozen)
           VALUES ('acct:task:old', 'TASK', 1000000, 0, 0, 0),
                  ('acct:day:Asia/Hong_Kong:2020-01-01', 'DAY', 5000000, 0, 0, 0)`,
        )
        .run();
      const stmtIns = host.govDb.prepare(
        `INSERT INTO budget_reservations(
           request_id, runtime_epoch, conversation_id, owner_task_id, purpose,
           task_account, day_account, charge_day, zone, binding_json,
           upper_mu, actual_mu, reserved_at, settle_due_at, state
         ) VALUES (?, ?, ?, ?, 'router', 'acct:task:old', 'acct:day:Asia/Hong_Kong:2020-01-01', '2020-01-01', 'Asia/Hong_Kong', '{}', 100, 99, ?, ?, 'SETTLED')`,
      );
      for (let i = 0; i < 105; i++) {
        stmtIns.run(`req_old_${runId}_${i}`, host.runtimeEpoch, "1", "task_old", fixedNow + 5000 + i, fixedNow + 60000);
      }
      const budgetAfter = (await (
        await fetch(`${auditWeb.baseUrl}/api/budget/summary`, { headers: { cookie: cookieHdr } })
      ).json()) as { totals: { settledMu: number }; reservations: unknown[] };
      assert.equal(budgetAfter.totals.settledMu, budgetBefore.totals.settledMu);
      assert.equal(budgetAfter.reservations.length, 100);
    } finally {
      await auditWeb.close();
    }

    // Close & restart host on same dataDir -> verify routine trigger stays deduplicated = 1 & background message persisted!
    await (bridge as GitHubMcpBridge | null)?.close();
    bridge = null;
    await host.close();
    host = null;

    const restartedHost = await AegisHostRuntime.start({
      dataDir: hostDataDir,
      vault,
      modelSlots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "owner@local.test" },
      egressPolicy,
      fetchImpl: fetchDeepSeekFixture,
      skillsEnabled: true,
      routinesEnabled: true,
      routinePollIntervalMs: 60_000,
      now: () => fixedNow,
    });
    const triggersAfterRestart = (
      restartedHost.govDb
        .prepare("SELECT count(*) AS n FROM routine_triggers WHERE routine_id = ?")
        .get(created1.routine.routine_id) as { n: number }
    ).n;
    assert.equal(triggersAfterRestart, 1);
    const pollAfterRestart = await restartedHost.routinePoller!.pollOnce();
    assert.equal(pollAfterRestart.admittedCount, 0);
    await restartedHost.close();

    // =========================================================================
    // 7. P0-4 S6 Stage 2 Zero-Leak Scan across Both SQLite DBs + WAL + Fake Logs (incl. echoed secrets!)
    // =========================================================================
    const markers = [
      { slotId: "slot:model-router", marker: routerKey },
      { slotId: "slot:model-worker", marker: workerKey },
      { slotId: "slot:tls-smtp", marker: tlsSmtpSecret },
      { slotId: "slot:github-mcp-pat", marker: mcpPat },
      { slotId: "slot:web-console", marker: consoleToken },
      { slotId: "slot:echoed-smtp-boundary", marker: ECHOED_SMTP_SECRET },
      { slotId: "slot:echoed-mcp-boundary", marker: ECHOED_MCP_SECRET },
      { slotId: "slot:echoed-mcp-read-boundary", marker: ECHOED_MCP_READ_SECRET },
      { slotId: "slot:echoed-mcp-list-boundary", marker: ECHOED_MCP_LIST_SECRET },
      { slotId: "slot:echoed-model-http-boundary", marker: ECHOED_MODEL_SECRET },
      { slotId: "slot:echoed-model-stream-boundary", marker: ECHOED_MODEL_STREAM_SECRET },
    ];
    const filesToScan = [
      path.join(hostDataDir, "aegis-gov.sqlite"),
      path.join(hostDataDir, "aegis-gov.sqlite-wal"),
      path.join(hostDataDir, "pi-durable.sqlite"),
      path.join(hostDataDir, "pi-durable.sqlite-wal"),
      fakeModel.logPath,
      mcpLogPath,
    ].filter((p) => existsSync(p));

    let totalLeakHits = 0;
    const scannedFiles: Array<{ file: string; bytes: number; hits: number }> = [];
    for (const f of filesToScan) {
      const buf = readFileSync(f);
      const scan = scanBufferInMemory(buf, markers);
      totalLeakHits += scan.totalForbiddenHits;
      scannedFiles.push({ file: path.basename(f), bytes: scan.scannedBytes, hits: scan.totalForbiddenHits });
    }
    if (existsSync(fakeSmtp.logPath)) {
      const buf = readFileSync(fakeSmtp.logPath);
      const scan = scanBufferInMemory(buf, markers.filter((m) => m.slotId !== "slot:echoed-smtp-boundary"));
      totalLeakHits += scan.totalForbiddenHits;
      scannedFiles.push({ file: path.basename(fakeSmtp.logPath), bytes: scan.scannedBytes, hits: scan.totalForbiddenHits });
    }
    assert.equal(totalLeakHits, 0, `Detected secret leaks: ${JSON.stringify(scannedFiles)}`);

    evidence["p0_4_credentials_zero_leak"] = {
      slotsChecked: markers.map((m) => m.slotId),
      scannedFiles,
      totalForbiddenHits: totalLeakHits,
    };
    evidence["round4_p0_closure"] = {
      s2_p0_1_githubWriteTransportDropPersistedUnknownAndDisplayedPendingReconcile: true,
      s2_p0_1_githubWriteDropIndependentWriteDelta: unknownGithubWrites[0]!.appliedCount,
      s2_p0_2_stage2MissingModelProfileRefusedStartup: true,
      s2_p0_2_retiredDeepseekChatAndZeroAndBelowPeakRatesRejected: true,
      s2_p0_2_deepseekFlashRealContractNormalTaskUpperMu: dsNormalUpperMu,
      s2_p0_2_deepseekFlashWireThinkingDisabledVerified: dsWireThinkingDisabledVerified,
      s2_p0_2_deepseekFlashWireMaxTokensVerified: dsWireMaxTokensVerified,
      s2_p0_2_deepseekFlashBudgetExhaustedHttpDelta: dsExhaustedHttpDelta,
      s2_p0_4_mcpConnectivityAndRecheckListErrorReducedZeroHits: true,
      s2_p0_4_modelHttp200InStreamErrorReducedToFixedCodeZeroHits: true,
      s2_p0_5_outOfOrderRoutineCompletionBoundToProducingTriggerIdRedacted: true,
      s2_p0_5_unknownProvenanceNullTriggerIdFailClosedRedacted: true,
    };
    evidence["round5_p0_closure"] = {
      githubUnknownWrites: unknownGithubWrites.map(({ mode, reason, dispatchCount, appliedCount }) => ({
        mode, reason, dispatchCount, appliedCount, state: "UNKNOWN", views1And3Status: "结果待核对",
      })),
      invalidModelProfiles,
      invalidModelProfileHttpDelta,
    };
    evidence["round3_p0_closure"] = {
      s2_p0_1_stage2StrictPlainTextMandatoryAndExtraFieldBlocked: true,
      s2_p0_2_loopbackRealProxyAndUnprovenModelBlocked: true,
      s2_p0_3_redriftWhileQuarantinedUpdatedAndAbsentToolApprovalRejected409: true,
      s2_p0_4_smtpQidAndModel401AndRoutineErrAndMcpReadErrReducedZeroHits: true,
      s2_p0_5_view1EffectsAndView2RoutinesRedactedOnRevoke: true,
    };
    evidence["round1_p0_and_p1_remediation"] = {
      s2_p0_1_crlfAndRecipientAllowlistBlocked: true,
      s2_p0_2_remoteRealPriceScheduleRequired: true,
      s2_p0_3a_listChangedPausedAndQuarantined: true,
      s2_p0_3b_pinApprovalBoundToCanonicalDef409OnStale: true,
      s2_p0_3c_controlledToolBoundAndEmptyPathDeniedAndUnconfirmedRefEscalated: true,
      s2_p0_3d_skillReadAndL3ExecGrantsEnforced: true,
      s2_p0_4_remoteEchoedSecretsReducedAtBoundaryZeroHits: true,
      s2_p0_5_view3AndView1RedactedIdenticallyAfterRevoke: true,
      s2_p1_1_stage1ScopeUpgradeVerified: true,
      s2_p1_2_sameConvTask1V1Task2V2Verified: true,
      s2_p1_4_billingDayAggregationVerifiedAcross105OtherDayRows: true,
    };
    evidence["p0_5_skills_routines_hono_mobile"] = {
      skills3LevelAndLockVerified: true,
      routineRuleRevokeReconfirmVerified: true,
      routineMissedPeriodsCollapsedTo1: triggersCount === 1 && triggersAfterRestart === 1,
      routinePauseStoppedFutureTriggers: pollPaused.admittedCount === 0,
      honoClosedBackgroundCompleted: true,
      mobileHttpsBadConfigRejected: badHttpsRejected,
      mobileHttpsHostPrefixCookieVerified: true,
      mobileHttpsCrossOrigin403Verified: true,
      mobileHttpsLogoutRevokedSession: true,
    };
    evidence["status"] = "PASS";

    const evPath = path.join(evidenceDir, "stage2-p0-core-evidence.json");
    writeFileSync(evPath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
    return { report: evidence, evidencePath: evPath };
  } finally {
    await (bridge as GitHubMcpBridge | null)?.close().catch(() => {});
    await host?.close().catch(() => {});
    await fakeModel.stop().catch(() => {});
    await fakeSmtp.stop().catch(() => {});
    await tlsSmtp.stop().catch(() => {});
    await connectProxy.stop().catch(() => {});
    if (!opts?.dataDir) {
      await rmDirWithRetry(rootDir);
    }
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isDirect) {
  const cli = parseWeek2CliArgs(process.argv.slice(2));
  runStage2P0Core({ dataDir: cli.dataDir, evidenceDir: cli.evidenceDir })
    .then((r) => {
      console.log(JSON.stringify(r.report, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
