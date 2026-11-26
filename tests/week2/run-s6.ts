import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildMinimalDockerCliEnv,
  DEFAULT_SANDBOX_IMAGE,
  inspectDockerEnvironment,
} from "../../src/capabilities/workspace/docker-sandbox.ts";
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

async function spawnFormalHostForS6(opts: {
  dataDir: string;
  modelBaseUrl: string;
  smtpHost: string;
  smtpPort: number;
  connectorsConfigPath: string;
  envSecrets: Record<string, string>;
}): Promise<{
  pid: number;
  baseUrl: string;
  runtimeEpoch: string;
  getLogs: () => string;
  stop: () => Promise<void>;
}> {
  const proc = spawn(
    LOCKED_NODE_EXE,
    [
      "src/index.ts",
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
      "--connectors-config",
      opts.connectorsConfigPath,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...opts.envSecrets },
    },
  );

  let stdoutAll = "";
  let stderrAll = "";
  const ready = await new Promise<{ pid: number; baseUrl: string; runtimeEpoch: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Formal S6 host timed out.\nstdout=${stdoutAll}\nstderr=${stderrAll}`));
    }, 20_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutAll += chunk.toString("utf8");
      for (const line of stdoutAll.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as { ready?: boolean; pid?: number; baseUrl?: string; runtimeEpoch?: string };
          if (parsed.ready && parsed.baseUrl && parsed.pid && parsed.runtimeEpoch) {
            clearTimeout(timer);
            resolve({ pid: parsed.pid, baseUrl: parsed.baseUrl, runtimeEpoch: parsed.runtimeEpoch });
            return;
          }
        } catch {
          // partial line
        }
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrAll += chunk.toString("utf8");
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Formal S6 host exited early (${String(code)}).\nstdout=${stdoutAll}\nstderr=${stderrAll}`));
    });
  });

  return {
    ...ready,
    getLogs: () => `${stdoutAll}\n${stderrAll}`,
    stop: async () => {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              // ignore
            }
            resolve();
          }, 3000);
          proc.once("exit", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
  };
}

