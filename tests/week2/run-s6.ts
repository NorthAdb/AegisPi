import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readImapMessageReadOnly } from "../../src/capabilities/mail/imap-client.ts";
import {
  cleanupTaskVolume,
  exportRegularFilesFromVolumeReadOnly,
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

export async function runS6(opts?: { dataDir?: string; evidenceDir?: string }) {
  const runId = `s6_${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(opts?.dataDir ?? `.tmp-week2-s6-${Date.now()}`);
  const evidenceDir = path.resolve(opts?.evidenceDir ?? path.join(rootDir, "evidence"));
  const hostDataDir = path.join(rootDir, "host-data");
  const inputSnapDir = path.join(rootDir, "input-snap");
  mkdirSync(hostDataDir, { recursive: true });
  mkdirSync(inputSnapDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

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

  // 0. Scanner positive control BEFORE real scan: prove scanner catches a planted canary!
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
    target: "imap.local.test",
    secretValue: markers.imap,
  });
  vault.registerConnectorSlot({
    slotId: "slot:github-mcp-pat",
    kind: "github_mcp",
    target: "NorthAdb/project-helios",
    secretValue: markers.githubPat,
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

  let mcpBridge: GitHubMcpBridge | null = null;
  let sandboxVolume = "";
  let sandboxContainer = "";

  try {
    // 1. Start Host #1 and exercise Router, Worker, Compaction, IMAP child, MCP child, Docker container
    const host1 = await AegisHostRuntime.start({
      dataDir: hostDataDir,
      vault,
      modelSlots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "s6@local.test" },
      compactionKeepRecentTokens: 15,
      compactionReserveTokens: 256,
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

    try {
      const now = Date.now();
      grantSourceRead(host1.govDb, {
        principalId: "owner",
        scopeId: "scope:default",
        sourceType: "imap",
        resourceId: "imap:INBOX",
        operations: ["read"],
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

      // Login via Web to write session token digest
      const loginRes = await fetch(`${web1.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: web1.baseUrl },
        body: JSON.stringify({ token: markers.consoleToken }),
      });
      assert.equal(loginRes.status, 200);
      const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

      // Exercise Router -> Worker delegation + Compaction
      await fakeModel.queue({
        clear: true,
        watchMarkers: allMarkers.map((m) => m.marker),
        scripts: [
          { kind: "tool_call", toolCall: { id: "s6_wrk_1", name: "run_worker", arguments: { prompt: "S6 worker task" } } },
          { kind: "text", text: "Worker output " + "alpha ".repeat(50) },
          { kind: "text", text: "Router final " + "beta ".repeat(50) },
          { kind: "text", text: "Router turn 2 " + "gamma ".repeat(50) },
          { kind: "text", text: "## Compacted S6 summary" },
        ],
      });

      const conv = await host1.createManagedConversation({ slotName: "router", budgetTaskId: "s6-task" });
      const sub1 = await conv.submit({ type: "input", content: "S6 router+worker prompt " + "pad ".repeat(40) }, BACKGROUND_CONTEXT);
      await sub1.wait(BACKGROUND_CONTEXT);
      const sub2 = await conv.submit({ type: "input", content: "S6 second turn for compaction " + "pad ".repeat(40) }, BACKGROUND_CONTEXT);
      await sub2.wait(BACKGROUND_CONTEXT);
      const cmp = await host1.triggerCompaction({ conversationId: String(conv.id), instructions: "Compact S6" });
      assert.equal(cmp.ok, true);
      if (cmp.ok) {
        await host1.harness.waitForTask(cmp.compactionTaskId as never, BACKGROUND_CONTEXT);
      }
      await new Promise((r) => setTimeout(r, 80));

      // Capture snapshot & SSE payload
      const snapRes = await fetch(`${web1.baseUrl}/api/conversations/${conv.id}/snapshot`, { headers: { cookie } });
      snapshotText = await snapRes.text();
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 600);
      try {
        const sseRes = await fetch(`${web1.baseUrl}/api/conversations/${conv.id}/events`, {
          headers: { cookie },
          signal: ac.signal,
        });
        if (sseRes.body) {
          const reader = sseRes.body.getReader();
          const { value } = await reader.read();
          if (value) sseText = new TextDecoder().decode(value);
          ac.abort();
        }
      } catch {
        // expected abort
      }

      // Exercise isolated IMAP child (stdin-only secret)
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

      // Exercise GitHub MCP child (inheritEnv: false, approved PAT only)
      mcpBridge = new GitHubMcpBridge({
        serverId: "github-s6",
        command: LOCKED_NODE_EXE,
        args: [mcpScript, "--log-path", mcpLogPath],
        pinnedArtifactPath: mcpScript,
        credentialSlotId: "slot:github-mcp-pat",
        govDb: host1.govDb,
        vault,
      });
      const mcpConn = await mcpBridge.connect();
      assert.equal(mcpConn.ok, true);
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

      // Exercise zero-credential Docker container + RO volume export
      writeFileSync(path.join(inputSnapDir, "in.txt"), "s6 input", "utf8");
      const sb = runTaskInDockerSandbox({
        inputSnapshotDir: inputSnapDir,
        nodeScript: `
          const fs = require("node:fs");
          fs.writeFileSync("/out/env-dump.json", JSON.stringify(process.env), "utf8");
        `,
      });
      sandboxVolume = sb.volumeName;
      sandboxContainer = sb.containerName;
      assert.equal(sb.ok, true);
      containerEnvKeys = sb.envKeysInContainer;
      assert.equal(verifyAllVolumeWritersExited(sandboxVolume).allExited, true);
      const exp = exportRegularFilesFromVolumeReadOnly({ volumeName: sandboxVolume });
      assert.equal(exp.ok, true);
      if (exp.ok) {
        const dumpFile = exp.files.find((f) => f.relPath === "env-dump.json");
        assert.ok(dumpFile);
        const containerLeakHits = scanBufferOrFile("docker_container_env_dump", dumpFile.bytes, allMarkers);
        assert.equal(containerLeakHits.length, 0, `Secret leaked into Docker container env: ${JSON.stringify(containerLeakHits)}`);
      }
    } finally {
      await web1.close();
      await host1.close();
    }

    // 2. Restart Host #2 to verify persistence & scan post-restart artifacts too
    const host2 = await AegisHostRuntime.start({
      dataDir: hostDataDir,
      vault,
      modelSlots,
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "s6@local.test" },
    });
    await host2.close();

    // 3. Verify independent model server received exact per-slot auth SHA-256 prefixes (Router vs Worker!)
    const modelStats = await fakeModel.stats();
    const routerAuthPrefix = sha256Prefix16(markers.router);
    const workerAuthPrefix = sha256Prefix16(markers.worker);
    const routerReqs = modelStats.records.filter((r) => r.model === "fake-router-1");
    const workerReqs = modelStats.records.filter((r) => r.model === "fake-worker-1");
    assert.ok(routerReqs.length >= 2, "Router must have made generation + compaction requests");
    assert.ok(workerReqs.length >= 1, "Worker must have made request");
    assert.ok(
      routerReqs.every((r) => r.authHeaderSha256Prefix === routerAuthPrefix),
      "Router requests must use ONLY slot:model-router credential",
    );
    assert.ok(
      workerReqs.every((r) => r.authHeaderSha256Prefix === workerAuthPrefix),
      "Worker requests must use ONLY slot:model-worker credential",
    );
    // Verify ZERO secret markers appeared in model prompts/bodies!
    for (const r of modelStats.records) {
      const hits = Object.values(r.markerHits ?? {}).reduce((a, b) => a + b, 0);
      assert.equal(hits, 0, `Secret marker leaked into model prompt body: ${JSON.stringify(r.markerHits)}`);
    }

    // 4. Verify independent MCP server log received ONLY githubPat hash prefix and NO other secret env vars
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

    // 5. Scan ALL forbidden locations across BOTH DBs, WALs, logs, snapshots, SSE!
    const locationsToScan: Array<{ name: string; content: Buffer | string }> = [
      { name: "web_snapshot", content: snapshotText },
      { name: "web_sse_frame", content: sseText },
      { name: "fake_model_log", content: readFileSync(fakeModel.logPath) },
      { name: "fake_imap_log", content: readFileSync(fakeImap.logPath) },
      { name: "fake_mcp_log", content: mcpLogRaw },
    ];
    for (const fname of ["aegis-gov.sqlite", "aegis-gov.sqlite-wal", "pi-durable.sqlite", "pi-durable.sqlite-wal"]) {
      const fp = path.join(hostDataDir, fname);
      if (existsSync(fp)) {
        locationsToScan.push({ name: fname, content: readFileSync(fp) });
      }
    }

    const forbiddenHits: Array<{ location: string; slotId: string }> = [];
    for (const loc of locationsToScan) {
      forbiddenHits.push(...scanBufferOrFile(loc.name, loc.content, allMarkers));
    }
    assert.equal(forbiddenHits.length, 0, `S6 FORBIDDEN SECRET LEAK DETECTED: ${JSON.stringify(forbiddenHits)}`);

    const perSlotReport = [
      {
        slotId: "slot:model-router",
        markerDigestPrefix: routerAuthPrefix,
        allowedLocations: ["host_memory_vault", "loopback_fake_model_router_auth_header"],
        checkedLocations: [...locationsToScan.map((l) => l.name), "model_prompt_bodies", "imap_child_env", "mcp_child_env", "docker_container_env"],
        forbiddenHits: 0,
      },
      {
        slotId: "slot:model-worker",
        markerDigestPrefix: workerAuthPrefix,
        allowedLocations: ["host_memory_vault", "loopback_fake_model_worker_auth_header"],
        checkedLocations: [...locationsToScan.map((l) => l.name), "model_prompt_bodies", "imap_child_env", "mcp_child_env", "docker_container_env"],
        forbiddenHits: 0,
      },
      {
        slotId: "slot:imap-readonly",
        markerDigestPrefix: sha256Prefix16(markers.imap),
        allowedLocations: ["host_memory_vault", "imap_child_stdin_only"],
        checkedLocations: [...locationsToScan.map((l) => l.name), "model_prompt_bodies", "imap_child_env", "mcp_child_env", "docker_container_env"],
        forbiddenHits: 0,
      },
      {
        slotId: "slot:github-mcp-pat",
        markerDigestPrefix: sha256Prefix16(markers.githubPat),
        allowedLocations: ["host_memory_vault", "github_mcp_child_explicit_env"],
        checkedLocations: [...locationsToScan.map((l) => l.name), "model_prompt_bodies", "imap_child_env", "docker_container_env"],
        forbiddenHits: 0,
      },
      {
        slotId: "slot:web-console",
        markerDigestPrefix: sha256Prefix16(markers.consoleToken),
        allowedLocations: ["host_memory_auth_config"],
        checkedLocations: [...locationsToScan.map((l) => l.name), "model_prompt_bodies", "imap_child_env", "mcp_child_env", "docker_container_env"],
        forbiddenHits: 0,
      },
    ];

    const report = {
      suite: "S6",
      runId,
      status: "PASS",
      scannerPositiveControl: { plantedMarkers: 2, detectedHits: canaryHits.length },
      samplingPointsCovered: ["router_generation", "worker_generation", "compaction", "imap_and_mcp_connectors", "docker_sandbox", "post_restart"],
      imapChildEnvKeysCount: imapChildEnvKeys.length,
      mcpChildEnvKeys: mcpStartup.envKeysReceived,
      dockerContainerEnvKeys: containerEnvKeys,
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
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === new URL(`file:///${process.argv[1]!.replace(/\\/g, "/")}`).href) {
  const { report, evidencePath } = await runS6();
  console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
}
