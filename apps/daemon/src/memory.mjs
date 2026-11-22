// Layered memory core (Unit 5.1; spec 01 sections 3–6, 06 section 9).
//
// L0: per-scope immutable export (MEMORY.md, and USER.md ONLY inside an
//     owner_dm scope — a global USER.md readable by every session is the
//     exact leak class 01 forbids). Files land crash-safely (tmp+fsync+
//     rename+dir fsync) BEFORE the DB activates the referencing object
//     rows (06 section 9). A run freezes the exported prefix hash at
//     session start: ordinary fact updates are visible NEXT run; revoke
//     or an authorization_revision bump kills the stale session first.
// L1: bounded reference-graph expansion along object_edges; EVERY hop
//     re-verifies the caller's live read grants on the target object's
//     full required-scope closure before it can appear in the result.
// L2: the locked dual-FTS recall (recall.mjs — the pack-pinned query)
//     plus the bounded short-term LIKE fallback for sub-3-char terms.
// Candidates: model-extracted facts only ever land as status='candidate'.
//     Identity/recipient/payment/approval-exemption/permission claims are
//     REFUSED outright; mutually exclusive values under one factKey keep
//     BOTH versions as 'conflicted' — never last-text-wins.
// Forgetting: phase 1 marks the object and its derived closure deleted in
//     one transaction (FTS index rows dropped with them); the tombstone
//     manifest is appended BEFORE that transaction so a crash anywhere
//     leaves the file ahead of the DB, which replay repairs — never the
//     reverse. Phase 2 physically removes the content and export files.

import { mkdirSync, existsSync, unlinkSync, readFileSync, writeFileSync, openSync, closeSync, renameSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";

import { withTx } from "./db/tx.mjs";
import { putObjectContent, insertObjectRow, fsyncParentDir } from "./objects.mjs";
import { writeAudit, writeStreamEvent, authorizationRevision } from "./audit.mjs";
import { hasReadGrant } from "./acl.mjs";
import { recall, recallShortTerm } from "./recall.mjs";
import { scanMemoryText, quarantinedReasons } from "./memory-scanner.mjs";
import {
  appendDeletionManifest,
  setDeletionSeqInTx,
  removeTombstonedContentFile,
} from "./deletion-manifest.mjs";
import { canonicalJson, sha256LfHex, sha256Hex } from "./keys.mjs";

export class MemoryError extends Error {}
export class MemoryFactForbidden extends MemoryError {}
export class MemoryConflict extends MemoryError {}
export class MemoryL0Quarantined extends MemoryError {}
export class SessionStale extends MemoryError {}
export class SummaryTooLarge extends MemoryError {}
export class ForgetTooLarge extends MemoryError {}

const FACT_KIND = "memory_fact";
const L0_MEMORY_KIND = "l0_memory";
const L0_USER_KIND = "l0_user";
const L0_FREEZE_KIND = "l0_freeze";
const SUMMARY_KIND = "summary";
const MAX_FORGET_CASCADE_OBJECTS = 512;
const MAX_FACT_CHARS = 4000;
// Facts whose activation is refused forever (01 section 4.1: never
// auto-activated into an authorization-relevant L0).
const NEVER_ACTIVATABLE_CATEGORIES = ["identity", "recipient", "payment", "approval_exemption", "permission"];
// Deterministic refusal of write-time policy-capture claims (acceptance
// 5.1-3: a candidate that tries to rewrite the approval regime or the
// recipient whitelist never becomes a row at all). The refusal tier is
// narrower than the scanner's quarantine tier on purpose: an exemption
// CLAIM alone is quarantined evidence (01 section 4.2), while an exemption
// claim joined to an execution/change imperative is a capture attempt and
// is refused before insert.
const FORBIDDEN_FACT_TEXT_RE =
  /(?:免审批|跳过审批|绕过审批|审批豁免|无需审批|自动批准|auto[- ]?approv\w*|approval\s*(?:exemption|bypass|not required|skip)|(?:no|without)\s+approval)[^\n]{0,80}(?:直接|立即|执行|发送|写入|外发|放行|run|execute|send|write|proceed|allow)/i;
const FORBIDDEN_FACT_TEXT_RE_2 =
  /(?:收件人|白名单|recipient|allowedRecipients|whitelist)[^\n]{0,80}(?:加入|加上|添加|改为|换成|移除|add|change|set|update|remove)[^\n]{0,40}/i;
const FORBIDDEN_FACT_TEXT_RE_3 =
  /(?:权限|授权|角色|scope|permission|acl|admin|role|grant)[^\n]{0,60}(?:提升|变更|修改|设为|授予|elevate|change|set|grant|promote)/i;

// Windows-safe directory name for one scope's L0 exports (the scope id
// itself contains ':' which is not a legal filename character on win32).
export function scopeDirName(scopeId) {
  const sanitized = String(scopeId).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  const body = sanitized.length > 0 ? sanitized.slice(0, 48) : "scope";
  return `${body}-${sha256Hex(scopeId).slice(0, 8)}`;
}

// Deterministic token ESTIMATE (not a provider tokenizer): CJK code points
// count one each, everything else counts per whitespace-delimited word.
// Used only as a host-side bound so summaries cannot silently exceed the
// configured purpose='summary' budget; the honest number is the model
// request's own maxOutputTokens gate.
export function estimateTokens(text) {
  let cjk = 0;
  let words = 0;
  let inWord = false;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3000 && code <= 0x303f)) {
      cjk += 1;
      inWord = false;
    } else if (/\s/.test(ch)) {
      inWord = false;
    } else if (!inWord) {
      words += 1;
      inWord = true;
    }
  }
  return cjk + words;
}

