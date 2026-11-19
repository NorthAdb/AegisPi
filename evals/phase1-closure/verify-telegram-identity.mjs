// Phase 1 closure — Telegram Bot identity verification (read-only).
//
// Verifies the notification channel without sending any message:
//   1. getMe  — the bot's own identity (must be a bot, username @aegispibot
//      per owner-baseline.local.md §1).
//   2. getChat — fetch the owner's private chat by TELEGRAM_OWNER_USER_ID.
//      For private chats the Bot API only knows a chat after the user has
//      interacted with the bot, so a successful getChat confirms /start was
//      completed for the configured owner ID.
// NO sendMessage (per instruction: 暂不发送测试消息). Both calls are
// read-only GETs.
//
// Credentials: TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_USER_ID are read from the
// repo-root .env IN THIS PROCESS ONLY; never printed, written or committed.
// Any accidental occurrence of the token in captured output is scrubbed.
//
// Exit 0 = both verifications hold. Exit 1 = missing env var or API failure.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

const token = readEnv("TELEGRAM_BOT_TOKEN");
const ownerId = readEnv("TELEGRAM_OWNER_USER_ID");
const missing = [];
if (!token) missing.push("TELEGRAM_BOT_TOKEN");
if (!ownerId) missing.push("TELEGRAM_OWNER_USER_ID");
if (missing.length > 0) {
  // Missing values: report the NAMES only, never guess or print others.
  console.error(JSON.stringify({ ok: false, missing }));
  process.exit(1);
}

const scrub = (s) => scrubImpl(String(s));
function scrubImpl(s) {
  let out = s;
  for (const secret of [token, ownerId]) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}

const maskId = (id) => {
  const s = String(id);
  return s.length <= 4 ? "****" : `${"****".padStart(Math.min(4, s.length - 4), "*")}${s.slice(-4)}`;
};

const base = `https://api.telegram.org/bot${token}`;

let out = { ok: false, getMe: null, ownerChat: null, nodeVersion: process.version };
try {
  const meRes = await fetch(`${base}/getMe`);
  const me = await meRes.json();
  if (!me.ok) throw new Error(`getMe failed: ${JSON.stringify(me)}`);
  out.getMe = {
    ok: true,
    isBot: me.result.is_bot === true,
    username: me.result.username,
    idMasked: maskId(me.result.id),
    first_name: me.result.first_name,
  };

  const chatRes = await fetch(`${base}/getChat?chat_id=${encodeURIComponent(ownerId)}`);
  const chat = await chatRes.json();
  if (!chat.ok) {
    out.ownerChat = {
      ok: false,
      error: scrub(chat.description ?? "getChat failed"),
      note: "a private chat is only visible to the bot after the user starts it — this failure means /start is not recorded for the configured owner ID (or the bot was blocked)",
    };
  } else {
    out.ownerChat = {
      ok: true,
      chatType: chat.result.type,
      idMatchesOwner: String(chat.result.id) === String(ownerId),
      idMasked: maskId(chat.result.id),
      firstNamePresent: typeof chat.result.first_name === "string" && chat.result.first_name.length > 0,
      startConfirmed: chat.result.type === "private" && String(chat.result.id) === String(ownerId),
    };
  }

  out.ok = out.getMe.ok && out.getMe.isBot && (out.ownerChat.ok && out.ownerChat.startConfirmed);
  console.log(scrub(JSON.stringify(out, null, 2)));
  process.exit(out.ok ? 0 : 1);
} catch (e) {
  out.error = scrub(String(e.message ?? e));
  console.error(scrub(JSON.stringify(out, null, 2)));
  process.exit(1);
}
