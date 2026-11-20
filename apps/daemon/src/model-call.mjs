// Host-side single-shot model execution core (ADR-0001 §5 / §6).
//
// callModelOnce drives the locked @earendil-works/pi-ai@1.5.2 SDK inside a
// short-lived child process (so daemon ticks stay synchronous) against the
// HOST-configured SDK root baseUrl (never a model-assembled URL and never a
// pre-appended /chat/completions path). The caller owns the ledger and
// model_requests state machine: reserve before this runs, commit EXECUTING
// before spawning, and settle only when the usage block and per-category
// price catalog satisfy ADR §6.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class ModelCallError extends Error {}

const PI_CHILD = join(dirname(fileURLToPath(import.meta.url)), "model-call-pi-child.mjs");

export function isLoopbackModelEndpoint(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
}

// Parse a whitelist modelId ("deepseek/deepseek-flash") into { provider, modelId }.
// The whitelist key never goes on the wire; pi-ai sends model.id ("deepseek-flash").
export function parseModelWhitelistKey(rawModelKey) {
  if (typeof rawModelKey !== "string" || rawModelKey.length === 0 || rawModelKey.length > 128) {
    throw new ModelCallError(`invalid model key: ${JSON.stringify(rawModelKey)}`);
  }
  const parts = rawModelKey.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ModelCallError(`model key must have <provider>/<modelId> form, got ${JSON.stringify(rawModelKey)}`);
  }
  return { provider: parts[0], modelId: parts[1] };
}

// Synchronous one-shot model call via locked pi-ai 1.5.2.
// baseUrl MUST be a pathless SDK root (e.g. "https://api.deepseek.com" or
// "http://127.0.0.1:<port>"); OpenAI SDK appends /chat/completions itself.
// bearer comes from the host credential service slot "model"; pi-ai checks for
// an apiKey/auth header before any HTTP byte, so an unwired slot fails closed
// before connecting.
export function callModelOnce({
  baseUrl,
  model = "deepseek/deepseek-flash",
  messages,
  timeoutMs = 60000,
  bearer = null,
  maxTokens = undefined,
}) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ModelCallError(`the configured model baseUrl is not a URL: ${JSON.stringify(baseUrl)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelCallError(`the configured model baseUrl must be http(s), got ${url.protocol}`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ModelCallError(
      `model baseUrl must be a pathless SDK root (got pathname ${JSON.stringify(url.pathname)}; do not append /chat/completions)`,
    );
  }
  if (url.search || url.hash) {
    throw new ModelCallError("model baseUrl must not carry query or hash fragments");
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ModelCallError("a model call needs at least one message");
  }
  const { provider, modelId } = parseModelWhitelistKey(model);
  const normalizedBaseUrl = url.origin;

  const payload = JSON.stringify({
    baseUrl: normalizedBaseUrl,
    provider,
    modelId,
    messages,
    timeoutMs,
    apiKey: bearer ?? null,
    maxTokens,
  });

  const r = spawnSync(process.execPath, [PI_CHILD], {
    input: payload,
    encoding: "utf8",
    timeout: timeoutMs + 5000,
    maxBuffer: 8 * 1024 * 1024,
  });

  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout ?? "");
  } catch {}
  if (!parsed) {
    return {
      ok: false,
      kind: "local",
      stopReason: "error",
      error: `model transport child failed (exit ${r.status ?? "killed"}): ${String(r.stderr ?? "").slice(0, 200)}`,
      usage: null,
    };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      kind: parsed.kind ?? "local",
      stopReason: parsed.stopReason ?? "error",
      error:
        parsed.kind === "timeout"
          ? `no response within ${timeoutMs}ms`
          : `model call failed (${parsed.kind ?? "error"}): ${parsed.error}`,
      usage: parsed.usage ?? null,
    };
  }
  return {
    ok: true,
    reply: typeof parsed.reply === "string" ? parsed.reply : "",
    usage: parsed.usage ?? null,
    endpoint: url.host,
    model: parsed.model ?? modelId,
    stopReason: parsed.stopReason ?? "stop",
  };
}

// Cost from the host's own 4-category price catalog (microUSD per 1M tokens),
// implementing ADR-0001 §6 rules for the locked pi-ai 1.5.2 openai-completions
// parser path:
//   1. usage must exist, carry boolean `totalFromProvider` (stream placeholder
//      omission path lacks this key), and have 4 non-negative integer token counts
//      whose sum is > 0 (all-zero usage cannot be distinguished from omission).
//   2. Per-category pricing: any category with tokens > 0 requires a non-negative
//      integer catalog rate; categories with 0 tokens tolerate null.
//   3. Host sums and rounds up (ceil) to integer microUSD itself; reasoning
//      tokens are already included in outputTokens and never billed separately.
export function microusdForUsage(usage, catalog, { stopReason = "stop" } = {}) {
  if (!usage || typeof usage !== "object") return null;
  if (stopReason === "error" || stopReason === "aborted") {
    // Only settle if a complete, valid usage block was parsed; callers normally
    // keep failed/aborted calls HELD without settling anyway.
  }
  if (
    !Object.prototype.hasOwnProperty.call(usage, "totalFromProvider") ||
    typeof usage.totalFromProvider !== "boolean"
  ) {
    return null;
  }
  const pairs = [
    ["inputTokens", "inputPerMTokMicrousd"],
    ["outputTokens", "outputPerMTokMicrousd"],
    ["cacheReadTokens", "cacheReadPerMTokMicrousd"],
    ["cacheWriteTokens", "cacheWritePerMTokMicrousd"],
  ];
  let tokenSum = 0;
  let scaledTotal = 0n;
  for (const [tokenKey, priceKey] of pairs) {
    const tokens = usage[tokenKey];
    if (!Number.isInteger(tokens) || tokens < 0) return null;
    tokenSum += tokens;
    if (tokens > 0) {
      const rate = catalog?.[priceKey];
      if (!Number.isInteger(rate) || rate < 0) return null;
      scaledTotal += BigInt(tokens) * BigInt(rate);
    }
  }
  if (tokenSum <= 0) return null;
  if (scaledTotal === 0n) return 0;
  return Number((scaledTotal + 999_999n) / 1_000_000n);
}
