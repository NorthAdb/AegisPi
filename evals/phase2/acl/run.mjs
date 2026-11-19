// test:acl — Phase 2 recall/ACL suite (01 sections 3/5, 04 Phase 2 gate).
// The headline case: 45 high-BM25 UNAUTHORIZED candidates (25 in a foreign
// scope, 20 demanding an ungranted extra scope) must not crowd out the 12
// legal results — the allowed CTE filters authorization strictly BEFORE any
// LIMIT. Everything runs the real recall query against the real FTS indexes
// maintained by the schema's three triggers.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
  repoRoot,
} from "../lib/harness.mjs";
import { loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { putObjectContent, insertObjectRow } from "../../../apps/daemon/src/objects.mjs";
import { grantPermission, revokePermission, hasReadGrant } from "../../../apps/daemon/src/acl.mjs";
import {
  recall,
  recallShortTerm,
  compileFtsQuery,
  assertRecallSqlMatchesPack,
} from "../../../apps/daemon/src/recall.mjs";
import { authorizationRevision } from "../../../apps/daemon/src/audit.mjs";

lockedNodeGuard();

const suite = makeSuite("acl");

// ---------------------------------------------------------------- consistency
{
  let matches = false;
  let detail = "";
  try {
    const r = assertRecallSqlMatchesPack();
    matches = r.matches;
    detail = `embedded recall.sql === pack file (${r.path})`;
  } catch (e) {
    detail = e.message;
  }
  suite.check("recall-sql-matches-pack-structure", matches, detail);
}

// ------------------------------------------------------------- FTS triggers
{
  const canonical = loadCanonicalSchema();
  const ws = makeWorkspace("acl-fts-triggers");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, canonical);
  db.prepare("INSERT INTO principals(id, platform, platform_subject) VALUES ('prn:web:1','web','1')").run();
  db.prepare(
    "INSERT INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused) VALUES ('scp:dm:web:1','prn:web:1','owner_dm','dm:web:1','web','1',NULL,1,1,'pv1',0)",
  ).run();
  db.prepare(
    "INSERT INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at) VALUES ('ses:fts:1','scp:dm:web:1','prn:web:1',NULL,NULL,1,'ss:1','ref:1',1797000000000)",
  ).run();
  const addMessage = (content) => {
    const stored = putObjectContent(ws.stateDir, content);
    const obj = insertObjectRow(db, {
      scopeId: "scp:dm:web:1",
      kind: "session_message",
      sourceUri: "test",
      sourceActor: "prn:web:1",
      content,
      contentHash: stored.contentHash,
      storageRef: stored.storageRef,
      observedAt: 1797000000000,
      requiredScopeIds: ["scp:dm:web:1"],
    });
    db.prepare(
      "INSERT INTO session_messages_index(session_id, object_id, role, tool_names, content_text, created_at) VALUES (?,?,?,?,?,?)",
    ).run("ses:fts:1", obj.id, "user", "", content, 1797000000000);
    return { rowid: db.prepare("SELECT rowid FROM session_messages_index WHERE object_id=?").get(obj.id).rowid, objectId: obj.id };
  };

  const m1 = addMessage("the hono csrf advisory matters");
  const lexCount = db.prepare("SELECT count(*) c FROM fts_messages_lex").get().c;
  const triCount = db.prepare("SELECT count(*) c FROM fts_messages_tri").get().c;
  suite.check(
    "insert-trigger-populates-both-fts-indexes",
    lexCount === 1 && triCount === 1,
    `after insert: lex=${lexCount} tri=${triCount}`,
  );

  db.prepare("UPDATE session_messages_index SET content_text=? WHERE rowid=?").run("completely different wording now", m1.rowid);
  const oldLexHit = db.prepare("SELECT count(*) c FROM fts_messages_lex WHERE fts_messages_lex MATCH ?").get('"advisory"').c;
  const newLexHit = db.prepare("SELECT count(*) c FROM fts_messages_lex WHERE fts_messages_lex MATCH ?").get('"different"').c;
  suite.check(
    "update-trigger-reindexes-both-indexes",
    oldLexHit === 0 && newLexHit === 1,
    `old term gone (advisory hits=${oldLexHit}), new term indexed (different hits=${newLexHit})`,
  );

  db.prepare("DELETE FROM session_messages_index WHERE rowid=?").run(m1.rowid);
  const lexAfterDelete = db.prepare("SELECT count(*) c FROM fts_messages_lex").get().c;
  const triAfterDelete = db.prepare("SELECT count(*) c FROM fts_messages_tri").get().c;
  suite.check(
    "delete-trigger-clears-both-indexes",
    lexAfterDelete === 0 && triAfterDelete === 0,
    `after delete: lex=${lexAfterDelete} tri=${triAfterDelete}`,
  );
}

