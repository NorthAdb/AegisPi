// Key encoding and canonical serialization per design-pack 06 section 1.1.
//
// Host rules (06: "分隔符和字段本身按宿主规则转义后拼接"):
// - Every key component is percent-escaped for the separators of its shape
//   ('%' -> %25, ':' -> %3A, '/' -> %2F) so two different objects can never
//   collide into one key string. Control characters and newlines are rejected.
// - The final key string is lowercased (06: "规范化为小写").
// - Natural keys never embed random ids, autoincrement rowids, or run UUIDs.
//
// Canonical JSON is an RFC 8785-compatible subset: recursively sorted object
// keys, no insignificant whitespace, ES6 number formatting, UTF-8 output,
// no NaN/Infinity, no undefined, no duplicate keys (JS parse guarantees the
// last one at input; callers must parse untrusted JSON with a dup check if
// provenance matters).

import { createHash } from "node:crypto";

export function canonicalJson(value) {
  const out = serialize(value, new Set());
  return out;
}

function serialize(value, seen) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite number is not representable");
    }
    return JSON.stringify(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "bigint") {
    throw new Error("canonicalJson: bigint must be converted by the caller");
  }
  if (t === "undefined" || t === "function" || t === "symbol") {
    throw new Error(`canonicalJson: ${t} is not representable`);
  }
  if (t === "object") {
    if (Array.isArray(value)) {
      return "[" + value.map((v) => serialize(v, seen)).join(",") + "]";
    }
    if (seen.has(value)) {
      throw new Error("canonicalJson: circular reference");
    }
    seen.add(value);
    try {
      const keys = Object.keys(value).sort();
      const body = keys
        .map((k) => JSON.stringify(k) + ":" + serialize(value[k], seen))
        .join(",");
      return "{" + body + "}";
    } finally {
      seen.delete(value);
    }
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
}

export function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

export function sha256LfHex(text) {
  const lf = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return sha256Hex(lf);
}

function escapeComponent(component, { allowSlash = false } = {}) {
  if (typeof component !== "string" || component.length === 0) {
    throw new Error(`key component must be a non-empty string, got ${JSON.stringify(component)}`);
  }
  let out = "";
  for (const ch of component) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw new Error("key component contains a control character");
    }
    if (ch === "%") out += "%25";
    else if (ch === ":") out += "%3A";
    else if (ch === "/" && !allowSlash) out += "%2F";
    else out += ch;
  }
  return out;
}

function lower(key) {
  return key.toLowerCase();
}

// domain_key shapes, mapped 1:1 to scopes.kind (06 section 1.1 table).
export function ownerUserDomainKey(userId) {
  return lower(`user:${escapeComponent(userId)}`);
}

export function ownerDmDomainKey(channel, conversationId) {
  return lower(`dm:${escapeComponent(channel)}:${escapeComponent(conversationId)}`);
}

export function groupDomainKey(channel, groupId) {
  return lower(`group:${escapeComponent(channel)}:${escapeComponent(groupId)}`);
}

export function repoDomainKey(host, owner, name) {
  return lower(
    `repo:${escapeComponent(host)}/${escapeComponent(owner)}/${escapeComponent(name)}`,
  );
}

export function serviceDomainKey(name) {
  return lower(`service:${escapeComponent(name)}`);
}

// dispatch_key: inbound idempotency key. With a provider event id the shape
// is {source}:{provider_event_id}; the hash form is the SHA-256 hex digest of
// the documented canonical envelope (UTF-8, newlines normalized to LF) and is
// used only when the source has no stable event id (06 section 1.1).
export function dispatchKeyFromProviderId(source, providerEventId) {
  return lower(`${escapeComponent(source)}:${escapeComponent(providerEventId)}`);
}

export const CANONICAL_ENVELOPE_FIELDS = [
  "source",
  "source_kind",
  "received_at",
  "principal_platform",
  "principal_subject",
  "scope_kind",
  "domain_key",
  "thread_key",
  "priority",
  "payload_sha256",
];

export function canonicalEnvelope({
  source,
  source_kind,
  received_at,
  principal_platform,
  principal_subject,
  scope_kind,
  domain_key,
  thread_key,
  priority,
  payload_sha256,
}) {
  return {
    source,
    source_kind,
    received_at,
    principal_platform,
    principal_subject,
    scope_kind,
    domain_key,
    thread_key,
    priority,
    payload_sha256,
  };
}

export function dispatchKeyFromEnvelope(envelope) {
  const canonical = canonicalEnvelope(envelope);
  const json = canonicalJson(canonical);
  return sha256LfHex(json);
}

// business_key: outbound/side-effect intent dedup, local only (06 section 1.1
// and section 6: "business_key去重是本地意图去重，不是远端恰好一次保证").
// Retries reuse the key; a new version of the content/resource must mint a new
// natural_key version, which is the caller's duty.
export function businessKey(effectType, domainKey, naturalKey) {
  return lower(
    `${escapeComponent(effectType)}:${escapeComponent(domainKey, { allowSlash: true })}:${escapeComponent(naturalKey)}`,
  );
}

// Timer inbox events are unique by timer id and occurrence number
// (06 section 7: "按 timer:<id>:<occurrence_no> 生成唯一inbox"). The inbox row
// stores source='timer' and this id, so dispatch_key reads timer:<id>:<occ>.
export function timerOccurrenceEventId(timerId, occurrenceNo) {
  if (!Number.isInteger(occurrenceNo) || occurrenceNo < 1) {
    throw new Error("occurrence number must be a positive integer");
  }
  return lower(`${escapeComponent(timerId)}:${occurrenceNo}`);
}
