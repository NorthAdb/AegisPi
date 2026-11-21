// Child process for the real HTTP submitter transport: performs exactly one
// POST and prints the outcome as JSON on stdout. Invoked synchronously by
// upstream-http.mjs (argv: endpoint, body JSON, timeout in ms). The child's
// own abort deadline makes timeouts a clean, reported outcome; the parent's
// longer spawn deadline is the wedge fallback.
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
]);

const [endpoint, bodyJson, timeoutMsArg] = process.argv.slice(2);
const timeoutMs = Number(timeoutMsArg);
const body = JSON.parse(bodyJson);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
try {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aegispi-request-kind": String(body.kind) },
    body: bodyJson,
    redirect: "error",
    signal: controller.signal,
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {}
  process.stdout.write(JSON.stringify({ ok: true, status: res.status, body: parsed }));
} catch (e) {
  const code = e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.code ?? null;
  const causeMsg = String(e?.cause?.message ?? e?.message ?? "");
  const timedOut = e?.name === "AbortError" || controller.signal.aborted;
  const isLocal =
    !timedOut &&
    ((typeof code === "string" && LOCAL_NETWORK_CODES.has(code)) ||
      /^(?:bad port|unexpected redirect)$/i.test(causeMsg));
  process.stdout.write(
    JSON.stringify({
      ok: false,
      kind: isLocal ? "local" : "timeout",
      error: code ? `${e?.message ?? e} (${code})` : causeMsg || String(e?.message ?? e),
    }),
  );
} finally {
  clearTimeout(timer);
}
