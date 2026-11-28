import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  readImapMessageReadOnly,
  type ImapEndpointConfig,
} from "./capabilities/mail/imap-client.ts";
import { testSmtpConnectivity } from "./capabilities/mail/smtp-client.ts";
import {
  cleanupTaskVolumeAsync,
  DEFAULT_SANDBOX_IMAGE,
  runTaskInDockerSandboxAsync,
  stopAndRemoveContainerAsync,
} from "./capabilities/workspace/docker-sandbox.ts";
import { ManagedWorkspaceImporter } from "./capabilities/workspace/importer.ts";
import {
  assertModelUrlForStage,
  assertSmtpHostForStage,
  getVerifiedModelBoundContract,
  HostCredentialVault,
  isLoopbackHost,
  validateModelPriceScheduleForEndpoint,
  type ModelPriceSchedule,
  type StageEgressPolicy,
  type StageProfile,
} from "./governance/credentials.ts";
import { writeAuditEvent } from "./governance/db.ts";
import {
  createSaltedMarkerCommitments,
  scanBufferInMemory,
} from "./governance/leak-scanner.ts";
import { openOperatorSettings } from "./governance/operator-settings.ts";
import { pinMcpServerBinary, sha256File } from "./governance/mcp-pin.ts";
import { checkSourceReadAuthorized } from "./governance/policy.ts";
import { validateEmailRecipientsAllowlist, type GithubWriteAllowlistEntry } from "./governance/rules.ts";
import { AegisHostRuntime } from "./runtime/harness.ts";
import { GitHubMcpBridge } from "./runtime/mcp-bridge.ts";
import { listOperatorModelCatalog, resolveOperatorModel } from "./runtime/models.ts";
import type { ModelSlotConfig } from "./runtime/models.ts";
import { openOperatorConnections, synchronizeOperatorReadGrants } from "./runtime/operator-connections.ts";
import { operatorGithubArtifact } from "./runtime/operator-github.ts";
import type { SmtpEndpointConfig } from "./runtime/submitter.ts";
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
const stageRaw = args["stage"] ?? process.env["AEGISPI_STAGE"] ?? "1";
const stage: StageProfile = stageRaw === "2" ? 2 : 1;
const uiMode: "stage1" | "stage2" =
  args["ui-mode"] === "stage2" ? "stage2" : args["ui-mode"] === "stage1" ? "stage1" : stage === 2 ? "stage2" : "stage1";
const webDistDir = args["web-dist"] ?? process.env["AEGISPI_WEB_DIST"] ?? path.resolve("web/dist");
const mobileHttpsOrigin = args["mobile-https-origin"] ?? process.env["AEGISPI_MOBILE_HTTPS_ORIGIN"];
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
  /** S2-P0-2: Test-only explicit opt-in allowing loopback fake-local synthetic pricing in Stage 2. */
  allowSyntheticFakeModel?: boolean;
  skillsEnabled?: boolean;
  /** S2-P0-3d: L3 skill script execution MUST be explicitly enabled (never inferred solely from workspace config). */
  skills?: {
    allowScriptExecution?: boolean;
  };
  routinesEnabled?: boolean;
  routinePollIntervalMs?: number;
  strictPlainTextEmail?: boolean;
  modelProfile?: {
    provider: string;
    routerModelId: string;
    workerModelId: string;
    baseUrl: string;
    allowedRemoteHosts?: string[];
    apiKeyEnvVar?: string;
    contextWindow?: number;
    maxTokens?: number;
    priceSchedule?: ModelPriceSchedule;
  };
  smtp?: {
    host: string;
    port: number;
    fromAddress: string;
    tlsMode?: "none" | "direct_tls" | "starttls";
    servername?: string;
    caCertPath?: string;
    proxy?: { host: string; port: number };
    username?: string;
    credentialSlotId?: string;
    secretEnvVar?: string;
    useOperatorGmailCredential?: boolean;
    allowedRemoteHosts?: string[];
    /** S2-P0-1: Explicit approved recipient allowlist (mandatory with zero '*' for non-loopback real SMTP). */
    allowedRecipients?: string[];
  };
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
    readOnlyMode?: boolean;
    writeAllowlist?: GithubWriteAllowlistEntry[];
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

let trustedConfig: TrustedConnectorsConfig | null = null;
if (connectorsConfigPath) {
  try {
    trustedConfig = JSON.parse(readFileSync(path.resolve(connectorsConfigPath), "utf8")) as TrustedConnectorsConfig;
  } catch (err) {
    process.stderr.write(
      `Refusing startup: invalid connectors-config (${err instanceof Error ? err.message : String(err)})\n`,
    );
    process.exit(1);
  }
}

