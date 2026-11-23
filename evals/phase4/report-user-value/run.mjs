// report:user-value — the per-scenario user-value and verification
// aggregator (kickoff plan section 3 unit 5.6 item 3).
//
// What this script is allowed to claim: numbers read back out of verified
// evidence JSON files, and nothing else. Every unmeasured quantity stays
// null / "未测" — the report never averages across scenarios (a green mail
// loop can never launder a red calendar) and never converts a missing
// suite into a pass.
//
// Sections:
//   1. suite evidence table (required suites gate the verdict; a PRESENT
//      real suite with failures also fails the aggregate — a recorded real
//      run is a verdict, not decoration);
//   2. per-scenario value blocks (Scenario 1 mail, Scenario 2 briefing /
//      calendar / Timer, Scenario 3 cross-channel isolation, Scenario 4
//      repo triage, Memory lifecycle) with judged/interception counts and
//      live stage evidence;
//   3. per-purpose cost attribution (worker/router/summary/classify) with
//      untested purposes kept null;
//   4. defaults fail-closed gate over the Phase 3 + Phase 5 keys;
//   5. zero-secret pattern scan over every evidence file it includes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockedNodeGuard, repoRoot } from "../../phase3/lib/harness.mjs";

lockedNodeGuard();

const REQUIRED_SUITES = [
  { id: "triage", file: "docs/phase3/evidence/triage-report.json", scope: "Scenario 4 offline baseline/target triage, oracle verdict, and outbox notify" },
  { id: "repo-observe", file: "docs/phase3/evidence/repo-observe-report.json", scope: "Read-only repo observe acquisition, KV prefix ordering, and HELD stop" },
  { id: "model-proposal", file: "docs/phase3/evidence/model-proposal-report.json", scope: "Agent->Host pi-ai 1.5.2 state machine T1-T10 and empty reply block" },
  { id: "security-unit", file: "docs/phase3/evidence/security-unit-report.json", scope: "Fail-closed credentials, ACL, budget, console, and Telegram outbound guards" },
  { id: "offline-jobs", file: "docs/phase3/evidence/offline-jobs-report.json", scope: "Offline container execution, deadlines, cancellation, and oracle gates" },
  { id: "security-integration", file: "docs/phase3/evidence/security-integration-report.json", scope: "Container network, rootfs, symlink, and escape integration matrix" },
  { id: "memory-lifecycle", file: "docs/phase5/evidence/memory-lifecycle-report.json", scope: "Memory lifecycle: L0 domains, L1/L2 recall, candidates, forgetting, spill" },
  { id: "cross-channel", file: "docs/phase5/evidence/cross-channel-report.json", scope: "Telegram pull cursor, multi-channel canary isolation, control bypass" },
  { id: "scenarios", file: "docs/phase5/evidence/scenarios-report.json", scope: "Scenario 1 mail + Scenario 2 briefing/calendar/timer matrix over loopback TLS fixtures" },
];

const OPTIONAL_SUITES = [
  { id: "repo-observe-real", file: "docs/phase3/evidence/repo-observe-real-report.json", scope: "Unit 4.2 live GitHub + DeepSeek acceptance (if present)" },
  { id: "triage-real", file: "docs/phase3/evidence/triage-real-report.json", scope: "Unit 4.5 live GitHub + DeepSeek + container execution + @aegispibot DM acceptance (if present)" },
  { id: "scenarios-real", file: "docs/phase5/evidence/scenarios-real-report.json", scope: "Unit 5.6 permit-2 live acceptance: Telegram pull isolation + real mailbox draft/approve/send + CalDAV boundary (if present)" },
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
    return null;
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
  return raw;
}

const rawByFile = {};
for (const s of REQUIRED_SUITES) rawByFile[s.id] = loadSuiteReport(s, true);
for (const s of OPTIONAL_SUITES) rawByFile[s.id] = loadSuiteReport(s, false);

// ---------------------------------------------------------------------------
// Per-scenario value blocks. Interception assertions are counted from the
// evidence check NAMES (refuse/block/kill/zero/leak/isolation verbs); they
// are honest counts of judged gates, never percentages invented here.

const INTERCEPT_RE = /(refus|forg|block|intercept|reject|kill|dead|zero|leak|unauthor|cannot|isolation|quarantin|forbidden|no-|drop)/i;

function scenarioBlockFromChecks({ id, benefit, checks, live }) {
  const passed = checks.filter((c) => c.status === "PASS").length;
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const interception = checks.filter((c) => c.status === "PASS" && INTERCEPT_RE.test(c.name)).length;
  return {
    id,
    benefit,
    judged: checks.length,
    passed,
    failed,
    interceptionAssertions: interception,
    live,
  };
}

