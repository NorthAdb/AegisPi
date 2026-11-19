// Phase 1 contract runner. Executes every probe under the locked Node and
// writes a structured report. `test:contracts` in the root package.json maps
// here. Refuses to run on a Node other than the locked 22.23.5.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

if (process.version !== "v22.23.5") {
  console.error(`Refusing to run: process.version=${process.version}, locked Node is v22.23.5`);
  process.exit(2);
}

const probeModules = [
  "pi01-exports.mjs",
  "pi02-virtual-models.mjs",
  "pi03-before-agent-start.mjs",
  "pi04-tool-interception.mjs",
  "pi05-rpc-commands.mjs",
  "pi06-idle-retry-compaction.mjs",
  "pi07-extension-ui.mjs",
  "pi08-fork-dir-gone.mjs",
  "pi09-provider-routing.mjs",
  "pi10-usage.mjs",
  "pi11-schema-typebox.mjs",
  "pi12-codemode.mjs",
  "pi13-cache-warming.mjs",
  "framing.mjs",
  "sqlite-node.mjs",
];

const only = process.argv
  .find((a) => a.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",");

const results = [];
for (const mod of probeModules) {
  const id = mod.replace(".mjs", "");
  if (only && !only.some((o) => id.startsWith(o))) continue;
  let m;
  try {
    m = await import(`./probes/${mod}`);
  } catch (e) {
    results.push({
      id,
      title: "import failure",
      status: "FAIL",
      summary: `probe module failed to import: ${e.message}`,
      findings: [],
    });
    continue;
  }
  console.error(`\n=== ${id} ===`);
  let res;
  try {
    res = await m.run();
  } catch (e) {
    res = {
      id: m.ID ?? id,
      title: m.TITLE ?? id,
      status: "FAIL",
      summary: `probe threw: ${e.stack ?? e.message}`,
      findings: [],
    };
  }
  results.push(res);
  const failCount = res.findings.filter((f) => f.status === "FAIL").length;
  console.error(
    `${res.status}  ${res.id} — ${failCount} failing check(s) — ${res.summary ?? ""}`,
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  results,
};
const outPath = join(repoRoot, "docs", "phase1", "evidence", "contracts-report.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

// Gate (audit round 2 N1): the suite is green ONLY when every probe has at
// least one real PASS finding and none is FAIL or SKIP. A probe made of
// notes alone is not evidence and must break the run.
const failedProbes = results.filter((r) => r.status === "FAIL");
const skippedProbes = results.filter((r) => r.status === "SKIP");
const noPassEvidence = results.filter(
  (r) => r.status !== "FAIL" && !r.findings.some((f) => f.status === "PASS"),
);
const bad = failedProbes.length > 0 || skippedProbes.length > 0 || noPassEvidence.length > 0;
if (failedProbes.length > 0) {
  console.error(`\nFAIL probes: ${failedProbes.map((r) => r.id).join(", ")}`);
}
if (skippedProbes.length > 0) {
  console.error(`SKIP (no falsifiable PASS evidence) probes: ${skippedProbes.map((r) => r.id).join(", ")}`);
}
if (noPassEvidence.length > 0) {
  console.error(`probes without any PASS finding: ${noPassEvidence.map((r) => r.id).join(", ")}`);
}
console.error(`\n${results.length} probe(s): ${bad ? "NOT GREEN (fail/skip/no-evidence present)" : "all PASS with falsifiable evidence"}`);
console.error(`report: ${outPath}`);
process.exit(bad ? 1 : 0);