const startupSecrets = new Map<string, string>();
for (const key of [
  "AEGISPI_MODEL_ROUTER_KEY", "AEGISPI_MODEL_WORKER_KEY", "AEGISPI_FAKE_MODEL_KEY", "DEEPSEEK_API_KEY",
  "AEGISPI_SMTP_SECRET", "AEGISPI_IMAP_SECRET", "AEGISPI_GITHUB_MCP_PAT",
  trustedConfig?.modelProfile?.apiKeyEnvVar, trustedConfig?.smtp?.secretEnvVar,
  trustedConfig?.imap?.secretEnvVar, trustedConfig?.githubMcp?.secretEnvVar,
]) {
  if (key && process.env[key]) startupSecrets.set(key, process.env[key]!);
}

async function runHost(listenPort: number) {
const syntheticOptIn = args["allow-synthetic-fake-model"] === "true" ||
  process.env["AEGISPI_ALLOW_SYNTHETIC_FAKE_MODEL"] === "1" ||
  trustedConfig?.allowSyntheticFakeModel === true;
const fixtureGithub = syntheticOptIn ? trustedConfig?.githubMcp : undefined;
const githubArtifact = () => operatorGithubArtifact(dataDir);
const operatorConnections = stage === 2 ? openOperatorConnections(dataDir, async () => {
  if (!fixtureGithub) return githubArtifact().prepare();
  if (sha256File(fixtureGithub.pinnedArtifactPath) !== fixtureGithub.pinnedArtifactSha256.toLowerCase()) {
    throw new Error("github_executable_hash_mismatch");
  }
}) : undefined;
const { model: browserModel, gmail: browserGmail, github: browserGithub } = operatorConnections?.active ?? {};
function loadBrowserCredential(ref: string): string | undefined {
  try {
    return operatorConnections?.resolveSecret(ref);
  } catch {
    process.stderr.write("A saved operator credential could not be unlocked. Replace it in Settings.\n");
    return undefined;
  }
}
const browserModelProfile = browserModel && resolveOperatorModel(browserModel.provider, browserModel.modelId, browserModel.baseUrl);
if (browserModel && !browserModelProfile) throw new Error("invalid_saved_model_profile");
const connectorsCfg: TrustedConnectorsConfig | null = trustedConfig || browserModel || browserGmail || browserGithub ? {
  ...trustedConfig,
  ...(browserModelProfile ? { modelProfile: browserModelProfile } : {}),
  ...(browserGmail ? {
    imap: {
      ...(syntheticOptIn && trustedConfig?.imap && isLoopbackHost(trustedConfig.imap.host)
        ? trustedConfig.imap
        : {
            mode: trustedConfig?.imap?.proxy ? "connect_tunnel" as const : "direct" as const,
            host: "imap.gmail.com", port: 993, servername: "imap.gmail.com",
            proxy: trustedConfig?.imap?.proxy,
          }),
      username: browserGmail.email,
      mailbox: browserGmail.mailbox,
      allowedMailboxes: [browserGmail.mailbox],
    },
  } : {}),
  ...(browserGithub ? {
    githubMcp: {
      ...(fixtureGithub ? { ...fixtureGithub, serverId: "operator-github-fixture", readOnlyMode: true } : githubArtifact().identity),
      writeAllowlist: [],
    },
  } : {}),
} : null;
const stageTwoModelProfile = stage === 2 ? connectorsCfg?.modelProfile : undefined;
const modelProvider = stageTwoModelProfile ? stageTwoModelProfile.provider : "fake-local";
if (typeof modelProvider !== "string" || !modelProvider.trim()) {
  process.stderr.write("Refusing startup: stage2_model_provider_required\n");
  process.exit(1);
}
const fakeModelProvider = modelProvider.trim().toLowerCase() === "fake-local";
const configuredModelBaseUrl = stageTwoModelProfile?.baseUrl;
const explicitModelBaseUrl = typeof configuredModelBaseUrl === "string" ? configuredModelBaseUrl.trim() : "";
if (!fakeModelProvider && !explicitModelBaseUrl) {
  process.stderr.write("Refusing startup: stage2_real_model_base_url_required\n");
  process.exit(1);
}
const effectiveModelBaseUrl = explicitModelBaseUrl || modelBaseUrl;
const egressPolicy: StageEgressPolicy = {
  stage,
  allowedRemoteModelHosts: stageTwoModelProfile?.allowedRemoteHosts ?? [],
  allowedRemoteSmtpHosts: stage === 2 ? (connectorsCfg?.smtp?.allowedRemoteHosts ?? []) : [],
};
const effectiveSmtpHost = stage === 2 && connectorsCfg?.smtp?.host ? connectorsCfg.smtp.host : smtpHost;
const effectiveSmtpPort = stage === 2 && connectorsCfg?.smtp?.port ? connectorsCfg.smtp.port : smtpPort;
const effectiveSmtpTlsMode = stage === 2 ? (connectorsCfg?.smtp?.tlsMode ?? "none") : "none";

const cliAllowedEmailTargets = (args["allowed-email-targets"] ?? process.env["AEGISPI_ALLOWED_EMAIL_TARGETS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const configuredAllowedEmailRecipients: string[] | undefined =
  connectorsCfg?.smtp?.allowedRecipients && connectorsCfg.smtp.allowedRecipients.length > 0
    ? connectorsCfg.smtp.allowedRecipients
    : cliAllowedEmailTargets.length > 0
      ? cliAllowedEmailTargets
      : undefined;

// G2 & S2-P0-1: Hard egress + recipient allowlist boundary — refuse disallowed endpoints BEFORE opening DB or Web!
try {
  assertModelUrlForStage(effectiveModelBaseUrl, egressPolicy);
  assertSmtpHostForStage(effectiveSmtpHost, effectiveSmtpPort, egressPolicy, {
    tlsEnabled: effectiveSmtpTlsMode === "direct_tls" || effectiveSmtpTlsMode === "starttls",
  });
  const recipStartupCheck = validateEmailRecipientsAllowlist({
    to: [],
    allowedRecipients: configuredAllowedEmailRecipients,
    smtpHost: effectiveSmtpHost,
  });
  if (!recipStartupCheck.ok) {
    throw new Error(recipStartupCheck.reason);
  }
} catch (err) {
  process.stderr.write(`Refusing startup: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const allowSyntheticFakeModel = syntheticOptIn;
const setupOnly = stage === 2 && !stageTwoModelProfile && !allowSyntheticFakeModel &&
  !args["model-base-url"] && !process.env["AEGISPI_MODEL_BASE_URL"];
const modelIsLoopback = isLoopbackHost(new URL(effectiveModelBaseUrl).hostname);

// S2-P0-2: Stage 2 MUST NOT silently fall back to fake-local / synthetic pricing on loopback when modelProfile is missing!
// Synthetic fake-local pricing in Stage 2 requires explicit test-profile opt-in (`--allow-synthetic-fake-model` or config flag).
if (stage === 2 && !stageTwoModelProfile && !allowSyntheticFakeModel && !setupOnly) {
  process.stderr.write(
    "Refusing startup: stage2_model_profile_required (Stage 2 requires explicit modelProfile with verified billing contract; loopback fake-local pricing requires explicit --allow-synthetic-fake-model test flag)\n",
  );
  process.exit(1);
}

const configuredRouterModelId = setupOnly ? "" : stageTwoModelProfile?.routerModelId ?? "fake-router-1";
const configuredWorkerModelId = setupOnly ? "" : stageTwoModelProfile?.workerModelId ?? "fake-worker-1";

if (stage === 2 && fakeModelProvider && !allowSyntheticFakeModel && !setupOnly) {
  process.stderr.write(
    "Refusing startup: stage2_synthetic_fake_not_enabled (fake-local provider in Stage 2 requires explicit --allow-synthetic-fake-model test flag)\n",
  );
  process.exit(1);
}

// S2-P0-1: Stage 2 cannot disable strictPlainTextEmail (approved snapshot must match transmitted SMTP fields).
if (stage === 2 && connectorsCfg?.strictPlainTextEmail === false) {
  process.stderr.write(
    "Refusing startup: strictPlainTextEmail cannot be disabled in Stage 2 (approved snapshot must match transmitted SMTP fields)\n",
  );
  process.exit(1);
}

// S2-P0-2: Synthetic fixed price schedules are STRICTLY limited to explicit fake-local loopback tests
// (and in Stage 2 ONLY when allowSyntheticFakeModel is explicitly enabled)!
// Real providers require an official HTTPS endpoint and a provider/model-bound price schedule.
const isExplicitSyntheticFake =
  modelIsLoopback && fakeModelProvider && (stage === 1 || allowSyntheticFakeModel);
const effectivePriceSchedule: ModelPriceSchedule | null =
  stageTwoModelProfile?.priceSchedule
    ? stageTwoModelProfile.priceSchedule
    : isExplicitSyntheticFake
      ? {
          priceVersion: "synthetic-v1",
          provider: "fake-local",
          modelId: configuredRouterModelId,
          inputPerMTokMu: 300_000,
          outputPerMTokMu: 1_200_000,
          syntheticFixedUpperMu: syntheticUpperMu,
          syntheticFixedActualMu: syntheticActualMu,
        }
      : null;

const modelChoices = setupOnly ? [] : [...new Set([configuredRouterModelId, configuredWorkerModelId])];
for (const modelId of modelChoices) {
  const priceStartupCheck = validateModelPriceScheduleForEndpoint(
    effectiveModelBaseUrl,
    effectivePriceSchedule,
    { provider: modelProvider, modelId },
  );
  if (!priceStartupCheck.ok) {
    process.stderr.write(
      `Refusing startup: ${priceStartupCheck.code} (${priceStartupCheck.reason})\n`,
    );
    process.exit(1);
  }
}
const effectivePriceVersion = effectivePriceSchedule?.priceVersion ?? "none";
const defaultModelMaxTokens = connectorsCfg?.modelProfile?.maxTokens ?? 1024;
const outputLimit = setupOnly ? 128_000 : Math.min(...modelChoices.map((id) =>
  getVerifiedModelBoundContract(modelProvider, id)?.maxTokensHardCeiling ?? 128_000,
));
const trustedGithub = stage === 2 ? trustedConfig?.githubMcp : undefined;
const configuredGithubWrites = trustedGithub?.writeAllowlist ?? [];
const githubWritesAvailable = trustedGithub?.readOnlyMode === false && configuredGithubWrites.length > 0;
const dedicatedGithubWrite = browserGithub && githubWritesAvailable && trustedGithub?.serverId !== connectorsCfg?.githubMcp?.serverId
  ? trustedGithub : undefined;
const operatorSettings = stage === 2 ? openOperatorSettings(dataDir, {
  defaults: {
    routerModelId: configuredRouterModelId,
    workerModelId: configuredWorkerModelId,
    routerMaxTokens: defaultModelMaxTokens,
    workerMaxTokens: defaultModelMaxTokens,
    gmailMailbox: connectorsCfg?.imap?.mailbox ?? null,
    githubWritesEnabled: githubWritesAvailable,
  },
  modelChoices,
  outputLimits: { router: outputLimit, worker: outputLimit },
  gmailMailboxes: connectorsCfg?.imap ? (connectorsCfg.imap.allowedMailboxes ?? [connectorsCfg.imap.mailbox]) : [],
  githubWritesAvailable,
}) : undefined;
const activePreferences = operatorSettings?.get().active;
const routerModelId = activePreferences?.routerModelId ?? configuredRouterModelId;
const workerModelId = activePreferences?.workerModelId ?? configuredWorkerModelId;
const routerContract = getVerifiedModelBoundContract(modelProvider, routerModelId);
const workerContract = getVerifiedModelBoundContract(modelProvider, workerModelId);

const customModelApiKeyVar = stageTwoModelProfile?.apiKeyEnvVar;
const configuredModelKey = browserModel
  ? loadBrowserCredential(browserModel.credentialRef)
  : customModelApiKeyVar ? startupSecrets.get(customModelApiKeyVar) : undefined;
const routerConfiguredKey = browserModel ? configuredModelKey : configuredModelKey ?? startupSecrets.get("AEGISPI_MODEL_ROUTER_KEY");
const workerConfiguredKey = browserModel ? configuredModelKey : configuredModelKey ?? startupSecrets.get("AEGISPI_MODEL_WORKER_KEY") ?? routerConfiguredKey;
const routerModelCredentialConfigured = !setupOnly && Boolean(routerConfiguredKey);
const workerModelCredentialConfigured = !setupOnly && Boolean(workerConfiguredKey);
const routerSecret =
  routerConfiguredKey ?? (fakeModelProvider ? startupSecrets.get("AEGISPI_FAKE_MODEL_KEY") ?? "SYNTHETIC_HOST_MEMORY_MODEL_KEY_V2" : undefined);
const workerSecret =
  configuredModelKey ?? (browserModel ? undefined : startupSecrets.get("AEGISPI_MODEL_WORKER_KEY") ??
    (fakeModelProvider ? startupSecrets.get("AEGISPI_FAKE_MODEL_KEY") : undefined) ?? routerSecret);

const vault = new HostCredentialVault();
if (!setupOnly) {
  for (const [slotId, secret, modelIds] of [
    ["slot:model-router", routerSecret, operatorSettings ? modelChoices : [routerModelId]],
    ["slot:model-worker", workerSecret, operatorSettings ? modelChoices : [workerModelId]],
    ["slot:fake-local", routerSecret, [routerModelId, workerModelId]],
  ] as const) {
    if (!secret) continue;
    vault.registerSlot({
      slotId, provider: modelProvider, allowedBaseUrls: [effectiveModelBaseUrl],
      allowedModelIds: [...modelIds], priceVersion: effectivePriceVersion,
    }, secret, egressPolicy);
  }
}

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
const browserGmailSecret = browserGmail ? loadBrowserCredential(browserGmail.credentialRef) : undefined;
if (connectorsCfg?.imap) {
  const ic = connectorsCfg.imap;
  const mailbox = activePreferences?.gmailMailbox ?? ic.mailbox;
  const slotId = ic.credentialSlotId ?? "slot:imap-readonly";
  const secretEnvVar = ic.secretEnvVar ?? "AEGISPI_IMAP_SECRET";
  const imapSecret = browserGmail ? browserGmailSecret : startupSecrets.get(secretEnvVar);
  if (imapSecret && imapSecret.length > 0) {
    vault.registerConnectorSlot({
      slotId,
      kind: "imap",
      target: `${ic.host}:${ic.port}/${mailbox}`,
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
      mailbox,
      operatorConnectionId: browserGmail?.connectionId,
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

let githubCredentialConfigured = false;
function registerGithubCredential(
  mc: NonNullable<TrustedConnectorsConfig["githubMcp"]>,
  slotId: string,
  mcpPat: string | undefined,
): boolean {
  const allowWritePin = stage === 2 && mc.readOnlyMode === false;
  if (!mcpPat) return false;
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
      readOnlyRequired: !allowWritePin,
    },
  });
  return true;
}
if (connectorsCfg?.githubMcp) {
  const mc = connectorsCfg.githubMcp;
  const mcpPat = browserGithub ? loadBrowserCredential(browserGithub.credentialRef) :
    startupSecrets.get(mc.secretEnvVar ?? "AEGISPI_GITHUB_MCP_PAT");
  githubCredentialConfigured = registerGithubCredential(mc, mc.credentialSlotId ?? "slot:github-mcp-pat", mcpPat);
}
const githubWriteSlotId = "slot:github-mcp-authorized-write";
if (dedicatedGithubWrite && activePreferences?.githubWritesEnabled) {
  registerGithubCredential(
    dedicatedGithubWrite, githubWriteSlotId,
    startupSecrets.get(dedicatedGithubWrite.secretEnvVar ?? "AEGISPI_GITHUB_MCP_PAT"),
  );
}

const configuredSmtpConfig: SmtpEndpointConfig = {
  host: effectiveSmtpHost,
  port: effectiveSmtpPort,
  fromAddress: stage === 2 && connectorsCfg?.smtp?.fromAddress ? connectorsCfg.smtp.fromAddress : "aegis-synthetic@local.test",
  timeoutMs: smtpTimeoutMs,
  tlsMode: effectiveSmtpTlsMode,
  ...(stage === 2 && connectorsCfg?.smtp?.servername ? { servername: connectorsCfg.smtp.servername } : {}),
  ...(stage === 2 && connectorsCfg?.smtp?.caCertPath && existsSync(connectorsCfg.smtp.caCertPath)
    ? { caPem: readFileSync(connectorsCfg.smtp.caCertPath, "utf8") }
    : {}),
  ...(stage === 2 && connectorsCfg?.smtp?.proxy ? { proxy: connectorsCfg.smtp.proxy } : {}),
  ...(stage === 2 && connectorsCfg?.smtp?.username ? { username: connectorsCfg.smtp.username } : {}),
  credentialRequired: stage === 2 && connectorsCfg?.smtp?.useOperatorGmailCredential === true,
};

const sc = connectorsCfg?.smtp;
if (stage === 2 && sc && (sc.secretEnvVar || sc.useOperatorGmailCredential)) {
  const slotId = sc.credentialSlotId ?? "slot:smtp-auth";
  const gmailSmtpTarget = sc.host === "smtp.gmail.com" && (sc.servername ?? sc.host) === sc.host &&
    (sc.tlsMode === "direct_tls" && sc.port === 465 || sc.tlsMode === "starttls" && sc.port === 587);
  const matchesGmailAccount = Boolean(browserGmail && sc.username === browserGmail.email && sc.fromAddress === browserGmail.email);
  const smtpSecret = sc.useOperatorGmailCredential
    ? (gmailSmtpTarget && matchesGmailAccount ? browserGmailSecret : undefined)
    : sc.secretEnvVar ? startupSecrets.get(sc.secretEnvVar) : undefined;
  if (smtpSecret && smtpSecret.length > 0) {
    vault.registerConnectorSlot({
      slotId,
      kind: "smtp",
      target: `${sc.host}:${sc.port}`,
      secretValue: smtpSecret,
      smtpBinding: {
        host: sc.host,
        port: sc.port,
        servername: sc.servername,
        username: sc.username,
        fromAddress: sc.fromAddress,
        ...(sc.proxy ? { proxyHost: sc.proxy.host, proxyPort: sc.proxy.port } : {}),
      },
    });
    configuredSmtpConfig.credentialSlotId = slotId;
  }
}

// W2-S6: Publish cryptographic salted SHA-256 commitments (ZERO raw secrets) before MCP subprocess launch
// so fake/test MCP child can substring-scan its live `process.env` in RAM across all slots!
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
  "DEEPSEEK_API_KEY",
  "AEGISPI_SMTP_SECRET",
  ...(customModelApiKeyVar ? [customModelApiKeyVar] : []),
  ...(connectorsCfg?.smtp?.secretEnvVar ? [connectorsCfg.smtp.secretEnvVar] : []),
  connectorsCfg?.imap?.secretEnvVar ?? "AEGISPI_IMAP_SECRET",
  connectorsCfg?.githubMcp?.secretEnvVar ?? "AEGISPI_GITHUB_MCP_PAT",
  ...startupSecrets.keys(),
]);
for (const key of scrubbedSecretEnvVars) {
  delete process.env[key];
}

const modelSlots: ModelSlotConfig[] = setupOnly ? [] : [
  {
    slotName: "router",
    provider: modelProvider,
    modelId: routerModelId,
    baseUrl: effectiveModelBaseUrl,
    credentialSlotId: "slot:model-router",
    contextWindow:
      connectorsCfg?.modelProfile?.contextWindow ??
      routerContract?.publishedContextWindowTokens ??
      128_000,
    maxTokens: activePreferences?.routerMaxTokens ?? defaultModelMaxTokens,
    priceSchedule: effectivePriceSchedule,
    outboundAuthorized: fakeModelProvider || routerModelCredentialConfigured,
  },
  {
    slotName: "worker",
    provider: modelProvider,
    modelId: workerModelId,
    baseUrl: effectiveModelBaseUrl,
    credentialSlotId: "slot:model-worker",
    contextWindow:
      connectorsCfg?.modelProfile?.contextWindow ??
      workerContract?.publishedContextWindowTokens ??
      128_000,
    maxTokens: activePreferences?.workerMaxTokens ?? defaultModelMaxTokens,
    priceSchedule: effectivePriceSchedule,
    outboundAuthorized: fakeModelProvider || workerModelCredentialConfigured,
  },
];
if (operatorSettings) {
  // Saved conversations retain their model IDs. Keep verified alternatives available for the
  // same role so a setting changes new conversations without breaking existing checkpoints.
  for (const active of [...modelSlots]) {
    for (const modelId of modelChoices) {
      if (modelId !== active.modelId) modelSlots.push({ ...active, modelId });
    }
  }
}
if (browserModel && syntheticOptIn) {
  // A previously explicit test profile can finish its own saved checkpoints after switching the new-session default.
  const previous = trustedConfig?.modelProfile;
  const previousUrl = previous?.baseUrl ?? modelBaseUrl;
  if ((!previous || previous.provider === "fake-local") && isLoopbackHost(new URL(previousUrl).hostname)) {
    for (const [slotName, modelId, environmentKey] of [
      ["router", previous?.routerModelId ?? "fake-router-1", "AEGISPI_MODEL_ROUTER_KEY"],
      ["worker", previous?.workerModelId ?? "fake-worker-1", "AEGISPI_MODEL_WORKER_KEY"],
    ] as const) {
      const credentialSlotId = `slot:legacy-fake-${slotName}`;
      const priceSchedule = previous?.priceSchedule ?? {
        priceVersion: "synthetic-v1", provider: "fake-local",
        inputPerMTokMu: 300_000, outputPerMTokMu: 1_200_000,
        syntheticFixedUpperMu: syntheticUpperMu, syntheticFixedActualMu: syntheticActualMu,
      };
      if (!validateModelPriceScheduleForEndpoint(previousUrl, priceSchedule, { provider: "fake-local", modelId }).ok) continue;
      vault.registerSlot({
        slotId: credentialSlotId, provider: "fake-local", allowedBaseUrls: [previousUrl],
        allowedModelIds: [modelId], priceVersion: priceSchedule.priceVersion,
      }, (previous?.apiKeyEnvVar ? startupSecrets.get(previous.apiKeyEnvVar) : undefined) ??
        startupSecrets.get(environmentKey) ?? startupSecrets.get("AEGISPI_FAKE_MODEL_KEY") ??
        startupSecrets.get("AEGISPI_MODEL_ROUTER_KEY") ?? "SYNTHETIC_HOST_MEMORY_MODEL_KEY_V2", egressPolicy);
      modelSlots.push({
        slotName, provider: "fake-local", modelId, baseUrl: previousUrl, credentialSlotId,
        contextWindow: previous?.contextWindow ?? 128_000, maxTokens: previous?.maxTokens ?? defaultModelMaxTokens,
        priceSchedule, outboundAuthorized: true,
      });
    }
  }
}

// W2-S1 / W2-S3: Host-managed workspace importer with isolated per-task frozen input snapshots & baselines
// (NEVER sharing one mutable path baseline table across concurrent tasks or trusting model baseSha256!)
let managedImporter: ManagedWorkspaceImporter | undefined;
let hostRef: AegisHostRuntime | null = null;
let mcpBridge: GitHubMcpBridge | null = null;
let githubWriteBridge: GitHubMcpBridge | null = null;
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
  smtpConfig: configuredSmtpConfig,
  egressPolicy,
  strictPlainTextEmail: stage === 2,
  ...(configuredAllowedEmailRecipients ? { allowedEmailRecipients: configuredAllowedEmailRecipients } : {}),
  githubWriteAllowlist: activePreferences?.githubWritesEnabled ? configuredGithubWrites : [],
  skillsEnabled: stage === 2 ? (connectorsCfg?.skillsEnabled ?? true) : false,
  routinesEnabled: stage === 2 ? (connectorsCfg?.routinesEnabled ?? true) : false,
  routinePollIntervalMs: connectorsCfg?.routinePollIntervalMs ?? 30_000,
  // S2-P0-3d: L3 skill script execution requires explicit skills.allowScriptExecution=true AND live execute_script grant!
  ...(stage === 2 && connectorsCfg?.workspace && connectorsCfg?.skills?.allowScriptExecution === true
    ? {
        skillScriptRunner: async (sp) => {
          const currentHost = hostRef!;
          const execPerm = checkSourceReadAuthorized(currentHost.govDb, {
            principalId: sp.principalId,
            scopeId: sp.scopeId,
            sourceType: "skill",
            resourceId: `skill:${sp.skillId}`,
            operation: "execute_script",
            scriptId: sp.scriptId,
            scriptSha256: sp.scriptSha256,
          });
          if (!execPerm.ok) {
            return { ok: false, code: "skill_script_execution_denied", output: "", error: execPerm.reason };
          }
          const wc = connectorsCfg!.workspace!;
          const sb = await runTaskInDockerSandboxAsync({
            approvedImageId: wc.approvedImageId,
            imageName: wc.imageName ?? DEFAULT_SANDBOX_IMAGE,
            nodeScript: `process.env.AEGIS_SKILL_INPUT_JSON = ${JSON.stringify(sp.inputJson)};\n${sp.sourceCode}`,
          });
          try {
            if (!sb.ok) {
              return { ok: false, code: sb.code ?? "skill_sandbox_failed", output: sb.stdout, error: sb.error ?? sb.stderr };
            }
            return { ok: true, code: "ok", output: sb.stdout.trim() || "skill_script_ok" };
          } finally {
            if (sb.containerName) await stopAndRemoveContainerAsync(sb.containerName);
            if (sb.volumeName) await cleanupTaskVolumeAsync(sb.volumeName);
          }
        },
      }
    : {}),
  defaultPrincipalId,
  defaultMemoryDomain: connectorsCfg?.defaultMemoryDomain ?? "default",
  l0RequiresDisclosure: stage === 2,
  defaultTaskLimitMu: taskLimitMu,
  defaultDayLimitMu: dayLimitMu,
  approvalTtlMs,
  pauseOutboxDelivery: pauseOutbox,
  managedWorkspaceImporter: managedImporter,
  // W2-S1: Bind hostRef AND connect pinned GitHub MCP bridge STRICTLY BEFORE harness.resume() releases scheduling!
  beforeResume: async (readyHost) => {
    hostRef = readyHost;
    if (operatorConnections) synchronizeOperatorReadGrants(readyHost.govDb, defaultPrincipalId, operatorConnections.active);
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
      if (browserGithub) pinMcpServerBinary(readyHost.govDb, {
        serverId: mc.serverId, executablePath: mc.pinnedArtifactPath, executableSha256: mc.pinnedArtifactSha256,
        command: mc.command, args: mc.args, readOnlyMode: true, approvedBy: defaultPrincipalId, now: Date.now(),
      });
      const bridge = new GitHubMcpBridge({
        serverId: mc.serverId,
        command: mc.command,
        args: mc.args,
        pinnedArtifactPath: mc.pinnedArtifactPath,
        credentialSlotId: mc.credentialSlotId ?? "slot:github-mcp-pat",
        stage,
        govDb: readyHost.govDb,
        vault,
        operatorConnectionId: browserGithub?.connectionId,
      });
      const connRes = await bridge.connect();
      if (connRes.ok || browserGithub) {
        mcpBridge = bridge;
      }
      if (!connRes.ok) {
        process.stderr.write(`GitHub MCP bridge not connected (${connRes.code}): ${connRes.reason ?? ""}\n`);
      }
    }
    if (dedicatedGithubWrite && activePreferences?.githubWritesEnabled) {
      const mc = dedicatedGithubWrite;
      const bridge = new GitHubMcpBridge({
        serverId: mc.serverId, command: mc.command, args: mc.args,
        pinnedArtifactPath: mc.pinnedArtifactPath, credentialSlotId: githubWriteSlotId,
        stage, govDb: readyHost.govDb, vault,
      });
      const result = await bridge.connect();
      if (result.ok) githubWriteBridge = bridge;
      else process.stderr.write(`Authorized GitHub write bridge not connected (${result.code}).\n`);
    }
  },
  ...(configuredImapEndpoint ? { imapEndpoint: configuredImapEndpoint } : {}),
  ...(connectorsCfg?.githubMcp
    ? {
        githubMcpBridge: () => mcpBridge,
      }
    : {}),
  ...(browserGithub ? { githubWriteMcpBridge: () => githubWriteBridge } : {}),
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
  port: listenPort,
  uiMode,
  webDistDir,
  ...(mobileHttpsOrigin ? { mobileHttps: { enabled: true, publicOrigin: mobileHttpsOrigin } } : {}),
  consoleToken,
  consoleTokens,
  defaultPrincipalId,
  ...(operatorSettings ? {
    operatorSettings,
    operatorCredentialStatus: {
      router: routerModelCredentialConfigured,
      worker: workerModelCredentialConfigured,
      gmailImap: Boolean(configuredImapEndpoint),
      gmailSmtp: Boolean(configuredSmtpConfig.credentialSlotId),
      github: githubCredentialConfigured,
    },
  } : {}),
  ...(operatorConnections ? {
    operatorConnections,
    listOperatorModelCatalog,
    requestOperatorRestart: requestRestart,
    testOperatorGmailRead: async (principalId) => {
      if (!browserGmail || !configuredImapEndpoint) return { ok: false, code: "gmail_not_connected" };
      const result = await readImapMessageReadOnly({
        govDb: host.govDb, vault, endpoint: configuredImapEndpoint,
        principalId, scopeId: "scope:default", verifyReadOnly: true,
      });
      return { ok: result.ok, code: result.ok || result.code === "mailbox_empty" || result.code === "seen_changed"
        ? result.code : "gmail_read_failed", seenUnchanged: result.seenUnchanged };
    },
    testOperatorGithubRead: async (principalId) => {
      if (!mcpBridge || !browserGithub) return { ok: false, code: "github_not_connected" };
      const result = await mcpBridge.readRepositoryFile({
        principalId, scopeId: "scope:default", repoId: browserGithub.repoId,
        ref: browserGithub.ref, path: browserGithub.filePath,
      });
      return { ok: result.ok, code: result.code };
    },
  } : {}),
  ...(dedicatedGithubWrite ? { operatorWriteMcpServerId: dedicatedGithubWrite.serverId } : {}),
  testGmailConnectivity: async (principalId) => {
    const imapRes = configuredImapEndpoint
      ? await readImapMessageReadOnly({
          govDb: host.govDb,
          vault,
          endpoint: configuredImapEndpoint,
          principalId,
          scopeId: "scope:default",
          connectivityOnly: true,
        })
      : { ok: false, code: "imap_not_configured", tlsVerified: false, error: "IMAP not configured" };
    const smtpRes = await testSmtpConnectivity({
      host: configuredSmtpConfig.host,
      port: configuredSmtpConfig.port,
      egressPolicy,
      tlsMode: configuredSmtpConfig.tlsMode,
      servername: configuredSmtpConfig.servername,
      caPem: configuredSmtpConfig.caPem,
      proxy: configuredSmtpConfig.proxy,
    });
    return {
      imap: {
        ok: imapRes.ok,
        tlsVerified: imapRes.tlsVerified,
        message: imapRes.ok
          ? `IMAP 只读连通 (${configuredImapEndpoint?.mailbox})`
          : (imapRes.code ?? "imap_connectivity_failed"),
      },
      smtp: smtpRes,
    };
  },
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

let closeTask: Promise<void> | undefined;
const close = () => closeTask ??= (async () => {
  let pending = "web";
  const notice = setTimeout(() => process.stderr.write(`Waiting for host shutdown (${pending}).\n`), 5000);
  try {
    await web.close().catch(() => {});
    pending = "github_mcp";
    await Promise.allSettled([mcpBridge?.close(), githubWriteBridge?.close()]);
    pending = "runtime";
    await host.close();
  } finally {
    clearTimeout(notice);
  }
})();

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
return { close, port: web.port };
}

let closing = false;
let restarting = false;
let running = await runHost(port);

function requestRestart() {
  if (closing || restarting) return;
  restarting = true;
  setTimeout(() => {
    void (async () => {
      const listenPort = running.port;
      await running.close();
      if (closing) return;
      running = await runHost(listenPort);
      restarting = false;
    })().catch(() => {
      process.stderr.write("Could not apply operator settings.\n");
      process.exit(1);
    });
  }, 250);
}

const shutdown = async () => {
  if (closing) return;
  closing = true;
  try {
    await running.close();
    process.exit(0);
  } catch {
    process.stderr.write("Could not close the host cleanly.\n");
    process.exit(1);
  }
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
