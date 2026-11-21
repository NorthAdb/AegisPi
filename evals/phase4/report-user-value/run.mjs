import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockedNodeGuard, repoRoot } from "../../phase3/lib/harness.mjs";

lockedNodeGuard();

const REQUIRED_SUITES = [
  { id: "triage", file: "docs/phase3/evidence/triage-report.json", scope: "Scenario 4 offline baseline/target triage, oracle verdict, and outbox notify" },
  { id: "repo-observe", file: "docs/phase3/evidence/repo-observe-report.json", scope: "Read-only repo observe acquisition, KV prefix ordering, and HELD stop" },
  { id: "model-proposal", file: "docs/phase3/evidence/model-proposal-report.json", scope: "Agent->Host pi-ai 1.5.2 state machine T1-T10 and empty reply block" },
  { id: "security-unit", file: "docs/phase3/evidence/security-unit-report.json", scope: "Fail-closed credentials, ACL, budget, and Telegram outbound guards" },
  { id: "offline-jobs", file: "docs/phase3/evidence/offline-jobs-report.json", scope: "Offline container execution, deadlines, cancellation, and oracle gates" },
  { id: "security-integration", file: "docs/phase3/evidence/security-integration-report.json", scope: "Container network, rootfs, symlink, and escape integration matrix" },
];

const OPTIONAL_SUITES = [
  { id: "repo-observe-real", file: "docs/phase3/evidence/repo-observe-real-report.json", scope: "Unit 4.2 live GitHub + DeepSeek acceptance (if present)" },
];

const defaults = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
const records = [];
let totalPassed = 0;
let totalJudged = 0;
let totalFailed = 0;

function loadSuiteReport(spec, required) {
  const abs = join(repoRoot, spec.file);
  if (!existsSync(abs)) {
    records.push({ ...spec, present: false, passed: 0, failed: required ? 1 : 0, judged: 0, exitCode: required ? 1 : null });
    if (required) totalFailed += 1;
    return;
  }
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  const passed = Number(raw.counts?.pass ?? raw.passed ?? raw.pass ?? 0);
  const failed = Number(raw.counts?.fail ?? raw.failed ?? raw.fail ?? 0);
  const judged = Number(raw.judged ?? raw.total ?? passed + failed);
  records.push({
    ...spec,
    present: true,
    generatedAt: raw.generatedAt ?? null,
    passed,
    failed,
    judged,
    exitCode: failed === 0 && judged > 0 ? 0 : 1,
  });
  totalPassed += passed;
  totalFailed += failed;
  totalJudged += judged;
}

for (const s of REQUIRED_SUITES) loadSuiteReport(s, true);
for (const s of OPTIONAL_SUITES) loadSuiteReport(s, false);

const realObserveReportPath = join(repoRoot, "docs/phase3/evidence/repo-observe-real-report.json");
let realCostSummary = null;
if (existsSync(realObserveReportPath)) {
  const rawReal = JSON.parse(readFileSync(realObserveReportPath, "utf8"));
  const passedReal = Number(rawReal.counts?.pass ?? rawReal.passed ?? rawReal.pass ?? 0);
  const failedReal = Number(rawReal.counts?.fail ?? rawReal.failed ?? rawReal.fail ?? 0);
  realCostSummary = {
    sourceFile: "docs/phase3/evidence/repo-observe-real-report.json",
    generatedAt: rawReal.generatedAt ?? null,
    passed: passedReal,
    failed: failedReal,
    taskBudgetCapMicrousd: defaults.budget.taskMicroUsd,
    dayBudgetCapMicrousd: defaults.budget.dayMicroUsd,
  };
}