// ---------------------------------------------------- the 45-unauthorized gate
{
  const canonical = loadCanonicalSchema();
  const ws = makeWorkspace("acl-45-unauthorized");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, canonical);
  const now = 1797100000000;

  const ensureScope = (id, domainKey) => {
    db.prepare(
      "INSERT OR IGNORE INTO principals(id, platform, platform_subject) VALUES (?,'web',?)",
    ).run(id.replace("scp:", "prn:web:").replace("dm:", ""), id);
    db.prepare(
      `INSERT OR IGNORE INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused)
       VALUES (?,?,'owner_dm',?,'web',?,NULL,1,1,'pv1',0)`,
    ).run(id, id.replace("scp:", "prn:web:").replace("dm:", ""), domainKey, domainKey.split(":").pop());
  };
  const ensurePrincipal = (id, subject) => {
    db.prepare("INSERT OR IGNORE INTO principals(id, platform, platform_subject) VALUES (?,'web',?)").run(id, subject);
    return id;
  };
  const scopeA = "scp:dm:web:a";
  const scopeB = "scp:dm:web:b";
  const scopeC = "scp:dm:web:c";
  ensureScope(scopeA, "dm:web:a");
  ensureScope(scopeB, "dm:web:b");
  ensureScope(scopeC, "dm:web:c");
  const reader = ensurePrincipal("prn:web:reader", "reader");
  const sessionMain = "ses:main:1";
  const sessionParent = "ses:parent:1";
  const sessionLegal = "ses:legal:1";
  const addMessage = ({ scopeId, sessionId, content, requiredScopeIds, status = "active", expiresAt = null, skipOwnClosure = false }) => {
    const stored = putObjectContent(ws.stateDir, content);
    if (skipOwnClosure) {
      // Simulate a legacy/corrupt row the writer refuses to produce (its
      // own-scope closure is missing). The recall query must still exclude
      // it: the closure check is defense in depth, not writer trust.
      const contentHash = stored.contentHash;
      const id = `obj:${scopeId}:${contentHash}`;
      db.prepare(
        `INSERT INTO objects(id, scope_id, kind, source_uri, source_actor, content_hash, storage_ref,
          status, version, supersedes_id, confidence, observed_at, expires_at, deleted_at, metadata_json)
         VALUES (?,?,?,?,?,?,?,?,1,NULL,NULL,?,?,NULL,'{}')`,
      ).run(id, scopeId, "session_message", "test", reader, contentHash, stored.storageRef, status, now, expiresAt);
      db.prepare(
        "INSERT INTO session_messages_index(session_id, object_id, role, tool_names, content_text, created_at) VALUES (?,?,?,?,?,?)",
      ).run(sessionId, id, "assistant", "", content, now);
      return id;
    }
    const closure = [scopeId, ...requiredScopeIds.filter((s) => s !== scopeId)];
    const obj = insertObjectRow(db, {
      scopeId,
      kind: "session_message",
      sourceUri: "test",
      sourceActor: reader,
      content,
      contentHash: stored.contentHash,
      storageRef: stored.storageRef,
      status,
      observedAt: now,
      expiresAt,
      requiredScopeIds: closure,
    });
    db.prepare(
      "INSERT INTO session_messages_index(session_id, object_id, role, tool_names, content_text, created_at) VALUES (?,?,?,?,?,?)",
    ).run(sessionId, obj.id, "assistant", "", content, now);
    return obj.id;
  };
  db.prepare(
    "INSERT INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at) VALUES (?,?,?,NULL,NULL,1,'ss:1','ref:1',?)",
  ).run(sessionParent, scopeA, reader, now);
  db.prepare(
    "INSERT INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at) VALUES (?,?,?,?,NULL,1,'ss:1','ref:2',?)",
  ).run(sessionMain, scopeA, reader, sessionParent, now);
  db.prepare(
    "INSERT INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at) VALUES (?,?,?,NULL,NULL,1,'ss:1','ref:legal',?)",
  ).run(sessionLegal, scopeA, reader, now);

  // 12 legal messages: authorized scope, own closure present, and in a
  // session OUTSIDE the current session's lineage.
  const legalIds = [];
  for (let i = 1; i <= 12; i += 1) {
    legalIds.push(addMessage({
      scopeId: scopeA, sessionId: sessionLegal, content: `security advisory finding number ${i} about hono csrf bypass`,
      requiredScopeIds: [],
    }));
  }
  // 25 unauthorized: strong matches, but they live in scopeB.
  db.prepare(
    "INSERT OR IGNORE INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at) VALUES ('ses:b',?,?,NULL,NULL,1,'ss:1','ref:b',?)",
  ).run(scopeB, reader, now);
  for (let i = 1; i <= 25; i += 1) {
    addMessage({
      scopeId: scopeB, sessionId: "ses:b", content: `security advisory finding ${i} hono csrf bypass secret private`,
      requiredScopeIds: [],
    });
  }
  // 20 unauthorized: in scopeA but demanding scopeC, which the reader lacks.
  for (let i = 1; i <= 20; i += 1) {
    addMessage({
      scopeId: scopeA, sessionId: sessionLegal, content: `security advisory finding ${100 + i} hono csrf bypass confidential annex`,
      requiredScopeIds: [scopeC],
    });
  }
  // An authorized message that lives in the CURRENT session's ANCESTOR: the
  // lineage exclusion must drop it even though every other check passes.
  const ancestorMessage = addMessage({
    scopeId: scopeA, sessionId: sessionParent, content: "security advisory hono csrf bypass from the ancestor session",
    requiredScopeIds: [],
  });
  // Messages excluded for structural reasons the query also enforces.
  addMessage({ scopeId: scopeA, sessionId: sessionLegal, content: "security advisory hono csrf bypass ancestor current", requiredScopeIds: [], skipOwnClosure: true });
  addMessage({ scopeId: scopeA, sessionId: sessionLegal, content: "security advisory hono csrf bypass deleted", requiredScopeIds: [], status: "deleted" });
  addMessage({ scopeId: scopeA, sessionId: sessionLegal, content: "security advisory hono csrf bypass expired", requiredScopeIds: [], expiresAt: now - 1 });
  const currentSessionMessage = addMessage({ scopeId: scopeA, sessionId: sessionMain, content: "security advisory hono csrf bypass in current session", requiredScopeIds: [] });

  grantPermission(db, { scopeId: scopeA, principalId: reader, permission: "read", now });
  const result = recall(db, {
    scopeId: scopeA,
    principalId: reader,
    currentSessionId: sessionMain,
    nowMs: now,
    query: "security advisory hono csrf bypass",
  });
  const recalledIds = new Set(result.rows.map((r) => r.object_id));
  const leakedForeignScope = result.rows.filter((r) => !legalIds.includes(r.object_id)).length;
  const legalFound = legalIds.filter((id) => recalledIds.has(id)).length;
  suite.check(
    "45-unauthorized-candidates-cannot-crowd-out-legal-results",
    result.rows.length === 12 && leakedForeignScope === 0 && legalFound === 12,
    `recalled ${result.rows.length} rows, all legal (${legalFound}/12 present), 0 leaked from 25 foreign-scope + 20 ungranted-closure candidates`,
  );
  suite.check(
    "ancestor-and-current-session-and-degraded-objects-excluded",
    !recalledIds.has(currentSessionMessage) && !recalledIds.has(ancestorMessage),
    "current session, its ancestor, missing own-closure, deleted and expired objects never recalled",
  );

  // Revoke: recall fails closed, revision and acl_version bumped atomically.
  const revisionBefore = authorizationRevision(db);
  const aclVersionBefore = db.prepare("SELECT acl_version FROM scopes WHERE id=?").get(scopeA).acl_version;
  revokePermission(db, { scopeId: scopeA, principalId: reader, permission: "read", now, actorId: "prn:web:owner", reason: "reader left the team" });
  const afterRevoke = recall(db, {
    scopeId: scopeA, principalId: reader, currentSessionId: sessionMain, nowMs: now,
    query: "security advisory hono csrf bypass",
  });
  const revisionAfter = authorizationRevision(db);
  const aclVersionAfter = db.prepare("SELECT acl_version FROM scopes WHERE id=?").get(scopeA).acl_version;
  const revokeAudit = db.prepare("SELECT count(*) c FROM audit_log WHERE code='acl_granted' OR code='authorization_revision_bumped'").get().c;
  suite.check(
    "revocation-closes-recall-and-bumps-revisions-in-one-transaction",
    afterRevoke.rows.length === 0 && revisionAfter === revisionBefore + 1 &&
      aclVersionAfter === aclVersionBefore + 1 && revokeAudit >= 2,
    `recall empty after revoke; authorization_revision ${revisionBefore}->${revisionAfter}, acl_version ${aclVersionBefore}->${aclVersionAfter}`,
  );

  // Cross-scope isolation: a grant in scopeA never opens scopeB.
  grantPermission(db, { scopeId: scopeA, principalId: reader, permission: "read", now });
  const inScopeB = recall(db, {
    scopeId: scopeB, principalId: reader, currentSessionId: sessionMain, nowMs: now,
    query: "security advisory hono csrf bypass",
  });
  suite.check(
    "cross-scope-isolation-holds",
    inScopeB.rows.length === 0,
    `scopeB recall with only a scopeA grant: ${inScopeB.rows.length} rows`,
  );

  // Expired grants fail closed.
  db.prepare("UPDATE acl_grants SET expires_at=? WHERE scope_id=? AND principal_id=?").run(now - 1, scopeA, reader);
  const expiredResult = recall(db, {
    scopeId: scopeA, principalId: reader, currentSessionId: sessionMain, nowMs: now,
    query: "security advisory hono csrf bypass",
  });
  suite.check("expired-grant-recalls-nothing", expiredResult.rows.length === 0, "expires_at in the past excludes the grant");

  // Multi-scope closure: an object demanding A+C is invisible with only A.
  const bothGrantSubject = ensurePrincipal("prn:web:both", "both");
  const annexId = addMessage({
    scopeId: scopeA, sessionId: sessionLegal, content: "annex-only note for readers of scope c too",
    requiredScopeIds: [scopeC],
  });
  db.prepare("UPDATE acl_grants SET expires_at=NULL WHERE scope_id=? AND principal_id=?").run(scopeA, reader);
  grantPermission(db, { scopeId: scopeC, principalId: reader, permission: "read", now });
  const withBoth = recall(db, {
    scopeId: scopeA, principalId: reader, currentSessionId: sessionMain, nowMs: now,
    query: "annex-only note readers scope",
  });
  const annexVisible = withBoth.rows.some((r) => r.object_id === annexId);
  const singleBefore = hasReadGrant(db, { scopeId: scopeA, principalId: bothGrantSubject, now });
  suite.check(
    "union-closure-intersects-grants",
    annexVisible === true && singleBefore === false,
    `object requiring A+C visible only with both grants (annex found: ${annexVisible})`,
  );
}

