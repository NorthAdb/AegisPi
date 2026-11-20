// Child process for the model call path: performs exactly one POST to the
// configured model endpoint and prints the outcome as JSON on stdout.
// Invoked synchronously by model-call.mjs (argv: endpoint, body JSON,
// timeout ms, optional bearer token). The bearer token arrives via argv of
// a short-lived process and is never persisted, logged, or written to the
// database; the host credential service resolved it moments before.
const [endpoint, bodyJson, timeoutMsArg, bearer] = process.argv.slice(2);
const timeoutMs = Number(timeoutMsArg);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
try {
  const headers = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(endpoint, { method: "POST", headers, body: bodyJson, signal: controller.signal });
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
