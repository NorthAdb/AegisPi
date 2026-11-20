// Telegram pull-mode ingress adapter (02 section 1 CP1; 06 section 3.1).
//
// READ-ONLY BY CONSTRUCTION: this module exposes getMe and getUpdates and
// NOTHING that sends. The daemon never auto-wires it (the owner starts a
// real feed explicitly); without a token it refuses before any network call
// (fail closed). Pull-mode authentication is the bot-token HTTPS channel
// plus update_id as the platform event id — the dedup that receiveEvent
// already enforces.
//
// Webhook truth (re-review P1: the guard is implemented AND wired): the
// Telegram-specific part — constant-time comparison of the
// X-Telegram-Bot-Api-Secret-Token header against the configured secret —
// is createTelegramWebhookGuard below, and the console route
// POST /ingress/telegram/webhook calls it (apps/daemon/src/console/api.mjs).
// A PUBLIC deployment and the owner-authorized secret are still open items:
// until they exist, the endpoint answers fail-closed (503 without a
// configured secret, 403 on a missing or wrong header) and everything
// verified here is local-request evidence, never "verified against the
// real webhook source".
//
// The fetch transport is INJECTED: the host decides how HTTP leaves this
// machine (direct or its own proxy). No URL is ever assembled from model
// output — the endpoint is fixed here.

import { timingSafeEqual } from "node:crypto";

export class TelegramAdapterError extends Error {}
export class TelegramTokenMissing extends TelegramAdapterError {}
export class TelegramWebhookSecretMissing extends TelegramAdapterError {}

const API_BASE = "https://api.telegram.org";

// Telegram webhook guard (the platform's documented header check): the
// caller presents the X-Telegram-Bot-Api-Secret-Token header and it must
// equal the configured secret in CONSTANT TIME. Wired to the console's
// /ingress/telegram/webhook route (re-review P1: implemented AND called);
// a public deployment and the real secret remain owner-authorized work.
export function createTelegramWebhookGuard({ secret }) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new TelegramWebhookSecretMissing(
      "a webhook secret of at least 16 chars is required; without one the webhook guard refuses instead of guessing",
    );
  }
  const expected = Buffer.from(secret, "utf8");
  return {
    mode: "webhook-header-guard",
    verifyRequest(headers) {
      const presented = headers["x-telegram-bot-api-secret-token"];
      if (typeof presented !== "string" || presented.length === 0) {
        return { ok: false, reason: "no X-Telegram-Bot-Api-Secret-Token header; the webhook guard refuses" };
      }
      const got = Buffer.from(presented, "utf8");
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        return { ok: false, reason: "webhook secret token mismatch; refused" };
      }
      return { ok: true };
    },
  };
}

// Map a Telegram update to the durable-ingress shape (06 section 3.1).
// Shared by the pull adapter and the webhook route: the bot token (pull)
// or the webhook secret (push) authenticates the CHANNEL; from.id maps the
// PRINCIPAL and chat.id+type maps the scope — never nicknames or free-text.
export function mapTelegramUpdate(update) {
  const message = update.message ?? update.edited_message ?? update.channel_post ?? null;
  if (!message) {
    return { mappable: false, reason: `update ${update.update_id} carries no mappable message` };
  }
  const from = message.from ?? null;
  if (!from) {
    return { mappable: false, reason: `update ${update.update_id} has no sender identity` };
  }
  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
  return {
    mappable: true,
    event: {
      source: "telegram",
      sourceEventId: String(update.update_id),
      principal: { platform: "telegram", subject: String(from.id) },
      scope: isGroup
        ? { kind: "group", domainKey: `group:telegram:${message.chat.id}`, channel: "telegram", conversationId: String(message.chat.id) }
        : { kind: "owner_dm", domainKey: `dm:telegram:${message.chat.id}`, channel: "telegram", conversationId: String(message.chat.id) },
      threadKey: `tg:${message.chat.id}`,
      payload: JSON.stringify({
        update_id: update.update_id,
        chat_type: message.chat.type,
        text: message.text ?? null,
        date: message.date,
      }),
    },
  };
}

export function createTelegramPullAdapter({ token, fetchImpl, apiBase = API_BASE }) {
  if (typeof token !== "string" || token.length === 0) {
    throw new TelegramTokenMissing("no Telegram bot token configured; the pull adapter refuses instead of guessing");
  }
  if (typeof fetchImpl !== "function") {
    throw new TelegramAdapterError("a fetch transport must be injected; the adapter never invents one");
  }
  async function call(method, params = {}) {
    const url = new URL(`${apiBase}/bot${token}/${method}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetchImpl(url);
    let body = null;
    try {
      body = await res.json();
    } catch {}
    if (!body || body.ok !== true) {
      throw new TelegramAdapterError(
        `Telegram ${method} failed: HTTP ${res.status}${body && body.description ? ` (${String(body.description).slice(0, 80)})` : ""}`,
      );
    }
    return body.result;
  }
  return {
    mode: "pull-readonly",
    async getMe() {
      return call("getMe");
    },
    // No offset is ever confirmed here (a read, not a consume): updates stay
    // in the platform queue until an explicit, audited advance elsewhere.
    async getUpdates({ limit = 1, timeout = 0, allowedUpdates = undefined } = {}) {
      return call("getUpdates", { limit, timeout, allowed_updates: allowedUpdates });
    },
    // Map a Telegram update to the durable-ingress shape — the shared
    // mapping also serves the webhook route. The bot token authenticates
    // the CHANNEL; identities come from the update itself.
    mapUpdate(update) {
      return mapTelegramUpdate(update);
    },
  };
}
