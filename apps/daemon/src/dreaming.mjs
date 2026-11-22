// L3 Dreaming orchestration loop (Unit 5.4 via D-95; spec 01 section 4,
// 03 section 4, phase5-kickoff plan §5.4). A low-frequency housekeeping pass
// that runs ONLY inside the configured quiet hours and ONLY under a live,
// independent purpose='summary' budget reservation:
//   - archives every candidate/active/conflicted fact whose expires_at has
//     passed (status 'expired' — a design terminal, never a delete);
//   - proposes MERGE SUGGESTIONS for same-scope, same-factKey-family clean
//     candidates — suggestions only: nothing auto-activates, forbidden
//     categories (NEVER_ACTIVATABLE_CATEGORIES) are never touched, and
//     scopes are never mixed (the query is per-scope by construction);
//   - raises governance alerts for conflicted facts that have waited past
//     the adjudication window, for the console (Unit 5.5) to resolve.
// The scan is deterministic host code: no model call, no cross-scope reads.
// A reservation that cannot be created (day budget frozen/exhausted) skips
// the pass with the reason on record — the independent budget IS the gate.

import { createHash } from "node:crypto";
import { withTx } from "./db/tx.mjs";
import { writeAudit, writeStreamEvent } from "./audit.mjs";
import { insertObjectRow } from "./objects.mjs";
import { NEVER_ACTIVATABLE_CATEGORIES } from "./memory.mjs";
import { inQuietHours } from "./quiet-time.mjs";

export class DreamingError extends Error {}

const DREAMING_SUGGESTION_KIND = "dreaming_suggestion";
const DEFAULT_CONFLICT_ALERT_AGE_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_SCAN_UPPER_MICROUSD = 1000;

function factKeyFamily(factKey) {
  const k = String(factKey ?? "");
  const cut = Math.min(...[k.indexOf(":"), k.indexOf("."), k.indexOf(" ")].filter((n) => n > 0));
  return Number.isFinite(cut) && cut > 0 ? k.slice(0, cut).toLowerCase() : k.toLowerCase();
}

/**
 * One dreaming pass. `now` is caller-supplied so suites can move the clock
 * into and out of the quiet window; no force flag exists — the quiet gate is
 * the mechanism, not a policy memo.
 */
