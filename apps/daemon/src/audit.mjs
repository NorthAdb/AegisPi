// Audit and stream-event writers. 06 section 10: "审计与stream事件跟业务
// 更新同事务" — these functions only run inside a caller's open transaction
// and never commit on their own.

export function writeAudit(db, { code, taskId = null, eventId = null, actorId = null, details = {}, now }) {
  db.prepare(
    "INSERT INTO audit_log(task_id, event_id, actor_id, code, details_json, created_at) VALUES (?,?,?,?,?,?)",
  ).run(taskId, eventId, actorId, code, JSON.stringify(details), now);
}

export function writeStreamEvent(db, { scopeId, eventType, entityId, entityVersion, payload = {}, now }) {
  db.prepare(
    "INSERT INTO stream_events(scope_id, event_type, entity_id, entity_version, payload_json, created_at) VALUES (?,?,?,?,?,?)",
  ).run(scopeId, eventType, entityId, entityVersion, JSON.stringify(payload), now);
}

// Bump the global authorization revision inside a caller's transaction
// (01 section 3: revocation updates acl_grants, scope.acl_version and
// system_state.authorization_revision, with audit, in one transaction).
export function bumpAuthorizationRevision(db, { now, reason, actorId = null }) {
  const row = db.prepare("SELECT value FROM system_state WHERE key='authorization_revision'").get();
  const next = String(Number(row.value) + 1);
  db.prepare("UPDATE system_state SET value=? WHERE key='authorization_revision'").run(next);
  writeAudit(db, { code: "authorization_revision_bumped", actorId, details: { revision: next, reason }, now });
  return next;
}

export function authorizationRevision(db) {
  return Number(db.prepare("SELECT value FROM system_state WHERE key='authorization_revision'").get().value);
}
