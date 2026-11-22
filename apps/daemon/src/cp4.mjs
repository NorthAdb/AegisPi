// CP4 recipient reverse-check (Unit 5.2; spec 02 section 3, 01 section 3).
//
// The caller having read rights is NOT sufficient: before a payload is
// delivered to a target domain (a group, an external recipient, an
// outbox destination), the HOST verifies that the target is ALLOWED TO
// RECEIVE every upstream scope the payload's closure requires. The
// deterministic rules, fail closed:
//   1. closure ⊆ {target}          — same-scope delivery, always fine;
//   2. target is an owner_dm whose OWNER holds a live read grant on every
//      closure scope — the audience is exactly one determinable person
//      already entitled to read all sources (this is what keeps the
//      Phase 4 repo-digest -> owner DM notification legal);
//   3. an explicit human-reviewed disclosure allowlist entry covers each
//      closure scope -> target (system_state key disclosure_allowlist;
//      host/admin-written, never model-writable).
// Anything else — a group, an unknown scope, an unresolvable recipient —
// is blocked BEFORE the effect/outbox row is usable and BEFORE any byte
// leaves, with audit `cp4_recipient_scope_leak_blocked`.

import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { hasReadGrant } from "./acl.mjs";

export class Cp4RecipientLeak extends Error {}

export const DISCLOSURE_ALLOWLIST_STATE_KEY = "disclosure_allowlist";

// The Phase 5 canonical GROUP-shaped Telegram targets — the multi-member
// audiences the CP4 reverse-check exists for (the plan's threat is a
// private derivative flowing to a public or unauthorized GROUP). A
// dm:telegram:<id> target has one determinable person behind it and stays
// under the Phase 4 recipient-allowlist discipline (the adapter refuses
// unlisted DMs as a local error); legacy fixture resources
// (telegram-dm:60, im:dm:6101, dm:5001) never match anything here.
export const GROUP_SHAPED_TARGET_RE = /^group:telegram:-?\d+$/;

export function disclosureAllowlist(db) {
  const row = db.prepare("SELECT value FROM system_state WHERE key=?").get(DISCLOSURE_ALLOWLIST_STATE_KEY);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) => e && typeof e.from === "string" && typeof e.to === "string" && typeof e.reviewedBy === "string",
    );
  } catch {
    return [];
  }
}

/**
 * The union closure a payload carries: its own required scopes plus every
 * ancestor's (object_edges parents, bounded depth). A derived object
 * inherits the whole chain — summarizing never de-classifies.
 */
export function payloadScopeClosure(db, { objectId, maxDepth = 6 }) {
  const closure = new Set();
  let frontier = [objectId];
  let depth = 0;
  while (frontier.length > 0 && depth <= maxDepth) {
    const next = [];
    for (const id of frontier) {
      for (const r of db.prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=?").all(id)) {
        closure.add(r.scope_id);
      }
      for (const p of db.prepare("SELECT parent_id FROM object_edges WHERE child_id=?").all(id)) {
        next.push(p.parent_id);
      }
    }
    frontier = next;
    depth += 1;
  }
  return [...closure];
}

function ownerDmAudienceCanRead(db, { targetScope, closure, now }) {
  if (targetScope.kind !== "owner_dm") return false;
  return closure.every((scopeId) => hasReadGrant(db, { scopeId, principalId: targetScope.owner_id, now }));
}

/**
 * The CP4 decision — PURE: no transaction, no audit, no writes. Callers
 * that block record the audit inside their OWN open transaction
 * (audit.mjs discipline); callers that allow proceed.
 */
export function cp4Decision(db, { payloadObjectId, targetScopeId, now }) {
  const closure = payloadScopeClosure(db, { objectId: payloadObjectId });
  const targetScope = db.prepare("SELECT id, kind, owner_id FROM scopes WHERE id=?").get(targetScopeId);
  const allowlist = disclosureAllowlist(db);
  const allowlistCovers = (fromScope) =>
    allowlist.some((e) => e.from === fromScope && (e.to === targetScopeId || e.to === "*"));

  if (closure.length === 0) {
    return { allowed: false, basis: "payload carries no required-scope closure", closure };
  }
  if (closure.every((s) => s === targetScopeId)) {
    return { allowed: true, basis: "same-scope delivery", closure };
  }
  if (targetScope && ownerDmAudienceCanRead(db, { targetScope, closure, now })) {
    return { allowed: true, basis: "owner_dm target whose owner holds live read on every closure scope", closure };
  }
  if (closure.every((s) => allowlistCovers(s))) {
    return { allowed: true, basis: "human-reviewed disclosure allowlist", closure };
  }
  return { allowed: false, basis: "cross-scope disclosure without an explicit review record", closure };
}

/** Audit trail for a blocked delivery — the CALLER owns the transaction. */
export function recordCp4Block(db, { payloadObjectId, targetScopeId, closure, basis, now }) {
  writeAudit(db, {
    code: "cp4_recipient_scope_leak_blocked",
    details: {
      payload_object_id: payloadObjectId,
      target_scope_id: targetScopeId,
      closure,
      reason: basis,
    },
    now,
  });
  // The stream event anchors to the payload's HOME scope (always a real
  // row); a target scope that does not exist has an undeterminable
  // audience, and stream_events.scope_id must reference an existing scope.
  const streamScopeId = Array.isArray(closure) && closure.length > 0 ? closure[0] : null;
  if (streamScopeId !== null) {
    writeStreamEvent(db, {
      scopeId: streamScopeId,
      eventType: "audit_alert",
      entityId: `cp4:${payloadObjectId}`,
      entityVersion: 1,
      payload: { blocked: true, target_scope_id: targetScopeId, closure_size: closure.length },
      now,
    });
  }
}

/**
 * The blocking form for callers OUTSIDE any transaction: decides, records
 * the block in a short transaction when refused, throws Cp4RecipientLeak.
 */
export function assertCp4RecipientAllowed(db, { payloadObjectId, targetScopeId, now }) {
  const decision = cp4Decision(db, { payloadObjectId, targetScopeId, now });
  if (decision.allowed) {
    return { allowed: true, basis: decision.basis, closure: decision.closure };
  }
  withTx(db, () => {
    recordCp4Block(db, { payloadObjectId, targetScopeId, closure: decision.closure, basis: decision.basis, now });
  });
  throw new Cp4RecipientLeak(
    `CP4 blocked: payload ${payloadObjectId} (closure ${decision.closure.join(",")}) may not flow to ${targetScopeId ?? "<unknown target>"} — ${decision.basis}`,
  );
}
