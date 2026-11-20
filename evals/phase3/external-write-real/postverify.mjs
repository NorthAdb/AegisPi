// test:external-write:postverify — READ-ONLY re-verification of the already
// executed real external-write acceptance (plan item B, entry run 2026-11-20).
//
// The single owner-authorized POST was made by the external-write-real entry
// run and is consumed. This script never touches the network, never spawns
// the daemon, and never re-seeds anything: it opens the two scratch
// databases that run left on disk (gitignored workspace-state/) read-only
// and re-derives the acceptance criteria with the audit vocabulary the code
// actually writes.
//
// Why this exists: the entry run's checks 2 and 3 asserted a vocabulary these
// code paths do not use, so the suite exited 1 even though every substantive
// acceptance criterion held. The two assertion errors:
//   - "effect_draft_to_ready" is the PRE-APPROVED narrow-routine transition
//     only (effects.mjs: a human-approval effect is never created DRAFT);
//     the human chain is effect_proposed -> approval_consumed (the CAS
//     decision consumes the approval card and flips the effect READY in the
//     same transaction, with no separate transition audit).
//   - The dispatcher commits SUBMITTING (one effect_submitting row) BEFORE
//     the adapter gate runs (effects.mjs: CAS commit, then
//     upstream.submit). A gate refusal then records effect_failed_local
//     whose details carry bytes_sent: 0 — the zero-bytes proof lives in that
//     audit row, not in the absence of a submitting row.
// The original evidence files stay untouched; this appends its own.
//
// Exit codes: 0 the re-derived criteria hold; 1 a criterion fails; 3 the
// scratch databases are missing (nothing to verify).

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  lockedNodeGuard,
  makeSuite,
  suiteExit,
  writeReport,
  repoRoot,
} from "../lib/harness.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";

lockedNodeGuard();

const EXPECTED_EXTERNAL_ID = "ext-b-acceptance-001";

const wsB = join(repoRoot, "workspace-state", "phase3", "external-write-real-b", "db", "aegis.db");
const wsC = join(repoRoot, "workspace-state", "phase3", "external-write-real-control", "db", "aegis.db");
if (!existsSync(wsB) || !existsSync(wsC)) {
  console.error("");
  console.error("=== test:external-write:postverify — NOT VERIFIABLE (exit 3) ===");
  console.error("两个 scratch 数据库不存在，无可核验对象（本脚本只读、零网络）。");
  console.error("");
  process.exit(3);
}

const suite = makeSuite("external-write-real-postverify");

// ---- the authorized run's database (exactly one effect in it)
let effect = null;
let counts = null;
let sequence = [];
{
  const db = openDatabase(wsB, { readOnly: true });
  effect = db
    .prepare("SELECT state, external_id, last_error, business_key, idempotency_key, attempt_count FROM effects")
    .get();
  const count = (code) => db.prepare("SELECT count(*) c FROM audit_log WHERE code=?").get(code).c;
  counts = {
    proposed: count("effect_proposed"),
    approvalConsumed: count("approval_consumed"),
    draftToReady: count("effect_draft_to_ready"),
    submitting: count("effect_submitting"),
    succeeded: count("effect_succeeded"),
    failedLocal: count("effect_failed_local"),
    failedRemote: count("effect_failed_remote"),
    unknown: count("effect_unknown"),
  };
  sequence = db.prepare("SELECT code FROM audit_log ORDER BY seq").all().map((r) => r.code);
  db.close();
}

suite.check(
  "authorized-effect-succeeded-real-external-id-one-submit-terminal",
  effect?.state === "SUCCEEDED" &&
    effect?.external_id === EXPECTED_EXTERNAL_ID &&
    counts.submitting === 1 &&
    effect?.attempt_count === 1 &&
    counts.failedLocal + counts.failedRemote + counts.unknown === 0,
  `effect=${effect?.state ?? "?"} external_id=${effect?.external_id ?? "-"} businessKey=${effect?.business_key ?? "-"} idempotencyKey=${effect?.idempotency_key ?? "-"} attempt_count=${effect?.attempt_count ?? "-"} submitting=${counts.submitting} failed(local/remote/unknown)=${counts.failedLocal}/${counts.failedRemote}/${counts.unknown} — one POST, terminal SUCCEEDED, no second attempt`,
);

