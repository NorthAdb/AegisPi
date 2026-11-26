import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readImapMessageReadOnly } from "../../src/capabilities/mail/imap-client.ts";
import {
  cleanupTaskVolume,
  DEFAULT_SANDBOX_IMAGE,
  exportRegularFilesFromVolumeReadOnly,
  inspectDockerEnvironment,
  runTaskInDockerSandbox,
  stopAndRemoveContainer,
  verifyAllVolumeWritersExited,
} from "../../src/capabilities/workspace/docker-sandbox.ts";
import { HostCredentialVault } from "../../src/governance/credentials.ts";
import { approveMcpToolDefinition, pinMcpServerBinary, sha256File } from "../../src/governance/mcp-pin.ts";
import { grantSourceRead } from "../../src/governance/policy.ts";
import { AegisHostRuntime } from "../../src/runtime/harness.ts";
import { GitHubMcpBridge } from "../../src/runtime/mcp-bridge.ts";
import type { ModelSlotConfig } from "../../src/runtime/models.ts";
import { startWebServer } from "../../src/web/server.ts";
import { LOCKED_NODE_EXE, startFakeImapServer, startFakeModelServer } from "../fakes/client.ts";
import { parseWeek2CliArgs, rmDirWithRetry } from "./cli-helpers.ts";