function checksOf(raw, filter) {
  return (raw?.results ?? []).filter((r) => filter(r.name));
}

const scenariosRaw = rawByFile["scenarios"];
const crossRaw = rawByFile["cross-channel"];
const memoryRaw = rawByFile["memory-lifecycle"];
const triageRaw = rawByFile["triage"];
const scenariosRealRaw = rawByFile["scenarios-real"];
const triageRealRaw = rawByFile["triage-real"];
const realTelemetry = scenariosRealRaw ?? null;

const scenarioBlocks = [
  scenarioBlockFromChecks({
    id: "scenario1-mail",
    benefit: "收件箱只读拉取后自动分诊并停在草稿审批：伪造显示名拒之门外、收件人/附件被篡改即拦截、审批一次点击后才发恰 1 封、DATA 后断流绝不自动重发",
    checks: checksOf(scenariosRaw, (n) => n.startsWith("5.3-")),
    live: realTelemetry?.mail
      ? {
          status: realTelemetry.mail.status ?? null,
          inboxFetched: realTelemetry.mail.inboxFetched ?? null,
          draftChars: realTelemetry.mail.draft?.chars ?? null,
          approval: realTelemetry.mail.approval ?? null,
          smtpSends: realTelemetry.mail.smtp?.sends ?? null,
          stageMs: realTelemetry.timings?.mailStageMs ?? null,
        }
      : null,
  }),
  scenarioBlockFromChecks({
    id: "scenario2-briefing-calendar-timer",
    benefit: "带时区条件跟进 Timer 只在真联系人回信未到时提醒一次；晨报合并静默时段；日历写入必须带 If-Match ETag，远端已改即 412 转重审、绝不覆盖",
    checks: checksOf(scenariosRaw, (n) => n.startsWith("5.4-")),
    live: realTelemetry
      ? {
          calendarStatus: realTelemetry.calendar?.status ?? null,
          calendarReason: realTelemetry.calendar?.reason ?? null,
          stageMs: realTelemetry.timings?.calendarStageMs ?? null,
        }
      : null,
  }),
  scenarioBlockFromChecks({
    id: "scenario3-cross-channel-isolation",
    benefit: "群聊任务永远读不到私聊内容：Canary 在 9 个派生环节零命中，跨群外发在建行与分发两层都被 CP4 击杀，/stop 秒级直达",
    checks: crossRaw?.results ?? [],
    live: realTelemetry?.telegram
      ? {
          status: realTelemetry.telegram.status ?? null,
          getUpdatesRounds: realTelemetry.telegram.rounds ?? null,
          admitted: realTelemetry.telegram.admitted ?? null,
          unauthorizedDropped: realTelemetry.telegram.unauthorized ?? null,
          offsetAfter: realTelemetry.telegram.offsetAfter ?? null,
          canary: realTelemetry.telegram.canary ?? null,
          stageMs: realTelemetry.timings?.telegramStageMs ?? null,
        }
      : null,
  }),
  scenarioBlockFromChecks({
    id: "scenario4-repo-triage",
    benefit: "依赖公告进私聊即自动出裁定卡：真实容器双跑对比、四类裁定全由宿主事实决定、结论直达 @aegispibot 私聊",
    checks: triageRaw?.results ?? [],
    live: (() => {
      if (!triageRealRaw) return null;
      const tel = triageRealRaw.telemetry ?? [];
      const settled = tel.map((t) => t.settledPeakMicrousd ?? 0).reduce((a, b) => a + b, 0);
      return {
        status: triageRealRaw.counts?.fail === 0 ? "VERIFIED" : "FAILED",
        liveCases: tel.length,
        settledPeakMicrousd: settled,
      };
    })(),
  }),
  scenarioBlockFromChecks({
    id: "memory-lifecycle",
    benefit: "跨域记忆互不串读、候选/冲突留人裁决、撤权即时失效、遗忘级联清干净且备份恢复不复活、超限输出进受 ACL 的 Spill",
    checks: memoryRaw?.results ?? [],
    live: null,
  }),
];

