// Host-side single-shot model execution core (ADR-0001 §5 / §6).
//
// callModelOnce drives the locked @earendil-works/pi-ai@1.5.2 SDK inside a
// short-lived child process (so daemon ticks stay synchronous) against the
// HOST-configured SDK root baseUrl (never a model-assembled URL and never a
// pre-appended /chat/completions path). The caller owns the ledger and
// model_requests state machine: reserve before this runs, commit EXECUTING
// before spawning, and settle only when the usage block and per-category
// price catalog satisfy ADR §6.

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class ModelCallError extends Error {}

export const MAX_MODEL_MESSAGES_BYTES = 128 * 1024;
const ALLOWED_MESSAGE_KEYS = new Set(["role", "content"]);
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);
const PI_CHILD = join(dirname(fileURLToPath(import.meta.url)), "model-call-pi-child.mjs");
const CHILD_SAFE_ENV_KEYS = [
  "PATH",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

function buildSafeChildEnv() {
  const out = {};
  for (const key of CHILD_SAFE_ENV_KEYS) {
    if (typeof process.env[key] === "string") {
      out[key] = process.env[key];
    }
  }
  return out;
}

export function validateModelMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, code: "invalid_messages", reason: "messages must be a non-empty array" };
  }
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      return { ok: false, code: "invalid_messages", reason: `messages[${i}] must be an object` };
    }
    for (const k of Object.keys(m)) {
      if (!ALLOWED_MESSAGE_KEYS.has(k)) {
        return { ok: false, code: "unknown_field", reason: `unknown message field: ${k}` };
      }
    }
    if (!ALLOWED_ROLES.has(m.role)) {
      return { ok: false, code: "invalid_messages", reason: `messages[${i}].role invalid: ${JSON.stringify(m.role)}` };
    }
    if (typeof m.content !== "string" || m.content.length === 0) {
      return { ok: false, code: "invalid_messages", reason: `messages[${i}].content must be a non-empty string` };
    }
  }
  const msgBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  if (msgBytes > MAX_MODEL_MESSAGES_BYTES) {
    return {
      ok: false,
      code: "messages_too_large",
      reason: `messages exceed 128 KiB hard cap (${msgBytes} > ${MAX_MODEL_MESSAGES_BYTES})`,
    };
  }
  return { ok: true };
}

export function isLoopbackModelEndpoint(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname);
}

export function assertValidModelBaseUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ModelCallError(`the configured model baseUrl is not a URL: ${JSON.stringify(rawUrl)}`);
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
  return url;
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

function prepareModelCall({ baseUrl, model, messages, timeoutMs, bearer, maxTokens }) {
  const url = assertValidModelBaseUrl(baseUrl);
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ModelCallError("a model call needs at least one message");
  }
  const { provider, modelId } = parseModelWhitelistKey(model);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_000_000) {
    return {
      immediate: {
        ok: false,
        kind: "local",
        stopReason: "error",
        error: `invalid model callTimeoutMs: ${JSON.stringify(timeoutMs)}`,
        usage: null,
      },
    };
  }
  if (typeof bearer !== "string" || bearer.trim().length === 0) {
    return {
      immediate: {
        ok: false,
        kind: "local",
        stopReason: "error",
        error: "No API key: model credential slot is unwired or empty (fail closed before HTTP)",
        usage: null,
      },
    };
  }
  return {
    immediate: null,
    url,
    modelId,
    timeoutMs,
    payload: JSON.stringify({
      baseUrl: url.origin,
      provider,
      modelId,
      messages,
      timeoutMs,
      apiKey: bearer,
      maxTokens,
    }),
  };
}

function interpretChildResult({ stdout, stderr, status }, { url, modelId, timeoutMs }) {
  let parsed = null;
  try {
    parsed = JSON.parse(stdout ?? "");
  } catch {}
  if (!parsed) {
    return {
      ok: false,
      kind: "local",
      stopReason: "error",
      error: `model transport child failed (exit ${status ?? "killed"}): ${String(stderr ?? "").slice(0, 200)}`,
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

export function callModelOnce({
  baseUrl,
  model = "deepseek/deepseek-flash",
  messages,
  timeoutMs = 60000,
  bearer = null,
  maxTokens = undefined,
}) {
  const prep = prepareModelCall({ baseUrl, model, messages, timeoutMs, bearer, maxTokens });
  if (prep.immediate) return prep.immediate;
  const r = spawnSync(process.execPath, [PI_CHILD], {
    input: prep.payload,
    encoding: "utf8",
    timeout: prep.timeoutMs + 5000,
    maxBuffer: 8 * 1024 * 1024,
    env: buildSafeChildEnv(),
  });
  return interpretChildResult(r, prep);
}

export function callModelOnceAsync({
  baseUrl,
  model = "deepseek/deepseek-flash",
  messages,
  timeoutMs = 60000,
  bearer = null,
  maxTokens = undefined,
}) {
  const prep = prepareModelCall({ baseUrl, model, messages, timeoutMs, bearer, maxTokens });
  if (prep.immediate) return Promise.resolve(prep.immediate);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PI_CHILD], {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSafeChildEnv(),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, prep.timeoutMs + 5000);
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ ok: false, kind: "local", stopReason: "error", error: err.message, usage: null });
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(interpretChildResult({ stdout, stderr, status }, prep));
    });
    child.stdin.end(prep.payload, "utf8");
  });
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
