import path from "node:path";
import { HostCredentialVault } from "./governance/credentials.ts";
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
const consoleToken =
  args["console-token"] ?? process.env["AEGISPI_CONSOLE_TOKEN"] ?? "SYNTHETIC_CONSOLE_LOGIN_TOKEN_V2";
const taskLimitMu = Number(args["task-limit-mu"] ?? "800000");
const dayLimitMu = Number(args["day-limit-mu"] ?? "5000000");
const syntheticUpperMu = args["synthetic-upper-mu"] ? Number(args["synthetic-upper-mu"]) : 100;
const syntheticActualMu = args["synthetic-actual-mu"] ? Number(args["synthetic-actual-mu"]) : 60;
const smtpTimeoutMs = args["smtp-timeout-ms"] ? Number(args["smtp-timeout-ms"]) : 60_000;

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
  defaultTaskLimitMu: taskLimitMu,
  defaultDayLimitMu: dayLimitMu,
});

const web = await startWebServer({
  host,
  bindHost,
  port,
  consoleToken,
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
    pairedCheckOk: host.startupReport.pairedCheck.ok,
  }) + "\n",
);