// Per-purpose cost attribution. Only measured numbers enter; every
// untested purpose stays null and is labeled 未测.
function purposeRow(purpose) {
  const entry = realTelemetry?.budgetByPurpose?.[purpose] ?? null;
  if (purpose === "worker") {
    const tel = triageRealRaw?.telemetry ?? [];
    const triageSettled = tel.map((t) => t.settledPeakMicrousd ?? 0).reduce((a, b) => a + b, 0);
    const scenariosReq = entry?.requests ?? 0;
    const scenariosSettled = entry?.settledMicrousd ?? 0;
    if (entry || tel.length > 0) {
      const parts = [];
      if (entry) parts.push(`scenarios-real: ${scenariosReq} req, ${scenariosSettled}u$`);
      if (tel.length > 0) parts.push(`triage-real: ${tel.length} req, ${triageSettled}u$ (peak catalog)`);
      return {
        purpose,
        requests: scenariosReq + tel.length,
        settledMicrousd: scenariosSettled + triageSettled,
        upperMicrousd: entry?.upperMicrousd ?? null,
        cacheReadTokens: entry?.cacheReadTokens ?? null,
        cacheWriteTokens: entry?.cacheWriteTokens ?? null,
        tested: true,
        note: parts.join(" + "),
      };
    }
    return { purpose, requests: null, settledMicrousd: null, upperMicrousd: null, cacheReadTokens: null, cacheWriteTokens: null, tested: false };
  }
  if (entry) {
    return {
      purpose,
      requests: entry.requests ?? null,
      settledMicrousd: entry.settledMicrousd ?? null,
      upperMicrousd: entry.upperMicrousd ?? null,
      cacheReadTokens: entry.cacheReadTokens ?? null,
      cacheWriteTokens: entry.cacheWriteTokens ?? null,
      tested: true,
    };
  }
  return { purpose, requests: null, settledMicrousd: null, upperMicrousd: null, cacheReadTokens: null, cacheWriteTokens: null, tested: false };
}
const purposeRows = ["worker", "router", "summary", "classify"].map(purposeRow);

// ---------------------------------------------------------------------------
// defaults fail-closed gate, extended over the Phase 5 keys.
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
  defaults.telegram?.allowRealPull === false &&
  defaults.telegram?.proxyUrl === null &&
  Array.isArray(defaults.telegram?.allowedChatIds) &&
  defaults.telegram.allowedChatIds.length === 0 &&
  defaults.mail?.imapHost === null &&
  defaults.mail?.smtpHost === null &&
  defaults.mail?.allowRealMailRead === false &&
  defaults.mail?.allowRealMailSend === false &&
  Array.isArray(defaults.mail?.allowedSenders) &&
  defaults.mail.allowedSenders.length === 0 &&
  Array.isArray(defaults.mail?.allowedRecipients) &&
  defaults.mail.allowedRecipients.length === 0 &&
  defaults.calendar?.caldavUrl === null &&
  defaults.calendar?.allowRealCalendarRead === false &&
  defaults.calendar?.allowRealCalendarWrite === false &&
  Array.isArray(defaults.calendar?.allowedCalendars) &&
  defaults.calendar.allowedCalendars.length === 0 &&
  defaults.adapters?.allowedRecipients !== undefined &&
  Array.isArray(defaults.adapters?.allowedRecipients) &&
  defaults.adapters.allowedRecipients.length === 0 &&
  Array.isArray(defaults.adapters?.allowedRepos) &&
  defaults.adapters.allowedRepos.length === 0 &&
  Array.isArray(defaults.adapters?.allowedBranches) &&
  defaults.adapters.allowedBranches.length === 0 &&
  defaults.memory?.autoActivateCandidateFacts === false &&
  defaults.credentials?.mail === null &&
  defaults.credentials?.repo === null &&
  defaults.credentials?.im === null &&
  defaults.acquisition?.allowRealRepoFetch === false &&
  defaults.acquisition?.enableHostGateway === false &&
  Array.isArray(defaults.acquisition?.allowedHosts) &&
  defaults.acquisition.allowedHosts.length === 0 &&
  Object.keys(defaults.acquisition?.targets ?? {}).length === 0 &&
  defaults.triage?.allowRealTriage === false &&
  Object.keys(defaults.triage?.presets ?? {}).length === 0;

