// test:external-write:real — the REAL external-write acceptance (plan item
// B; owner-authorized 2026-11-20, 仅限本次: exactly ONE POST, no retry).
//
// Exit codes by contract:
//   0   the real checks passed: the authorized production tick made exactly
//       one POST to the owner's disposable endpoint, the effect SUCCEEDED
//       with the endpoint's real externalId, the approval chain is on
//       record, and the unauthorized control refused before any byte
//   1   a real check failed — recorded honestly; the one POST, if it left,
//       is consumed; NO retry, NO address change (the authorization is spent)
//   2   wrong Node binary (the harness guard exits 2)
//   4   REFUSED before touching the network: evidence from a previous run
//       already exists. The owner authorized exactly ONE submission, so a
//       rerun would be a second POST — this entry hard-refuses it.
//
// Wire facts this run relies on (unchanged production code, no test seams):
//   - dispatch path: adapter gates (adapters.mjs) -> upstream-http.mjs
//     builds the internal envelope
//     {kind:"submit", businessKey, idempotencyKey, operation, at} ->
//     upstream-http-child.mjs POSTs it with content-type and
//     x-aegispi-request-kind headers ONLY. No auth header exists in this
//     path at all: the credentials.im config entry is a slot MARKER the
//     adapter checks host-side; the transport never sees a secret.
//   - The adapter requires policy.allowRealExternalWrites=true AND a
//     non-null credentials slot marker for notify/external_write over a
//     real transport; the closed default refuses with zero bytes.
//   - A 2xx whose JSON body carries a non-empty externalId string maps to
//     SUCCEEDED; the owner configured this endpoint to answer exactly
//     {"externalId":"ext-b-acceptance-001"} with 200 / application/json.
//   - AT_MOST_ONCE: exactly one submit attempt is possible on any outcome;
//     the effect_submitting audit count is the local one-shot proof.
//
// The repo defaults.json is NEVER modified: the real endpoint/policy/slot
// values live only in this run's scratch test-config (gitignored
// workspace-state/), discarded with the workspace. The committed default
// stays fail-closed (allowRealExternalWrites=false, submitUrl=null).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
  repoRoot,
} from "../lib/harness.mjs";
import { loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent, dispatchKeyForInbox } from "../../../apps/daemon/src/ingress.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../apps/daemon/src/scheduler.mjs";
import { proposeEffect } from "../../../apps/daemon/src/effects.mjs";
import { decideApproval } from "../../../apps/daemon/src/approvals.mjs";
import { grantPermission } from "../../../apps/daemon/src/acl.mjs";

lockedNodeGuard();

// Owner-authorized this run (2026-11-20): the disposable endpoint (the URL
// itself is owner-recordable; it carries no secret) and the externalId the
// endpoint has been configured to return for the single delivery.
const SUBMIT_URL = "https://webhook.site/7b38d120-9947-4427-8d1e-86434713190a";
const EXPECTED_EXTERNAL_ID = "ext-b-acceptance-001";
const UPSTREAM_TIMEOUT_MS = 15000;

// One-shot authorization guard: "仅限本次" means one POST ever. If evidence
// from a previous run exists, refuse before anything network-capable runs.
const priorEvidence = join(repoRoot, "docs", "phase3", "evidence", "external-write-real-report.json");
if (existsSync(priorEvidence)) {
  console.error("");
  console.error("=== test:external-write:real — REFUSED (exit 4) ===");
  console.error("docs/phase3/evidence/external-write-real-report.json 已存在：2026-11-20 的主人授权仅限一次 POST，已消耗。");
  console.error("本入口拒绝再次执行（第二次提交未被授权），未发送任何请求字节。重跑需新的书面授权。");
  console.error("");
  process.exit(4);
}

const suite = makeSuite("external-write-real");
const daemonPath = join(repoRoot, "apps", "daemon", "src", "daemon.mjs");

