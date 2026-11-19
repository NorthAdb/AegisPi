// Pre-migration backups (06 section 9 startup order: integrity, THEN a
// backup BEFORE migration, then migration and schema verification). The
// snapshot must hold the PRE-apply state: if a migration apply fails midway,
// the rolled-back live database plus this snapshot is the rollback point.
// A database whose schema is already current takes no new snapshot — nothing
// is about to be applied to it.

import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, checkDatabaseIntegrity } from "./connect.mjs";

export function migrationPending(db) {
  // The apply-or-refuse path: a database with no schema_migrations record is
  // about to have version 1 applied (or be refused for stray tables — the
  // snapshot is harmless forensics either way). A database that already
  // records version 1 with the pinned checksum only gets verified, never
  // applied, so no snapshot is needed before a restart.
  const hasTable = db
    .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get().c;
  if (!hasTable) return true;
  const recorded = db.prepare("SELECT count(*) c FROM schema_migrations").get().c;
  return recorded === 0;
}

export function preMigrationBackup(db, { backupsDir, now }) {
  mkdirSync(backupsDir, { recursive: true });
  const path = join(backupsDir, `pre-migration-${now}.db`);
  // VACUUM INTO wants forward slashes on Windows.
  db.prepare("VACUUM INTO ?").run(path.replace(/\\/g, "/"));
  const bytes = statSync(path).size;
  // Fail closed if the snapshot is not usable: a broken backup is worse than
  // no backup because it pretends to be a rollback point.
  const check = openDatabase(path, { readOnly: true });
  const integrity = checkDatabaseIntegrity(check);
  check.close();
  if (!integrity.ok) {
    throw new Error(`pre-migration snapshot failed its own integrity check: ${integrity.detail}`);
  }
  return { path, bytes, integrity: integrity.detail };
}