// ---- L0 ----------------------------------------------------------------

function activeFactsInScope(db, { scopeId, now }) {
  return db
    .prepare(
      `SELECT id, content_hash, storage_ref, metadata_json, observed_at, expires_at FROM objects
       WHERE scope_id=? AND kind=? AND status='active' AND deleted_at IS NULL
       ORDER BY observed_at ASC, id ASC`,
    )
    .all(scopeId, FACT_KIND)
    .filter((row) => row.expires_at === null || row.expires_at > now)
    .map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json || "{}") }));
}

function renderFactList(facts, { maxChars, header }) {
  const lines = [header];
  let used = header.length;
  let omitted = 0;
  for (const fact of facts) {
    if (quarantinedReasons({ hits: fact.metadata.quarantined_reasons ?? [] }).length > 0) continue;
    const line = `- ${fact.metadata.factKey ?? "fact"}: ${String(fact.metadata.factValue ?? "")}`;
    if (used + line.length + 1 > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) {
    lines.push(`- … ${omitted} further fact(s) omitted from this bounded export (query the object store)`);
  }
  return { text: lines.join("\n") + "\n", omitted };
}

/**
 * Render the current L0 export for a scope. USER.md is produced ONLY for
 * owner_dm scopes — the render refuses to produce a global USER profile.
 */
export function renderL0(db, { scopeId, now, memoryMaxChars = 2200, userMaxChars = 1375 }) {
  const scope = db.prepare("SELECT id, kind FROM scopes WHERE id=?").get(scopeId);
  if (!scope) throw new MemoryError(`scope ${scopeId} does not exist`);
  const facts = activeFactsInScope(db, { scopeId, now });
  const memory = renderFactList(facts, { maxChars: memoryMaxChars, header: "# MEMORY (scope-bounded export)" });
  let user = null;
  if (scope.kind === "owner_dm") {
    const userFacts = facts.filter((f) => f.metadata.category === "user_preference");
    user = renderFactList(userFacts, { maxChars: userMaxChars, header: "# USER preferences (owner_dm only)" });
  }
  return {
    memoryText: memory.text,
    userText: user === null ? null : user.text,
    factCount: facts.length,
    omitted: memory.omitted + (user?.omitted ?? 0),
  };
}

function atomicWriteExport(stateDir, relPath, text) {
  const path = join(stateDir, ...relPath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncParentDir(dirname(path));
  return path;
}

/**
 * Export the L0 snapshot for a scope: crash-safe files first, then ONE
 * transaction activating the `l0_memory` / `l0_user` object rows with
 * derived_from edges back to every contributing fact (so forgetting a
 * fact cascades onto the export that quoted it). Re-exporting creates a
 * NEW export object; the previous one stays as history until forgotten.
 */
export function exportL0Snapshot(db, stateDir, { scopeId, now, actorId = "host", memoryMaxChars = 2200, userMaxChars = 1375 }) {
  const scope = db.prepare("SELECT id, kind FROM scopes WHERE id=?").get(scopeId);
  if (!scope) throw new MemoryError(`scope ${scopeId} does not exist`);
  const rendered = renderL0(db, { scopeId, now, memoryMaxChars, userMaxChars });

  const scanMemory = scanMemoryText(rendered.memoryText, { capacityChars: memoryMaxChars * 2, label: "L0 MEMORY export" });
  if (!scanMemory.clean) {
    throw new MemoryL0Quarantined(
      `refusing to export L0 MEMORY for ${scopeId}: quarantined classes ${quarantinedReasons(scanMemory).join(",")}`,
    );
  }
  let scanUser = null;
  if (rendered.userText !== null) {
    scanUser = scanMemoryText(rendered.userText, { capacityChars: userMaxChars * 2, label: "L0 USER export" });
    if (!scanUser.clean) {
      throw new MemoryL0Quarantined(
        `refusing to export L0 USER for ${scopeId}: quarantined classes ${quarantinedReasons(scanUser).join(",")}`,
      );
    }
  }

  const dir = scopeDirName(scopeId);
  const facts = activeFactsInScope(db, { scopeId, now });
  const parentIds = facts.map((f) => f.id);
  const memoryRelPath = `scopes/${dir}/MEMORY.md`;
  atomicWriteExport(stateDir, memoryRelPath, rendered.memoryText);
  const storedMemory = putObjectContent(stateDir, rendered.memoryText);
  let storedUser = null;
  let userRelPath = null;
  if (rendered.userText !== null) {
    userRelPath = `scopes/${dir}/USER.md`;
    atomicWriteExport(stateDir, userRelPath, rendered.userText);
    storedUser = putObjectContent(stateDir, rendered.userText);
  }

  const result = withTx(db, () => {
    const memoryRow = insertObjectRow(db, {
      scopeId,
      kind: L0_MEMORY_KIND,
      sourceUri: `l0-export:${scopeId}`,
      sourceActor: actorId,
      content: rendered.memoryText,
      contentHash: storedMemory.contentHash,
      storageRef: storedMemory.storageRef,
      status: "active",
      observedAt: now,
      metadata: { scopeKind: scope.kind, exportPath: memoryRelPath, factCount: rendered.factCount },
      requiredScopeIds: [scopeId],
      parents: parentIds.map((id) => ({ parentId: id })),
    });
    let userRow = null;
    if (storedUser !== null) {
      const userFacts = facts.filter((f) => f.metadata.category === "user_preference").map((f) => f.id);
      userRow = insertObjectRow(db, {
        scopeId,
        kind: L0_USER_KIND,
        sourceUri: `l0-export:${scopeId}:user`,
        sourceActor: actorId,
        content: rendered.userText,
        contentHash: storedUser.contentHash,
        storageRef: storedUser.storageRef,
        status: "active",
        observedAt: now,
        metadata: { scopeKind: scope.kind, exportPath: userRelPath },
        requiredScopeIds: [scopeId],
        parents: (userFacts.length > 0 ? userFacts : parentIds.length > 0 ? parentIds : []).map((id) => ({ parentId: id })),
      });
    }
    writeAudit(db, {
      code: "l0_exported",
      actorId,
      details: { scope_id: scopeId, memory_object_id: memoryRow.id, user_object_id: userRow?.id ?? null, fact_count: rendered.factCount },
      now,
    });
    writeStreamEvent(db, {
      scopeId,
      eventType: "memory_changed",
      entityId: `object:${memoryRow.id}`,
      entityVersion: 1,
      payload: { kind: L0_MEMORY_KIND },
      now,
    });
    return { memoryRow, userRow };
  });

  return {
    scopeId,
    dir,
    memoryText: rendered.memoryText,
    userText: rendered.userText,
    memoryObjectId: result.memoryRow.id,
    userObjectId: result.userRow?.id ?? null,
    factCount: rendered.factCount,
  };
}

/**
 * Open a session context for a run: freezes the L0 prefix (the exact
 * MEMORY/USER texts this run will see) into an `l0_freeze` object and
 * records the CURRENT authorization_revision on the session row. Any later
 * revision bump (revoke!) makes the session stale and the caller must
 * rebuild a clean one — "please ignore" prompts are not a mechanism.
 */
export function openScopeSession(db, stateDir, { sessionId, scopeId, principalId, skillSetHash, now, memoryMaxChars = 2200, userMaxChars = 1375 }) {
  const scope = db.prepare("SELECT id, kind FROM scopes WHERE id=?").get(scopeId);
  if (!scope) throw new MemoryError(`scope ${scopeId} does not exist`);
  const rendered = renderL0(db, { scopeId, now, memoryMaxChars, userMaxChars });
  const freezeContent = canonicalJson({
    scopeId,
    memoryText: rendered.memoryText,
    userText: rendered.userText,
    skillSetHash,
    authorizationRevision: authorizationRevision(db),
    frozenAt: now,
  });
  const stored = putObjectContent(stateDir, freezeContent);
  return withTx(db, () => {
    const freezeRow = insertObjectRow(db, {
      scopeId,
      kind: L0_FREEZE_KIND,
      sourceUri: `l0-freeze:${scopeId}:${now}`,
      sourceActor: principalId,
      content: freezeContent,
      contentHash: stored.contentHash,
      storageRef: stored.storageRef,
      status: "active",
      observedAt: now,
      metadata: { scopeId, skillSetHash, l0PrefixHash: sha256LfHex(rendered.memoryText) },
      requiredScopeIds: [scopeId],
    });
    db.prepare(
      `INSERT INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at)
       VALUES (?,?,?,NULL,?,?,?,?,?)`,
    ).run(sessionId, scopeId, principalId, freezeRow.id, authorizationRevision(db), skillSetHash, freezeRow.id, now);
    writeAudit(db, {
      code: "session_opened",
      actorId: principalId,
      details: { session_id: sessionId, scope_id: scopeId, l0_prefix_hash: sha256LfHex(rendered.memoryText) },
      now,
    });
    return {
      sessionId,
      freezeObjectId: freezeRow.id,
      l0PrefixHash: sha256LfHex(rendered.memoryText),
      userPrefixHash: rendered.userText === null ? null : sha256LfHex(rendered.userText),
      authorizationRevision: authorizationRevision(db),
    };
  });
}

/**
 * CP2 freshness gate: a session whose recorded authorization_revision is
 * behind the current one MUST be abandoned before the next model request
 * or tool call, and the caller rebuilds with a clean session.
 */
export function assertSessionFresh(db, { sessionId }) {
  const session = db.prepare("SELECT id, scope_id, authorization_revision FROM sessions WHERE id=?").get(sessionId);
  if (!session) throw new SessionStale(`session ${sessionId} does not exist`);
  const current = authorizationRevision(db);
  if (session.authorization_revision !== current) {
    return {
      fresh: false,
      sessionId,
      scopeId: session.scope_id,
      sessionRevision: session.authorization_revision,
      currentRevision: current,
    };
  }
  return { fresh: true, sessionId, scopeId: session.scope_id, currentRevision: current };
}

/** Read a session's frozen L0 prefix (the texts the run was promised). */
export function frozenL0(db, stateDir, { sessionId }) {
  const session = db
    .prepare("SELECT id, scope_id, context_object_id FROM sessions WHERE id=?")
    .get(sessionId);
  if (!session || !session.context_object_id) throw new MemoryError(`session ${sessionId} has no frozen L0 context`);
  const freeze = db
    .prepare("SELECT content_hash, storage_ref, metadata_json FROM objects WHERE id=?")
    .get(session.context_object_id);
  if (!freeze) throw new MemoryError(`freeze object ${session.context_object_id} is missing`);
  if (typeof freeze.storage_ref !== "string" || freeze.storage_ref.includes("\\") || freeze.storage_ref.includes("..")) {
    throw new MemoryError(`freeze object ${session.context_object_id} has an invalid storage ref`);
  }
  const path = join(stateDir, ...freeze.storage_ref.split("/"));
  if (!existsSync(path)) throw new MemoryError(`freeze object ${session.context_object_id} content is missing`);
  const content = JSON.parse(readFileSync(path, "utf8"));
  return { sessionId, scopeId: session.scope_id, freeze: content };
}

// ---- L1 ----------------------------------------------------------------

/**
 * Bounded reference-graph expansion (01 section 4 L1). Every hop verifies
 * the caller's LIVE read grants on the target object's full
 * object_required_scopes closure; objects that fail the check are simply
 * not returned (they might as well not exist for this caller).
 */
export function expandObjectGraph(db, { rootObjectIds, principalId, now, maxHops = 2, maxObjects = 16 }) {
  if (!Array.isArray(rootObjectIds) || rootObjectIds.length === 0) return { objects: [], skipped: 0, truncated: false };
  const canRead = (objectId) => {
    const required = db.prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=?").all(objectId);
    if (required.length === 0) return false; // no own-scope closure: refuse (defense in depth)
    return required.every((r) => hasReadGrant(db, { scopeId: r.scope_id, principalId, now }));
  };
  const objects = [];
  const seen = new Set();
  let queue = rootObjectIds.map((id) => ({ id, hop: 0 }));
  let skipped = 0;
  let truncated = false;
  while (queue.length > 0) {
    const next = [];
    for (const node of queue) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const row = db
        .prepare("SELECT id, scope_id, kind, content_hash, status, deleted_at, expires_at FROM objects WHERE id=?")
        .get(node.id);
      if (!row || row.status !== "active" || row.deleted_at !== null) continue;
      if (row.expires_at !== null && row.expires_at <= now) continue;
      if (!canRead(node.id)) {
        skipped += 1;
        continue;
      }
      if (objects.length >= maxObjects) {
        truncated = true;
        continue;
      }
      objects.push({ objectId: row.id, scopeId: row.scope_id, kind: row.kind, contentHash: row.content_hash, hop: node.hop });
      if (node.hop < maxHops) {
        const children = db.prepare("SELECT child_id FROM object_edges WHERE parent_id=?").all(node.id);
        for (const c of children) next.push({ id: c.child_id, hop: node.hop + 1 });
      }
    }
    queue = next;
  }
  return { objects, skipped, truncated };
}

// ---- L2 ----------------------------------------------------------------

/** The locked dual-FTS recall plus the sub-3-char bounded LIKE fallback. */
export function recallScopedMemories(db, { scopeId, principalId, currentSessionId, now, query }) {
  const term = String(query ?? "").trim();
  if (term.length > 0 && Array.from(term).length < 3) {
    return recallShortTerm(db, { scopeId, principalId, currentSessionId, nowMs: now, term });
  }
  return recall(db, { scopeId, principalId, currentSessionId, nowMs: now, query: term });
}

// ---- candidates, conflicts, summaries ----------------------------------

function factRowByFactKey(db, { scopeId, factKey }) {
  const rows = db
    .prepare(
      `SELECT id, status, content_hash, metadata_json FROM objects
       WHERE scope_id=? AND kind=? AND status IN ('candidate','active','conflicted')`,
    )
    .all(scopeId, FACT_KIND);
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata_json || "{}");
    if (metadata.factKey === factKey) return { ...row, metadata };
  }
  return null;
}

