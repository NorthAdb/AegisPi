import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digestSecret } from "../governance/canonical.ts";
import { withImmediateTx, writeAuditEvent } from "../governance/db.ts";

export const SESSION_COOKIE_NAME = "aegispi_session";
export const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthSession {
  tokenDigest: string;
  principalId: string;
  expiresAt: number;
}

export class LoginRateLimiter {
  readonly #attempts = new Map<string, number[]>();
  readonly #maxPerWindow: number;
  readonly #windowMs: number;

  constructor(maxPerWindow = 10, windowMs = 60_000) {
    this.#maxPerWindow = maxPerWindow;
    this.#windowMs = windowMs;
  }

  checkAndRecord(key: string, now: number): boolean {
    const list = (this.#attempts.get(key) ?? []).filter((ts) => now - ts < this.#windowMs);
    if (list.length >= this.#maxPerWindow) {
      this.#attempts.set(key, list);
      return false;
    }
    list.push(now);
    this.#attempts.set(key, list);
    return true;
  }
}

export function constantTimeTokenMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function createWebSession(
  db: DatabaseSync,
  params: { principalId: string; now: number; ttlMs?: number },
): { rawToken: string; tokenDigest: string; expiresAt: number } {
  const ttl = Math.min(params.ttlMs ?? MAX_SESSION_TTL_MS, MAX_SESSION_TTL_MS);
  const rawToken = randomBytes(32).toString("hex");
  const tokenDigest = digestSecret(rawToken);
  const expiresAt = params.now + ttl;

  withImmediateTx(db, () => {
    db.prepare(
      `INSERT INTO sessions(token_digest, principal_id, expires_at, revoked_at)
       VALUES (?, ?, ?, NULL)`,
    ).run(tokenDigest, params.principalId, expiresAt);
    writeAuditEvent(db, {
      entityType: "session",
      entityId: tokenDigest.slice(0, 16),
      eventKey: `login:${tokenDigest.slice(0, 16)}`,
      eventType: "session_created",
      occurredAt: params.now,
      details: { principalId: params.principalId, expiresAt },
    });
  });

  return { rawToken, tokenDigest, expiresAt };
}

export function validateWebSession(
  db: DatabaseSync,
  rawToken: string | undefined,
  now: number,
): AuthSession | null {
  if (!rawToken || rawToken.length < 16) return null;
  const tokenDigest = digestSecret(rawToken);
  const row = db
    .prepare("SELECT token_digest, principal_id, expires_at, revoked_at FROM sessions WHERE token_digest = ?")
    .get(tokenDigest) as
    | { token_digest: string; principal_id: string; expires_at: number; revoked_at: number | null }
    | undefined;
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (now >= row.expires_at) return null;
  return {
    tokenDigest: row.token_digest,
    principalId: row.principal_id,
    expiresAt: row.expires_at,
  };
}

export function revokeWebSession(db: DatabaseSync, tokenDigest: string, now: number): void {
  withImmediateTx(db, () => {
    db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_digest = ? AND revoked_at IS NULL").run(
      now,
      tokenDigest,
    );
    writeAuditEvent(db, {
      entityType: "session",
      entityId: tokenDigest.slice(0, 16),
      eventKey: `logout:${tokenDigest.slice(0, 16)}:${now}`,
      eventType: "session_revoked",
      occurredAt: now,
    });
  });
}

export function isAllowedLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const normalized = hostHeader.toLowerCase().trim();
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
}

export function isAllowedLoopbackOrigin(originHeader: string | undefined, port: number): boolean {
  if (!originHeader || originHeader === "null") return false;
  const normalized = originHeader.toLowerCase().trim();
  return normalized === `http://127.0.0.1:${port}` || normalized === `http://localhost:${port}`;
}

export function buildSessionCookie(rawToken: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
