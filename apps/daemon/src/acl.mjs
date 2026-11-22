// ACL grants and revocation per 01 section 3 and 06 section 2. A revocation
// updates acl_grants, scope.acl_version AND the global authorization revision
// in ONE transaction, with audit — hosts re-check the revision before every
// model request, tool call, retrieval and action submission, so a revoked
// grant fails closed at every later gate.

import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent, bumpAuthorizationRevision, authorizationRevision } from "./audit.mjs";
import { cancelScopeTimersInTx } from "./timers.mjs";

export class AclError extends Error {}

export const PERMISSIONS = ["read", "request", "approve", "admin"];

export function grantPermission(db, { scopeId, principalId, permission, expiresAt = null, now, actorId = null }) {
  if (!PERMISSIONS.includes(permission)) {
    throw new AclError(`permission ${permission} is not one of ${PERMISSIONS.join("/")}`);
  }
  return withTx(db, () => {
    db.prepare(
      `INSERT INTO acl_grants(scope_id, principal_id, permission, expires_at, revoked_at)
       VALUES (?,?,?,?,NULL)
       ON CONFLICT(scope_id, principal_id, permission)
       DO UPDATE SET expires_at=excluded.expires_at, revoked_at=NULL`,
    ).run(scopeId, principalId, permission, expiresAt);
    writeAudit(db, {
      code: "acl_granted",
      actorId,
      details: { scope_id: scopeId, principal_id: principalId, permission, expires_at: expiresAt },
      now,
    });
    return { scopeId, principalId, permission };
  });
}

// One transaction: revoke the grant, bump the scope's acl_version, bump the
// global authorization revision, audit. Loaded contexts die with the revision
// — a "please ignore" note is not a revocation.
export function revokePermission(db, { scopeId, principalId, permission, now, actorId = null, reason = "" }) {
  return withTx(db, () => {
    const changed = db
      .prepare(
        "UPDATE acl_grants SET revoked_at=? WHERE scope_id=? AND principal_id=? AND permission=? AND revoked_at IS NULL",
      )
      .run(now, scopeId, principalId, permission).changes;
    if (changed !== 1) {
      throw new AclError(`no live ${permission} grant for ${principalId} in ${scopeId}`);
    }
    db.prepare("UPDATE scopes SET acl_version=acl_version+1 WHERE id=?").run(scopeId);
    // Unit 5.4 cascade (03 section 4): revoking READ access kills the
    // scope's SCHEDULED timers in the same transaction — a follow-up that
    // can no longer read its thread may not keep firing.
    let cancelledTimers = [];
    if (permission === "read") {
      cancelledTimers = cancelScopeTimersInTx(db, { scopeId, now, reason: `read grant revoked for ${principalId}`, actorId });
    }
    const revision = bumpAuthorizationRevision(db, { now, reason: reason || `revoke ${permission} in ${scopeId}`, actorId });
    writeStreamEvent(db, {
      scopeId,
      eventType: "acl_changed",
      entityId: `grant:${principalId}:${permission}`,
      entityVersion: 1,
      payload: { revoked: true, permission },
      now,
    });
    return { scopeId, principalId, permission, authorizationRevision: revision, cancelledTimers };
  });
}

export function hasReadGrant(db, { scopeId, principalId, now }) {
  const row = db
    .prepare(
      `SELECT 1 FROM acl_grants
        WHERE scope_id=? AND principal_id=? AND permission='read'
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)
        LIMIT 1`,
    )
    .get(scopeId, principalId, now);
  return row !== undefined;
}

export function currentRevision(db) {
  return authorizationRevision(db);
}
