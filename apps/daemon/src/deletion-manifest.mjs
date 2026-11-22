// Protected tombstone deletion manifest (Unit 5.1; spec 01 section 4.1,
// 06 section 9 crash matrix; audit matrix F09/F15).
//
// The manifest is a JSON file at <stateDir>/deletion-manifest.json with a
// byte-identical .bak copy, INDEPENDENT of the ordinary database backups on
// purpose: a restored backup is old by construction, and the tombstones are
// what prevents forgotten data from resurrecting out of it. Each entry is
// content-free of sensitive text: {deletionSeq, objectId, contentHash,
// scopeId, deletedAt} chained by SHA-256 (entryHash covers the entry plus
// the previous entry's hash; the chain root is all zeros).
//
// Crash ordering (06 section 9): the FILE is appended BEFORE the DB rows are
// marked deleted. A crash between the two leaves the file AHEAD of the DB,
// which startup recovery repairs by replaying; the DB can never be ahead of
// the file, and a missing or stale file with a non-zero DB sequence refuses
// to open execution (read-only diagnostics) instead of resurrecting.

import { existsSync, mkdirSync, openSync, closeSync, renameSync, readFileSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJson, sha256LfHex } from "./keys.mjs";
import { writeAudit } from "./audit.mjs";
import { fsyncParentDir } from "./objects.mjs";

export const DELETION_MANIFEST_SEQ_STATE_KEY = "deletion_manifest_seq";
export const DELETION_MANIFEST_FILE = "deletion-manifest.json";
const GENESIS_PREV_HASH = `sha256:${"0".repeat(64)}`;

export class DeletionManifestError extends Error {}
export class DeletionManifestStale extends DeletionManifestError {}
export class DeletionManifestMissing extends DeletionManifestError {}
export class DeletionManifestCorrupt extends DeletionManifestError {}

function manifestPaths(stateDir) {
  const main = join(stateDir, DELETION_MANIFEST_FILE);
  return { main, backup: `${main}.bak` };
}

function entryHashOf({ deletionSeq, objectId, contentHash, scopeId, deletedAt, prevHash }) {
  return sha256LfHex(
    canonicalJson({
      deletionSeq,
      objectId: String(objectId),
      contentHash: String(contentHash),
      scopeId: String(scopeId),
      deletedAt: Number(deletedAt),
      prevHash: String(prevHash),
    }),
  );
}

function verifyChain(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, reason: "manifest root must be an object" };
  }
  if (doc.kind !== "aegispi-deletion-manifest" || doc.schemaVersion !== 1) {
    return { ok: false, reason: "unexpected manifest kind or schemaVersion" };
  }
  if (!Array.isArray(doc.entries)) {
    return { ok: false, reason: "manifest.entries must be an array" };
  }
  let prevHash = GENESIS_PREV_HASH;
  let expectedSeq = 1;
  for (const entry of doc.entries) {
    if (!entry || typeof entry !== "object") return { ok: false, reason: `entry ${expectedSeq} is not an object` };
    if (entry.deletionSeq !== expectedSeq) {
      return { ok: false, reason: `entry sequence broken at ${expectedSeq} (found ${JSON.stringify(entry.deletionSeq)})` };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, reason: `chain break at entry ${expectedSeq}: prevHash mismatch` };
    }
    if (entry.entryHash !== entryHashOf(entry)) {
      return { ok: false, reason: `chain break at entry ${expectedSeq}: entryHash does not cover the entry fields` };
    }
    if (typeof entry.objectId !== "string" || typeof entry.contentHash !== "string" || typeof entry.scopeId !== "string" || !Number.isInteger(entry.deletedAt)) {
      return { ok: false, reason: `entry ${expectedSeq} is missing tombstone fields` };
    }
    prevHash = entry.entryHash;
    expectedSeq += 1;
  }
  const latestSeq = doc.entries.length === 0 ? 0 : doc.entries[doc.entries.length - 1].deletionSeq;
  if (doc.latestSeq !== latestSeq) {
    return { ok: false, reason: `latestSeq ${JSON.stringify(doc.latestSeq)} does not match the last entry (${latestSeq})` };
  }
  return { ok: true, latestSeq };
}