/**
 * Model-extracted fact proposal (01 section 4.1). Three deterministic
 * gates run BEFORE any row is written:
 *   1. Forbidden capture claims (approval exemption, recipient-whitelist
 *      edits, permission/scope elevation, identity substitution) are
 *      REFUSED — no row, audited refusal.
 *   2. The 13-class scanner quarantines injection carriers: the row is
 *      still stored (evidence is not destroyed) but carries
 *      quarantined_reasons and can never activate.
 *   3. Identity/recipient/payment/approval_exemption/permission
 *      categories are stored as candidates that can NEVER be activated.
 * A conflicting value under the same factKey flips BOTH versions to
 * 'conflicted' — never last-text-wins.
 */
export function proposeMemoryFact(db, stateDir, {
  scopeId, factKey, factText, category = null, confidence = null, expiresAt = null,
  sourceUri, sourceActor, parentObjectIds = [], now, actorId = "host",
  autoActivate = false,
}) {
  if (typeof factKey !== "string" || factKey.trim().length === 0 || factKey.length > 128) {
    throw new MemoryError("factKey must be a non-empty string of at most 128 chars");
  }
  if (typeof factText !== "string" || factText.length === 0 || factText.length > 65536) {
    throw new MemoryError(`factText must be 1..65536 chars (a hard input bound; texts over the fact capacity are quarantined, not rejected)`);
  }
  if (!db.prepare("SELECT id FROM scopes WHERE id=?").get(scopeId)) {
    throw new MemoryError(`scope ${scopeId} does not exist`);
  }
  const text = factText.trim();
  if (FORBIDDEN_FACT_TEXT_RE.test(text) || FORBIDDEN_FACT_TEXT_RE_2.test(text) || FORBIDDEN_FACT_TEXT_RE_3.test(text)) {
    writeAudit(db, {
      code: "memory_fact_refused",
      actorId,
      details: { scope_id: scopeId, fact_key: factKey, reason: "policy-capture claim refused before insert" },
      now,
    });
    throw new MemoryFactForbidden(
      `fact '${factKey}' asserts an approval exemption, recipient-whitelist change, permission elevation or identity capture; the memory interface refuses it before insert`,
    );
  }
  const scan = scanMemoryText(text, { capacityChars: MAX_FACT_CHARS, label: `fact ${factKey}` });
  const quarantined = quarantinedReasons(scan);
  const neverActivatable = NEVER_ACTIVATABLE_CATEGORIES.includes(category);

  const stored = putObjectContent(stateDir, text);
  return withTx(db, () => {
    const existing = factRowByFactKey(db, { scopeId, factKey });
    if (existing && existing.content_hash === stored.contentHash) {
      writeAudit(db, {
        code: "memory_fact_confirmed",
        actorId,
        details: { scope_id: scopeId, fact_key: factKey, object_id: existing.id },
        now,
      });
      return { objectId: existing.id, status: existing.status, duplicate: true, quarantined, conflicted: false };
    }
    let status = "candidate";
    let conflicted = false;
    if (existing && existing.content_hash !== stored.contentHash) {
      // Mutually exclusive values under one factKey: BOTH survive as
      // conflicted versions for the owner to adjudicate.
      if (existing.status === "active" || existing.status === "candidate") {
        db.prepare("UPDATE objects SET status='conflicted' WHERE id=? AND status IN ('active','candidate')").run(existing.id);
      }
      status = "conflicted";
      conflicted = true;
      writeAudit(db, {
        code: "memory_fact_conflicted",
        actorId,
        details: { scope_id: scopeId, fact_key: factKey, existing_object_id: existing.id },
        now,
      });
    }
    const row = insertObjectRow(db, {
      scopeId,
      kind: FACT_KIND,
      sourceUri,
      sourceActor,
      content: text,
      contentHash: stored.contentHash,
      storageRef: stored.storageRef,
      status,
      observedAt: now,
      expiresAt,
      metadata: {
        factKey,
        factValue: text,
        category: category ?? null,
        confidence: typeof confidence === "number" ? confidence : null,
        quarantined_reasons: quarantined,
        never_activatable: neverActivatable || quarantined.length > 0,
        confirmations: 0,
      },
      requiredScopeIds: [scopeId],
      parents: parentObjectIds.map((id) => ({ parentId: id })),
    });
    if (existing && conflicted) {
      db.prepare("UPDATE objects SET supersedes_id=? WHERE id=?").run(existing.id, row.id);
    }
    writeAudit(db, {
      code: "memory_fact_proposed",
      actorId,
      details: { scope_id: scopeId, fact_key: factKey, object_id: row.id, status, quarantined: quarantined.length > 0 },
      now,
    });
    writeStreamEvent(db, {
      scopeId,
      eventType: "memory_changed",
      entityId: `object:${row.id}`,
      entityVersion: 1,
      payload: { status, quarantined: quarantined.length > 0 },
      now,
    });
    let activated = false;
    if (status === "candidate" && autoActivate === true && quarantined.length === 0 && !neverActivatable) {
      const flipped = db.prepare("UPDATE objects SET status='active' WHERE id=? AND status='candidate'").run(row.id).changes;
      activated = flipped === 1;
      if (activated) {
        writeAudit(db, { code: "memory_fact_auto_activated", actorId, details: { object_id: row.id }, now });
      }
    }
    return { objectId: row.id, status: activated ? "active" : status, duplicate: false, quarantined, conflicted, activated };
  });
}