const defaultsFailClosedPreserved =
  defaults.model?.baseUrl === null &&
  Array.isArray(defaults.model?.allowedPurposes) &&
  defaults.model.allowedPurposes.length === 0 &&
  Array.isArray(defaults.model?.allowedModelIds) &&
  defaults.model.allowedModelIds.length === 0 &&
  defaults.model?.allowRealModelCalls === false &&
  defaults.model?.priceCatalog?.inputPerMTokMicrousd === null &&
  defaults.model?.priceCatalog?.outputPerMTokMicrousd === null &&
  defaults.model?.priceCatalog?.cacheReadPerMTokMicrousd === null &&
  defaults.model?.priceCatalog?.cacheWritePerMTokMicrousd === null &&
  defaults.policy?.allowRealExternalWrites === false &&
  defaults.upstream?.submitUrl === null &&
  defaults.telegram?.apiBase === null &&
  defaults.telegram?.allowRealSend === false &&
  defaults.telegram?.proxyUrl === null &&
  Array.isArray(defaults.adapters?.allowedRecipients) &&
  defaults.adapters.allowedRecipients.length === 0 &&
  defaults.credentials?.mail === null &&
  defaults.credentials?.repo === null &&
  defaults.credentials?.im === null &&
  defaults.acquisition?.allowRealRepoFetch === false &&
  Array.isArray(defaults.acquisition?.allowedHosts) &&
  defaults.acquisition.allowedHosts.length === 0 &&
  Object.keys(defaults.acquisition?.targets ?? {}).length === 0 &&
  defaults.triage?.allowRealTriage === false &&
  Object.keys(defaults.triage?.presets ?? {}).length === 0;

const ok =
  totalFailed === 0 &&
  defaultsFailClosedPreserved &&
  records
    .filter((r) => REQUIRED_SUITES.some((req) => req.id === r.id))
    .every((r) => r.present && r.passed > 0 && r.failed === 0);

const jsonOut = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  ok,
  summary: {
    passed: totalPassed,
    failed: totalFailed,
    judged: totalJudged,
    taskBudgetCapMicrousd: defaults.budget.taskMicroUsd,
    dayBudgetCapMicrousd: defaults.budget.dayMicroUsd,
    defaultsFailClosedPreserved,
  },
  suites: records,
  realCostSummary,
};

mkdirSync(join(repoRoot, "docs", "phase3", "evidence"), { recursive: true });
mkdirSync(join(repoRoot, "docs", "phase4", "reports"), { recursive: true });

writeFileSync(join(repoRoot, "docs", "phase3", "evidence", "user-value-report.json"), JSON.stringify(jsonOut, null, 2) + "\n", "utf8");

const lines = [
  "# User-value and verification report",
  "",
  `> Generated: ${jsonOut.generatedAt} from verified evidence JSON files`,
  "",
  `- status: ${ok ? "PASS" : "FAIL"} (${totalPassed} pass / ${totalFailed} fail / ${totalJudged} judged)`,
  `- configured budgets: task=${defaults.budget.taskMicroUsd} microUSD (\`$${(defaults.budget.taskMicroUsd / 1_000_000).toFixed(2)}\`), day=${defaults.budget.dayMicroUsd} microUSD (\`$${(defaults.budget.dayMicroUsd / 1_000_000).toFixed(2)}\`)`,
  `- fail-closed defaults intact: ${defaultsFailClosedPreserved}`,
  "",
  "## Verified suite evidence",
  "",
  "| suite | present | passed | failed | judged | scope |",
  "| --- | --- | --- | --- | --- | --- |",
  ...records.map((r) => `| ${r.id} | ${r.present} | ${r.passed} | ${r.failed} | ${r.judged} | ${r.scope} |`),
];

if (realCostSummary) {
  lines.push(
    "",
    "## Recorded real acceptance summary",
    "",
    `- source: \`${realCostSummary.sourceFile}\` (${realCostSummary.generatedAt ?? "unknown time"})`,
    `- counts: ${realCostSummary.passed} pass, ${realCostSummary.failed} fail`,
  );
}

writeFileSync(join(repoRoot, "docs", "phase4", "reports", "user-value-report.md"), lines.join("\n") + "\n", "utf8");

console.log(`user-value-report: ${ok ? "PASS" : "FAIL"} (${totalPassed}/${totalJudged} pass, ${totalFailed} fail, defaultsFailClosed=${defaultsFailClosedPreserved})`);
process.exit(ok ? 0 : 1);
