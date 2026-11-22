// Host-side calendar adapter runtime (Unit 5.4; spec 03 section 4, 06
// sections 5 and 7). Read side: a fail-closed CalDAV pull whose parsed
// events feed the morning briefing. Write side: calendar.write is NEVER part
// of a briefing — it is an approval-gated effect whose action pins the remote
// ETag as expected_head; the dispatcher's precondition re-reads the head
// inside the CAS window, and a server 412 keeps the write from ever applying
// silently. A changed head means re-approval (reproposeHeadChanged on READY,
// reproposeAfter412 on the FAILED race), never an overwrite.
//
// TZID handling: the child returns naive wall-clock components plus the
// event's TZID; the host re-anchors floating/local times through
// quiet-time.mjs's IANA machinery so America/New_York DST jumps land on the
// same wall clock the owner sees.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { ensureScope, scopeId } from "./ingress.mjs";
import { insertObjectRow } from "./objects.mjs";
import { createCredentialService } from "./credentials.mjs";
import { buildSafeChildEnv } from "./model-call.mjs";
import { parseIcsEvents } from "./calendar-ics.mjs";
import { wallClockInstant } from "./quiet-time.mjs";
import {
  splitBusinessKey,
  unescapeKeyComponent,
  proposeEffect,
  extraFieldsOfAction,
} from "./effects.mjs";

const CALENDAR_CHILD = join(dirname(fileURLToPath(import.meta.url)), "upstream-calendar-child.mjs");

export class CalendarAdapterError extends Error {}

export function calendarDomainKey(name) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(n)) {
    throw new CalendarAdapterError(`calendar name ${JSON.stringify(name)} must be a short slug`);
  }
  return `dm:calendar:${n}`;
}

export function calendarScopeId(name) {
  return scopeId(calendarDomainKey(name));
}

export function ensureCalendarScope(db, { name, ownerId, policyVersion }) {
  return ensureScope(db, {
    ownerId,
    kind: "owner_dm",
    domainKey: calendarDomainKey(name),
    channel: "caldav",
    conversationId: String(name).toLowerCase(),
    policyVersion,
  });
}

function createCalendarChildRunner({ nodePath = process.execPath, childPath = CALENDAR_CHILD } = {}) {
  return function runCalendarChild(input) {
    const r = spawnSync(nodePath, [childPath], {
      input: JSON.stringify(input),
      env: buildSafeChildEnv(),
      encoding: "utf8",
      timeout: (input?.timeoutMs ?? 30000) + 15000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) {
      return { ok: false, kind: "local", error: `calendar child failed to run: ${r.error.message}` };
    }
    try {
      return JSON.parse(r.stdout);
    } catch {
      return { ok: false, kind: "local", error: `calendar child produced unparseable output (status ${r.status})` };
    }
  };
}

function resolveCalendarCredential(db) {
  const credentials = createCredentialService(db);
  const resolved = credentials.resolve("calendar");
  if (!resolved.ok) return resolved;
  const v = String(resolved.value ?? "");
  if (v.startsWith("{")) {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed?.user === "string" && typeof parsed?.password === "string") {
        return { ok: true, user: parsed.user, password: parsed.password };
      }
    } catch {}
    return { ok: false, reason: "calendar credential slot JSON lacks user/password" };
  }
  const idx = v.indexOf(":");
  if (idx <= 0) return { ok: false, reason: "calendar credential slot value must be user:password or JSON" };
  return { ok: true, user: v.slice(0, idx), password: v.slice(idx + 1) };
}

// TZID re-anchor: a naive wall-clock reading becomes the true instant under
// the event's IANA zone; UTC-suffixed values are already absolute.
function anchoredMs(ms, timezone) {
  if (!timezone || timezone === "UTC") return ms;
  try {
    // parseIcsDate read the wall clock AS IF it were UTC; re-read those same
    // wall components through the zone (wallClockInstant resolves the zone's
    // actual offset, DST included).
    const iso = new Date(ms).toISOString(); // "2026-11-23T10:00:00.000Z" (naive)
    const localDate = iso.slice(0, 10);
    const hhmm = iso.slice(11, 16);
    return wallClockInstant(localDate, hhmm, timezone);
  } catch {
    return ms;
  }
}

