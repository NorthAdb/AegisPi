// Recoverable tool-output spill (Unit 5.1; spec 01 section 6, audit
// matrix F09). Tool output past the 50 KB / 2000-line bound is written to a
// scope-isolated `tool_spill` object AFTER a best-effort credential
// scrub; the model only ever sees a bounded truncated view plus the
// spillObjectId. Reading the full text goes through an ACL-checked paged
// read on the object id — the host file path is never exposed.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { putObjectContent, insertObjectRow } from "./objects.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { hasReadGrant } from "./acl.mjs";
import { withTx } from "./db/tx.mjs";

export class SpillError extends Error {}

const SPILL_KIND = "tool_spill";
const VIEW_MAX_LINES = 150;
const VIEW_MAX_BYTES = 8192;
const ERROR_LINE_RE = /(?:error|failed|failure|exception|traceback|fatal|✗|FAIL|\bERR\b)/i;
const MAX_ERROR_LINES = 30;

// Best-effort, deterministic credential scrub. This is NOT a proof that all
// secrets are found — the stronger rule stays upstream: logs carrying
// live secrets must never be written to an unprotected spill in the first
// place (01 section 6).
export function redactSecrets(text) {
  return String(text)
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_TG_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, "Bearer [REDACTED]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key|app[_-]?password)\b(\s*[:=]\s*)(["']?)[^\s"']{8,}\3/gi, "$1$2$3[REDACTED]$3");
}

function clipViewLines(lines, pick) {
  const picked = [];
  for (const line of lines) {
    picked.push(line);
    if (picked.length >= pick) break;
  }
  let bytes = 0;
  const out = [];
  for (const line of picked) {
    if (bytes + line.length + 1 > VIEW_MAX_BYTES && out.length > 0) break;
    out.push(line);
    bytes += line.length + 1;
  }
  return out;
}

/**
 * Build the bounded model-facing view. Code/document output keeps the
 * HEAD; build/test/log output keeps the TAIL plus key error lines from
 * anywhere — the two halves a human actually needs to act.
 */
export function buildSpillView(content, { toolName }) {
  const allLines = String(content).split("\n");
  const logish = /(?:log|test|build|compile|stderr|stdout|runner|exec)/i.test(String(toolName ?? ""));
  const errorLines = [];
  for (const line of allLines) {
    if (ERROR_LINE_RE.test(line) && errorLines.length < MAX_ERROR_LINES) errorLines.push(line);
  }
  const kept = logish
    ? clipViewLines(allLines.slice(Math.max(0, allLines.length - VIEW_MAX_LINES)), VIEW_MAX_LINES)
    : clipViewLines(allLines.slice(0, VIEW_MAX_LINES), VIEW_MAX_LINES);
  const head = [`[spill view of tool '${toolName}']`, ...(logish ? ["… (tail kept, head truncated)"] : ["… (head kept, tail truncated)"])];
  const body = errorLines.length > 0 ? [...kept, "", "key error lines:", ...errorLines] : kept;
  return [...head, ...body, `[full output: spill object, ACL-gated paged read]`].join("\n");
}

/**
 * Capture oversized tool output. Under both bounds: a no-op (the caller
 * keeps the full text; nothing is spilled). Over either bound: redact,
 * store the FULL redacted text as the object content, return the bounded
 * view plus the spillObjectId.
 */
export function captureToolSpill(db, stateDir, {
  scopeId, toolName, content, now, actorId = "host",
  maxBytes = 51200, maxLines = 2000, extraRequiredScopeIds = [], parentObjectIds = [],
}) {
  if (typeof content !== "string") throw new SpillError("spill content must be a string");
  const bytes = Buffer.byteLength(content, "utf8");
  const lines = content.split("\n").length;
  if (bytes <= maxBytes && lines <= maxLines) {
    return { spilled: false, bytes, lines };
  }
  if (!db.prepare("SELECT id FROM scopes WHERE id=?").get(scopeId)) {
    throw new SpillError(`scope ${scopeId} does not exist`);
  }
  const redacted = redactSecrets(content);
  const stored = putObjectContent(stateDir, redacted);
  const view = buildSpillView(redacted, { toolName });
  const result = withTx(db, () => {
    const row = insertObjectRow(db, {
      scopeId,
      kind: SPILL_KIND,
      sourceUri: `spill:${toolName}:${now}`,
      sourceActor: actorId,
      content: redacted,
      contentHash: stored.contentHash,
      storageRef: stored.storageRef,
      status: "active",
      observedAt: now,
      expiresAt: null,
      metadata: { toolName, bytes, lines, redacted: true },
      requiredScopeIds: [scopeId, ...extraRequiredScopeIds],
      parents: parentObjectIds.map((id) => ({ parentId: id })),
    });
    writeAudit(db, {
      code: "tool_spill_captured",
      actorId,
      details: { scope_id: scopeId, object_id: row.id, tool_name: toolName, bytes, lines },
      now,
    });
    writeStreamEvent(db, {
      scopeId,
      eventType: "memory_changed",
      entityId: `object:${row.id}`,
      entityVersion: 1,
      payload: { kind: SPILL_KIND, toolName },
      now,
    });
    return row;
  });
  return { spilled: true, spillObjectId: result.id, view, bytes, lines };
}

/**
 * ACL-gated paged read over a spill (or any object) — the ONLY way the
 * full text is reachable, by object id, never by host path. Every
 * required scope needs a live read grant; denials are uniform so object
 * existence is not leaked to unauthorized callers.
 */
export function readSpillPage(db, stateDir, { objectId, principalId, offset = 0, limit = 200, now }) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 2000) {
    throw new SpillError("offset must be a non-negative integer and limit an integer 1..2000");
  }
  const row = db
    .prepare("SELECT id, scope_id, kind, content_hash, storage_ref, status, deleted_at FROM objects WHERE id=?")
    .get(objectId);
  if (!row || row.status === "deleted" || row.deleted_at !== null) {
    return { denied: true, reason: "object not readable" };
  }
  const required = db.prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=?").all(row.id);
  if (required.length === 0 || !required.every((r) => hasReadGrant(db, { scopeId: r.scope_id, principalId, now }))) {
    return { denied: true, reason: "object not readable" };
  }
  if (typeof row.storage_ref !== "string" || row.storage_ref.includes("\\") || row.storage_ref.includes("..")) {
    throw new SpillError(`object ${objectId} has an invalid storage ref`);
  }
  const path = join(stateDir, ...row.storage_ref.split("/"));
  if (!existsSync(path)) {
    throw new SpillError(`object ${objectId} content file is missing`);
  }
  const lines = readFileSync(path, "utf8").split("\n");
  const slice = lines.slice(offset, offset + limit);
  return {
    denied: false,
    objectId,
    kind: row.kind,
    contentHash: row.content_hash,
    offset,
    limit,
    totalLines: lines.length,
    lines: slice,
  };
}