export async function runS6(opts?: { dataDir?: string; evidenceDir?: string }) {
  const runId = `s6_${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(opts?.dataDir ?? `.tmp-week2-s6-${Date.now()}`);
  const evidenceDir = path.resolve(opts?.evidenceDir ?? path.join(rootDir, "evidence"));
  const hostDataDir = path.join(rootDir, "host-data");
  const workspaceDir = path.join(rootDir, "workspace");
  mkdirSync(hostDataDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const dockerEnv = inspectDockerEnvironment(DEFAULT_SANDBOX_IMAGE);
  assert.equal(dockerEnv.available, true, "Docker image required for S6");
  const approvedImageId = dockerEnv.imageId!;

  // Independent synthetic markers per slot (passed into REAL formal src/index.ts via startup env; never logged raw in evidence!)
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

  // 0b. W2-S6: Direct proof that buildMinimalDockerCliEnv() strips ALL 5 formal startup secrets from Docker CLI child env!
  const simulatedHostEnvWithSecrets: NodeJS.ProcessEnv = {
    ...process.env,
    AEGISPI_CONSOLE_TOKEN: markers.consoleToken,
    AEGISPI_MODEL_ROUTER_KEY: markers.router,
    AEGISPI_MODEL_WORKER_KEY: markers.worker,
    AEGISPI_IMAP_SECRET: markers.imap,
    AEGISPI_GITHUB_MCP_PAT: markers.githubPat,
  };
  const dockerCliEnv = buildMinimalDockerCliEnv(simulatedHostEnvWithSecrets);
  const dockerCliChild = spawnSync(LOCKED_NODE_EXE, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
    encoding: "utf8",
    env: dockerCliEnv,
    windowsHide: true,
  });
  assert.equal(dockerCliChild.status, 0);
  const dockerCliEnvJson = dockerCliChild.stdout;
  const dockerCliEnvHits = scanBufferOrFile("docker_cli_child_env", dockerCliEnvJson, allMarkers);
  assert.equal(dockerCliEnvHits.length, 0, "W2-S6: Docker CLI child env MUST receive 0 host secret markers");
  const dockerCliEnvKeys = Object.keys(JSON.parse(dockerCliEnvJson) as Record<string, string>).sort();

  const fakeModel = await startFakeModelServer(path.join(rootDir, "fake-model"));
  const fakeSmtp = await startFakeSmtpServer(path.join(rootDir, "fake-smtp"), { mode: "normal" });
  const fakeImap = await startFakeImapServer(path.join(rootDir, "fake-imap"), {
    certCn: "imap.local.test",
    user: "owner@local.test",
    pass: markers.imap,
  });

  const imapCaPath = path.join(rootDir, "imap-ca.pem");
  writeFileSync(imapCaPath, fakeImap.certPem, "utf8");

  const mcpLogPath = path.join(rootDir, "fake-mcp", "mcp-calls.jsonl");
  const mcpScript = path.resolve("tests/fakes/fake-github-mcp-server.ts");
  const mcpSha = sha256File(mcpScript);
  const mcpArgs = [mcpScript, "--log-path", mcpLogPath];

  // Pre-seed governance DB with grants & MCP pins for formal src/index.ts
  const now = Date.now();
  const { db: seedDb } = openGovernanceDb(path.join(hostDataDir, "aegis-gov.sqlite"));
  ensureActiveEpochAndManifest(seedDb, now);
  ensureScope(seedDb, {
    scopeId: "scope:default",
    allowedPrincipals: ["owner"],
    allowedTools: [
      "send_email",
      "run_worker",
      "mail_read_latest",
      "github_read_file",
      "workspace_write_managed",
    ],
    allowedTargets: ["*"],
  });
  grantSourceRead(seedDb, {
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
  grantSourceRead(seedDb, {
    principalId: "owner",
    scopeId: "scope:default",
    sourceType: "github_mcp",
    resourceId: "github:NorthAdb/project-helios",
    operations: ["read_file"],
    constraints: { allowedRefs: ["refs/heads/main"], allowedPaths: ["README.md"] },
    now,
  });
  grantSourceRead(seedDb, {
    principalId: "owner",
    scopeId: "scope:default",
    sourceType: "workspace_write",
    resourceId: "workspace",
    operations: ["write"],
    constraints: { allowedRelPaths: ["reports/s6-check.md"] },
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
  pinMcpServerBinary(seedDb, {
    serverId: "github-s6",
    executablePath: mcpScript,
    executableSha256: mcpSha,
    command: LOCKED_NODE_EXE,
    args: mcpArgs,
    readOnlyMode: true,
    approvedBy: "owner",
    now,
  });
  approveMcpToolDefinition(seedDb, {
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
  seedDb.close();

  const connectorsConfigPath = path.join(rootDir, "s6-connectors.json");
  writeFileSync(
    connectorsConfigPath,
    JSON.stringify(
      {
        defaultMemoryDomain: "default",
        imap: {
          mode: "direct",
          host: fakeImap.host,
          port: fakeImap.imapPort,
          servername: "imap.local.test",
          caCertPath: imapCaPath,
          username: "owner@local.test",
          mailbox: "INBOX",
          allowedMailboxes: ["INBOX"],
          credentialSlotId: "slot:imap-readonly",
          secretEnvVar: "AEGISPI_IMAP_SECRET",
        },
        githubMcp: {
          serverId: "github-s6",
          command: LOCKED_NODE_EXE,
          args: mcpArgs,
          pinnedArtifactPath: mcpScript,
          pinnedArtifactSha256: mcpSha,
          credentialSlotId: "slot:github-mcp-pat",
          secretEnvVar: "AEGISPI_GITHUB_MCP_PAT",
        },
        workspace: {
          workspaceDir,
          approvedImageId,
          imageName: DEFAULT_SANDBOX_IMAGE,
          trackedBaselineRelPaths: ["reports/s6-check.md"],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const formalStartupSecrets = {
    AEGISPI_CONSOLE_TOKEN: markers.consoleToken,
    AEGISPI_MODEL_ROUTER_KEY: markers.router,
    AEGISPI_MODEL_WORKER_KEY: markers.worker,
    AEGISPI_IMAP_SECRET: markers.imap,
    AEGISPI_GITHUB_MCP_PAT: markers.githubPat,
  };

  const capturedHttpUrls: string[] = [];
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

  let formalHost1: Awaited<ReturnType<typeof spawnFormalHostForS6>> | null = null;
  let formalHost2: Awaited<ReturnType<typeof spawnFormalHostForS6>> | null = null;

  try {
    // 1. Start REAL formal src/index.ts #1 with all 5 synthetic startup secret env vars!
    formalHost1 = await spawnFormalHostForS6({
      dataDir: hostDataDir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      connectorsConfigPath,
      envSecrets: formalStartupSecrets,
    });

    const loginUrl = `${formalHost1.baseUrl}/api/auth/login`;
    capturedHttpUrls.push(loginUrl);
    const loginRes = await fetch(loginUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: formalHost1.baseUrl },
      body: JSON.stringify({ token: markers.consoleToken }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]!;

    // Queue end-to-end Router -> run_worker -> IMAP + GitHub MCP + Docker managed workspace write -> Router final -> Compaction!
    await fakeModel.queue({
      clear: true,
      watchMarkers: Object.values(markers),
      scripts: [
        {
          kind: "tool_call",
          toolCall: { id: "s6_wrk_1", name: "run_worker", arguments: { prompt: "Read IMAP, GitHub MCP, and write report" } },
        },
        {
          kind: "tool_call",
          toolCall: { id: "s6_imap_1", name: "mail_read_latest", arguments: { subjectContains: "Project Helios" } },
        },
        {
          kind: "tool_call",
          toolCall: {
            id: "s6_mcp_1",
            name: "github_read_file",
            arguments: { repoId: "NorthAdb/project-helios", ref: "refs/heads/main", path: "README.md" },
          },
        },
        {
          kind: "tool_call",
          toolCall: {
            id: "s6_ws_1",
            name: "workspace_write_managed",
            arguments: { relPath: "reports/s6-check.md", content: `S6_FORMAL_HOST_OUTPUT_${runId}\n` },
          },
        },
        { kind: "text", text: "S6 worker output clean" },
        { kind: "text", text: "S6 router final clean " + "pad ".repeat(80) },
        { kind: "text", text: "S6 compaction summary clean" },
      ],
    });

    const convUrl = `${formalHost1.baseUrl}/api/conversations`;
    capturedHttpUrls.push(convUrl);
    const convRes = await fetch(convUrl, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: formalHost1.baseUrl },
      body: JSON.stringify({ slotName: "router" }),
    });
    const convBody = (await convRes.json()) as { conversationId: string; runtimeEpoch: string };

    const chatUrl = `${formalHost1.baseUrl}/api/conversations/${convBody.conversationId}/chat`;
    capturedHttpUrls.push(chatUrl);
    const chatRes = await fetch(chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: formalHost1.baseUrl },
      body: JSON.stringify({
        content: "Run S6 formal host leak check across router, worker, IMAP, MCP, and Docker " + "pad ".repeat(80),
        chatKey: `s6-chat-${runId}`,
        runtimeEpoch: convBody.runtimeEpoch,
      }),
    });
    assert.equal(chatRes.status, 200);

    // Wait for Router + Worker + IMAP + MCP + Docker workspace write to complete on formal host!
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (existsSync(path.join(workspaceDir, "reports", "s6-check.md"))) {
        const st = await fakeModel.stats();
        if (st.totalPhysicalRequests >= 6) break;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    assert.equal(existsSync(path.join(workspaceDir, "reports", "s6-check.md")), true, "S6: formal host must complete Docker workspace write");

    // Sampling point 1: LIVE WAL + DB + URL + formal host logs after Router/Worker/IMAP/MCP/Docker
    const liveWalsAfterGen = readLiveDbsAndWals();
    assert.ok(
      liveWalsAfterGen.some((f) => f.name.endsWith("-wal") && f.content.length > 0),
      "S6: MUST observe non-empty live WAL while formal host is running",
    );
    recordPoint("formal_router_worker_connectors_live", [
      ...liveWalsAfterGen,
      { name: "captured_urls", content: capturedHttpUrls.join("\n") },
      { name: "formal_host_stdout_stderr", content: formalHost1.getLogs() },
      { name: "fake_model_log", content: readFileSync(fakeModel.logPath) },
      { name: "fake_imap_log", content: readFileSync(fakeImap.logPath) },
      { name: "fake_mcp_log", content: readFileSync(mcpLogPath, "utf8") },
      { name: "workspace_output_file", content: readFileSync(path.join(workspaceDir, "reports", "s6-check.md")) },
    ]);

    // Sampling point 2: Trigger real Compaction via formal Web API + scan LIVE WAL, /snapshot, /events SSE
    const compactUrl = `${formalHost1.baseUrl}/api/conversations/${convBody.conversationId}/compact`;
    capturedHttpUrls.push(compactUrl);
    const cmpRes = await fetch(compactUrl, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: formalHost1.baseUrl },
      body: JSON.stringify({ instructions: "Compact for S6 formal check" }),
    });
    assert.equal(cmpRes.status, 200);
    await new Promise((r) => setTimeout(r, 400));

    const snapUrl = `${formalHost1.baseUrl}/api/conversations/${convBody.conversationId}/snapshot`;
    capturedHttpUrls.push(snapUrl);
    const snapText = await (await fetch(snapUrl, { headers: { cookie } })).text();
    const snapParsed = JSON.parse(snapText) as {
      cursor: string;
      fileImports: Array<{ state: string; targetRelPath: string }>;
    };
    assert.ok(snapParsed.fileImports.some((f) => f.targetRelPath === "reports/s6-check.md" && f.state === "INSTALLED"));

    const sseUrl = `${formalHost1.baseUrl}/api/conversations/${convBody.conversationId}/events`;
    capturedHttpUrls.push(sseUrl);
    const ac = new AbortController();
    const sseText = await fetch(sseUrl, { headers: { cookie }, signal: ac.signal })
      .then(async (r) => {
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        let acc = "";
        const t = setTimeout(() => ac.abort(), 400);
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            acc += dec.decode(value, { stream: true });
            if (acc.includes("\n\n")) break;
          }
        } catch {
          // expected abort
        } finally {
          clearTimeout(t);
        }
        return acc;
      })
      .catch(() => "");

    recordPoint("formal_compaction_web_live", [
      ...readLiveDbsAndWals(),
      { name: "web_snapshot", content: snapText },
      { name: "web_sse_frame", content: sseText },
      { name: "captured_urls", content: capturedHttpUrls.join("\n") },
      { name: "docker_cli_minimal_env", content: dockerCliEnvJson },
    ]);

    await formalHost1.stop();
    formalHost1 = null;

    // Sampling point 3: Restart formal src/index.ts #2 on same dataDir and scan post-restart live DBs/WALs + logs!
    formalHost2 = await spawnFormalHostForS6({
      dataDir: hostDataDir,
      modelBaseUrl: fakeModel.baseUrl,
      smtpHost: fakeSmtp.host,
      smtpPort: fakeSmtp.smtpPort,
      connectorsConfigPath,
      envSecrets: formalStartupSecrets,
    });
    recordPoint("formal_post_restart_live", [
      ...readLiveDbsAndWals(),
      { name: "formal_host2_stdout_stderr", content: formalHost2.getLogs() },
      { name: "fake_model_log", content: readFileSync(fakeModel.logPath) },
      { name: "fake_imap_log", content: readFileSync(fakeImap.logPath) },
      { name: "fake_mcp_log", content: readFileSync(mcpLogPath, "utf8") },
    ]);
    await formalHost2.stop();
    formalHost2 = null;

    // Verify independent model server received exact per-slot auth SHA-256 prefixes (Router vs Worker!)
    const modelStats = await fakeModel.stats();
    const routerAuthPrefix = sha256Prefix16(markers.router);
    const workerAuthPrefix = sha256Prefix16(markers.worker);
    const routerReqs = modelStats.records.filter((r) => r.model === "fake-router-1");
    const workerReqs = modelStats.records.filter((r) => r.model === "fake-worker-1");
    assert.ok(routerReqs.length >= 2, "Router must have made generation + compaction requests via formal host");
    assert.ok(workerReqs.length >= 1, "Worker must have made request via formal host");
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
    // Verify MCP child did NOT receive ANY of the other 4 formal startup secrets!
    const mcpEnvKeysJoined = mcpStartup.envKeysReceived.join(",");
    assert.equal(mcpEnvKeysJoined.includes("AEGISPI_CONSOLE_TOKEN"), false);
    assert.equal(mcpEnvKeysJoined.includes("AEGISPI_MODEL_ROUTER_KEY"), false);
    assert.equal(mcpEnvKeysJoined.includes("AEGISPI_MODEL_WORKER_KEY"), false);
    assert.equal(mcpEnvKeysJoined.includes("AEGISPI_IMAP_SECRET"), false);

    const imapStats = await fakeImap.stats();
    assert.ok(imapStats.totalLogins >= 1, "Formal host must have executed real IMAP read");
    assert.equal(forbiddenHits.length, 0, `S6 FORBIDDEN SECRET LEAK DETECTED: ${JSON.stringify(forbiddenHits)}`);

    const checkedLocationsAll = [
      "live_aegis-gov.sqlite",
      "live_aegis-gov.sqlite-wal",
      "live_pi-durable.sqlite",
      "live_pi-durable.sqlite-wal",
      "captured_urls",
      "formal_host_stdout_stderr",
      "web_snapshot",
      "web_sse_frame",
      "fake_model_log",
      "fake_imap_log",
      "fake_mcp_log",
      "model_prompt_bodies",
      "docker_cli_minimal_env",
      "workspace_output_file",
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
      formalEntrypointUsed: true,
      formalEntrypoint: "src/index.ts",
      hostStartupSecretEnvScrubbed: true,
      scannerPositiveControl: {
        plantedMarkers: 2,
        detectedHits: canaryHits.length,
      },
      samplingPointMatrix: samplingMatrix,
      uncollectedSamples: [] as string[],
      dockerDigests: {
        approvedImageId,
      },
      dockerCliMinimalEnvKeys: dockerCliEnvKeys,
      mcpChildEnvKeys: mcpStartup.envKeysReceived,
      capturedUrlsCount: capturedHttpUrls.length,
      totalForbiddenHits: forbiddenHits.length,
      slots: perSlotReport,
    };
    const evidencePath = path.join(evidenceDir, "s6-evidence.json");
    writeFileSync(evidencePath, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { report, evidencePath };
  } finally {
    await formalHost1?.stop().catch(() => {});
    await formalHost2?.stop().catch(() => {});
    await fakeImap.stop().catch(() => {});
    await fakeSmtp.stop().catch(() => {});
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
