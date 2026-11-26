import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildMinimalDockerCliEnv,
  DEFAULT_SANDBOX_IMAGE,
  inspectDockerEnvironment,
} from "../../src/capabilities/workspace/docker-sandbox.ts";
import { ensureScope } from "../../src/governance/approvals.ts";
import { openGovernanceDb } from "../../src/governance/db.ts";
import { createSaltedMarkerCommitments, scanBufferInMemory } from "../../src/governance/leak-scanner.ts";
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
  s6ObserveDir: string;
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
      "--s6-observe-dir",
      opts.s6ObserveDir,
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
  const s6ObserveDir = path.join(rootDir, "s6-observe");
  mkdirSync(hostDataDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(s6ObserveDir, { recursive: true });
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

  // 0. Scanner positive control BEFORE real scan: prove scanner catches planted markers + wrapped substrings in memory & MCP child!
  const canaryFile = path.join(rootDir, "scanner-canary.txt");
  writeFileSync(canaryFile, `canary payload containing ${markers.router} and ${markers.githubPat}\n`, "utf8");
  const canaryHits = scanBufferOrFile("canary", readFileSync(canaryFile), allMarkers);
  assert.equal(canaryHits.length, 2, "S6: leak scanner positive control MUST detect planted markers");
  rmSync(canaryFile, { force: true });

  const inMemoryCanaryRes = scanBufferInMemory(
    Buffer.from(`prefix_${markers.router}_middle_${markers.imap}_suffix`, "utf8"),
    allMarkers,
  );
  assert.equal(inMemoryCanaryRes.totalForbiddenHits, 2, "W2-S6: in-memory scanner MUST catch wrapped substring markers");
  assert.equal(inMemoryCanaryRes.forbiddenHitsBySlot["slot:model-router"], 1);
  assert.equal(inMemoryCanaryRes.forbiddenHitsBySlot["slot:imap-readonly"], 1);

  const posCommitmentsPath = path.join(rootDir, "scanner-pos-commitments.json");
  const posMcpLogPath = path.join(rootDir, "scanner-pos-mcp.jsonl");
  writeFileSync(posCommitmentsPath, JSON.stringify(createSaltedMarkerCommitments(allMarkers), null, 2), "utf8");
  const posMcpRes = spawnSync(
    LOCKED_NODE_EXE,
    [
      path.resolve("tests/fakes/fake-github-mcp-server.ts"),
      "--log-path",
      posMcpLogPath,
      "--commitments-file",
      posCommitmentsPath,
    ],
    {
      input: "",
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      env: {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: markers.githubPat,
        S6_POS_WRAP: `prefix_${markers.worker}_suffix`,
        S6_POS_EXTRA_PAT: `wrap_${markers.githubPat}_end`,
      },
    },
  );
  assert.equal(posMcpRes.status, 0, `W2-S6: MCP positive control subprocess failed: ${posMcpRes.stderr}`);
  const posMcpLogRaw = readFileSync(posMcpLogPath, "utf8");
  assert.equal(posMcpLogRaw.includes(markers.worker), false, "MCP log MUST NOT write raw leaked value");
  assert.equal(posMcpLogRaw.includes(markers.githubPat), false, "MCP log MUST NOT write raw PAT substring");
  const posMcpStartup = JSON.parse(posMcpLogRaw.trim().split(/\r?\n/)[0]!) as {
    substringScanPerformed: boolean;
    rawValuesWrittenToDisk: boolean;
    forbiddenHitsBySlot: Record<string, number>;
    totalForbiddenHits: number;
  };
  assert.equal(posMcpStartup.substringScanPerformed, true);
  assert.equal(posMcpStartup.rawValuesWrittenToDisk, false);
  assert.equal(posMcpStartup.forbiddenHitsBySlot["slot:model-worker"], 1, "MCP child MUST catch wrapped non-PAT marker substring");
  assert.equal(posMcpStartup.forbiddenHitsBySlot["slot:github-mcp-pat"], 1, "MCP child MUST catch wrapped PAT substring outside allowed key");
  assert.equal(posMcpStartup.totalForbiddenHits, 2);
  rmSync(posCommitmentsPath, { force: true });
  rmSync(posMcpLogPath, { force: true });

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
  const mcpCommitmentsPath = path.join(s6ObserveDir, "mcp-commitments.json");
  const mcpScript = path.resolve("tests/fakes/fake-github-mcp-server.ts");
  const mcpSha = sha256File(mcpScript);
  const mcpArgs = [mcpScript, "--log-path", mcpLogPath, "--commitments-file", mcpCommitmentsPath];

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
  const checkedLocationsBySlot = new Map<string, Set<string>>();

  const recordPoint = (
    point: string,
    artifacts: Array<{ name: string; content: Buffer | string; excludeSlots?: string[] }>,
  ): void => {
    const scannedArtifacts: Array<{ name: string; bytes: number; hits: number }> = [];
    let totalHits = 0;
    for (const a of artifacts) {
      const buf = typeof a.content === "string" ? Buffer.from(a.content, "utf8") : a.content;
      const excluded = new Set(a.excludeSlots ?? []);
      const applicableMarkers = allMarkers.filter((m) => !excluded.has(m.slotId));
      for (const m of applicableMarkers) {
        let s = checkedLocationsBySlot.get(m.slotId);
        if (!s) {
          s = new Set<string>();
          checkedLocationsBySlot.set(m.slotId, s);
        }
        s.add(a.name);
      }
      const hits = scanBufferOrFile(`${point}:${a.name}`, buf, applicableMarkers);
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
      s6ObserveDir,
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
      s6ObserveDir,
    });
    recordPoint("formal_post_restart_live", [
      ...readLiveDbsAndWals(),
      { name: "formal_host2_stdout_stderr", content: formalHost2.getLogs() },
      { name: "fake_model_log", content: readFileSync(fakeModel.logPath) },
      { name: "fake_imap_log", content: readFileSync(fakeImap.logPath) },
      { name: "fake_mcp_log", content: readFileSync(mcpLogPath, "utf8"), excludeSlots: ["slot:github-mcp-pat"] },
    ]);
    await formalHost2.stop();
    formalHost2 = null;

    // W2-S6: Query REAL formal-host audit records + actual observed child/container env & pre-install volume bytes!
    const { db: postS6Db } = openGovernanceDb(path.join(hostDataDir, "aegis-gov.sqlite"));
    const scrubAuditRow = postS6Db
      .prepare("SELECT details_json FROM audit_events WHERE event_type = 'host_startup_env_scrubbed' ORDER BY occurred_at DESC LIMIT 1")
      .get() as { details_json: string } | undefined;
    const imapAuditRow = postS6Db
      .prepare("SELECT details_json FROM audit_events WHERE event_type = 'imap_read_completed' ORDER BY occurred_at DESC LIMIT 1")
      .get() as { details_json: string } | undefined;
    const dockerAuditRow = postS6Db
      .prepare("SELECT details_json FROM audit_events WHERE event_type = 'docker_sandbox_observed' ORDER BY occurred_at DESC LIMIT 1")
      .get() as { details_json: string } | undefined;
    postS6Db.close();

    assert.ok(scrubAuditRow, "W2-S6: Formal host must record dynamic startup env scrub audit");
    const scrubDetails = JSON.parse(scrubAuditRow.details_json) as {
      scrubbedVarNames: string[];
      remainingSecretVars: string[];
      allScrubbed: boolean;
    };
    assert.equal(scrubDetails.allScrubbed, true, `W2-S6: Secret vars remained on host env: ${JSON.stringify(scrubDetails.remainingSecretVars)}`);
    assert.equal(scrubDetails.remainingSecretVars.length, 0);

    assert.ok(imapAuditRow, "W2-S6: Formal host must record IMAP child observed env");
    const imapDetails = JSON.parse(imapAuditRow.details_json) as {
      childEnvKeysObserved: string[];
      childEnvValueDigests?: Record<string, string>;
      passwordPresentInEnv: boolean;
      tlsVerified: boolean;
      readOnlyExamine: boolean;
      usedBodyPeek: boolean;
    };
    assert.equal(imapDetails.passwordPresentInEnv, false);
    assert.ok(imapDetails.childEnvKeysObserved.length >= 1, "W2-S6: IMAP child env keys must be sampled");
    for (const k of imapDetails.childEnvKeysObserved) {
      assert.equal(k.startsWith("AEGISPI_"), false, `IMAP child inherited forbidden key ${k}`);
    }

    assert.ok(dockerAuditRow, "W2-S6: Formal host must record Docker task container & volume inspect audit");
    const dockerDetails = JSON.parse(dockerAuditRow.details_json) as {
      containerId: string;
      volumeName: string;
      executorImageId: string;
      exporterImageId: string | null;
      networkMode: string;
      mounts: Array<{ source: string; destination: string; rw: boolean }>;
      envKeysInContainer: string[];
      dockerCliEnvKeys: string[];
      artifactSha256: string | null;
    };
    assert.ok(dockerDetails.containerId.length > 0);
    assert.equal(dockerDetails.networkMode, "none");
    assert.ok(dockerDetails.mounts.some((m) => m.destination === "/input" && m.rw === false));
    assert.ok(dockerDetails.mounts.some((m) => m.destination === "/out" && m.rw === true));
    for (const k of dockerDetails.envKeysInContainer) {
      assert.equal(/(^AEGISPI_|_SECRET$|_TOKEN$|_PAT$|PERSONAL_ACCESS_TOKEN|API_KEY)/i.test(k), false, `Task container inherited secret env key: ${k}`);
    }
    for (const k of dockerDetails.dockerCliEnvKeys) {
      assert.equal(/(^AEGISPI_|_SECRET$|_TOKEN$|_PAT$|PERSONAL_ACCESS_TOKEN|API_KEY)/i.test(k), false, `Docker CLI env contained secret key: ${k}`);
    }

    // Read ONLY sanitized in-memory scan reports captured by formal src/index.ts under s6ObserveDir
    // (W2-S6: ZERO raw env values or raw .bin volume bytes may ever be written to disk!).
    const obsFiles = readdirSync(s6ObserveDir).sort();
    assert.equal(
      obsFiles.some((f) => f.endsWith(".bin")),
      false,
      "W2-S6: Formal observer MUST NEVER write raw .bin volume export bytes to disk",
    );
    const imapObsName = obsFiles.find((f) => f.startsWith("imap-child-") && f.endsWith(".json"));
    const dockerObsName = obsFiles.find((f) => f.startsWith("docker-sandbox-") && f.endsWith(".json"));
    const volExpObsName = obsFiles.find((f) => f.startsWith("volume-export-") && f.endsWith(".json"));
    assert.ok(imapObsName, "W2-S6: Formal host MUST capture in-memory IMAP child env scan report");
    assert.ok(dockerObsName, "W2-S6: Formal host MUST capture in-memory Docker inspect & CLI scan report");
    assert.ok(volExpObsName, "W2-S6: Formal host MUST capture in-memory pre-install volume scan report");

    const imapObsRawText = readFileSync(path.join(s6ObserveDir, imapObsName), "utf8");
    const imapRawObs = JSON.parse(imapObsRawText) as {
      observedInMemoryOnly: boolean;
      rawValuesWrittenToDisk: boolean;
      envKeys: string[];
      envEntriesCount: number;
      valueDigests: Record<string, string>;
      scannedBytes: number;
      passwordPresentInEnv: boolean;
      forbiddenHitsBySlot: Record<string, number>;
      totalForbiddenHits: number;
    };
    assert.equal(imapRawObs.observedInMemoryOnly, true);
    assert.equal(imapRawObs.rawValuesWrittenToDisk, false);
    assert.ok(imapRawObs.envKeys.length >= 1 && imapRawObs.scannedBytes > 0);
    assert.equal(imapRawObs.passwordPresentInEnv, false);
    assert.equal(imapRawObs.totalForbiddenHits, 0);

    const dockerObsRawText = readFileSync(path.join(s6ObserveDir, dockerObsName), "utf8");
    const dockerRawObs = JSON.parse(dockerObsRawText) as {
      observedInMemoryOnly: boolean;
      rawValuesWrittenToDisk: boolean;
      networkMode: string;
      containerId: string;
      volumeName: string;
      envKeysInContainer: string[];
      rawEnvEntriesCount: number;
      rawEnvScannedBytes: number;
      containerEnvValueDigests: Record<string, string>;
      containerEnvForbiddenHitsBySlot: Record<string, number>;
      cliEnvKeys: string[];
      cliEnvEntriesCount: number;
      cliEnvScannedBytes: number;
      cliEnvForbiddenHitsBySlot: Record<string, number>;
      totalForbiddenHits: number;
    };
    assert.equal(dockerRawObs.observedInMemoryOnly, true);
    assert.equal(dockerRawObs.rawValuesWrittenToDisk, false);
    assert.equal(dockerRawObs.networkMode, "none", "W2-S6: Docker inspect .HostConfig.NetworkMode MUST be 'none'");
    assert.ok(dockerRawObs.rawEnvEntriesCount >= 1 && dockerRawObs.rawEnvScannedBytes > 0);
    assert.ok(dockerRawObs.cliEnvEntriesCount >= 1 && dockerRawObs.cliEnvScannedBytes > 0);
    assert.equal(dockerRawObs.totalForbiddenHits, 0);

    const volExpObsRawText = readFileSync(path.join(s6ObserveDir, volExpObsName), "utf8");
    const volExpMeta = JSON.parse(volExpObsRawText) as {
      observedInMemoryOnly: boolean;
      rawBytesWrittenToDisk: boolean;
      volumeName: string;
      readOnlyMountVerified: boolean;
      exportedFilesCount: number;
      exportedTotalBytes: number;
      files: Array<{ relPath: string; sha256: string; sizeBytes: number }>;
      forbiddenHitsBySlot: Record<string, number>;
      totalForbiddenHits: number;
    };
    assert.equal(volExpMeta.observedInMemoryOnly, true);
    assert.equal(volExpMeta.rawBytesWrittenToDisk, false);
    assert.equal(volExpMeta.readOnlyMountVerified, true);
    assert.ok(volExpMeta.files.length >= 1 && volExpMeta.exportedTotalBytes > 0);
    assert.equal(volExpMeta.totalForbiddenHits, 0);

    // Verify independent model server received exact per-slot auth SHA-256 prefixes (Router vs Worker!)
    const modelStats = await fakeModel.stats();
    const routerAuthPrefix = sha256Prefix16(markers.router);
    const workerAuthPrefix = sha256Prefix16(markers.worker);
    const imapSecretPrefix = sha256Prefix16(markers.imap);
    const githubPatPrefix = sha256Prefix16(markers.githubPat);
    const consoleTokenPrefix = sha256Prefix16(markers.consoleToken);

    const mcpCommitmentsRawText = readFileSync(mcpCommitmentsPath, "utf8");
    const mcpLogRaw = readFileSync(mcpLogPath, "utf8");
    const mcpLines = mcpLogRaw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const mcpStartups = mcpLines.filter((l) => l["kind"] === "startup") as Array<{
      observedInMemoryOnly?: boolean;
      rawValuesWrittenToDisk?: boolean;
      patSha256Prefix: string;
      envKeysReceived: string[];
      envValueDigests?: Record<string, string>;
      nonPatEnvCount?: number;
      nonPatEnvScannedBytes?: number;
      substringScanPerformed?: boolean;
      allEnvScannedBytes?: number;
      forbiddenHitsBySlot?: Record<string, number> | null;
      totalForbiddenHits?: number | null;
    }>;
    assert.ok(mcpStartups.length >= 1, "W2-S6: Fake MCP server must record startup observation");
    for (const st of mcpStartups) {
      assert.equal(st.observedInMemoryOnly, true);
      assert.equal(st.rawValuesWrittenToDisk, false);
      assert.equal(st.substringScanPerformed, true, "W2-S6: MCP child MUST perform in-memory substring scan against salted commitments");
      assert.ok((st.allEnvScannedBytes ?? 0) > 0, "W2-S6: MCP child allEnvScannedBytes must be > 0");
      assert.ok(st.forbiddenHitsBySlot && typeof st.forbiddenHitsBySlot === "object");
    }
    const mcpStartup = mcpStartups[0]!;
    assert.equal(mcpStartup.patSha256Prefix, githubPatPrefix);
    assert.ok((mcpStartup.nonPatEnvCount ?? 0) >= 1 && (mcpStartup.nonPatEnvScannedBytes ?? 0) > 0);
    assert.ok(mcpStartup.envValueDigests && typeof mcpStartup.envValueDigests === "object");
    // Verify MCP child did NOT receive ANY of the other 4 formal startup secrets (neither key nor value digest)!
    const mcpEnvKeysJoined = mcpStartup.envKeysReceived.join(",");
    assert.equal(mcpEnvKeysJoined.includes("AEGISPI_CONSOLE_TOKEN"), false);
    assert.equal(mcpEnvKeysJoined.includes("AEGISPI_MODEL_ROUTER_KEY"), false);
    assert.equal(mcpEnvKeysJoined.includes("AEGISPI_MODEL_WORKER_KEY"), false);
    assert.equal(mcpEnvKeysJoined.includes("AEGISPI_IMAP_SECRET"), false);
    for (const [k, digest] of Object.entries(mcpStartup.envValueDigests)) {
      if (k !== "GITHUB_PERSONAL_ACCESS_TOKEN") {
        assert.notEqual(digest, githubPatPrefix);
      }
      assert.notEqual(digest, routerAuthPrefix);
      assert.notEqual(digest, workerAuthPrefix);
      assert.notEqual(digest, imapSecretPrefix);
      assert.notEqual(digest, consoleTokenPrefix);
    }

    // Sampling point 4: Fold real in-memory scan results (ZERO hardcoded hit counts!) + scan all sanitized metadata files!
    const pushInMemoryHits = (locationName: string, hitsBySlot: Record<string, number> | null | undefined): number => {
      if (!hitsBySlot) return 0;
      let total = 0;
      for (const [slotId, count] of Object.entries(hitsBySlot)) {
        if (count > 0) {
          for (let i = 0; i < count; i++) {
            forbiddenHits.push({ location: locationName, slotId });
          }
          total += count;
        }
      }
      return total;
    };
    const imapHitsCount = pushInMemoryHits("in_memory:imap_child_raw_env", imapRawObs.forbiddenHitsBySlot);
    const dockerCtrHitsCount = pushInMemoryHits("in_memory:docker_container_raw_env", dockerRawObs.containerEnvForbiddenHitsBySlot);
    const dockerCliHitsCount = pushInMemoryHits("in_memory:docker_cli_passed_env", dockerRawObs.cliEnvForbiddenHitsBySlot);
    const volExpHitsCount = pushInMemoryHits("in_memory:volume_export_bytes", volExpMeta.forbiddenHitsBySlot);
    let mcpEnvHitsCount = 0;
    for (const st of mcpStartups) {
      mcpEnvHitsCount += pushInMemoryHits("in_memory:mcp_child_all_env_substring", st.forbiddenHitsBySlot);
    }
    const mcpAllEnvBytes = Math.max(...mcpStartups.map((st) => st.allEnvScannedBytes ?? 0));

    const inMemoryArtifacts: Array<{ name: string; bytes: number; hits: number }> = [
      { name: "imap_child_raw_env", bytes: imapRawObs.scannedBytes, hits: imapHitsCount },
      { name: "docker_container_raw_env", bytes: dockerRawObs.rawEnvScannedBytes, hits: dockerCtrHitsCount },
      { name: "docker_cli_passed_env", bytes: dockerRawObs.cliEnvScannedBytes, hits: dockerCliHitsCount },
      { name: "volume_export_bytes", bytes: volExpMeta.exportedTotalBytes, hits: volExpHitsCount },
      { name: "mcp_child_non_pat_env", bytes: mcpStartup.nonPatEnvScannedBytes ?? 0, hits: mcpEnvHitsCount },
      { name: "mcp_child_all_env_substring", bytes: mcpAllEnvBytes, hits: mcpEnvHitsCount },
    ];
    for (const a of inMemoryArtifacts) {
      for (const m of allMarkers) {
        let s = checkedLocationsBySlot.get(m.slotId);
        if (!s) {
          s = new Set<string>();
          checkedLocationsBySlot.set(m.slotId, s);
        }
        s.add(a.name);
      }
    }
    recordPoint("formal_child_and_container_observations", [
      { name: "host_env_scrub_audit", content: scrubAuditRow.details_json },
      { name: "imap_child_observed_env", content: imapAuditRow.details_json },
      { name: "imap_child_in_memory_sanitized_summary", content: imapObsRawText },
      { name: "docker_task_container_and_volume_audit", content: dockerAuditRow.details_json },
      { name: "docker_in_memory_sanitized_summary", content: dockerObsRawText },
      { name: "docker_cli_whitelist_control_probe", content: dockerCliEnvJson },
      { name: "volume_export_in_memory_sanitized_summary", content: volExpObsRawText },
      { name: "mcp_child_env_digests", content: JSON.stringify(mcpStartup.envValueDigests), excludeSlots: ["slot:github-mcp-pat"] },
      { name: "mcp_commitments_salted", content: mcpCommitmentsRawText },
    ]);
    samplingMatrix[samplingMatrix.length - 1]!.scannedArtifacts.push(...inMemoryArtifacts);
    samplingMatrix[samplingMatrix.length - 1]!.totalHits += inMemoryArtifacts.reduce((a, b) => a + b.hits, 0);

    const routerReqs = modelStats.records.filter((r) => r.model === "fake-router-1");
    const workerReqs = modelStats.records.filter((r) => r.model === "fake-worker-1");
    assert.ok(routerReqs.length >= 2, "Router must have made generation + compaction requests via formal host");
    assert.ok(workerReqs.length >= 1, "Worker must have made request via formal host");
    assert.ok(routerReqs.every((r) => r.authHeaderSha256Prefix === routerAuthPrefix));
    assert.ok(workerReqs.every((r) => r.authHeaderSha256Prefix === workerAuthPrefix));
    for (const m of allMarkers) {
      let s = checkedLocationsBySlot.get(m.slotId);
      if (!s) {
        s = new Set<string>();
        checkedLocationsBySlot.set(m.slotId, s);
      }
      s.add("model_prompt_bodies");
    }
    for (const r of modelStats.records) {
      const hits = Object.values(r.markerHits ?? {}).reduce((a, b) => a + b, 0);
      assert.equal(hits, 0, `Secret marker leaked into model prompt body: ${JSON.stringify(r.markerHits)}`);
    }

    const imapStats = await fakeImap.stats();
    assert.ok(imapStats.totalLogins >= 1, "Formal host must have executed real IMAP read");
    assert.equal(forbiddenHits.length, 0, `S6 FORBIDDEN SECRET LEAK DETECTED: ${JSON.stringify(forbiddenHits)}`);

    // Dynamically compute uncollectedSamples from ACTUAL observed artifacts across all sampling points!
    const allObservedNames = new Map<string, number>();
    for (const pt of samplingMatrix) {
      for (const a of pt.scannedArtifacts) {
        allObservedNames.set(a.name, Math.max(allObservedNames.get(a.name) ?? 0, a.bytes));
      }
    }
    const requiredSampleNames = [
      "aegis-gov.sqlite",
      "aegis-gov.sqlite-wal",
      "pi-durable.sqlite",
      "pi-durable.sqlite-wal",
      "web_snapshot",
      "web_sse_frame",
      "captured_urls",
      "formal_host_stdout_stderr",
      "fake_model_log",
      "fake_imap_log",
      "fake_mcp_log",
      "imap_child_observed_env",
      "imap_child_raw_env",
      "docker_task_container_and_volume_audit",
      "docker_container_raw_env",
      "docker_cli_passed_env",
      "docker_cli_whitelist_control_probe",
      "volume_export_bytes",
      "mcp_child_non_pat_env",
      "mcp_child_all_env_substring",
      "mcp_child_env_digests",
      "mcp_commitments_salted",
      "host_env_scrub_audit",
      "workspace_output_file",
    ];
    const uncollectedSamples: string[] = [];
    for (const reqName of requiredSampleNames) {
      const b = allObservedNames.get(reqName);
      if (b === undefined || b <= 0) {
        uncollectedSamples.push(reqName);
      }
    }
    if (!sseText.includes("event:")) {
      uncollectedSamples.push("web_sse_frame_nonempty_event");
    }
    if (imapDetails.childEnvKeysObserved.length === 0) {
      uncollectedSamples.push("imap_child_env_keys");
    }
    if (dockerRawObs.rawEnvEntriesCount === 0) {
      uncollectedSamples.push("docker_container_raw_env_entries");
    }
    if (!mcpStartups.every((st) => st.substringScanPerformed === true)) {
      uncollectedSamples.push("mcp_child_substring_scan");
    }
    assert.deepEqual(uncollectedSamples, [], `W2-S6: Missing required live S6 samples: ${JSON.stringify(uncollectedSamples)}`);

    const countSlotHits = (slotId: string): number =>
      forbiddenHits.filter((h) => h.slotId === slotId).length;
    const locationsForSlot = (slotId: string): string[] =>
      [...(checkedLocationsBySlot.get(slotId) ?? [])].sort();

    const perSlotReport = [
      {
        slotId: "slot:model-router",
        markerDigestPrefix: routerAuthPrefix,
        allowedLocations: ["host_memory_vault", "loopback_fake_model_router_auth_header"],
        checkedLocations: locationsForSlot("slot:model-router"),
        forbiddenHits: countSlotHits("slot:model-router"),
      },
      {
        slotId: "slot:model-worker",
        markerDigestPrefix: workerAuthPrefix,
        allowedLocations: ["host_memory_vault", "loopback_fake_model_worker_auth_header"],
        checkedLocations: locationsForSlot("slot:model-worker"),
        forbiddenHits: countSlotHits("slot:model-worker"),
      },
      {
        slotId: "slot:imap-readonly",
        markerDigestPrefix: imapSecretPrefix,
        allowedLocations: ["host_memory_vault", "imap_child_stdin_only"],
        checkedLocations: locationsForSlot("slot:imap-readonly"),
        forbiddenHits: countSlotHits("slot:imap-readonly"),
      },
      {
        slotId: "slot:github-mcp-pat",
        markerDigestPrefix: githubPatPrefix,
        allowedLocations: ["host_memory_vault", "github_mcp_child_explicit_env"],
        checkedLocations: locationsForSlot("slot:github-mcp-pat"),
        forbiddenHits: countSlotHits("slot:github-mcp-pat"),
      },
      {
        slotId: "slot:web-console",
        markerDigestPrefix: consoleTokenPrefix,
        allowedLocations: ["host_memory_auth_config"],
        checkedLocations: locationsForSlot("slot:web-console"),
        forbiddenHits: countSlotHits("slot:web-console"),
      },
    ];

    const report = {
      suite: "S6",
      runId,
      status: "PASS",
      formalEntrypointUsed: true,
      formalEntrypoint: "src/index.ts",
      hostStartupSecretEnvScrubbed: scrubDetails.allScrubbed,
      hostStartupRemainingSecretVars: scrubDetails.remainingSecretVars,
      scannerPositiveControl: {
        plantedMarkers: 2,
        detectedHits: canaryHits.length,
        inMemorySubstringPlantedMarkers: 2,
        inMemorySubstringDetectedHits: inMemoryCanaryRes.totalForbiddenHits,
        mcpChildSubstringPlantedMarkers: 2,
        mcpChildSubstringDetectedHits: posMcpStartup.totalForbiddenHits,
        mcpChildSubstringHitsBySlot: posMcpStartup.forbiddenHitsBySlot,
      },
      samplingPointMatrix: samplingMatrix,
      uncollectedSamples,
      notDirectlyCapturedFromExternalOs: [
        "docker.exe external OS GetEnvironmentStrings (verified via formal host dockerCliEnvEntries allowlist audit + whitelist control probe + docker inspect .Config.Env)",
      ],
      dockerDigests: {
        approvedImageId,
        executorImageId: dockerDetails.executorImageId,
        exporterImageId: dockerDetails.exporterImageId,
      },
      dockerTaskContainer: {
        containerId: dockerRawObs.containerId,
        volumeName: dockerRawObs.volumeName,
        networkMode: dockerRawObs.networkMode,
        mounts: dockerDetails.mounts,
        envKeysInContainer: dockerDetails.envKeysInContainer,
        rawEnvEntriesCount: dockerRawObs.rawEnvEntriesCount,
        artifactSha256: dockerDetails.artifactSha256,
      },
      volumePreInstallExport: {
        readOnlyMountVerified: volExpMeta.readOnlyMountVerified,
        exportedFilesCount: volExpMeta.files.length,
        exportedTotalBytes: volExpMeta.exportedTotalBytes,
        observedInMemoryOnly: true,
        rawBytesWrittenToDisk: false,
      },
      dockerCliMinimalEnvKeysPassed: dockerRawObs.cliEnvKeys,
      dockerCliWhitelistControlEnvKeys: dockerCliEnvKeys,
      imapChildObservedEnvKeys: imapDetails.childEnvKeysObserved,
      imapChildObservedValueDigestCount: Object.keys(imapRawObs.valueDigests ?? {}).length,
      imapChildPasswordPresentInEnv: imapDetails.passwordPresentInEnv,
      mcpChildEnvKeys: mcpStartup.envKeysReceived,
      mcpChildNonPatEntriesCount: mcpStartup.nonPatEnvCount ?? 0,
      mcpChildSubstringScanPerformed: mcpStartups.every((st) => st.substringScanPerformed === true),
      mcpChildAllEnvScannedBytes: mcpAllEnvBytes,
      mcpChildForbiddenHitsBySlot: mcpStartup.forbiddenHitsBySlot ?? {},
      observerInMemoryOnly: true,
      rawValuesOrVolumeBytesWrittenToDisk: false,
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
