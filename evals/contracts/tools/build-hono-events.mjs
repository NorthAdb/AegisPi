// One-shot generator: builds events.json (public hono release/advisory
// events, 2026-05-18..2026-11-18 window) from gh api dumps in the temp dir.
// Run: node evals/contracts/tools/build-hono-events.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = "C:\\Users\\1\\AppData\\Local\\Temp\\opencode";
const advisories = JSON.parse(readFileSync(join(tmp, "hono-advisories-clean.json"), "utf8"));
const releasesRaw = JSON.parse(readFileSync(join(tmp, "hono-releases-raw.json"), "utf8"));

const WINDOW_START = "2026-05-18T00:00:00Z";
const events = [];

for (const r of releasesRaw) {
  if (r.published_at < WINDOW_START) continue;
  if (r.draft || r.prerelease || r.tag_name.includes("-rc")) continue;
  events.push({
    eventId: `release:${r.tag_name}`,
    kind: "release",
    tag: r.tag_name,
    publishedAt: r.published_at,
    sourceUrl: r.html_url,
  });
}

for (const a of advisories) {
  events.push({
    eventId: `advisory:${a.ghsa_id}`,
    kind: "advisory",
    ghsaId: a.ghsa_id,
    cveId: a.cve_id ?? null,
    severity: a.severity,
    summary: a.summary,
    vulnerableRanges: a.ranges,
    patchedVersions: a.patched,
    publishedAt: a.published_at,
    sourceUrl: `https://github.com/honojs/hono/security/advisories/${a.ghsa_id}`,
  });
}

events.sort((x, y) => x.publishedAt.localeCompare(y.publishedAt));
const out = join(here, "..", "fixtures", "hono-triage", "events.json");
writeFileSync(
  out,
  JSON.stringify(
    {
      generatedAt: "2026-11-18T00:00:00Z",
      source: "GitHub REST API via gh CLI (read-only): repos/honojs/hono/security-advisories and /releases",
      windowStart: WINDOW_START,
      windowEnd: "2026-11-18T00:00:00Z",
      candidateCount: events.length,
      events,
    },
    null,
    1,
  ) + "\n",
  "utf8",
);
console.log(`wrote ${out}: ${events.length} events (${events.filter((e) => e.kind === "release").length} releases, ${events.filter((e) => e.kind === "advisory").length} advisories)`);