// Seed a READY im.notify effect the way the host does (event -> task ->
// claim -> proposal -> CAS approval) — verbatim the security-unit (b) shape.
// Deciding at the seed instant is the production shape ("a human approves at
// T, the effect is dispatchable at T"): the spawned tick's real clock
// always lands past the due point.
function seedReadyEffect(tag) {
  const ws = makeWorkspace(tag);
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const now = Date.now();
  const ing = receiveEvent(db, ws.stateDir, {
    now, source: "telegram", sourceEventId: `evt-${tag}`,
    principal: { platform: "telegram", subject: "6101" },
    scope: { kind: "owner_dm", domainKey: "dm:telegram:6101", channel: "telegram", conversationId: "6101" },
    threadKey: `t-${tag}`, priority: 5, policyVersion: "pv1", payload: `real external write ${tag}`, verdict: "ADMIT",
  });
  const inbox = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
  dispatchEventToTask(db, {
    inboxId: inbox.id, dispatchKey: dispatchKeyForInbox(inbox), now, priority: 5,
    maxSteps: 25, deadlineAt: now + 15 * 60 * 1000, skillSetHash: "ss",
  });
  const claim = claimNextTask(db, { now, leaseMs: 60000 });
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(claim.taskId);
  const attemptId = db.prepare("SELECT id FROM attempts WHERE task_id=? AND attempt_no=?").get(task.id, task.attempt_no).id;
  const ownerId = db.prepare("SELECT id FROM principals WHERE platform='telegram' AND platform_subject='6101'").get().id;
  grantPermission(db, { scopeId: "scp:dm%3Atelegram%3A6101", principalId: ownerId, permission: "approve", now });
  const card = proposeEffect(db, ws.stateDir, {
    now,
    taskId: task.id,
    attemptId,
    effectType: "notify",
    domainKey: "dm:telegram:6101",
    naturalKey: `case-${tag}`,
    operationIntent: { targetResource: "im:dm:6101", operation: "im.notify", contentHash: "a".repeat(64), evidenceManifestHash: "b".repeat(64), extra: { body_preview: "real acceptance B (owner authorized, one POST)" } },
    retryMode: "AT_MOST_ONCE",
    provider: "telegram",
    resource: "im:dm:6101",
    requiresApproval: true,
    approverPrincipalId: ownerId,
    expiresAt: now + 60 * 60 * 1000,
  });
  decideApproval(db, {
    approvalId: card.approvalId,
    decision: "approve",
    actionHash: card.actionHash,
    nonce: card.approvalNonce,
    approverId: ownerId,
    now,
  });
  db.close();
  return { ws, effectId: card.effectId, businessKey: card.businessKey };
}

// A test config = the repo's real defaults plus ONLY the deployment values
// under test (endpoint, policy flag, credential slot marker). allow=false
// keeps the transport wired to the REAL endpoint with the policy closed —
// exactly the shipped fail-closed stance the control must reproduce.
function writeTestConfig(ws, { allow }) {
  const defaults = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
  defaults.upstream = { submitUrl: SUBMIT_URL, timeoutMs: UPSTREAM_TIMEOUT_MS };
  defaults.policy = { allowRealExternalWrites: allow };
  defaults.credentials = { im: allow ? "owner-authorized-b-2026-11-20" : null, mail: null, repo: null };
  const path = join(ws.stateDir, "test-config.json");
  writeFileSync(path, JSON.stringify(defaults, null, 2), "utf8");
  return path;
}

// (1) The authorized run: ONE production tick (no --fake-upstream) submits
// through the real HTTP transport. This is the one owner-authorized POST.
const { ws, effectId, businessKey } = seedReadyEffect("external-write-real-b");
const configPath = writeTestConfig(ws, { allow: true });
const r = spawnSync(
  process.execPath,
  [daemonPath, "--once", `--data-dir=${ws.stateDir}`, `--config=${configPath}`],
  { cwd: repoRoot, encoding: "utf8", timeout: 120000 },
);
let effect = null;
let audits = {};
let submittingForEffect = 0;
{
  const db = openDatabase(ws.dbPath, { readOnly: true });
  effect = db.prepare("SELECT state, external_id, last_error FROM effects WHERE id=?").get(effectId);
  const count = (code) => db.prepare("SELECT count(*) c FROM audit_log WHERE code=?").get(code).c;
  audits = {
    proposed: count("effect_proposed"),
    draftToReady: count("effect_draft_to_ready"),
    submitting: count("effect_submitting"),
    succeeded: count("effect_succeeded"),
    failedLocal: count("effect_failed_local"),
    failedRemote: count("effect_failed_remote"),
    unknown: count("effect_unknown"),
    approvalConsumed: count("approval_consumed"),
  };
  submittingForEffect = db
    .prepare("SELECT count(*) c FROM audit_log WHERE code='effect_submitting' AND details_json LIKE ?")
    .get(`%${effectId}%`).c;
  db.close();
}
const failedTotal = audits.failedLocal + audits.failedRemote + audits.unknown;

suite.check(
  "authorized-single-post-succeeded-with-real-external-id",
  r.status === 0 &&
    effect?.state === "SUCCEEDED" &&
    effect?.external_id === EXPECTED_EXTERNAL_ID &&
    audits.submitting === 1 &&
    submittingForEffect === 1 &&
    failedTotal === 0,
  `daemon exit=${r.status} effect=${effect?.state ?? "?"} external_id=${effect?.external_id ?? "-"} businessKey=${businessKey} submitting-audits=${audits.submitting} (for this effect ${submittingForEffect}) failed-audits=${failedTotal} — exactly one POST, terminal SUCCEEDED, no second attempt`,
);