function parseDoc(rawText, source) {
  let doc = null;
  try {
    doc = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: `${source} is not valid JSON` };
  }
  const verified = verifyChain(doc);
  return { ...verified, doc };
}

/**
 * Read and chain-verify the manifest. Prefers the main file; falls back to
 * the .bak copy only if the main file is missing or fails verification.
 * Never throws for a missing manifest when nothing was ever deleted
 * (dbSeq 0) — that is the honest fresh-install state.
 */
export function readDeletionManifest(stateDir) {
  const { main, backup } = manifestPaths(stateDir);
  const tried = [];
  for (const [path, source] of [[main, "manifest"], [backup, "manifest.bak"]]) {
    if (!existsSync(path)) {
      tried.push(`${source}: missing`);
      continue;
    }
    const parsed = parseDoc(readFileSync(path, "utf8"), source);
    if (parsed.ok) {
      return { ok: true, latestSeq: parsed.latestSeq, entries: parsed.doc.entries, source, repairedFromBackup: source === "manifest.bak" };
    }
    tried.push(`${source}: ${parsed.reason}`);
  }
  return { ok: false, reason: tried.join("; "), entries: [], latestSeq: null };
}

function atomicWriteManifest(stateDir, doc) {
  const { main, backup } = manifestPaths(stateDir);
  const serialized = `${JSON.stringify(doc, null, 2)}\n`;
  for (const path of [main, backup]) {
    const tmp = `${path}.tmp.${process.pid}`;
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, serialized);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    fsyncParentDir(dirname(path));
  }
}

/**
 * Append tombstones (caller supplies plain entries; the sequence, prevHash
 * and entryHash are computed here). Fails closed when the existing file is
 * corrupt — a broken chain must never be silently extended.
 */
export function appendDeletionManifest(stateDir, tombstones, { now } = {}) {
  if (!Array.isArray(tombstones) || tombstones.length === 0) {
    throw new DeletionManifestError("appendDeletionManifest requires a non-empty tombstone array");
  }
  mkdirSync(stateDir, { recursive: true });
  const { main, backup } = manifestPaths(stateDir);
  const freshStart = !existsSync(main) && !existsSync(backup);
  // A missing manifest on a system that never deleted anything is the
  // honest fresh state — the first append CREATES it. But an EXISTING file
  // that fails chain verification is never silently extended: a broken
  // chain must stay broken and loud, not be buried under new entries.
  let entries = [];
  let latestSeq = 0;
  if (!freshStart) {
    const current = readDeletionManifest(stateDir);
    if (!current.ok) {
      throw new DeletionManifestCorrupt(`refusing to extend a manifest that fails verification: ${current.reason}`);
    }
    entries = [...current.entries];
    latestSeq = current.latestSeq ?? 0;
  }
  let seq = latestSeq;
  let prevHash = seq === 0 ? GENESIS_PREV_HASH : entries[entries.length - 1].entryHash;
  for (const t of tombstones) {
    if (!t || typeof t.objectId !== "string" || typeof t.contentHash !== "string" || typeof t.scopeId !== "string") {
      throw new DeletionManifestError("each tombstone needs objectId, contentHash and scopeId");
    }
    seq += 1;
    const entry = {
      deletionSeq: seq,
      objectId: t.objectId,
      contentHash: t.contentHash,
      scopeId: t.scopeId,
      deletedAt: Number(t.deletedAt ?? now ?? Date.now()),
      prevHash,
    };
    entry.entryHash = entryHashOf(entry);
    prevHash = entry.entryHash;
    entries.push(entry);
  }
  const doc = { schemaVersion: 1, kind: "aegispi-deletion-manifest", entries, latestSeq: seq };
  atomicWriteManifest(stateDir, doc);
  return { latestSeq: seq, appended: tombstones.length };
}

