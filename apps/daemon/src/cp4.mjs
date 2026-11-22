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
import { scopeId as scopeIdForDomainKey } from "./ingress.mjs";

export class Cp4RecipientLeak extends Error {}
export class Cp4ClosureTooDeep extends Error {}
export class Cp4ClosureTooLarge extends Error {}

export const DISCLOSURE_ALLOWLIST_STATE_KEY = "disclosure_allowlist";

// Target-shape classification (02 section 3 CP4: "检查payload来源ACL和
// 真正接收人" — every outbound/write target, not just SendToUser):
//   group:telegram:<id>  — a GROUP audience, always adjudicated;
//   telegram:<id>        — prefix-less and ambiguous: it can name a group
//                          chat, so it is treated as the WORST case (group);
//   dm:telegram:<id>    — one determinable person (owner_dm audience rule);
//   telegram-dm:<n> / im:dm:<n> — the legacy single-person fixture shapes,
//                          same owner_dm audience rule when a scope exists;
//   repo://...          — a repository write whose audience is the repo's
//                          readers (a public audience: allowlist only);
// Anything else an im adapter would refuse anyway — with a payload closure
// that leaves its own scope the audience is undeterminable and the decision
// fails closed.
export const IM_GROUP_TARGET_RE = /^group:telegram:-?\d+$/;
export const IM_BARE_TARGET_RE = /^telegram:-?\d+$/;
export const IM_DM_TARGET_RE = /^dm:telegram:-?\d+$/;
export const LEGACY_DM_TARGET_RE = /^(?:telegram-dm|im:dm):-?\d+$/;
export const REPO_URL_TARGET_RE = /^repo:\/\//;

// Kept for the D-93 era callers/tests that only ask "is this a GROUP-shaped
// telegram target"; the decision itself uses cp4TargetShape below.
export const GROUP_SHAPED_TARGET_RE = IM_GROUP_TARGET_RE;

export function cp4TargetShape({ operation, resource }) {
  if (typeof resource !== "string") return { shape: "none", scopeDomainKey: null };
  if (operation === "im.notify" || operation === "send_message") {
    if (IM_GROUP_TARGET_RE.test(resource)) return { shape: "im-group", scopeDomainKey: resource };
    if (IM_BARE_TARGET_RE.test(resource)) {
      return { shape: "im-group", scopeDomainKey: `group:${resource}` };
    }
    if (IM_DM_TARGET_RE.test(resource)) return { shape: "im-dm", scopeDomainKey: resource };
    if (LEGACY_DM_TARGET_RE.test(resource)) return { shape: "im-dm-legacy", scopeDomainKey: resource };
    return { shape: "unknown-im", scopeDomainKey: null };
  }
  if (operation === "pr.create_draft" && REPO_URL_TARGET_RE.test(resource)) {
    return { shape: "repo-write", scopeDomainKey: null };
  }
  // Unit 5.3/5.4 (D-96 red line): mail.send and calendar.write are ALWAYS
  // adjudicated — their audiences (email addresses, calendar readers) are
  // undeterminable scopes, so the payload closure must stay inside the
  // effect's own scope unless a human-reviewed disclosure allowlist entry
  // says otherwise. adapters.allowedRecipients / mail.allowedRecipients are
  // transport reachability only and never substitute for this gate.
  if (operation === "mail.send") {
    return { shape: "mail-send", scopeDomainKey: null };
  }
  if (operation === "calendar.write") {
    return { shape: "calendar-write", scopeDomainKey: null };
  }
  return { shape: "none", scopeDomainKey: null };
}

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

const MAX_CLOSURE_SCOPES = 64;

/**
 * The union closure a payload carries: its own required scopes plus every
 * ancestor's (object_edges parents, bounded depth). A derived object
 * inherits the whole chain — summarizing never de-classifies. The walk
 * keeps a visited set (cycles terminate) and FAILS CLOSED past the depth
 * or size bounds: an ancestor chain too deep to verify is refused, never
 * silently truncated into an allowance (the chain beyond the cut is
 * exactly where a private ancestor could hide).
 */