/**
 * Read pass: REPORT the collection, parse every .ics, persist each event as
 * an ACL-locked objects(kind='calendar_event') row keyed by (scope, uid).
 * Fail-closed ladder mirrors the mail adapter; a failed read is local, the
 * next pass retries. Re-pulls REPLACE the stored event row (same uid) so the
 * ETag stays current — a changed ETag is exactly what makes a stale write
 * approval detectable.
 */
export function pullCalendarEvents(db, stateDir, {
  now,
  calendar: calendarConfig,
  runner = null,
  timeoutMs = 30000,
  ownerId = null,
  policyVersion = "pv1",
}) {
  const auditSkip = (reason) => {
    try {
      writeAudit(db, { code: "calendar_pull_skipped", details: { reason }, now });
    } catch {}
  };
  if (calendarConfig?.caldavUrl == null) {
    return { skipped: "calendar.caldavUrl is null; zero CalDAV calls (fail closed)" };
  }
  if (calendarConfig.allowRealCalendarRead !== true) {
    auditSkip("calendar.allowRealCalendarRead is false (loopback included)");
    return { skipped: "calendar.allowRealCalendarRead is false; zero CalDAV calls" };
  }
  const allowed = Array.isArray(calendarConfig.allowedCalendars) ? calendarConfig.allowedCalendars : [];
  const calendarName = allowed[0] ?? "default";
  const cred = resolveCalendarCredential(db);
  if (!cred.ok) {
    auditSkip(`calendar credential slot not resolvable (${cred.reason})`);
    return { skipped: `calendar credential slot not resolvable (${cred.reason}); zero CalDAV calls` };
  }
  const runChild = runner ?? createCalendarChildRunner();
  const outcome = runChild({
    mode: "calendar.read",
    url: calendarConfig.caldavUrl,
    username: cred.user,
    password: cred.password,
    timeoutMs,
  });
  if (outcome.ok !== true) {
    try {
      writeAudit(db, { code: "calendar_pull_failed", details: { kind: outcome.kind, status: outcome.status ?? null, error: String(outcome.error ?? "").slice(0, 200) }, now });
    } catch {}
    return { failed: `calendar pull failed (${outcome.kind}): ${String(outcome.error ?? "").slice(0, 160)}` };
  }
  const scopeRef = ensureCalendarScope(db, { name: calendarName, ownerId: ownerId ?? "prn:calendar:owner", policyVersion });
  const stored = [];
  for (const entry of outcome.entries.slice(0, 200)) {
    if (!entry.ics) continue;
    for (const ev of parseIcsEvents(entry.ics)) {
      if (!ev.uid) continue;
      const meta = {
        uid: ev.uid,
        summary: ev.summary ?? "(untitled)",
        dtStart: anchoredMs(ev.dtStart ?? 0, ev.timezone),
        rawDtStart: ev.dtStart ?? null,
        dtEnd: anchoredMs(ev.dtEnd ?? 0, ev.timezone),
        timezone: ev.timezone ?? null,
        rrule: ev.rrule ?? null,
        etag: entry.etag,
        href: entry.href,
        attendees: ev.attendees ?? [],
      };
      const existing = db
        .prepare("SELECT id FROM objects WHERE scope_id=? AND kind='calendar_event' AND metadata_json LIKE ?")
        .get(scopeRef.id, `%"uid":"${ev.uid.replace(/"/g, "")}"%`);
      if (existing) {
        // Replace-in-place via a fresh version row: the old row is marked
        // expired, the new one carries the current ETag.
        withTx(db, () => {
          db.prepare("UPDATE objects SET status='expired' WHERE id=? AND status='active'").run(existing.id);
        });
      }
      const row = insertObjectRow(db, {
        scopeId: scopeRef.id,
        kind: "calendar_event",
        sourceUri: `caldav:${calendarName}:${ev.uid}`,
        sourceActor: "host-calendar",
        content: JSON.stringify({ ...meta, icsBytes: Buffer.byteLength(entry.ics, "utf8") }),
        observedAt: now,
        requiredScopeIds: [scopeRef.id],
        metadata: meta,
      });
      stored.push(row.id);
    }
  }
  try {
    writeAudit(db, { code: "calendar_pull_stored", details: { calendar: calendarName, events: stored.length }, now });
  } catch {}
  return { fetched: outcome.entries.length, stored: stored.length, scopeId: scopeRef.id };
}

/**
 * The calendar.write transport inside the adapter registry. The action pins
 * expected_head = the ETag the human approved against; submit() carries
 * If-Match, and a 412 is kind "precondition" — the write definitively did
 * not happen and the FAILED effect names head_changed for re-approval.
 */
