// Isolated short-lived CalDAV child (Unit 5.4; spec 03 section 4, 02 section
// 4). One process, one job, stdin JSON in, one JSON line out. The model never
// touches this surface: the host config owns the URL, the child accepts
// structured fields only, and every request is a FIXED template against the
// configured collection — never a model-assembled path.
//
//   {mode:"calendar.read"}  REPORT (RFC 4791 calendar-query, Depth 1) over the
//                           collection; parses multistatus responses into
//                           bounded {href, etag, ics} entries.
//   {mode:"calendar.write"} PUT / DELETE with `If-Match: "<etag>"` — the 06
//                           section 5 resource-version precondition. A 412
//                           Precondition Failed is kind "precondition": the
//                           write definitively did NOT happen and the card
//                           must be re-approved against the fresh ETag.
//
// TLS: full verification by default; a loopback host accepts the fixture's
// self-signed certificate (the same local-verification-seam convention as the
// mail child). Credentials never appear in output — scrubbed on every path.

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { parseIcsEvents } from "./calendar-ics.mjs";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function readInput() {
  return JSON.parse(readFileSync(0, "utf8"));
}

function isLoopbackUrl(url) {
  const h = (url.hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
}

function scrub(text, secrets) {
  let clean = String(text ?? "");
  for (const s of secrets) {
    if (typeof s === "string" && s.length > 0) clean = clean.split(s).join("[REDACTED_CREDENTIAL]");
  }
  return clean.slice(0, 600);
}

function fail(error, kind = "local") {
  process.stdout.write(JSON.stringify({ ok: false, kind, error: scrub(error, []) }));
  process.exit(0);
}

// One HTTP request against the configured URL; the response is streamed with
// a hard byte bound. Classification: local (pre-send failure — zero request
// bytes of consequence), remote (a status the server returned), unknown
// (the request was fully written but the connection broke before a status).
function httpOnce({ url, method, headers, body, timeoutMs, secrets }) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const useTls = target.protocol === "https:";
    const reqFn = useTls ? httpsRequest : httpRequest;
    let settled = false;
    let requestWritten = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        req.destroy();
      } catch {}
      resolve(outcome);
    };
    const req = reqFn(
      {
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: Number(target.port || (useTls ? 443 : 80)),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...headers,
          host: target.host,
          ...(body !== null ? { "content-length": String(Buffer.byteLength(body, "utf8")) } : {}),
          connection: "close",
          ...(useTls && isLoopbackUrl(target) ? {} : {}),
        },
        ...(useTls ? { rejectUnauthorized: !isLoopbackUrl(target) } : {}),
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          total += c.length;
          if (total > MAX_RESPONSE_BYTES) {
            finish({ ok: false, kind: "remote", status: res.statusCode ?? 0, error: `response exceeded ${MAX_RESPONSE_BYTES} bytes` });
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          finish({
            ok: true,
            status: res.statusCode ?? 0,
            headers: { etag: res.headers.etag ?? null, "content-type": res.headers["content-type"] ?? null },
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", (e) => finish({ ok: false, kind: requestWritten ? "unknown" : "local", error: String(e.message ?? e) }));
      },
    );
    const timer = setTimeout(() => {
      finish({ ok: false, kind: requestWritten ? "unknown" : "local", error: `calendars request timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    req.on("error", (e) => {
      finish({ ok: false, kind: requestWritten ? "unknown" : "local", error: String(e.message ?? e) });
    });
    if (body !== null) {
      req.write(body);
    }
    req.end();
    requestWritten = true;
  });
}

// Minimal multistatus extraction (no XML dependency): bounded <D:response> /
// <d:response> blocks with <D:getetag> and the calendar-data payload.
function parseMultistatus(xml) {
  const out = [];
  const blockRe = /<(?:[a-zA-Z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?response>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null && out.length < 500) {
    const block = m[1];
    const href = /<(?:[a-zA-Z0-9]+:)?href[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?href>/.exec(block)?.[1]?.trim() ?? "";
    const etagM = /<(?:[a-zA-Z0-9]+:)?getetag[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?getetag>/.exec(block)?.[1]?.trim() ?? "";
    const icsM = /<(?:[a-zA-Z0-9]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?calendar-data>/.exec(block)?.[1] ?? "";
    out.push({ href, etag: etagM.replace(/^"|"$/g, ""), ics: icsM.trim() });
  }
  return out;
}

// parseIcsEvents/parseIcsDate live in calendar-ics.mjs (pure, import-safe).

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

const READ_BODY = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

let input;
try {
  input = readInput();
} catch (err) {
  fail(`invalid calendar child input: ${err.message}`);
}

const { mode, url, username, password, timeoutMs = 30000 } = input ?? {};
const secrets = [username, password].filter((s) => typeof s === "string" && s.length > 0);

if (!["calendar.read", "calendar.write", "calendar.head"].includes(mode)) fail(`mode ${JSON.stringify(mode)} is not one of calendar.read/calendar.write/calendar.head`);
let target;
try {
  target = new URL(String(url ?? ""));
} catch {
  fail("calendar child refused the URL parameter");
}
if (!/^https?:$/.test(target.protocol)) fail("calendar child refused a non-http(s) URL");
if (target.username || target.password || target.search) fail("calendar child refused a URL embedding credentials or a query string");
if (typeof username !== "string" || username.length === 0 || username.length > 320) fail("calendar child refused the username parameter");
if (typeof password !== "string" || password.length === 0 || password.length > 1024) fail("calendar child refused the password parameter");
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) fail("calendar child refused the timeout parameter");

const authHeaders = { authorization: basicAuth(username, password) };

if (mode === "calendar.read") {
  const res = await httpOnce({
    url: String(url),
    method: "REPORT",
    headers: { ...authHeaders, depth: "1", "content-type": "application/xml" },
    body: READ_BODY,
    timeoutMs,
    secrets,
  });
  if (!res.ok) {
    process.stdout.write(JSON.stringify({ ok: false, kind: res.kind, error: scrub(res.error, secrets) }));
    process.exit(0);
  }
  if (res.status !== 207) {
    process.stdout.write(JSON.stringify({ ok: false, kind: "remote", status: res.status, error: `calendars REPORT returned HTTP ${res.status}` }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ ok: true, entries: parseMultistatus(res.body) }));
  process.exit(0);
}

// calendar.head: a plain GET of one resource returning its current ETag —
// the dispatcher's precondition source (06 section 6 head re-check).
if (mode === "calendar.head") {
  const { href } = input;
  if (typeof href !== "string" || !href.startsWith("/")) fail("calendar.head needs a collection-relative href");
  const res = await httpOnce({
    url: `${target.origin}${href}`,
    method: "GET",
    headers: { ...authHeaders, depth: "0" },
    body: null,
    timeoutMs,
    secrets,
  });
  if (!res.ok) {
    process.stdout.write(JSON.stringify({ ok: false, kind: res.kind, error: scrub(res.error, secrets) }));
    process.exit(0);
  }
  if (res.status !== 200 && res.status !== 404) {
    process.stdout.write(JSON.stringify({ ok: false, kind: "remote", status: res.status, error: `calendar head GET returned HTTP ${res.status}` }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ ok: true, found: res.status === 200, etag: (res.headers.etag ?? "").replace(/^"|"$/g, "") || null, status: res.status }));
  process.exit(0);
}

// calendar.write
const { method, href, etag, ics } = input;
if (!["PUT", "DELETE"].includes(method)) fail("calendar.write method must be PUT or DELETE");
if (typeof href !== "string" || !href.startsWith("/")) fail("calendar.write needs a collection-relative href");
if (method === "PUT") {
  if (typeof ics !== "string" || ics.trim().length === 0) fail("calendar.write PUT needs ics content");
  if (Buffer.byteLength(ics, "utf8") > 1024 * 1024) fail("ics exceeds 1MiB");
}
if (method === "PUT" && (typeof etag !== "string" || etag.length === 0)) {
  fail("calendar.write PUT needs an ETag for the If-Match precondition (zero silent overwrites)");
}

const writeUrl = `${target.origin}${href}`;
const res = await httpOnce({
  url: writeUrl,
  method,
  headers: {
    ...authHeaders,
    ...(method === "PUT" ? { "content-type": "text/calendar; charset=utf-8", "if-match": `"${String(etag).replace(/"/g, "")}"` } : {}),
    ...(method === "DELETE" && typeof etag === "string" && etag.length > 0 ? { "if-match": `"${String(etag).replace(/"/g, "")}"` } : {}),
  },
  body: method === "PUT" ? ics : null,
  timeoutMs,
  secrets,
});
if (!res.ok) {
  const kind = res.kind === "remote" ? "remote" : res.kind === "unknown" ? "unknown" : "local";
  process.stdout.write(JSON.stringify({ ok: false, kind, error: scrub(res.error, secrets) }));
  process.exit(0);
}
if (res.status === 412 || res.status === 409) {
  process.stdout.write(JSON.stringify({
    ok: false,
    kind: "precondition",
    status: res.status,
    error: `head_changed: server returned ${res.status} Precondition Failed; the remote calendar changed under the approved action`,
  }));
  process.exit(0);
}
if (res.status < 200 || res.status >= 300) {
  process.stdout.write(JSON.stringify({ ok: false, kind: "remote", status: res.status, error: `calendar ${method} returned HTTP ${res.status}` }));
  process.exit(0);
}
const newEtag = (res.headers.etag ?? "").replace(/^W\//, "").replace(/^"|"$/g, "") || `etag-unknown-${createHash("sha256").update(String(res.body)).digest("hex").slice(0, 16)}`;
process.stdout.write(JSON.stringify({ ok: true, status: res.status, etag: newEtag, method }));
process.exit(0);
