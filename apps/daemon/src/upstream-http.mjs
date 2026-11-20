// Real HTTP submitter transport (re-review P1: "the production loop has no
// real HTTP transport" — fail-closed was true and the transport was absent).
//
// This module is the base transport behind the ADAPTER upstream, exactly the
// role createFakeRemote plays for the fixture: the adapter keeps every trust
// decision (registry, policy, credentials, templates) and this module only
// carries bytes to the endpoint the HOST configured. The endpoint is never
// taken from action_json — adapters own addresses (02 section 4).
//
// The HTTP call runs in a short-lived child process (the same pattern the
// container executor uses for docker) so the dispatcher's durable
// transaction stays synchronous: SUBMITTING commits, the call runs, the
// outcome records — a crash anywhere in between leaves SUBMITTING for
// startup recovery to mark UNKNOWN, which is precisely the 06 crash row.
//
// Result shapes match the fake remote contract the dispatcher already maps:
//   {status:"succeeded", externalId} | {status:"failed_local", error}
//   {status:"failed_remote", error}  | {status:"unknown", error}
// A connection that dies before any byte leaves the host is failed_local; a
// timeout after bytes may have left is unknown (never blindly retried —
// reconciliation owns UNKNOWN). Without authorization the ADAPTER refuses
// before this module runs, so zero bytes leave the host.
//
// The endpoint must be an http(s) URL. For verification the endpoint is a
// LOCAL controllable service; a real external endpoint additionally needs
// policy.allowRealExternalWrites plus wired credentials, enforced upstream
// of this module by the adapter.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class HttpUpstreamError extends Error {}

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "upstream-http-child.mjs");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackEndpoint(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname);
}

// One synchronous round trip through the child. `graceMs` beyond the child's
// own abort deadline: a parent-side kill means the child was wedged, and the
// conservative verdict is unknown (bytes may have left).
function callEndpoint(endpoint, body, { timeoutMs }) {
  const r = spawnSync(process.execPath, [CHILD, endpoint, JSON.stringify(body), String(timeoutMs)], {
    encoding: "utf8",
    timeout: timeoutMs + 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.status !== 0 || typeof r.stdout !== "string" || r.stdout.length === 0) {
    return { ok: false, kind: r.signal === "SIGTERM" || r.status === null ? "timeout" : "local", error: `transport child failed (exit ${r.status ?? "killed"}): ${String(r.stderr ?? "").slice(0, 160)}` };
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { ok: false, kind: "local", error: "transport child produced unparseable output" };
  }
}

export function createHttpUpstream({ endpoint, label = "http-upstream", timeoutMs = 30000 }) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpUpstreamError(`the configured submit endpoint is not a URL: ${JSON.stringify(endpoint)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpUpstreamError(`the configured submit endpoint must be http(s), got ${url.protocol}`);
  }
  if (/\s/.test(endpoint)) {
    throw new HttpUpstreamError("the configured submit endpoint contains whitespace; refusing to guess");
  }
  const call = (body) => callEndpoint(url.toString(), body, { timeoutMs });
  return {
    label: `http-upstream(${label})`,
    endpoint: url.toString(),
    submit({ businessKey, idempotencyKey, operation, now, mode = undefined }) {
      if (mode !== undefined) {
        // The fault-injection seam belongs to the FAKE transport. A real
        // transport that honored it would let callers forge outcomes.
        throw new HttpUpstreamError("a real HTTP transport ignores fault-injection modes; only the fake transport simulates outcomes");
      }
      const r = call({ kind: "submit", businessKey, idempotencyKey, operation, at: now });
      if (!r.ok) {
        return r.kind === "timeout"
          ? { status: "unknown", error: r.error ?? "no response within deadline; request bytes may have been sent" }
          : { status: "failed_local", error: r.error ?? "transport failed before any request byte" };
      }
      if (r.status >= 200 && r.status < 300) {
        if (!r.body || typeof r.body.externalId !== "string" || r.body.externalId.length === 0) {
          return { status: "failed_remote", error: `upstream answered HTTP ${r.status} without an externalId` };
        }
        return { status: "succeeded", externalId: r.body.externalId, duplicate: r.body.duplicate === true };
      }
      return { status: "failed_remote", error: `upstream rejected the operation: HTTP ${r.status}` };
    },
    lookup({ businessKey, consistency = "strong" }) {
      const r = call({ kind: "lookup", businessKey, consistency });
      if (r.ok && r.status >= 200 && r.status < 300 && r.body) {
        return {
          found: r.body.found === true,
          externalId: typeof r.body.externalId === "string" ? r.body.externalId : null,
          strong: consistency === "strong",
        };
      }
      return { found: false, strong: false };
    },
    lookupHead({ targetResource }) {
      const r = call({ kind: "lookupHead", targetResource });
      if (r.ok && r.status >= 200 && r.status < 300 && r.body) {
        if (r.body.ok === true && typeof r.body.head === "string") {
          return { ok: true, head: r.body.head };
        }
        return { ok: false, reason: r.body.reason ?? "upstream could not verify the resource head" };
      }
      return { ok: false, reason: `head lookup failed: ${r.ok ? `HTTP ${r.status}` : r.error}` };
    },
  };
}
