import { readFileSync } from "node:fs";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";

const MAX_RESPONSE_BYTES = 256 * 1024;
const LOCAL_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_INVALID_URL",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
]);

function parseTelegramBodyOrFail(status, textBody) {
  let parsed = null;
  try {
    parsed = JSON.parse(textBody);
  } catch {}
  if (status >= 200 && status < 300 && parsed === null) {
    return { ok: false, kind: "timeout", error: "telegram returned unparseable 2xx response" };
  }
  return { ok: true, status, body: parsed };
}

function scrubToken(text, botToken) {
  let clean = String(text ?? "");
  if (typeof botToken === "string" && botToken.length > 0) {
    clean = clean.split(botToken).join("[REDACTED_BOT_TOKEN]");
  }
  return clean.replace(/\/bot[^/\s"']+/g, "/bot[REDACTED_BOT_TOKEN]");
}

function readInput() {
  const raw = readFileSync(0, "utf8");
  return JSON.parse(raw);
}

function isValidProxy(proxy) {
  if (proxy === null || proxy === undefined) return true;
  return (
    typeof proxy === "object" &&
    !Array.isArray(proxy) &&
    typeof proxy.host === "string" &&
    proxy.host.length > 0 &&
    !/\s/.test(proxy.host) &&
    Number.isInteger(proxy.port) &&
    proxy.port >= 1 &&
    proxy.port <= 65535
  );
}

function sendViaConnectProxy({ endpoint, proxy, chatId, text, timeoutMs }) {
  const target = new URL(endpoint);
  const useTls = target.protocol === "https:";
  const targetHost = target.hostname.replace(/^\[|\]$/g, "");
  const connectHost = targetHost.includes(":") ? `[${targetHost}]` : targetHost;
  const targetPort = Number(target.port || (useTls ? 443 : 80));
  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });

  return new Promise((resolve) => {
    let settled = false;
    let connectConfirmed = false;
    let tlsConfirmed = !useTls;
    let requestSent = false;
    const rawSock = netConnect(proxy.port, proxy.host);
    let activeSocket = rawSock;
    let singleUseAgent = null;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        singleUseAgent?.destroy();
      } catch {}
      try {
        activeSocket.destroy();
      } catch {}
      try {
        rawSock.destroy();
      } catch {}
      resolve(outcome);
    };

    const failFromError = (err) => {
      const code = err?.cause?.code ?? err?.code ?? null;
      const preHttp = !requestSent && (!connectConfirmed || !tlsConfirmed);
      const isLocal =
        preHttp ||
        (!requestSent && typeof code === "string" && LOCAL_NETWORK_CODES.has(code));
      const detail = code ? `${err?.message ?? err} (${code})` : String(err?.message ?? err);
      finish({ ok: false, kind: isLocal ? "local" : "timeout", error: detail });
    };

    const failPreHttpEof = (stage) => () => {
      if (!requestSent) {
        finish({ ok: false, kind: "local", error: `telegram proxy closed before ${stage}` });
      }
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        kind: requestSent ? "timeout" : "local",
        error: requestSent
          ? "telegram proxy request timed out"
          : connectConfirmed
            ? "telegram proxy TLS handshake timed out"
            : "telegram proxy CONNECT timed out",
      });
    }, timeoutMs);

    const issueHttpRequest = (transportSock) => {
      if (settled) return;
      const defaultPort = useTls ? 443 : 80;
      const hostHeader = targetPort === defaultPort ? connectHost : `${connectHost}:${targetPort}`;
      singleUseAgent = useTls
        ? new HttpsAgent({ keepAlive: false, maxSockets: 1 })
        : new HttpAgent({ keepAlive: false, maxSockets: 1 });
      singleUseAgent.createConnection = () => transportSock;
      const requestFn = useTls ? httpsRequest : httpRequest;
      const req = requestFn(
        {
          agent: singleUseAgent,
          hostname: targetHost,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: {
            host: hostHeader,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload, "utf8")),
            connection: "close",
          },
        },
        (res) => {
          const chunks = [];
          let totalBytes = 0;
          res.on("data", (c) => {
            totalBytes += c.length;
            if (totalBytes > MAX_RESPONSE_BYTES) {
              finish({ ok: false, kind: "timeout", error: `telegram proxy response exceeded ${MAX_RESPONSE_BYTES} bytes` });
              return;
            }
            chunks.push(c);
          });
          res.on("error", failFromError);
          res.on("aborted", () => {
            finish({ ok: false, kind: "timeout", error: "telegram proxy response aborted mid-stream" });
          });
          res.once("close", () => {
            if (!settled && !res.complete) {
              finish({ ok: false, kind: "timeout", error: "telegram proxy response closed incomplete" });
            }
          });
          res.on("end", () => {
            const textBody = Buffer.concat(chunks).toString("utf8");
            finish(parseTelegramBodyOrFail(res.statusCode ?? 0, textBody));
          });
        },
      );
      req.once("error", failFromError);
      requestSent = true;
      req.write(payload);
      req.end();
      transportSock.resume();
    };

    rawSock.once("error", failFromError);
    rawSock.once("close", failPreHttpEof("CONNECT 200"));
    rawSock.once("connect", () => {
      rawSock.write(`CONNECT ${connectHost}:${targetPort} HTTP/1.1\r\nHost: ${connectHost}:${targetPort}\r\n\r\n`);
    });

    let head = "";
    const onProxyHead = (chunk) => {
      head += chunk.toString("latin1");
      const idx = head.indexOf("\r\n\r\n");
      if (idx === -1) {
        if (head.length > 8192) {
          finish({ ok: false, kind: "local", error: "proxy CONNECT response header too large" });
        }
        return;
      }
      rawSock.off("data", onProxyHead);
      const statusLine = head.slice(0, head.indexOf("\r\n")).trim();
      if (!/^HTTP\/1\.[01]\s+200(?:\s|$)/.test(statusLine)) {
        finish({ ok: false, kind: "local", error: `proxy CONNECT refused: ${statusLine}` });
        return;
      }
      connectConfirmed = true;
      const leftover = Buffer.from(head.slice(idx + 4), "latin1");
      if (leftover.length > 0) {
        rawSock.pause();
        rawSock.unshift(leftover);
      }

      if (!useTls) {
        issueHttpRequest(rawSock);
        return;
      }

      const tlsOpts = isIP(targetHost) === 0
        ? { socket: rawSock, servername: targetHost }
        : { socket: rawSock, host: targetHost };
      const transportSock = tlsConnect(tlsOpts);
      activeSocket = transportSock;
      transportSock.once("error", failFromError);
      transportSock.once("close", failPreHttpEof("TLS handshake"));
      transportSock.once("secureConnect", () => {
        tlsConfirmed = true;
        issueHttpRequest(transportSock);
      });
    };
    rawSock.on("data", onProxyHead);
  });
}

