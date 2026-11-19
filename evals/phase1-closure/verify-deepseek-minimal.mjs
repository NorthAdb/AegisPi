// Phase 1 closure — DeepSeek Flash High minimal real inference contract.
//
// Runs EXACTLY ONE real inference through the locked Pi 1.5.2 SDK binding
// (provider "deepseek", model id "deepseek-flash", thinkingLevel "high")
// against the real api.deepseek.com catalog entry. Verifies the model ID and
// thinking level are accepted, and records the actual reply, usage, and
// whatever cost information is obtainable (catalog-priced cost object;
// DeepSeek's response carries no billing total).
//
// Credentials: DEEPSEEK_API_KEY is read from the repo-root .env IN THIS
// PROCESS ONLY and handed to Pi via setRuntimeApiKey (in-memory runtime
// credential; the isolated temp authPath is discarded). It is never printed,
// written to any report, or committed. Any accidental occurrence of the key
// in captured output is scrubbed before printing.
//
// Discipline (owner-baseline.local.md §4): ONE call. No retry, no model
// switch, no second attempt. On failure the script exits non-zero and stops.
//
// Exit 0 = contract verified (accepted, stopReason stop, usage recorded).
// Exit 1 = missing env var, or the single inference failed/was rejected.
// Exit 2 = wrong Node (must be locked v22.23.5).

import * as pi from "@earendil-works/pi-coding-agent";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

if (process.version !== "v22.23.5") {
  console.error(`Refusing to run: process.version=${process.version}, locked Node is v22.23.5`);
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Minimal .env reader (no dependency). Values never leave this process.
function readEnv(name) {
  try {
    const txt = readFileSync(join(repoRoot, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return undefined;
}

const apiKey = readEnv("DEEPSEEK_API_KEY");
if (!apiKey) {
  // Missing value: report the NAME only, never guess or print other values.
  console.error(JSON.stringify({ ok: false, missing: "DEEPSEEK_API_KEY" }));
  process.exit(1);
}
// Shape pre-flight (protects the single authorized attempt from being wasted
// on a parse artifact): DeepSeek keys are sk- prefixed token strings. Only a
// boolean verdict is printed — never the value itself.
if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
  console.error(JSON.stringify({ ok: false, malformed: "DEEPSEEK_API_KEY", detail: "value does not match the expected sk-… token shape (not attempted, no call made)" }));
  process.exit(1);
}

// Scrub the key from anything this script is about to print (defense in
// depth: the key should never appear in Pi's captured output either).
const scrub = (s) => (apiKey ? String(s).split(apiKey).join("***") : String(s));

const TMP_ROOT = join(tmpdir(), "aegispi-phase1-closure");
mkdirSync(TMP_ROOT, { recursive: true });
const agentDir = mkdtempSync(join(TMP_ROOT, "agent-"));
const wsDir = mkdtempSync(join(TMP_ROOT, "ws-"));

const startedAt = Date.now();
try {
  // No modelsPath override: the default bundled catalog is used, so the
  // deepseek provider points at the REAL https://api.deepseek.com base URL.
  const runtime = await pi.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    allowModelNetwork: false,
  });
  await runtime.setRuntimeApiKey("deepseek", apiKey);

  const model = runtime.getModel("deepseek", "deepseek-flash");
  const { session } = await pi.createAgentSession({
    agentDir,
    cwd: wsDir,
    model,
    thinkingLevel: "high",
    modelRuntime: runtime,
    resourceLoader: new pi.DefaultResourceLoader({ cwd: wsDir, agentDir, extensionFactories: [] }),
    sessionManager: pi.SessionManager.inMemory(wsDir),
    settingsManager: pi.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false }, // no automatic retry — single-shot contract
    }),
    tools: [],
  });

  const ends = [];
  const unsub = session.subscribe((e) => {
    if (e.type === "message_end") ends.push(e);
  });

  // The single minimal prompt. Everything after this is one attempt only.
  const PROMPT = "Reply with exactly the single word OK and nothing else.";
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout: no message_end within 180s")), 180_000),
  );
  await Promise.race([session.prompt(PROMPT), timeout]);

  unsub();
  const end = ends.at(-1);
  const msg = end?.message;
  const usage = msg?.usage;
  const stopReason = msg?.stopReason ?? null;
  const errorMessage = msg?.errorMessage ?? null;
  const reasoning = typeof msg?.reasoning === "string" && msg.reasoning.length > 0;

  const out = {
    ok: stopReason === "stop" && !!usage && typeof usage.input === "number",
    binding: { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" },
    accepted: stopReason === "stop",
    stopReason,
    errorMessage: errorMessage ? scrub(errorMessage) : null,
    replyText: msg?.content ? scrub(JSON.stringify(msg.content)).slice(0, 300) : null,
    reasoningReported: reasoning,
    usage: usage
      ? {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          totalTokens: usage.totalTokens,
          cost: usage.cost,
        }
      : null,
    durationMs: Date.now() - startedAt,
    nodeVersion: process.version,
    note: "cost is catalog-priced (pi-ai deepseek.json: input 0.3 / output 1.2 / cacheRead 0.006 USD per M tokens); DeepSeek responses carry no billing total — usage numbers are the only obtainable cost basis",
  };

  console.log(scrub(JSON.stringify(out, null, 2)));
  session.dispose();
  process.exit(out.ok ? 0 : 1);
} catch (e) {
  console.error(
    scrub(
      JSON.stringify(
        { ok: false, binding: { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" }, error: String(e.message ?? e), durationMs: Date.now() - startedAt },
        null,
        2,
      ),
    ),
  );
  process.exit(1);
} finally {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
}