export function payloadScopeClosure(db, { objectId, maxDepth = 6 }) {
  const closure = new Set();
  const visited = new Set([objectId]);
  let frontier = [objectId];
  let depth = 0;
  while (frontier.length > 0) {
    if (depth > maxDepth) {
      throw new Cp4ClosureTooDeep(
        `object ${objectId} has an ancestor chain deeper than maxDepth=${maxDepth}; the closure cannot be verified, so the disclosure is refused`,
      );
    }
    const next = [];
    for (const id of frontier) {
      for (const r of db.prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=?").all(id)) {
        closure.add(r.scope_id);
        if (closure.size > MAX_CLOSURE_SCOPES) {
          throw new Cp4ClosureTooLarge(
            `object ${objectId} closure exceeds ${MAX_CLOSURE_SCOPES} scopes; refusing instead of walking unbounded`,
          );
        }
      }
      for (const p of db.prepare("SELECT parent_id FROM object_edges WHERE child_id=?").all(id)) {
        if (!visited.has(p.parent_id)) {
          visited.add(p.parent_id);
          next.push(p.parent_id);
        }
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

/**
 * The unified effect-level decision (Unit 5.2 rework, 02 section 3 CP4):
 * normalizes the target shape, and — whatever the shape — refuses whenever
 * the payload closure contains a scope the effect's own scope does not
 * cover. GROUP-shaped targets are adjudicated even same-scope; repo writes
 * carry a public audience (allowlist only); unknown im targets with an
 * external closure fail closed with an undeterminable audience. The
 * closure comes either from the inserted payload object (`payloadObjectId`
 * — the dispatch gate) or from the caller's lineage union plus the full
 * ancestor walk of the named parents (`closure` + `parentObjectIds` — the
 * proposal gate, byte-identical to what the later object walk yields).
 * Returns {needed, allowed, basis, closure, shape} and never throws for a
 * verification failure — a chain too deep to verify is a REFUSAL, not an
 * exception for the caller to mis-handle.
 */
export function cp4EffectDecision(db, {
  operation,
  resource,
  payloadObjectId = null,
  closure: closureArg = null,
  parentObjectIds = [],
  effectScopeId,
  now,
}) {
  const shape = cp4TargetShape({ operation, resource });
  let closure;
  try {
    if (closureArg !== null) {
      const union = new Set(Array.isArray(closureArg) ? closureArg : []);
      for (const pid of Array.isArray(parentObjectIds) ? parentObjectIds : []) {
        for (const s of payloadScopeClosure(db, { objectId: pid })) union.add(s);
      }
      closure = [...union];
    } else {
      closure = payloadScopeClosure(db, { objectId: payloadObjectId });
    }
  } catch (e) {
    if (e instanceof Cp4ClosureTooDeep || e instanceof Cp4ClosureTooLarge) {
      return { needed: true, allowed: false, basis: e.message, closure: [], shape: shape.shape };
    }
    throw e;
  }
  const external = closure.filter((s) => s !== effectScopeId);
  const adjudicate = () => {
    const allowlist = disclosureAllowlist(db);
    const targetScopeId = shape.scopeDomainKey !== null ? scopeIdForDomainKey(shape.scopeDomainKey) : null;
    const targetScope = targetScopeId !== null
      ? db.prepare("SELECT id, kind, owner_id FROM scopes WHERE id=?").get(targetScopeId)
      : null;
    if (closure.length === 0) {
      return { allowed: false, basis: "payload carries no required-scope closure" };
    }
    if (targetScopeId !== null && closure.every((s) => s === targetScopeId)) {
      return { allowed: true, basis: "same-scope delivery" };
    }
    if ((shape.shape === "mail-send" || shape.shape === "calendar-write") && closure.every((s) => s === effectScopeId)) {
      return {
        allowed: true,
        basis: shape.shape === "mail-send"
          ? "mail payload closure stays inside the effect's own scope (transport whitelist still applies at the adapter)"
          : "calendar payload closure stays inside the effect's own scope (ETag precondition still applies at submit)",
      };
    }
    if (shape.shape === "im-dm-legacy" && closure.every((s) => s === effectScopeId)) {
      const legacyId = String(resource).split(":").pop();
      const effectScope = db.prepare("SELECT kind, domain_key, conversation_id FROM scopes WHERE id=?").get(effectScopeId);
      const scopeSuffix = String(effectScope?.domain_key ?? "").split(":").pop();
      if (effectScope?.kind === "owner_dm" && (effectScope.conversation_id === legacyId || scopeSuffix === legacyId)) {
        return { allowed: true, basis: "same-owner legacy DM fixture delivery" };
      }
    }
    if (
      (shape.shape === "im-dm" || shape.shape === "im-dm-legacy") &&
      targetScope &&
      ownerDmAudienceCanRead(db, { targetScope, closure, now })
    ) {
      return { allowed: true, basis: "owner_dm target whose owner holds live read on every closure scope" };
    }
    if (closure.every((s) => allowlist.some((e) => e.from === s && (e.to === targetScopeId || e.to === resource || e.to === "*")))) {
      return { allowed: true, basis: "human-reviewed disclosure allowlist" };
    }
    if (shape.shape === "im-group") {
      return {
        allowed: false,
        basis: targetScope
          ? "cross-scope disclosure to a GROUP audience without an explicit review record"
          : "GROUP-shaped target has no resolvable scope; its audience is undeterminable",
      };
    }
    if (shape.shape === "repo-write") {
      return { allowed: false, basis: "cross-scope disclosure to a repository (public) audience without an explicit review record" };
    }
    if (shape.shape === "mail-send") {
      return { allowed: false, basis: "mail payload closure leaves the effect's scope and the recipients' audience is undeterminable; a disclosure allowlist record is required" };
    }
    if (shape.shape === "calendar-write") {
      return { allowed: false, basis: "calendar payload closure leaves the effect's scope and the calendar readers are undeterminable; a disclosure allowlist record is required" };
    }
    return { allowed: false, basis: "target audience undeterminable while the payload closure leaves its own scope" };
  };
  if (shape.shape !== "none") {
    const decision = adjudicate();
    return { needed: true, ...decision, closure, shape: shape.shape };
  }
  if (external.length === 0) {
    return {
      needed: false,
      allowed: true,
      basis: "the payload closure never leaves the effect's own scope",
      closure,
      shape: shape.shape,
    };
  }
  const decision = adjudicate();
  return { needed: true, ...decision, closure, shape: shape.shape };
}

/** Audit trail for a blocked delivery — the CALLER owns the transaction. */
export function recordCp4Block(db, { payloadObjectId = null, targetScopeId = null, targetResource = null, closure, basis, now }) {
  writeAudit(db, {
    code: "cp4_recipient_scope_leak_blocked",
    details: {
      payload_object_id: payloadObjectId,
      target_scope_id: targetScopeId,
      target_resource: targetResource,
      closure,
      reason: basis,
    },
    now,
  });
  // The stream event anchors to the payload's HOME scope (always a real
  // row when the payload exists); a proposal-time refusal has no row yet,
  // and a target scope that does not exist has an undeterminable
  // audience — stream_events.scope_id must reference an existing scope.
  const streamScopeId = Array.isArray(closure) && closure.length > 0 ? closure[0] : null;
  if (streamScopeId !== null && db.prepare("SELECT 1 FROM scopes WHERE id=?").get(streamScopeId) !== undefined) {
    writeStreamEvent(db, {
      scopeId: streamScopeId,
      eventType: "audit_alert",
      entityId: `cp4:${payloadObjectId ?? targetResource ?? "proposal"}`,
      entityVersion: 1,
      payload: { blocked: true, target_scope_id: targetScopeId, target_resource: targetResource, closure_size: closure.length },
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
