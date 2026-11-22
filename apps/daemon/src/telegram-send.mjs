import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCredentialService } from "./credentials.mjs";
import { buildSafeChildEnv } from "./model-call.mjs";
import { objectRelPath, sha256Buffer } from "./objects.mjs";
import { isLoopbackEndpoint } from "./upstream-http.mjs";

export class TelegramSendError extends Error {}

const TELEGRAM_CHILD = join(dirname(fileURLToPath(import.meta.url)), "upstream-telegram-child.mjs");
const TELEGRAM_TARGET_RE = /^(?:(?:dm|group):)?telegram:(-?\d+)$/;
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;

function scrubSecretText(text, botToken = null) {
  let out = String(text ?? "");
  if (typeof botToken === "string" && botToken.length > 0) {
    out = out.split(botToken).join("[REDACTED_BOT_TOKEN]");
  }
  return out.replace(/\/bot[^/\s"']+/g, "/bot[REDACTED_BOT_TOKEN]");
}

export function parseTelegramTargetResource(targetResource) {
  if (typeof targetResource !== "string") return null;
  const m = TELEGRAM_TARGET_RE.exec(targetResource);
  return m ? m[1] : null;
}

export function isRecipientAllowed(allowedRecipients, targetResource) {
  return Array.isArray(allowedRecipients) && allowedRecipients.length > 0 && allowedRecipients.includes(targetResource);
}

export function assertValidTelegramApiBase(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || /\s/.test(rawUrl)) {
    throw new TelegramSendError(`telegram.apiBase must be null or a whitespace-free URL string, got ${JSON.stringify(rawUrl)}`);
  }
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new TelegramSendError(`telegram.apiBase is not a valid URL: ${JSON.stringify(rawUrl)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new TelegramSendError(`telegram.apiBase must use http: or https:, got ${u.protocol}`);
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "" && u.pathname !== "/")) {
    throw new TelegramSendError(`telegram.apiBase must be a pathless root URL, got ${JSON.stringify(rawUrl)}`);
  }
  return u.origin;
}

function validateNotificationText(text, { emptyError, tooLongError }) {
  if (text.trim().length === 0) {
    return { ok: false, error: emptyError };
  }
  if (text.length > TELEGRAM_MAX_TEXT_LENGTH) {
    return { ok: false, error: tooLongError(text.length) };
  }
  return { ok: true, text };
}

export function resolveVerifiedNotificationText({ stateDir, contentHash, extra = {} }) {
  if (typeof contentHash !== "string" || !/^[0-9a-f]{64}$/.test(contentHash)) {
    return { ok: false, error: "telegram refused: contentHash must be a 64-char sha256 hex digest" };
  }
  if (stateDir) {
    const objPath = join(stateDir, ...objectRelPath(contentHash).split("/"));
    if (existsSync(objPath)) {
      const buf = readFileSync(objPath);
      if (sha256Buffer(buf) !== contentHash) {
        return { ok: false, error: "telegram refused: stored notification payload hash mismatch" };
      }
      return validateNotificationText(buf.toString("utf8"), {
        emptyError: "telegram refused: stored notification payload is empty",
        tooLongError: (len) => `telegram refused: message length ${len} exceeds ${TELEGRAM_MAX_TEXT_LENGTH}`,
      });
    }
  }
  for (const field of ["text", "body", "message"]) {
    const candidate = extra?.[field];
    if (typeof candidate === "string") {
      if (sha256Buffer(Buffer.from(candidate, "utf8")) !== contentHash) {
        return { ok: false, error: `telegram refused: inline ${field} does not match contentHash` };
      }
      return validateNotificationText(candidate, {
        emptyError: "telegram refused: notification message text is empty",
        tooLongError: (len) => `telegram refused: message length ${len} exceeds ${TELEGRAM_MAX_TEXT_LENGTH}`,
      });
    }
  }
  return { ok: false, error: "telegram refused: no sha256-verified notification text found in stateDir or intent extra" };
}

export function parseTelegramProxyUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0 || /\s/.test(rawUrl.trim())) {
    throw new TelegramSendError(`telegram.proxyUrl must be null or a whitespace-free URL string, got ${JSON.stringify(rawUrl)}`);
  }
  const trimmed = rawUrl.trim();
  const normalizedInput = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  let u;
  try {
    u = new URL(normalizedInput);
  } catch {
    throw new TelegramSendError(`telegram.proxyUrl is not a valid URL: ${JSON.stringify(rawUrl)}`);
  }
  if (u.protocol !== "http:") {
    throw new TelegramSendError(`telegram.proxyUrl must use http: for HTTP CONNECT tunneling, got ${u.protocol}`);
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "" && u.pathname !== "/")) {
    throw new TelegramSendError(`telegram.proxyUrl must be a pathless root URL without credentials, got ${JSON.stringify(rawUrl)}`);
  }
  const port = Number(u.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !u.hostname) {
    throw new TelegramSendError(`telegram.proxyUrl has invalid host or port: ${JSON.stringify(rawUrl)}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return { url: u.origin, host, port };
}

function readWindowsLoopbackProxy() {
  if (process.platform !== "win32") return { ok: true, proxy: null };
  try {
    const reg = (value) =>
      spawnSync(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", value],
        { encoding: "utf8", timeout: 3000 },
      );
    const enable = reg("ProxyEnable");
    if (enable.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(enable.stdout ?? "")) {
      return { ok: true, proxy: null };
    }
    const server = reg("ProxyServer");
    const m = (server.stdout ?? "").match(/ProxyServer\s+REG_SZ\s+(.+)/);
    if (!m) return { ok: true, proxy: null };
    const raw = m[1].trim();
    if (!raw) return { ok: true, proxy: null };
    const parts = raw.split(";").map((s) => s.trim()).filter(Boolean);
    let selected = null;
    let fallbackHttp = null;
    for (const part of parts) {
      const kv = part.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
      if (kv) {
        const key = kv[1].toLowerCase();
        const val = kv[2].trim();
        if (key === "https") {
          selected = val;
          break;
        }
        if (key === "http" && !fallbackHttp) fallbackHttp = val;
      } else if (!selected && !fallbackHttp) {
        selected = part;
      }
    }
    const addr = selected ?? fallbackHttp ?? "";
    if (!addr) {
      return { ok: false, error: "telegram refused: Windows WinInet ProxyEnable=1 has no HTTP/HTTPS proxy entry; configure telegram.proxyUrl explicitly" };
    }
    const parsed = parseTelegramProxyUrl(addr);
    if (!isLoopbackEndpoint(parsed.url)) {
      return { ok: false, error: `telegram refused: Windows WinInet proxy ${parsed.host}:${parsed.port} is not loopback; configure telegram.proxyUrl explicitly` };
    }
    return { ok: true, proxy: { host: parsed.host, port: parsed.port } };
  } catch (e) {
    return { ok: false, error: `telegram refused: unreadable Windows WinInet proxy (${e.message})` };
  }
}

// Shared by the SEND and PULL paths: an explicit proxy wins, a loopback
// base never needs one, otherwise the env probes and (on Windows) the
// WinInet loopback registry probe decide — fail closed on unreadable
// configuration.
export function resolveTelegramProxy({ normalizedBase, allowRealSend, parsedExplicitProxy }) {
  if (parsedExplicitProxy) {
    return { ok: true, proxy: { host: parsedExplicitProxy.host, port: parsedExplicitProxy.port } };
  }
  if (isLoopbackEndpoint(normalizedBase) || allowRealSend !== true) {
    return { ok: true, proxy: null };
  }
  const envProxy = [
    process.env.AEGISPI_TG_PROXY,
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ].find((v) => typeof v === "string" && v.trim().length > 0) ?? "";
  if (envProxy.trim().length > 0) {
    try {
      const parsed = parseTelegramProxyUrl(envProxy.trim());
      return { ok: true, proxy: { host: parsed.host, port: parsed.port } };
    } catch (e) {
      return { ok: false, error: `telegram refused: invalid proxy configuration (${e.message})` };
    }
  }
  return readWindowsLoopbackProxy();
}

export function createTelegramSendTransport({
  db,
  stateDir,
  apiBase,
  allowRealSend = false,
  timeoutMs = 15000,
  allowedRecipients = [],
  proxyUrl = null,
}) {
  const normalizedBase = assertValidTelegramApiBase(apiBase);
  const parsedExplicitProxy = proxyUrl !== null && proxyUrl !== undefined ? parseTelegramProxyUrl(proxyUrl) : null;
  const recipientAllowlist = Array.isArray(allowedRecipients) ? [...allowedRecipients] : [];
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new TelegramSendError(`telegram.timeoutMs must be an integer 1000..120000, got ${JSON.stringify(timeoutMs)}`);
  }

  return {
    label: `telegram-send(${normalizedBase})`,
    apiBase: normalizedBase,
    allowRealSend: allowRealSend === true,
    canHandle(targetResource) {
      return parseTelegramTargetResource(targetResource) !== null;
    },
    submit({ operation: opRow, intent = null, mode = undefined }) {
      if (mode !== undefined) {
        return { status: "failed_local", error: "telegram refused: real telegram transport ignores fault-injection modes" };
      }
      let action = {};
      if (!intent) {
        try {
          action = JSON.parse(opRow?.action_json ?? "{}");
        } catch {
          return { status: "failed_local", error: "telegram refused: action_json is unparseable" };
        }
      }
      const targetResource = intent?.targetResource ?? action.target_resource ?? null;
      const contentHash = intent?.contentHash ?? action.content_hash ?? null;
      const extra = intent?.extra ?? action;
      const chatId = parseTelegramTargetResource(targetResource);
      if (!chatId) {
        return { status: "failed_local", error: `telegram refused: unsupported targetResource ${JSON.stringify(targetResource)}` };
      }
      if (!isRecipientAllowed(recipientAllowlist, targetResource)) {
        return {
          status: "failed_local",
          error: `telegram refused: target ${targetResource} is not in non-empty adapters.allowedRecipients`,
        };
      }
      if (!isLoopbackEndpoint(normalizedBase) && allowRealSend !== true) {
        return {
          status: "failed_local",
          error: "telegram refused: non-loopback telegram.apiBase requires telegram.allowRealSend=true",
        };
      }
      const cred = createCredentialService(db).resolve("im");
      const botToken = cred.ok && typeof cred.value === "string" ? cred.value.trim() : "";
      if (!botToken || /[\s/?#\\]/.test(botToken)) {
        return {
          status: "failed_local",
          error: "telegram refused: im credential slot is missing, malformed, or revoked (zero bytes sent)",
        };
      }
      const resolved = resolveVerifiedNotificationText({ stateDir, contentHash, extra });
      if (!resolved.ok) {
        return { status: "failed_local", error: resolved.error };
      }
      const proxyRes = resolveTelegramProxy({
        normalizedBase,
        allowRealSend: allowRealSend === true,
        parsedExplicitProxy,
      });
      if (!proxyRes.ok) {
        return { status: "failed_local", error: proxyRes.error };
      }

      const r = spawnSync(process.execPath, [TELEGRAM_CHILD], {
        input: JSON.stringify({
          apiBase: normalizedBase,
          botToken,
          chatId,
          text: resolved.text,
          timeoutMs,
          proxy: proxyRes.proxy,
        }),
        env: buildSafeChildEnv(),
        encoding: "utf8",
        timeout: timeoutMs + 5000,
        maxBuffer: 1024 * 1024,
      });

      if (
        r.error?.code === "ETIMEDOUT" ||
        r.error?.code === "ENOBUFS" ||
        r.signal === "SIGTERM" ||
        r.status === null
      ) {
        return {
          status: "unknown",
          error: scrubSecretText(
            `telegram child timed out or exceeded buffer (${r.error?.code ?? r.signal ?? r.status})`,
            botToken,
          ),
        };
      }
      if (r.error) {
        return {
          status: "failed_local",
          error: scrubSecretText(`telegram child spawn failed (${r.error.code ?? r.error.message})`, botToken),
        };
      }
      if (typeof r.stdout !== "string" || r.stdout.length === 0 || r.status !== 0) {
        return {
          status: "failed_local",
          error: scrubSecretText(`telegram child failed (exit ${r.status}): ${String(r.stderr ?? "")}`, botToken).slice(0, 200),
        };
      }
      let out;
      try {
        out = JSON.parse(r.stdout);
      } catch {
        return { status: "failed_local", error: "telegram child produced unparseable output" };
      }
      if (!out.ok) {
        return out.kind === "timeout"
          ? { status: "unknown", error: scrubSecretText(out.error ?? "telegram request timed out; message may have been delivered", botToken) }
          : { status: "failed_local", error: scrubSecretText(out.error ?? "telegram transport failed before send", botToken) };
      }
      const msgId = out.body?.result?.message_id;
      if (
        out.status >= 200 &&
        out.status < 300 &&
        out.body?.ok === true &&
        (typeof msgId === "number" || (typeof msgId === "string" && msgId.length > 0))
      ) {
        return {
          status: "succeeded",
          externalId: `tg:${chatId}:${msgId}`,
        };
      }
      const desc = typeof out.body?.description === "string" ? ` (${scrubSecretText(out.body.description, botToken).slice(0, 120)})` : "";
      return {
        status: "failed_remote",
        error: `telegram sendMessage failed: HTTP ${out.status}${desc}`,
      };
    },
    lookup() {
      return {
        found: false,
        strong: false,
        reason: "Telegram Bot API does not offer a strongly consistent lookup for sendMessage",
      };
    },
  };
}
