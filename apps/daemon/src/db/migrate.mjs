// Schema migrator per design-pack 06 section 1:
// - schema.sql is the design fixture for a brand-new database, not a
//   repeatable migration program.
// - schema_migrations is maintained by this migrator; the checksum algorithm is
//   SHA-256 over the normative SQL as UTF-8 bytes with newlines normalized to
//   LF (never CRLF, never un-normalized text).
// - The pack does not ship with the repo (decision D-01): the canonical SQL is
//   resolved from a pointer file, or the AEGISPI_SCHEMA_SQL env override, and
//   its LF checksum must equal the pinned expected value before anything is
//   applied. A missing file, an unreadable file, or a checksum mismatch fails
//   closed (upstream callers open read-only diagnostics, they never "fix" the
//   schema by guessing).
//
// Connection pragmas (WAL/FULL/foreign_keys/busy_timeout) are owned by
// connect.mjs per 06; the PRAGMA lines of the fixture are filtered before the
// DDL is applied, and the recorded checksum still covers the whole normative
// file, PRAGMA lines included.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class SchemaSourceError extends Error {}
export class SchemaDriftError extends Error {}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(here, "..", "..", "config", "schema-source.json");

// The pinned checksum ALWAYS applies, including when AEGISPI_SCHEMA_SQL
// overrides the path: an override that could skip the hash gate would turn the
// pin into a string self-assertion (the N9 lesson). The pointer file must
// therefore exist to supply the pin; only the path may be overridden.
export function loadCanonicalSchema({
  configPath = DEFAULT_CONFIG_PATH,
  env = process.env,
} = {}) {
  if (!existsSync(configPath)) {
    throw new SchemaSourceError(
      `no schema pin: ${configPath} missing (it carries expectedSha256Lf; AEGISPI_SCHEMA_SQL can only override the path)`,
    );
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const sourcePath = env.AEGISPI_SCHEMA_SQL ?? config.schemaSqlPath;
  const expectedSha256Lf = config.expectedSha256Lf;
  if (typeof expectedSha256Lf !== "string" || expectedSha256Lf.length !== 64) {
    throw new SchemaSourceError("schema-source.json has no valid expectedSha256Lf pin");
  }
  if (!existsSync(sourcePath)) {
    throw new SchemaSourceError(`canonical schema.sql not found at ${sourcePath}`);
  }
  const raw = readFileSync(sourcePath);
  const lfText = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
  const checksum = createHash("sha256").update(lfText).digest("hex");
  if (checksum !== expectedSha256Lf) {
    throw new SchemaSourceError(
      `canonical schema checksum mismatch: got ${checksum}, expected ${expectedSha256Lf} (${sourcePath})`,
    );
  }
  return {
    sourcePath,
    sqlText: lfText.toString("utf8"),
    ddlText: stripPragmaLines(lfText.toString("utf8")),
    checksum,
  };
}

function stripPragmaLines(sqlText) {
  return sqlText
    .split("\n")
    .filter((line) => !/^PRAGMA\b/i.test(line.trim()))
    .join("\n");
}

function tableExists(db, name) {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) !== undefined
  );
}

function userTableCount(db) {
  return db
    .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .get().c;
}

export function migrate(db, canonical) {
  const migrationsTable = tableExists(db, "schema_migrations");
  if (!migrationsTable) {
    if (userTableCount(db) > 0) {
      throw new SchemaDriftError(
        "database has tables but no schema_migrations record: refusing to guess; recover from backup or rebuild",
      );
    }
  }
  const applied = [];
  if (!migrationsTable) {
    // Version 1: apply the canonical fixture inside one transaction. DDL is
    // transactional in SQLite; a crash mid-apply rolls back to an empty file
    // which then migrates cleanly on the next start.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(canonical.ddlText);
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Transaction already dead; surface the original error.
      }
      throw new SchemaDriftError(`canonical schema apply failed: ${e.message}`);
    }
    const now = Date.now();
    db.prepare(
      "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?,?,?)",
    ).run(1, canonical.checksum, now);
    applied.push({ version: 1, checksum: canonical.checksum, appliedAt: now });
    return { applied, versions: [{ version: 1, checksum: canonical.checksum }] };
  }
  const rows = db
    .prepare("SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version")
    .all();
  if (rows.length === 0 && userTableCount(db) > 0) {
    throw new SchemaDriftError("schema_migrations exists but is empty while tables are present");
  }
  if (rows.length === 0) {
    throw new SchemaDriftError("schema_migrations exists but is empty on a database with no tables: state is ambiguous");
  }
  const v1 = rows.find((r) => r.version === 1);
  if (!v1) {
    throw new SchemaDriftError("schema_migrations has no version 1 row");
  }
  if (v1.checksum !== canonical.checksum) {
    throw new SchemaDriftError(
      `schema checksum drift: applied ${v1.checksum} != canonical ${canonical.checksum}`,
    );
  }
  return { applied: [], versions: rows.map((r) => ({ version: r.version, checksum: r.checksum })) };
}

export function verifySchema(db, canonical) {
  const rows = db
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all();
  if (rows.length !== 1 || rows[0].version !== 1) {
    return { ok: false, reason: `expected exactly migration version 1, found ${JSON.stringify(rows)}` };
  }
  if (rows[0].checksum !== canonical.checksum) {
    return { ok: false, reason: `checksum drift: ${rows[0].checksum} != ${canonical.checksum}` };
  }
  return { ok: true, reason: "schema_migrations version 1 matches canonical checksum" };
}