/**
 * Human/host-only activation. Quarantined and never-activatable
 * categories are refused regardless of who asks — activation is a
 * governed decision, not a privileged string.
 */
export function activateMemoryFact(db, { objectId, actorId = "host", now }) {
  return withTx(db, () => {
    const row = db.prepare("SELECT id, scope_id, status, metadata_json FROM objects WHERE id=?").get(objectId);
    if (!row) throw new MemoryError(`object ${objectId} does not exist`);
    const metadata = JSON.parse(row.metadata_json || "{}");
    const quarantined = quarantinedReasons({ hits: metadata.quarantined_reasons ?? [] });
    if (quarantined.length > 0) {
      writeAudit(db, { code: "memory_activation_refused", actorId, details: { object_id: objectId, reason: "quarantined", classes: quarantined }, now });
      throw new MemoryError(`object ${objectId} is quarantined (${quarantined.join(",")}); human review owns the next step`);
    }
    if (metadata.never_activatable === true || NEVER_ACTIVATABLE_CATEGORIES.includes(metadata.category)) {
      writeAudit(db, { code: "memory_activation_refused", actorId, details: { object_id: objectId, reason: "never-activatable category" }, now });
      throw new MemoryError(`object ${objectId} belongs to a never-activatable category; it can never become authorization-relevant L0`);
    }
    const changes = db.prepare("UPDATE objects SET status='active' WHERE id=? AND status='candidate'").run(objectId).changes;
    if (changes !== 1) {
      throw new MemoryError(`object ${objectId} is not an activatable candidate (current state refuses)`);
    }
    writeAudit(db, { code: "memory_fact_activated", actorId, details: { object_id: objectId, scope_id: row.scope_id }, now });
    writeStreamEvent(db, {
      scopeId: row.scope_id,
      eventType: "memory_changed",
      entityId: `object:${objectId}`,
      entityVersion: 2,
      payload: { status: "active" },
      now,
    });
    return { objectId, status: "active" };
  });
}

