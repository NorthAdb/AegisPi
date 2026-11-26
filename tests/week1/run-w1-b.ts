import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LOCKED_NODE_EXE, startFakeModelServer, startFakeSmtpServer } from "../fakes/client.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        out[k] = v;
        i++;
      } else {
        out[k] = "true";
      }
    }
  }
  return out;
}

interface HostProcessHandle {
  pid: number;
  port: number;
  baseUrl: string;
  runtimeEpoch: string;
  health: string;
  recoveredSubmittingToUnknown: string[];
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
  stopGracefully: () => Promise<void>;
}

async function spawnHostProcess(opts: {
  dataDir: string;
  modelBaseUrl: string;
  smtpHost: string;
  smtpPort: number;
  consoleToken: string;
  modelSecret: string;
  port?: number;
}): Promise<HostProcessHandle> {
  const entry = path.resolve("src/index.ts");
  const child = spawn(
    LOCKED_NODE_EXE,
    [
      entry,
      "--data-dir",
      opts.dataDir,
      "--port",
      String(opts.port ?? 0),
      "--model-base-url",
      opts.modelBaseUrl,
      "--smtp-host",
      opts.smtpHost,
      "--smtp-port",
      String(opts.smtpPort),
      "--console-token",
      opts.consoleToken,
      "--smtp-timeout-ms",
      "60000",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        AEGISPI_FAKE_MODEL_KEY: opts.modelSecret,
      },
    },
  );

  let stderrBuf = "";
  const ready = await new Promise<{
    pid: number;
    port: number;
    baseUrl: string;
    runtimeEpoch: string;
    health: string;
    recoveredSubmittingToUnknown: string[];
  }>((resolve, reject) => {
    let stdoutBuf = "";
    const timer = setTimeout(() => {
      reject(new Error(`Host process did not become ready within 15s. stderr=${stderrBuf}`));
    }, 15_000);
    const onOut = (c: Buffer): void => {
      stdoutBuf += c.toString("utf8");
      const idx = stdoutBuf.indexOf("\n");
      if (idx !== -1) {
        clearTimeout(timer);
        child.stdout.off("data", onOut);
        resolve(JSON.parse(stdoutBuf.slice(0, idx)) as never);
      }
    };
    child.stderr.on("data", (c: Buffer) => {
      stderrBuf += c.toString("utf8");
    });
    child.stdout.on("data", onOut);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Host process exited early with code ${String(code)}. stderr=${stderrBuf}`));
    });
  });

  return {
    pid: ready.pid,
    port: ready.port,
    baseUrl: ready.baseUrl,
    runtimeEpoch: ready.runtimeEpoch,
    health: ready.health,
    recoveredSubmittingToUnknown: ready.recoveredSubmittingToUnknown,
    child,
    stderr: () => stderrBuf,
    stopGracefully: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const t = setTimeout(() => {
          spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${ready.pid} -Force`]);
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

async function login(baseUrl: string, token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ token }),
  });
  assert.equal(res.status, 200, "W1-B login must return 200");
  const sc = res.headers.get("set-cookie");
  assert.ok(sc, "login must set session cookie");
  return sc.split(";")[0]!;
}

function readGovEffectState(govDbPath: string, effectId: string) {
  const db = new DatabaseSync(govDbPath, { readOnly: true });
  try {
    const effect = db.prepare("SELECT * FROM effects WHERE effect_id = ?").get(effectId) as Record<string, unknown> | undefined;
    const claims = db
      .prepare(
        "SELECT count(*) AS n FROM audit_events WHERE entity_type = 'effect' AND entity_id = ? AND event_type = 'effect_claimed'",
      )
      .get(effectId) as { n: number };
    const approvals = db
      .prepare("SELECT count(*) AS n FROM audit_events WHERE entity_type = 'approval' AND event_type = 'approval_approved'")
      .get() as { n: number };
    return { effect: effect ?? null, claimCount: claims.n, approvalCount: approvals.n };
  } finally {
    db.close();
  }
}