export function runDreamingLoop(db, stateDir, {
  now,
  quietHours,
  ledger = null,
  modelProvider = "deepseek",
  conflictAlertAgeMs = DEFAULT_CONFLICT_ALERT_AGE_MS,
  scanUpperMicrousd = DEFAULT_SCAN_UPPER_MICROUSD,
  maxSuggestionsPerPass = 20,
}) {
  if (!quietHours || typeof quietHours !== "object") {
    return { skipped: "no quietHours configured; the dreaming loop never runs without an explicit window" };
  }
  if (!inQuietHours(now, quietHours)) {
    return { skipped: "outside quiet hours; the dreaming loop runs only inside the window" };
  }
  // The independent purpose='summary' budget: a live reservation is the
  // permission slip. Without a ledger (or when the day account is frozen or
  // full) the pass skips — never runs unaccounted.
  let reservationId = null;
  if (ledger) {
    try {
      const dayAcc = ledger.ensureDayAccount({ now }).accountId;
      const res = ledger.reserve({
        requestKey: `dreaming:${new Date(now).toISOString().slice(0, 13)}:${createHash("sha256").update(String(now)).digest("hex").slice(0, 8)}`,
        taskId: null,
        purpose: "summary",
        provider: modelProvider,
        priceVersion: "catalog-v1",
        upperMicrousd: scanUpperMicrousd,
        accounts: [{ accountId: dayAcc, amountMicrousd: scanUpperMicrousd }],
        now,
      });
      reservationId = res.reservationId;
    } catch (e) {
      withTx(db, () => {
        writeAudit(db, {
          code: "dreaming_budget_refused",
          details: { reason: String(e.message).slice(0, 200) },
          now,
        });
      });
      return { skipped: `summary-purpose reservation refused (${String(e.message).slice(0, 120)}); the pass runs only under its independent budget` };
    }
  }
  const out = { expired: [], mergeSuggestions: [], conflictAlerts: [], reservationId };
  try {
    // 1. Expiry archive: expires_at <= now on any live status.
    const expiredRows = db
      .prepare(
        `SELECT id, scope_id FROM objects
          WHERE status IN ('candidate','active','conflicted')
            AND expires_at IS NOT NULL AND expires_at<=?
          LIMIT 500`,
      )
      .all(now);
    for (const r of expiredRows) {
      withTx(db, () => {
        const changed = db
          .prepare("UPDATE objects SET status='expired' WHERE id=? AND status IN ('candidate','active','conflicted')")
          .run(r.id).changes;
        if (changed !== 1) return;
        writeAudit(db, { code: "memory_dreaming_expired", details: { object_id: r.id }, now });
        writeStreamEvent(db, {
          scopeId: r.scope_id,
          eventType: "memory_changed",
          entityId: `object:${r.id}`,
          entityVersion: 2,
          payload: { status: "expired", cause: "dreaming_expiry_archive" },
          now,
        });
        out.expired.push(r.id);
      });
    }

    // 2. Merge suggestions: same scope, same factKey family, clean
    //    candidates only. The suggestion object is data for the governance
    //    console — activation stays a human decision.
    const scopes = db
      .prepare("SELECT DISTINCT scope_id FROM objects WHERE kind='memory_fact' AND status='candidate'")
      .all();
    let suggestions = 0;
    for (const s of scopes) {
      if (suggestions >= maxSuggestionsPerPass) break;
      const candidates = db
        .prepare(
          `SELECT id, metadata_json, observed_at FROM objects
            WHERE scope_id=? AND kind='memory_fact' AND status='candidate'
            ORDER BY observed_at ASC LIMIT 200`,
        )
        .all(s.scope_id);
      const families = new Map();
      for (const c of candidates) {
        let meta;
        try {
          meta = JSON.parse(c.metadata_json || "{}");
        } catch {
          continue;
        }
        if (Array.isArray(meta.quarantined_reasons) && meta.quarantined_reasons.length > 0) continue;
        if (meta.never_activatable === true) continue;
        if (NEVER_ACTIVATABLE_CATEGORIES.includes(meta.category)) continue;
        const family = factKeyFamily(meta.factKey);
        if (!families.has(family)) families.set(family, []);
        families.get(family).push({ id: c.id, factKey: meta.factKey ?? null, category: meta.category ?? null });
      }
      for (const [family, members] of families) {
        if (suggestions >= maxSuggestionsPerPass) break;
        if (members.length < 2) continue;
        const objectIds = members.slice(0, 8).map((m) => m.id);
        // Idempotent: one open suggestion per (scope, family, membership).
        const fp = createHash("sha256").update(JSON.stringify([s.scope_id, family, objectIds])).digest("hex").slice(0, 16);
        const dupe = db
          .prepare("SELECT id FROM objects WHERE kind=? AND metadata_json LIKE ? AND status IN ('candidate','active')")
          .get(DREAMING_SUGGESTION_KIND, `%"fingerprint":"${fp}"%`);
        if (dupe) continue;
        withTx(db, () => {
          const row = insertObjectRow(db, {
            scopeId: s.scope_id,
            kind: DREAMING_SUGGESTION_KIND,
            sourceUri: `dreaming:${fp}`,
            sourceActor: "host-dreaming",
            content: JSON.stringify({ type: "merge_candidates", factKeyFamily: family, members }),
            observedAt: now,
            requiredScopeIds: [s.scope_id],
            metadata: {
              suggestionType: "merge_candidates",
              factKeyFamily: family,
              objectIds,
              fingerprint: fp,
              neverActivates: true,
            },
          });
          writeAudit(db, {
            code: "memory_dreaming_merge_proposed",
            details: { suggestion_id: row.id, scope_id: s.scope_id, family, members: objectIds.length },
            now,
          });
          writeStreamEvent(db, {
            scopeId: s.scope_id,
            eventType: "memory_changed",
            entityId: `object:${row.id}`,
            entityVersion: 1,
            payload: { suggestion: "merge_candidates", family, member_count: members.length },
            now,
          });
          out.mergeSuggestions.push(row.id);
          suggestions += 1;
        });
      }
    }

    // 3. Governance alerts: conflicted facts older than the adjudication
    //    window, per scope (never cross-scope mixed).
    const staleConflicted = db
      .prepare(
        `SELECT id, scope_id, observed_at, metadata_json FROM objects
          WHERE kind='memory_fact' AND status='conflicted' AND observed_at<=?
          ORDER BY observed_at ASC LIMIT 100`,
      )
      .all(now - conflictAlertAgeMs);
    for (const c of staleConflicted) {
      const fp = createHash("sha256").update(JSON.stringify(["conflicted-alert", c.id])).digest("hex").slice(0, 16);
      const dupe = db
        .prepare("SELECT id FROM objects WHERE kind=? AND metadata_json LIKE ? AND status IN ('candidate','active')")
        .get(DREAMING_SUGGESTION_KIND, `%"fingerprint":"${fp}"%`);
      if (dupe) continue;
      withTx(db, () => {
        const row = insertObjectRow(db, {
          scopeId: c.scope_id,
          kind: DREAMING_SUGGESTION_KIND,
          sourceUri: `dreaming:${fp}`,
          sourceActor: "host-dreaming",
          content: JSON.stringify({ type: "conflicted_adjudication_needed", objectId: c.id, observedAt: c.observed_at }),
          observedAt: now,
          requiredScopeIds: [c.scope_id],
          metadata: { suggestionType: "conflicted_adjudication_needed", objectId: c.id, fingerprint: fp },
        });
        writeAudit(db, {
          code: "memory_dreaming_conflict_alert",
          details: { suggestion_id: row.id, scope_id: c.scope_id, conflicted_object: c.id, waiting_ms: now - c.observed_at },
          now,
        });
        writeStreamEvent(db, {
          scopeId: c.scope_id,
          eventType: "audit_alert",
          entityId: `object:${row.id}`,
          entityVersion: 1,
          payload: { alert: "conflicted_memory_unadjudicated", object_id: c.id },
          now,
        });
        out.conflictAlerts.push(row.id);
      });
    }

    // The deterministic scan used no model tokens: settle the reservation at
    // actual 0 with the basis on record (never a fabricated usage number).
    if (ledger && reservationId) {
      try {
        ledger.settle({
          reservationId,
          usage: { actualMicrousd: 0, source: "dreaming-deterministic-scan", basis: "no model call in the Phase 5 batch 2 dreaming loop" },
          now,
          actorId: "host-dreaming",
        });
      } catch {}
    }
    return out;
  } catch (e) {
    return { failed: String(e.message).slice(0, 200), ...out };
  }
}
