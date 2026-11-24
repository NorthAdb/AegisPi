import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { splitMailCredential, isLoopbackMailHost } from "./mail-adapter.mjs";
import { parseTelegramProxyUrl, resolveTelegramProxy } from "./telegram-send.mjs";
import { isLoopbackEndpoint } from "./upstream-http.mjs";

const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const MAX_PROBE_RESPONSE_BYTES = 256 * 1024;

export function scrubSecrets(text, secretValues = []) {
  let clean = String(text ?? "");
  for (const val of secretValues) {
    if (typeof val === "string" && val.length > 0) {
      clean = clean.split(val).join("[REDACTED]");
    }
  }
  clean = clean.replace(/\/bot[^/\s"']+/g, "/bot[REDACTED]");
  clean = clean.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  return clean.slice(0, 300);
}

function resolveProxyForTest(config, env) {
  const apiBase = config.telegram.apiBase;
  const explicitRaw = config.telegram.proxyUrl ?? null;
  if (explicitRaw !== null && explicitRaw !== undefined) {
    const parsed = parseTelegramProxyUrl(String(explicitRaw));
    return { ok: true, proxy: { host: parsed.host, port: parsed.port } };
  }
  if (isLoopbackEndpoint(apiBase)) {
    return { ok: true, proxy: null };
  }
  const envProxy = [
    env.AEGISPI_REAL_TG_PROXY,
    env.AEGISPI_TG_PROXY,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
  ].find((v) => typeof v === "string" && v.trim().length > 0);
  if (envProxy) {
    try {
      const parsed = parseTelegramProxyUrl(envProxy.trim());
      return { ok: true, proxy: { host: parsed.host, port: parsed.port } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return resolveTelegramProxy({ normalizedBase: apiBase, allowRealSend: true, parsedExplicitProxy: null });
}

function getJsonViaConnectProxy({ endpoint, proxy, timeoutMs }) {
  const target = new URL(endpoint);
  const useTls = target.protocol === "https:";
  const targetHost = target.hostname.replace(/^\[|\]$/g, "");
  const connectHost = targetHost.includes(":") ? `[${targetHost}]` : targetHost;
  const targetPort = Number(target.port || (useTls ? 443 : 80));

  return new Promise((resolve) => {
    let settled = false;
    const rawSock = netConnect(proxy.port, proxy.host);
    let activeSocket = rawSock;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        activeSocket.destroy();
      } catch {}
      try {
        rawSock.destroy();
      } catch {}
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: "telegram proxy request timed out", timedOut: true });
    }, timeoutMs);

    const issueRequest = (transportSock) => {
      if (settled) return;
      const defaultPort = useTls ? 443 : 80;
      const hostHeader = targetPort === defaultPort ? connectHost : `${connectHost}:${targetPort}`;
      const requestFn = useTls ? httpsRequest : httpRequest;
      const req = requestFn(
        {
          createConnection: () => transportSock,
          hostname: targetHost,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers: { host: hostHeader, connection: "close" },
        },
        (res) => {
          const chunks = [];
          let totalBytes = 0;
          res.on("data", (c) => {
            totalBytes += c.length;
            if (totalBytes > MAX_PROBE_RESPONSE_BYTES) {
              finish({ ok: false, error: "response exceeded size cap" });
              return;
            }
            chunks.push(c);
          });
          res.on("error", (err) => finish({ ok: false, error: err?.message ?? String(err) }));
          res.on("end", () => {
            const textBody = Buffer.concat(chunks).toString("utf8");
            let parsed = null;
            try {
              parsed = JSON.parse(textBody);
            } catch {}
            finish({ ok: true, status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.once("error", (err) => finish({ ok: false, error: err?.message ?? String(err) }));
      req.end();
      transportSock.resume();
    };

    rawSock.once("error", (err) => finish({ ok: false, error: err?.message ?? String(err) }));
    rawSock.once("connect", () => {
      rawSock.write(`CONNECT ${connectHost}:${targetPort} HTTP/1.1\r\nHost: ${connectHost}:${targetPort}\r\n\r\n`);
    });

    let head = "";
    const onProxyHead = (chunk) => {
      head += chunk.toString("latin1");
      const idx = head.indexOf("\r\n\r\n");
      if (idx === -1) {
        if (head.length > 8192) finish({ ok: false, error: "proxy CONNECT header too large" });
        return;
      }
      rawSock.off("data", onProxyHead);
      const statusLine = head.slice(0, head.indexOf("\r\n")).trim();
      if (!/^HTTP\/1\.[01]\s+200(?:\s|$)/.test(statusLine)) {
        finish({ ok: false, error: `proxy CONNECT refused: ${statusLine}` });
        return;
      }
      const leftover = Buffer.from(head.slice(idx + 4), "latin1");
      if (leftover.length > 0) {
        rawSock.pause();
        rawSock.unshift(leftover);
      }
      if (!useTls) {
        issueRequest(rawSock);
        return;
      }
      const tlsOpts = isIP(targetHost) === 0
        ? { socket: rawSock, servername: targetHost }
        : { socket: rawSock, host: targetHost };
      const transportSock = tlsConnect(tlsOpts);
      activeSocket = transportSock;
      transportSock.once("error", (err) => finish({ ok: false, error: err?.message ?? String(err) }));
      transportSock.once("secureConnect", () => issueRequest(transportSock));
    };
    rawSock.on("data", onProxyHead);
  });
}

async function testModelConnectivity({ config, env, timeoutMs }) {
  const baseUrl = config.model?.baseUrl ?? null;
  if (!baseUrl) {
    return { ok: false, target: "model", error: "model_base_url_unset", message: "model.baseUrl is not configured" };
  }
  const apiKey = typeof env.DEEPSEEK_API_KEY === "string" ? env.DEEPSEEK_API_KEY.trim() : "";
  if (!apiKey) {
    return { ok: false, target: "model", error: "missing_api_key", message: "DEEPSEEK_API_KEY is not configured" };
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const text = await res.text().catch(() => "");
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    if (res.status >= 200 && res.status < 300) {
      return {
        ok: true,
        target: "model",
        status: res.status,
        latencyMs,
        modelCount: Array.isArray(parsed?.data) ? parsed.data.length : null,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        target: "model",
        error: "auth_failed",
        status: res.status,
        latencyMs,
        message: `Authentication failed (HTTP ${res.status})`,
      };
    }
    return {
      ok: false,
      target: "model",
      error: "http_error",
      status: res.status,
      latencyMs,
      message: scrubSecrets(parsed?.error?.message ?? `HTTP ${res.status}`, [apiKey]),
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const timedOut = controller.signal.aborted || err?.name === "AbortError";
    return {
      ok: false,
      target: "model",
      error: timedOut ? "timeout" : "network_error",
      latencyMs,
      message: scrubSecrets(err?.cause?.message ?? err?.message ?? String(err), [apiKey]),
    };
  } finally {
    clearTimeout(timer);
  }
}

function mapTelegramProbeResponse({ status, body, latencyMs, botToken }) {
  if (status >= 200 && status < 300 && body?.ok === true && body?.result) {
    return {
      ok: true,
      target: "telegram",
      status,
      latencyMs,
      botUsername: body.result.username ?? null,
      botId: body.result.id ?? null,
    };
  }
  const authFailed = status === 401 || status === 403;
  return {
    ok: false,
    target: "telegram",
    error: authFailed ? "auth_failed" : "telegram_error",
    status,
    latencyMs,
    message: scrubSecrets(body?.description ?? `HTTP ${status}`, [botToken]),
  };
}

async function testTelegramConnectivity({ config, env, timeoutMs }) {
  const apiBase = config.telegram?.apiBase ?? null;
  if (!apiBase) {
    return { ok: false, target: "telegram", error: "telegram_api_base_unset", message: "telegram.apiBase is not configured" };
  }
  const botToken = typeof env.TELEGRAM_BOT_TOKEN === "string" ? env.TELEGRAM_BOT_TOKEN.trim() : "";
  if (!botToken || /[\s/?#\\]/.test(botToken)) {
    return { ok: false, target: "telegram", error: "missing_bot_token", message: "TELEGRAM_BOT_TOKEN is missing or malformed" };
  }
  const proxyRes = resolveProxyForTest(config, env);
  if (!proxyRes.ok) {
    return { ok: false, target: "telegram", error: "proxy_error", message: scrubSecrets(proxyRes.error, [botToken]) };
  }
  const startedAt = Date.now();
  const endpoint = `${apiBase.replace(/\/+$/, "")}/bot${botToken}/getMe`;
  if (proxyRes.proxy) {
    const proxied = await getJsonViaConnectProxy({ endpoint, proxy: proxyRes.proxy, timeoutMs });
    const latencyMs = Date.now() - startedAt;
    if (!proxied.ok) {
      return {
        ok: false,
        target: "telegram",
        error: proxied.timedOut ? "timeout" : "network_error",
        latencyMs,
        message: scrubSecrets(proxied.error, [botToken]),
      };
    }
    return mapTelegramProbeResponse({ status: proxied.status, body: proxied.body, latencyMs, botToken });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, { method: "GET", redirect: "error", signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    let body = null;
    try {
      body = await res.json();
    } catch {}
    return mapTelegramProbeResponse({ status: res.status, body, latencyMs, botToken });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const timedOut = controller.signal.aborted || err?.name === "AbortError";
    return {
      ok: false,
      target: "telegram",
      error: timedOut ? "timeout" : "network_error",
      latencyMs,
      message: scrubSecrets(err?.cause?.message ?? err?.message ?? String(err), [botToken]),
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveMailCredentials(env) {
  const user = typeof env.MAIL_USER === "string" ? env.MAIL_USER.trim().toLowerCase() : "";
  const pass = typeof env.MAIL_APP_PASSWORD === "string" ? env.MAIL_APP_PASSWORD : "";
  if (user && pass) return { ok: true, user, password: pass };
  const rawCred = typeof env.AEGISPI_MAIL_CREDENTIAL === "string" ? env.AEGISPI_MAIL_CREDENTIAL.trim() : "";
  if (!rawCred) {
    return { ok: false, message: "MAIL_USER / MAIL_APP_PASSWORD (or AEGISPI_MAIL_CREDENTIAL) is not configured" };
  }
  try {
    const parsed = splitMailCredential(rawCred);
    return { ok: true, ...parsed };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function probeImapServer({ host, port, tls, user, password, folder, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    let stage = "greeting";
    const opts = {
      host,
      port,
      ...(tls ? { rejectUnauthorized: !isLoopbackMailHost(host), servername: host } : {}),
    };
    const sock = tls ? tlsConnect(opts) : netConnect({ host, port });

    const finish = (outcome, { graceful = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (graceful) sock.end();
        else sock.destroy();
      } catch {}
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: "timeout", message: `IMAP probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    sock.once("error", (err) => {
      finish({
        ok: false,
        error: "network_error",
        message: scrubSecrets(err?.message ?? String(err), [user, password]),
      });
    });

    sock.on("close", () => {
      if (!settled) {
        finish({ ok: false, error: "network_error", message: "IMAP connection closed unexpectedly" });
      }
    });

    const handleLine = (line) => {
      if (stage === "greeting") {
        if (/^\* (?:OK|PREAUTH)\b/i.test(line)) {
          stage = "login";
          const u = user.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const p = password.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          sock.write(`a1 LOGIN "${u}" "${p}"\r\n`);
        } else if (/^\* BYE\b/i.test(line)) {
          finish({ ok: false, error: "remote_refused", message: "IMAP server sent BYE on connect" });
        }
        return;
      }
      if (stage === "login" && line.startsWith("a1 ")) {
        if (/^a1 OK\b/i.test(line)) {
          stage = "select";
          const f = folder.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          sock.write(`a2 SELECT "${f}"\r\n`);
        } else {
          finish({ ok: false, error: "auth_failed", message: "IMAP LOGIN refused" });
        }
        return;
      }
      if (stage === "select" && line.startsWith("a2 ")) {
        if (/^a2 OK\b/i.test(line)) {
          try {
            sock.write("a3 LOGOUT\r\n");
          } catch {}
          finish({ ok: true }, { graceful: true });
        } else {
          finish({ ok: false, error: "mailbox_error", message: `IMAP SELECT ${folder} refused` });
        }
      }
    };

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_PROBE_RESPONSE_BYTES) {
        finish({ ok: false, error: "protocol_error", message: "IMAP response exceeded size cap" });
        return;
      }
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break;
        const line = buf.subarray(0, nl + 1).toString("utf8").replace(/\r?\n$/, "");
        buf = buf.subarray(nl + 1);
        handleLine(line);
        if (settled) break;
      }
    });
  });
}

async function testMailConnectivity({ config, env, timeoutMs }) {
  const imapHost = config.mail?.imapHost ?? null;
  if (!imapHost) {
    return { ok: false, target: "mail", error: "mail_imap_host_unset", message: "mail.imapHost is not configured" };
  }
  const cred = resolveMailCredentials(env);
  if (!cred.ok) {
    return { ok: false, target: "mail", error: "missing_mail_credential", message: cred.message };
  }
  if (/[\r\n\0]/.test(cred.user) || /[\r\n\0]/.test(cred.password)) {
    return { ok: false, target: "mail", error: "invalid_mail_credential", message: "mail credential contains control characters" };
  }
  const port = config.mail?.imapPort ?? 993;
  const tls = config.mail?.imapTls !== false;
  const folder = Array.isArray(config.mail?.allowedFolders) && config.mail.allowedFolders.length > 0
    ? config.mail.allowedFolders[0]
    : "INBOX";
  const startedAt = Date.now();
  const res = await probeImapServer({ host: imapHost, port, tls, user: cred.user, password: cred.password, folder, timeoutMs });
  const latencyMs = Date.now() - startedAt;
  if (!res.ok) {
    return { ok: false, target: "mail", error: res.error, host: imapHost, port, latencyMs, message: res.message };
  }
  return { ok: true, target: "mail", host: imapHost, port, folder, latencyMs };
}

export async function testConnectivity({ target, config, env = process.env, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS }) {
  if (target === "model") return testModelConnectivity({ config, env, timeoutMs });
  if (target === "telegram") return testTelegramConnectivity({ config, env, timeoutMs });
  if (target === "mail") return testMailConnectivity({ config, env, timeoutMs });
  return { ok: false, target: String(target ?? ""), error: "invalid_target", message: "target must be model, telegram, or mail" };
}
