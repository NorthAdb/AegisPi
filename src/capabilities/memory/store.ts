import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../../governance/canonical.ts";
import { withImmediateTx, writeAuditEvent } from "../../governance/db.ts";
import { checkSourceReadAuthorized } from "../../governance/policy.ts";
import { quarantinedReasons, scanMemoryText } from "../../governance/scanner.ts";

export interface MemoryNoteRow {
  note_id: string;
  principal_id: string;
  scope_id: string;
  domain: string;
  tier: "L0" | "L1" | "L2";
  title: string;
  body: string;
  version: number;
  content_digest: string;
  expires_at: number | null;
  deleted_at: number | null;
  quarantined: number;
  quarantine_reasons_json: string;
  created_at: number;
}

export interface UpsertMemoryNoteResult {
  note: MemoryNoteRow;
  quarantined: boolean;
  quarantineReasons: string[];
}

export function upsertMemoryNote(
  db: DatabaseSync,
  params: {
    noteId: string;
    principalId: string;
    scopeId: string;
    domain: string;
    tier: "L0" | "L1" | "L2";
    title: string;
    body: string;
    version?: number;
    expiresAt?: number | null;
    now: number;
  },
): UpsertMemoryNoteResult {
  const scanTitle = scanMemoryText(params.title, { label: "memory_title" });
  const scanBody = scanMemoryText(params.body, { label: "memory_body" });
  const reasons = [...new Set([...quarantinedReasons(scanTitle), ...quarantinedReasons(scanBody)])];
  const isQuarantined = reasons.length > 0;
  const contentDigest = sha256Hex(`${params.title}\n${params.body}`);
  const version = params.version ?? 1;

  return withImmediateTx(db, () => {
    db.prepare(
      `INSERT INTO memory_notes(
         note_id, principal_id, scope_id, domain, tier, title, body, version,
         content_digest, expires_at, deleted_at, quarantined, quarantine_reasons_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(note_id) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         version = excluded.version,
         content_digest = excluded.content_digest,
         expires_at = excluded.expires_at,
         deleted_at = NULL,
         quarantined = excluded.quarantined,
         quarantine_reasons_json = excluded.quarantine_reasons_json`,
    ).run(
      params.noteId,
      params.principalId,
      params.scopeId,
      params.domain,
      params.tier,
      params.title,
      params.body,
      version,
      contentDigest,
      params.expiresAt ?? null,
      isQuarantined ? 1 : 0,
      JSON.stringify(reasons),
      params.now,
    );

    db.prepare("DELETE FROM memory_notes_fts WHERE note_id = ?").run(params.noteId);
    // Quarantined notes NEVER enter FTS index (evidence stays preserved in memory_notes)
    if (!isQuarantined) {
      db.prepare("INSERT INTO memory_notes_fts(note_id, title, body) VALUES (?, ?, ?)").run(
        params.noteId,
        params.title,
        params.body,
      );
    }

    if (isQuarantined) {
      writeAuditEvent(db, {
        entityType: "memory_note",
        entityId: params.noteId,
        eventKey: `quarantine:${params.noteId}:v${version}`,
        eventType: "memory_note_quarantined",
        occurredAt: params.now,
        details: {
          principalId: params.principalId,
          scopeId: params.scopeId,
          reasons,
        },
      });
    }

    const row = db
      .prepare("SELECT * FROM memory_notes WHERE note_id = ?")
      .get(params.noteId) as unknown as MemoryNoteRow;
    return { note: row, quarantined: isQuarantined, quarantineReasons: reasons };
  });
}

export function addMemoryReference(
  db: DatabaseSync,
  params: { fromNoteId: string; toNoteId: string; relation?: string },
): void {
  withImmediateTx(db, () => {
    db.prepare(
      `INSERT OR IGNORE INTO memory_refs(from_note_id, to_note_id, relation)
       VALUES (?, ?, ?)`,
    ).run(params.fromNoteId, params.toNoteId, params.relation ?? "references");
  });
}

export function deleteMemoryNoteWithTombstone(
  db: DatabaseSync,
  params: { noteId: string; reason: string; now: number },
): void {
  withImmediateTx(db, () => {
    db.prepare("UPDATE memory_notes SET deleted_at = ? WHERE note_id = ?").run(params.now, params.noteId);
    db.prepare("DELETE FROM memory_notes_fts WHERE note_id = ?").run(params.noteId);
    db.prepare(
      `INSERT OR REPLACE INTO memory_tombstones(note_id, deleted_at, reason)
       VALUES (?, ?, ?)`,
    ).run(params.noteId, params.now, params.reason);
    writeAuditEvent(db, {
      entityType: "memory_note",
      entityId: params.noteId,
      eventKey: `tombstone:${params.noteId}:${params.now}`,
      eventType: "memory_note_tombstoned",
      occurredAt: params.now,
      details: { reason: params.reason },
    });
  });
}

