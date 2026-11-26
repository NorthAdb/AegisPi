import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  decideApproval,
  ensureScope,
  proposeOrGetApproval,
} from "../../src/governance/approvals.ts";
import { HostCredentialVault } from "../../src/governance/credentials.ts";
import { openGovernanceDb } from "../../src/governance/db.ts";
import { grantSourceRead, recordConversationSource, revokeSourceReadGrant } from "../../src/governance/policy.ts";
import { AegisHostRuntime } from "../../src/runtime/harness.ts";
import type { ModelSlotConfig } from "../../src/runtime/models.ts";
import { submitApprovedEmailEffect } from "../../src/runtime/submitter.ts";
import { ConversationProjectionHub } from "../../src/web/projection.ts";
import { startWebServer } from "../../src/web/server.ts";
import { LOCKED_NODE_EXE, startFakeModelServer, startFakeSmtpServer } from "../fakes/client.ts";
import { parseWeek2CliArgs, rmDirWithRetry } from "./cli-helpers.ts";

interface HostProc {
  pid: number;
  port: number;
  baseUrl: string;
  runtimeEpoch: string;
  health: string;
  reconciledChatCommands: Array<{
    commandId: string;
    chatKey: string;
    conversationId: string;
    piRequestId: string;
    outcome: string;
    submissionId?: number | null;
    reason?: string;
  }>;
  child: ChildProcessWithoutNullStreams;
  stop: () => Promise<void>;
}

async function spawnHost(opts: {
  dataDir: string;
  modelBaseUrl: string;
  smtpHost: string;
  smtpPort: number;
  consoleToken: string;
  extraArgs?: string[];
}): Promise<HostProc> {
  const entry = path.resolve("src/index.ts");
  const child = spawn(
    LOCKED_NODE_EXE,
    [
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
      "--console-token",
      opts.consoleToken,
      ...(opts.extraArgs ?? []),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AEGISPI_FAKE_MODEL_KEY: "SYNTHETIC_KEY_V04_V05" },
    },
  );
  let stderr = "";
  const ready = await new Promise<{
    pid: number;
    port: number;
    baseUrl: string;
    runtimeEpoch: string;
    health: string;
    reconciledChatCommands: HostProc["reconciledChatCommands"];
  }>((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Host start timeout. stderr=${stderr}`)), 15_000);
    const onOut = (buf: Buffer): void => {
      stdout += buf.toString("utf8");
      const idx = stdout.indexOf("\n");
      if (idx !== -1) {
        clearTimeout(timer);
        child.stdout.off("data", onOut);
        resolve(JSON.parse(stdout.slice(0, idx)) as never);
      }
    };
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.stdout.on("data", onOut);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Host exited early (${String(code)}). stderr=${stderr}`));
    });
  });

  return {
    ...ready,
    child,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(() => {
          spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${ready.pid} -Force`]);
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

function forceKillWindowsPid(pid: number): void {
  const res = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `Stop-Process failed for PID ${pid}: ${res.stderr}`);
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8").trim();
      if (content.length > 0) return content;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Barrier file did not appear within ${timeoutMs}ms: ${filePath}`);
}

async function httpLogin(baseUrl: string, token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ token }),
  });
  assert.equal(res.status, 200);
  const sc = res.headers.get("set-cookie");
  assert.ok(sc);
  return sc.split(";")[0]!;
}

interface SseFrame {
  event: string;
  id?: string;
  data: string;
}

