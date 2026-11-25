import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertStage1LoopbackModelUrl,
  assertStage1LoopbackSmtpHost,
  HostCredentialVault,
} from "./governance/credentials.ts";
import { AegisHostRuntime } from "./runtime/harness.ts";
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
const pauseOutbox = args["pause-outbox"] === "true";

// Explicit test-only fault barriers for R5 real Windows Stop-Process -Force window verification
const faultBeforeT2CommitFile = args["fault-before-t2-commit"];
const faultAfterSignalBeforeAckFile = args["fault-after-signal-before-ack"];
const faultAfterClaimBeforeSmtpFile = args["fault-after-claim-before-smtp"];

const vault = new HostCredentialVault();
vault.registerSlot(
  {
    slotId: "slot:fake-local",
    provider: "fake-local",
    allowedBaseUrls: [modelBaseUrl],
    allowedModelIds: ["fake-router-1", "fake-worker-1"],
    priceVersion: "synthetic-v1",
  },
  process.env["AEGISPI_FAKE_MODEL_KEY"] ?? "SYNTHETIC_HOST_MEMORY_MODEL_KEY_V2",
);

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
    credentialSlotId: "slot:fake-local",
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
    credentialSlotId: "slot:fake-local",
    contextWindow: 128_000,
    maxTokens: 1024,
    priceSchedule,
    outboundAuthorized: true,
  },
];

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
  defaultTaskLimitMu: taskLimitMu,
  defaultDayLimitMu: dayLimitMu,
  pauseOutboxDelivery: pauseOutbox,
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
          // Freeze synchronously right after READY->SUBMITTING commit and before SMTP socket open
          const shared = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(shared, 0, 0, 60_000);
        },
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
    chargedBoundReservations: host.startupReport.chargedBoundReservations,
    pairedCheckOk: host.startupReport.pairedCheck.ok,
  }) + "\n",
);
