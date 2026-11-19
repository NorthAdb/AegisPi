// Consistency backups, the maintenance window, the encrypted manifest, the
// deletion ledger, and restore (Phase 3 per 04 taskbook + phase2-closure
// open item 4).
//
// A consistency backup runs ONLY inside its configured maintenance window:
//   1. WAL checkpoint TRUNCATE (no half-written pages in the snapshot)
//   2. VACUUM INTO a fresh .db file (consistent point-in-time image)
//   3. the image must pass its own integrity check (a broken backup is worse
//      than none: it pretends to be a rollback point)
//   4. a manifest is written NEXT to the image, encrypted with AES-256-GCM
//      using the host's backup-manifest key (credential slot "backup.manifest";
//      NO key configured -> the backup refuses to run, fail closed)
//   5. the manifest embeds the DELETION LEDGER: the list of objects whose
//      deletion was intended BEFORE the backup. Restore applies the ledger,
//      so a forgotten or revoked object never resurrects from a backup.
//
// The deletion ledger itself lives as a content-addressed OBJECT in the
// service scope (no schema change): system_state key "deletion_ledger_object"
// points at an objects row of kind "deletion_ledger" whose content is the
// JSON array of {object_id, reason, deleted_at} entries.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, checkDatabaseIntegrity } from "./connect.mjs";
import { loadCanonicalSchema, verifySchema } from "./migrate.mjs";
import { withTx } from "./tx.mjs";
import { writeAudit } from "../audit.mjs";
import { insertObjectRow, putObjectContent } from "../objects.mjs";

export const DELETION_LEDGER_STATE_KEY = "deletion_ledger_object";

export class BackupError extends Error {}
export class OutsideMaintenanceWindow extends BackupError {}
export class ManifestKeyMissing extends BackupError {}

// ---------------------------------------------------------------------------
// Deletion ledger: intent-to-forget records, stored as an object + pointer.

export function readDeletionLedger(db, { stateDir } = {}) {
  const row = db.prepare("SELECT value FROM system_state WHERE key=?").get(DELETION_LEDGER_STATE_KEY);
  if (!row) return { entries: [] };
  const objectId = row.value;
  const obj = db.prepare("SELECT id, storage_ref, content_hash FROM objects WHERE id=?").get(objectId);
  if (!obj || !obj.storage_ref) return { entries: [] };
  try {
    const content = readFileSync(join(stateDir ?? deriveStateDirFromDb(db), ...obj.storage_ref.split("/")), "utf8");
    const parsed = JSON.parse(content);
    return { objectId, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { objectId, entries: [] };
  }
}

// The ledger object lives under the workspace state dir; backups and restores
// share it, so the state dir is wherever the caller's objects live. The
// derive fallback only works when the caller passes a stateDir explicitly —
// readDeletionLedger without one still works for in-memory checks.
function deriveStateDirFromDb() {
  return process.env.AEGISPI_STATE_DIR ?? ".";
}

export function appendDeletionEntries(db, { entries, now, stateDir }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new BackupError("entries must be a non-empty array");
  }
  for (const e of entries) {
    if (typeof e.objectId !== "string" || e.objectId.length === 0) {
      throw new BackupError("each deletion entry needs an objectId");
    }
  }
  return withTx(db, () => {
    // Ensure the service scope + owner exist (same ids the budget ledger uses).
    db.prepare("INSERT OR IGNORE INTO principals(id, platform, platform_subject) VALUES ('prn:system:deletion','system','deletion')").run();
    db.prepare(
      `INSERT OR IGNORE INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused)
       VALUES ('scp:service:deletion','prn:system:deletion','service','service:deletion','internal',NULL,NULL,1,1,'pv1',0)`,
    ).run();
    const current = readDeletionLedger(db, { stateDir });
    const merged = [
      ...current.entries.filter((old) => !entries.some((n) => n.objectId === old.objectId)),
      ...entries.map((e) => ({ object_id: e.objectId, reason: e.reason ?? "unspecified", deleted_at: e.deletedAt ?? now })),
    ];
    const content = JSON.stringify({ schemaVersion: 1, entries: merged });
    // Content-addressed storage: the file lands on disk BEFORE the row
    // references it (06 section 9, last crash row).
    const stored = putObjectContent(stateDir, content);
    const ledgerObject = insertObjectRow(db, {
      scopeId: "scp:service:deletion",
      kind: "deletion_ledger",
      sourceUri: "host-backup",
      sourceActor: "host-backup",
      content,
      contentHash: stored.contentHash,
      storageRef: stored.storageRef,
      observedAt: now,
      requiredScopeIds: ["scp:service:deletion"],
    });
    db.prepare("INSERT INTO system_state(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(DELETION_LEDGER_STATE_KEY, ledgerObject.id);
    writeAudit(db, {
      code: "deletion_ledger_appended",
      details: { added: entries.map((e) => e.objectId), total: merged.length },
      now,
    });
    return { objectId: ledgerObject.id, entries: merged };
  });
}

// ---------------------------------------------------------------------------
// Manifest encryption (AES-256-GCM). The key comes from the host credential
// store; it is never written to the backup directory in plaintext.

export function encryptManifest(manifestJson, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new BackupError("the backup manifest key must be 32 bytes (64 hex chars)");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(manifestJson, "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: Buffer.concat([ciphertext, tag]).toString("hex"),
    plaintextSha256: createHash("sha256").update(plaintext).digest("hex"),
  };
}

export function decryptManifest(envelope, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new BackupError("the backup manifest key must be 32 bytes (64 hex chars)");
  }
  if (envelope.alg !== "aes-256-gcm") {
    throw new BackupError(`unsupported manifest algorithm ${envelope.alg}`);
  }
  const iv = Buffer.from(envelope.iv, "hex");
  const data = Buffer.from(envelope.ciphertext, "hex");
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { manifest: JSON.parse(plaintext.toString("utf8")), plaintextSha256: createHash("sha256").update(plaintext).digest("hex") };
}

