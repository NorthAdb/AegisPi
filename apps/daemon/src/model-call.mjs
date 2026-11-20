// Real model call path (re-review P1: "the production tick must wire model
// calls to the budget ledger — reserve first, then call, then settle by
// real usage; unknown usage is never zero").
//
// callModelOnce carries the worker's inference request to the HOST-configured
// endpoint (never a model-assembled URL — 02 section 4) and returns the
// reply with normalized usage tokens. The CALLER owns the ledger discipline:
// reserve before this runs, settle only with a trusted usage and an
// authorized price catalog, otherwise keep the reservation HELD.
//
// The HTTP round trip runs in a short-lived child process (same pattern as
// the container executor's docker calls and the submitter transport) so the
// daemon tick stays synchronous. The response's usage is the provider's own
// token accounting — the closest thing to a bill the host can read directly;
// the authoritative cost still comes from the host's price catalog.
//
// A loopback endpoint is the local verification seam; a non-loopback
// endpoint is an owner-authorized real provider (checked by the caller).

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class ModelCallError extends Error {}

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "model-call-child.mjs");

export function isLoopbackModelEndpoint(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
}

// Synchronous one-shot model call. Bearer comes from the host credential
// service slot "model" resolved by the caller; null means no key wired
// (loopback verification services ignore auth; a real provider without a
// key fails on its own answer, never on a fabricated credential here).
export function callModelOnce({ endpoint, model, messages, timeoutMs = 60000, bearer = null }) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ModelCallError(`the configured model endpoint is not a URL: ${JSON.stringify(endpoint)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelCallError(`the configured model endpoint must be http(s), got ${url.protocol}`);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ModelCallError("a model call needs at least one message");
  }
  const body = JSON.stringify({ model, messages });
  const r = spawnSync(process.execPath, [CHILD, url.toString(), body, String(timeoutMs), bearer ?? ""], {
    encoding: "utf8",
    timeout: timeoutMs + 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout ?? "");
  } catch {}
  if (!parsed) {
    return {
      ok: false,
      error: `model transport child failed (exit ${r.status ?? "killed"}): ${String(r.stderr ?? "").slice(0, 160)}`,
    };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.kind === "timeout" ? `no response within ${timeoutMs}ms` : `model call failed before any byte: ${parsed.error}`,
    };
  }
  if (parsed.status < 200 || parsed.status >= 300) {
    return { ok: false, error: `model endpoint answered HTTP ${parsed.status}` };
  }
  const choice = parsed.body?.choices?.[0]?.message?.content;
  const usageRaw = parsed.body?.usage ?? null;
  const usage =
    usageRaw && Number.isInteger(usageRaw.prompt_tokens) && Number.isInteger(usageRaw.completion_tokens)
      ? { promptTokens: usageRaw.prompt_tokens, completionTokens: usageRaw.completion_tokens }
      : null;
  return {
    ok: true,
    reply: typeof choice === "string" ? choice : null,
    usage,
    endpoint: url.host,
    model,
  };
}

// Cost from the host's own price catalog (microusd per 1M tokens). An
// unauthorized catalog (null on either side) prices NOTHING: the caller
// keeps the reservation HELD rather than settling a guess. A response with
// no usage accounting at all prices nothing either.
export function microusdForUsage(usage, catalog) {
  if (!Number.isInteger(usage?.promptTokens) || !Number.isInteger(usage?.completionTokens)) return null;
  if (!Number.isInteger(catalog?.inputPerMTokMicrousd) || !Number.isInteger(catalog?.outputPerMTokMicrousd)) {
    return null;
  }
  return Math.ceil((usage.promptTokens * catalog.inputPerMTokMicrousd + usage.completionTokens * catalog.outputPerMTokMicrousd) / 1_000_000);
}