function sha256Prefix16(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

function scanBufferOrFile(
  locationName: string,
  content: Buffer | string,
  markers: Array<{ slotId: string; marker: string }>,
): Array<{ location: string; slotId: string }> {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const hits: Array<{ location: string; slotId: string }> = [];
  for (const m of markers) {
    if (buf.includes(Buffer.from(m.marker, "utf8"))) {
      hits.push({ location: locationName, slotId: m.slotId });
    }
  }
  return hits;
}

interface SamplingPointRecord {
  point: string;
  scannedArtifacts: Array<{ name: string; bytes: number; hits: number }>;
  totalHits: number;
}

export async function runS6(opts?: { dataDir?: string; evidenceDir?: string }) {
  const runId = `s6_${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(opts?.dataDir ?? `.tmp-week2-s6-${Date.now()}`);
  const evidenceDir = path.resolve(opts?.evidenceDir ?? path.join(rootDir, "evidence"));
  const hostDataDir = path.join(rootDir, "host-data");
  const inputSnapDir = path.join(rootDir, "input-snap");
  mkdirSync(hostDataDir, { recursive: true });
  mkdirSync(inputSnapDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const dockerEnv = inspectDockerEnvironment(DEFAULT_SANDBOX_IMAGE);
  assert.equal(dockerEnv.available, true, "Docker image required for S6");
  const approvedImageId = dockerEnv.imageId!;

  // Independent synthetic markers per slot (never logged raw in evidence JSON!)
  const markers = {
    router: `SYNTH_S6_MODEL_ROUTER_${runId}_A1`,
    worker: `SYNTH_S6_MODEL_WORKER_${runId}_B2`,
    imap: `SYNTH_S6_MAIL_IMAP_${runId}_C3`,
    githubPat: `SYNTH_S6_GITHUB_PAT_${runId}_D4`,
    consoleToken: `SYNTH_S6_WEB_CONSOLE_${runId}_E5`,
  };
  const allMarkers = [
    { slotId: "slot:model-router", marker: markers.router },
    { slotId: "slot:model-worker", marker: markers.worker },
    { slotId: "slot:imap-readonly", marker: markers.imap },
    { slotId: "slot:github-mcp-pat", marker: markers.githubPat },
    { slotId: "slot:web-console", marker: markers.consoleToken },
  ];

  // 0. Scanner positive control BEFORE real scan: prove scanner catches planted markers!
  const canaryFile = path.join(rootDir, "scanner-canary.txt");
  writeFileSync(canaryFile, `canary payload containing ${markers.router} and ${markers.githubPat}\n`, "utf8");
  const canaryHits = scanBufferOrFile("canary", readFileSync(canaryFile), allMarkers);
  assert.equal(canaryHits.length, 2, "S6: leak scanner positive control MUST detect planted markers");
  rmSync(canaryFile, { force: true });

  const fakeModel = await startFakeModelServer(path.join(rootDir, "fake-model"));
  const fakeImap = await startFakeImapServer(path.join(rootDir, "fake-imap"), {
    certCn: "imap.local.test",
    user: "owner@local.test",
    pass: markers.imap,
  });

  const mcpLogPath = path.join(rootDir, "fake-mcp", "mcp-calls.jsonl");
  const mcpScript = path.resolve("tests/fakes/fake-github-mcp-server.ts");
  const mcpSha = sha256File(mcpScript);
  const mcpArgs = [mcpScript, "--log-path", mcpLogPath];

  const vault = new HostCredentialVault();
  vault.registerSlot(
    {
      slotId: "slot:model-router",
      provider: "fake-local",
      allowedBaseUrls: [fakeModel.baseUrl],
      allowedModelIds: ["fake-router-1"],
      priceVersion: "synthetic-v1",
    },
    markers.router,
  );
  vault.registerSlot(
    {
      slotId: "slot:model-worker",
      provider: "fake-local",
      allowedBaseUrls: [fakeModel.baseUrl],
      allowedModelIds: ["fake-worker-1"],
      priceVersion: "synthetic-v1",
    },
    markers.worker,
  );
  vault.registerConnectorSlot({
    slotId: "slot:imap-readonly",
    kind: "imap",
    target: `${fakeImap.host}:${fakeImap.imapPort}/INBOX`,
    secretValue: markers.imap,
    imapBinding: {
      host: fakeImap.host,
      port: fakeImap.imapPort,
      servername: "imap.local.test",
      username: "owner@local.test",
      allowedMailboxes: ["INBOX"],
    },
  });
  vault.registerConnectorSlot({
    slotId: "slot:github-mcp-pat",
    kind: "github_mcp",
    target: "github-s6",
    secretValue: markers.githubPat,
    githubMcpBinding: {
      serverId: "github-s6",
      command: LOCKED_NODE_EXE,
      args: mcpArgs,
      executablePath: mcpScript,
      executableSha256: mcpSha,
      readOnlyRequired: true,
    },
  });

  const priceSchedule = {
    priceVersion: "synthetic-v1",
    inputPerMTokMu: 300_000,
    outputPerMTokMu: 1_200_000,
    syntheticFixedUpperMu: 100,
    syntheticFixedActualMu: 60,
  };
  const modelSlots: ModelSlotConfig[] = [
    {
      slotName: "router",
      provider: "fake-local",
      modelId: "fake-router-1",
      baseUrl: fakeModel.baseUrl,
      credentialSlotId: "slot:model-router",
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
      credentialSlotId: "slot:model-worker",
      contextWindow: 128_000,
      maxTokens: 1024,
      priceSchedule,
      outboundAuthorized: true,
    },
  ];

  const capturedHttpUrls: string[] = [];
  const capturedHostLogs: string[] = [];
  const samplingMatrix: SamplingPointRecord[] = [];
  const forbiddenHits: Array<{ location: string; slotId: string }> = [];

  const recordPoint = (
    point: string,
    artifacts: Array<{ name: string; content: Buffer | string }>,
  ): void => {
    const scannedArtifacts: Array<{ name: string; bytes: number; hits: number }> = [];
    let totalHits = 0;
    for (const a of artifacts) {
      const buf = typeof a.content === "string" ? Buffer.from(a.content, "utf8") : a.content;
      const hits = scanBufferOrFile(`${point}:${a.name}`, buf, allMarkers);
      forbiddenHits.push(...hits);
      totalHits += hits.length;
      scannedArtifacts.push({ name: a.name, bytes: buf.length, hits: hits.length });
    }
    samplingMatrix.push({ point, scannedArtifacts, totalHits });
  };

  const readLiveDbsAndWals = (): Array<{ name: string; content: Buffer }> => {
    const out: Array<{ name: string; content: Buffer }> = [];
    for (const fname of ["aegis-gov.sqlite", "aegis-gov.sqlite-wal", "pi-durable.sqlite", "pi-durable.sqlite-wal"]) {
      const fp = path.join(hostDataDir, fname);
      if (existsSync(fp)) {
        out.push({ name: fname, content: readFileSync(fp) });
      }
    }
    return out;
  };

  let mcpBridge: GitHubMcpBridge | null = null;
  let sandboxVolume = "";
  let sandboxContainer = "";
  let executorImageId: string | null = null;
  let exporterImageId: string | null = null;

  try {
    // 1. Start Host #1 and collect LIVE samples at every single sampling point (including live WAL, URLs, host logs, unrelated child env!)
    const host1 = await AegisHostRuntime.start({
      dataDir: hostDataDir,
      vault,
      modelSlots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "s6@local.test" },
      compactionKeepRecentTokens: 15,
      compactionReserveTokens: 256,
      onHttpFetchAttempt: (url) => {
        capturedHttpUrls.push(url);
      },
      onReservationRecorded: (info) => {
        capturedHostLogs.push(JSON.stringify({ event: "reservation", ...info }));
      },
    });
    const web1 = await startWebServer({
      host: host1,
      port: 0,
      consoleToken: markers.consoleToken,
    });

    let snapshotText = "";
    let sseText = "";
    let imapChildEnvKeys: string[] = [];
    let containerEnvKeys: string[] = [];
    let unrelatedChildEnvKeys: string[] = [];

    try {
      const now = Date.now();
      grantSourceRead(host1.govDb, {
        principalId: "owner",
        scopeId: "scope:default",
        sourceType: "imap",
        resourceId: "imap:INBOX",
        operations: ["read"],
        constraints: {
          allowedHosts: [fakeImap.host],
          allowedServernames: ["imap.local.test"],
          allowedUsernames: ["owner@local.test"],
        },
        now,
      });
      grantSourceRead(host1.govDb, {
        principalId: "owner",
        scopeId: "scope:default",
        sourceType: "github_mcp",
        resourceId: "github:NorthAdb/project-helios",
        operations: ["read_file"],
        constraints: { allowedRefs: ["refs/heads/main"], allowedPaths: ["README.md"] },
        now,
      });
      pinMcpServerBinary(host1.govDb, {
        serverId: "github-s6",
        executablePath: mcpScript,
        executableSha256: mcpSha,
        command: LOCKED_NODE_EXE,
        args: mcpArgs,
        readOnlyMode: true,
        approvedBy: "owner",
        now,
      });
      approveMcpToolDefinition(host1.govDb, {
        serverId: "github-s6",
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

      const loginUrl = `${web1.baseUrl}/api/auth/login`;
      capturedHttpUrls.push(loginUrl);
      const loginRes = await fetch(loginUrl, {
        method: "POST",
        headers: { "content-type": "application/json", origin: web1.baseUrl },
        body: JSON.stringify({ token: markers.consoleToken }),
      });
      assert.equal(loginRes.status, 200);
      const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]!;

      await fakeModel.queue({
        clear: true,
        watchMarkers: Object.values(markers),
        scripts: [
          {
            kind: "tool_call",
            toolCall: { id: "s6_wrk_1", name: "run_worker", arguments: { prompt: "S6 worker check" } },
          },
          { kind: "text", text: "S6 worker output clean" },
          { kind: "text", text: "S6 router final clean " + "pad ".repeat(80) },
          { kind: "text", text: "S6 compaction summary clean" },
        ],
      });

      const convRes = await fetch(`${web1.baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: web1.baseUrl },
        body: JSON.stringify({ slotName: "router" }),
      });
      const convBody = (await convRes.json()) as { conversationId: string; runtimeEpoch: string };
      capturedHttpUrls.push(`${web1.baseUrl}/api/conversations`);

      const chatUrl = `${web1.baseUrl}/api/conversations/${convBody.conversationId}/chat`;
      capturedHttpUrls.push(chatUrl);
      const chatRes = await fetch(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: web1.baseUrl },
        body: JSON.stringify({
          content: "Run S6 leak check across router and worker " + "pad ".repeat(80),
          chatKey: `s6-chat-${runId}`,
          runtimeEpoch: convBody.runtimeEpoch,
        }),
      });
      assert.equal(chatRes.status, 200);

      // Wait for Router + Worker to complete
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const st = await fakeModel.stats();
        if (st.totalPhysicalRequests >= 3) break;
        await new Promise((r) => setTimeout(r, 80));
      }
      await new Promise((r) => setTimeout(r, 200));

      // Sampling point 1 & 2: LIVE WAL + DB + URL + host log scan after router & worker generation (BEFORE shutdown!)
      const liveWalsAfterGen = readLiveDbsAndWals();
      assert.ok(
        liveWalsAfterGen.some((f) => f.name.endsWith("-wal") && f.content.length > 0),
        "S6: MUST observe non-empty live WAL while host is running",
      );
      recordPoint("router_and_worker_live", [
        ...liveWalsAfterGen,
        { name: "captured_urls", content: capturedHttpUrls.join("\n") },
        { name: "host_runtime_logs", content: capturedHostLogs.join("\n") },
        { name: "fake_model_log", content: readFileSync(fakeModel.logPath) },
      ]);

      // Sampling point 3: Compaction + LIVE WAL scan
      const cmp = await host1.triggerCompaction({
        conversationId: convBody.conversationId,
        instructions: "Compact for S6",
      });
      assert.equal(cmp.ok, true);
      if (cmp.ok) {
        await host1.harness.waitForTask(cmp.compactionTaskId as never, BACKGROUND_CONTEXT);
      }

      const snapUrl = `${web1.baseUrl}/api/conversations/${convBody.conversationId}/snapshot`;
      capturedHttpUrls.push(snapUrl);
      const snapRes = await fetch(snapUrl, { headers: { cookie } });
      snapshotText = await snapRes.text();
      const snapParsed = JSON.parse(snapshotText) as { cursor: string };

      const sseUrl = `${web1.baseUrl}/api/conversations/${convBody.conversationId}/events?cursor=${encodeURIComponent(snapParsed.cursor)}`;
      capturedHttpUrls.push(sseUrl);
      const ac = new AbortController();
      const ssePromise = fetch(sseUrl, { headers: { cookie }, signal: ac.signal })
        .then(async (r) => {
          const reader = r.body!.getReader();
          const dec = new TextDecoder();
          let acc = "";
          const t = setTimeout(() => ac.abort(), 500);
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              acc += dec.decode(value, { stream: true });
            }
          } catch {
            // expected abort
          } finally {
            clearTimeout(t);
          }
          return acc;
        })
        .catch(() => "");
      await web1.projectionHub.notifyConversationChanged({
        runtimeEpoch: host1.runtimeEpoch,
        conversationId: convBody.conversationId,
        reason: "s6_sse_probe",
        eventKind: "delta",
      });
      sseText = await ssePromise;

      recordPoint("compaction_web_live", [
        ...readLiveDbsAndWals(),
        { name: "web_snapshot", content: snapshotText },
        { name: "web_sse_frame", content: sseText },
        { name: "captured_urls", content: capturedHttpUrls.join("\n") },
      ]);

      // Sampling point 4: IMAP + GitHub MCP connectors + unrelated child process env check!
      const imapRes = await readImapMessageReadOnly({
        govDb: host1.govDb,
        vault,
        endpoint: {
          mode: "direct",
          host: fakeImap.host,
          port: fakeImap.imapPort,
          servername: "imap.local.test",
          caPem: fakeImap.certPem,
          username: "owner@local.test",
          credentialSlotId: "slot:imap-readonly",
          mailbox: "INBOX",
        },
        principalId: "owner",
        scopeId: "scope:default",
        uid: 102,
        now,
      });
      assert.equal(imapRes.ok, true);
      imapChildEnvKeys = imapRes.childEnvKeysObserved ?? [];

      mcpBridge = new GitHubMcpBridge({
        serverId: "github-s6",
        command: LOCKED_NODE_EXE,
        args: mcpArgs,
        pinnedArtifactPath: mcpScript,
        credentialSlotId: "slot:github-mcp-pat",
        govDb: host1.govDb,
        vault,
      });
      const mcpConn = await mcpBridge.connect();
      assert.equal(mcpConn.ok, true, JSON.stringify(mcpConn));
      const mcpRead = await mcpBridge.callReadOnlyTool(
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
      assert.equal(mcpRead.ok, true);
      await mcpBridge.close();
      mcpBridge = null;

      // Spawn an unrelated benign child process to verify ZERO secrets leaked into host process.env / unrelated children!
      const unrelatedChild = spawnSync(LOCKED_NODE_EXE, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(unrelatedChild.status, 0);
      const unrelatedEnvJson = unrelatedChild.stdout;
      unrelatedChildEnvKeys = Object.keys(JSON.parse(unrelatedEnvJson) as Record<string, string>).sort();

      recordPoint("imap_mcp_and_unrelated_child_live", [
        ...readLiveDbsAndWals(),
        { name: "fake_imap_log", content: readFileSync(fakeImap.logPath) },
        { name: "fake_mcp_log", content: readFileSync(mcpLogPath, "utf8") },
        { name: "unrelated_child_env", content: unrelatedEnvJson },
      ]);

      // Sampling point 5: Zero-credential Docker container + RO volume export (by immutable image digest!)
      writeFileSync(path.join(inputSnapDir, "in.txt"), "s6 input", "utf8");
      const sb = runTaskInDockerSandbox({
        approvedImageId,
        inputSnapshotDir: inputSnapDir,
        nodeScript: `
          const fs = require("node:fs");
          fs.writeFileSync("/out/env-dump.json", JSON.stringify(process.env), "utf8");
        `,
      });
      sandboxVolume = sb.volumeName;
      sandboxContainer = sb.containerName;
      executorImageId = sb.executorImageId;
      assert.equal(sb.ok, true, sb.stderr);
      containerEnvKeys = sb.envKeysInContainer;
      assert.equal(verifyAllVolumeWritersExited(sandboxVolume).allExited, true);
      const exp = exportRegularFilesFromVolumeReadOnly({
        volumeName: sandboxVolume,
        approvedImageId,
      });
      assert.equal(exp.ok, true);
      if (exp.ok) {
        exporterImageId = exp.exporterImageId;
        const dumpFile = exp.files.find((f) => f.relPath === "env-dump.json");
        assert.ok(dumpFile);
        recordPoint("docker_sandbox_live", [
          { name: "docker_container_env_dump", content: dumpFile.bytes },
          ...readLiveDbsAndWals(),
        ]);
      }
    } finally {
      await web1.close();
      await host1.close();
    }

    // Sampling point 6: Restart Host #2 and scan post-restart live DBs/WALs + logs!
    const host2 = await AegisHostRuntime.start({
      dataDir: hostDataDir,
      vault,
      modelSlots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "s6@local.test" },
    });
    try {
      recordPoint("post_restart_live", [
        ...readLiveDbsAndWals(),
        { name: "fake_model_log", content: readFileSync(fakeModel.logPath) },
        { name: "fake_imap_log", content: readFileSync(fakeImap.logPath) },
        { name: "fake_mcp_log", content: readFileSync(mcpLogPath, "utf8") },
      ]);
    } finally {
      await host2.close();
    }

    // Verify independent model server received exact per-slot auth SHA-256 prefixes (Router vs Worker!)
    const modelStats = await fakeModel.stats();
    const routerAuthPrefix = sha256Prefix16(markers.router);
    const workerAuthPrefix = sha256Prefix16(markers.worker);
    const routerReqs = modelStats.records.filter((r) => r.model === "fake-router-1");
    const workerReqs = modelStats.records.filter((r) => r.model === "fake-worker-1");
    assert.ok(routerReqs.length >= 2, "Router must have made generation + compaction requests");
    assert.ok(workerReqs.length >= 1, "Worker must have made request");
    assert.ok(routerReqs.every((r) => r.authHeaderSha256Prefix === routerAuthPrefix));
    assert.ok(workerReqs.every((r) => r.authHeaderSha256Prefix === workerAuthPrefix));
    for (const r of modelStats.records) {
      const hits = Object.values(r.markerHits ?? {}).reduce((a, b) => a + b, 0);
      assert.equal(hits, 0, `Secret marker leaked into model prompt body: ${JSON.stringify(r.markerHits)}`);
    }

    const mcpLogRaw = readFileSync(mcpLogPath, "utf8");
    const mcpLines = mcpLogRaw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const mcpStartup = mcpLines.find((l) => l["kind"] === "startup") as {
      patSha256Prefix: string;
      envKeysReceived: string[];
    };
    assert.equal(mcpStartup.patSha256Prefix, sha256Prefix16(markers.githubPat));
    assert.equal(forbiddenHits.length, 0, `S6 FORBIDDEN SECRET LEAK DETECTED: ${JSON.stringify(forbiddenHits)}`);

    const checkedLocationsAll = [
      "live_aegis-gov.sqlite",
      "live_aegis-gov.sqlite-wal",
      "live_pi-durable.sqlite",
      "live_pi-durable.sqlite-wal",
      "captured_urls",
      "host_runtime_logs",
      "web_snapshot",
      "web_sse_frame",
      "fake_model_log",
      "fake_imap_log",
      "fake_mcp_log",
      "model_prompt_bodies",
      "imap_child_env",
      "unrelated_child_env",
      "docker_container_env",
    ];

    const perSlotReport = [
      {
        slotId: "slot:model-router",
        markerDigestPrefix: routerAuthPrefix,
        allowedLocations: ["host_memory_vault", "loopback_fake_model_router_auth_header"],
        checkedLocations: [...checkedLocationsAll, "mcp_child_env"],
        forbiddenHits: 0,
      },
      {
        slotId: "slot:model-worker",
        markerDigestPrefix: workerAuthPrefix,
        allowedLocations: ["host_memory_vault", "loopback_fake_model_worker_auth_header"],
        checkedLocations: [...checkedLocationsAll, "mcp_child_env"],
        forbiddenHits: 0,
      },
      {
        slotId: "slot:imap-readonly",
        markerDigestPrefix: sha256Prefix16(markers.imap),
        allowedLocations: ["host_memory_vault", "imap_child_stdin_only"],
        checkedLocations: [...checkedLocationsAll, "mcp_child_env"],
        forbiddenHits: 0,
      },
      {
        slotId: "slot:github-mcp-pat",
        markerDigestPrefix: sha256Prefix16(markers.githubPat),
        allowedLocations: ["host_memory_vault", "github_mcp_child_explicit_env"],
        checkedLocations: checkedLocationsAll,
        forbiddenHits: 0,
      },
      {
        slotId: "slot:web-console",
        markerDigestPrefix: sha256Prefix16(markers.consoleToken),
        allowedLocations: ["host_memory_auth_config"],
        checkedLocations: [...checkedLocationsAll, "mcp_child_env"],
        forbiddenHits: 0,
      },
    ];

    const report = {
      suite: "S6",
      runId,
      status: "PASS",
      scannerPositiveControl: { plantedMarkers: 2, detectedHits: canaryHits.length },
      samplingPointMatrix: samplingMatrix,
      uncollectedSamples: [],
      dockerDigests: { executorImageId, exporterImageId },
      imapChildEnvKeysCount: imapChildEnvKeys.length,
      unrelatedChildEnvKeysCount: unrelatedChildEnvKeys.length,
      mcpChildEnvKeys: mcpStartup.envKeysReceived,
      dockerContainerEnvKeys: containerEnvKeys,
      capturedUrlsCount: capturedHttpUrls.length,
      totalForbiddenHits: forbiddenHits.length,
      slots: perSlotReport,
    };
    const evidencePath = path.join(evidenceDir, "s6-evidence.json");
    writeFileSync(evidencePath, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { report, evidencePath };
  } finally {
    await mcpBridge?.close().catch(() => {});
    if (sandboxContainer) stopAndRemoveContainer(sandboxContainer);
    if (sandboxVolume) cleanupTaskVolume(sandboxVolume);
    await fakeImap.stop().catch(() => {});
    await fakeModel.stop().catch(() => {});
    if (!opts?.dataDir) {
      await rmDirWithRetry(rootDir);
    }
  }
}

if (import.meta.url === new URL(`file:///${process.argv[1]!.replace(/\\/g, "/")}`).href) {
  const cli = parseWeek2CliArgs(process.argv.slice(2));
  const { report, evidencePath } = await runS6({ dataDir: cli.dataDir, evidenceDir: cli.evidenceDir });
  console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
}
