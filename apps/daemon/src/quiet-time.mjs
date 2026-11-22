// Quiet hours and IANA wall-clock time helpers (Unit 5.4; spec 03 section 4,
// 06 section 7: "Cron和静默期必须显式带时区", "错过周期默认合并为一次补跑并
// 记录 missed_count"). Wall-clock arithmetic never uses Date's local zone:
// every conversion goes through Intl with the configured IANA zone, so
// Asia/Hong_Kong and a DST zone like America/New_York both land on the same
// wall-clock instant the owner set, across DST jumps.

import { createHash } from "node:crypto";

export class QuietTimeError extends Error {}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const PARTS_CACHE = new Map();

function zoneParts(ms, timeZone) {
  const cacheKey = `${Math.floor(ms / 60000)}|${timeZone}`;
  const hit = PARTS_CACHE.get(cacheKey);
  if (hit) return hit;
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  if (PARTS_CACHE.size > 4096) PARTS_CACHE.clear();
  PARTS_CACHE.set(cacheKey, parts);
  return parts;
}

// The canonical "local wall clock as a sortable string" for a moment.
export function wallClock(ms, timeZone) {
  const p = zoneParts(ms, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function utcMsForWall(localDate, hh, mm, ss, timeZone) {
  // Two-pass resolve: guess UTC = wall time read as UTC, then correct by the
  // offset the zone reports for that guess. Handles fixed-offset zones and
  // DST dates (the second pass lands on the right side of the jump because
  // the offset near a wall time that does not exist snaps to the closest
  // transition; 06 does not ask us to define non-existent wall times, and
  // the ±30min probe below keeps recurring schedules stable across jumps).
  let guess = Date.parse(`${localDate}T${hh}:${mm}:${ss}Z`);
  for (let i = 0; i < 3; i += 1) {
    const p = zoneParts(guess, timeZone);
    const asUtc = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const diff = Date.parse(`${localDate}T${hh}:${mm}:${ss}Z`) - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/**
 * The next UTC instant at or after `afterMs` whose wall clock in `timeZone`
 * equals localDate + hh:mm. Used by wall-clock recurrences and quiet-hour
 * exits.
 */
export function wallClockInstant(localDate, hhmm, timeZone) {
  const m = HHMM_RE.exec(hhmm ?? "");
  if (!m) throw new QuietTimeError(`time ${JSON.stringify(hhmm)} must be HH:MM (24h)`);
  return utcMsForWall(localDate, m[1], m[2], "00", timeZone);
}

function localDateOf(ms, timeZone) {
  const p = zoneParts(ms, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function addDays(localDate, n) {
  const d = Date.parse(`${localDate}T00:00:00Z`) + n * 86400000;
  return new Date(d).toISOString().slice(0, 10);
}

// Next local wall-clock occurrence of hh:mm strictly AFTER afterMs (>= for
// exact hits when exactOk). Pure date arithmetic in the zone; DST-safe
// because utcMsForWall resolves the zone offset for the target date.
export function nextWallClockOccurrence(afterMs, { timeOfDay, timeZone, exactOk = false }) {
  let date = localDateOf(afterMs, timeZone);
  for (let i = 0; i < 400; i += 1) {
    const at = wallClockInstant(date, timeOfDay, timeZone);
    if (exactOk ? at >= afterMs : at > afterMs) return at;
    date = addDays(date, 1);
  }
  throw new QuietTimeError(`no wall-clock occurrence found within 400 days for ${timeOfDay} ${timeZone}`);
}

// How many hh:mm occurrences of this schedule lie in (fromMs, toMs] — the
// missed-period counter for a merged catch-up fire (06 section 7).
export function countOccurrencesBetween(fromMs, toMs, { timeOfDay, timeZone }) {
  let count = 0;
  let cursor = fromMs;
  while (cursor < toMs && count < 1000) {
    const next = nextWallClockOccurrence(cursor, { timeOfDay, timeZone });
    if (next <= toMs) count += 1;
    cursor = next;
  }
  return count;
}

export function parseQuietHours(raw, { defaultTimezone = "Asia/Hong_Kong" } = {}) {
  const q = raw ?? {};
  const start = q.start ?? "23:00";
  const end = q.end ?? "07:00";
  if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
    throw new QuietTimeError(`calendar.quietHours start/end must be HH:MM, got ${JSON.stringify(raw)}`);
  }
  const timezone = typeof q.timezone === "string" && q.timezone.length > 0 ? q.timezone : defaultTimezone;
  try {
    wallClock(Date.now(), timezone);
  } catch {
    throw new QuietTimeError(`calendar.quietHours.timezone ${timezone} is not a valid IANA zone`);
  }
  return { start, end, timezone };
}

/**
 * Is `ms` inside the quiet window? A window that crosses midnight (23:00 ->
 * 07:00) is "wall >= start OR wall < end"; a same-day window is the
 * between-form. Both evaluated on the wall clock of the configured zone.
 */
export function inQuietHours(ms, quietHours) {
  const wallHHMM = wallClock(ms, quietHours.timezone).slice(11, 16);
  const { start, end } = quietHours;
  if (start < end) return wallHHMM >= start && wallHHMM < end;
  if (start > end) return wallHHMM >= start || wallHHMM < end;
  return false; // start === end: zero-length window, never quiet
}

// The next moment the quiet window OPENS (for scheduling the dreaming loop)
// or CLOSES (for pushing deferred notifications out). Strictly after `ms`.
export function nextQuietBoundary(ms, quietHours, { wantOpen = true } = {}) {
  let cursor = ms;
  for (let i = 0; i < 800; i += 1) {
    const opening = nextWallClockOccurrence(cursor, { timeOfDay: quietHours.start, timeZone: quietHours.timezone });
    const closing = nextWallClockOccurrence(cursor, { timeOfDay: quietHours.end, timeZone: quietHours.timezone });
    const candidate = wantOpen ? opening : closing;
    if (wantOpen ? !inQuietHours(candidate, quietHours) : inQuietHours(candidate, quietHours)) {
      cursor = candidate;
      continue;
    }
    return candidate;
  }
  throw new QuietTimeError("no quiet boundary resolved within 800 candidate transitions");
}

// Deterministic content hash helper (audit and suggestion ids).
export function quietTimeFingerprint(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}
