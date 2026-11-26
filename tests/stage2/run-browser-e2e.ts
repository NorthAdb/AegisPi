import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { upsertMemoryNote } from "../../src/capabilities/memory/store.ts";
import { ensureScope } from "../../src/governance/approvals.ts";
import { openGovernanceDb } from "../../src/governance/db.ts";
import { approveMcpToolDefinition, pinMcpServerBinary, sha256File } from "../../src/governance/mcp-pin.ts";
import { grantModelDisclosure, grantSourceRead } from "../../src/governance/policy.ts";
import { ensureActiveEpochAndManifest } from "../../src/governance/recovery.ts";
import {
  LOCKED_NODE_EXE,
  startFakeImapServer,
  startFakeModelServer,
  startFakeSmtpServer,
} from "../fakes/client.ts";
import {
  launchReliableHeadlessBrowser,
  parseWeek2CliArgs,
  rmDirWithRetry,
  type HeadlessBrowserHandle,
} from "../week2/cli-helpers.ts";

interface SpawnedStage2Host {
  pid: number;
  baseUrl: string;
  port: number;
  runtimeEpoch: string;
  stop: () => Promise<void>;
}

async function spawnStage2Host(opts: {
  dataDir: string;
  modelBaseUrl: string;
  smtpHost: string;
  smtpPort: number;
  consoleToken: string;
  connectorsConfigPath: string;
  env: Record<string, string>;
}): Promise<SpawnedStage2Host> {
  const child = spawn(
    LOCKED_NODE_EXE,
    [
      path.resolve("src/index.ts"),
      "--stage",
      "2",
      "--ui-mode",
      "stage2",
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
      "--console-token",
      opts.consoleToken,
      "--connectors-config",
      opts.connectorsConfigPath,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    },
  );

  let stdout = "";
  let stderr = "";
  const ready = await new Promise<{ pid: number; baseUrl: string; port: number; runtimeEpoch: string }>(
    (resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Stage 2 host start timeout. stderr=${stderr}`)), 25_000);
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      const onOut = (d: Buffer): void => {
        stdout += d.toString("utf8");
        for (const line of stdout.split(/\r?\n/)) {
          const tr = line.trim();
          if (!tr.startsWith("{")) continue;
          try {
            const p = JSON.parse(tr) as {
              ready?: boolean;
              pid: number;
              baseUrl: string;
              port: number;
              runtimeEpoch: string;
            };
            if (p.ready) {
              clearTimeout(t);
              child.stdout.off("data", onOut);
              resolve(p);
              return;
            }
          } catch {
            // keep scanning
          }
        }
      };
      child.stdout.on("data", onOut);
      child.once("exit", (c) => {
        clearTimeout(t);
        reject(new Error(`Stage 2 host exited early (${String(c)}). stderr=${stderr}`));
      });
    },
  );

  return {
    ...ready,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          spawnSync("taskkill", ["/PID", String(ready.pid), "/T", "/F"], { windowsHide: true });
          resolve();
        }, 4000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

export async function runStage2BrowserE2E(opts?: { dataDir?: string; evidenceDir?: string }) {
  const runId = `s2_browser_${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(opts?.dataDir ?? `.tmp-stage2-browser-${Date.now()}`);
  const evidenceDir = path.resolve(opts?.evidenceDir ?? path.join(rootDir, "evidence"));
  const hostDataDir = path.join(rootDir, "host-data");
  mkdirSync(hostDataDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  assert.equal(existsSync(path.resolve("web/dist/index.html")), true, "web/dist/index.html must be built before E2E");

  const consoleToken = `SYNTH_S2_BROWSER_TOK_${runId}`;
  const imapSecret = `SYNTH_S2_BROWSER_IMAP_${runId}`;
  const githubPat = `SYNTH_S2_BROWSER_PAT_${runId}`;

  const fakeModel = await startFakeModelServer(path.join(rootDir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(rootDir, "fake-smtp"), { mode: "normal" });
  const fakeImap = await startFakeImapServer(path.join(rootDir, "fake-imap"), {
    certCn: "imap.s2.local.test",
    user: "owner@s2.local.test",
    pass: imapSecret,
  });
  const imapCertPath = path.join(rootDir, "fake-imap", "server-cert.pem");
  const mcpScript = path.resolve("tests/fakes/fake-github-mcp-server.ts");
  const mcpSha = sha256File(mcpScript);
  const mcpLogPath = path.join(rootDir, "fake-mcp", "mcp-calls.jsonl");
  const mcpArgs = [mcpScript, "--log-path", mcpLogPath];

  // Seed governance DB with memory notes, read grants, and MCP binary/tool pins
  const now = Date.now();
  const { db: seedDb } = openGovernanceDb(path.join(hostDataDir, "aegis-gov.sqlite"));
  ensureActiveEpochAndManifest(seedDb, now);
  ensureScope(seedDb, {
    scopeId: "scope:default",
    allowedPrincipals: ["owner"],
    allowedTools: [
      "send_email",
      "run_worker",
      "memory_recall",
      "mail_read_latest",
      "github_read_file",
      "github_write_file",
      "workspace_write_managed",
      "skill_read_body",
      "skill_run_script",
      "routine_create",
    ],
    allowedTargets: ["*"],
  });
  grantSourceRead(seedDb, {
    principalId: "owner",
    scopeId: "scope:default",
    sourceType: "memory",
    resourceId: "memory:default",
    operations: ["read"],
    now,
  });
  grantSourceRead(seedDb, {
    principalId: "owner",
    scopeId: "scope:default",
    sourceType: "imap",
    resourceId: "imap:INBOX",
    operations: ["read"],
    constraints: {
      allowedHosts: [fakeImap.host],
      allowedServernames: ["imap.s2.local.test"],
      allowedUsernames: ["owner@s2.local.test"],
    },
    now,
  });
  grantSourceRead(seedDb, {
    principalId: "owner",
    scopeId: "scope:default",
    sourceType: "github_mcp",
    resourceId: "github:NorthAdb/project-helios",
    operations: ["read_file"],
    constraints: { allowedRefs: ["refs/heads/main"], allowedPaths: ["README.md"] },
    now,
  });
  grantModelDisclosure(seedDb, {
    principalId: "owner",
    scopeId: "scope:default",
    sourceType: "*",
    sourceId: "*",
    provider: "fake-local",
    modelId: "*",
    baseUrl: fakeModel.baseUrl,
    slotName: "*",
    now,
  });
  upsertMemoryNote(seedDb, {
    noteId: "note_s2_l0_focus",
    principalId: "owner",
    scopeId: "scope:default",
    domain: "default",
    tier: "L0",
    title: "Owner Focus",
    body: "Active project: Project Helios (NorthAdb/project-helios). Prefer concise direct answers.",
    now,
  });
  upsertMemoryNote(seedDb, {
    noteId: "note_s2_l1_milestone",
    principalId: "owner",
    scopeId: "scope:default",
    domain: "default",
    tier: "L1",
    title: "Helios Release Milestone",
    body: "Helios milestone review scheduled for Friday 17:00 HKT.",
    now: now + 1,
  });
  pinMcpServerBinary(seedDb, {
    serverId: "github-s2-ui",
    executablePath: mcpScript,
    executableSha256: mcpSha,
    command: LOCKED_NODE_EXE,
    args: mcpArgs,
    readOnlyMode: true,
    approvedBy: "owner",
    now,
  });
  approveMcpToolDefinition(seedDb, {
    serverId: "github-s2-ui",
    def: {
      name: "get_file_contents",
      description: "Read a file from an approved read-only GitHub repository.",
      inputSchema: {
        type: "object",
        properties: { repo: { type: "string" }, ref: { type: "string" }, path: { type: "string" } },
        required: ["repo", "ref", "path"],
      },
    },
    now,
  });
  seedDb.close();

  const connectorsCfgPath = path.join(rootDir, "connectors.json");
  writeFileSync(
    connectorsCfgPath,
    JSON.stringify(
      {
        defaultMemoryDomain: "default",
        skillsEnabled: true,
        routinesEnabled: true,
        strictPlainTextEmail: true,
        imap: {
          mode: "direct",
          host: fakeImap.host,
          port: fakeImap.imapPort,
          servername: "imap.s2.local.test",
          caCertPath: imapCertPath,
          username: "owner@s2.local.test",
          mailbox: "INBOX",
          credentialSlotId: "slot:imap-readonly",
          secretEnvVar: "AEGISPI_IMAP_SECRET",
        },
        githubMcp: {
          serverId: "github-s2-ui",
          command: LOCKED_NODE_EXE,
          args: mcpArgs,
          pinnedArtifactPath: mcpScript,
          pinnedArtifactSha256: mcpSha,
          readOnlyMode: true,
          credentialSlotId: "slot:github-mcp-pat",
          secretEnvVar: "AEGISPI_GITHUB_MCP_PAT",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  let host: SpawnedStage2Host | null = null;
  let browser: HeadlessBrowserHandle | null = null;

  try {
    host = await spawnStage2Host({
      dataDir: hostDataDir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      consoleToken,
      connectorsConfigPath: connectorsCfgPath,
      env: {
        AEGISPI_IMAP_SECRET: imapSecret,
        AEGISPI_GITHUB_MCP_PAT: githubPat,
      },
    });

    browser = await launchReliableHeadlessBrowser();
    const cdp = browser.cdp;
    await cdp.send("Page.enable", {});
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: host.baseUrl });

    // 1. Login in Stage 2 React Console
    await cdp.waitFor(`document.querySelector('[data-login-token]') !== null`, 15_000);
    await cdp.evalJs(`(() => {
      const inp = document.querySelector('[data-login-token]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(consoleToken)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-action="login"]').click();
    })()`);
    await cdp.waitFor(`document.querySelector('[data-view-panel="chat"]') !== null`, 15_000);

    // 2. View ①: Progressive Multi-Chunk Streaming + Refresh Parity
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "text",
          chunks: [
            "第一段实时流式内容：已启动核对。",
            "\n第二段实时流式内容：已读取授权记忆与摘要。",
            "\n第三段实时流式内容：全部核对完成。",
          ],
          chunkDelayMs: 220,
          usage: { prompt_tokens: 180, completion_tokens: 90 },
        },
      ],
    });
    await cdp.evalJs(`document.querySelector('[data-action="new-conversation"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-chat-input]') && !document.querySelector('[data-chat-input]').disabled`, 10_000);
    await cdp.evalJs(`(() => {
      const ta = document.querySelector('[data-chat-input]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '请分段流式输出项目核对进度');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.evalJs(`document.querySelector('[data-action="send-chat"]').click()`);

    // Observe >= 2 distinct progressive partial renders in DOM before completion!
    const seenPartials = new Set<string>();
    const streamPollStart = Date.now();
    while (Date.now() - streamPollStart < 10_000) {
      const state = await cdp.evalJs<{ partial: string; finalText: string }>(`(() => ({
        partial: document.querySelector('[data-live-partial-text]')?.textContent || '',
        finalText: Array.from(document.querySelectorAll('[data-message-role="assistant"]')).map(e => e.textContent || '').join('\\n')
      }))()`);
      if (state.partial) seenPartials.add(state.partial);
      if (state.finalText.includes("第三段实时流式内容：全部核对完成。")) break;
      await new Promise((r) => setTimeout(r, 45));
    }
    assert.ok(seenPartials.size >= 2, `Browser MUST render >=2 progressive partial states before completion; saw ${seenPartials.size}`);

    // Reload browser and confirm final message persists from authoritative snapshot
    await cdp.send("Page.reload", {});
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('[data-message-role="assistant"]')).some(e => (e.textContent || '').includes('第三段实时流式内容：全部核对完成。'))`,
      15_000,
    );
    const firstTokenText = await cdp.evalJs<string>(
      `document.querySelector('[data-metric-first-token]')?.textContent || ''`,
    );

    // 3. View ①: Inline Draft Edit (dirty disables Approve) -> Save -> Approve -> Unique Fake SMTP = 1
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: {
            id: "ui_mail_1",
            name: "send_email",
            arguments: {
              to: ["advisor@s2.local.test"],
              subject: "周报草稿 v1",
              body: "初始草稿正文",
            },
          },
        },
        { kind: "text", text: "邮件已根据最终核准草稿外发。" },
      ],
    });
    await cdp.evalJs(`(() => {
      const ta = document.querySelector('[data-chat-input]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '请起草一封周报回复邮件');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.evalJs(`document.querySelector('[data-action="send-chat"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-approval-card]') !== null`, 15_000);

    // Edit draft body -> verify approve button disabled while dirty!
    const editedBody = "浏览器内联改稿后的最终正文（Stage 2 E2E）。";
    await cdp.evalJs(`(() => {
      const ta = document.querySelector('[data-field="draft-body"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(editedBody)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const dirtyState = await cdp.evalJs<{ approveDisabled: boolean; warningVisible: boolean }>(`(() => ({
      approveDisabled: Boolean(document.querySelector('[data-action="approve"]')?.disabled),
      warningVisible: document.querySelector('[data-dirty-warning]') !== null
    }))()`);
    assert.equal(dirtyState.approveDisabled, true, "Approve MUST be disabled while draft has unsaved edits");
    assert.equal(dirtyState.warningVisible, true);

    // Save draft -> approve becomes enabled -> click Approve
    await cdp.evalJs(`document.querySelector('[data-action="save-draft"]').click()`);
    await cdp.waitFor(
      `document.querySelector('[data-dirty-warning]') === null && document.querySelector('[data-action="approve"]') && !document.querySelector('[data-action="approve"]').disabled`,
      10_000,
    );
    await cdp.evalJs(`document.querySelector('[data-action="approve"]').click()`);
    await cdp.waitFor(
      `(document.querySelector('[data-approval-card] [data-ui-status-label]')?.textContent || '') === '远端已确认'`,
      15_000,
    );
    const smtpStats = await fakeSmtp.stats();
    assert.equal(smtpStats.totalReceived, 1, "Fake SMTP MUST receive exactly 1 message");
    assert.ok(smtpStats.records[0]!.rawData.includes(editedBody), "Delivered SMTP body MUST match edited draft");

    // 4. View ②: Connectors Status + Connectivity Test + Skills L2/L3 Disclosure + Natural Language Routine
    await cdp.evalJs(`document.querySelector('[data-nav-view="workspace"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-view-panel="workspace"]') !== null`, 10_000);
    const gmailLabel = await cdp.evalJs<string>(
      `document.querySelector('[data-connector-card="gmail"]')?.textContent || ''`,
    );
    assert.ok(gmailLabel.includes("Host Adapter"), "Gmail MUST be shown as Host Adapter, not MCP");
    await cdp.evalJs(`document.querySelector('[data-action="test-all-connectors"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-connectivity-result]') !== null`, 10_000);

    // Skills on-demand L2/L3 disclosure
    await cdp.waitFor(`document.querySelector('[data-skill-card="weekly-brief-helper"]') !== null`, 10_000);
    await cdp.evalJs(`document.querySelector('[data-skill-card="weekly-brief-helper"] [data-action="inspect-skill"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-skill-disclosure-panel]') !== null`, 10_000);
    const skillText = await cdp.evalJs<string>(
      `document.querySelector('[data-skill-disclosure-panel]')?.textContent || ''`,
    );
    assert.ok(skillText.includes("format-weekly-brief.cjs"), "Skill L3 reviewed script metadata must be disclosed");

    // Natural language routine preview -> confirm -> pause -> resume
    await cdp.evalJs(`(() => {
      const inp = document.querySelector('[data-routine-input]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '每周五 17:00 汇总 Helios 周报并检查时间差异，周末跳过');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.evalJs(`document.querySelector('[data-action="preview-routine"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-routine-preview]') !== null`, 10_000);
    await cdp.evalJs(`document.querySelector('[data-checkbox="remember-routine-rule"]').click()`);
    await cdp.evalJs(`document.querySelector('[data-action="confirm-routine"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-routine-card]') !== null`, 10_000);
    await cdp.evalJs(`document.querySelector('[data-action="pause-routine"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-action="resume-routine"]') !== null`, 10_000);
    await cdp.evalJs(`document.querySelector('[data-action="resume-routine"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-action="pause-routine"]') !== null`, 10_000);

    // 5. View ③: Approvals & Rules (verify status + revoke remembered rule + jump back to conversation)
    await cdp.evalJs(`document.querySelector('[data-nav-view="approvals"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-view-panel="approvals"]') !== null`, 10_000);
    await cdp.waitFor(`document.querySelector('[data-rule-row]') !== null`, 10_000);
    await cdp.evalJs(`document.querySelector('[data-action="revoke-rule"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-rule-row]') === null`, 10_000);

    // 6. View ④: Memory Search + Forget Tombstone Receipt + Governance Budget Ledger
    await cdp.evalJs(`document.querySelector('[data-nav-view="memory"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-view-panel="memory"]') !== null`, 10_000);
    await cdp.waitFor(`document.querySelector('[data-memory-note]') !== null`, 10_000);
    await cdp.evalJs(`document.querySelector('[data-action="forget-memory"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-forget-receipt]') !== null`, 10_000);
    const forgetReceipt = await cdp.evalJs<string>(
      `document.querySelector('[data-forget-receipt]')?.textContent || ''`,
    );
    assert.ok(forgetReceipt.includes("ftsCleaned=true"), `Expected ftsCleaned=true in receipt: ${forgetReceipt}`);
    const budgetText = await cdp.evalJs<string>(
      `document.querySelector('[data-budget-ledger]')?.textContent || ''`,
    );
    assert.ok(budgetText.includes("$5.0000"), "Budget ledger must reflect real governance microUSD limit");

    // 7. Narrow-Screen (390x844) Responsive Verification: Threads Drawer, Inspector Drawer, Full Approval Card!
    await cdp.evalJs(`document.querySelector('[data-nav-view="chat"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-view-panel="chat"]') !== null`, 10_000);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await new Promise((r) => setTimeout(r, 150));

    // Open mobile threads drawer
    await cdp.evalJs(`document.querySelector('[data-open-drawer="threads"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-mobile-drawer="threads"]') !== null`, 5_000);
    const threadsDrawerVisible = await cdp.evalJs<boolean>(
      `document.querySelector('[data-mobile-drawer="threads"] [data-thread-list]') !== null`,
    );
    assert.equal(threadsDrawerVisible, true);
    await cdp.evalJs(`document.querySelector('[data-close-drawer="threads"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-mobile-drawer="threads"]') === null`, 5_000);

    // Open mobile inspector drawer
    await cdp.evalJs(`document.querySelector('[data-open-drawer="inspector"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-mobile-drawer="inspector"]') !== null`, 5_000);
    const inspDrawerVisible = await cdp.evalJs<boolean>(
      `document.querySelector('[data-mobile-drawer="inspector"] [data-inspector-body]') !== null`,
    );
    assert.equal(inspDrawerVisible, true);
    await cdp.evalJs(`document.querySelector('[data-close-drawer="inspector"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-mobile-drawer="inspector"]') === null`, 5_000);

    // Verify inline approval card fits cleanly inside 390px viewport
    const cardBounds = await cdp.evalJs<{ width: number; right: number; viewportWidth: number }>(`(() => {
      const rect = document.querySelector('[data-approval-card]').getBoundingClientRect();
      return { width: Math.round(rect.width), right: Math.round(rect.right), viewportWidth: window.innerWidth };
    })()`);
    assert.ok(
      cardBounds.width > 200 && cardBounds.right <= cardBounds.viewportWidth + 4,
      `Approval card overflowed 390px narrow screen: ${JSON.stringify(cardBounds)}`,
    );

    const report = {
      runId,
      status: "PASS",
      executedAt: new Date().toISOString(),
      formalEntrypoint: "src/index.ts --stage 2 --ui-mode stage2",
      desktopViewport: "1280x800",
      narrowViewport: "390x844",
      progressivePartialRendersObserved: seenPartials.size,
      firstTokenUiMetric: firstTokenText,
      dirtyBlockedApprove: dirtyState.approveDisabled,
      fakeSmtpTotalReceived: smtpStats.totalReceived,
      editedDraftMatchedDeliveredSmtp: true,
      view2ConnectorsTestAndSkillsL3AndRoutineVerified: true,
      view3ApprovalsAndRuleRevokeVerified: true,
      view4MemoryForgetTombstoneReceipt: forgetReceipt,
      narrowScreenThreadsDrawerOk: threadsDrawerVisible,
      narrowScreenInspectorDrawerOk: inspDrawerVisible,
      narrowScreenApprovalCardBounds: cardBounds,
    };
    const evPath = path.join(evidenceDir, "stage2-browser-e2e-evidence.json");
    writeFileSync(evPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { report, evidencePath: evPath };
  } finally {
    await browser?.close().catch(() => {});
    await host?.stop().catch(() => {});
    await fakeModel.stop().catch(() => {});
    await fakeSmtp.stop().catch(() => {});
    await fakeImap.stop().catch(() => {});
    if (!opts?.dataDir) {
      await rmDirWithRetry(rootDir);
    }
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isDirect) {
  const cli = parseWeek2CliArgs(process.argv.slice(2));
  runStage2BrowserE2E({ dataDir: cli.dataDir, evidenceDir: cli.evidenceDir })
    .then((r) => {
      console.log(JSON.stringify(r.report, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
