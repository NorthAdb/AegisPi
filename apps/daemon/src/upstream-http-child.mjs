// Child process for the real HTTP submitter transport: performs exactly one
// POST and prints the outcome as JSON on stdout. Invoked synchronously by
// upstream-http.mjs (argv: endpoint, body JSON, timeout in ms). The child's
// own abort deadline makes timeouts a clean, reported outcome; the parent's
// longer spawn deadline is the wedge fallback.
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
    signal: controller.signal,
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {}
  process.stdout.write(JSON.stringify({ ok: true, status: res.status, body: parsed }));
} catch (e) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      kind: e?.name === "AbortError" ? "timeout" : "local",
      error: String(e?.message ?? e),
    }),
  );
} finally {
  clearTimeout(timer);
}
