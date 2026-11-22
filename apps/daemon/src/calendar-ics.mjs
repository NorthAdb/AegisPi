// Pure iCalendar parsing helpers shared by the CalDAV child process and the
// host-side calendar adapter. NO top-level process behavior here: the child
// (upstream-calendar-child.mjs) owns the stdin/stdout entry, and importing
// this module must never execute protocol code.

// iCalendar property extraction (bounded, deterministic): DTSTART/DTEND with
// TZID params, RRULE, SUMMARY, ATTENDEE, UID. Folded lines (RFC 5545 3.1)
// are unfolded first.
export function parseIcsEvents(ics) {
  const unfolded = String(ics ?? "").replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^BEGIN:VEVENT$/i.test(trimmed)) {
      current = { attendees: [] };
      continue;
    }
    if (/^END:VEVENT$/i.test(trimmed)) {
      if (current) events.push(current);
      current = null;
      if (events.length >= 200) break;
      continue;
    }
    if (!current) continue;
    const m = /^([A-Z-]+)(?:;([^:]*))?:(.*)$/i.exec(trimmed);
    if (!m) continue;
    const [, nameRaw, paramsRaw, value] = m;
    const name = nameRaw.toUpperCase();
    const params = Object.fromEntries(
      (paramsRaw ?? "").split(";").filter((p) => p.includes("=")).map((p) => {
        const i = p.indexOf("=");
        return [p.slice(0, i).toUpperCase(), p.slice(i + 1).replace(/^"|"$/g, "")];
      }),
    );
    if (name === "UID") current.uid = value.trim();
    else if (name === "SUMMARY") current.summary = value.trim().slice(0, 300);
    else if (name === "DTSTART") {
      current.dtStart = parseIcsDate(value.trim());
      current.timezone = params.TZID ?? (value.trim().endsWith("Z") ? "UTC" : null);
    } else if (name === "DTEND") {
      current.dtEnd = parseIcsDate(value.trim());
    } else if (name === "RRULE") current.rrule = value.trim().slice(0, 200);
    else if (name === "ATTENDEE") {
      const cn = params.CN ?? "";
      const address = /(?:mailto:)?([^>;\s]+)/i.exec(value)?.[1]?.toLowerCase() ?? "";
      if (address) current.attendees.push({ address, name: cn.slice(0, 120) });
    }
  }
  return events;
}

// iCalendar date-time (YYYYMMDDTHHMMSS[Z]) -> epoch ms. TZID-aware wall-clock
// conversion happens at the HOST (Intl zone table), not in the child: the
// child returns the raw components so the host resolves the zone itself.
export function parseIcsDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === "Z") return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  // Floating/zone-local time: recorded as the naive UTC reading of the wall
  // clock; the host re-anchors via the event's TZID when one is present.
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}
