// Ingress per 06 section 3.1. Signature verification, time-window checks and
// platform event-id trust belong to source adapters; Phase 2 adapters are
// fake/recorded, so receiveEvent() takes already-verified inputs and owns
// exactly the durable part: map principal + scope, persist the payload object,
// write inbox + admission audit + stream event in ONE transaction, and only
// then return — the return IS the authorization to ACK the source ("ACK 必须
// 发生在事务提交之后"). Returning duplicate=true is also a success: repeated
// events never create new objects and never fail the source.
//
// Sources without a stable provider event id dedup on the SHA-256 of the
// documented canonical envelope (06 section 1.1): the digest becomes the
// source_event_id, so two legal-but-identical deliveries collapse and two
// different payloads never do.

import { withTx } from "./db/tx.mjs";
import { putObjectContent, insertObjectRow, objectRelPath } from "./objects.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import {
  canonicalEnvelope,
  dispatchKeyFromEnvelope,
  dispatchKeyFromProviderId,
  escapeComponent,
} from "./keys.mjs";
import { crashpoint } from "./testing/crashpoints.mjs";

export function principalId(platform, subject) {
  return `prn:${escapeComponent(platform)}:${escapeComponent(subject)}`;
}

export function scopeId(domainKey) {
  return `scp:${escapeComponent(domainKey, { allowSlash: true })}`;
}

const KIND_BY_PREFIX = [
  ["user:", "owner_dm"],
  ["dm:", "owner_dm"],
  ["group:", "group"],
  ["repo:", "repo"],
  ["service:", "service"],
];

export function kindForDomainKey(domainKey) {
  for (const [prefix, kind] of KIND_BY_PREFIX) {
    if (domainKey.startsWith(prefix)) return kind;
  }
  throw new Error(`domain_key shape not recognized: ${domainKey}`);
}

export function ensurePrincipal(db, { platform, subject }) {
  const id = principalId(platform, subject);
  const existing = db.prepare("SELECT id FROM principals WHERE id=?").get(id);
  if (!existing) {
    db.prepare("INSERT INTO principals(id, platform, platform_subject) VALUES (?,?,?)").run(
      id,
      platform,
      subject,
    );
  }
  return { id };
}

export function ensureScope(db, { ownerId, kind, domainKey, channel, conversationId = null, repoId = null, policyVersion }) {
  const mapped = kindForDomainKey(domainKey);
  if (mapped !== kind) {
    throw new Error(`scope kind ${kind} does not match domain_key shape ${domainKey} (${mapped})`);
  }
  const id = scopeId(domainKey);
  const existing = db.prepare("SELECT id, epoch, acl_version FROM scopes WHERE id=?").get(id);
  if (!existing) {
    db.prepare(
      `INSERT INTO scopes(id, owner_id, kind, domain_key, channel, conversation_id, repo_id, epoch, acl_version, policy_version, paused)
       VALUES (?,?,?,?,?,?,?, 1, 1, ?, 0)`,
    ).run(id, ownerId, kind, domainKey, channel, conversationId, repoId, policyVersion);
    return { id, created: true, epoch: 1, aclVersion: 1 };
  }
  return { id, created: false, epoch: existing.epoch, aclVersion: existing.acl_version };
}

export function receiveEvent(db, stateDir, {
  now,
  source,
  sourceEventId = null,
  sourceKind = "message",
  principal,
  scope,
  threadKey,
  priority = 0,
  policyVersion,
  payload,
  verdict,
  extraRequiredScopeIds = [],
}) {
  if (!["ADMIT", "DROP", "OBSERVE"].includes(verdict)) {
    throw new Error(`verdict must be ADMIT/DROP/OBSERVE, got ${verdict}`);
  }
  const content = typeof payload === "string" ? payload : JSON.stringify(payload);
  // The immutable file is durable BEFORE the transaction activates it; a
  // crash between the two leaves an unreferenced file for GC, never a
  // dangling reference (06 section 9, last row).
  crashpoint("ingress:before-file");
  const stored = putObjectContent(stateDir, content);
  const payloadSha256 = stored.contentHash;

  let dedupId = sourceEventId;
  let dedupKind = "provider_event_id";
  if (!dedupId) {
    dedupId = dispatchKeyFromEnvelope(
      canonicalEnvelope({
        source,
        source_kind: sourceKind,
        received_at: now,
        principal_platform: principal.platform,
        principal_subject: principal.subject,
        scope_kind: scope.kind,
        domain_key: scope.domainKey,
        thread_key: threadKey,
        priority,
        payload_sha256: payloadSha256,
      }),
    );
    dedupKind = "canonical_envelope_digest";
  }

  crashpoint("ingress:before-txn");
  const result = withTx(db, () => {
    const principalRef = ensurePrincipal(db, principal);
    const scopeRef = ensureScope(db, { ...scope, ownerId: principalRef.id, policyVersion });
    const existing = db
      .prepare("SELECT id, state, verdict FROM inbox WHERE source=? AND source_event_id=?")
      .get(source, dedupId);
    if (existing) {
      writeAudit(db, {
        code: "ingress_duplicate",
        eventId: existing.id,
        actorId: principalRef.id,
        details: { source, source_event_id: dedupId, dedup: dedupKind },
        now,
      });
      return {
        duplicate: true,
        inboxId: existing.id,
        state: existing.state,
        objectId: null,
        committedAt: now,
      };
    }
    const inboxId = `inb:${escapeComponent(source)}:${escapeComponent(dedupId, { allowSlash: true })}`;
    const object = insertObjectRow(db, {
      scopeId: scopeRef.id,
      kind: "event_payload",
      sourceUri: `${source}:${dedupId}`,
      sourceActor: principalRef.id,
      contentHash: stored.contentHash,
      storageRef: stored.storageRef,
      status: "active",
      observedAt: now,
      metadata: { source, source_kind: sourceKind, dedup: dedupKind },
      requiredScopeIds: [scopeRef.id, ...extraRequiredScopeIds],
    });
    const state = verdict === "ADMIT" ? "PENDING" : "DONE";
    db.prepare(
      `INSERT INTO inbox(id, source, source_event_id, principal_id, scope_id, payload_object_id,
        thread_key, priority, policy_version, verdict, state, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      inboxId,
      source,
      dedupId,
      principalRef.id,
      scopeRef.id,
      object.id,
      threadKey,
      priority,
      policyVersion,
      verdict,
      state,
      now,
    );
    writeAudit(db, {
      code: "ingress_received",
      eventId: inboxId,
      actorId: principalRef.id,
      details: { source, source_event_id: dedupId, verdict, dedup: dedupKind },
      now,
    });
    writeStreamEvent(db, {
      scopeId: scopeRef.id,
      eventType: "inbox_changed",
      entityId: `inbox:${inboxId}`,
      entityVersion: 1,
      payload: { verdict, state, thread_key: threadKey },
      now,
    });
    crashpoint("ingress:inside-txn");
    return {
      duplicate: false,
      inboxId,
      state,
      objectId: object.id,
      committedAt: now,
    };
  });
  // Past this line the transaction has committed; the caller may ACK.
  crashpoint("ingress:after-commit");
  return result;
}

export function inboxRow(db, inboxId) {
  return db.prepare("SELECT * FROM inbox WHERE id=?").get(inboxId);
}

// dispatch_key for an inbox row: {source}:{provider_event_id} in the escaped,
// lowercased form of 06 section 1.1 (also the router's plan-stable key).
export function dispatchKeyForInbox(row) {
  return dispatchKeyFromProviderId(row.source, row.source_event_id);
}
