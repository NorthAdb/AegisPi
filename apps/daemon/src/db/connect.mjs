// Connection initialization per design-pack 06 section 1 and schema.sql:
// every connection sets WAL, FULL synchronous, foreign_keys, busy_timeout.
// The pragmas are read back and verified; a mismatch fails closed.

import { DatabaseSync } from "node:sqlite";

export const REQUIRED_SQLITE_VERSION = "3.39";

export function openDatabase(dbPath, { readOnly = false } = {}) {
  const db = new DatabaseSync(dbPath, { open: true, readOnly });
  if (!readOnly) {
    applyConnectionPragmas(db);
  } else {
    // Even read-only inspection connections honor the busy timeout so they do
    // not fail spuriously against an active writer.
    db.exec("PRAGMA busy_timeout=5000");
  }
  return db;
}

export function applyConnectionPragmas(db) {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  const journal = db.prepare("PRAGMA journal_mode").get();
  const sync = db.prepare("PRAGMA synchronous").get();
  const fk = db.prepare("PRAGMA foreign_keys").get();
  const busy = db.prepare("PRAGMA busy_timeout").get();
  if (journal.journal_mode !== "wal") {
    throw new Error(`journal_mode is ${journal.journal_mode}, expected wal`);
  }
  if (sync.synchronous !== 2) {
    throw new Error(`synchronous is ${sync.synchronous}, expected 2 (FULL)`);
  }
  if (fk.foreign_keys !== 1) {
    throw new Error(`foreign_keys is ${fk.foreign_keys}, expected 1`);
  }
  if (busy.timeout < 5000) {
    throw new Error(`busy_timeout is ${busy.timeout}, expected >= 5000`);
  }
}

export function checkDatabaseIntegrity(db) {
  const integrity = db.prepare("PRAGMA integrity_check(1)").all();
  const first = integrity[0];
  const text = first ? (first.text ?? first.integrity_check ?? Object.values(first)[0]) : "";
  const ok = integrity.length === 1 && text === "ok";
  if (!ok) return { ok: false, detail: JSON.stringify(integrity) };
  const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
  if (fkViolations.length > 0) {
    return { ok: false, detail: `${fkViolations.length} foreign key violation(s)` };
  }
  return { ok: true, detail: "integrity_check ok, foreign_key_check empty" };
}

export function sqliteLibraryVersion(db) {
  return db.prepare("select sqlite_version() as v").get().v;
}