/**
 * Register the bounded purpose='summary' derivation. The summary text is
 * scanned, token-estimated against the summary budget, and stored with the
 * UNION closure of all parent sources' required scopes plus the caller's
 * own scope — a summary of two private scopes requires BOTH to read:
 * summarizing never de-classifies.
 */
export function writeSummaryDerivation(db, stateDir, {
  scopeId, parentObjectIds, summaryText, now, actorId = "host", summaryMaxOutputTokens = 500,
}) {
  if (typeof summaryText !== "string" || summaryText.trim().length === 0) {
    throw new MemoryError("summaryText must be a non-empty string");
  }
  if (!Array.isArray(parentObjectIds) || parentObjectIds.length === 0) {
    throw new MemoryError("a summary must cite at least one parent source object");
  }
  const tokens = estimateTokens(summaryText);
  if (tokens > summaryMaxOutputTokens) {
    throw new SummaryTooLarge(
      `summary estimates at ${tokens} tokens over the ${summaryMaxOutputTokens}-token bound; return references instead of hard-truncating a conclusion`,
    );
  }
  const scan = scanMemoryText(summaryText, { capacityChars: MAX_FACT_CHARS * 2, label: "summary text" });
  const quarantined = quarantinedReasons(scan);
  const stored = putObjectContent(stateDir, summaryText);
  return withTx(db, () => {
    const closure = new Set([scopeId]);
    for (const parentId of parentObjectIds) {
      const parent = db.prepare("SELECT id, scope_id FROM objects WHERE id=?").get(parentId);
      if (!parent) throw new MemoryError(`parent source ${parentId} does not exist`);
      for (const r of db.prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=?").all(parentId)) {
        closure.add(r.scope_id);
      }
    }
    const row = insertObjectRow(db, {
      scopeId,
      kind: SUMMARY_KIND,
      sourceUri: `summary:${scopeId}:${now}`,
      sourceActor: actorId,
      content: summaryText,
      contentHash: stored.contentHash,
      storageRef: stored.storageRef,
      status: quarantined.length > 0 ? "candidate" : "active",
      observedAt: now,
      metadata: { parent_object_ids: parentObjectIds, quarantined_reasons: quarantined, estimated_tokens: tokens },
      requiredScopeIds: [...closure],
      parents: parentObjectIds.map((id) => ({ parentId: id })),
    });
    writeAudit(db, {
      code: "summary_derived",
      actorId,
      details: { scope_id: scopeId, object_id: row.id, required_scope_count: closure.size, quarantined: quarantined.length > 0 },
      now,
    });
    return { objectId: row.id, status: quarantined.length > 0 ? "candidate" : "active", requiredScopeIds: [...closure], quarantined, estimatedTokens: tokens };
  });
}

