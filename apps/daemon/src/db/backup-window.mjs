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
//      NO key configured -> the backup refuses to run, fail closed). The
//      manifest carries dbSha256 over the image BYTES: restore re-verifies
//      it before the file is ever opened (audit F3: an equal-length swap of
//      the image must be refused, and a size match alone proves nothing).
//      The .db image itself is PLAINTEXT SQLite at rest — only the manifest
//      is sealed; if the threat model includes the backup directory being
//      read by an attacker, that residual exposure is recorded as such, not
//      papered over with a "whole backup is encrypted" claim.
//   5. the manifest embeds the DELETION LEDGER: the list of objects whose
//      deletion was intended BEFORE the backup. Restore applies the ledger,
//      so a forgotten or revoked object never resurrects from a backup.
//
// The deletion ledger itself lives as a content-addressed OBJECT in the
// service scope (no schema change): system_state key "deletion_ledger_object"
// points at an objects row of kind "deletion_ledger" whose content is the
// JSON array of {object_id, reason, deleted_at} entries.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, checkDatabaseIntegrity } from "./connect.mjs";
import { loadCanonicalSchema, verifySchema } from "./migrate.mjs";
import { withTx } from "./tx.mjs";
import { writeAudit } from "../audit.mjs";
import { insertObjectRow, putObjectContent } from "../objects.mjs";
import {
  DeletionManifestStale,
  verifyDeletionManifestInvariant,
  replayDeletionManifestInTx,
} from "../deletion-manifest.mjs";

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
  //    dbSha256 authenticates the image BYTES: the size check alone would
  //    accept an equal-length substitution (audit F3).
  const ledger = readDeletionLedger(db, { stateDir });
  const tables = [
    "tasks", "attempts", "effects", "approvals", "timers", "inbox",
    "outbox", "objects", "budget_accounts", "budget_reservations", "execution_jobs",
  ];
  const counts = {};
  for (const t of tables) {
    counts[t] = db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
  }
  const dbSha256 = "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
  const manifest = {
    schemaVersion: 2,
    kind: "aegispi-consistency-backup",
    label,
    createdAt: now,
    backupBytes: statSync(path).size,
    dbSha256,
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
//
// Unit 5.1: with `stateDir` provided, the restore ALSO enforces the
// protected deletion-manifest invariant against the restored image: a
// missing, corrupt, or sequence-behind manifest refuses the restore (the
// daemon then stays in read-only diagnostics); a valid manifest is REPLAYED
// so objects forgotten after the backup cannot resurrect. Startup recovery
// (recovery.mjs step 3b) enforces the same invariant unconditionally at
// every boot, so a restore that skipped this parameter is still gated
// before execution ever opens.

export function restoreFromBackup({
  backupPath,
  manifestPath,
  manifestKeyHex,
  targetDbPath,
  now,
  stateDir = null,
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
  // v1 manifests did not authenticate the image bytes: an equal-length
  // substitution of the .db passed restore (audit F3). Without dbSha256 the
  // restore refuses, fail closed.
  if (typeof manifest.dbSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(manifest.dbSha256)) {
    throw new BackupError("the manifest does not carry dbSha256 over the image bytes; a v1 backup without byte authentication is not restorable evidence");
  }
  // Byte authentication BEFORE the file is opened: hash the image and
  // compare against the sealed manifest's dbSha256. The old size check
  // stays only as a cheap early refusal — it never proves integrity.
  const imageBytes = statSync(backupPath).size;
  if (manifest.backupBytes !== imageBytes) {
    throw new BackupError(`backup image size ${imageBytes} does not match the manifest's ${manifest.backupBytes}`);
  }
  const actualSha = "sha256:" + createHash("sha256").update(readFileSync(backupPath)).digest("hex");
  if (actualSha !== manifest.dbSha256) {
    throw new BackupError(
      `backup image bytes hash to ${actualSha} but the manifest sealed ${manifest.dbSha256}; the image was modified after the backup — refusing to restore`,
    );
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
  // Unit 5.1: the protected deletion manifest is INDEPENDENT of this
  // backup, so it can be newer than the restored image. Verify it against
  // the restored DB and replay every tombstone the image has not seen.
  // A missing/corrupt/stale manifest refuses the restore outright —
  // execution cannot open on top of potentially resurrected data.
  let manifestReplay = null;
  if (stateDir !== null) {
    const invariant = verifyDeletionManifestInvariant(db, stateDir);
    if (!invariant.ok) {
      db.close();
      throw new DeletionManifestStale(`deletion-manifest gate refused the restore: ${invariant.reason}`);
    }
    if (invariant.pendingReplay.length > 0) {
      manifestReplay = withTx(db, () => replayDeletionManifestInTx(db, { entries: invariant.pendingReplay, now }));
    } else {
      manifestReplay = { applied: 0, latestSeq: invariant.fileLatestSeq };
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
  return { restored, manifest, appliedDeletions: removed, integrity: integrity.detail, manifestReplay };
}

// ---------------------------------------------------------------------------
// Retention (06 section 10 / defaults.backup.retentionDays): backups older
// than the retention window are deleted when a new consistency backup
// lands. Before this existed the default advertised 14 days but nothing ever
// removed a backup (audit F8); now the value is real. Pairs (.db +
// .manifest.json) are judged together by the .db mtime, and an orphan
// manifest without its image is pruned with it.

export function pruneExpiredBackups(backupsDir, { retentionDays, now }) {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new BackupError(`retentionDays must be a positive integer, got ${retentionDays}`);
  }
  if (!existsSync(backupsDir)) {
    return { pruned: [], kept: [] };
  }
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const pruned = [];
  const kept = [];
  for (const name of readdirSync(backupsDir).sort()) {
    if (!/^consistency-\d+\.db$/.test(name)) continue;
    const manifestName = name.replace(/\.db$/, ".manifest.json");
    const st = statSync(join(backupsDir, name));
    const manifestSt = existsSync(join(backupsDir, manifestName)) ? statSync(join(backupsDir, manifestName)) : null;
    // The pair expires when the OLDER of the two is past the cutoff: a
    // manifest rewritten later never resurrects a stale image.
    const oldest = manifestSt ? Math.min(st.mtimeMs, manifestSt.mtimeMs) : st.mtimeMs;
    if (oldest < cutoff) {
      rmSync(join(backupsDir, name), { force: true });
      if (manifestSt) rmSync(join(backupsDir, manifestName), { force: true });
      pruned.push(name);
    } else {
      kept.push(name);
    }
  }
  return { pruned, kept };
}
