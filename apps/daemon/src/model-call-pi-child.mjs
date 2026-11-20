// Short-lived child process for the single-shot Pi 1.5.2 model call path
// (ADR-0001 §5): invokes getBuiltinModel + completeSimple with explicit
// reasoning:"high" and host-configured SDK root baseUrl. Reads JSON on stdin
// so large (up to 128 KiB) message envelopes and API keys stay out of argv.

import { readFileSync } from "node:fs";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { completeSimple } from "@earendil-works/pi-ai/compat";

function buildPiMessages(messages, model) {
  const now = Date.now();
  return messages.map((m) => {
    if (m.role === "system") {
      return { role: "system", content: m.content, timestamp: now };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: [{ type: "text", text: m.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: now,
      };
    }
    return { role: "user", content: m.content, timestamp: now };
  });
}

function extractUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const out = {
    inputTokens: rawUsage.input,
    outputTokens: rawUsage.output,
    cacheReadTokens: rawUsage.cacheRead,
    cacheWriteTokens: rawUsage.cacheWrite,
  };
  if (
    rawUsage.cost &&
    typeof rawUsage.cost === "object" &&
    Object.prototype.hasOwnProperty.call(rawUsage.cost, "totalFromProvider")
  ) {
    out.totalFromProvider = rawUsage.cost.totalFromProvider;
  }
  return out;
}

const rawInput = readFileSync(0, "utf8");
let req;
try {
  req = JSON.parse(rawInput);
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, kind: "local", error: `invalid child input: ${e.message}` }));
  process.exit(0);
}

const { baseUrl, provider, modelId, messages, timeoutMs, apiKey, maxTokens } = req;

let builtin;
try {
  builtin = getBuiltinModel(provider, modelId);
} catch (e) {
  process.stdout.write(
    JSON.stringify({ ok: false, kind: "local", error: `builtin model lookup failed: ${e.message}` }),
  );
  process.exit(0);
}
if (!builtin) {
  process.stdout.write(
    JSON.stringify({ ok: false, kind: "local", error: `unknown builtin model ${provider}/${modelId}` }),
  );
  process.exit(0);
}

const model = { ...builtin, baseUrl };
const piMessages = buildPiMessages(messages, model);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 60000);

try {
  const options = {
    reasoning: "high",
    env: {},
    maxRetries: 0,
    timeoutMs: Number(timeoutMs) || 60000,
    signal: controller.signal,
    ...(typeof apiKey === "string" && apiKey.length > 0 ? { apiKey } : {}),
    ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
  };
  const msg = await completeSimple(model, { messages: piMessages }, options);
  const usage = extractUsage(msg?.usage);
  if (msg?.stopReason === "error" || msg?.stopReason === "aborted") {
    const isTimeout = msg.stopReason === "aborted" || controller.signal.aborted;
    process.stdout.write(
      JSON.stringify({
        ok: false,
        kind: isTimeout ? "timeout" : "provider_error",
        stopReason: msg.stopReason,
        error: msg.errorMessage || `provider stopped with ${msg.stopReason}`,
        usage,
      }),
    );
    process.exit(0);
  }
  const reply = Array.isArray(msg?.content)
    ? msg.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("")
    : "";
  process.stdout.write(
    JSON.stringify({
      ok: true,
      stopReason: msg?.stopReason ?? "stop",
      reply,
      usage,
      model: model.id,
    }),
  );
} catch (e) {
  const isTimeout = e?.name === "AbortError" || controller.signal.aborted;
  process.stdout.write(
    JSON.stringify({
      ok: false,
      kind: isTimeout ? "timeout" : "local",
      stopReason: isTimeout ? "aborted" : "error",
      error: String(e?.message ?? e),
      usage: null,
    }),
  );
} finally {
  clearTimeout(timer);
}