// ---- two-phase forget ---------------------------------------------------

/**
 * Two-phase forget (01 section 4.1). Phase 1: the tombstone manifest is
 * appended FIRST (a crash then leaves the file ahead of the DB, which
 * replay repairs — never the reverse), then ONE transaction marks the
 * object and its derived closure deleted and drops the FTS index rows.
 * Phase 2 physically removes content files and the affected L0 export
 * files. Shared derivatives are withdrawn too and recorded as needing
 * regeneration — a derivative quoting a forgotten source must not keep
 * serving it.
 */
export function forgetObject(db, stateDir, { objectId, now, actorId = "host" }) {
  const root = db
    .prepare("SELECT id, scope_id, kind, content_hash, storage_ref, status, metadata_json FROM objects WHERE id=?")
    .get(objectId);
  if (!root) throw new MemoryError(`object ${objectId} does not exist`);
  if (root.status === "deleted") return { objectId, alreadyDeleted: true, forgotten: 0 };

  // Collect the derived closure first (read-only walk).
  const closure = new Map();
  const queue = [objectId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (closure.has(id)) continue;
    const row = db
      .prepare("SELECT id, scope_id, kind, content_hash, storage_ref, status, metadata_json FROM objects WHERE id=?")
      .get(id);
    if (!row) continue;
    closure.set(id, row);
    if (closure.size > MAX_FORGET_CASCADE_OBJECTS) {
      throw new ForgetTooLarge(`forget cascade exceeds ${MAX_FORGET_CASCADE_OBJECTS} objects; refusing instead of walking unbounded`);
    }
    for (const child of db.prepare("SELECT child_id FROM object_edges WHERE parent_id=?").all(id)) {
      queue.push(child.child_id);
    }
  }
  const ids = [...closure.keys()];
  const shared = [];
  for (const id of ids) {
    if (id === objectId) continue;
    const parents = db.prepare("SELECT parent_id FROM object_edges WHERE child_id=?").all(id).map((p) => p.parent_id);
    if (parents.some((p) => !closure.has(p))) shared.push(id);
  }
  const tombstones = ids.map((id) => {
    const row = closure.get(id);
    return { objectId: id, contentHash: row.content_hash, scopeId: row.scope_id, deletedAt: now };
  });

  // FILE FIRST: the manifest append happens before the DB flip so the
  // invariant "file >= DB" holds across every crash window.
  const appended = appendDeletionManifest(stateDir, tombstones, { now });

  const affectedExportFiles = [];
  for (const id of ids) {
    const row = closure.get(id);
    if (row.kind === L0_MEMORY_KIND || row.kind === L0_USER_KIND || row.kind === L0_FREEZE_KIND) {
      const metadata = JSON.parse(row.metadata_json || "{}");
      if (typeof metadata.exportPath === "string") affectedExportFiles.push(metadata.exportPath);
    }
  }

  withTx(db, () => {
    for (const id of ids) {
      db.prepare("UPDATE objects SET status='deleted', deleted_at=? WHERE id=? AND status != 'deleted'").run(now, id);
      db.prepare("DELETE FROM session_messages_index WHERE object_id=?").run(id);
    }
    setDeletionSeqInTx(db, { latestSeq: appended.latestSeq, now });
    writeAudit(db, {
      code: "memory_forgotten",
      actorId,
      details: {
        root_object_id: objectId,
        objects: ids.length,
        shared_derivatives_needing_regen: shared.length,
        manifest_latest_seq: appended.latestSeq,
      },
      now,
    });
    if (shared.length > 0) {
      writeStreamEvent(db, {
        scopeId: root.scope_id,
        eventType: "audit_alert",
        entityId: `forget:${objectId}`,
        entityVersion: 1,
        payload: { shared_derivatives: shared.length, reason: "shared derivatives withdrawn; regeneration required" },
        now,
      });
    }
  });

  // Phase 2: physical cleanup after the commit.
  let filesRemoved = 0;
  for (const id of ids) {
    const row = closure.get(id);
    if (row.storage_ref) {
      const res = removeTombstonedContentFile(stateDir, { storageRef: row.storage_ref });
      if (res.removed) filesRemoved += 1;
    }
  }
  let exportFilesRemoved = 0;
  for (const relPath of affectedExportFiles) {
    const path = join(stateDir, ...relPath.split("/"));
    if (existsSync(path)) {
      unlinkSync(path);
      exportFilesRemoved += 1;
    }
  }
  return {
    objectId,
    forgotten: ids.length,
    shared: shared.length,
    manifestLatestSeq: appended.latestSeq,
    filesRemoved,
    exportFilesRemoved,
  };
}