function isNoteAccessible(
  db: DatabaseSync,
  note: MemoryNoteRow,
  params: { principalId: string; scopeId: string; now: number },
): boolean {
  if (note.principal_id !== params.principalId) return false;
  if (note.scope_id !== params.scopeId) return false;
  if (note.deleted_at !== null) return false;
  if (note.quarantined !== 0) return false;
  if (note.expires_at !== null && params.now >= note.expires_at) return false;
  const tomb = db.prepare("SELECT 1 AS t FROM memory_tombstones WHERE note_id = ?").get(note.note_id);
  if (tomb) return false;
  // Re-verify scanner defense-in-depth at read time
  if (!scanMemoryText(note.title).clean || !scanMemoryText(note.body).clean) return false;
  return true;
}

export interface FrozenL0Snapshot {
  domain: string;
  frozenAt: number;
  notes: Array<{ noteId: string; title: string; body: string; version: number; contentDigest: string }>;
  renderedText: string;
}

export function freezeDomainL0Snapshot(
  db: DatabaseSync,
  params: {
    principalId: string;
    scopeId: string;
    domain: string;
    now: number;
  },
): FrozenL0Snapshot {
  const auth = checkSourceReadAuthorized(db, {
    principalId: params.principalId,
    scopeId: params.scopeId,
    sourceType: "memory",
    resourceId: `memory:${params.domain}`,
    operation: "read",
  });
  if (!auth.ok) {
    return {
      domain: params.domain,
      frozenAt: params.now,
      notes: [],
      renderedText: "",
    };
  }

  const rows = db
    .prepare(
      `SELECT * FROM memory_notes
        WHERE principal_id = ?
          AND scope_id = ?
          AND domain = ?
          AND tier = 'L0'
          AND deleted_at IS NULL
          AND quarantined = 0
          AND (expires_at IS NULL OR expires_at > ?)
          AND note_id NOT IN (SELECT note_id FROM memory_tombstones)
        ORDER BY note_id ASC`,
    )
    .all(params.principalId, params.scopeId, params.domain, params.now) as unknown as MemoryNoteRow[];

  const cleanNotes = rows
    .filter((n) => isNoteAccessible(db, n, params))
    .map((n) => ({
      noteId: n.note_id,
      title: n.title,
      body: n.body,
      version: n.version,
      contentDigest: n.content_digest,
    }));

  const renderedText =
    cleanNotes.length === 0
      ? ""
      : cleanNotes.map((n) => `[L0:${n.noteId}@v${n.version}] ${n.title}: ${n.body}`).join("\n");

  return {
    domain: params.domain,
    frozenAt: params.now,
    notes: cleanNotes,
    renderedText,
  };
}

export interface RecalledMemoryItem {
  noteId: string;
  domain: string;
  tier: "L0" | "L1" | "L2";
  title: string;
  body: string;
  version: number;
  contentDigest: string;
  hop: number;
  parentNoteId: string | null;
}

export interface MemoryRecallResult {
  ok: boolean;
  code: string;
  reason?: string;
  items: RecalledMemoryItem[];
  filteredCounts: {
    principalOrScopeExcluded: number;
    expiredOrTombstonedExcluded: number;
    quarantinedExcluded: number;
  };
}

function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 10);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

/**
 * FTS5 + bounded 2-hop reference expansion recall.
 * Filters principal, scope ACL, expiry, tombstones, and 13-class scanner quarantine
 * strictly BEFORE FTS ranking AND on EVERY reference hop!
 */
