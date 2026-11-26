import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ImapEndpointConfig } from "./capabilities/mail/imap-client.ts";
import {
  cleanupTaskVolumeAsync,
  DEFAULT_SANDBOX_IMAGE,
  runTaskInDockerSandboxAsync,
  stopAndRemoveContainerAsync,
} from "./capabilities/workspace/docker-sandbox.ts";
import { ManagedWorkspaceImporter } from "./capabilities/workspace/importer.ts";
import {
  assertStage1LoopbackModelUrl,
  assertStage1LoopbackSmtpHost,
  HostCredentialVault,
} from "./governance/credentials.ts";
import { writeAuditEvent } from "./governance/db.ts";
import {
  createSaltedMarkerCommitments,
  scanBufferInMemory,
} from "./governance/leak-scanner.ts";
import { checkSourceReadAuthorized } from "./governance/policy.ts";
import { AegisHostRuntime } from "./runtime/harness.ts";
import { GitHubMcpBridge } from "./runtime/mcp-bridge.ts";
import type { ModelSlotConfig } from "./runtime/models.ts";
import { startWebServer } from "./web/server.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg && arg.startsWith("--")) {
      const k = arg.slice(2);
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

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args["data-dir"] ?? process.env["AEGISPI_DATA_DIR"] ?? "data");
const port = Number(args["port"] ?? process.env["AEGISPI_PORT"] ?? "4310");
const bindHost = args["bind-host"] ?? "127.0.0.1";
const modelBaseUrl = args["model-base-url"] ?? process.env["AEGISPI_MODEL_BASE_URL"] ?? "http://127.0.0.1:4391";
const smtpHost = args["smtp-host"] ?? process.env["AEGISPI_SMTP_HOST"] ?? "127.0.0.1";
const smtpPort = Number(args["smtp-port"] ?? process.env["AEGISPI_SMTP_PORT"] ?? "4392");
const defaultPrincipalId = args["default-principal"] ?? process.env["AEGISPI_DEFAULT_PRINCIPAL"] ?? "owner";
const consoleToken = args["console-token"] ?? process.env["AEGISPI_CONSOLE_TOKEN"];
const principalTokensRaw = args["principal-tokens-json"] ?? process.env["AEGISPI_PRINCIPAL_TOKENS_JSON"];

let consoleTokens: Record<string, string> | undefined = undefined;
if (principalTokensRaw) {
  try {
    const parsed = JSON.parse(principalTokensRaw) as Record<string, unknown>;
    consoleTokens = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.length > 0) {
        consoleTokens[k] = v;
      }
    }
  } catch {
    process.stderr.write("Refusing startup: invalid principal-tokens-json\n");
    process.exit(1);
  }
}

// G1: Formal entry MUST refuse startup when no console token is configured (zero hardcoded fallback!)
if (
  (!consoleToken || consoleToken.trim().length === 0) &&
  (!consoleTokens || Object.keys(consoleTokens).length === 0)
) {
  process.stderr.write(
    "Refusing startup: AEGISPI_CONSOLE_TOKEN (--console-token) or AEGISPI_PRINCIPAL_TOKENS_JSON is required.\n",
  );
  process.exit(1);
}

