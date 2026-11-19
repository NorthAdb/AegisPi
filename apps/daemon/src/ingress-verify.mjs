// CP1 event verification (02 section 3 checkpoint table; 06 section 3.1:
// "验证原始字节签名、时间窗和平台事件ID").
//
// The durable ingress (receiveEvent) takes ALREADY-VERIFIED input; this
// module is the verification that produces it. Fail-closed is the default:
// with no secret configured for a source, verification REFUSES rather than
// skipping the check. Signature failures never persist the body — the
// caller gets a refusal and may write a redacted counter, nothing else.
//
// Canonical signed bytes: the exact raw payload string, LF-normalized,
// UTF-8, HMAC-SHA256 with the source's per-feed secret. Replay protection is
// the (source, provider event id) uniqueness that receiveEvent already
// enforces, plus the time window here.

import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_TIME_WINDOW_MS = 5 * 60 * 1000;

export class VerificationError extends Error {}
export class SignatureMissing extends VerificationError {}
export class SignatureInvalid extends VerificationError {}
export class TimeWindowExceeded extends VerificationError {}
export class SecretNotConfigured extends VerificationError {}

export function canonicalSignedBytes(payload) {
  if (typeof payload !== "string") {
    throw new VerificationError("payload must be a string (the raw received bytes as UTF-8 text)");
  }
  return Buffer.from(payload.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
}

export function computeEventSignature({ payload, secret }) {
  const mac = createHmac("sha256", secret);
  mac.update(canonicalSignedBytes(payload));
  return mac.digest("hex");
}

function constantTimeEqualHex(aHex, bHex) {
  const a = Buffer.from(String(aHex), "utf8");
  const b = Buffer.from(String(bHex), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// verifyFeedEvent: the single entry point an ingress adapter must call
// before receiveEvent. secretFor(source) must return the configured secret
// or null — null REFUSES (fail closed), it never degrades to "no signature
// required".
export function verifyFeedEvent({
  source,
  payload,
  signature,
  timestamp,
  now,
  secretFor,
  timeWindowMs = DEFAULT_TIME_WINDOW_MS,
}) {
  if (typeof source !== "string" || source.length === 0) {
    throw new VerificationError("source must be a non-empty string");
  }
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new VerificationError("timestamp must be a unix millisecond number");
  }
  if (Math.abs(now - timestamp) > timeWindowMs) {
    throw new TimeWindowExceeded(
      `event timestamp ${timestamp} is outside the ±${timeWindowMs}ms window around ${now}`,
    );
  }
  const secret = secretFor(source);
  if (secret === null || secret === undefined || secret === "") {
    throw new SecretNotConfigured(
      `no secret configured for source ${source}; verification refuses instead of skipping`,
    );
  }
  if (typeof signature !== "string" || signature.length === 0) {
    throw new SignatureMissing(`event from ${source} carries no signature`);
  }
  const expected = computeEventSignature({ payload, secret });
  if (!constantTimeEqualHex(expected, signature)) {
    throw new SignatureInvalid(`signature mismatch for source ${source}`);
  }
  return { verified: true, source };
}
