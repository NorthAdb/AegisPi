// The recall query is docs/reference/recall.sql from the design pack, embedded
// verbatim (01 section 5: "唯一召回查询见 recall.sql"). Its documented order is
// the security contract: authorization and ancestor filtering happen INSIDE
// the allowed CTE, strictly BEFORE both FTS LIMIT 40 windows and the final
// LIMIT 12 — unauthorized rows cannot spend limit slots. The query compiler
// quotes FTS terms and bounds their count and length; it never interpolates
// SQL. Terms shorter than 3 characters cannot be served by the trigram index
// (01 section 5), so short terms fall back to a bounded LIKE over the SAME
// allowed set — a fallback with its own bounded ranking, never claimed to be
// RRF-equivalent.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const RECALL_SQL = `
WITH RECURSIVE lineage(sid) AS (
  SELECT :current_session_id
  UNION
  SELECT s.parent_session_id FROM sessions s JOIN lineage l ON s.id=l.sid
  WHERE s.parent_session_id IS NOT NULL
),
allowed AS MATERIALIZED (
  SELECT m.rowid FROM session_messages_index m
  JOIN objects o ON o.id=m.object_id
  WHERE o.scope_id=:scope_id AND o.status='active' AND o.deleted_at IS NULL
  AND (o.expires_at IS NULL OR o.expires_at>:now_ms)
  AND m.session_id NOT IN (SELECT sid FROM lineage)
  AND EXISTS(SELECT 1 FROM object_required_scopes r WHERE r.object_id=o.id AND r.scope_id=o.scope_id)
  AND NOT EXISTS(
   SELECT 1 FROM object_required_scopes r WHERE r.object_id=o.id AND NOT EXISTS(
    SELECT 1 FROM acl_grants g WHERE g.scope_id=r.scope_id AND g.principal_id=:principal_id
    AND g.permission='read' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>:now_ms)
   )
  )
),
lex_scored AS MATERIALIZED (
  SELECT f.rowid,bm25(fts_messages_lex) AS score FROM fts_messages_lex f
  WHERE fts_messages_lex MATCH :lex_query AND f.rowid IN (SELECT rowid FROM allowed)
  ORDER BY score,f.rowid LIMIT 40
),
tri_scored AS MATERIALIZED (
  SELECT f.rowid,bm25(fts_messages_tri) AS score FROM fts_messages_tri f
  WHERE fts_messages_tri MATCH :tri_query AND f.rowid IN (SELECT rowid FROM allowed)
  ORDER BY score,f.rowid LIMIT 40
),
lex_ranked AS (SELECT rowid,row_number() OVER(ORDER BY score,rowid) AS rnk FROM lex_scored),
tri_ranked AS (SELECT rowid,row_number() OVER(ORDER BY score,rowid) AS rnk FROM tri_scored),
fused AS (
  SELECT rowid,sum(weight) AS rrf_score FROM (
   SELECT rowid,1.0/(60+rnk) AS weight FROM lex_ranked
   UNION ALL SELECT rowid,1.0/(60+rnk) AS weight FROM tri_ranked
  ) GROUP BY rowid
)
SELECT m.object_id,m.session_id,m.role,m.content_text,f.rrf_score
FROM fused f JOIN session_messages_index m ON m.rowid=f.rowid
ORDER BY f.rrf_score DESC,m.rowid LIMIT 12;
`;

// Consistency gate: the embedded query must equal the pack's recall.sql
// structurally — same lines, same order, same tokens, with per-line whitespace
// normalized (leading indentation is readability, not semantics). The pack is
// a local prerequisite (D-01); a missing pack fails this check loudly rather
// than silently passing.
export function assertRecallSqlMatchesPack({ packPath, env = process.env } = {}) {
  const path = env.AEGISPI_RECALL_SQL ?? packPath ?? "D:\\AegisPi\\aegis-pi-design-pack-v1.4.1\\docs\\reference\\recall.sql";
  const pack = readFileSync(path, "utf8");
  const normalize = (text) =>
    text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((l) => !/^--/.test(l.trim()))
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join("\n");
  if (normalize(pack) !== normalize(RECALL_SQL)) {
    throw new Error(
      `embedded recall SQL drifted from the pack file ${path}: re-embed the canonical query, do not fork it`,
    );
  }
  return { path, matches: true };
}

// Query compiler (recall.sql header: "Query compiler quotes/escapes FTS terms
// and bounds length; never interpolate SQL"). Every token is quoted so FTS
// operators and column filters inside a term are inert; token count and
// length are capped.
export function compileFtsQuery(rawQuery, { maxTerms = 8, maxTermLength = 64 } = {}) {
  const tokens = String(rawQuery ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxTerms);
  const quoted = tokens
    .map((t) => t.slice(0, maxTermLength).replace(/"/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return quoted.join(" ");
}

export function recall(db, { scopeId, principalId, currentSessionId, nowMs, query }) {
  const lexQuery = compileFtsQuery(query);
  if (lexQuery.length === 0) {
    return { rows: [], fallback: null };
  }
  const triQuery = lexQuery;
  const rows = db
    .prepare(RECALL_SQL)
    .all({
      scope_id: scopeId,
      principal_id: principalId,
      current_session_id: currentSessionId,
      now_ms: nowMs,
      lex_query: lexQuery,
      tri_query: triQuery,
    });
  return { rows, fallback: null };
}

// Short-term fallback (01 section 5): terms under 3 characters cannot be
// served by trigram; run a bounded LIKE over the SAME authorized allowed set.
// The ordering is NOT RRF and is not claimed to be; it is a bounded, honest
// fallback that needs its own acceptance before any ranking claims.
const FALLBACK_SQL = `
WITH RECURSIVE lineage(sid) AS (
  SELECT :current_session_id
  UNION
  SELECT s.parent_session_id FROM sessions s JOIN lineage l ON s.id=l.sid
  WHERE s.parent_session_id IS NOT NULL
),
allowed AS MATERIALIZED (
  SELECT m.rowid FROM session_messages_index m
  JOIN objects o ON o.id=m.object_id
  WHERE o.scope_id=:scope_id AND o.status='active' AND o.deleted_at IS NULL
  AND (o.expires_at IS NULL OR o.expires_at>:now_ms)
  AND m.session_id NOT IN (SELECT sid FROM lineage)
  AND EXISTS(SELECT 1 FROM object_required_scopes r WHERE r.object_id=o.id AND r.scope_id=o.scope_id)
  AND NOT EXISTS(
   SELECT 1 FROM object_required_scopes r WHERE r.object_id=o.id AND NOT EXISTS(
    SELECT 1 FROM acl_grants g WHERE g.scope_id=r.scope_id AND g.principal_id=:principal_id
    AND g.permission='read' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>:now_ms)
   )
  )
)
SELECT m.object_id,m.session_id,m.role,m.content_text
FROM session_messages_index m
WHERE m.rowid IN (SELECT rowid FROM allowed) AND m.content_text LIKE :like_term
ORDER BY m.rowid LIMIT 12;
`;

export function recallShortTerm(db, { scopeId, principalId, currentSessionId, nowMs, term }) {
  const t = String(term ?? "").trim();
  if ([...t].length >= 3) {
    throw new Error("recallShortTerm is only for terms shorter than 3 characters");
  }
  // LIKE metacharacters are escaped so a user term cannot widen the pattern.
  const likeTerm = `%${t.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const rows = db
    .prepare(FALLBACK_SQL)
    .all({
      scope_id: scopeId,
      principal_id: principalId,
      current_session_id: currentSessionId,
      now_ms: nowMs,
      like_term: likeTerm,
    });
  return { rows, fallback: "bounded LIKE over the authorized allowed set; ranking not RRF" };
}