export function recallMemory(
  db: DatabaseSync,
  params: {
    principalId: string;
    scopeId: string;
    domain?: string;
    query: string;
    maxHops?: number;
    limit?: number;
    now: number;
  },
): MemoryRecallResult {
  const resourceId = params.domain ? `memory:${params.domain}` : "memory:*";
  const auth = checkSourceReadAuthorized(db, {
    principalId: params.principalId,
    scopeId: params.scopeId,
    sourceType: "memory",
    resourceId,
    operation: "read",
  });
  if (!auth.ok) {
    return {
      ok: false,
      code: auth.code,
      reason: auth.reason,
      items: [],
      filteredCounts: {
        principalOrScopeExcluded: 0,
        expiredOrTombstonedExcluded: 0,
        quarantinedExcluded: 0,
      },
    };
  }

  const maxHops = Math.min(Math.max(params.maxHops ?? 2, 0), 2);
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
  const ftsQuery = sanitizeFtsQuery(params.query);

  // Pre-filter candidate notes by principal, scope, expiry, tombstone, and quarantine BEFORE ranking!
  let seedRows: MemoryNoteRow[] = [];
  if (ftsQuery.length > 0) {
    try {
      seedRows = db
        .prepare(
          `SELECT n.*
             FROM memory_notes n
             JOIN memory_notes_fts f ON f.note_id = n.note_id
            WHERE memory_notes_fts MATCH ?
              AND n.principal_id = ?
              AND n.scope_id = ?
              AND (? IS NULL OR n.domain = ?)
              AND n.deleted_at IS NULL
              AND n.quarantined = 0
              AND (n.expires_at IS NULL OR n.expires_at > ?)
              AND n.note_id NOT IN (SELECT note_id FROM memory_tombstones)
            ORDER BY bm25(memory_notes_fts) ASC
            LIMIT ?`,
        )
        .all(
          ftsQuery,
          params.principalId,
          params.scopeId,
          params.domain ?? null,
          params.domain ?? null,
          params.now,
          limit,
        ) as unknown as MemoryNoteRow[];
    } catch {
      seedRows = [];
    }
  }

  // Fallback substring match over strictly pre-filtered authorized notes (handles CJK queries cleanly when FTS unicode tokenizer splits phrases)
  if (seedRows.length === 0) {
    const allEligible = db
      .prepare(
        `SELECT * FROM memory_notes
          WHERE principal_id = ?
            AND scope_id = ?
            AND (? IS NULL OR domain = ?)
            AND deleted_at IS NULL
            AND quarantined = 0
            AND (expires_at IS NULL OR expires_at > ?)
            AND note_id NOT IN (SELECT note_id FROM memory_tombstones)
          ORDER BY created_at DESC`,
      )
      .all(
        params.principalId,
        params.scopeId,
        params.domain ?? null,
        params.domain ?? null,
        params.now,
      ) as unknown as MemoryNoteRow[];
    const qLower = params.query.toLowerCase();
    const terms = qLower.split(/[\s,，。？?！!]+/).filter((t) => t.length >= 2);
    seedRows = allEligible
      .filter((n) => {
        const hay = `${n.title} ${n.body}`.toLowerCase();
        if (terms.length === 0) return true;
        return terms.some((t) => hay.includes(t)) || hay.includes(qLower);
      })
      .slice(0, limit);
    if (seedRows.length === 0) {
      seedRows = allEligible.slice(0, limit);
    }
  }

  const visited = new Set<string>();
  const items: RecalledMemoryItem[] = [];
  const filteredCounts = {
    principalOrScopeExcluded: 0,
    expiredOrTombstonedExcluded: 0,
    quarantinedExcluded: 0,
  };

  let frontier: Array<{ note: MemoryNoteRow; hop: number; parentId: string | null }> = [];
  for (const r of seedRows) {
    if (!isNoteAccessible(db, r, params)) continue;
    visited.add(r.note_id);
    frontier.push({ note: r, hop: 0, parentId: null });
    items.push({
      noteId: r.note_id,
      domain: r.domain,
      tier: r.tier,
      title: r.title,
      body: r.body,
      version: r.version,
      contentDigest: r.content_digest,
      hop: 0,
      parentNoteId: null,
    });
  }

  // Hop-by-hop reference expansion with strict per-hop ACL/expiry/tombstone/scanner filter
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const nextFrontier: Array<{ note: MemoryNoteRow; hop: number; parentId: string | null }> = [];
    for (const cur of frontier) {
      const refs = db
        .prepare("SELECT to_note_id FROM memory_refs WHERE from_note_id = ?")
        .all(cur.note.note_id) as Array<{ to_note_id: string }>;
      for (const ref of refs) {
        if (visited.has(ref.to_note_id)) continue;
        const target = db
          .prepare("SELECT * FROM memory_notes WHERE note_id = ?")
          .get(ref.to_note_id) as MemoryNoteRow | undefined;
        if (!target) {
          filteredCounts.expiredOrTombstonedExcluded++;
          continue;
        }
        if (target.principal_id !== params.principalId || target.scope_id !== params.scopeId) {
          filteredCounts.principalOrScopeExcluded++;
          continue;
        }
        if (target.quarantined !== 0 || !scanMemoryText(target.title).clean || !scanMemoryText(target.body).clean) {
          filteredCounts.quarantinedExcluded++;
          continue;
        }
        const tomb = db.prepare("SELECT 1 AS t FROM memory_tombstones WHERE note_id = ?").get(target.note_id);
        if (target.deleted_at !== null || tomb || (target.expires_at !== null && params.now >= target.expires_at)) {
          filteredCounts.expiredOrTombstonedExcluded++;
          continue;
        }
        visited.add(target.note_id);
        items.push({
          noteId: target.note_id,
          domain: target.domain,
          tier: target.tier,
          title: target.title,
          body: target.body,
          version: target.version,
          contentDigest: target.content_digest,
          hop,
          parentNoteId: cur.note.note_id,
        });
        nextFrontier.push({ note: target, hop, parentId: cur.note.note_id });
      }
    }
    frontier = nextFrontier;
  }

  return { ok: true, code: "ok", items, filteredCounts };
}