// --------------------------------------------------- compiler and fallback
{
  const compiled = compileFtsQuery('csrf "column:filter" OR bogus ' + Array.from({ length: 12 }, (_, i) => `term${i}`).join(" "));
  const expected = '"csrf" "column:filter" "OR" "bogus" "term0" "term1" "term2" "term3"';
  suite.check(
    "query-compiler-bounds-and-quotes",
    compiled === expected,
    `14 tokens in -> first 8 kept, every token quoted so FTS operators are inert: ${compiled}`,
  );
  suite.check("empty-query-compiles-to-nothing", compileFtsQuery("   ") === "", "blank input -> empty query -> no recall");

  const canonical = loadCanonicalSchema();
  const ws = makeWorkspace("acl-short-cjk");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, canonical);
  db.prepare("INSERT INTO principals(id, platform, platform_subject) VALUES ('prn:web:cn','web','cn')").run();
  db.prepare(
    "INSERT INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused) VALUES ('scp:dm:web:cn','prn:web:cn','owner_dm','dm:web:cn','web','cn',NULL,1,1,'pv1',0)",
  ).run();
  db.prepare(
    "INSERT INTO sessions(id, scope_id, principal_id, parent_session_id, context_object_id, authorization_revision, skill_set_hash, transcript_ref, created_at) VALUES ('ses:cn:1','scp:dm:web:cn','prn:web:cn',NULL,NULL,1,'ss:1','ref:cn',1797200000000)",
  ).run();
  grantPermission(db, { scopeId: "scp:dm:web:cn", principalId: "prn:web:cn", permission: "read", now: 1797200000000 });
  const addCn = (content) => {
    const stored = putObjectContent(ws.stateDir, content);
    const obj = insertObjectRow(db, {
      scopeId: "scp:dm:web:cn", kind: "session_message", sourceUri: "test", sourceActor: "prn:web:cn",
      content, contentHash: stored.contentHash, storageRef: stored.storageRef,
      observedAt: 1797200000000, requiredScopeIds: ["scp:dm:web:cn"],
    });
    db.prepare(
      "INSERT INTO session_messages_index(session_id, object_id, role, tool_names, content_text, created_at) VALUES (?,?,?,?,?,?)",
    ).run("ses:cn:1", obj.id, "user", "", content, 1797200000000);
    return obj.id;
  };
  addCn("把安全公告归档到香港目录");
  addCn("香港服务器维护窗口在周五");
  const short = recallShortTerm(db, {
    scopeId: "scp:dm:web:cn", principalId: "prn:web:cn", currentSessionId: "ses:cn:other-session",
    nowMs: 1797200000000, term: "香港",
  });
  suite.check(
    "short-cjk-fallback-bounded-over-authorized-set",
    short.rows.length === 2 && short.fallback.includes("not RRF"),
    `2-char term served by the bounded LIKE fallback (${short.rows.length} rows), ranking explicitly not claimed RRF-equivalent`,
  );
  const injected = recallShortTerm(db, {
    scopeId: "scp:dm:web:cn", principalId: "prn:web:cn", currentSessionId: "ses:cn:other-session",
    nowMs: 1797200000000, term: "%",
  });
  suite.check(
    "short-fallback-escapes-like-metacharacters",
    injected.rows.length === 0,
    "a bare % term matches nothing literal — LIKE metacharacters escaped",
  );
}

// -------------------------------------------------------------------- summary
const exit = suiteExit(suite, { label: "test:acl" });
const { reportPath, logPath } = writeReport({
  suiteId: "acl",
  suite,
  label: "Phase 2 test:acl — 召回顺序、FTS 三触发器与 45 条无权候选门（01 §3/§5）",
  extra: { dataSources: "本地 SQLite 与设计包 recall.sql（无真实外部连接）" },
  evidenceDir: join(repoRoot, "docs", "phase2", "evidence"),
});
console.log(`report: ${reportPath}`);
console.log(`log: ${logPath}`);
process.exit(exit);