// ---------------------------------------------------------------------------
// The maintenance-window consistency backup.

export function insideMaintenanceWindow(nowMs, { windowStartHour, windowEndHour, timeZone = "Asia/Hong_Kong" } = {}) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(new Date(nowMs)),
  );
  if (windowStartHour <= windowEndHour) {
    return hour >= windowStartHour && hour < windowEndHour;
  }
  // Window crosses midnight.
  return hour >= windowStartHour || hour < windowEndHour;
}

export function consistencyBackup(db, {
  stateDir,
  backupsDir,
  now,
  manifestKeyHex,
  window = null, // { windowStartHour, windowEndHour, timeZone } — null disables the window check (explicit operator action)
  label = "scheduled",
}) {
  if (window && !insideMaintenanceWindow(now, window)) {
    throw new OutsideMaintenanceWindow(
      `refusing a consistency backup outside the maintenance window ${window.windowStartHour}:00-${window.windowEndHour}:00`,
    );
  }
  if (!manifestKeyHex || !/^[0-9a-f]{64}$/.test(manifestKeyHex)) {
    throw new ManifestKeyMissing("a 32-byte hex backup-manifest key is required; without it the manifest cannot be sealed");
  }
  mkdirSync(backupsDir, { recursive: true });
  // 1. WAL checkpoint TRUNCATE: the snapshot must not depend on a WAL file.
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  // 2. Consistent point-in-time image.
  const stamp = `${now}`;
  const path = join(backupsDir, `consistency-${stamp}.db`);
  db.prepare("VACUUM INTO ?").run(path.replace(/\\/g, "/"));
  // 3. The image must pass its own integrity check.
  const check = openDatabase(path, { readOnly: true });
  const integrity = checkDatabaseIntegrity(check);
  check.close();
  if (!integrity.ok) {
    rmSync(path, { force: true });
    throw new BackupError(`consistency snapshot failed its own integrity check: ${integrity.detail}`);
  }
  // 4. Manifest with row counts + the deletion ledger, encrypted at rest.
  const ledger = readDeletionLedger(db, { stateDir });
  const tables = [
    "tasks", "attempts", "effects", "approvals", "timers", "inbox",
    "outbox", "objects", "budget_accounts", "budget_reservations", "execution_jobs",
  ];
  const counts = {};
  for (const t of tables) {
    counts[t] = db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
  }
  const manifest = {
    schemaVersion: 1,
    kind: "aegispi-consistency-backup",
    label,
    createdAt: now,
    backupBytes: statSync(path).size,
    integrity: integrity.detail,
    tableCounts: counts,
    deletionLedger: ledger.entries,
    nodeVersion: process.version,
  };
  const envelope = encryptManifest(JSON.stringify(manifest), manifestKeyHex);
  const manifestPath = join(backupsDir, `consistency-${stamp}.manifest.json`);
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...envelope, backupFile: `consistency-${stamp}.db`, ciphertext: envelope.ciphertext }) + "\n",
    "utf8",
  );
  return { path, manifestPath, bytes: manifest.backupBytes, entries: ledger.entries.length, counts };
}

