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
// Connectivity: api.telegram.org may be unreachable directly from this
// network (DNS pollution + TCP block, recorded in evidence/07). The script
// routes through a proxy when one is configured, in priority order:
//   AEGISPI_TG_PROXY env override (e.g. http://127.0.0.1:7897)
//   > HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy env
//   > the Windows system (WinINET) proxy when ProxyEnable=1.
// The proxy path is a CONNECT tunnel implemented with node:net + node:tls
// (no new dependency). The bot token only ever transits the machine's own
// configured proxy process — the same path the machine's browser traffic
// takes. If the proxy is untrusted, do not configure it.
//
// Credentials: TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_USER_ID are read from the
// repo-root .env IN THIS PROCESS ONLY; never printed, written or committed.
// Any accidental occurrence of the token in captured output is scrubbed.
//
// Exit 0 = both verifications hold. Exit 1 = missing env var or API failure.

import { readFileSync } from "node:fs";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import { spawnSync } from "node:child_process";
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

const scrub = (s) => {
  let out = String(s);
  for (const secret of [token, ownerId]) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
};

const maskId = (id) => {
  const s = String(id);
  return s.length <= 4 ? "****" : `****${s.slice(-4)}`;
};

// ---- proxy detection ------------------------------------------------------
function parseProxy(s) {
  const withoutScheme = String(s).replace(/^https?:\/\//, "");
  const [host, port] = withoutScheme.split(":");
  const p = Number(port);
  return host && Number.isFinite(p) ? { host, port: p, label: `${host}:${p}` } : null;
}

function winInetProxy() {
  if (process.platform !== "win32") return null;
  try {
    const reg = (value) =>
      spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", value], { encoding: "utf8" });
    const enable = reg("ProxyEnable");
    if (enable.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(enable.stdout)) return null;
    const server = reg("ProxyServer");
    const m = (server.stdout ?? "").match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    return m ? parseProxy(m[1]) : null;
  } catch {
    return null;
  }
}

const proxy =
  parseProxy(
    process.env.AEGISPI_TG_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      "",
  ) || winInetProxy();

// ---- CONNECT tunnel agent (no new dependency) ------------------------------
// Extends https.Agent (protocol "https:") so https.request accepts it; the
// override of createConnection returns a TLS socket that reaches the origin
// through an HTTP CONNECT tunnel via the configured proxy.
class TunnelAgent extends HttpsAgent {
  constructor(proxyHost, proxyPort) {
    super({ keepAlive: false });
    this.proxyHost = proxyHost;
    this.proxyPort = proxyPort;
  }
  createConnection(options, callback) {
    const { host, port, servername } = options;
    const sock = netConnect(this.proxyPort, this.proxyHost);
    let settled = false;
    const done = (err, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        sock.destroy();
        callback(err);
      } else {
        callback(null, socket);
      }
    };
    const timer = setTimeout(() => done(new Error(`proxy CONNECT timeout (15s) via ${this.proxyHost}:${this.proxyPort}`)), 15_000);
    sock.once("connect", () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let head = "";
    const onData = (chunk) => {
      head += chunk.toString("latin1");
      const idx = head.indexOf("\r\n\r\n");
      if (idx === -1) {
        if (head.length > 8192) done(new Error("proxy CONNECT response header too large"));
        return;
      }
      sock.off("data", onData);
      const statusLine = head.slice(0, head.indexOf("\r\n"));
      if (!/\s200\s/.test(` ${statusLine} `)) {
        done(new Error(`proxy CONNECT refused: ${statusLine}`));
        return;
      }
      const rest = Buffer.from(head.slice(idx + 4), "latin1");
      if (rest.length > 0) sock.unshift(rest);
      const tls = tlsConnect({ socket: sock, servername: servername || host });
      tls.once("error", (e) => done(e));
      // Handshake completes asynchronously; hand the socket over now, the
      // request layer writes after 'secureConnect'.
      done(null, tls);
    };
    sock.on("data", onData);
    sock.once("error", (e) => done(e));
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const agent = proxy ? new TunnelAgent(proxy.host, proxy.port) : undefined;
    const req = httpsRequest(url, { method: "GET", agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`non-JSON response (status ${res.statusCode})`));
        }
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error("request timeout (30s)")));
    req.once("error", (e) => reject(e));
    req.end();
  });
}

// Read-only diagnostic: --diag-updates lists which chats the bot has seen
// (masked), whether each sent /start, and whether the chat id matches the
// configured owner ID. Message texts and raw ids are never printed. Calling
// getUpdates without an offset does not confirm/consume anything.
if (process.argv.includes("--diag-updates")) {
  try {
    const upd = await getJson(`https://api.telegram.org/bot${token}/getUpdates?limit=100&timeout=0`);
    if (!upd.ok) throw new Error(scrub(`getUpdates failed: ${JSON.stringify(upd)}`));
    const rows = (upd.result ?? []).map((u) => {
      const m = u.message ?? u.edited_message ?? u.channel_post;
      const chatId = m?.chat?.id;
      return {
        updateId: u.update_id,
        chatIdMasked: chatId === undefined ? null : maskId(chatId),
        chatType: m?.chat?.type ?? null,
        sentStart: typeof m?.text === "string" && m.text.trim().startsWith("/start"),
        matchesConfiguredOwner: chatId === undefined ? false : String(chatId) === String(ownerId),
      };
    });
    const seenChats = new Map();
    for (const r of rows) {
      if (r.chatIdMasked) {
        const k = r.chatIdMasked;
        if (!seenChats.has(k)) seenChats.set(k, { chats: 0, start: false, match: false, type: r.chatType });
        seenChats.get(k).chats++;
        if (r.sentStart) seenChats.get(k).start = true;
        if (r.matchesConfiguredOwner) seenChats.get(k).match = true;
      }
    }
    console.log(
      scrub(
        JSON.stringify(
          {
            ok: true,
            via: proxy ? `proxy ${proxy.label}` : "direct",
            updateCount: rows.length,
            chatsSeen: [...seenChats.entries()].map(([masked, v]) => ({
              chatIdMasked: masked,
              chatType: v.type,
              sentStart: v.start,
              matchesConfiguredOwner: v.match,
            })),
            note: "masked summary only; texts and raw ids are never printed",
          },
          null,
          2,
        ),
      ),
    );
    process.exit(0);
  } catch (e) {
    console.error(scrub(JSON.stringify({ ok: false, error: scrub(String(e.message ?? e)) }, null, 2)));
    process.exit(1);
  }
}

// ---- verification ----------------------------------------------------------
let out = {
  ok: false,
  via: proxy ? `proxy ${proxy.label}` : "direct",
  getMe: null,
  ownerChat: null,
  nodeVersion: process.version,
};
try {
  const me = await getJson(`https://api.telegram.org/bot${token}/getMe`);
  if (!me.ok) throw new Error(`getMe failed: ${JSON.stringify(me)}`);
  out.getMe = {
    ok: true,
    isBot: me.result.is_bot === true,
    username: me.result.username,
    idMasked: maskId(me.result.id),
    first_name: me.result.first_name,
  };

  const chat = await getJson(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(ownerId)}`);
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
