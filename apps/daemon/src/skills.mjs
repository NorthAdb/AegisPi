// Three-level skill disclosure (Unit 5.1; spec 03 section 7.3, 01 section 6).
//
// Level 1: name + short index (no body). Level 2: the SKILL body, only
// after a live read-grant check on the body object's required scopes.
// Level 3: the reviewed script HASH only — script text is never handed to
// the model; scripts are code, promoted by human review, never by a
// description claiming to be one.
//
// A task locks its skill_set_hash at CREATION (tasks.skill_set_hash) and a
// running task never hot-swaps: activating a new version retires the old
// ACTIVE row and changes the set hash, which only NEW tasks pick up.

import { withTx } from "./db/tx.mjs";
import { putObjectContent, insertObjectRow } from "./objects.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { hasReadGrant } from "./acl.mjs";
import { scanMemoryText, quarantinedReasons } from "./memory-scanner.mjs";
import { sha256LfHex, canonicalJson } from "./keys.mjs";

export class SkillError extends Error {}

const SKILL_BODY_KIND = "skill_body";
const SKILL_SCRIPT_KIND = "skill_script";
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_BODY_CHARS = 200_000;

function requireSkillRow(db, { name, scopeId, version = null }) {
  const row =
    version === null
      ? db.prepare("SELECT * FROM skill_versions WHERE name=? AND scope_id=? AND state='ACTIVE'").get(name, scopeId)
      : db.prepare("SELECT * FROM skill_versions WHERE name=? AND scope_id=? AND version=?").get(name, scopeId, version);
  if (!row) {
    throw new SkillError(`skill ${name} (scope ${scopeId}${version === null ? ", active" : `, v${version}`}) does not exist`);
  }
  return row;
}

/**
 * Register a skill version as CANDIDATE. The description and body both run
 * the 13-class scanner first — a poisoned description never becomes an
 * index line (01 section 4.2 names skill descriptions as scan targets).
 */
export function registerSkillVersion(db, stateDir, {
  name, scopeId, version, description, bodyText, scriptText = null, now, actorId = "host",
}) {
  if (!SKILL_NAME_RE.test(String(name ?? ""))) {
    throw new SkillError(`skill name must match ${SKILL_NAME_RE}`);
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new SkillError("skill version must be a positive integer");
  }
  if (typeof description !== "string" || description.length === 0 || description.length > MAX_DESCRIPTION_CHARS) {
    throw new SkillError(`skill description must be 1..${MAX_DESCRIPTION_CHARS} chars`);
  }
  if (typeof bodyText !== "string" || bodyText.length === 0 || bodyText.length > MAX_BODY_CHARS) {
    throw new SkillError(`skill body must be 1..${MAX_BODY_CHARS} chars`);
  }
  if (!db.prepare("SELECT id FROM scopes WHERE id=?").get(scopeId)) {
    throw new SkillError(`scope ${scopeId} does not exist`);
  }
  const descScan = scanMemoryText(description, { capacityChars: MAX_DESCRIPTION_CHARS, label: "skill description" });
  if (!descScan.clean) {
    throw new SkillError(`skill description hits injection classes ${quarantinedReasons(descScan).join(",")}; refusing registration`);
  }
  const bodyScan = scanMemoryText(bodyText, { capacityChars: MAX_BODY_CHARS, label: "skill body" });
  if (!bodyScan.clean) {
    throw new SkillError(`skill body hits injection classes ${quarantinedReasons(bodyScan).join(",")}; refusing registration`);
  }
  const storedBody = putObjectContent(stateDir, bodyText);
  let scriptHash = null;
  let storedScript = null;
  if (scriptText !== null) {
    if (typeof scriptText !== "string" || scriptText.length === 0 || scriptText.length > MAX_BODY_CHARS) {
      throw new SkillError("skill script must be a non-empty bounded string");
    }
    scriptHash = sha256LfHex(scriptText);
    storedScript = putObjectContent(stateDir, scriptText);
  }
  return withTx(db, () => {
    const existing = db
      .prepare("SELECT version FROM skill_versions WHERE name=? AND scope_id=? AND version=?")
      .get(name, scopeId, version);
    if (existing) throw new SkillError(`skill ${name} v${version} already exists in ${scopeId}`);
    const bodyRow = insertObjectRow(db, {
      scopeId,
      kind: SKILL_BODY_KIND,
      sourceUri: `skill:${name}:${version}`,
      sourceActor: actorId,
      content: bodyText,
      contentHash: storedBody.contentHash,
      storageRef: storedBody.storageRef,
      status: "active",
      observedAt: now,
      metadata: { name, version, description },
      requiredScopeIds: [scopeId],
    });
    let scriptObjectId = null;
    if (storedScript !== null) {
      const scriptRow = insertObjectRow(db, {
        scopeId,
        kind: SKILL_SCRIPT_KIND,
        sourceUri: `skill:${name}:${version}:script`,
        sourceActor: actorId,
        content: scriptText,
        contentHash: storedScript.contentHash,
        storageRef: storedScript.storageRef,
        status: "active",
        observedAt: now,
        metadata: { name, version, script_hash: scriptHash, human_review_pending: true },
        requiredScopeIds: [scopeId],
        parents: [{ parentId: bodyRow.id }],
      });
      scriptObjectId = scriptRow.id;
    }
    db.prepare(
      `INSERT INTO skill_versions(name, version, scope_id, object_id, content_hash, supersedes_version, update_id, state)
       VALUES (?,?,?,?,?,NULL,NULL,'CANDIDATE')`,
    ).run(name, version, scopeId, bodyRow.id, storedBody.contentHash);
    writeAudit(db, {
      code: "skill_version_registered",
      actorId,
      details: { name, version, scope_id: scopeId, object_id: bodyRow.id, script_object_id: scriptObjectId },
      now,
    });
    return { name, version, scopeId, state: "CANDIDATE", bodyObjectId: bodyRow.id, scriptObjectId, scriptHash };
  });
}

