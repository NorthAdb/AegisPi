import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  logs: () => string;
  stop: () => Promise<void>;
}

async function spawnStage2Host(opts: {
  dataDir: string;
  modelBaseUrl?: string;
  smtpHost?: string;
  smtpPort?: number;
  consoleToken: string;
  connectorsConfigPath?: string;
  taskLimitMu?: number;
  env: Record<string, string>;
}): Promise<SpawnedStage2Host> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AEGISPI_")) delete env[key];
  }
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
      ...(opts.modelBaseUrl ? ["--model-base-url", opts.modelBaseUrl, "--allow-synthetic-fake-model"] : []),
      ...(opts.smtpHost ? ["--smtp-host", opts.smtpHost, "--smtp-port", String(opts.smtpPort)] : []),
      "--console-token",
      opts.consoleToken,
      ...(opts.connectorsConfigPath ? ["--connectors-config", opts.connectorsConfigPath] : []),
      ...(opts.taskLimitMu ? ["--task-limit-mu", String(opts.taskLimitMu)] : []),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, ...opts.env },
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
              child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
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
    logs: () => stdout + stderr,
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
  const imapSecret = "aegisimapprobese";
  const githubPat = `SYNTH_S2_BROWSER_PAT_${runId}`;
  const browserPat = `github_pat_synthetic_${randomUUID().replaceAll("-", "")}`;
  const deepseekKey = `sk-synthetic-${randomUUID()}`;

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
  const mcpArgs = [mcpScript, "--log-path", mcpLogPath, "--allow-write"];

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
    readOnlyMode: false,
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
        allowSyntheticFakeModel: true,
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
          allowedMailboxes: ["INBOX", "Archive"],
          credentialSlotId: "slot:imap-readonly",
          secretEnvVar: "AEGISPI_IMAP_SECRET",
        },
        githubMcp: {
          serverId: "github-s2-ui",
          command: LOCKED_NODE_EXE,
          args: mcpArgs,
          pinnedArtifactPath: mcpScript,
          pinnedArtifactSha256: mcpSha,
          readOnlyMode: false,
          writeAllowlist: [{
            repoId: "NorthAdb/project-helios",
            operations: ["create_or_update_file"],
            allowedRefs: ["refs/heads/main"],
            allowedPaths: ["BROWSER-TEST.md"],
            tier: 2,
          }],
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
  let setupHost: SpawnedStage2Host | null = null;

  const startHost = () => spawnStage2Host({
      dataDir: hostDataDir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      consoleToken,
      connectorsConfigPath: connectorsCfgPath,
      taskLimitMu: 200_000,
      env: {
        AEGISPI_IMAP_SECRET: imapSecret,
        AEGISPI_GITHUB_MCP_PAT: githubPat,
        AEGISPI_PRINCIPAL_TOKENS_JSON: JSON.stringify({ viewer: "synthetic-stage2-settings-viewer" }),
      },
  });
  try {
    host = await startHost();

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

    await cdp.evalJs(`document.querySelector('[data-action="open-settings"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-setting="router-max"]') !== null`, 10_000);
    const settingsFit = await cdp.evalJs<boolean>(`(() => {
      const dialog = document.querySelector('[data-settings-dialog]');
      const rect = dialog.getBoundingClientRect();
      return dialog.open && rect.left >= 0 && rect.right <= window.innerWidth;
    })()`);
    assert.ok(settingsFit, "Settings must fit the narrow viewport");
    await cdp.evalJs(`(() => {
      const select = document.querySelector('[data-setting="router-model"]');
      select.value = 'fake-worker-1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await cdp.evalJs(`(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const [role, value] of [['router', '768'], ['worker', '1536']]) {
        const input = document.querySelector('[data-setting="' + role + '-max"]');
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('[data-action="save-model-settings"]').click();
    })()`);
    await cdp.waitFor(`document.querySelector('[data-settings-restart]') !== null`, 10_000);
    assert.equal(await cdp.evalJs<number>(`fetch('/api/operator-settings', {
      method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ gmailMailbox: 'unapproved' })
    }).then(r => r.status)`), 400);

    await cdp.evalJs(`document.querySelector('[data-settings-section="connectors"]').click()`);
    await cdp.evalJs(`document.querySelector('[data-settings-connector="gmail"]').click()`);
    await cdp.evalJs(`document.querySelector('[data-action="test-settings-connector"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-settings-probe]')?.textContent.includes('IMAP 连通')`, 10_000);
    await cdp.evalJs(`(() => {
      const mailbox = document.querySelector('[data-setting="gmail-mailbox"]');
      mailbox.value = 'Archive';
      mailbox.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await cdp.evalJs(`Array.from(document.querySelectorAll('[data-settings-dialog] button')).find(b => b.textContent === '保存邮箱设置').click()`);
    await cdp.waitFor(`fetch('/api/operator-settings').then(r => r.json()).then(r =>
      r.settings.active.gmailMailbox === 'INBOX' && r.settings.saved.gmailMailbox === 'Archive'
    )`, 10_000);
    await cdp.evalJs(`document.querySelector('[data-action="back-to-connectors"]').click()`);
    await cdp.evalJs(`document.querySelector('[data-settings-connector="github_mcp"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-settings-dialog]').textContent.includes('当前写入 按宿主白名单开放')`, 10_000);

    await host.stop();
    host = await startHost();
    const baseUrl = host.baseUrl;
    const authHeaders = { origin: baseUrl, "content-type": "application/json" };
    async function login(token: string) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST", headers: authHeaders, body: JSON.stringify({ token }),
      });
      assert.equal(response.status, 200);
      return { ...authHeaders, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
    }
    const ownerHeaders = await login(consoleToken);
    const viewerHeaders = await login("synthetic-stage2-settings-viewer");
    const settingsUrl = `${baseUrl}/api/operator-settings`;
    const blocked = await fetch(settingsUrl, {
      method: "PATCH", headers: viewerHeaders, body: JSON.stringify({ routerMaxTokens: 4 }),
    });
    assert.equal(blocked.status, 403);
    const response = await fetch(settingsUrl, { headers: ownerHeaders });
    assert.equal(response.status, 200);
    const afterRestart = await response.json() as { settings: {
      active: { routerModelId: string; routerMaxTokens: number; workerMaxTokens: number; gmailMailbox: string };
      pendingRestart: boolean;
    } };
    assert.equal(afterRestart.settings.active.routerModelId, "fake-worker-1");
    assert.equal(afterRestart.settings.active.routerMaxTokens, 768);
    assert.equal(afterRestart.settings.active.workerMaxTokens, 1536);
    assert.equal(afterRestart.settings.active.gmailMailbox, "Archive");
    assert.equal(afterRestart.settings.pendingRestart, false);

    const existing = await (await fetch(`${baseUrl}/api/conversations`, { headers: ownerHeaders })).json() as {
      activeRuntimeEpoch: string;
      conversations: Array<{ conversationId: string }>;
    };
    const submitCapCheck = async (conversationId: string, runtimeEpoch: string) => {
      const chat = await fetch(`${baseUrl}/api/conversations/${conversationId}/chat`, {
        method: "POST", headers: ownerHeaders,
        body: JSON.stringify({ runtimeEpoch, chatKey: randomUUID(), content: "验证设置后的模型输出上限" }),
      });
      assert.ok(chat.ok);
    };
    const modelRequestsBefore = (await fakeModel.stats()).totalPhysicalRequests;
    for (const slotName of ["router", "worker"] as const) {
      const created = await fetch(`${baseUrl}/api/conversations`, {
        method: "POST", headers: ownerHeaders, body: JSON.stringify({ slotName }),
      });
      assert.equal(created.status, 200);
      const { conversationId, runtimeEpoch } = await created.json() as { conversationId: string; runtimeEpoch: string };
      await submitCapCheck(conversationId, runtimeEpoch);
    }
    await submitCapCheck(existing.conversations[0]!.conversationId, existing.activeRuntimeEpoch);
    const capDeadline = Date.now() + 15_000;
    let sentCaps: string[] = [];
    while (Date.now() < capDeadline) {
      const arrivals = (await fakeModel.stats()).records.slice(modelRequestsBefore);
      sentCaps = arrivals.map((request) => `${request.model}:${request.maxTokens ?? request.maxCompletionTokens}`);
      if (sentCaps.length >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(sentCaps.sort(), ["fake-router-1:768", "fake-worker-1:1536", "fake-worker-1:768"]);

    async function browserLogin(url: string) {
      await cdp.send("Page.navigate", { url });
      const login = "document.querySelector('[data-login-token]')";
      const settings = "document.querySelector('[data-action=\"open-settings\"]')";
      await cdp.waitFor(`location.origin === ${JSON.stringify(url)} && Boolean(${login} || ${settings})`, 15_000);
      if (await cdp.evalJs<boolean>(`Boolean(${login})`)) await cdp.evalJs(`(() => {
        const input = document.querySelector('[data-login-token]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(consoleToken)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-action="login"]').click();
      })()`);
      await cdp.waitFor(`document.querySelector('[data-action="open-settings"]') !== null`, 15_000);
    }
    async function fillAccount(kind: string, fields: Record<string, string>) {
      await cdp.evalJs(`document.querySelector('[data-edit-connection="${kind}"]').click()`);
      await cdp.waitFor(`document.querySelector('input[name="secret"]:enabled') !== null`, 10_000);
      await cdp.evalJs(`(() => {
        const form = document.querySelector('input[name="secret"]').form;
        for (const [name, value] of Object.entries(${JSON.stringify(fields)})) form.elements.namedItem(name).value = value;
        form.elements.namedItem('authorize').checked = true;
        form.requestSubmit();
      })()`);
      await cdp.waitFor(`document.querySelector('[data-action="apply-settings"]') !== null`, 30_000);
    }
    async function applyAccounts() {
      await cdp.waitFor(`document.querySelector('[data-action="apply-settings"]:enabled') !== null`, 15_000);
      await cdp.evalJs(`document.querySelector('[data-action="apply-settings"]').click()`);
      try {
        await cdp.waitFor(`document.querySelector('[data-action="open-settings"]') &&
          !document.querySelector('[data-settings-dialog]')`, 45_000);
      } catch {
        const message = await cdp.evalJs<string>(`document.querySelector('[data-settings-dialog] [role="alert"]')?.textContent ?? ""`);
        throw new Error(`Apply did not reload the settings dialog. UI=${message}\n${(setupHost ?? host)!.logs()}`);
      }
    }
    const configPath = "/api/operator-settings/connections";
    assert.equal((await fetch(baseUrl + configPath, {
      method: "PUT", headers: authHeaders, body: "{}",
    })).status, 401);
    assert.equal((await fetch(baseUrl + configPath, {
      method: "PUT", headers: viewerHeaders, body: "{}",
    })).status, 403);
    assert.equal((await fetch(baseUrl + "/api/operator-settings/apply", {
      method: "POST", headers: viewerHeaders,
    })).status, 403);
    await browserLogin(baseUrl);
    await cdp.evalJs(`document.querySelector('[data-action="open-settings"]').click()`);
    await cdp.evalJs(`document.querySelector('[data-settings-section="connectors"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-settings-connector="gmail"]') !== null`, 10_000);
    await cdp.evalJs(`document.querySelector('[data-settings-connector="gmail"]').click()`);
    await fillAccount("gmail", { email: "owner@s2.local.test", mailbox: "INBOX", secret: imapSecret });
    await cdp.evalJs(`document.querySelector('[data-action="back-to-connectors"]').click()`);
    await cdp.evalJs(`document.querySelector('[data-settings-connector="github_mcp"]').click()`);
    await fillAccount("github", { repoId: "NorthAdb/project-helios", branch: "main", filePath: "README.md", secret: browserPat });
    await cdp.waitFor(`fetch('/api/operator-settings').then(r => r.json()).then(r => r.connections.saved.github?.credentialConfigured)`, 15_000);
    await applyAccounts();

    const imapBefore = await fakeImap.stats();
    const gmailRead = await fetch(baseUrl + "/api/operator-settings/gmail/test-read", { method: "POST", headers: ownerHeaders });
    assert.deepEqual(await gmailRead.json(), { ok: true, code: "read_verified", seenUnchanged: true });
    const imapAfter = await fakeImap.stats();
    assert.equal(imapAfter.totalBodyPeekFetch - imapBefore.totalBodyPeekFetch, 1);
    assert.equal(imapAfter.totalSelect - imapBefore.totalSelect, 0);
    assert.deepEqual(imapAfter.messages.map(({ flags }) => flags), imapBefore.messages.map(({ flags }) => flags));

    const githubProbePath = baseUrl + "/api/operator-settings/github/test-read";
    const mcpCalls = () => readFileSync(mcpLogPath, "utf8").split(/\r?\n/).filter((line) => line.includes('"kind":"tool_call"')).length;
    const githubCallsBefore = mcpCalls();
    const beforePin = await (await fetch(githubProbePath, { method: "POST", headers: ownerHeaders })).json() as { ok: boolean };
    assert.equal(beforePin.ok, false);
    assert.equal(mcpCalls(), githubCallsBefore);
    const pins = await (await fetch(baseUrl + "/api/mcp/pins", { headers: ownerHeaders })).json() as {
      tools: Array<{ serverId: string; toolName: string; observedSchemaSha256: string; canonicalDefJson: string; state: string }>;
    };
    const pin = pins.tools.find((entry) => entry.serverId === "operator-github-fixture" && entry.toolName === "get_file_contents");
    assert.equal(pin?.state, "QUARANTINED");
    const approvePin = await fetch(baseUrl + `/api/mcp/pins/${pin!.serverId}/${pin!.toolName}/approve`, {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ expectedSchemaSha256: pin!.observedSchemaSha256, expectedCanonicalDefJson: pin!.canonicalDefJson }),
    });
    assert.equal(approvePin.status, 200);
    const githubRead = await fetch(githubProbePath, { method: "POST", headers: ownerHeaders });
    assert.deepEqual(await githubRead.json(), { ok: true, code: "ok" });
    assert.equal(mcpCalls() - githubCallsBefore, 1);
    const githubReadDelta = mcpCalls() - githubCallsBefore;
    const afterApply = await (await fetch(baseUrl + "/api/conversations", { headers: ownerHeaders })).json() as typeof existing;
    assert.equal(afterApply.activeRuntimeEpoch, existing.activeRuntimeEpoch);
    assert.ok(afterApply.conversations.some((entry) => entry.conversationId === existing.conversations[0]!.conversationId));

    const writePin = pins.tools.find((entry) => entry.serverId === "github-s2-ui" && entry.toolName === "create_or_update_file");
    assert.equal(writePin?.state, "QUARANTINED");
    assert.equal((await fetch(baseUrl + `/api/mcp/pins/${writePin!.serverId}/${writePin!.toolName}/approve`, {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ expectedSchemaSha256: writePin!.observedSchemaSha256, expectedCanonicalDefJson: writePin!.canonicalDefJson }),
    })).status, 200);
    await fakeModel.queue({ clear: true, scripts: [{
      kind: "tool_call",
      toolCall: { id: "operator_write_fixture", name: "github_write_file", arguments: {
        repoId: "NorthAdb/project-helios", operation: "create_or_update_file", ref: "refs/heads/main",
        path: "BROWSER-TEST.md", content: "Synthetic GitHub write", message: "Verify separate write bridge",
      } },
    }, { kind: "text", text: "合成测试写入已确认。" }] });
    const writeCallsBefore = mcpCalls();
    const writeConversation = await (await fetch(baseUrl + "/api/conversations", {
      method: "POST", headers: ownerHeaders, body: "{}",
    })).json() as { conversationId: string; runtimeEpoch: string };
    await submitCapCheck(writeConversation.conversationId, writeConversation.runtimeEpoch);
    await cdp.send("Page.reload", {});
    await cdp.waitFor(`document.querySelector('[data-approval-card]')?.textContent.includes('BROWSER-TEST.md') === true`, 15_000);
    assert.equal(mcpCalls(), writeCallsBefore);
    await cdp.evalJs(`document.querySelector('[data-approval-card] [data-action="approve"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-approval-card] [data-ui-status-label]')?.textContent === '远端已确认'`, 15_000);
    assert.equal(mcpCalls() - writeCallsBefore, 1);
    const githubWriteDelta = mcpCalls() - writeCallsBefore;

    const connectionFile = path.join(hostDataDir, "operator-connections.json");
    const gmailAccount = () => (JSON.parse(readFileSync(connectionFile, "utf8")) as {
      gmail: { credentialRef: string; connectionId: string };
    }).gmail;
    const priorGmail = gmailAccount();
    const rotateGmail = await fetch(baseUrl + configPath, {
      method: "PUT", headers: ownerHeaders, body: JSON.stringify({
        kind: "gmail", email: "owner@s2.local.test", mailbox: "INBOX", secret: imapSecret, authorize: true,
      }),
    });
    assert.equal(rotateGmail.status, 200);
    const rotatedGmail = gmailAccount();
    assert.notEqual(rotatedGmail.credentialRef, priorGmail.credentialRef);
    assert.equal(rotatedGmail.connectionId, priorGmail.connectionId);
    assert.equal(existsSync(path.join(hostDataDir, "operator-credentials", `${priorGmail.credentialRef}.dpapi`)), false);

    const fixtureModelKey = `sk-synthetic-retained-${randomUUID()}`;
    const combinedModel = await fetch(baseUrl + configPath, {
      method: "PUT", headers: ownerHeaders, body: JSON.stringify({
        kind: "model", provider: "deepseek", modelId: "deepseek-flash", baseUrl: "https://api.deepseek.com",
        secret: fixtureModelKey, authorize: true,
      }),
    });
    assert.equal(combinedModel.status, 200);
    assert.equal((await fetch(baseUrl + "/api/operator-settings/apply", { method: "POST", headers: ownerHeaders })).status, 202);
    await cdp.waitFor(`fetch('/api/operator-settings').then(r => r.json()).then(r => r.connections?.active.model?.modelId === 'deepseek-flash').catch(() => false)`, 30_000);
    const disclosureUrl = baseUrl + "/api/operator-settings/disclosure/gmail";
    const disclosure = await (await fetch(disclosureUrl, { headers: ownerHeaders })).json() as {
      available: boolean; granted: boolean; confirmation: string;
    };
    assert.equal(disclosure.available, true);
    assert.equal(disclosure.granted, false);
    const setDisclosure = async (authorized: boolean) => {
      const response = await fetch(disclosureUrl, {
        method: "PUT", headers: ownerHeaders, body: JSON.stringify({ authorized, confirmation: disclosure.confirmation }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, granted: authorized });
    };
    await setDisclosure(true);
    await setDisclosure(false);
    const priorPhysicalRequests = (await fakeModel.stats()).totalPhysicalRequests;
    await submitCapCheck(existing.conversations[0]!.conversationId, existing.activeRuntimeEpoch);
    const oldModelDeadline = Date.now() + 10_000;
    let resumed = false;
    while (!resumed && Date.now() < oldModelDeadline) {
      resumed = (await fakeModel.stats()).totalPhysicalRequests > priorPhysicalRequests;
      if (!resumed) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(resumed, "An existing synthetic model checkpoint must continue on its original provider after apply");

    const setupDataDir = path.join(rootDir, "setup-only-host");
    setupHost = await spawnStage2Host({ dataDir: setupDataDir, consoleToken, taskLimitMu: 1, env: {} });
    await browserLogin(setupHost.baseUrl);
    await cdp.evalJs(`document.querySelector('[data-action="new-conversation"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-settings-dialog]') !== null`, 10_000);
    const catalog = await cdp.evalJs<{ providers: Array<{ id: string; models: Array<{ verifiedEndpoints: string[] }> }> }>(
      `fetch('/api/operator-settings/model-catalog').then(r => r.json())`,
    );
    assert.equal(catalog.providers.length, 43);
    assert.deepEqual(catalog.providers.filter((provider) => provider.models.some((model) => model.verifiedEndpoints.length)).map((provider) => provider.id), ["deepseek"]);
    await cdp.waitFor(`document.querySelector('[data-edit-connection="model"]') !== null`, 10_000);
    await fillAccount("model", { secret: deepseekKey });
    await applyAccounts();
    const actual = await cdp.evalJs<string>(`fetch('/api/operator-settings').then(r => r.text())`);
    assert.equal(JSON.parse(actual).connections.active.model.modelId, "deepseek-flash");
    assert.ok(!actual.includes(deepseekKey));
    const probeStatus = await cdp.evalJs<number>(`fetch('/api/operator-settings/model/test', { method: 'POST' }).then(r => r.status)`);
    assert.equal(probeStatus, 202);
    const readDb = new DatabaseSync(path.join(setupDataDir, "aegis-gov.sqlite"), { readOnly: true });
    let budgetDenials = 0;
    let reservations = 0;
    try {
      const timeout = Date.now() + 15_000;
      while (Date.now() < timeout && budgetDenials === 0) {
        budgetDenials = Number(readDb.prepare(`SELECT count(*) AS n FROM audit_events
          WHERE event_type = 'budget_denied' AND json_extract(details_json, '$.code') = 'task_budget_exceeded'`).get()?.["n"]);
        if (budgetDenials === 0) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      reservations = Number(readDb.prepare("SELECT count(*) AS n FROM budget_reservations").get()?.["n"]);
      assert.equal(readDb.prepare("SELECT count(*) AS n FROM conversation_scopes WHERE scope_id LIKE 'scope:model-test:%'").get()?.["n"], 1);
      assert.equal(readDb.prepare("SELECT count(*) AS n FROM conversation_sources").get()?.["n"], 0);
    } finally {
      readDb.close();
    }
    assert.ok(budgetDenials > 0);
    assert.equal(reservations, 0);

    // Exercise the real-model configuration with isolated fixtures and a budget
    // too small to contact the provider. Only authorized L0 may enter context.
    const { db: memoryFixtureDb } = openGovernanceDb(path.join(setupDataDir, "aegis-gov.sqlite"));
    const noteId = "ux_auto_memory";
    try {
      grantSourceRead(memoryFixtureDb, {
        principalId: "owner", scopeId: "scope:default", sourceType: "memory",
        resourceId: "memory:default", operations: ["read"], now: Date.now(),
      });
      upsertMemoryNote(memoryFixtureDb, {
        noteId, principalId: "owner", scopeId: "scope:default", domain: "default",
        tier: "L0", title: "Synthetic consent fixture", body: "Synthetic memory body.",
        now: Date.now(),
      });
      const sendSynthetic = async (expectedDenial: string, conversationId?: string) => {
        const runtimeEpoch = await cdp.evalJs<string>(
          `fetch('/api/health').then(r => r.json()).then(r => r.runtimeEpoch)`,
        );
        const id = conversationId ?? await cdp.evalJs<string>(
          `fetch('/api/conversations', { method: 'POST' }).then(r => r.json()).then(r => r.conversationId)`,
        );
        const before = Number(memoryFixtureDb.prepare(`
          SELECT COALESCE(MAX(seq), 0) AS seq FROM audit_events
        `).get()?.["seq"]);
        const status = await cdp.evalJs<number>(`
          fetch('/api/conversations/${id}/chat', { method: 'POST', headers: {'content-type':'application/json'},
            body: JSON.stringify({ content: 'Synthetic message.', chatKey: 'ux-memory-${randomUUID()}', runtimeEpoch: ${JSON.stringify(runtimeEpoch)} })
          }).then(r => r.status)
        `);
        assert.ok(status === 202 || status === 200, `Synthetic message was not queued: ${status}`);
        const deadline = Date.now() + 15_000;
        let denied = false;
        while (Date.now() < deadline && !denied) {
          denied = Boolean(memoryFixtureDb.prepare(`
            SELECT 1 FROM audit_events WHERE seq > ? AND event_type = 'budget_denied'
              AND json_extract(details_json, '$.conversationId') = ?
              AND json_extract(details_json, '$.code') = ?
          `).get(before, id, expectedDenial));
          if (!denied) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(denied, `Expected ${expectedDenial} for synthetic conversation ${id}`);
        return id;
      };
      const countSources = (id: string) => Number(memoryFixtureDb.prepare(`
        SELECT COUNT(*) AS n FROM conversation_sources WHERE conversation_id = ? AND source_id = ?
      `).get(id, `memory:${noteId}`)?.["n"]);
      assert.equal(countSources(await sendSynthetic("task_budget_exceeded")), 0);
      await cdp.evalJs(`document.querySelector('[data-nav-view="memory"]').click()`);
      await cdp.waitFor(`Boolean(document.querySelector('[data-memory-disclosure="${noteId}"]'))`, 10_000);
      await cdp.evalJs(`window.confirm = () => true; document.querySelector('[data-memory-disclosure="${noteId}"]').click()`);
      await cdp.waitFor(`document.querySelector('[data-memory-disclosure="${noteId}"]')?.textContent.includes('撤销')`, 10_000);
      const authorizedConversation = await sendSynthetic("task_budget_exceeded");
      assert.equal(countSources(authorizedConversation), 1);
      const exact = memoryFixtureDb.prepare(`
        SELECT source_id FROM model_disclosure_grants WHERE source_type = 'memory' AND revoked_at IS NULL
      `).get();
      assert.equal(exact?.["source_id"], `memory:${noteId}@v1`);
      await cdp.evalJs(`document.querySelector('[data-memory-disclosure="${noteId}"]').click()`);
      await cdp.waitFor(`document.querySelector('[data-memory-disclosure="${noteId}"]')?.textContent.includes('授权发送')`, 10_000);
      await sendSynthetic("disclosure_denied", authorizedConversation);
      assert.equal(countSources(await sendSynthetic("task_budget_exceeded")), 0);
      assert.equal(memoryFixtureDb.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get()?.["n"], 0);
    } finally {
      memoryFixtureDb.close();
    }
    const secrets = [imapSecret, browserPat, deepseekKey, fixtureModelKey];
    for (const dir of [hostDataDir, setupDataDir]) {
      for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!file.isFile()) continue;
        const bytes = readFileSync(path.join(file.parentPath, file.name));
        assert.ok(secrets.every((secret) => !bytes.includes(Buffer.from(secret))), `credential leaked in ${file.name}`);
      }
    }
    assert.ok(secrets.every((secret) => !(host!.logs() + setupHost!.logs()).includes(secret)));
    assert.equal(readdirSync(path.join(hostDataDir, "operator-credentials")).length, 3);
    assert.equal(readdirSync(path.join(setupDataDir, "operator-credentials")).length, 1);

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
      operatorSettingsSavedAndAppliedAfterRestart: true,
      operatorSettingsViewerWriteRefused: true,
      browserOnboarding: {
        setupWithoutModel: true,
        catalogProviders: catalog.providers.length,
        budgetDenials,
        reservations,
        checkedCiphertextDbWalAndLogs: true,
        imapPeekDelta: imapAfter.totalBodyPeekFetch - imapBefore.totalBodyPeekFetch,
        imapSelectDelta: imapAfter.totalSelect - imapBefore.totalSelect,
        imapSeenUnchanged: true,
        githubCallsBeforeApprovalDelta: 0,
        githubCallsAfterApprovalDelta: githubReadDelta,
        separateGithubWriteDelta: githubWriteDelta,
        sameScopeCredentialRotationPreservedAuthorization: true,
        previousEpochAndConversationPreserved: true,
        previousModelContinuedAfterModelSwitch: resumed,
        modelDisclosureIndependentlyGrantedAndRevoked: true,
        automaticMemorySkippedUntilAuthorizedAndRevoked: true,
      },
    };
    const evPath = path.join(evidenceDir, "stage2-browser-e2e-evidence.json");
    writeFileSync(evPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { report, evidencePath: evPath };
  } finally {
    await browser?.close().catch(() => {});
    await setupHost?.stop().catch(() => {});
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