export function createCalendarUpstream(db, {
  calendar: calendarConfig,
  now = () => Date.now(),
  runner = null,
} = {}) {
  const runChild = runner ?? createCalendarChildRunner();

  const gate = () => {
    if (calendarConfig?.caldavUrl == null) return { wired: false, reason: "calendar.caldavUrl is null; zero transports" };
    if (calendarConfig.allowRealCalendarWrite !== true) return { wired: true, authorized: false, reason: "calendar.allowRealCalendarWrite is false; zero bytes" };
    const cred = resolveCalendarCredential(db);
    if (!cred.ok) return { wired: true, authorized: false, reason: `calendar credential slot not resolvable (${cred.reason})` };
    return { wired: true, authorized: true, cred };
  };

  return {
    label: "calendar-upstream(caldav-child)",
    canHandle(resource) {
      return typeof resource === "string" && resource.startsWith("caldav:");
    },
    gateSummary: gate,
    // The dispatcher's precondition source: the CURRENT remote ETag of the
    // approved href (06 section 6 head re-check inside the CAS window).
    lookupHead({ targetResource }) {
      if (!this.canHandle(targetResource)) return { ok: false, reason: "not a caldav target" };
      const g = gate();
      if (!g.wired || g.authorized !== true) return { ok: false, reason: g.reason };
      const href = String(targetResource.slice("caldav:".length));
      const out = runChild({
        mode: "calendar.head",
        url: calendarConfig.caldavUrl,
        username: g.cred.user,
        password: g.cred.password,
        href,
        timeoutMs: Number.isInteger(calendarConfig.timeoutMs) ? calendarConfig.timeoutMs : 30000,
      });
      if (!out.ok) return { ok: false, reason: out.error ?? "head lookup failed" };
      if (!out.found) return { ok: false, reason: `resource ${href} no longer exists (HTTP 404)` };
      return { ok: true, head: out.etag ?? "" };
    },
    submit({ businessKey, idempotencyKey, operation: opRow, now: submitNow, effectId = null }) {
      const auditRefusal = (reason) => {
        try {
          writeAudit(db, { code: "adapter_refused", details: { operation: opRow?.operation, reason, effect_id: effectId }, now: now() });
        } catch {}
      };
      const g = gate();
      if (!g.wired || g.authorized !== true) {
        auditRefusal(g.reason);
        return { status: "failed_local", error: `local_error: calendar adapter refused: ${g.reason}` };
      }
      let action = {};
      try {
        action = JSON.parse(opRow?.action_json ?? "{}");
      } catch {
        return { status: "failed_local", error: "local_error: calendar adapter refused: action_json is not parseable" };
      }
      // canonicalActionJson spreads operationIntent.extra at the TOP level
      // of the action — recover the extra fields the same way every other
      // adapter does.
      const extra = extraFieldsOfAction(action);
      const href = typeof extra.href === "string" ? extra.href : null;
      if (!href || !href.startsWith("/")) {
        return { status: "failed_local", error: "local_error: calendar adapter refused: no collection-relative href" };
      }
      if (action.expected_head == null || String(action.expected_head).length === 0) {
        return { status: "failed_local", error: "local_error: calendar adapter refused: no expected_head ETag (zero silent overwrites)" };
      }
      const method = extra.method === "DELETE" ? "DELETE" : "PUT";
      const ics = typeof extra.ics === "string" ? extra.ics : "";
      if (method === "PUT" && ics.trim().length === 0) {
        return { status: "failed_local", error: "local_error: calendar adapter refused: no ics content" };
      }
      const out = runChild({
        mode: "calendar.write",
        url: calendarConfig.caldavUrl,
        username: g.cred.user,
        password: g.cred.password,
        method,
        href,
        etag: String(action.expected_head),
        ics,
        timeoutMs: Number.isInteger(calendarConfig.timeoutMs) ? calendarConfig.timeoutMs : 30000,
      });
      if (out.ok === true) {
        return { status: "succeeded", externalId: `${method}:${href}@${out.etag ?? ""}` };
      }
      if (out.kind === "precondition") {
        // The write did NOT apply. The FAILED effect's last_error names the
        // head change; the daemon's calendar sweep re-proposes against the
        // fresh ETag for re-approval.
        return { status: "failed_remote", error: out.error ?? "head_changed: 412 precondition failed" };
      }
      if (out.kind === "unknown") {
        return { status: "unknown", error: out.error ?? "calendar write outcome unknown (request fully sent)" };
      }
      if (out.kind === "remote") {
        return { status: "failed_remote", error: out.error ?? "calendar write refused by server" };
      }
      return { status: "failed_local", error: `local_error: ${out.error ?? "calendar child local failure"}` };
    },
  };
}