suite.check(
  "approval-chain-proposed-cas-consumed-submitting-succeeded",
  counts.proposed >= 1 &&
    counts.approvalConsumed >= 1 &&
    counts.submitting === 1 &&
    counts.succeeded === 1 &&
    counts.draftToReady === 0,
  `effect_proposed=${counts.proposed} approval_consumed=${counts.approvalConsumed} effect_submitting=${counts.submitting} effect_succeeded=${counts.succeeded} effect_draft_to_ready=${counts.draftToReady}（人工审批效果从不走窄例程码，0 是预期形状）— 链 = proposal → CAS 审批 → SUBMITTING → SUCCEEDED；审计顺序=${sequence.join(" > ")}`,
);

// ---- the unauthorized control's database (exactly one effect in it)
let ctlEffect = null;
let ctlCounts = null;
let ctlBytesSent = null;
let ctlSequence = [];
{
  const db = openDatabase(wsC, { readOnly: true });
  ctlEffect = db.prepare("SELECT state, last_error FROM effects").get();
  const count = (code) => db.prepare("SELECT count(*) c FROM audit_log WHERE code=?").get(code).c;
  ctlCounts = {
    adapterRefused: count("adapter_refused"),
    failedLocal: count("effect_failed_local"),
    submitting: count("effect_submitting"),
    succeeded: count("effect_succeeded"),
  };
  const failedRow = db
    .prepare("SELECT details_json FROM audit_log WHERE code='effect_failed_local' LIMIT 1")
    .get();
  if (failedRow) {
    try {
      ctlBytesSent = JSON.parse(failedRow.details_json).bytes_sent;
    } catch {}
  }
  ctlSequence = db.prepare("SELECT code FROM audit_log ORDER BY seq").all().map((r) => r.code);
  db.close();
}

suite.check(
  "control-adapter-refused-zero-bytes-recorded-in-audit",
  ctlEffect?.state === "FAILED" &&
    /^local_error: adapter refused: real external writes/.test(ctlEffect?.last_error ?? "") &&
    ctlCounts.adapterRefused >= 1 &&
    ctlCounts.failedLocal === 1 &&
    ctlBytesSent === 0 &&
    ctlCounts.succeeded === 0,
  `effect=${ctlEffect?.state ?? "?"} adapter_refused=${ctlCounts.adapterRefused} effect_failed_local=${ctlCounts.failedLocal}（details.bytes_sent=${ctlBytesSent ?? "?"}，代码以 bytes_sent:0 记零字节）submitting=${ctlCounts.submitting}（提交承诺先行，字节从未离开）succeeded=${ctlCounts.succeeded} — policy 关闭在适配器门拒绝，零字节；审计顺序=${ctlSequence.join(" > ")}`,
);

writeReport({
  suiteId: "external-write-real-postverify",
  suite,
  label: "test:external-write:postverify — 真实外部写 B 只读复核（同一对 scratch 库；零网络；修正断言词汇后重核五项通过标准）",
  extra: {
    dataSources: `对已执行的真实外部写验收（external-write-real，恰 1 次 POST 已消耗）做只读复核：不重跑守护进程、不播种、零网络、零新外部字节；两个 scratch 数据库保持原样供独立复核。断言词汇按代码事实修正——effect_draft_to_ready 仅属预批准窄例程（人工审批效果预期为 0）；控制组的零字节证据在 effect_failed_local 审计行的 details.bytes_sent=0（SUBMITTING 提交承诺先于适配器门，字节从未离开本机）。原始证据文件 external-write-real-report.json/-log.md 保持一字未改。`,
  },
});
process.exit(suiteExit(suite, { label: "test:external-write:postverify" }));
