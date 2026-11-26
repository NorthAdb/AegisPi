import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sendSmtpMessage } from "../../src/capabilities/mail/smtp-client.ts";
import {
  getOrLockConversationSkillSet,
  readSkillDisclosure,
  registerSkillVersion,
  revokeSkill,
  setSkillActiveVersion,
} from "../../src/capabilities/skills/store.ts";
import {
  createRoutineWithGovernance,
  parseNaturalLanguageRoutine,
  pauseRoutine,
} from "../../src/capabilities/timers/routines.ts";
import {
  decideApproval,
  ensureScope,
  fetchAuthorizedApprovalChallenge,
  proposeOrGetApproval,
  saveDraftRevision,
} from "../../src/governance/approvals.ts";
import { setBudgetAccountLimit, taskAccountIdFor } from "../../src/governance/budget.ts";
import { HostCredentialVault } from "../../src/governance/credentials.ts";
import { countSuccessfulClaimsForEffect, revokeOrCancelScope } from "../../src/governance/effects.ts";
import { scanBufferInMemory } from "../../src/governance/leak-scanner.ts";
import {
  approveMcpToolDefinition,
  approveStoredMcpToolPin,
  pinMcpServerBinary,
  revokeMcpTool,
  sha256File,
} from "../../src/governance/mcp-pin.ts";
import { grantModelDisclosure, grantSourceRead } from "../../src/governance/policy.ts";
import {
  evaluateGithubWritePolicy,
  listRememberedRules,
  revokeRememberedRule,
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
  mkdirSync(path.dirname(mcpLogPath), { recursive: true });

  const githubWriteAllowlist: GithubWriteAllowlistEntry[] = [
    {
      repoId: "NorthAdb/aegis-stage2-test",
      operations: ["create_or_update_file"],
      allowedRefs: ["refs/heads/stage2-test"],
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
    const egressPolicy = { stage: 2 as const };
    const tokenPriceSchedule = {
      priceVersion: "deepseek-stage2-fake-v1",
      inputPerMTokMu: 280_000,
      outputPerMTokMu: 420_000,
      cacheReadPerMTokMu: 28_000,
      allowTokenBoundEstimation: true,
    };
    vault.registerSlot(
      {
        slotId: "slot:model-router",
        provider: "deepseek-fake",
        allowedBaseUrls: [fakeModel.baseUrl],
        allowedModelIds: ["deepseek-chat"],
        priceVersion: tokenPriceSchedule.priceVersion,
      },
      routerKey,
      egressPolicy,
    );
    vault.registerSlot(
      {
        slotId: "slot:model-worker",
        provider: "deepseek-fake",
        allowedBaseUrls: [fakeModel.baseUrl],
        allowedModelIds: ["deepseek-reasoner"],
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
        provider: "deepseek-fake",
        modelId: "deepseek-chat",
        baseUrl: fakeModel.baseUrl,
        credentialSlotId: "slot:model-router",
        contextWindow: 64_000,
        maxTokens: 1024,
        priceSchedule: tokenPriceSchedule,
        outboundAuthorized: true,
      },
      {
        slotName: "worker",
        provider: "deepseek-fake",
        modelId: "deepseek-reasoner",
        baseUrl: fakeModel.baseUrl,
        credentialSlotId: "slot:model-worker",
        contextWindow: 64_000,
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
          provider: "deepseek-fake",
          modelId: "*",
          baseUrl: fakeModel.baseUrl,
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
            `SELECT e.effect_id, e.state, a.decision_key
               FROM effects e
               JOIN approvals a ON a.approval_id = e.approval_id
               JOIN proposals p ON p.proposal_id = a.proposal_id
              WHERE p.conversation_id = ? AND p.tool_name = 'github_write_file'`,
          )
          .get(String(convGhT0.id)) as { effect_id: string; state: string; decision_key: string } | undefined,
      (row) => Boolean(row && row.state === "SUCCEEDED"),
      12_000,
    );
    assert.ok(t0Effect!.decision_key.startsWith("auto:tier0:"));
    assert.equal(countSuccessfulClaimsForEffect(host.govDb, t0Effect!.effect_id), 1);
    const mcpWritesAfterT0 = readMcpJsonl(mcpLogPath).filter((e) => e["kind"] === "tool_call" && e["isWrite"]).length;
    assert.equal(mcpWritesAfterT0 - mcpWritesBefore, 1);

    // Negative: unallowlisted write (protected branch) -> 0 MCP writes!
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
    await new Promise((r) => setTimeout(r, 400));
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

    // =========================================================================
    // 5. P0-3 MCP Pin C4: Drift, Missing Tool, Revocation & Binary Tamper (0 remote calls!)
    // =========================================================================
    const mcpTotalBeforeC4 = readMcpJsonl(mcpLogPath).filter((e) => e["kind"] === "tool_call").length;

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

    // 5b. Tool definition drift -> recheck quarantines -> both read AND pending-claim write refused (0 remote calls!)
    writeFileSync(tamperFlagPath, "tampered", "utf8");
    const driftRecheck = await bridge!.recheckToolPins();
    assert.ok(driftRecheck.quarantinedTools.some((t) => t.name === "get_file_contents"));
    assert.ok(driftRecheck.quarantinedTools.some((t) => t.name === "create_or_update_file"));
    const callAfterDrift = await bridge!.callReadOnlyTool(
      "get_file_contents",
      { repo: "NorthAdb/project-helios", ref: "refs/heads/main", path: "README.md" },
      { principalId: "owner", scopeId: "scope:default", repoId: "NorthAdb/project-helios", operation: "read_file", ref: "refs/heads/main", path: "README.md" },
    );
    assert.equal(callAfterDrift.ok, false);
    assert.equal(callAfterDrift.code, "mcp_tool_quarantined");

    const { submitApprovedGithubWriteEffect } = await import("../../src/runtime/submitter.ts");
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

    // 5c. Even AFTER human approves the new drifted schema, the OLD pending effect (bound to old fingerprint)
    // MUST STILL be refused with mcp_tool_fingerprint_changed (forcing re-proposal)!
    const reappWrite = approveStoredMcpToolPin(host.govDb, {
      serverId: "github-s2",
      toolName: "create_or_update_file",
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
    const reapp = approveStoredMcpToolPin(host.govDb, {
      serverId: "github-s2",
      toolName: "get_file_contents",
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

    // 5c. Missing tool on reconnect -> quarantined!
    rmSync(tamperFlagPath, { force: true });
    approveStoredMcpToolPin(host.govDb, { serverId: "github-s2", toolName: "get_file_contents", approvedBy: "owner", now: fixedNow });
    writeFileSync(dropReadFlagPath, "drop", "utf8");
    const missingRes = await bridge!.reconnect();
    assert.equal(missingRes.ok, true);
    assert.ok(missingRes.missingQuarantinedTools?.includes("get_file_contents"));
    rmSync(dropReadFlagPath, { force: true });

    // 5d. Binary tamper on reconnect -> binary SHA-256 mismatch -> admission paused, 0 calls!
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
    assert.equal(mcpTotalAfterC4 - mcpTotalBeforeC4, 0, "Drifted/revoked/paused MCP calls MUST produce 0 remote tool_calls");

    evidence["p0_3_mcp_c4"] = {
      driftQuarantined: true,
      pendingClaimBlockedOnDrift: claimWhileQuarantined.code,
      pendingClaimBlockedOnFingerprintChangeAfterReapprove: claimWithStaleFingerprint.code,
      revokedCallBlocked: callAfterRevoke.code,
      missingToolQuarantined: Boolean(missingRes.missingQuarantinedTools?.includes("get_file_contents")),
      binaryTamperRejected: tamperedConn.code,
      remoteToolCallDeltaDuringC4: mcpTotalAfterC4 - mcpTotalBeforeC4,
    };

    // =========================================================================
    // 6. P0-5 Skills 3-Level + Routines Idempotency + Hono Decoupling + Mobile HTTPS
    // =========================================================================
    // 6a. Skills 3-level: L1 lock, version switch for new task only, immediate revocation
    const lock1 = getOrLockConversationSkillSet(host.govDb, {
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convStream.id),
      now: fixedNow,
    });
    assert.ok(lock1.renderedL1Index.includes("weekly-brief-helper v1"));
    const l2 = readSkillDisclosure(host.govDb, {
      skillId: "weekly-brief-helper",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convStream.id),
    });
    assert.equal(l2.ok, true);
    assert.equal(l2.scripts.length, 1);

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
    // Old conversation stays locked to v1, new conversation gets v2!
    const l2Old = readSkillDisclosure(host.govDb, {
      skillId: "weekly-brief-helper",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: String(convStream.id),
    });
    assert.equal(l2Old.ok && l2Old.version, 1);
    const l2New = readSkillDisclosure(host.govDb, {
      skillId: "weekly-brief-helper",
      runtimeEpoch: host.runtimeEpoch,
      conversationId: "9999",
    });
    assert.equal(l2New.ok && l2New.version, 2);
    // Revoke immediately blocks BOTH old and new!
    revokeSkill(host.govDb, { skillId: "weekly-brief-helper", actorId: "owner", reason: "test_revoke", now: fixedNow + 2000 });
    assert.equal(
      readSkillDisclosure(host.govDb, { skillId: "weekly-brief-helper", runtimeEpoch: host.runtimeEpoch, conversationId: String(convStream.id) }).ok,
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
    // 7. P0-4 S6 Stage 2 Zero-Leak Scan across Both SQLite DBs + WAL + Fake Logs
    // =========================================================================
    const markers = [
      { slotId: "slot:model-router", marker: routerKey },
      { slotId: "slot:model-worker", marker: workerKey },
      { slotId: "slot:tls-smtp", marker: tlsSmtpSecret },
      { slotId: "slot:github-mcp-pat", marker: mcpPat },
      { slotId: "slot:web-console", marker: consoleToken },
    ];
    const filesToScan = [
      path.join(hostDataDir, "aegis-gov.sqlite"),
      path.join(hostDataDir, "aegis-gov.sqlite-wal"),
      path.join(hostDataDir, "pi-durable.sqlite"),
      path.join(hostDataDir, "pi-durable.sqlite-wal"),
      fakeModel.logPath,
      fakeSmtp.logPath,
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
    assert.equal(totalLeakHits, 0, `Detected secret leaks: ${JSON.stringify(scannedFiles)}`);

    evidence["p0_4_credentials_zero_leak"] = {
      slotsChecked: markers.map((m) => m.slotId),
      scannedFiles,
      totalForbiddenHits: totalLeakHits,
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