/**
 * The 412 re-proposal (03 section 4: "遇 412 ... 走 reproposeHeadChanged 作
 * 废旧卡提示重审，零静默覆盖"). The FAILED effect is cancelled, the task
 * parks again, and a NEW approval card pins the CURRENT ETag so the human
 * re-approves with fresh facts. The old card stays in history; nothing was
 * ever written remotely.
 */
export function reproposeAfter412(db, stateDir, {
  now,
  effectId,
  currentHead,
  runner = null,
  actorId = "daemon-dispatcher",
  expiresTtlMs = 4 * 3600 * 1000,
}) {
  if (typeof currentHead !== "string" || currentHead.length === 0) {
    throw new CalendarAdapterError("reproposeAfter412 needs the real current ETag from the transport");
  }
  const old = db.prepare("SELECT * FROM effects WHERE id=?").get(effectId);
  if (!old) throw new CalendarAdapterError(`effect ${effectId} not found`);
  if (old.state !== "FAILED") {
    throw new CalendarAdapterError(`effect ${effectId} is ${old.state}; only a FAILED head_changed effect can be re-proposed here`);
  }
  if (!/^head_changed:/.test(old.last_error ?? "")) {
    throw new CalendarAdapterError(`effect ${effectId} did not fail on a head change (${old.last_error})`);
  }
  const parts = splitBusinessKey(old.business_key);
  const oldAction = JSON.parse(old.action_json);
  const newNaturalKey = `${unescapeKeyComponent(parts.naturalKey)}~head2`;
  const changed = db
    .prepare("UPDATE effects SET state='CANCELLED', last_error='head_changed reproposed', updated_at=? WHERE id=? AND state='FAILED'")
    .run(now, effectId).changes;
  if (changed !== 1) {
    throw new CalendarAdapterError(`effect ${effectId} left FAILED before the 412 re-proposal`);
  }
  const taskParked = db
    .prepare("UPDATE tasks SET state='WAITING_APPROVAL', updated_at=? WHERE id=? AND state='WAITING_EFFECT'")
    .run(now, old.task_id).changes;
  writeAudit(db, {
    code: "calendar_head_changed_reproposed",
    taskId: old.task_id,
    actorId,
    details: { old_effect_id: effectId, pinned_head: oldAction.expected_head, current_head: currentHead, new_natural_key: newNaturalKey, task_reparked: taskParked === 1 },
    now,
  });
  writeStreamEvent(db, {
    scopeId: old.scope_id,
    eventType: "approval_changed",
    entityId: `effect:${effectId}`,
    entityVersion: 2,
    payload: { state: "CANCELLED", reason: "head_changed_412", current_head: currentHead },
    now,
  });
  const proposed = proposeEffect(db, stateDir, {
    now,
    taskId: old.task_id,
    attemptId: old.attempt_id,
    effectType: "calendar",
    domainKey: unescapeKeyComponent(parts.domainKey),
    naturalKey: newNaturalKey,
    operationIntent: {
      targetResource: oldAction.target_resource,
      operation: oldAction.operation,
      contentHash: oldAction.content_hash,
      attachmentHash: oldAction.attachment_hash ?? null,
      expectedHead: currentHead,
      evidenceManifestHash: oldAction.evidence_manifest_hash,
      extra: { ...extraFieldsOfAction(oldAction), reproposed_from: effectId },
    },
    retryMode: old.retry_mode,
    provider: old.provider,
    resource: old.resource,
    requiresApproval: true,
    approverPrincipalId: db.prepare("SELECT approver_id FROM approvals WHERE effect_id=?").get(effectId)?.approver_id,
    expiresAt: now + expiresTtlMs,
  });
  return {
    oldEffectId: effectId,
    newEffectId: proposed.effectId,
    newApprovalId: proposed.approvalId,
    newActionHash: proposed.actionHash,
    pinnedHead: currentHead,
    taskReparked: taskParked === 1,
  };
}
