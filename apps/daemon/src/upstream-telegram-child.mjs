import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const LOCAL_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_INVALID_URL",
]);

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
    let requestSent = false;
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

    const failFromError = (err) => {
      const code = err?.cause?.code ?? err?.code ?? null;
      const isLocal = !requestSent && (!connectConfirmed || (typeof code === "string" && LOCAL_NETWORK_CODES.has(code)));
      const detail = code ? `${err?.message ?? err} (${code})` : String(err?.message ?? err);
      finish({ ok: false, kind: isLocal ? "local" : "timeout", error: detail });
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        kind: requestSent ? "timeout" : "local",
        error: requestSent ? "telegram proxy request timed out" : "telegram proxy CONNECT timed out",
      });
    }, timeoutMs);

    rawSock.once("error", failFromError);
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
      const statusLine = head.slice(0, head.indexOf("\r\n"));
      if (!/\s200\s/.test(` ${statusLine} `)) {
        finish({ ok: false, kind: "local", error: `proxy CONNECT refused: ${statusLine.trim()}` });
        return;
      }
      connectConfirmed = true;
      const leftover = Buffer.from(head.slice(idx + 4), "latin1");
      if (leftover.length > 0) rawSock.unshift(leftover);

      const transportSock = useTls
        ? tlsConnect({ socket: rawSock, servername: targetHost })
        : rawSock;
      activeSocket = transportSock;
      transportSock.once("error", failFromError);

      const defaultPort = useTls ? 443 : 80;
      const hostHeader = targetPort === defaultPort ? connectHost : `${connectHost}:${targetPort}`;
      const req = httpRequest(
        {
          agent: false,
          hostname: targetHost,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: {
            host: hostHeader,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload, "utf8")),
          },
          createConnection: () => transportSock,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
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
      req.once("error", failFromError);
      requestSent = true;
      req.write(payload);
      req.end();
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
    signal: controller.signal,
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {}
  process.stdout.write(JSON.stringify({ ok: true, status: res.status, body: parsed }));
} catch (e) {
  const causeCode = e?.cause?.code ?? e?.code ?? null;
  const timedOut = controller.signal.aborted || e?.name === "AbortError";
  const isPreSendLocal = !timedOut && typeof causeCode === "string" && LOCAL_NETWORK_CODES.has(causeCode);
  const rawDetail = causeCode ? `${e?.message ?? e} (${causeCode})` : String(e?.message ?? e);
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
