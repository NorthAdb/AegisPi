import { readFileSync } from "node:fs";

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

let input;
try {
  input = readInput();
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, kind: "local", error: `invalid telegram child input: ${err.message}` }));
  process.exit(0);
}

const { apiBase, botToken, chatId, text, timeoutMs } = input ?? {};
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
  timeoutMs < 1000
) {
  process.stdout.write(JSON.stringify({ ok: false, kind: "local", error: "telegram child refused malformed parameters" }));
  process.exit(0);
}

const endpoint = `${apiBase.replace(/\/$/, "")}/bot${botToken}/sendMessage`;
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