// ---------------------------------------------------------------------------
// Zero-secret pattern scan over every evidence file this report includes.
const FIXTURE_MARKERS = /(fixture|example\.com|example\.net|example\.org|\.example\b|\.test\b|not-a-real|\[REDACTED|\*{3,}|aegispi\.local)/i;
const SECRET_PATTERNS = [
  { label: "telegram-bot-token-shape", re: /\b\d{8,10}:[A-Za-z0-9_-]{34,}\b/ },
  { label: "llm-api-key-shape", re: /sk-[A-Za-z0-9]{20,}/ },
  {
    label: "json-secret-key-with-long-value",
    re: /"(?:api_?key|apikey|password|app_?password|bot_?token|bearer|client_secret|credential)"\s*:\s*"([^"\s]{16,})"/gi,
    valueGroup: 1,
  },
  {
    label: "non-fixture-mail-address",
    re: /[\w.+-]+@[\w-]+\.[\w.-]+/g,
    valueGroup: 0,
  },
];
const secretHits = [];
for (const spec of [...REQUIRED_SUITES, ...OPTIONAL_SUITES]) {
  const abs = join(repoRoot, spec.file);
  if (!existsSync(abs)) continue;
  const text = readFileSync(abs, "utf8");
  for (const pat of SECRET_PATTERNS) {
    const re = new RegExp(pat.re.source, pat.re.flags.includes("g") ? pat.re.flags : pat.re.flags + "g");
    for (const m of text.matchAll(re)) {
      const value = m[pat.valueGroup ?? 0] ?? "";
      if (FIXTURE_MARKERS.test(value)) continue;
      secretHits.push({ suite: spec.id, pattern: pat.label, sample: value.slice(0, 6) + "…" });
      break;
    }
  }
}
const zeroSecretScan = { scannedFiles: [...REQUIRED_SUITES, ...OPTIONAL_SUITES].filter((s) => existsSync(join(repoRoot, s.file))).length, hits: secretHits.length, hitsDetail: secretHits };

// A present real suite is a verdict: its failures or empty runs fail the aggregate.
const presentRealWithFailures = records.filter(
  (r) => OPTIONAL_SUITES.some((o) => o.id === r.id) && r.present && (r.failed > 0 || r.judged === 0 || r.exitCode !== 0),
);

const ok =
  totalFailed === 0 &&
  defaultsFailClosedPreserved &&
  secretHits.length === 0 &&
  presentRealWithFailures.length === 0 &&
  records
    .filter((r) => REQUIRED_SUITES.some((req) => req.id === r.id))
    .every((r) => r.present && r.passed > 0 && r.failed === 0);

const jsonOut = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  ok,
  summary: {
    passed: totalPassed,
    failed: totalFailed,
    judged: totalJudged,
    taskBudgetCapMicrousd: defaults.budget.taskMicroUsd,
    dayBudgetCapMicrousd: defaults.budget.dayMicroUsd,
    defaultsFailClosedPreserved,
    zeroSecretScan: secretHits.length === 0,
  },
  suites: records,
  scenarioBlocks,
  purposeRows,
  zeroSecretScan,
  liveAcceptance: realTelemetry
    ? {
        present: true,
        generatedAt: scenariosRealRaw.generatedAt ?? null,
        telegram: realTelemetry.telegram ?? null,
        mail: realTelemetry.mail ?? null,
        calendar: realTelemetry.calendar ?? null,
        timings: realTelemetry.timings ?? null,
      }
    : { present: false, note: "scenarios-real evidence absent on this host: unit 5.6 live acceptance NOT VERIFIED here" },
};

mkdirSync(join(repoRoot, "docs", "phase3", "evidence"), { recursive: true });
mkdirSync(join(repoRoot, "docs", "phase4", "reports"), { recursive: true });

writeFileSync(join(repoRoot, "docs", "phase3", "evidence", "user-value-report.json"), JSON.stringify(jsonOut, null, 2) + "\n", "utf8");