suite.check(
  "approval-chain-proposed-cas-submitting-succeeded-on-record",
  audits.proposed >= 1 &&
    audits.approvalConsumed >= 1 &&
    audits.submitting === 1 &&
    audits.succeeded === 1 &&
    audits.draftToReady === 0,
  `effect_proposed=${audits.proposed} approval_consumed=${audits.approvalConsumed} effect_submitting=${audits.submitting} effect_succeeded=${audits.succeeded} effect_draft_to_ready=${audits.draftToReady}（人工审批效果从不走窄例程码，0 是预期形状）— proposal -> CAS approval -> SUBMITTING -> SUCCEEDED, one row each for the single dispatch`,
);

// (2) The unauthorized control, immediately after: the same host chain in a
// fresh scratch workspace, the transport still wired to the REAL endpoint,
// policy closed. The dispatcher commits SUBMITTING first (one
// effect_submitting row — the commitment, not a byte), then the adapter
// gate refuses before the transport sees anything: FAILED effect with the
// local_error prefix, adapter_refused audit, and an effect_failed_local
// whose details carry bytes_sent: 0 — zero request bytes, nothing consumed.
const ctl = seedReadyEffect("external-write-real-control");
const ctlConfigPath = writeTestConfig(ctl.ws, { allow: false });
const r2 = spawnSync(
  process.execPath,
  [daemonPath, "--once", `--data-dir=${ctl.ws.stateDir}`, `--config=${ctlConfigPath}`],
  { cwd: repoRoot, encoding: "utf8", timeout: 120000 },
);
let ctlEffect = null;
let ctlRefused = 0;
let ctlSubmitting = 0;
let ctlBytesSent = null;
{
  const db = openDatabase(ctl.ws.dbPath, { readOnly: true });
  ctlEffect = db.prepare("SELECT state, last_error FROM effects WHERE id=?").get(ctl.effectId);
  ctlRefused = db
    .prepare("SELECT count(*) c FROM audit_log WHERE code='adapter_refused' AND details_json LIKE ?")
    .get(`%${ctl.effectId}%`).c;
  ctlSubmitting = db.prepare("SELECT count(*) c FROM audit_log WHERE code='effect_submitting'").get().c;
  const failedRow = db
    .prepare("SELECT details_json FROM audit_log WHERE code='effect_failed_local' AND details_json LIKE ?")
    .get(`%${ctl.effectId}%`);
  if (failedRow) {
    try {
      ctlBytesSent = JSON.parse(failedRow.details_json).bytes_sent;
    } catch {}
  }
  db.close();
}

suite.check(
  "unauthorized-control-refuses-before-any-byte",
  r2.status === 0 &&
    ctlEffect?.state === "FAILED" &&
    /^local_error: adapter refused: real external writes/.test(ctlEffect?.last_error ?? "") &&
    ctlRefused >= 1 &&
    ctlBytesSent === 0,
  `daemon exit=${r2.status} control-effect=${ctlEffect?.state ?? "?"} adapter-refused-audits=${ctlRefused} effect_failed_local.bytes_sent=${ctlBytesSent ?? "?"}（SUBMITTING 承诺先行，字节从未离开）— policy closed refuses at the gate, zero bytes to the endpoint`,
);

writeReport({
  suiteId: "external-write-real",
  suite,
  label: "test:external-write:real — 真实外部写验收 B（可丢弃端点单次 POST；未授权对照零字节）",
  extra: {
    dataSources: `主人 2026-11-20 书面授权「仅限本次」：向 ${SUBMIT_URL} 恰 1 次 POST（AT_MOST_ONCE，无重试、无改址、无平台 API、载荷无凭据）；端点已由主人配置为 200/application/json 响应 {"externalId":"${EXPECTED_EXTERNAL_ID}"}。授权链经真实宿主路径（事件→任务→领取→proposal→CAS 审批→生产 tick 派发），仓库 defaults.json 全程未改，开关只存在于本次临时 test-config（gitignored，随工作区废弃）；未授权对照（policy=false）在适配器门拒绝、零字节。端点侧恰 1 份载荷由主人在 webhook.site 页面人工核对。`,
    expectedWire: {
      method: "POST",
      url: SUBMIT_URL,
      headers: ["content-type: application/json", "x-aegispi-request-kind: submit"],
      envelopeFields: ["kind", "businessKey", "idempotencyKey", "operation", "at"],
      operationFields: { operation: "im.notify", targetResource: "im:dm:6101", expectedHead: null },
    },
    businessKey,
    effectId,
  },
});
process.exit(suiteExit(suite, { label: "test:external-write:real" }));
