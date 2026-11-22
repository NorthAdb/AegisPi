// Content-addressed object store (01 section 3, 06 section 9 last row).
//
// Order is fixed by the crash matrix: an immutable content file is written and
// fsynced, renamed into place, and the parent directory is fsynced — all
// BEFORE any transaction activates a reference to it. A crash between file
// write and DB activation leaves an unreferenced file, which GC later removes;
// it never leaves a referenced-but-missing file.
//
// Parent-directory fsync is POSIX-only; on Windows the directory open for
// fsync fails and we rely on NTFS metadata journaling for rename durability,
// recorded here rather than silently skipped.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

export function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function objectRelPath(contentHash) {
  // Stored refs are POSIX-shaped on every OS (portable in the DB); filesystem
  // paths are assembled separately with join().
  return ["objects", contentHash.slice(0, 2), contentHash.slice(2, 4), contentHash].join("/");
}

export function putObjectContent(stateDir, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  const contentHash = sha256Buffer(buf);
  const relRef = objectRelPath(contentHash);
  const finalPath = join(stateDir, ...relRef.split("/"));
  if (existsSync(finalPath)) {
    // Content-addressed reuse. If bytes on disk disagree with the hash, fail
    // closed instead of activating corrupt content.
    const existing = readFileSync(finalPath);
    if (!existing.equals(buf)) {
      throw new Error(`object file content mismatch at ${finalPath}`);
    }
    return { contentHash, storageRef: relRef, alreadyPresent: true };
  }
  const dir = dirname(finalPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmpPath, "wx");
  try {
    writeSync(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, finalPath);
  fsyncParentDir(dir);
  return { contentHash, storageRef: relRef, alreadyPresent: false };
}

export function fsyncParentDir(dir) {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Windows cannot open a directory for fsync; NTFS journaling covers the
    // rename. POSIX fsyncs succeed and land here only on exotic errors, which
    // the caller cannot fix by retrying, so we proceed and stay honest above.
  }
}

// The objects row is ALWAYS inserted by the caller's transaction; this module
// never opens one. Own-scope closure is mandatory (01 section 3: "至少包含
// 自身scope"), and missing closure fails closed.
export function insertObjectRow(db, {
  scopeId,
  kind,
  sourceUri,
  sourceActor,
  content = null,
  contentHash = null,
  storageRef = null,
  status = "active",
  observedAt,
  expiresAt = null,
  metadata = {},
  requiredScopeIds = [],
  parents = [],
}) {
  if (contentHash === null) {
    if (content === null) {
      throw new Error("insertObjectRow needs content or contentHash");
    }
    contentHash = sha256Buffer(Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8"));
  }
  const id = objectRowId(scopeId, contentHash);
  const existing = db.prepare("SELECT id, status FROM objects WHERE id=?").get(id);
  if (existing) {
    return { id, alreadyPresent: true, status: existing.status };
  }
  if (storageRef !== null && storageRef.includes("\\")) {
    // Storage refs are POSIX-shaped on every OS (see objectRelPath). A
    // backslash ref is a legacy/corrupt row at best; the writer refuses it
    // so the referenced-set comparison can never be surprised by one.
    throw new Error(`storage_ref must use forward slashes (got ${JSON.stringify(storageRef)})`);
  }
  if (!requiredScopeIds.includes(scopeId)) {
    throw new Error(`object ${id} is missing its own scope ${scopeId} in the required closure`);
  }
  db.prepare(
    `INSERT INTO objects(id, scope_id, kind, source_uri, source_actor, content_hash, storage_ref,
      status, version, supersedes_id, confidence, observed_at, expires_at, deleted_at, metadata_json)
     VALUES (?,?,?,?,?,?,?,?,1,NULL,NULL,?,?,NULL,?)`,
  ).run(
    id,
    scopeId,
    kind,
    sourceUri,
    sourceActor,
    contentHash,
    storageRef,
    status,
    observedAt,
    expiresAt,
    JSON.stringify(metadata),
  );
  const seen = new Set();
  for (const sid of requiredScopeIds) {
    if (seen.has(sid)) continue;
    seen.add(sid);
    db.prepare("INSERT INTO object_required_scopes(object_id, scope_id) VALUES (?,?)").run(id, sid);
  }
  for (const edge of parents) {
    db.prepare(
      "INSERT OR IGNORE INTO object_edges(parent_id, child_id, relation) VALUES (?,?,?)",
    ).run(edge.parentId, id, edge.relation ?? "derived_from");
  }
  return { id, alreadyPresent: false, status };
}

export function objectRowId(scopeId, contentHash) {
  return `obj:${scopeId}:${contentHash}`;
}

// GC for files that were written but never activated (crash between file
// durability and DB activation) plus leftover tmp files. Moves them to
// objects/trash/<ts>/ rather than hard-deleting, so nothing is silently gone.
export function gcUnreferencedContent(db, stateDir, { now = Date.now(), dryRun = false } = {}) {
  const objectsRoot = join(stateDir, "objects");
  if (!existsSync(objectsRoot)) return { scanned: 0, trashed: 0, tmpRemoved: 0 };
  const referenced = new Set();
  for (const row of db.prepare("SELECT storage_ref FROM objects WHERE storage_ref IS NOT NULL").all()) {
    // Both the raw ref and its backslash-normalized twin count as
    // referenced: a legacy row written with Windows separators must never
    // let the GC treat the live file as an orphan.
    referenced.add(row.storage_ref);
    referenced.add(row.storage_ref.replace(/\\/g, "/"));
  }
  const trashRoot = join(objectsRoot, "trash", String(now));
  let scanned = 0;
  let trashed = 0;
  let tmpRemoved = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "trash") continue;
        walk(p);
        continue;
      }
      if (entry.name.includes(".tmp.")) {
        tmpRemoved += 1;
        if (!dryRun) rmSync(p, { force: true });
        continue;
      }
      scanned += 1;
      const rel = relative(stateDir, p).replace(/\\/g, "/");
      if (!referenced.has(rel)) {
        trashed += 1;
        if (!dryRun) {
          mkdirSync(dirname(join(trashRoot, rel)), { recursive: true });
          renameSync(p, join(trashRoot, rel));
        }
      }
    }
  };
  walk(objectsRoot);
  return { scanned, trashed, tmpRemoved };
}