const fmtLive = (live, keys) => (live ? keys.filter((k) => live[k] !== null && live[k] !== undefined).map((k) => `${k}=${live[k]}`).join(" ") : "未执行（无实盘证据）");
const lines = [
  "# User-value and verification report",
  "",
  `> Generated: ${jsonOut.generatedAt} from verified evidence JSON files; unmeasured quantities stay null / 未测`,
  "",
  `- status: ${ok ? "PASS" : "FAIL"} (${totalPassed} pass / ${totalFailed} fail / ${totalJudged} judged)`,
  `- configured budgets: task=${defaults.budget.taskMicroUsd} microUSD (\`$${(defaults.budget.taskMicroUsd / 1_000_000).toFixed(2)}\`), day=${defaults.budget.dayMicroUsd} microUSD (\`$${(defaults.budget.dayMicroUsd / 1_000_000).toFixed(2)}\`)`,
  `- fail-closed defaults intact (Phase 3 + Phase 5 keys): ${defaultsFailClosedPreserved}`,
  `- zero-secret pattern scan: ${secretHits.length === 0 ? "clean" : `${secretHits.length} hit(s)`} over ${zeroSecretScan.scannedFiles} evidence file(s)`,
  "",
  "## Verified suite evidence",
  "",
  "| suite | present | passed | failed | judged | scope |",
  "| --- | --- | --- | --- | --- | --- |",
  ...records.map((r) => `| ${r.id} | ${r.present} | ${r.passed} | ${r.failed} | ${r.judged} | ${r.scope} |`),
  "",
  "## Per-scenario user value (no averaging across scenarios)",
  "",
];
for (const b of scenarioBlocks) {
  lines.push(`### ${b.id}`);
  lines.push("");
  lines.push(`- benefit: ${b.benefit}`);
  lines.push(
    `- judged evidence: ${b.passed} pass / ${b.failed} fail / ${b.judged} judged, of which interception-type assertions ${b.interceptionAssertions}`,
  );
  if (b.id === "scenario1-mail") {
    lines.push(`- live (unit 5.6): ${fmtLive(b.live, ["status", "inboxFetched", "draftChars", "smtpSends", "stageMs"])}`);
    if (b.live?.approval) lines.push(`- approval path: ${b.live.approval.via ?? "未测"} (consumed=${b.live.approval.consumed ?? "未测"})`);
  }
  if (b.id === "scenario2-briefing-calendar-timer") {
    lines.push(`- live (unit 5.6): ${fmtLive(b.live, ["calendarStatus", "stageMs"])}`);
    if (b.live?.calendarReason) lines.push(`- calendar boundary: ${b.live.calendarReason}`);
  }
  if (b.id === "scenario3-cross-channel-isolation") {
    lines.push(`- live (unit 5.6): ${fmtLive(b.live, ["status", "getUpdatesRounds", "admitted", "unauthorizedDropped", "offsetAfter", "canary", "stageMs"])}`);
  }
  if (b.id === "scenario4-repo-triage" && b.live) {
    lines.push(`- live (unit 4.5): cases=${b.live.liveCases} settledPeakMicrousd=${b.live.settledPeakMicrousd}`);
  }
  if (b.live === null && b.id === "memory-lifecycle") {
    lines.push("- live: 不适用（记忆生命周期属本机离线能力，无外部通道）");
  }
  lines.push("");
}
lines.push("## Per-purpose cost attribution (untested purposes stay 未测/null)");
lines.push("");
lines.push("| purpose | tested | requests | settledMicrousd | upperMicrousd | cacheReadTokens | cacheWriteTokens |");
lines.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const p of purposeRows) {
  lines.push(
    `| ${p.purpose} | ${p.tested ? "measured" : "未测"} | ${p.requests ?? "null"} | ${p.settledMicrousd ?? "null"} | ${p.upperMicrousd ?? "null"} | ${p.cacheReadTokens ?? "null"} | ${p.cacheWriteTokens ?? "null"} |`,
  );
}
lines.push("");
lines.push("## Live acceptance record (unit 5.6, permit 2)");
lines.push("");
if (jsonOut.liveAcceptance.present) {
  const t = jsonOut.liveAcceptance;
  lines.push(`- scenarios-real evidence: generated ${t.generatedAt ?? "unknown time"} (docs/phase5/evidence/scenarios-real-report.json)`);
  lines.push(`- telegram: ${fmtLive(t.telegram, ["status", "rounds", "admitted", "unauthorized", "offsetAfter", "canary"])}`);
  lines.push(`- mail: ${fmtLive(t.mail, ["status", "inboxFetched"])}`);
  lines.push(`- calendar: ${fmtLive(t.calendar, ["status"])}`);
} else {
  lines.push(`- scenarios-real evidence absent on this host: unit 5.6 live acceptance NOT VERIFIED here (${jsonOut.liveAcceptance.note})`);
}
if (presentRealWithFailures.length > 0) {
  lines.push("");
  lines.push(`- present real suites carrying failures (aggregate forced FAIL): ${presentRealWithFailures.map((r) => r.id).join(", ")}`);
}
lines.push("");

writeFileSync(join(repoRoot, "docs", "phase4", "reports", "user-value-report.md"), lines.join("\n") + "\n", "utf8");

console.log(
  `user-value-report: ${ok ? "PASS" : "FAIL"} (${totalPassed}/${totalJudged} pass, ${totalFailed} fail, defaultsFailClosed=${defaultsFailClosedPreserved}, secretScan=${secretHits.length === 0 ? "clean" : secretHits.length + " hits"})`,
);
process.exit(ok ? 0 : 1);