// G2: Stage 1 hard egress boundary — refuse non-loopback model or SMTP endpoints BEFORE opening DB or Web!
try {
  assertStage1LoopbackModelUrl(modelBaseUrl);
  assertStage1LoopbackSmtpHost(smtpHost, smtpPort);
} catch (err) {
  process.stderr.write(`Refusing startup: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const taskLimitMu = Number(args["task-limit-mu"] ?? "800000");
const dayLimitMu = Number(args["day-limit-mu"] ?? "5000000");
const syntheticUpperMu = args["synthetic-upper-mu"] ? Number(args["synthetic-upper-mu"]) : 100;
const syntheticActualMu = args["synthetic-actual-mu"] ? Number(args["synthetic-actual-mu"]) : 60;
const smtpTimeoutMs = args["smtp-timeout-ms"] ? Number(args["smtp-timeout-ms"]) : 60_000;
const approvalTtlMs = args["approval-ttl-ms"] ? Number(args["approval-ttl-ms"]) : undefined;
const pauseOutbox = args["pause-outbox"] === "true";
const connectorsConfigPath = args["connectors-config"] ?? process.env["AEGISPI_CONNECTORS_CONFIG"];

// Explicit test-only fault barriers for R5/V04/V03 real Windows Stop-Process -Force window verification
const faultBeforeT2CommitFile = args["fault-before-t2-commit"];
const faultAfterSignalBeforeAckFile = args["fault-after-signal-before-ack"];
const faultAfterClaimBeforeSmtpFile = args["fault-after-claim-before-smtp"];
const faultAfterChatGovRegisterFile = args["fault-after-chat-gov-register"];
const faultAfterPiAdmitBeforeGovReceiptFile = args["fault-after-pi-admit-before-gov-receipt"];
const faultAfterChatGovReceiptBeforeHttpFile = args["fault-after-chat-gov-receipt-before-http"];
const faultChatReconcileReadFailure = args["fault-chat-reconcile-read-failure"];
const faultAfterImportInstallBeforeReceiptFile = args["fault-after-import-install-before-receipt"];
const s6ObserveDir = args["s6-observe-dir"] ? path.resolve(args["s6-observe-dir"]) : undefined;
if (s6ObserveDir) {
  mkdirSync(s6ObserveDir, { recursive: true });
}

interface TrustedConnectorsConfig {
  defaultMemoryDomain?: string;
  imap?: {
    mode: "direct" | "connect_tunnel";
    host: string;
    port: number;
    servername: string;
    caCertPath?: string;
    proxy?: { host: string; port: number };
    username: string;
    mailbox: string;
    allowedMailboxes?: string[];
    credentialSlotId?: string;
    secretEnvVar?: string;
  };
  githubMcp?: {
    serverId: string;
    command: string;
    args: string[];
    pinnedArtifactPath: string;
    pinnedArtifactSha256: string;
    credentialSlotId?: string;
    secretEnvVar?: string;
  };
  workspace?: {
    workspaceDir: string;
    approvedImageId: string;
    imageName?: string;
    trackedBaselineRelPaths?: string[];
  };
}

let connectorsCfg: TrustedConnectorsConfig | null = null;
if (connectorsConfigPath) {
  try {
    connectorsCfg = JSON.parse(readFileSync(path.resolve(connectorsConfigPath), "utf8")) as TrustedConnectorsConfig;
  } catch (err) {
    process.stderr.write(
      `Refusing startup: invalid connectors-config (${err instanceof Error ? err.message : String(err)})\n`,
    );
    process.exit(1);
  }
}

const vault = new HostCredentialVault();
const routerSecret =
  process.env["AEGISPI_MODEL_ROUTER_KEY"] ??
  process.env["AEGISPI_FAKE_MODEL_KEY"] ??
  "SYNTHETIC_HOST_MEMORY_MODEL_KEY_V2";
const workerSecret =
  process.env["AEGISPI_MODEL_WORKER_KEY"] ??
  process.env["AEGISPI_FAKE_MODEL_KEY"] ??
  routerSecret;

vault.registerSlot(
  {
    slotId: "slot:model-router",
    provider: "fake-local",
    allowedBaseUrls: [modelBaseUrl],
    allowedModelIds: ["fake-router-1"],
    priceVersion: "synthetic-v1",
  },
  routerSecret,
);
vault.registerSlot(
  {
    slotId: "slot:model-worker",
    provider: "fake-local",
    allowedBaseUrls: [modelBaseUrl],
    allowedModelIds: ["fake-worker-1"],
    priceVersion: "synthetic-v1",
  },
  workerSecret,
);
// Keep legacy slot alias for Week 1 compatibility
vault.registerSlot(
  {
    slotId: "slot:fake-local",
    provider: "fake-local",
    allowedBaseUrls: [modelBaseUrl],
    allowedModelIds: ["fake-router-1", "fake-worker-1"],
    priceVersion: "synthetic-v1",
  },
  routerSecret,
);

// W2-S6: In-memory only secret marker scanner (NEVER writes raw env values or volume bytes to disk!)
const collectInMemorySlotMarkers = (): Array<{ slotId: string; marker: string }> => {
  const markers: Array<{ slotId: string; marker: string }> = vault
    .registeredSlotMarkersForAudit()
    .map((m) => ({ slotId: m.slotId, marker: m.marker }));
  if (consoleToken && consoleToken.length > 0) {
    markers.push({ slotId: "slot:web-console", marker: consoleToken });
  }
  if (consoleTokens) {
    for (const tok of Object.values(consoleTokens)) {
      if (tok && tok.length > 0 && !markers.some((m) => m.slotId === "slot:web-console" && m.marker === tok)) {
        markers.push({ slotId: "slot:web-console", marker: tok });
      }
    }
  }
  return markers;
};

const scanBufferStrictlyInMemory = (
  buf: Buffer,
  excludeSlots: string[] = [],
): { scannedBytes: number; forbiddenHitsBySlot: Record<string, number>; totalForbiddenHits: number } =>
  scanBufferInMemory(buf, collectInMemorySlotMarkers(), { excludeSlots });

// W2-G1 / W2-S1: Register trusted connector slots strictly bound to verified target descriptors in host memory!
let configuredImapEndpoint: ImapEndpointConfig | null = null;
if (connectorsCfg?.imap) {
  const ic = connectorsCfg.imap;
  const slotId = ic.credentialSlotId ?? "slot:imap-readonly";
  const secretEnvVar = ic.secretEnvVar ?? "AEGISPI_IMAP_SECRET";
  const imapSecret = process.env[secretEnvVar];
  if (imapSecret && imapSecret.length > 0) {
    vault.registerConnectorSlot({
      slotId,
      kind: "imap",
      target: `${ic.host}:${ic.port}/${ic.mailbox}`,
      secretValue: imapSecret,
      imapBinding: {
        host: ic.host,
        port: ic.port,
        servername: ic.servername,
        username: ic.username,
        allowedMailboxes: ic.allowedMailboxes ?? [ic.mailbox],
        ...(ic.proxy ? { proxyHost: ic.proxy.host, proxyPort: ic.proxy.port } : {}),
      },
    });
    configuredImapEndpoint = {
      mode: ic.mode,
      host: ic.host,
      port: ic.port,
      servername: ic.servername,
      ...(ic.caCertPath && existsSync(ic.caCertPath) ? { caPem: readFileSync(ic.caCertPath, "utf8") } : {}),
      ...(ic.proxy ? { proxy: ic.proxy } : {}),
      username: ic.username,
      credentialSlotId: slotId,
      mailbox: ic.mailbox,
      ...(s6ObserveDir
        ? {
            onObserveChildEnv: (info) => {
              // W2-S6: Scan raw env entries strictly IN MEMORY; NEVER write raw env values to disk!
              const entries = info.entries ?? [];
              const scan = scanBufferStrictlyInMemory(Buffer.from(JSON.stringify(entries), "utf8"));
              const outFile = path.join(
                s6ObserveDir,
                `imap-child-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`,
              );
              writeFileSync(
                outFile,
                JSON.stringify(
                  {
                    observedInMemoryOnly: true,
                    rawValuesWrittenToDisk: false,
                    envKeys: info.keys,
                    envEntriesCount: entries.length,
                    valueDigests: info.valueDigests,
                    scannedBytes: scan.scannedBytes,
                    passwordPresentInEnv: info.passwordPresentInEnv,
                    forbiddenHitsBySlot: scan.forbiddenHitsBySlot,
                    totalForbiddenHits: scan.totalForbiddenHits,
                    at: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
                "utf8",
              );
            },
          }
        : {}),
    };
  }
}

if (connectorsCfg?.githubMcp) {
  const mc = connectorsCfg.githubMcp;
  const slotId = mc.credentialSlotId ?? "slot:github-mcp-pat";
  const secretEnvVar = mc.secretEnvVar ?? "AEGISPI_GITHUB_MCP_PAT";
  const mcpPat = process.env[secretEnvVar];
  if (mcpPat && mcpPat.length > 0) {
    vault.registerConnectorSlot({
      slotId,
      kind: "github_mcp",
      target: mc.serverId,
      secretValue: mcpPat,
      githubMcpBinding: {
        serverId: mc.serverId,
        command: mc.command,
        args: mc.args,
        executablePath: mc.pinnedArtifactPath,
        executableSha256: mc.pinnedArtifactSha256,
        readOnlyRequired: true,
      },
    });
  }
}

// W2-S6: Publish cryptographic salted SHA-256 commitments (ZERO raw secrets) before MCP subprocess launch
// so fake/test MCP child can substring-scan its live `process.env` in RAM across all 5 slots!
if (s6ObserveDir) {
  const commitments = createSaltedMarkerCommitments(collectInMemorySlotMarkers());
  writeFileSync(path.join(s6ObserveDir, "mcp-commitments.json"), JSON.stringify(commitments, null, 2), "utf8");
}

// W2-S6: Immediately scrub startup secret environment variables from host process.env
// AFTER loading them into host memory / HostCredentialVault so no child process can inherit them!
const scrubbedSecretEnvVars = new Set<string>([
  "AEGISPI_CONSOLE_TOKEN",
  "AEGISPI_PRINCIPAL_TOKENS_JSON",
  "AEGISPI_MODEL_ROUTER_KEY",
  "AEGISPI_MODEL_WORKER_KEY",
  "AEGISPI_FAKE_MODEL_KEY",
  connectorsCfg?.imap?.secretEnvVar ?? "AEGISPI_IMAP_SECRET",
  connectorsCfg?.githubMcp?.secretEnvVar ?? "AEGISPI_GITHUB_MCP_PAT",
]);
for (const key of scrubbedSecretEnvVars) {
  delete process.env[key];
}

const priceSchedule = {
  priceVersion: "synthetic-v1",
  inputPerMTokMu: 300_000,
  outputPerMTokMu: 1_200_000,
  syntheticFixedUpperMu: syntheticUpperMu,
  syntheticFixedActualMu: syntheticActualMu,
};

const modelSlots: ModelSlotConfig[] = [
  {
    slotName: "router",
    provider: "fake-local",
    modelId: "fake-router-1",
    baseUrl: modelBaseUrl,
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
    baseUrl: modelBaseUrl,
    credentialSlotId: "slot:model-worker",
    contextWindow: 128_000,
    maxTokens: 1024,
    priceSchedule,
    outboundAuthorized: true,
  },
];

// W2-S1 / W2-S3: Host-managed workspace importer with isolated per-task frozen input snapshots & baselines
// (NEVER sharing one mutable path baseline table across concurrent tasks or trusting model baseSha256!)
let managedImporter: ManagedWorkspaceImporter | undefined;
let hostRef: AegisHostRuntime | null = null;
let mcpBridge: GitHubMcpBridge | null = null;
const taskSnapshotsRootDir = path.join(dataDir, "sandbox-task-snapshots");

if (connectorsCfg?.workspace) {
  const wc = connectorsCfg.workspace;
  managedImporter = new ManagedWorkspaceImporter(path.resolve(wc.workspaceDir));
  mkdirSync(taskSnapshotsRootDir, { recursive: true });
}

const host = await AegisHostRuntime.start({
  dataDir,
  vault,
  modelSlots,
  smtpConfig: {
    host: smtpHost,
    port: smtpPort,
    fromAddress: "aegis-synthetic@local.test",
    timeoutMs: smtpTimeoutMs,
  },
  defaultPrincipalId,
  defaultMemoryDomain: connectorsCfg?.defaultMemoryDomain ?? "default",
  defaultTaskLimitMu: taskLimitMu,
  defaultDayLimitMu: dayLimitMu,
  approvalTtlMs,
  pauseOutboxDelivery: pauseOutbox,
  managedWorkspaceImporter: managedImporter,
  // W2-S1: Bind hostRef AND connect pinned GitHub MCP bridge STRICTLY BEFORE harness.resume() releases scheduling!
  beforeResume: async (readyHost) => {
    hostRef = readyHost;
    // W2-S6: Record dynamic verification of scrubbed startup secret env vars on live process.env
    const remainingSecretVars = [...scrubbedSecretEnvVars]
      .sort()
      .filter((k) => Object.prototype.hasOwnProperty.call(process.env, k));
    writeAuditEvent(readyHost.govDb, {
      entityType: "host_runtime",
      entityId: readyHost.runtimeEpoch,
      eventKey: `startup_env_scrub:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      eventType: "host_startup_env_scrubbed",
      occurredAt: Date.now(),
      details: {
        pid: process.pid,
        scrubbedVarNames: [...scrubbedSecretEnvVars].sort(),
        remainingSecretVars,
        allScrubbed: remainingSecretVars.length === 0,
      },
    });
    if (connectorsCfg?.githubMcp) {
      const mc = connectorsCfg.githubMcp;
      const bridge = new GitHubMcpBridge({
        serverId: mc.serverId,
        command: mc.command,
        args: mc.args,
        pinnedArtifactPath: mc.pinnedArtifactPath,
        credentialSlotId: mc.credentialSlotId ?? "slot:github-mcp-pat",
        govDb: readyHost.govDb,
        vault,
      });
      const connRes = await bridge.connect();
      if (connRes.ok) {
        mcpBridge = bridge;
      } else {
        process.stderr.write(`GitHub MCP bridge not connected (${connRes.code}): ${connRes.reason ?? ""}\n`);
      }
    }
  },
  ...(configuredImapEndpoint ? { imapEndpoint: configuredImapEndpoint } : {}),
  ...(connectorsCfg?.githubMcp
    ? {
        githubMcpBridge: () => mcpBridge,
      }
    : {}),
  ...(managedImporter && connectorsCfg?.workspace
    ? {
        workspaceWriteHandler: async (wp) => {
          const wc = connectorsCfg!.workspace!;
          const importer = managedImporter!;
          const currentHost = hostRef!;
          const cap = importer.captureHostBaseline(wp.relPath);
          if (!cap.ok) {
            return { ok: false, code: cap.code, message: cap.reason };
          }
          const preAuth = checkSourceReadAuthorized(currentHost.govDb, {
            principalId: wp.principalId,
            scopeId: wp.scopeId,
            sourceType: "workspace_write",
            resourceId: "workspace",
            operation: "write",
            path: cap.normalizedRelPath,
          });
          if (!preAuth.ok) {
            return { ok: false, code: "workspace_write_denied", message: preAuth.reason };
          }
          // W2-S3: ALWAYS preserve existing terminal / reconciled / pending receipts BEFORE checking
          // execution root or frozen snapshot state, so retries NEVER downgrade INSTALLED -> PENDING_RECONCILE!
          const existingImport = importer.getExistingImportRecord(currentHost.govDb, wp.logicalKey);
          if (existingImport) {
            if (existingImport.state === "INSTALLED") {
              return {
                ok: true,
                code: "idempotent_already_installed",
                message: `Logical import ${wp.logicalKey} already installed`,
                importId: existingImport.import_id,
                state: "INSTALLED",
                targetRelPath: existingImport.target_rel_path,
                artifactSha256: existingImport.artifact_sha256 || undefined,
                installCount: existingImport.install_count,
              };
            }
            if (existingImport.state === "CONFLICT_SAVED") {
              return {
                ok: false,
                code: "version_conflict",
                message: existingImport.reason ?? "Conflict already preserved",
                importId: existingImport.import_id,
                state: "CONFLICT_SAVED",
                targetRelPath: existingImport.target_rel_path,
                conflictPath: existingImport.conflict_rel_path,
                installCount: existingImport.install_count,
              };
            }
            if (existingImport.state === "PENDING_RECONCILE") {
              return {
                ok: false,
                code: "pending_reconcile",
                message: existingImport.reason ?? "Import already pending reconciliation",
                importId: existingImport.import_id,
                state: "PENDING_RECONCILE",
                targetRelPath: existingImport.target_rel_path,
                installCount: existingImport.install_count,
              };
            }
            if (existingImport.state === "REJECTED") {
              return {
                ok: false,
                code: "rejected",
                message: existingImport.reason ?? "Import previously rejected",
                importId: existingImport.import_id,
                state: "REJECTED",
                targetRelPath: existingImport.target_rel_path,
                installCount: existingImport.install_count,
              };
            }
          }

          // W2-S3: Durable run-level frozen input snapshot & baseline persisted in governance SQLite,
          // failing closed into PENDING_RECONCILE if worker execution lineage or persisted snapshot cannot be verified.
          const pendOutcome = (
            pend: ReturnType<ManagedWorkspaceImporter["recordPendingReconcileImport"]>,
            defaultCode: string,
            defaultMessage: string,
          ) => {
            if (pend.state === "INSTALLED") {
              return {
                ok: true,
                code: "idempotent_already_installed",
                state: "INSTALLED",
                importId: pend.importId,
                targetRelPath: pend.targetRelPath,
                artifactSha256: pend.artifactSha256 ?? undefined,
                installCount: pend.installCount,
                message: `Logical import ${wp.logicalKey} already installed`,
              };
            }
            return {
              ok: false,
              code: pend.state === "CONFLICT_SAVED" ? "version_conflict" : defaultCode,
              state: pend.state,
              importId: pend.importId,
              targetRelPath: pend.targetRelPath,
              conflictPath: pend.conflictRelPath,
              installCount: pend.installCount,
              message: pend.reason ?? defaultMessage,
            };
          };

          if (wp.executionRootTaskId.startsWith("__MISSING_WORKER_EXECUTION_ROOT__:")) {
            const reason = `worker_execution_root_missing: cannot confirm execution root for worker conversation ${wp.conversationId}`;
            const pend = importer.recordPendingReconcileImport(currentHost.govDb, {
              runtimeEpoch: wp.runtimeEpoch,
              conversationId: wp.conversationId,
              principalId: wp.principalId,
              scopeId: wp.scopeId,
              logicalKey: wp.logicalKey,
              targetRelPath: cap.normalizedRelPath,
              baseSha256: cap.baseSha256,
              reason,
            });
            return pendOutcome(pend, "worker_execution_root_missing", reason);
          }
          const boundTask = currentHost.getConversationBudgetTaskId(wp.conversationId, wp.runtimeEpoch);
          const taskSnapKey = `${wp.runtimeEpoch}:${wp.executionRootTaskId}`;
          const frozenRes = importer.getOrCreateTaskFrozenSnapshot({
            snapshotKey: taskSnapKey,
            snapshotRootDir: taskSnapshotsRootDir,
            govDb: currentHost.govDb,
            runtimeEpoch: wp.runtimeEpoch,
            executionRootTaskId: wp.executionRootTaskId,
            principalId: wp.principalId,
            scopeId: wp.scopeId,
            candidateRelPaths: [...(wc.trackedBaselineRelPaths ?? []), cap.normalizedRelPath],
          });
          if (!frozenRes.ok) {
            const pend = importer.recordPendingReconcileImport(currentHost.govDb, {
              runtimeEpoch: wp.runtimeEpoch,
              conversationId: wp.conversationId,
              principalId: wp.principalId,
              scopeId: wp.scopeId,
              logicalKey: wp.logicalKey,
              targetRelPath: cap.normalizedRelPath,
              baseSha256: cap.baseSha256,
              reason: frozenRes.code,
            });
            return pendOutcome(pend, frozenRes.code, frozenRes.reason);
          }
          const frozenSnap = frozenRes.snapshot;
          if (frozenSnap.fromDurableDb && !frozenSnap.hasBaseline(cap.normalizedRelPath) && cap.baseSha256 !== null) {
            const reason = `Restored frozen snapshot ${frozenSnap.snapshotId} lacks frozen baseline for existing file '${cap.normalizedRelPath}'`;
            const pend = importer.recordPendingReconcileImport(currentHost.govDb, {
              runtimeEpoch: wp.runtimeEpoch,
              conversationId: wp.conversationId,
              principalId: wp.principalId,
              scopeId: wp.scopeId,
              logicalKey: wp.logicalKey,
              targetRelPath: cap.normalizedRelPath,
              baseSha256: cap.baseSha256,
              reason: "frozen_snapshot_baseline_missing",
            });
            return pendOutcome(pend, "frozen_snapshot_baseline_missing", reason);
          }
          const hostBaseSha256 = frozenSnap.getBaseline(cap.normalizedRelPath);
          let latestMountedRelPaths: string[] = [];
          let latestExcludedRelPaths: string[] = [];

          const sb = await runTaskInDockerSandboxAsync({
            approvedImageId: wc.approvedImageId,
            imageName: wc.imageName ?? DEFAULT_SANDBOX_IMAGE,
            // W2-S3: Re-verify ALL cached /input grants synchronously RIGHT BEFORE spawning `docker run`!
            prepareInputSnapshotDirSync: () => {
              const mountAuth = checkSourceReadAuthorized(currentHost.govDb, {
                principalId: wp.principalId,
                scopeId: wp.scopeId,
                sourceType: "workspace_write",
                resourceId: "workspace",
                operation: "write",
                path: cap.normalizedRelPath,
              });
              if (!mountAuth.ok) {
                return { ok: false, code: "workspace_write_denied", reason: mountAuth.reason };
              }
              const verifiedMount = importer.prepareVerifiedMountInputDir({
                snapshot: frozenSnap,
                mountRootDir: taskSnapshotsRootDir,
                govDb: currentHost.govDb,
                principalId: wp.principalId,
                scopeId: wp.scopeId,
              });
              latestMountedRelPaths = verifiedMount.mountedRelPaths;
              latestExcludedRelPaths = verifiedMount.excludedRelPaths;
              return {
                ok: true,
                inputSnapshotDir: verifiedMount.mountDir,
                cleanup: verifiedMount.cleanup,
              };
            },
            nodeScript: `
              const fs = require("node:fs");
              const path = require("node:path");
              const rel = ${JSON.stringify(cap.normalizedRelPath)};
              const full = path.join("/out", rel);
              fs.mkdirSync(path.dirname(full), { recursive: true });
              fs.writeFileSync(full, ${JSON.stringify(wp.content)}, "utf8");
            `,
            ...(s6ObserveDir
              ? {
                  onInspectObserved: (info) => {
                    // W2-S6: Scan raw container env & CLI env strictly IN MEMORY; NEVER write raw values to disk!
                    const containerScan = scanBufferStrictlyInMemory(
                      Buffer.from(JSON.stringify(info.rawEnvInContainer), "utf8"),
                    );
                    const cliScan = scanBufferStrictlyInMemory(
                      Buffer.from(JSON.stringify(info.cliEnvEntries), "utf8"),
                    );
                    const containerEnvValueDigests: Record<string, string> = {};
                    const envKeysInContainer: string[] = [];
                    for (const entry of info.rawEnvInContainer) {
                      const eqIdx = entry.indexOf("=");
                      const k = eqIdx >= 0 ? entry.slice(0, eqIdx) : entry;
                      const v = eqIdx >= 0 ? entry.slice(eqIdx + 1) : "";
                      if (k) {
                        envKeysInContainer.push(k);
                        containerEnvValueDigests[k] = createHash("sha256").update(v, "utf8").digest("hex").slice(0, 16);
                      }
                    }
                    const outFile = path.join(
                      s6ObserveDir,
                      `docker-sandbox-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`,
                    );
                    writeFileSync(
                      outFile,
                      JSON.stringify(
                        {
                          observedInMemoryOnly: true,
                          rawValuesWrittenToDisk: false,
                          containerId: info.containerId,
                          containerName: info.containerName,
                          volumeName: info.volumeName,
                          networkMode: info.networkMode,
                          mounts: info.mounts.map((m) => ({ destination: m.destination, rw: m.rw })),
                          envKeysInContainer,
                          rawEnvEntriesCount: info.rawEnvInContainer.length,
                          rawEnvScannedBytes: containerScan.scannedBytes,
                          containerEnvValueDigests,
                          containerEnvForbiddenHitsBySlot: containerScan.forbiddenHitsBySlot,
                          cliEnvKeys: info.cliEnvEntries.map(([k]) => k),
                          cliEnvEntriesCount: info.cliEnvEntries.length,
                          cliEnvScannedBytes: cliScan.scannedBytes,
                          cliEnvForbiddenHitsBySlot: cliScan.forbiddenHitsBySlot,
                          mountedRelPaths: latestMountedRelPaths,
                          excludedRelPaths: latestExcludedRelPaths,
                          totalForbiddenHits: containerScan.totalForbiddenHits + cliScan.totalForbiddenHits,
                          at: new Date().toISOString(),
                        },
                        null,
                        2,
                      ),
                      "utf8",
                    );
                  },
                }
              : {}),
          });
          if (!sb.ok) {
            if (sb.containerName) await stopAndRemoveContainerAsync(sb.containerName);
            if (sb.volumeName) await cleanupTaskVolumeAsync(sb.volumeName);
            return {
              ok: false,
              code: sb.code ?? "sandbox_execution_failed",
              message: sb.error ?? (sb.stderr || "Docker sandbox failed"),
              executorImageId: sb.executorImageId,
            };
          }

          try {
            // Collect related conversation IDs (e.g. parent + worker) for W2-S2 recursive source revocation checks
            const relatedIds = new Set<string>([wp.conversationId]);
            if (boundTask) {
              const rows = currentHost.govDb
                .prepare(
                  "SELECT DISTINCT conversation_id FROM budget_task_bindings WHERE runtime_epoch = ? AND owner_task_id = ?",
                )
                .all(wp.runtimeEpoch, boundTask) as Array<{ conversation_id: string }>;
              for (const r of rows) relatedIds.add(r.conversation_id);
            }

            const impRes = await importer.importFileFromTaskVolume({
              govDb: currentHost.govDb,
              runtimeEpoch: wp.runtimeEpoch,
              conversationId: wp.conversationId,
              relatedConversationIds: [...relatedIds],
              principalId: wp.principalId,
              scopeId: wp.scopeId,
              logicalKey: wp.logicalKey,
              volumeName: sb.volumeName,
              approvedImageId: wc.approvedImageId,
              containerId: sb.containerId,
              targetRelPath: cap.normalizedRelPath,
              baseSha256: hostBaseSha256,
              ...(s6ObserveDir
                ? {
                    onExportedFilesObserved: (expInfo) => {
                      // W2-S6: Scan pre-install exported volume bytes strictly IN MEMORY; NEVER write raw .bin bytes to disk!
                      const rawConcat = Buffer.concat(expInfo.files.map((f) => f.bytes));
                      const volScan = scanBufferStrictlyInMemory(rawConcat);
                      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
                      writeFileSync(
                        path.join(s6ObserveDir, `volume-export-${stamp}.json`),
                        JSON.stringify(
                          {
                            observedInMemoryOnly: true,
                            rawBytesWrittenToDisk: false,
                            volumeName: expInfo.volumeName,
                            exporterImageId: expInfo.exporterImageId,
                            readOnlyMountVerified: expInfo.readOnlyMountVerified,
                            exportedFilesCount: expInfo.files.length,
                            exportedTotalBytes: volScan.scannedBytes,
                            files: expInfo.files.map((f) => ({
                              relPath: f.relPath,
                              sha256: f.sha256,
                              sizeBytes: f.sizeBytes,
                            })),
                            forbiddenHitsBySlot: volScan.forbiddenHitsBySlot,
                            totalForbiddenHits: volScan.totalForbiddenHits,
                            at: new Date().toISOString(),
                          },
                          null,
                          2,
                        ),
                        "utf8",
                      );
                    },
                  }
                : {}),
              ...(faultAfterImportInstallBeforeReceiptFile
                ? {
                    onAfterAtomicInstallBeforeReceipt: (info) => {
                      writeFileSync(
                        faultAfterImportInstallBeforeReceiptFile,
                        JSON.stringify({
                          pid: process.pid,
                          window: "after_import_install_before_receipt",
                          logicalKey: wp.logicalKey,
                          conversationId: wp.conversationId,
                          targetRelPath: cap.normalizedRelPath,
                          ...info,
                          at: new Date().toISOString(),
                        }) + "\n",
                        "utf8",
                      );
                      const shared = new Int32Array(new SharedArrayBuffer(4));
                      Atomics.wait(shared, 0, 0, 60_000);
                    },
                  }
                : {}),
            });
            writeAuditEvent(currentHost.govDb, {
              entityType: "sandbox_run",
              entityId: sb.containerName || sb.volumeName,
              eventKey: `sandbox:${wp.logicalKey}:${impRes.importId}`,
              eventType: "docker_sandbox_observed",
              occurredAt: Date.now(),
              details: {
                containerId: sb.containerId,
                containerName: sb.containerName,
                volumeName: sb.volumeName,
                executorImageId: sb.executorImageId,
                exporterImageId: impRes.exporterImageId ?? null,
                networkMode: sb.networkMode,
                mounts: sb.mounts,
                envKeysInContainer: sb.envKeysInContainer,
                dockerCliEnvKeys: sb.dockerCliEnvKeys ?? [],
                inputAuthorizedFiles: latestMountedRelPaths,
                excludedInputFiles: latestExcludedRelPaths,
                targetRelPath: cap.normalizedRelPath,
                importState: impRes.state,
                importCode: impRes.code,
                artifactSha256: impRes.artifactSha256,
              },
            });
            return {
              ok: impRes.ok,
              code: impRes.code,
              message: impRes.message,
              importId: impRes.importId,
              state: impRes.state,
              targetRelPath: impRes.targetRelPath,
              artifactSha256: impRes.artifactSha256 ?? undefined,
              conflictPath: impRes.conflictRelPath,
              installCount: impRes.installCount,
              executorImageId: sb.executorImageId,
              exporterImageId: impRes.exporterImageId,
            };
          } finally {
            await stopAndRemoveContainerAsync(sb.containerName);
            await cleanupTaskVolumeAsync(sb.volumeName);
          }
        },
      }
    : {}),
  ...(faultAfterSignalBeforeAckFile
    ? {
        onAfterSignalBeforeAck: (info) => {
          writeFileSync(
            faultAfterSignalBeforeAckFile,
            JSON.stringify({ pid: process.pid, ...info, at: new Date().toISOString() }) + "\n",
            "utf8",
          );
          // Freeze synchronously right after SDK signal commit and before outbox ACK / event-loop continuation
          const shared = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(shared, 0, 0, 60_000);
        },
      }
    : {}),
  ...(faultAfterClaimBeforeSmtpFile
    ? {
        onAfterClaimBeforeTransport: (effectId) => {
          writeFileSync(
            faultAfterClaimBeforeSmtpFile,
            JSON.stringify({ pid: process.pid, effectId, at: new Date().toISOString() }) + "\n",
            "utf8",
          );
          const shared = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(shared, 0, 0, 60_000);
        },
      }
    : {}),
  ...(faultAfterChatGovRegisterFile
    ? {
        onAfterChatGovRegister: (cmd) => {
          writeFileSync(
            faultAfterChatGovRegisterFile,
            JSON.stringify({
              pid: process.pid,
              window: "after_chat_gov_register",
              commandId: cmd.command_id,
              piRequestId: cmd.pi_request_id,
              chatKey: cmd.chat_key,
              at: new Date().toISOString(),
            }) + "\n",
            "utf8",
          );
          const shared = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(shared, 0, 0, 60_000);
        },
      }
    : {}),
  ...(faultAfterPiAdmitBeforeGovReceiptFile
    ? {
        onAfterPiAdmitBeforeGovReceipt: (info) => {
          writeFileSync(
            faultAfterPiAdmitBeforeGovReceiptFile,
            JSON.stringify({
              pid: process.pid,
              window: "after_pi_admit_before_gov_receipt",
              ...info,
              at: new Date().toISOString(),
            }) + "\n",
            "utf8",
          );
          const shared = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(shared, 0, 0, 60_000);
        },
      }
    : {}),
  ...(faultAfterChatGovReceiptBeforeHttpFile
    ? {
        onAfterChatGovReceiptBeforeHttp: (info) => {
          writeFileSync(
            faultAfterChatGovReceiptBeforeHttpFile,
            JSON.stringify({
              pid: process.pid,
              window: "after_chat_gov_receipt_before_http",
              ...info,
              at: new Date().toISOString(),
            }) + "\n",
            "utf8",
          );
          const shared = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(shared, 0, 0, 60_000);
        },
      }
    : {}),
  ...(faultChatReconcileReadFailure
    ? {
        injectChatReconcileReadFailure: () => faultChatReconcileReadFailure,
      }
    : {}),
});