/**
 * Human-promoted activation (03 section 7.3: first-version promotion is
 * always human). The previous ACTIVE version retires in the SAME
 * transaction; running tasks keep their frozen skill_set_hash — only new
 * tasks see the new set.
 */
export function activateSkillVersion(db, { name, scopeId, version, reviewedBy, now, actorId = "host" }) {
  return withTx(db, () => {
    const target = requireSkillRow(db, { name, scopeId, version });
    if (target.state !== "CANDIDATE") {
      throw new SkillError(`skill ${name} v${version} is ${target.state}, not a promotable CANDIDATE`);
    }
    const retired = db
      .prepare("UPDATE skill_versions SET state='RETIRED' WHERE name=? AND scope_id=? AND state='ACTIVE' AND version != ?")
      .run(name, scopeId, version).changes;
    const changes = db
      .prepare("UPDATE skill_versions SET state='ACTIVE' WHERE name=? AND scope_id=? AND version=? AND state='CANDIDATE'")
      .run(name, scopeId, version).changes;
    if (changes !== 1) throw new SkillError(`skill ${name} v${version} could not be activated`);
    writeAudit(db, {
      code: "skill_version_activated",
      actorId,
      details: { name, version, scope_id: scopeId, reviewed_by: reviewedBy, retired_versions: retired },
      now,
    });
    return { name, version, scopeId, state: "ACTIVE", retiredVersions: retired };
  });
}

/** The frozen-at-creation set hash: hash over the sorted ACTIVE versions. */
export function currentSkillSetHash(db, { scopeId }) {
  const rows = db
    .prepare("SELECT name, version, content_hash FROM skill_versions WHERE scope_id=? AND state='ACTIVE' ORDER BY name ASC")
    .all(scopeId);
  return sha256LfHex(
    canonicalJson(rows.map((r) => ({ name: r.name, version: r.version, content_hash: r.content_hash }))),
  );
}

/** Level 1: the short index — names, versions, descriptions. No bodies. */
export function describeSkillIndex(db, { scopeId }) {
  return db
    .prepare("SELECT name, version, state, object_id FROM skill_versions WHERE scope_id=? ORDER BY name ASC, version ASC")
    .all(scopeId)
    .map((row) => {
      const obj = db.prepare("SELECT metadata_json FROM objects WHERE id=?").get(row.object_id);
      const metadata = JSON.parse(obj?.metadata_json || "{}");
      return {
        name: row.name,
        version: row.version,
        state: row.state,
        description: typeof metadata.description === "string" ? metadata.description : "",
      };
    });
}

/** Level 2: the body, behind a live read-grant check on every required scope. */
export function readSkillBody(db, stateDir, { name, scopeId, principalId, now, version = null }) {
  const row = requireSkillRow(db, { name, scopeId, version });
  const body = db
    .prepare("SELECT id, content_hash, storage_ref, metadata_json FROM objects WHERE id=?")
    .get(row.object_id);
  if (!body) throw new SkillError(`skill body object ${row.object_id} is missing`);
  const required = db.prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=?").all(body.id);
  if (required.length === 0 || !required.every((r) => hasReadGrant(db, { scopeId: r.scope_id, principalId, now }))) {
    return { denied: true, reason: "no live read grant on every required scope of the skill body" };
  }
  return {
    denied: false,
    name,
    version: row.version,
    contentHash: body.content_hash,
    metadata: JSON.parse(body.metadata_json || "{}"),
    // The caller reads the content through the ACL-gated object file; this
    // function deliberately returns the REFERENCE, not the text inline.
    storageRef: body.storage_ref,
  };
}

/** Level 3: the reviewed script hash. Script TEXT is never returned. */
export function lockedScriptRef(db, { name, scopeId, version = null }) {
  const row = requireSkillRow(db, { name, scopeId, version });
  const body = db.prepare("SELECT metadata_json FROM objects WHERE id=?").get(row.object_id);
  const metadata = JSON.parse(body?.metadata_json || "{}");
  const script = db
    .prepare("SELECT id, metadata_json FROM objects WHERE kind=? AND scope_id=? ORDER BY observed_at DESC")
    .all(SKILL_SCRIPT_KIND, scopeId)
    .find((o) => {
      const m = JSON.parse(o.metadata_json || "{}");
      return m.name === name && m.version === row.version;
    });
  if (!script) {
    return { denied: true, reason: `skill ${name} has no registered script` };
  }
  const m = JSON.parse(script.metadata_json || "{}");
  return {
    denied: false,
    name,
    version: row.version,
    scriptObjectId: script.id,
    scriptHash: m.script_hash ?? null,
    humanReviewed: m.human_review_pending !== true,
  };
}