// ---- DB side -----------------------------------------------------------

export function deletionSeqInDb(db) {
  const row = db.prepare("SELECT value FROM system_state WHERE key=?").get(DELETION_MANIFEST_SEQ_STATE_KEY);
  if (!row) return 0;
  const parsed = Number.parseInt(String(row.value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new DeletionManifestCorrupt(`system_state ${DELETION_MANIFEST_SEQ_STATE_KEY} is not a non-negative integer`);
  }
  return parsed;
}

// Caller-owned transaction (audit.mjs discipline: writes ride the caller's tx).
export function setDeletionSeqInTx(db, { latestSeq, now }) {
  db.prepare("INSERT INTO system_state(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(DELETION_MANIFEST_SEQ_STATE_KEY, String(latestSeq));
  writeAudit(db, {
    code: "deletion_manifest_seq_advanced",
    details: { latest_seq: latestSeq },
    now,
  });
}

/**
 * The startup/restore invariant: the file may be ahead of the DB (crash
 * between append and tx — repaired by replay) but must never be missing,
 * corrupt, or behind a non-zero DB sequence.
 */
export function verifyDeletionManifestInvariant(db, stateDir) {
  const dbSeq = deletionSeqInDb(db);
  const file = readDeletionManifest(stateDir);
  if (!file.ok) {
    if (dbSeq === 0 && !existsSync(manifestPaths(stateDir).main)) {
      // Nothing was ever forgotten and no manifest exists yet — honest
      // fresh state, not a violation.
      return { ok: true, dbSeq, fileLatestSeq: 0, pendingReplay: [], fresh: true };
    }
    return {
      ok: false,
      dbSeq,
      reason: dbSeq === 0 ? `deletion manifest unreadable while deletions may exist: ${file.reason}` : `deletion manifest unreadable while the database records ${dbSeq} deletions: ${file.reason}`,
    };
  }
  if (file.latestSeq < dbSeq) {
    return {
      ok: false,
      dbSeq,
      fileLatestSeq: file.latestSeq,
      reason: `deletion manifest latestSeq ${file.latestSeq} is behind the database deletion sequence ${dbSeq}; refusing to open execution (stale or rolled-back manifest)`,
    };
  }
  return {
    ok: true,
    dbSeq,
    fileLatestSeq: file.latestSeq,
    pendingReplay: file.entries.filter((e) => e.deletionSeq > dbSeq),
    fresh: dbSeq === 0 && file.latestSeq === 0,
  };
}

/**
 * Idempotent replay of tombstones into a database (a restored backup or a
 * crashed daemon). Each entry marks its object deleted, drops the FTS index
 * row (the schema triggers clean fts_messages_lex/tri), and records nothing
 * sensitive. Runs in ONE caller-visible transaction; safe to re-run.
 */
export function replayDeletionManifestInTx(db, { entries, now }) {
  let applied = 0;
  let maxSeq = null;
  for (const entry of entries) {
    db.prepare(
      "UPDATE objects SET status='deleted', deleted_at=? WHERE id=? AND (status IS NULL OR status != 'deleted')",
    ).run(entry.deletedAt, entry.objectId);
    db.prepare("DELETE FROM session_messages_index WHERE object_id=?").run(entry.objectId);
    applied += 1;
    maxSeq = entry.deletionSeq;
  }
  if (maxSeq !== null) {
    setDeletionSeqInTx(db, { latestSeq: maxSeq, now });
  }
  return { applied, latestSeq: maxSeq ?? 0 };
}

/** Physically remove a tombstoned object's content file (phase-2 cleanup). */
export function removeTombstonedContentFile(stateDir, { storageRef }) {
  if (typeof storageRef !== "string" || storageRef.includes("\\") || storageRef.includes("..")) {
    return { removed: false, reason: "invalid storage ref" };
  }
  const path = join(stateDir, ...storageRef.split("/"));
  if (!existsSync(path)) return { removed: false, reason: "already gone" };
  unlinkSync(path);
  return { removed: true };
}