const web = await startWebServer({
  host,
  bindHost,
  port,
  consoleToken,
  consoleTokens,
  defaultPrincipalId,
  ...(faultBeforeT2CommitFile
    ? {
        injectBeforeT2Commit: () => {
          writeFileSync(
            faultBeforeT2CommitFile,
            JSON.stringify({ pid: process.pid, window: "before_t2_commit", at: new Date().toISOString() }) + "\n",
            "utf8",
          );
          // Synchronously stall inside SQLite BEGIN IMMEDIATE transaction until external Stop-Process -Force kills this PID
          const shared = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(shared, 0, 0, 60_000);
          throw new Error("fault_before_t2_commit_timeout");
        },
      }
    : {}),
});

const shutdown = async (): Promise<void> => {
  await web.close().catch(() => {});
  await mcpBridge?.close().catch(() => {});
  await host.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

process.stdout.write(
  JSON.stringify({
    ready: true,
    service: "aegispi-v2-host",
    pid: process.pid,
    dataDir,
    port: web.port,
    baseUrl: web.baseUrl,
    health: host.health,
    runtimeEpoch: host.runtimeEpoch,
    recoveredSubmittingToUnknown: host.startupReport.recoveredSubmittingToUnknown,
    reconciledQuarantinedEffects: host.startupReport.reconciledQuarantinedEffects,
    reconciledChatCommands: host.startupReport.reconciledChatCommands,
    reconciledFileImports: host.startupReport.reconciledFileImports,
    chargedBoundReservations: host.startupReport.chargedBoundReservations,
    pairedCheckOk: host.startupReport.pairedCheck.ok,
    connectorsConfigured: {
      imap: Boolean(configuredImapEndpoint),
      githubMcp: Boolean(mcpBridge),
      workspace: Boolean(managedImporter),
    },
  }) + "\n",
);