let input;
try {
  input = readInput();
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, kind: "local", error: `invalid telegram child input: ${err.message}` }));
  process.exit(0);
}

const { apiBase, botToken, chatId, text, timeoutMs, proxy = null } = input ?? {};
if (
  typeof apiBase !== "string" ||
  typeof botToken !== "string" ||
  botToken.length === 0 ||
  /[\s/?#\\]/.test(botToken) ||
  typeof chatId !== "string" ||
  !/^-?\d+$/.test(chatId) ||
  typeof text !== "string" ||
  text.trim().length === 0 ||
  text.length > 4096 ||
  !Number.isInteger(timeoutMs) ||
  timeoutMs < 1000 ||
  !isValidProxy(proxy)
) {
  process.stdout.write(JSON.stringify({ ok: false, kind: "local", error: "telegram child refused malformed parameters" }));
  process.exit(0);
}

const endpoint = `${apiBase.replace(/\/$/, "")}/bot${botToken}/sendMessage`;
if (proxy) {
  const proxied = await sendViaConnectProxy({ endpoint, proxy, chatId, text, timeoutMs });
  if (proxied.ok) {
    process.stdout.write(JSON.stringify({ ok: true, status: proxied.status, body: proxied.body }));
  } else {
    process.stdout.write(
      JSON.stringify({ ok: false, kind: proxied.kind, error: scrubToken(proxied.error, botToken) }),
    );
  }
  process.exit(0);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
try {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
    redirect: "error",
    signal: controller.signal,
  });
  let textBody = "";
  if (res.body) {
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error(`telegram direct response exceeded ${MAX_RESPONSE_BYTES} bytes`), { name: "AbortError" });
      }
      chunks.push(Buffer.from(value));
    }
    textBody = Buffer.concat(chunks).toString("utf8");
  }
  const bodyOutcome = parseTelegramBodyOrFail(res.status, textBody);
  process.stdout.write(JSON.stringify(bodyOutcome.ok ? bodyOutcome : { ok: false, kind: bodyOutcome.kind, error: scrubToken(bodyOutcome.error, botToken) }));
} catch (e) {
  const causeCode = e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.code ?? null;
  const causeMsg = String(e?.cause?.message ?? "");
  const timedOut = controller.signal.aborted || e?.name === "AbortError";
  const isPreSendLocal =
    !timedOut &&
    ((typeof causeCode === "string" && LOCAL_NETWORK_CODES.has(causeCode)) ||
      /^(?:bad port|unexpected redirect)$/i.test(causeMsg));
  const rawDetail = causeCode ? `${e?.message ?? e} (${causeCode})` : (causeMsg || String(e?.message ?? e));
  process.stdout.write(
    JSON.stringify({
      ok: false,
      kind: isPreSendLocal ? "local" : "timeout",
      error: scrubToken(rawDetail, botToken),
    }),
  );
} finally {
  clearTimeout(timer);
}