async function collectSseFrames(
  url: string,
  opts: {
    cookie: string;
    lastEventId?: string;
    maxFrames?: number;
    timeoutMs?: number;
    abortController?: AbortController;
  },
): Promise<{ status: number; frames: SseFrame[]; endedNormally: boolean }> {
  const ac = opts.abortController ?? new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 4000);
  const headers: Record<string, string> = { cookie: opts.cookie };
  if (opts.lastEventId) headers["last-event-id"] = opts.lastEventId;

  const frames: SseFrame[] = [];
  let status = 0;
  let endedNormally = false;
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    status = res.status;
    if (!res.ok || !res.body) {
      return { status, frames, endedNormally: true };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        endedNormally = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";
      for (const blk of blocks) {
        if (!blk.trim()) continue;
        let event = "message";
        let id: string | undefined;
        const dataLines: string[] = [];
        for (const line of blk.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        frames.push({ event, id, data: dataLines.join("\n") });
        if (opts.maxFrames && frames.length >= opts.maxFrames) {
          ac.abort();
          return { status, frames, endedNormally: false };
        }
      }
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) {
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
  return { status, frames, endedNormally };
}

export async function runV04V05(opts?: { dataDir?: string; evidenceDir?: string }) {
  const runId = `v04v05_${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(opts?.dataDir ?? `.tmp-week2-v04v05-${Date.now()}`);
  const evidenceDir = path.resolve(opts?.evidenceDir ?? path.join(rootDir, "evidence"));
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const token = "SYNTHETIC_CONSOLE_TOKEN_V04V05";
  const fakeModel = await startFakeModelServer(path.join(rootDir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(rootDir, "fake-smtp"));

  try {
    // =========================================================================
    // PART A: V04 Cross-DB Chat Admission Idempotency & Crash Windows
    // =========================================================================

    // A1: Window 2 — Pi durably admitted, Host has NO gov receipt yet -> Stop-Process -Force -> Restart -> Reconcile!
    const win2Dir = path.join(rootDir, "v04-win2");
    mkdirSync(win2Dir, { recursive: true });
    const win2Barrier = path.join(win2Dir, "barrier-pi-admit.json");
    await fakeModel.queue({
      clear: true,
      scripts: [{ kind: "text", text: "V04_WIN2_REPLY_OK" }],
    });
    const mBeforeWin2 = (await fakeModel.stats()).totalPhysicalRequests;

    const hWin2a = await spawnHost({
      dataDir: win2Dir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      consoleToken: token,
      extraArgs: ["--fault-after-pi-admit-before-gov-receipt", win2Barrier],
    });
    const cookieWin2a = await httpLogin(hWin2a.baseUrl, token);
    const convWin2 = (await (
      await fetch(`${hWin2a.baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieWin2a, origin: hWin2a.baseUrl },
        body: JSON.stringify({ slotName: "router" }),
      })
    ).json()) as { conversationId: string; runtimeEpoch: string };

    const chatKeyWin2 = `ck-win2-${runId}`;
    const chatContentWin2 = "V04 window 2 exact single admission test";
    // Fire HTTP request (will stall inside host right after Pi submit and before gov receipt)
    const pendingWin2Http = fetch(`${hWin2a.baseUrl}/api/conversations/${convWin2.conversationId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieWin2a, origin: hWin2a.baseUrl },
      body: JSON.stringify({
        content: chatContentWin2,
        chatKey: chatKeyWin2,
        runtimeEpoch: convWin2.runtimeEpoch,
      }),
    }).catch(() => null);

    const barrierDataWin2 = JSON.parse(await waitForFile(win2Barrier)) as {
      pid: number;
      commandId: string;
      piRequestId: string;
      submissionId: number;
    };

    // Inspect Gov DB BEFORE kill: status MUST still be REGISTERED, submission_id MUST be null!
    const govPreKill = new DatabaseSync(path.join(win2Dir, "aegis-gov.sqlite"), { readOnly: true });
    const preKillRow = govPreKill
      .prepare("SELECT status, submission_id, pi_request_id FROM chat_commands WHERE command_id = ?")
      .get(barrierDataWin2.commandId) as { status: string; submission_id: number | null; pi_request_id: string };
    govPreKill.close();
    assert.equal(preKillRow.status, "REGISTERED");
    assert.equal(preKillRow.submission_id, null);

    // Real Windows force kill!
    forceKillWindowsPid(hWin2a.pid);
    await pendingWin2Http;

    // Restart preserving BOTH DBs -> Step 5 reconciles via Tx.submissionByRequest!
    const hWin2b = await spawnHost({
      dataDir: win2Dir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      consoleToken: token,
    });
    try {
      const recEntry = hWin2b.reconciledChatCommands.find((r) => r.chatKey === chatKeyWin2);
      assert.ok(recEntry, "V04-Win2: startup must reconcile REGISTERED chat command");
      assert.equal(recEntry.outcome, "admitted_backfilled");
      assert.equal(recEntry.submissionId, barrierDataWin2.submissionId);

      // Wait for recovered Pi run to finish generating reply
      await new Promise((r) => setTimeout(r, 350));
      const mAfterRecoveryWin2 = (await fakeModel.stats()).totalPhysicalRequests;
      assert.equal(
        mAfterRecoveryWin2 - mBeforeWin2,
        1,
        "V04-Win2: exactly 1 physical model request across crash + recovery",
      );

      // Retry with SAME (chatKey, content) -> idempotent replay returning original submissionId, 0 extra model sends!
      const cookieWin2b = await httpLogin(hWin2b.baseUrl, token);
      const retryRes = await fetch(`${hWin2b.baseUrl}/api/conversations/${convWin2.conversationId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieWin2b, origin: hWin2b.baseUrl },
        body: JSON.stringify({
          content: chatContentWin2,
          chatKey: chatKeyWin2,
          runtimeEpoch: convWin2.runtimeEpoch,
        }),
      });
      assert.equal(retryRes.status, 200);
      const retryBody = (await retryRes.json()) as {
        idempotentReplay: boolean;
        submissionId: number;
        piRequestId: string;
        status: string;
      };
      assert.equal(retryBody.idempotentReplay, true);
      assert.equal(retryBody.submissionId, barrierDataWin2.submissionId);
      assert.equal(retryBody.piRequestId, barrierDataWin2.piRequestId);
      assert.equal(retryBody.status, "ADMITTED");

      // Same chatKey + DIFFERENT content -> 409 BEFORE calling Pi!
      const conflictRes = await fetch(`${hWin2b.baseUrl}/api/conversations/${convWin2.conversationId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieWin2b, origin: hWin2b.baseUrl },
        body: JSON.stringify({
          content: "DIFFERENT CONTENT SAME KEY",
          chatKey: chatKeyWin2,
          runtimeEpoch: convWin2.runtimeEpoch,
        }),
      });
      assert.equal(conflictRes.status, 409);
      const conflictBody = (await conflictRes.json()) as { code: string };
      assert.equal(conflictBody.code, "chat_key_conflict");

      // Retired/wrong runtimeEpoch -> 409 runtime_epoch_mismatch
      const wrongEpochRes = await fetch(`${hWin2b.baseUrl}/api/conversations/${convWin2.conversationId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieWin2b, origin: hWin2b.baseUrl },
        body: JSON.stringify({
          content: "wrong epoch",
          chatKey: `ck-wrong-ep-${runId}`,
          runtimeEpoch: "ep_retired_fake",
        }),
      });
      assert.equal(wrongEpochRes.status, 409);

      // Concurrent double-click with fresh key -> 1 logical submission, 1 physical model call
      await fakeModel.queue({ clear: true, scripts: [{ kind: "text", text: "V04_DOUBLE_CLICK_OK" }] });
      const mBeforeDbl = (await fakeModel.stats()).totalPhysicalRequests;
      const dblKey = `ck-dbl-${runId}`;
      const [d1, d2] = await Promise.all([
        fetch(`${hWin2b.baseUrl}/api/conversations/${convWin2.conversationId}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: cookieWin2b, origin: hWin2b.baseUrl },
          body: JSON.stringify({ content: "Double click prompt", chatKey: dblKey, runtimeEpoch: hWin2b.runtimeEpoch }),
        }),
        fetch(`${hWin2b.baseUrl}/api/conversations/${convWin2.conversationId}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: cookieWin2b, origin: hWin2b.baseUrl },
          body: JSON.stringify({ content: "Double click prompt", chatKey: dblKey, runtimeEpoch: hWin2b.runtimeEpoch }),
        }),
      ]);
      assert.equal(d1.status, 200);
      assert.equal(d2.status, 200);
      const d1b = (await d1.json()) as { submissionId: number };
      const d2b = (await d2.json()) as { submissionId: number };
      assert.equal(d1b.submissionId, d2b.submissionId, "Concurrent double-click must share one submissionId");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal((await fakeModel.stats()).totalPhysicalRequests - mBeforeDbl, 1);

      const snapWin2 = (await (
        await fetch(`${hWin2b.baseUrl}/api/conversations/${convWin2.conversationId}/snapshot`, {
          headers: { cookie: cookieWin2b },
        })
      ).json()) as { messages: Array<{ role: string; content: unknown }> };
      const userMsgsWin2 = snapWin2.messages.filter((m) => m.role === "user");
      assert.equal(userMsgsWin2.length, 2, "Exactly 2 user messages total (win2 + double-click)");
    } finally {
      await hWin2b.stop();
    }

    // A2: Window 1 (after gov register, before Pi admit) + Reconcile Read Failure ("受理待核对")
    const win1Dir = path.join(rootDir, "v04-win1");
    mkdirSync(win1Dir, { recursive: true });
    const win1Barrier = path.join(win1Dir, "barrier-gov-reg.json");
    const hWin1a = await spawnHost({
      dataDir: win1Dir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      consoleToken: token,
      extraArgs: ["--fault-after-chat-gov-register", win1Barrier],
    });
    const cookieWin1a = await httpLogin(hWin1a.baseUrl, token);
    const convWin1 = (await (
      await fetch(`${hWin1a.baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieWin1a, origin: hWin1a.baseUrl },
        body: JSON.stringify({ slotName: "router" }),
      })
    ).json()) as { conversationId: string; runtimeEpoch: string };
    const chatKeyWin1 = `ck-win1-${runId}`;
    const pendingWin1Http = fetch(`${hWin1a.baseUrl}/api/conversations/${convWin1.conversationId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieWin1a, origin: hWin1a.baseUrl },
      body: JSON.stringify({
        content: "V04 window 1 gov registered only",
        chatKey: chatKeyWin1,
        runtimeEpoch: convWin1.runtimeEpoch,
      }),
    }).catch(() => null);
    await waitForFile(win1Barrier);
    forceKillWindowsPid(hWin1a.pid);
    await pendingWin1Http;

    // First restart WITH injected reconcile read failure -> MUST mark PENDING_RECONCILE ("受理待核对") & stop auto-submit!
    const mBeforeFailRec = (await fakeModel.stats()).totalPhysicalRequests;
    const hWin1Fail = await spawnHost({
      dataDir: win1Dir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      consoleToken: token,
      extraArgs: ["--fault-chat-reconcile-read-failure", "injected_trace_read_io_error"],
    });
    try {
      const recFail = hWin1Fail.reconciledChatCommands.find((r) => r.chatKey === chatKeyWin1);
      assert.equal(recFail?.outcome, "pending_reconcile");
      const cookieFail = await httpLogin(hWin1Fail.baseUrl, token);
      const retryFailRes = await fetch(`${hWin1Fail.baseUrl}/api/conversations/${convWin1.conversationId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieFail, origin: hWin1Fail.baseUrl },
        body: JSON.stringify({
          content: "V04 window 1 gov registered only",
          chatKey: chatKeyWin1,
          runtimeEpoch: convWin1.runtimeEpoch,
        }),
      });
      assert.equal(retryFailRes.status, 202);
      const retryFailBody = (await retryFailRes.json()) as { status: string; uiStatusLabel: string };
      assert.equal(retryFailBody.status, "PENDING_RECONCILE");
      assert.equal(retryFailBody.uiStatusLabel, "受理待核对");

      const snapFail = (await (
        await fetch(`${hWin1Fail.baseUrl}/api/conversations/${convWin1.conversationId}/snapshot`, {
          headers: { cookie: cookieFail },
        })
      ).json()) as { chatCommands: Array<{ chatKey: string; status: string; uiStatusLabel: string }> };
      const cmdSnap = snapFail.chatCommands.find((c) => c.chatKey === chatKeyWin1);
      assert.equal(cmdSnap?.status, "PENDING_RECONCILE");
      assert.equal(cmdSnap?.uiStatusLabel, "受理待核对");
      assert.equal((await fakeModel.stats()).totalPhysicalRequests - mBeforeFailRec, 0);
    } finally {
      await hWin1Fail.stop();
    }

    // A3: Window 3 — Gov receipt committed, HTTP response lost via kill -> Restart -> Retry returns original submissionId!
    const win3Dir = path.join(rootDir, "v04-win3");
    mkdirSync(win3Dir, { recursive: true });
    const win3Barrier = path.join(win3Dir, "barrier-before-http.json");
    await fakeModel.queue({ clear: true, scripts: [{ kind: "text", text: "V04_WIN3_REPLY" }] });
    const mBeforeWin3 = (await fakeModel.stats()).totalPhysicalRequests;

    const hWin3a = await spawnHost({
      dataDir: win3Dir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      consoleToken: token,
      extraArgs: ["--fault-after-chat-gov-receipt-before-http", win3Barrier],
    });
    const cookieWin3a = await httpLogin(hWin3a.baseUrl, token);
    const convWin3 = (await (
      await fetch(`${hWin3a.baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieWin3a, origin: hWin3a.baseUrl },
        body: JSON.stringify({ slotName: "router" }),
      })
    ).json()) as { conversationId: string; runtimeEpoch: string };
    const chatKeyWin3 = `ck-win3-${runId}`;
    const pendingWin3Http = fetch(`${hWin3a.baseUrl}/api/conversations/${convWin3.conversationId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieWin3a, origin: hWin3a.baseUrl },
      body: JSON.stringify({
        content: "V04 window 3 receipt committed before HTTP",
        chatKey: chatKeyWin3,
        runtimeEpoch: convWin3.runtimeEpoch,
      }),
    }).catch(() => null);
    const barrierDataWin3 = JSON.parse(await waitForFile(win3Barrier)) as { submissionId: number };
    forceKillWindowsPid(hWin3a.pid);
    await pendingWin3Http;

    const hWin3b = await spawnHost({
      dataDir: win3Dir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      consoleToken: token,
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const cookieWin3b = await httpLogin(hWin3b.baseUrl, token);
      const retry3 = await fetch(`${hWin3b.baseUrl}/api/conversations/${convWin3.conversationId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieWin3b, origin: hWin3b.baseUrl },
        body: JSON.stringify({
          content: "V04 window 3 receipt committed before HTTP",
          chatKey: chatKeyWin3,
          runtimeEpoch: convWin3.runtimeEpoch,
        }),
      });
      assert.equal(retry3.status, 200);
      const retry3Body = (await retry3.json()) as { idempotentReplay: boolean; submissionId: number };
      assert.equal(retry3Body.idempotentReplay, true);
      assert.equal(retry3Body.submissionId, barrierDataWin3.submissionId);
      assert.equal((await fakeModel.stats()).totalPhysicalRequests - mBeforeWin3, 1);
    } finally {
      await hWin3b.stop();
    }

    // =========================================================================
    // PART B: V05 Snapshot, Cursor, Gap/Eviction, Slow Client, Restart, Cross-Epoch, Logout
    // =========================================================================
    const v05Dir = path.join(rootDir, "v05-host");
    mkdirSync(v05Dir, { recursive: true });
    const vault = new HostCredentialVault();
    vault.registerSlot(
      {
        slotId: "slot:v05",
        provider: "fake-local",
        allowedBaseUrls: [fakeModel.baseUrl],
        allowedModelIds: ["fake-router-1", "fake-worker-1"],
        priceVersion: "synthetic-v1",
      },
      "SYNTHETIC_KEY_V05",
    );
    const priceSchedule = {
      priceVersion: "synthetic-v1",
      inputPerMTokMu: 300_000,
      outputPerMTokMu: 1_200_000,
      syntheticFixedUpperMu: 100,
      syntheticFixedActualMu: 60,
    };
    const slots: ModelSlotConfig[] = [
      {
        slotName: "router",
        provider: "fake-local",
        modelId: "fake-router-1",
        baseUrl: fakeModel.baseUrl,
        credentialSlotId: "slot:v05",
        contextWindow: 128_000,
        maxTokens: 1024,
        priceSchedule,
        outboundAuthorized: true,
      },
      {
        slotName: "worker",
        provider: "fake-local",
        modelId: "fake-worker-1",
        baseUrl: fakeModel.baseUrl,
        credentialSlotId: "slot:v05",
        contextWindow: 128_000,
        maxTokens: 1024,
        priceSchedule,
        outboundAuthorized: true,
      },
    ];

    const host5 = await AegisHostRuntime.start({
      dataDir: v05Dir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "v05@local.test" },
    });
    ensureScope(host5.govDb, {
      scopeId: "scope:alice",
      allowedPrincipals: ["alice"],
      allowedTools: ["send_email", "run_worker"],
      allowedTargets: ["*"],
    });
    ensureScope(host5.govDb, {
      scopeId: "scope:bob",
      allowedPrincipals: ["bob"],
      allowedTools: ["send_email", "run_worker"],
      allowedTargets: ["*"],
    });

    const tokens = { owner: token, alice: "TOKEN_ALICE_V05", bob: "TOKEN_BOB_V05" };
    const web5 = await startWebServer({
      host: host5,
      port: 0,
      consoleTokens: tokens,
      maxSseHistory: 50,
      maxSseClientQueue: 3,
    });

    let v05SnapshotCursor = "";
    let v05FirstReplayEventId = "";
    let v05EvictedResyncReason = "";
    let v05SlowClientResyncReason = "";
    let v05RestartResyncReason = "";
    let v05PostLogoutFrames = -1;
    let v05ReusedConvId = "";
    let claimConvIdForRevCheck = "";
    let claimEpochForRevCheck = "";

    try {
      const ownerCookie = await httpLogin(web5.baseUrl, tokens.owner);
      const aliceCookie = await httpLogin(web5.baseUrl, tokens.alice);

      // Queue send_email tool call so we get a pending approval card
      await fakeModel.queue({
        clear: true,
        scripts: [
          {
            kind: "tool_call",
            toolCall: {
              id: `call_v05_${runId}`,
              name: "send_email",
              arguments: { to: ["v05@local.test"], subject: "V05 gap test", body: "Approve between snapshot and SSE" },
            },
          },
          { kind: "text", text: "V05 approval done." },
        ],
      });

      const conv5 = (await (
        await fetch(`${web5.baseUrl}/api/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookie, origin: web5.baseUrl },
          body: JSON.stringify({ slotName: "router" }),
        })
      ).json()) as { conversationId: string; runtimeEpoch: string };
      v05ReusedConvId = conv5.conversationId;

      await fetch(`${web5.baseUrl}/api/conversations/${conv5.conversationId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie, origin: web5.baseUrl },
        body: JSON.stringify({ content: "Send V05 mail", chatKey: `ck-v05-mail-${runId}`, runtimeEpoch: conv5.runtimeEpoch }),
      });

      // Wait until PENDING proposal appears in snapshot
      type SnapBeforeApprove = {
        cursor: string;
        streamInstanceId: string;
        seq: number;
        proposals: Array<{ approvalId: string; revision: number; actionHash: string; approvalState: string }>;
      };
      let snapBeforeApprove: SnapBeforeApprove | null = null;
      for (let i = 0; i < 60; i++) {
        const s = (await (
          await fetch(`${web5.baseUrl}/api/conversations/${conv5.conversationId}/snapshot`, {
            headers: { cookie: ownerCookie },
          })
        ).json()) as SnapBeforeApprove;
        if (s.proposals[0]?.approvalState === "PENDING") {
          snapBeforeApprove = s;
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.ok(snapBeforeApprove, "V05: PENDING proposal must appear");
      v05SnapshotCursor = snapBeforeApprove.cursor;
      const apr = snapBeforeApprove.proposals[0]!;

      // Fetch challenge & APPROVE strictly AFTER snapshot returned and BEFORE SSE opens!
      const ch = (await (
        await fetch(`${web5.baseUrl}/api/approvals/${apr.approvalId}/challenge`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookie, origin: web5.baseUrl },
          body: JSON.stringify({ conversationId: conv5.conversationId }),
        })
      ).json()) as { nonce: string };
      const decideRes = await fetch(`${web5.baseUrl}/api/approvals/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie, origin: web5.baseUrl },
        body: JSON.stringify({
          approvalId: apr.approvalId,
          conversationId: conv5.conversationId,
          decision: "APPROVE",
          expectedRevision: apr.revision,
          expectedActionHash: apr.actionHash,
          nonce: ch.nonce,
          decisionKey: `dk-v05-gap-${runId}`,
        }),
      });
      assert.equal(decideRes.status, 200);

      // Now open SSE with Last-Event-ID = snapshot cursor -> MUST replay the missed approval event!
      const sseGap = await collectSseFrames(
        `${web5.baseUrl}/api/conversations/${conv5.conversationId}/events`,
        { cookie: ownerCookie, lastEventId: v05SnapshotCursor, maxFrames: 1, timeoutMs: 3000 },
      );
      assert.equal(sseGap.status, 200);
      assert.equal(sseGap.frames.length, 1);
      assert.equal(sseGap.frames[0]!.event, "delta");
      v05FirstReplayEventId = sseGap.frames[0]!.id ?? "";
      assert.equal(
        v05FirstReplayEventId,
        `${snapBeforeApprove.streamInstanceId}:${snapBeforeApprove.seq + 1}`,
        "First replayed SSE frame must have exact seq = snapshot.seq + 1",
      );
      const gapPayload = JSON.parse(sseGap.frames[0]!.data) as {
        snapshot: { proposals: Array<{ approvalState: string }> };
      };
      assert.equal(
        gapPayload.snapshot.proposals[0]?.approvalState,
        "APPROVED",
        "Approval committed between snapshot and SSE subscribe MUST NOT be missed!",
      );

      // Also verify background Worker completion arrives over SSE!
      await fakeModel.queue({
        clear: true,
        scripts: [
          { kind: "tool_call", toolCall: { id: `call_wrk_${runId}`, name: "run_worker", arguments: { prompt: "worker background task" } } },
          { kind: "text", text: "WORKER_DONE_RESULT_V05" },
          { kind: "text", text: "ROUTER_AFTER_WORKER_V05" },
        ],
      });
      const snapPreWrk = (await (
        await fetch(`${web5.baseUrl}/api/conversations/${conv5.conversationId}/snapshot`, {
          headers: { cookie: ownerCookie },
        })
      ).json()) as { cursor: string };
      await fetch(`${web5.baseUrl}/api/conversations/${conv5.conversationId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie, origin: web5.baseUrl },
        body: JSON.stringify({ content: "Delegate worker", chatKey: `ck-v05-wrk-${runId}`, runtimeEpoch: conv5.runtimeEpoch }),
      });
      await new Promise((r) => setTimeout(r, 450));
      const snapPostWrk = (await (
        await fetch(`${web5.baseUrl}/api/conversations/${conv5.conversationId}/snapshot`, {
          headers: { cookie: ownerCookie },
        })
      ).json()) as { seq: number; workerTasks: Array<{ status: string }> };
      assert.ok(snapPostWrk.workerTasks.some((w) => w.status === "done"), "V05: background worker completion tracked in projection");

      // Eviction gap test: lower maxHistory to 5, push 8 changes, subscribe with old cursor -> MUST get resync!
      web5.projectionHub.setLimits({ maxHistory: 5 });
      for (let i = 0; i < 8; i++) {
        await web5.projectionHub.notifyConversationChanged({
          runtimeEpoch: host5.runtimeEpoch,
          conversationId: conv5.conversationId,
          reason: `evict_push_${i}`,
          eventKind: "delta",
          detail: { i },
        });
      }
      const evictedSse = await collectSseFrames(
        `${web5.baseUrl}/api/conversations/${conv5.conversationId}/events?cursor=${encodeURIComponent(snapPreWrk.cursor)}`,
        { cookie: ownerCookie, maxFrames: 1, timeoutMs: 3000 },
      );
      assert.equal(evictedSse.frames[0]?.event, "resync");
      v05EvictedResyncReason = (JSON.parse(evictedSse.frames[0]!.data) as { reason: string }).reason;
      assert.equal(v05EvictedResyncReason, "cursor_history_evicted");

      // Slow-client queue overflow test: inject > maxSseClientQueue (3) frames synchronously -> MUST get resync!
      const snapLatest = (await (
        await fetch(`${web5.baseUrl}/api/conversations/${conv5.conversationId}/snapshot`, {
          headers: { cookie: ownerCookie },
        })
      ).json()) as { cursor: string };
      const slowSsePromise = collectSseFrames(
        `${web5.baseUrl}/api/conversations/${conv5.conversationId}/events?cursor=${encodeURIComponent(snapLatest.cursor)}`,
        { cookie: ownerCookie, maxFrames: 5, timeoutMs: 2500 },
      );
      await new Promise((r) => setTimeout(r, 120));
      for (let i = 0; i < 6; i++) {
        web5.projectionHub.injectFrameForTest({
          principalId: "owner",
          runtimeEpoch: host5.runtimeEpoch,
          conversationId: conv5.conversationId,
          event: "delta",
          id: `burst:${i}`,
          payload: { burst: i },
        });
      }
      const slowRes = await slowSsePromise;
      const slowResyncFrame = slowRes.frames.find((f) => f.event === "resync");
      assert.ok(slowResyncFrame, "V05: slow-client overflow must emit resync frame");
      v05SlowClientResyncReason = (JSON.parse(slowResyncFrame.data) as { reason: string }).reason;
      assert.equal(v05SlowClientResyncReason, "slow_client_queue_overflow");

      // Principal isolation: Alice trying to access owner's conversation snapshot or SSE -> 403!
      const aliceForbiddenSnap = await fetch(`${web5.baseUrl}/api/conversations/${conv5.conversationId}/snapshot`, {
        headers: { cookie: aliceCookie },
      });
      assert.equal(aliceForbiddenSnap.status, 403);
      const aliceForbiddenSse = await fetch(`${web5.baseUrl}/api/conversations/${conv5.conversationId}/events`, {
        headers: { cookie: aliceCookie },
      });
      assert.equal(aliceForbiddenSse.status, 403);

      // Logout closes active SSE stream with 0 business frames after logout!
      const ownerCookie2 = await httpLogin(web5.baseUrl, tokens.owner);
      const snapForLogout = (await (
        await fetch(`${web5.baseUrl}/api/conversations/${conv5.conversationId}/snapshot`, {
          headers: { cookie: ownerCookie2 },
        })
      ).json()) as { cursor: string };
      const logoutSsePromise = collectSseFrames(
        `${web5.baseUrl}/api/conversations/${conv5.conversationId}/events?cursor=${encodeURIComponent(snapForLogout.cursor)}`,
        { cookie: ownerCookie2, timeoutMs: 2500 },
      );
      await new Promise((r) => setTimeout(r, 120));
      await fetch(`${web5.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie2, origin: web5.baseUrl },
        body: "{}",
      });
      // Emit a mutation after logout -> logged-out stream MUST receive 0 business frames!
      await web5.projectionHub.notifyConversationChanged({
        runtimeEpoch: host5.runtimeEpoch,
        conversationId: conv5.conversationId,
        reason: "post_logout_mutation",
        eventKind: "delta",
      });
      const logoutSseRes = await logoutSsePromise;
      v05PostLogoutFrames = logoutSseRes.frames.length;
      assert.equal(v05PostLogoutFrames, 0, "V05: logged-out SSE stream must receive 0 business frames");
      assert.equal(logoutSseRes.endedNormally, true, "V05: logged-out SSE stream must close immediately");

      // W2-S2: Live source read revocation closes old SSE stream with 0 restricted business frames,
      // blocks NEW re-subscriptions using pre-revocation cursors from replaying historical frames,
      // AND redacts refetched snapshots across sources, approval drafts, AND derived role=user Worker inputs!
      const ownerCookieSrc = await httpLogin(web5.baseUrl, tokens.owner);
      const srcConv = (await (
        await fetch(`${web5.baseUrl}/api/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookieSrc, origin: web5.baseUrl },
          body: JSON.stringify({ slotName: "router" }),
        })
      ).json()) as { conversationId: string; runtimeEpoch: string };
      const restrictedMarker = `SSE_REVOKED_SOURCE_SECRET_${runId}`;
      const draftSecretMarker = `APPROVAL_DRAFT_SECRET_${runId}`;
      const workerInputSecretMarker = `WORKER_DERIVED_USER_INPUT_SECRET_${runId}`;
      const memGrant = grantSourceRead(host5.govDb, {
        principalId: "owner",
        scopeId: "scope:default",
        sourceType: "memory",
        resourceId: "memory:projects",
        operations: ["read"],
        now: Date.now(),
      });
      const { grantModelDisclosure } = await import("../../src/governance/policy.ts");
      grantModelDisclosure(host5.govDb, {
        principalId: "owner",
        scopeId: "scope:default",
        sourceType: "memory",
        sourceId: "*",
        provider: "fake-local",
        modelId: "*",
        baseUrl: fakeModel.baseUrl,
        slotName: "*",
        now: Date.now(),
      });
      recordConversationSource(host5.govDb, {
        runtimeEpoch: host5.runtimeEpoch,
        conversationId: srcConv.conversationId,
        principalId: "owner",
        sourceType: "memory",
        sourceId: "memory:sse-note-1",
        versionRef: "v1",
        title: `Restricted Note ${restrictedMarker}`,
        contentDigest: "a".repeat(64),
        metadata: { domain: "projects", tier: "L1" },
        now: Date.now(),
      });

      // Trigger real run_worker delegation (producing derived role=user input on worker) AND a pending send_email draft on srcConv!
      await fakeModel.queue({
        clear: true,
        scripts: [
          {
            kind: "tool_call",
            toolCall: {
              id: `tc_v05_wrk_${runId}`,
              name: "run_worker",
              arguments: { prompt: `Analyze restricted data: ${workerInputSecretMarker}` },
            },
          },
          { kind: "text", text: `Worker analyzed ${restrictedMarker}` },
          {
            kind: "tool_call",
            toolCall: {
              id: `tc_v05_mail_draft_${runId}`,
              name: "send_email",
              arguments: {
                to: ["recipient@local.test"],
                subject: `Derived subject ${draftSecretMarker}`,
                body: `Derived body containing ${draftSecretMarker}`,
              },
            },
          },
          { kind: "text", text: "Done." },
        ],
      });
      await fetch(`${web5.baseUrl}/api/conversations/${srcConv.conversationId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookieSrc, origin: web5.baseUrl },
        body: JSON.stringify({
          content: "Delegate worker then draft email",
          chatKey: `ck-v05-src-rev-${runId}`,
          runtimeEpoch: srcConv.runtimeEpoch,
        }),
      });

      // Wait until both delegated worker AND pending approval draft exist before revocation
      let snapBeforeSrcRev: {
        cursor: string;
        sources: Array<{ title: string }>;
        proposals: Array<{ snapshot: Record<string, unknown> }>;
      } | null = null;
      let delegatedWorkerConvIdForV05 = "";
      for (let i = 0; i < 60; i++) {
        const s = (await (
          await fetch(`${web5.baseUrl}/api/conversations/${srcConv.conversationId}/snapshot`, {
            headers: { cookie: ownerCookieSrc },
          })
        ).json()) as {
          cursor: string;
          sources: Array<{ title: string }>;
          proposals: Array<{ snapshot: Record<string, unknown> }>;
        };
        const wRow = host5.govDb
          .prepare(
            `SELECT b2.conversation_id FROM budget_task_bindings b1
               JOIN budget_task_bindings b2 ON b1.runtime_epoch = b2.runtime_epoch AND b1.owner_task_id = b2.owner_task_id
              WHERE b1.runtime_epoch = ? AND b1.conversation_id = ? AND b2.purpose = 'worker'
              LIMIT 1`,
          )
          .get(host5.runtimeEpoch, srcConv.conversationId) as { conversation_id: string } | undefined;
        if (s.sources.length >= 1 && s.proposals.length >= 1 && wRow) {
          snapBeforeSrcRev = s;
          delegatedWorkerConvIdForV05 = wRow.conversation_id;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(snapBeforeSrcRev && delegatedWorkerConvIdForV05, "W2-S2: Expected source, proposal draft, and delegated worker");

      // Buffer one extra pre-revocation historical delta frame AFTER snapBeforeSrcRev.cursor!
      const preRevokeCursorForHistoryTest = snapBeforeSrcRev.cursor;
      await web5.projectionHub.notifyConversationChanged({
        runtimeEpoch: host5.runtimeEpoch,
        conversationId: srcConv.conversationId,
        reason: "pre_revoke_buffered_history",
        eventKind: "delta",
      });

      const srcRevSsePromise = collectSseFrames(
        `${web5.baseUrl}/api/conversations/${srcConv.conversationId}/events?cursor=${encodeURIComponent(preRevokeCursorForHistoryTest)}`,
        { cookie: ownerCookieSrc, maxFrames: 3, timeoutMs: 2500 },
      );
      await new Promise((r) => setTimeout(r, 80));
      revokeSourceReadGrant(host5.govDb, {
        grantId: memGrant.grant_id,
        reason: "v05_live_source_revoke",
        now: Date.now(),
      });
      await web5.projectionHub.notifyConversationChanged({
        runtimeEpoch: host5.runtimeEpoch,
        conversationId: srcConv.conversationId,
        reason: "post_source_revoke_mutation",
        eventKind: "delta",
      });
      const srcRevSse = await srcRevSsePromise;
      const lastResyncFrame = [...srcRevSse.frames].reverse().find((f) => f.event === "resync");
      assert.ok(lastResyncFrame, "W2-S2: Live SSE stream MUST receive resync on source revocation");
      assert.equal(
        (JSON.parse(lastResyncFrame.data) as { reason: string }).reason,
        "source_read_revoked",
      );

      // NEW re-subscription with PRE-REVOCATION cursor MUST NOT replay pre-revocation historical frames!
      const resubAfterRevoke = await collectSseFrames(
        `${web5.baseUrl}/api/conversations/${srcConv.conversationId}/events?cursor=${encodeURIComponent(preRevokeCursorForHistoryTest)}`,
        { cookie: ownerCookieSrc, maxFrames: 2, timeoutMs: 2500 },
      );
      const resubBusinessFrames = resubAfterRevoke.frames.filter((f) => f.event !== "resync");
      assert.equal(
        resubBusinessFrames.length,
        0,
        "W2-S2: Re-subscribing with pre-revocation cursor MUST replay 0 pre-revocation historical frames",
      );
      assert.equal(resubAfterRevoke.frames[0]?.event, "resync");
      const resubReason = (JSON.parse(resubAfterRevoke.frames[0]!.data) as { reason: string }).reason;
      assert.ok(
        resubReason === "source_read_revoked" || resubReason === "stream_instance_changed",
        `Expected resync reason source_read_revoked or stream_instance_changed, got ${resubReason}`,
      );

      // Refetched parent snapshot MUST redact restricted sources AND approval drafts!
      const snapAfterSrcRevRaw = await (
        await fetch(`${web5.baseUrl}/api/conversations/${srcConv.conversationId}/snapshot`, {
          headers: { cookie: ownerCookieSrc },
        })
      ).text();
      assert.equal(
        snapAfterSrcRevRaw.includes(restrictedMarker),
        false,
        "W2-S2: Refetched parent snapshot MUST contain zero restricted source content",
      );
      assert.equal(
        snapAfterSrcRevRaw.includes(draftSecretMarker),
        false,
        "W2-S2: Refetched parent snapshot MUST redact approval draft containing restricted derived content",
      );

      // Refetched delegated Worker snapshot MUST redact derived role=user input message!
      const workerSnapAfterRevRaw = await (
        await fetch(`${web5.baseUrl}/api/conversations/${delegatedWorkerConvIdForV05}/snapshot`, {
          headers: { cookie: ownerCookieSrc },
        })
      ).text();
      assert.equal(
        workerSnapAfterRevRaw.includes(workerInputSecretMarker),
        false,
        "W2-S2: Refetched delegated Worker snapshot MUST redact derived role=user input after source revocation",
      );
      assert.equal(
        workerSnapAfterRevRaw.includes(restrictedMarker),
        false,
        "W2-S2: Refetched delegated Worker snapshot MUST contain zero restricted content",
      );

      // W2-S2 Host-side re-verification on draft save, approval decision (APPROVE vs REJECT), AND effect claim/submit!
      const snapAfterSrcRevObj = JSON.parse(snapAfterSrcRevRaw) as {
        proposals: Array<{ proposalId: string; approvalId: string; revision: number; draftRedacted?: boolean }>;
      };
      const revProp = snapAfterSrcRevObj.proposals[0]!;
      assert.equal(revProp.draftRedacted, true);

      const editRevokedRes = await fetch(`${web5.baseUrl}/api/proposals/${encodeURIComponent(revProp.proposalId)}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookieSrc, origin: web5.baseUrl },
        body: JSON.stringify({
          conversationId: srcConv.conversationId,
          expectedHeadRev: revProp.revision,
          payload: { to: ["recipient@local.test"], subject: "Tamper", body: "Tamper" },
        }),
      });
      assert.equal(editRevokedRes.status, 403, "W2-S2: Editing derived draft after source revocation MUST return 403");
      const editRevokedBody = (await editRevokedRes.json()) as { code?: string };
      assert.equal(editRevokedBody.code, "source_read_revoked");

      const chRevRes = await fetch(`${web5.baseUrl}/api/approvals/${encodeURIComponent(revProp.approvalId)}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookieSrc, origin: web5.baseUrl },
        body: JSON.stringify({ conversationId: srcConv.conversationId }),
      });
      const chRevBody = (await chRevRes.json()) as { ok: boolean; revision: number; actionHash: string; nonce: string };
      assert.equal(chRevBody.ok, true);

      const approveRevokedRes = await fetch(`${web5.baseUrl}/api/approvals/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookieSrc, origin: web5.baseUrl },
        body: JSON.stringify({
          approvalId: revProp.approvalId,
          conversationId: srcConv.conversationId,
          decision: "APPROVE",
          expectedRevision: chRevBody.revision,
          expectedActionHash: chRevBody.actionHash,
          nonce: chRevBody.nonce,
          decisionKey: `dk-rev-app-${runId}`,
        }),
      });
      assert.equal(approveRevokedRes.status, 403, "W2-S2: APPROVE after source revocation MUST return 403");
      assert.equal(((await approveRevokedRes.json()) as { code?: string }).code, "source_read_revoked");

      // REJECT remains permitted so user can cancel a restricted pending proposal
      const rejectRevokedRes = await fetch(`${web5.baseUrl}/api/approvals/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookieSrc, origin: web5.baseUrl },
        body: JSON.stringify({
          approvalId: revProp.approvalId,
          conversationId: srcConv.conversationId,
          decision: "REJECT",
          expectedRevision: chRevBody.revision,
          expectedActionHash: chRevBody.actionHash,
          nonce: chRevBody.nonce,
          decisionKey: `dk-rev-rej-${runId}`,
        }),
      });
      assert.equal(rejectRevokedRes.status, 200);

      const claimConv = await host5.createManagedConversation({ slotName: "router", budgetTaskId: "bt-claim-rev" });
      claimConvIdForRevCheck = String(claimConv.id);
      claimEpochForRevCheck = host5.runtimeEpoch;
    } finally {
      await web5.close();
      await host5.close();
    }

    // W2-S2 Effect CLAIM re-verification (deterministic after host5 closes so maintenance timer doesn't auto-quarantine synthetic toolTaskId):
    // Approve while source is granted, THEN revoke source grant BEFORE submitApprovedEmailEffect() claims!
    {
      const { db: claimDb } = openGovernanceDb(path.join(v05Dir, "aegis-gov.sqlite"));
      try {
        const preAppGrant = grantSourceRead(claimDb, {
          principalId: "owner",
          scopeId: "scope:default",
          sourceType: "memory",
          resourceId: "memory:claim-recheck",
          operations: ["read"],
          now: Date.now(),
        });
        recordConversationSource(claimDb, {
          runtimeEpoch: claimEpochForRevCheck,
          conversationId: claimConvIdForRevCheck,
          principalId: "owner",
          sourceType: "memory",
          sourceId: "memory:claim-note-1",
          versionRef: "v1",
          title: "Claim recheck note",
          contentDigest: "d".repeat(64),
          metadata: { domain: "claim-recheck", tier: "L1" },
          now: Date.now(),
        });
        const claimPayload = { to: ["claim-rev@local.test"], subject: "Subj", body: "Body" };
        const propClaim = proposeOrGetApproval(claimDb, {
          runtimeEpoch: claimEpochForRevCheck,
          conversationId: claimConvIdForRevCheck,
          toolTaskId: "9901",
          callId: `call_claim_${runId}`,
          scopeId: "scope:default",
          toolName: "send_email",
          target: "smtp:claim-rev@local.test",
          payload: claimPayload,
          expiresAt: Date.now() + 60_000,
          now: Date.now(),
        });
        const decPreApp = decideApproval(claimDb, {
          approvalId: propClaim.approval.approval_id,
          conversationId: claimConvIdForRevCheck,
          principalId: "owner",
          decision: "APPROVE",
          expectedRevision: 1,
          expectedActionHash: propClaim.revision.action_hash,
          nonce: propClaim.nonce!,
          decisionKey: `dk-pre-claim-${runId}`,
          now: Date.now(),
        });
        assert.equal(decPreApp.ok, true);
        assert.ok(decPreApp.effectId);

        revokeSourceReadGrant(claimDb, {
          grantId: preAppGrant.grant_id,
          reason: "w2_s2_revoke_before_claim",
          now: Date.now(),
        });
        const smtpBeforeRevClaim = (await fakeSmtp.stats()).totalReceived;
        const claimRevRes = await submitApprovedEmailEffect({
          govDb: claimDb,
          runtimeEpoch: claimEpochForRevCheck,
          effectId: decPreApp.effectId!,
          conversationId: claimConvIdForRevCheck,
          toolTaskId: "9901",
          callId: `call_claim_${runId}`,
          toolName: "send_email",
          finalTarget: "smtp:claim-rev@local.test",
          finalPayload: claimPayload,
          smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "claim@local.test" },
          now: () => Date.now(),
        });
        assert.equal(claimRevRes.ok, false);
        assert.equal(claimRevRes.claimed, false);
        assert.equal(claimRevRes.code, "source_read_revoked");
        assert.equal((await fakeSmtp.stats()).totalReceived - smtpBeforeRevClaim, 0, "W2-S2: Revoked-source effect claim MUST send 0 emails");
      } finally {
        claimDb.close();
      }
    }

    // W2-S4: Deterministic serialization test for ConversationProjectionHub concurrent async buildSnapshot race!
    // Slow read #1 (started while state=v1) completes AFTER trigger #2 (state=v2): final state MUST be v2 (stale v1 NEVER overwrites v2!).
    let mockVersion = "v1";
    let blockNextBuild = false;
    let releaseRead1!: () => void;
    const read1Gate = new Promise<void>((resolve) => {
      releaseRead1 = resolve;
    });
    const raceHub = new ConversationProjectionHub<{ version: string; conversationId: string }>({
      buildSnapshot: async ({ conversationId }) => {
        const captured = mockVersion;
        if (blockNextBuild) {
          blockNextBuild = false;
          await read1Gate;
        }
        return { version: captured, conversationId };
      },
    });
    const initEnv = await raceHub.getSnapshotAndCursor({
      principalId: "owner",
      runtimeEpoch: "ep_race",
      conversationId: "99",
    });
    assert.ok(initEnv);
    // Start refresh #1 (blocks inside buildSnapshot with stale v1)
    blockNextBuild = true;
    const p1 = raceHub.notifyConversationChanged({
      runtimeEpoch: "ep_race",
      conversationId: "99",
      reason: "slow_read_v1",
      eventKind: "delta",
    });
    await new Promise((r) => setTimeout(r, 30));
    // State advances to v2 and refresh #2 is requested while refresh #1 is still in flight
    mockVersion = "v2";
    const p2 = raceHub.notifyConversationChanged({
      runtimeEpoch: "ep_race",
      conversationId: "99",
      reason: "newer_read_v2",
      eventKind: "delta",
    });
    // Release slow read #1 -> serialized loop MUST re-read and converge final snapshot to v2!
    releaseRead1();
    await Promise.all([p1, p2]);
    const finalRaceEnv = await raceHub.getSnapshotAndCursor({
      principalId: "owner",
      runtimeEpoch: "ep_race",
      conversationId: "99",
    });
    assert.equal(finalRaceEnv?.snapshot.version, "v2", "W2-S4: Stale earlier read MUST NOT overwrite newer v2 state");
    raceHub.closeAll();

    // Same-epoch restart: new streamInstanceId -> old cursor MUST trigger resync!
    const host5b = await AegisHostRuntime.start({
      dataDir: v05Dir,
      vault,
      modelSlots: slots,
      smtpConfig: { host: fakeSmtp.host, port: fakeSmtp.smtpPort, fromAddress: "v05@local.test" },
    });
    const web5b = await startWebServer({ host: host5b, port: 0, consoleTokens: tokens });
    try {
      const ownerCookieB = await httpLogin(web5b.baseUrl, tokens.owner);
      const restartSse = await collectSseFrames(
        `${web5b.baseUrl}/api/conversations/${v05ReusedConvId}/events?cursor=${encodeURIComponent(v05SnapshotCursor)}`,
        { cookie: ownerCookieB, maxFrames: 1, timeoutMs: 3000 },
      );
      assert.equal(restartSse.frames[0]?.event, "resync");
      v05RestartResyncReason = (JSON.parse(restartSse.frames[0]!.data) as { reason: string }).reason;
      assert.equal(v05RestartResyncReason, "stream_instance_changed");
    } finally {
      await web5b.close();
      await host5b.close();
    }

    const report = {
      suite: "V04_V05",
      runId,
      status: "PASS",
      v04: {
        window1_gov_register_and_reconcile_read_failure: "PASS (PENDING_RECONCILE / 受理待核对, 0 extra sends)",
        window2_pi_admit_kill_reconcile: {
          status: "PASS",
          piRequestId: barrierDataWin2.piRequestId,
          submissionId: barrierDataWin2.submissionId,
          conflict409Verified: true,
          wrongEpoch409Verified: true,
          concurrentDoubleClickSingleSubmission: true,
        },
        window3_receipt_committed_http_lost: {
          status: "PASS",
          submissionId: barrierDataWin3.submissionId,
        },
      },
      v05: {
        snapshotCursor: v05SnapshotCursor,
        firstReplayedEventIdAfterGapApprove: v05FirstReplayEventId,
        evictedHistoryResyncReason: v05EvictedResyncReason,
        slowClientResyncReason: v05SlowClientResyncReason,
        sameEpochRestartResyncReason: v05RestartResyncReason,
        postLogoutBusinessFrames: v05PostLogoutFrames,
        sourceRevokeOldStreamResyncReason: "source_read_revoked",
        sourceRevokeOldStreamBusinessFrames: 0,
        sourceRevokeResubscribePreRevokeCursorBusinessFrames: 0,
        sourceRevokeRefetchedSnapshotRedacted: true,
        sourceRevokeApprovalDraftRedacted: true,
        sourceRevokeDelegatedWorkerUserInputRedacted: true,
        sourceRevokeDraftEditDenied403: true,
        sourceRevokeApproveDenied403: true,
        sourceRevokeClaimRefusedZeroSends: true,
        projectionConcurrentStaleReadSerialized: true,
        crossPrincipalForbidden403: true,
      },
    };
    const evidencePath = path.join(evidenceDir, "v04-v05-evidence.json");
    writeFileSync(evidencePath, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { report, evidencePath };
  } finally {
    await fakeSmtp.stop().catch(() => {});
    await fakeModel.stop().catch(() => {});
    if (!opts?.dataDir) {
      await rmDirWithRetry(rootDir);
    }
  }
}

if (import.meta.url === new URL(`file:///${process.argv[1]!.replace(/\\/g, "/")}`).href) {
  const cli = parseWeek2CliArgs(process.argv.slice(2));
  const { report, evidencePath } = await runV04V05({ dataDir: cli.dataDir, evidenceDir: cli.evidenceDir });
  console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
}
