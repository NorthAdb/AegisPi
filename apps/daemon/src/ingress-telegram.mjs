// Telegram pull-mode ingress adapter (02 section 1 CP1; 06 section 3.1).
//
// READ-ONLY BY CONSTRUCTION: this module exposes getMe and getUpdates and
// NOTHING that sends. The daemon never auto-wires it (the owner starts a
// real feed explicitly); without a token it refuses before any network call
// (fail closed). Pull-mode authentication is the bot-token HTTPS channel
// plus update_id as the platform event id — the dedup that receiveEvent
// already enforces.
//
// Webhook truth (audit F7 fixed the conflated comment): ingress-verify.mjs
// is a GENERIC HMAC-SHA256 signed-envelope verifier, not the Telegram
// webhook header check. The Telegram-specific part — constant-time
// comparison of the X-Telegram-Bot-Api-Secret-Token header against the
// configured webhook secret — is createTelegramWebhookGuard below. It is
// implemented but NOT wired to any public endpoint: a real webhook source
// needs a public endpoint and an owner-authorized secret, which is the
// recorded open item; until then nothing calls it.
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
// equal the configured secret in CONSTANT TIME. Implemented, not wired: no
// public endpoint exists in this phase, so nothing here is "verified
// against the real webhook source" — that stays an open item on record.
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
    // Map a Telegram update to the durable-ingress shape (06 section 3.1).
    // The bot token authenticates the CHANNEL; from.id maps the PRINCIPAL and
    // chat.id+type maps the scope — never nicknames or free-text.
    mapUpdate(update) {
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
    },
  };
}
