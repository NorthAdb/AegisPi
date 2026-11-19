// One-shot generator: builds events.json (public hono release/advisory
// events) from gh api dumps in a dump directory (argv[2] or the default
// temp dir). Dumps must be FULL lists — fetch advisories with per_page=100
// (audit round 1: the original per_page=20 fetch truncated the list and
// made us wrongly "correct away" GHSA-88fw-hqm2-52qc, which does exist).
//
// Window filter applies to BOTH kinds now: [windowStart, windowEnd).
// Run: node evals/contracts/tools/build-hono-events.mjs [dumpDir]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dumpDir = process.argv[2] ?? "C:\\Users\\1\\AppData\\Local\\Temp\\opencode";
const advisoryDump = join(dumpDir, "hono-advisories-100.json");
const releaseDump = join(dumpDir, "hono-releases-raw.json");

if (!existsSync(advisoryDump) || !existsSync(releaseDump)) {
  console.error(`missing dumps. Generate them first:
  gh api "repos/honojs/hono/security-advisories?per_page=100" > ${advisoryDump}
  gh api "repos/honojs/hono/releases?per_page=50"            > ${releaseDump}`);
  process.exit(2);
}

const advisories = JSON.parse(readFileSync(advisoryDump, "utf8"));
const releasesRaw = JSON.parse(readFileSync(releaseDump, "utf8"));

const WINDOW_START = "2026-05-18T00:00:00Z";
const WINDOW_END = "2026-11-18T00:00:00Z"; // exclusive
const inWindow = (t) => t >= WINDOW_START && t < WINDOW_END;

const events = [];

for (const r of releasesRaw) {
  if (r.draft || r.prerelease || r.tag_name.includes("-rc")) continue;
  if (!inWindow(r.published_at)) continue;
  events.push({
    eventId: `release:${r.tag_name}`,
    kind: "release",
    tag: r.tag_name,
    publishedAt: r.published_at,
    sourceUrl: r.html_url,
  });
}

for (const a of advisories) {
  if (!inWindow(a.published_at)) continue;
  events.push({
    eventId: `advisory:${a.ghsa_id}`,
    kind: "advisory",
    ghsaId: a.ghsa_id,
    cveId: a.cve_id ?? null,
    severity: a.severity,
    summary: a.summary,
    vulnerableRanges: a.vulnerabilities.map((v) => v.vulnerable_version_range),
    patchedVersions: a.vulnerabilities.map((v) => v.patched_versions),
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
      generatedAt: new Date().toISOString(),
      source:
        "GitHub REST API via gh CLI (read-only): repos/honojs/hono/security-advisories (per_page=100, full list) and /releases",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      windowEndExclusive: true,
      advisoryListTotal: advisories.length,
      candidateCount: events.length,
      events,
    },
    null,
    1,
  ) + "\n",
  "utf8",
);
console.log(
  `wrote ${out}: ${events.length} events (${events.filter((e) => e.kind === "release").length} releases, ${events.filter((e) => e.kind === "advisory").length} advisories); advisory dump total = ${advisories.length}`,
);