function scanFilesForSecrets(filePaths: string[], secretMarkers: string[]): Array<{ file: string; leaked: string }> {
  const hits: Array<{ file: string; leaked: string }> = [];
  for (const fp of filePaths) {
    if (!existsSync(fp)) continue;
    const buf = readFileSync(fp);
    for (const marker of secretMarkers) {
      if (buf.includes(Buffer.from(marker, "utf8"))) {
        hits.push({ file: fp, leaked: marker });
      }
    }
  }
  return hits;
}

export async function runW1B(opts?: { dataDir?: string; evidenceDir?: string }) {
  const runId = `w1b_${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(opts?.dataDir ?? `.tmp-week1-w1b-${Date.now()}`);
  const hostDataDir = path.join(rootDir, "host-data");
  const evidenceDir = opts?.evidenceDir ? path.resolve(opts.evidenceDir) : path.join(rootDir, "evidence");
  mkdirSync(hostDataDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const consoleToken = "SYNTHETIC_CONSOLE_LOGIN_TOKEN_W1B_9981";
  const modelSecret = "SYNTHETIC_HOST_MEMORY_MODEL_KEY_W1B_7742";
  const timeline: Array<{ step: number; at: string; event: string; details: Record<string, unknown> }> = [];
  const logStep = (event: string, details: Record<string, unknown>): void => {
    timeline.push({ step: timeline.length + 1, at: new Date().toISOString(), event, details });
  };

  const fakeModel = await startFakeModelServer(path.join(rootDir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(rootDir, "fake-smtp"), {
    mode: "hold_after_receive",
  });

  let host1: HostProcessHandle | null = null;
  let host2: HostProcessHandle | null = null;
  let host3: HostProcessHandle | null = null;

  try {
    // Queue synthetic tool_call for send_email
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: {
            id: `call_${runId}`,
            name: "send_email",
            arguments: {
              to: ["auditor-w1b@local.test"],
              subject: `W1-B Synthetic Mail [${runId}]`,
              body: `Synthetic W1-B body for crash recovery verification (${runId}).`,
            },
          },
        },
        { kind: "text", text: "Post-tool assistant follow-up." },
      ],
    });

    // 1. Start Host Process #1
    host1 = await spawnHostProcess({
      dataDir: hostDataDir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      consoleToken,
      modelSecret,
    });
    logStep("host1_started", { pid: host1.pid, baseUrl: host1.baseUrl, runtimeEpoch: host1.runtimeEpoch });

    // Verify View 1 HTML is served on /
    const view1HtmlResp = await fetch(`${host1.baseUrl}/`);
    assert.equal(view1HtmlResp.status, 200);
    const view1Html = await view1HtmlResp.text();
    assert.ok(view1Html.includes("AegisPi v2 · 视图①"), "View 1 page must be served");
    assert.ok(!view1Html.includes("cdn.tailwindcss.com"), "View 1 must not load external Tailwind CDN");

    const cookie1 = await login(host1.baseUrl, consoleToken);

    // 2. Create conversation & trigger send_email proposal through normal chat entry
    const convRes = await fetch(`${host1.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie1, origin: host1.baseUrl },
      body: JSON.stringify({ slotName: "router" }),
    });
    assert.equal(convRes.status, 200);
    const { conversationId } = (await convRes.json()) as { conversationId: string };

    const chatRes = await fetch(`${host1.baseUrl}/api/conversations/${conversationId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie1, origin: host1.baseUrl },
      body: JSON.stringify({
        content: "Please send the synthetic W1-B email.",
        chatKey: `w1b-chat-${runId}`,
        runtimeEpoch: host1.runtimeEpoch,
      }),
    });
    assert.equal(chatRes.status, 200);

    // Wait until View 1 snapshot shows the PENDING approval card (G3: snapshot must NOT expose plaintext nonce!)
    let pendingCard: {
      proposalId: string;
      approvalId: string;
      revision: number;
      actionHash: string;
      hasChallenge: boolean;
      nonce?: string | null;
      uiStatusLabel: string;
    } | null = null;
    for (let i = 0; i < 80; i++) {
      const snapRes = await fetch(`${host1.baseUrl}/api/conversations/${conversationId}/snapshot`, {
        headers: { cookie: cookie1 },
      });
      const snap = (await snapRes.json()) as {
        proposals: Array<{
          proposalId: string;
          approvalId: string;
          revision: number;
          actionHash: string;
          hasChallenge: boolean;
          nonce?: string | null;
          approvalState: string;
          uiStatusLabel: string;
        }>;
      };
      const found = snap.proposals.find((p) => p.approvalState === "PENDING" && p.hasChallenge);
      if (found) {
        pendingCard = {
          proposalId: found.proposalId,
          approvalId: found.approvalId,
          revision: found.revision,
          actionHash: found.actionHash,
          hasChallenge: found.hasChallenge,
          nonce: found.nonce,
          uiStatusLabel: found.uiStatusLabel,
        };
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(pendingCard, "W1-B: pending approval card must appear in View 1 snapshot");
    assert.equal(pendingCard.nonce, undefined, "W1-B/G3: snapshot must NOT contain plaintext nonce");

    // G3: Fetch single-use approval challenge via dedicated authorized endpoint
    const chRes = await fetch(`${host1.baseUrl}/api/approvals/${pendingCard.approvalId}/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie1, origin: host1.baseUrl },
      body: JSON.stringify({ conversationId }),
    });
    assert.equal(chRes.status, 200, "W1-B/G3: authorized challenge route must return 200");
    const chBody = (await chRes.json()) as { ok: boolean; nonce: string; revision: number; actionHash: string };
    assert.equal(chBody.ok, true);
    assert.ok(chBody.nonce && chBody.nonce.length > 8);
    const approvalNonce = chBody.nonce;

    logStep("proposal_pending_in_view1", {
      proposalId: pendingCard.proposalId,
      approvalId: pendingCard.approvalId,
      revision: pendingCard.revision,
      actionHash: pendingCard.actionHash,
      nonceExposedInSnapshot: false,
      challengeFetchedViaDedicatedRoute: true,
      uiStatusLabel: pendingCard.uiStatusLabel,
    });

    // 3. Approve from View 1 endpoint (POST /api/approvals/decide)
    const decisionKey = `dk_${runId}_approve`;
    const decideRes = await fetch(`${host1.baseUrl}/api/approvals/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie1, origin: host1.baseUrl },
      body: JSON.stringify({
        approvalId: pendingCard.approvalId,
        conversationId,
        decision: "APPROVE",
        expectedRevision: pendingCard.revision,
        expectedActionHash: pendingCard.actionHash,
        nonce: approvalNonce,
        decisionKey,
      }),
    });
    assert.equal(decideRes.status, 200, "W1-B: approval decide must return 200");
    const decideBody = (await decideRes.json()) as {
      ok: boolean;
      effectId: string;
      effectState: string;
      signalKey: string;
    };
    const effectId = decideBody.effectId;
    assert.ok(effectId, "W1-B: approval must mint effectId");
    logStep("approval_decided", {
      approvalId: pendingCard.approvalId,
      effectId,
      decisionKey,
      initialEffectState: decideBody.effectState,
    });

    // 4. Deterministic barrier: wait until independent Fake SMTP durably persists 1 received email (and holds reply!)
    const arrival = await fakeSmtp.waitArrival(1, 15_000);
    assert.equal(arrival.arrived, true, "W1-B: fake SMTP must durably receive 1 email");
    assert.equal(arrival.totalReceived, 1, "W1-B: fake SMTP totalReceived must be 1 before kill");
    logStep("fake_smtp_received_and_held", {
      totalReceived: arrival.totalReceived,
      rawSha256: arrival.record?.rawSha256,
      replySent: arrival.record?.replySent,
    });

    // 5. Controller verifies governance DB shows effectId is SUBMITTING with NO receipt_ref before force-killing host1!
    const govDbPath = path.join(hostDataDir, "aegis-gov.sqlite");
    const preKillGov = readGovEffectState(govDbPath, effectId);
    assert.equal(preKillGov.effect?.["state"], "SUBMITTING", "W1-B: governance DB must show SUBMITTING before kill");
    assert.equal(preKillGov.effect?.["receipt_ref"], null, "W1-B: governance DB must have no receipt before kill");
    assert.equal(preKillGov.claimCount, 1, "W1-B: claim count must be 1");
    logStep("gov_db_verified_submitting_before_kill", preKillGov);

    // 6. Real Windows Force Kill: Stop-Process -Id <host1.pid> -Force
    const killCommand = `Stop-Process -Id ${host1.pid} -Force`;
    const killOut = spawnSync("powershell.exe", ["-NoProfile", "-Command", killCommand], { encoding: "utf8" });
    assert.equal(killOut.status, 0, `Windows Stop-Process failed: ${killOut.stderr}`);
    await new Promise<void>((resolve) => {
      if (host1!.child.exitCode !== null) resolve();
      else host1!.child.once("exit", () => resolve());
    });
    logStep("host1_force_killed", {
      killedPid: host1.pid,
      killCommand,
      exitCode: host1.child.exitCode,
      signalCode: host1.child.signalCode,
    });

    // Switch fake SMTP to normal mode so ANY accidental resend after restart would immediately succeed and increment count to 2!
    await fakeSmtp.setMode("normal");

    // 7. Restart Host Process #2 preserving BOTH DBs and fake servers
    host2 = await spawnHostProcess({
      dataDir: hostDataDir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      consoleToken,
      modelSecret,
    });
    assert.ok(
      host2.recoveredSubmittingToUnknown.includes(effectId),
      "W1-B: Host #2 startup recovery must transition SUBMITTING -> UNKNOWN",
    );
    logStep("host2_restarted_and_recovered", {
      pid: host2.pid,
      runtimeEpoch: host2.runtimeEpoch,
      recoveredSubmittingToUnknown: host2.recoveredSubmittingToUnknown,
    });

    // Wait briefly to confirm recovery scheduling settles with ZERO resends
    await new Promise((r) => setTimeout(r, 400));

    // 8. Repeated wakeup (BOTH HTTP decide replay AND real SDK signal re-delivery!) & View 1 refresh on Host #2
    const cookie2 = await login(host2.baseUrl, consoleToken);
    const replayDecide = await fetch(`${host2.baseUrl}/api/approvals/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie2, origin: host2.baseUrl },
      body: JSON.stringify({
        approvalId: pendingCard.approvalId,
        conversationId,
        decision: "APPROVE",
        expectedRevision: pendingCard.revision,
        expectedActionHash: pendingCard.actionHash,
        nonce: approvalNonce,
        decisionKey,
      }),
    });
    assert.equal(replayDecide.status, 200, "W1-B: same decisionKey replay returns original receipt + current effectState");
    const replayBody = (await replayDecide.json()) as { idempotentReplay: boolean; effectState: string };
    assert.equal(replayBody.idempotentReplay, true);
    assert.equal(replayBody.effectState, "UNKNOWN");

    const newKeyDecide = await fetch(`${host2.baseUrl}/api/approvals/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie2, origin: host2.baseUrl },
      body: JSON.stringify({
        approvalId: pendingCard.approvalId,
        conversationId,
        decision: "APPROVE",
        expectedRevision: pendingCard.revision,
        expectedActionHash: pendingCard.actionHash,
        nonce: approvalNonce,
        decisionKey: `dk_${runId}_second_attempt`,
      }),
    });
    assert.equal(newKeyDecide.status, 409, "W1-B: new decisionKey against consumed approval must return 409");

    // R4: Explicit duplicate SDK signal wakeup against the recovered tool task on Host #2!
    const sdkWakeRes = await fetch(`${host2.baseUrl}/api/approvals/${pendingCard.approvalId}/redeliver`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie2, origin: host2.baseUrl },
      body: JSON.stringify({}),
    });
    assert.equal(sdkWakeRes.status, 200, "W1-B/R4: explicit SDK redeliver route must succeed");
    const sdkWakeBody = (await sdkWakeRes.json()) as {
      ok: boolean;
      sdkResult: string;
      deliveryKey: string;
      duplicateCheck: string | null;
      outbox: { approval_id: string; state: string; sdk_result: string | null; reason: string | null } | null;
      effect: { effect_id: string; state: string; receipt_ref: string | null } | null;
    };
    assert.ok(
      sdkWakeBody.sdkResult === "duplicate" || sdkWakeBody.sdkResult === "closed",
      `W1-B/R4: expected SDK duplicate or closed on post-recovery wakeup, got ${sdkWakeBody.sdkResult}`,
    );
    assert.equal(sdkWakeBody.effect?.state, "UNKNOWN");
    await new Promise((r) => setTimeout(r, 250));

    const snap2Res = await fetch(`${host2.baseUrl}/api/conversations/${conversationId}/snapshot`, {
      headers: { cookie: cookie2 },
    });
    assert.equal(snap2Res.status, 200);
    const snap2 = (await snap2Res.json()) as {
      proposals: Array<{
        proposalId: string;
        uiStatusLabel: string;
        effect: { effectId: string; state: string; receiptRef: string | null } | null;
      }>;
    };
    const card2 = snap2.proposals.find((p) => p.proposalId === pendingCard!.proposalId);
    assert.ok(card2 && card2.effect);
    assert.equal(card2.effect.effectId, effectId);
    assert.equal(card2.effect.state, "UNKNOWN");
    assert.equal(card2.uiStatusLabel, "结果待核对", "W1-B: View 1 must display 结果待核对 after restart #1");

    const smtpStatsAfterHost2 = await fakeSmtp.stats();
    assert.equal(smtpStatsAfterHost2.totalReceived, 1, "W1-B: fake SMTP totalReceived must still be 1 after restart #1");
    logStep("host2_refreshed_and_verified", {
      smtpTotalReceived: smtpStatsAfterHost2.totalReceived,
      view1Label: card2.uiStatusLabel,
      effectState: card2.effect.state,
      duplicateSdkWakeup: {
        sdkResult: sdkWakeBody.sdkResult,
        deliveryKey: sdkWakeBody.deliveryKey,
        duplicateCheck: sdkWakeBody.duplicateCheck,
        outboxState: sdkWakeBody.outbox?.state ?? null,
        outboxSdkResult: sdkWakeBody.outbox?.sdk_result ?? null,
        effectState: sdkWakeBody.effect?.state ?? null,
      },
    });

    // 9. Graceful stop Host #2 and restart AGAIN (Host #3) to confirm persistence across repeated restarts
    await host2.stopGracefully();
    host3 = await spawnHostProcess({
      dataDir: hostDataDir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      consoleToken,
      modelSecret,
    });
    await new Promise((r) => setTimeout(r, 300));

    const cookie3 = await login(host3.baseUrl, consoleToken);
    const snap3Res = await fetch(`${host3.baseUrl}/api/conversations/${conversationId}/snapshot`, {
      headers: { cookie: cookie3 },
    });
    const snap3 = (await snap3Res.json()) as {
      proposals: Array<{
        proposalId: string;
        uiStatusLabel: string;
        effect: { effectId: string; state: string; receiptRef: string | null; reason: string | null } | null;
      }>;
    };
    const card3 = snap3.proposals.find((p) => p.proposalId === pendingCard!.proposalId);
    assert.ok(card3 && card3.effect);
    assert.equal(card3.effect.state, "UNKNOWN");
    assert.equal(card3.uiStatusLabel, "结果待核对", "W1-B: View 1 must still display 结果待核对 after restart #2");

    const finalGov = readGovEffectState(govDbPath, effectId);
    assert.equal(finalGov.effect?.["state"], "UNKNOWN");
    assert.equal(finalGov.claimCount, 1, "W1-B: successful claim count MUST remain exactly 1");
    assert.equal(finalGov.approvalCount, 1, "W1-B: successful approval count MUST remain exactly 1");

    const finalSmtpStats = await fakeSmtp.stats();
    assert.equal(finalSmtpStats.totalReceived, 1, "W1-B: fake SMTP totalReceived MUST remain exactly 1");

    // 10. Secret leak scan across both DBs + WAL files
    const secretLeaks = scanFilesForSecrets(
      [
        path.join(hostDataDir, "aegis-gov.sqlite"),
        path.join(hostDataDir, "aegis-gov.sqlite-wal"),
        path.join(hostDataDir, "pi-durable.sqlite"),
        path.join(hostDataDir, "pi-durable.sqlite-wal"),
      ],
      [consoleToken, modelSecret],
    );
    assert.equal(secretLeaks.length, 0, `Secret leak detected: ${JSON.stringify(secretLeaks)}`);

    logStep("host3_final_verification_passed", {
      host3Pid: host3.pid,
      finalEffectState: finalGov.effect?.["state"],
      claimCount: finalGov.claimCount,
      approvalCount: finalGov.approvalCount,
      smtpTotalReceived: finalSmtpStats.totalReceived,
      view1Label: card3.uiStatusLabel,
      secretLeaksCount: secretLeaks.length,
    });

    const report = {
      suite: "W1-B",
      runId,
      status: "PASS",
      environment: {
        nodeVersion: process.version,
        sqliteVersion: process.versions.sqlite,
        platform: process.platform,
      },
      identifiers: {
        runId,
        runtimeEpoch: host1.runtimeEpoch,
        conversationId,
        proposalId: pendingCard.proposalId,
        approvalId: pendingCard.approvalId,
        effectId,
        killedHostPid: host1.pid,
        restartedHost2Pid: host2.pid,
        restartedHost3Pid: host3.pid,
      },
      finalGovernanceRecord: finalGov,
      finalFakeSmtp: {
        totalReceived: finalSmtpStats.totalReceived,
        logFile: path.basename(finalSmtpStats.logPath),
        records: finalSmtpStats.records.map((r) => ({
          seq: r.seq,
          receivedAt: r.receivedAt,
          rcptTo: r.rcptTo,
          rawSha256: r.rawSha256,
          modeAtArrival: r.modeAtArrival,
          replySent: r.replySent,
        })),
      },
      finalView1Evidence: {
        conversationId,
        proposalId: card3.proposalId,
        effectId: card3.effect.effectId,
        effectState: card3.effect.state,
        uiStatusLabel: card3.uiStatusLabel,
      },
      duplicateSdkWakeup: {
        sdkResult: sdkWakeBody.sdkResult,
        deliveryKey: sdkWakeBody.deliveryKey,
        duplicateCheck: sdkWakeBody.duplicateCheck,
        outbox: sdkWakeBody.outbox,
        effect: sdkWakeBody.effect,
      },
      secretScan: { clean: true, leaks: secretLeaks },
      timeline,
    };

    const outPath = path.join(evidenceDir, "w1-b-evidence.json");
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { report, evidencePath: outPath };
  } finally {
    await host3?.stopGracefully().catch(() => {});
    await host2?.stopGracefully().catch(() => {});
    await host1?.stopGracefully().catch(() => {});
    await fakeSmtp.stop().catch(() => {});
    await fakeModel.stop().catch(() => {});
  }
}

if (import.meta.url === new URL(`file:///${process.argv[1]!.replace(/\\/g, "/")}`).href) {
  const args = parseArgs(process.argv.slice(2));
  const { report, evidencePath } = await runW1B({
    dataDir: args["data-dir"],
    evidenceDir: args["evidence-dir"],
  });
  console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
}