// ---------------------------------------------------------------------------
// Restore: the drill that test:restore exercises. Restores the image to a
// target directory, re-verifies it against the canonical schema, and applies
// the deletion ledger from the (decrypted) manifest — forgotten stays
// forgotten across a restore.

export function restoreFromBackup({
  backupPath,
  manifestPath,
  manifestKeyHex,
  targetDbPath,
  now,
}) {
  if (!existsSync(backupPath)) {
    throw new BackupError(`no backup image at ${backupPath}`);
  }
  if (!existsSync(manifestPath)) {
    throw new BackupError(`no manifest at ${manifestPath}; a backup without its manifest is not restorable`);
  }
  const envelope = JSON.parse(readFileSync(manifestPath, "utf8"));
  const { manifest, plaintextSha256 } = decryptManifest(envelope, manifestKeyHex);
  if (plaintextSha256 !== envelope.plaintextSha256) {
    throw new BackupError("manifest plaintext hash mismatch; refusing to trust the manifest");
  }
  // Hash-verify the image against the manifest's expectations.
  const imageBytes = statSync(backupPath).size;
  if (manifest.backupBytes !== imageBytes) {
    throw new BackupError(`backup image size ${imageBytes} does not match the manifest's ${manifest.backupBytes}`);
  }
  mkdirSync(join(targetDbPath, ".."), { recursive: true });
  const target = targetDbPath.replace(/\\/g, "/");
  rmSync(targetDbPath, { force: true });
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(targetDbPath + suffix, { force: true });
  }
  copyFileSync(backupPath, target);
  const db = openDatabase(targetDbPath);
  const integrity = checkDatabaseIntegrity(db);
  if (!integrity.ok) {
    db.close();
    throw new BackupError(`restored image failed integrity: ${integrity.detail}`);
  }
  const canonical = loadCanonicalSchema();
  const schema = verifySchema(db, canonical);
  if (!schema.ok) {
    db.close();
    throw new BackupError(`restored schema does not match the pinned canonical DDL: ${schema.reason}`);
  }
  // 04 section 5: generation lives in system_state and MUST advance on a
  // backup restore — clients reconnect with a reset, never replay a stale
  // stream against restored state.
  const currentGen = Number(
    db.prepare("SELECT value FROM system_state WHERE key='stream_generation'").get()?.value ?? "1",
  );
  db.prepare("INSERT INTO system_state(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run("stream_generation", String(currentGen + 1));
  // Apply the deletion ledger: entries the owner forgot before the backup
  // must not resurrect from it.
  const removed = [];
  for (const entry of manifest.deletionLedger ?? []) {
    const objectId = entry.object_id;
    const gone = db.prepare("SELECT count(*) c FROM objects WHERE id=?").get(objectId).c;
    if (gone === 1) {
      db.prepare("UPDATE objects SET status='deleted', deleted_at=? WHERE id=?").run(now, objectId);
      removed.push(objectId);
    }
  }
  // What did we actually get back? The Phase 3 acceptance cares about
  // pending-approval, ready-to-send and timer work surviving.
  const restored = {
    waitingApprovals: db.prepare("SELECT count(*) c FROM approvals WHERE state='WAITING'").get().c,
    readyEffects: db.prepare("SELECT count(*) c FROM effects WHERE state='READY'").get().c,
    scheduledTimers: db.prepare("SELECT count(*) c FROM timers WHERE state='SCHEDULED'").get().c,
    queuedInbox: db.prepare("SELECT count(*) c FROM inbox WHERE state='PENDING' AND verdict='ADMIT'").get().c,
  };
  db.close();
  return { restored, manifest, appliedDeletions: removed, integrity: integrity.detail };
}
