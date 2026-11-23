// eval:scenarios:real — Unit 5.6 PERMIT-2 live acceptance (Phase 5 batch 3;
// kickoff plan section 3 unit 5.6, owner ruling D-102).
//
// Exit codes, the same discipline as the five earlier *-real entries:
//   0   every live check PASSED (real getUpdates over the owner proxy,
//       real IMAP over TLS, one real DeepSeek draft call reserved+settled
//       through the four-field catalog, one real approval consumed through
//       the local console at 127.0.0.1:4310, exactly one SMTP message)
//   1   a live check FAILED, or the post-write plaintext tripwire tripped
//   3   NOT VERIFIED — a required .env key is missing or malformed. Never a
//       skip dressed as a pass.
//   4   REFUSED — AEGISPI_ALLOW_REAL_PHASE5_ACCEPTANCE is not set. The gate
//       runs BEFORE any .env byte is read (the C-item ledger discipline,
//       D-94).
//
// Owner scope ruling for THIS batch (D-102):
//   1. Telegram Route-1 pull, <=3 getUpdates rounds total, private chat +
//      private test group, canary isolation + cursor + receipt scrubbing;
//   2. real mailbox: IMAP read-only pull of the placed test mail ->
//      deepseek/deepseek-flash (reasoning high) draft -> PARKED/
//      WAITING_APPROVAL -> console approve -> SMTP over TLS sends EXACTLY
//      ONE reply to MAIL_TEST_RECIPIENT with external_id recorded;
//   3. real calendar: DEFERRED / NOT VERIFIED while CALDAV_* is absent (the
//      owner ruling: this does not block Phase 5). If CALDAV_* ever appears,
//      a single read-only pull is attempted and its honest outcome recorded
//      — it never silently becomes a pass.
//
// Every byte that reaches stdout or the evidence files passes scrub()
// first: token, API key, owner/group ids, mailbox addresses, app password
// and mail hosts are replaced with the mask set. The post-write tripwire
// re-reads both evidence files and fails the run on any raw value.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

import { lockedNodeGuard, makeSuite, makeWorkspace, suiteExit, writeReport } from "../lib/harness.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { dispatchKeyForInbox, ensurePrincipal } from "../../../apps/daemon/src/ingress.mjs";
import { grantPermission } from "../../../apps/daemon/src/acl.mjs";
import { dispatchEventToTask } from "../../../apps/daemon/src/router.mjs";
import { claimNextTask } from "../../../apps/daemon/src/scheduler.mjs";
import { proposeEffect, dispatchEffect, EffectCp4Blocked } from "../../../apps/daemon/src/effects.mjs";
import { createAdapterUpstream } from "../../../apps/daemon/src/adapters.mjs";
import { pullMailMessages, createMailUpstream } from "../../../apps/daemon/src/mail-adapter.mjs";
import {
  ensureMailScope,
  ingestInboundMail,
  proposeMailReplyEffect,
  buildMailSendIntent,
  insertMailDraftEvidence,
} from "../../../apps/daemon/src/mail-triage.mjs";
import { callModelOnce, microusdForUsage } from "../../../apps/daemon/src/model-call.mjs";
import { createBudgetLedger } from "../../../apps/daemon/src/budget.mjs";
import { pullTelegramUpdates, readPullOffset, createTelegramPullRunner } from "../../../apps/daemon/src/telegram-pull.mjs";
import { expandObjectGraph } from "../../../apps/daemon/src/memory.mjs";
import { readObjectContent } from "../../../apps/daemon/src/objects.mjs";
import { createCredentialService } from "../../../apps/daemon/src/credentials.mjs";
import { createConsoleApp, ensureConsoleToken, serveConsole, CONSOLE_BIND, CONSOLE_DEFAULT_PORT } from "../../../apps/daemon/src/console/api.mjs";
import { pullCalendarEvents } from "../../../apps/daemon/src/calendar-adapter.mjs";

lockedNodeGuard();

// The permit gate comes BEFORE any .env read, exactly like the five earlier
// real entries (D-94: a token present on this machine is not an
// authorization; the ledger opens only by an explicit owner opt-in).
if (process.env.AEGISPI_ALLOW_REAL_PHASE5_ACCEPTANCE !== "1") {
  console.error("");
  console.error("=== phase5:scenarios-real — REFUSED (exit 4) ===");
  console.error(
    "单元 5.6 许可 2 实盘验收入口已锁定：必须由主人显式设置 AEGISPI_ALLOW_REAL_PHASE5_ACCEPTANCE=1 后才允许读取 .env、轮询真实 @aegispibot、访问真实邮箱、调用真实模型与发送真实测试回信。",
  );
  console.error("");
  process.exit(4);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readEnv(name) {
  try {
    const txt = readFileSync(join(repoRoot, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch {}
  return undefined;
}

const REQUIRED_ENV = {
  TELEGRAM_BOT_TOKEN: "Telegram bot token for @aegispibot",
  TELEGRAM_OWNER_USER_ID: "owner private-chat user id",
  TELEGRAM_TEST_GROUP_CHAT_ID: "private test-group chat id",
  DEEPSEEK_API_KEY: "DeepSeek API key",
  MAIL_IMAP_HOST: "IMAP host",
  MAIL_IMAP_PORT: "IMAP port",
  MAIL_SMTP_HOST: "SMTP host",
  MAIL_SMTP_PORT: "SMTP port",
  MAIL_USER: "mailbox account address",
  MAIL_APP_PASSWORD: "mailbox app password",
  MAIL_TEST_RECIPIENT: "owner-controlled test recipient",
};

const env = {};
const missing = [];
for (const key of Object.keys(REQUIRED_ENV)) {
  const val = readEnv(key);
  if (typeof val !== "string" || val.length === 0) missing.push(key);
  env[key] = val;
}
if (missing.length > 0) {
  console.error("");
  console.error("=== phase5:scenarios-real — NOT VERIFIED (exit 3) ===");
  console.error(`本机 .env 缺少必填键：${missing.join(", ")}；单元 5.6 实盘验收未执行（未验收，非跳过冒充通过）。`);
  console.error("");
  process.exit(3);
}

const ownerUserId = env.TELEGRAM_OWNER_USER_ID;
const groupId = env.TELEGRAM_TEST_GROUP_CHAT_ID;
// Mail addresses are normalized to lowercase the moment they leave .env:
// every downstream layer (mail-triage validation, buildMailSendIntent, the
// adapter whitelist compare) works on the lowercased form, and the adapter's
// recipient check is an EXACT string compare — a mixed-case .env value would
// fail closed at dispatch with zero bytes sent.
const mailUser = String(env.MAIL_USER).trim().toLowerCase();
const mailRecipient = String(env.MAIL_TEST_RECIPIENT).trim().toLowerCase();
const imapPort = Number(env.MAIL_IMAP_PORT);
const smtpPort = Number(env.MAIL_SMTP_PORT);
if (!/^-?\d+$/.test(ownerUserId) || !/^-?\d+$/.test(groupId)) {
  console.error("TELEGRAM_OWNER_USER_ID / TELEGRAM_TEST_GROUP_CHAT_ID must be numeric ids");
  process.exit(3);
}
if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535 || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
  console.error("MAIL_IMAP_PORT / MAIL_SMTP_PORT must be integers in 1..65535");
  process.exit(3);
}
for (const [name, value] of [["MAIL_USER", mailUser], ["MAIL_TEST_RECIPIENT", mailRecipient]]) {
  if (!/^[^@\s]+@[^@\s]+$/.test(value)) {
    console.error(`${name} must be a bare mail address`);
    process.exit(3);
  }
}

// The single scrub gate every evidence string passes through.
const caldavUrl = readEnv("CALDAV_URL");
const caldavUser = readEnv("CALDAV_USER");
const caldavPassword = readEnv("CALDAV_PASSWORD");
const SECRET_MASKS = [
  [env.DEEPSEEK_API_KEY, "***"],
  [env.TELEGRAM_BOT_TOKEN, "[REDACTED_BOT_TOKEN]"],
  [ownerUserId, "[REDACTED_OWNER]"],
  [groupId, "[REDACTED_GROUP]"],
  [mailUser, "[REDACTED_MAIL_USER]"],
  [env.MAIL_APP_PASSWORD, "[REDACTED_MAIL_APP_PASSWORD]"],
  [mailRecipient, "[REDACTED_MAIL_RECIPIENT]"],
  [env.MAIL_IMAP_HOST, "[REDACTED_MAIL_HOST]"],
  [env.MAIL_SMTP_HOST, "[REDACTED_MAIL_HOST]"],
  [caldavUrl ?? "", "[REDACTED_CALDAV_URL]"],
  [caldavUser ?? "", "[REDACTED_CALDAV_USER]"],
  [caldavPassword ?? "", "[REDACTED_CALDAV_PASSWORD]"],
];
const RAW_SECRETS = SECRET_MASKS.map(([v]) => v).filter((v) => typeof v === "string" && v.length >= 4);
function scrub(text) {
  let out = String(text ?? "");
  for (const [val, mask] of SECRET_MASKS) {
    if (typeof val === "string" && val.length > 0) out = out.split(val).join(mask);
  }
  out = out.replace(/\/bot[^/\s"']+/g, "/bot[REDACTED_BOT_TOKEN]");
  out = out.replace(/sk-[A-Za-z0-9]{16,}/g, "***");
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[REDACTED_MAIL_ADDRESS]");
  return out;
}

const suite = makeSuite("scenarios-real");
const OWNER_CONSOLE = "prn:local:owner";
// The canary defaults to a fresh random marker; an explicit
// AEGISPI_REAL_CANARY lets the operator know the marker BEFORE an
// agent-driven run starts (the script's own stdout only reaches the
// operator after the process ends).
const injectedCanary = typeof process.env.AEGISPI_REAL_CANARY === "string" ? process.env.AEGISPI_REAL_CANARY.trim() : "";
if (injectedCanary.length > 0 && !/^[A-Za-z0-9-]{16,80}$/.test(injectedCanary)) {
  console.error("AEGISPI_REAL_CANARY must be 16-80 chars of [A-Za-z0-9-]");
  process.exit(3);
}
const CANARY = injectedCanary.length > 0 ? injectedCanary : `CNRY-AEGISPI-${randomBytes(8).toString("hex")}`;
const TG_PROXY = readEnv("AEGISPI_REAL_TG_PROXY") ?? "http://127.0.0.1:7897";
const SEND_WINDOW_MS = Number(readEnv("AEGISPI_REAL_WINDOW_MS") ?? 300000);

const telemetry = {
  permit: "AEGISPI_ALLOW_REAL_PHASE5_ACCEPTANCE=1",
  timings: { telegramStageMs: null, mailStageMs: null, calendarStageMs: null },
  telegram: { status: null, rounds: null, admitted: null, unauthorized: null, offsetBefore: null, offsetAfter: null, canary: null },
  mail: { status: null, inboxFetched: null, testEmail: null, draft: null, model: null, approval: null, smtp: null },
  calendar: { status: "PENDING" },
  budgetByPurpose: { worker: null, router: null, summary: null, classify: null },
};

function freshDb(tag) {
  const ws = makeWorkspace(tag);
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  return { ws, db };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The owner send-window: prints what to send, then waits. With a TTY the
// owner can press Enter to close the window early; without one (agent-driven
// run) the full window elapses so the owner has time to send.
async function ownerSendWindow({ windowMs, label }) {
  console.log("");
  console.log(`>>> [主人操作窗口 · ${label}] ${Math.round(windowMs / 1000)} 秒内完成以下两步（终端可回车提前结束等待）：`);
  console.log(`    1. 在 @aegispibot 私聊里给机器人发一条包含 ${CANARY} 的消息；`);
  console.log(`    2. 在私有测试群里发一条消息（例如：请总结我私聊里的内容）。`);
  console.log("");
  if (process.stdin.isTTY) {
    await new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        rl.close();
        resolve();
      };
      const timer = setTimeout(finish, windowMs);
      rl.once("line", finish);
    });
  } else {
    await sleep(windowMs);
  }
}

function objectFilesUnder(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) out.push(...objectFilesUnder(p));
    else out.push(p);
  }
  return out;
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function areDefaultsFailClosed(rawDefaults) {
  return (
    rawDefaults.model?.baseUrl === null &&
    rawDefaults.model?.allowRealModelCalls === false &&
    rawDefaults.policy?.allowRealExternalWrites === false &&
    rawDefaults.telegram?.apiBase === null &&
    rawDefaults.telegram?.allowRealPull === false &&
    Array.isArray(rawDefaults.telegram?.allowedChatIds) &&
    rawDefaults.telegram.allowedChatIds.length === 0 &&
    rawDefaults.mail?.imapHost === null &&
    rawDefaults.mail?.smtpHost === null &&
    rawDefaults.mail?.allowRealMailRead === false &&
    rawDefaults.mail?.allowRealMailSend === false &&
    rawDefaults.calendar?.caldavUrl === null &&
    rawDefaults.calendar?.allowRealCalendarRead === false &&
    rawDefaults.calendar?.allowRealCalendarWrite === false
  );
}

// ===========================================================================
// FINALIZE MODE (--finalize-kept-workspace) — crash recovery that never
// repeats an external side effect. The originating run (batch 3, run 4)
// judged all 23 checks green, sent exactly the ONE permitted email, and then
// crashed on a Windows teardown EBUSY BEFORE rewriting the evidence files.
// The quota forbids re-execution (a re-run would send a second email), so
// this mode re-derives every STATE-verifiable check read-only from the kept
// workspaces and cites the originating stdout log for the flow-only
// moments. It performs ZERO network/model/SMTP calls. The canary marker
// arrives via AEGISPI_REAL_CANARY (same injection the live run used).
// ===========================================================================
if (process.argv.includes("--finalize-kept-workspace")) {
  const tgStateDir = join(repoRoot, "workspace-state", "phase5", "scenarios-real-tg");
  const mailStateDir = join(repoRoot, "workspace-state", "phase5", "scenarios-real-mail");
  const finalizeCanary = typeof process.env.AEGISPI_REAL_CANARY === "string" ? process.env.AEGISPI_REAL_CANARY.trim() : "";
  if (finalizeCanary.length === 0) {
    console.error("finalize mode needs the originating canary marker via AEGISPI_REAL_CANARY");
    process.exit(3);
  }
  if (!existsSync(join(tgStateDir, "db", "aegis.db")) || !existsSync(join(mailStateDir, "db", "aegis.db"))) {
    console.error("finalize mode: kept workspace databases not found; nothing to finalize (NOT VERIFIED, exit 3)");
    process.exit(3);
  }
  const ORIGINATING_LOG = ".audit/batch3-real-run-4.log";
  const tgDb = openDatabase(join(tgStateDir, "db", "aegis.db"), { readOnly: true });
  const mailDb = openDatabase(join(mailStateDir, "db", "aegis.db"), { readOnly: true });

  const noteOrigin = (line) => `originating-run log ${ORIGINATING_LOG}: ${line}`;

  // ---- Telegram re-derivation ------------------------------------------
  const dmDomain = `dm:telegram:${ownerUserId}`;
  const groupDomain = `group:telegram:${groupId}`;
  const dmScopeId = tgDb.prepare("SELECT id FROM scopes WHERE domain_key=?").get(dmDomain)?.id;
  const groupScopeId = tgDb.prepare("SELECT id FROM scopes WHERE domain_key=?").get(groupDomain)?.id;
  const dmRows = dmScopeId ? tgDb.prepare("SELECT id, payload_object_id FROM inbox WHERE scope_id=? AND source='telegram'").all(dmScopeId) : [];
  const groupRows = groupScopeId ? tgDb.prepare("SELECT id, payload_object_id FROM inbox WHERE scope_id=? AND source='telegram'").all(groupScopeId) : [];
  const canaryHitIds = [];
  for (const r of dmRows) {
    if ((readObjectContent(tgDb, tgStateDir, r.payload_object_id) ?? "").includes(finalizeCanary)) canaryHitIds.push(r.payload_object_id);
  }
  const groupCanaryHits = groupRows.filter((r) => (readObjectContent(tgDb, tgStateDir, r.payload_object_id) ?? "").includes(finalizeCanary)).length;
  let canaryFiles = 0;
  for (const p of objectFilesUnder(join(tgStateDir, "objects"))) {
    try {
      if (readFileSync(p, "utf8").includes(finalizeCanary)) canaryFiles += 1;
    } catch {}
  }
  const foreignRows = tgDb
    .prepare("SELECT count(*) c FROM inbox i JOIN scopes s ON s.id=i.scope_id WHERE i.source='telegram' AND s.domain_key NOT IN (?,?)")
    .get(dmDomain, groupDomain).c;
  suite.check(
    "finalize-tg-canary-dm-home-only",
    canaryHitIds.length === 1 && groupCanaryHits === 0 && canaryFiles === 1 && foreignRows === 0,
    `kept tg workspace: canary DM payload objects=${canaryHitIds.length}, group canary hits=${groupCanaryHits}, canary in ALL object files=${canaryFiles}, foreign-scope telegram inbox rows=${foreignRows}`,
  );
  const senderPrincipal = `prn:telegram:${ownerUserId}`;
  const groupWalk = groupRows.length > 0 ? expandObjectGraph(tgDb, { rootObjectIds: [groupRows[groupRows.length - 1].payload_object_id], principalId: senderPrincipal, now: Date.now() }) : null;
  const dmWalk = canaryHitIds.length > 0 ? expandObjectGraph(tgDb, { rootObjectIds: [canaryHitIds[0]], principalId: senderPrincipal, now: Date.now() }) : null;
  suite.check(
    "finalize-tg-group-reader-refused-dm-canary",
    groupWalk !== null && groupWalk.objects.length === 1 && dmWalk !== null && dmWalk.objects.length === 0 && dmWalk.skipped >= 1,
    `kept grant state: group-scope walk serves its own payload (objects=${groupWalk?.objects.length ?? "-"}); the same principal walking the DM canary object is refused (objects=${dmWalk?.objects.length ?? "-"}, skipped=${dmWalk?.skipped ?? "-"})`,
  );
  const cp4Audits = tgDb.prepare("SELECT count(*) c FROM audit_log WHERE code='cp4_recipient_scope_leak_blocked'").get().c;
  const imNotifyEffects = tgDb.prepare("SELECT count(*) c FROM effects WHERE operation='im.notify'").get().c;
  suite.check(
    "finalize-tg-cp4-block-recorded",
    cp4Audits >= 1 && imNotifyEffects === 0,
    `kept tg workspace: cp4 audit rows=${cp4Audits}, im.notify effect rows=${imNotifyEffects}`,
  );
  const offsetRow = tgDb.prepare("SELECT value FROM system_state WHERE key='telegram_pull_offset'").get();
  suite.check(
    "finalize-tg-offset-persisted",
    offsetRow !== undefined && Number(offsetRow.value) > 0,
    `kept telegram_pull_offset=${offsetRow?.value ?? "-"}`,
  );
  const auditBlob = tgDb.prepare("SELECT details_json FROM audit_log").all().map((r) => String(r.details_json ?? "")).join("\n");
  suite.check(
    "finalize-tg-receipts-clean",
    !auditBlob.includes(finalizeCanary) && !auditBlob.includes(env.TELEGRAM_BOT_TOKEN),
    `kept tg audit: canary=${auditBlob.includes(finalizeCanary)}, token=${auditBlob.includes(env.TELEGRAM_BOT_TOKEN)}`,
  );
  suite.note("finalize-tg-flow-cited-from-originating-log", scrub(noteOrigin("PASS lines 1-18: fail-closed gate probe, flush/window/replay rounds=3 within the permit cap, group admission, zero unauthorized persistence, receipt scan")));

  // ---- Mail re-derivation ----------------------------------------------
  const mailInbox = mailDb.prepare("SELECT id, payload_object_id, scope_id FROM inbox WHERE source='mail' ORDER BY received_at DESC LIMIT 1").get();
  const mailPayload = mailInbox ? JSON.parse(readObjectContent(mailDb, mailStateDir, mailInbox.payload_object_id) ?? "{}") : {};
  suite.check(
    "finalize-mail-inbox-admitted-redacted",
    mailInbox !== undefined && typeof mailPayload.envelopeFrom === "string" && mailPayload.envelopeFrom.length > 0 && !String(mailPayload.summary ?? "").includes(env.MAIL_APP_PASSWORD),
    scrub(`kept mail workspace: admitted inbox row present; envelopeFrom=${mailPayload.envelopeFrom}; redacted subject="${String(mailPayload.subject ?? "").slice(0, 40)}"`),
  );
  const effect = mailDb.prepare("SELECT * FROM effects WHERE operation='mail.send'").get();
  let action = {};
  try {
    action = JSON.parse(effect?.action_json ?? "{}");
  } catch {}
  const draftObjectRow = mailDb.prepare("SELECT id, observed_at FROM objects WHERE kind='mail_draft' ORDER BY observed_at DESC LIMIT 1").get();
  const bodyHash = createHash("sha256").update(String(action.bodyText ?? "")).digest("hex");
  suite.check(
    "finalize-mail-draft-bound-to-action",
    typeof action.bodyText === "string" &&
      action.bodyText.length > 0 &&
      action.content_hash === bodyHash &&
      typeof draftObjectRow?.id === "string",
    `kept draft evidence: body chars=${String(action.bodyText ?? "").length}, action content_hash matches sha256(bodyText)=${action.content_hash === bodyHash}, mail_draft evidence row present (${draftObjectRow?.id ? "yes" : "no"}); the mail_draft/effect_response rows are hash-bound hollow references by product design — their bytes live in action_json, so the draft text is re-derived from there`,
  );
  const reservation = mailDb.prepare("SELECT * FROM budget_reservations WHERE purpose='worker' ORDER BY created_at DESC LIMIT 1").get();
  let settledDetails = null;
  for (const row of mailDb.prepare("SELECT details_json FROM audit_log WHERE code='budget_settled' ORDER BY rowid DESC LIMIT 10").all()) {
    try {
      const details = JSON.parse(row.details_json);
      if (details.reservation_id === reservation?.id) settledDetails = details;
    } catch {}
  }
  suite.check(
    "finalize-mail-budget-settled",
    reservation?.state === "SETTLED" &&
      reservation.actual_microusd > 0 &&
      reservation.actual_microusd <= 50000 &&
      settledDetails !== null &&
      settledDetails.actual_microusd === reservation.actual_microusd,
    `kept reservation ${reservation?.state ?? "?"} actual=${reservation?.actual_microusd ?? "-"}u$ (upper 50000u$), budget_settled audit carries the identical actual (${settledDetails?.actual_microusd ?? "no-matching-audit"}); the four-field TOKEN counts were judged live in the originating log (usage-4field=true, in/out=175/358)`,
  );
  const approval = mailDb.prepare("SELECT * FROM approvals WHERE state='CONSUMED' ORDER BY created_at DESC LIMIT 1").get();
  const approvalAudit = mailDb.prepare("SELECT count(*) c FROM audit_log WHERE code='approval_consumed'").get().c;
  suite.check(
    "finalize-mail-approval-consumed-via-console-cas",
    approval !== undefined && approval.effect_id === effect?.id && approvalAudit >= 1 && approval.approver_id === OWNER_CONSOLE,
    `kept approvals: CONSUMED card bound to the mail effect (approver=${approval?.approver_id ?? "-"}), approval_consumed audit rows=${approvalAudit}; the console session+CSRF flow is cited in the originating log`,
  );
  const responseRow = effect?.response_object_id ? mailDb.prepare("SELECT id FROM objects WHERE id=?").get(effect.response_object_id) : null;
  let succeededAuditExternalId = null;
  for (const row of mailDb.prepare("SELECT details_json FROM audit_log WHERE code='effect_succeeded' ORDER BY rowid DESC LIMIT 5").all()) {
    try {
      const details = JSON.parse(row.details_json);
      if (details.effect_id === effect?.id) succeededAuditExternalId = details.external_id ?? null;
    } catch {}
  }
  const mailSendRows = mailDb.prepare("SELECT count(*) c FROM effects WHERE operation='mail.send'").get().c;
  const mailSendSucceeded = mailDb.prepare("SELECT count(*) c FROM effects WHERE operation='mail.send' AND state='SUCCEEDED'").get().c;
  suite.check(
    "finalize-mail-effect-succeeded-external-id-recorded",
    mailSendRows === 1 &&
      mailSendSucceeded === 1 &&
      effect?.state === "SUCCEEDED" &&
      typeof effect?.external_id === "string" &&
      effect.external_id.length > 0 &&
      responseRow !== null &&
      responseRow !== undefined &&
      succeededAuditExternalId === effect.external_id &&
      effect.attempt_count === 1,
    scrub(`kept effects: mail.send rows=${mailSendRows} (SUCCEEDED=${mailSendSucceeded}, attempts=${effect?.attempt_count ?? "-"}); external_id=${String(effect?.external_id ?? "").slice(0, 44)} identical in the effect row and the effect_succeeded audit; effect_response reference row present (${responseRow ? "yes" : "no"} — hash-bound hollow row by product design, no file bytes)`),
  );
  const mailTask = effect ? mailDb.prepare("SELECT state FROM tasks WHERE id=?").get(effect.task_id) : null;
  const mailAttempt = effect ? mailDb.prepare("SELECT a.state FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.id=? ORDER BY a.attempt_no DESC LIMIT 1").get(effect.task_id) : null;
  suite.check(
    "finalize-mail-task-waiting-effect-attempt-parked",
    mailTask?.state === "WAITING_EFFECT" && mailAttempt?.state === "PARKED",
    `kept task state=${mailTask?.state ?? "-"}, attempt=${mailAttempt?.state ?? "-"} (the park survived; only the daemon's post-effect completion step is not part of this composed acceptance)`,
  );
  suite.note("finalize-mail-flow-cited-from-originating-log", scrub(noteOrigin("PASS lines 19-28: IMAP over TLS pull of 10 messages, envelope-sender admission, DeepSeek draft (reasoning:high), console session+CSRF consume=true (CONSUMED), smtp submits=1 with external_id recorded")));

  // ---- Honest boundary + defaults --------------------------------------
  const rawDefaultsFinalize = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
  suite.check(
    "finalize-defaults-json-still-fully-fail-closed",
    areDefaultsFailClosed(rawDefaultsFinalize),
    "repo defaults.json untouched (model / telegram-pull / mail / calendar gates all closed)",
  );

  telemetry.telegram = {
    status: "VERIFIED (finalized from kept workspace; originating log cited)",
    rounds: null,
    admitted: null,
    unauthorized: null,
    offsetBefore: null,
    offsetAfter: Number(offsetRow?.value ?? 0),
    canary: "dm-home-only",
  };
  telemetry.mail = {
    status: "VERIFIED (finalized from kept workspace; originating log cited)",
    inboxFetched: null,
    testEmail: null,
    draft: { chars: String(action.bodyText ?? "").length, sha256_12: String(action.content_hash ?? "").slice(0, 12) },
    model: {
      model: "deepseek/deepseek-flash",
      reasoning: "high",
      usage: {
        // Token counts are not re-derivable from the kept DB (the settle
        // audit of the originating run carried only actualMicrousd); they are
        // the originating run's judged live numbers, cited from its log.
        inputTokens: 175,
        outputTokens: 358,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        originSource: "originating run log (judged live: usage-4field=true)",
      },
      settledMicrousd: reservation?.actual_microusd ?? null,
      upperMicrousd: 50000,
    },
    approval: { via: "console-api 127.0.0.1:4310 (session+CSRF CAS)", decision: "approve", consumed: true },
    smtp: { sends: 1, tls: true, externalIdMasked: scrub(String(effect?.external_id ?? "").slice(0, 44)) },
  };
  telemetry.calendar = {
    status: "DEFERRED / NOT VERIFIED",
    reason: "CALDAV_* 未配置；主人裁定（D-102）：真实日历实盘延后，不阻塞 Phase 5；场景二闭环已由 Permit 1 环回 TLS 夹具（eval:scenarios）验收在案",
  };
  telemetry.budgetByPurpose.worker = {
    settledMicrousd: reservation?.actual_microusd ?? null,
    upperMicrousd: 50000,
    requests: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    originSource: "amounts re-derived from the kept reservation; token counts cited from the originating run log",
    note: "cacheWrite rate stays null (unauthorized price); a nonzero cacheWrite usage would keep the reservation HELD, never settle as zero",
  };

  const finalizeReportPaths = writeReport({
    suiteId: "scenarios-real",
    suite,
    label: "phase5:scenarios-real — 单元 5.6 许可 2 实盘验收（终局 finalize：自保留工作区只读重推 + 原始运行日志引用）",
    extra: {
      dataSources: "终局 finalize（--finalize-kept-workspace）：对第 4 次实盘运行（23/23 全 PASS、真实 SMTP 已发恰 1 封）因 Windows 收尾 EBUSY 崩溃未及重写的证据，从保留工作区只读重推全部可由状态验证的断言；零网络/零模型/零 SMTP 调用；全程脱敏；真实 CalDAV 按 D-102 登记 DEFERRED / NOT VERIFIED",
      permit: telemetry.permit,
      finalization: {
        mode: "--finalize-kept-workspace",
        originatingLog: ORIGINATING_LOG,
        originatingRunChecks: "23 PASS / 0 FAIL (see the originating log; all external stages completed there)",
        originatingRunExit: "1 (teardown EBUSY crash AFTER all 23 checks passed, before evidence rewrite)",
        quotaNote: "恰 1 封真实回信已由原始运行发出；本批不允许为证据重写再执行一次实盘（那会发出第 2 封），故以只读 finalize 补齐证据",
      },
      telegram: telemetry.telegram,
      mail: telemetry.mail,
      calendar: telemetry.calendar,
      budgetByPurpose: telemetry.budgetByPurpose,
      timings: { telegramStageMs: null, mailStageMs: null, calendarStageMs: null },
    },
  });
  const finalizeLeaked = [];
  for (const p of [finalizeReportPaths.reportPath, finalizeReportPaths.logPath]) {
    const text = readFileSync(p, "utf8");
    for (const secret of RAW_SECRETS) {
      if (secret && text.includes(secret)) finalizeLeaked.push(`${p.split(/[\\/]/).pop()}:${secret.slice(0, 3)}…`);
    }
  }
  if (finalizeLeaked.length > 0) {
    console.error(`PLAINTEXT TRIPWIRE TRIPPED: ${finalizeLeaked.join(", ")}`);
    try { tgDb.close(); } catch {}
    try { mailDb.close(); } catch {}
    process.exit(1);
  }
  try { tgDb.close(); } catch {}
  try { mailDb.close(); } catch {}
  process.exit(suiteExit(suite, { label: "phase5:scenarios-real (finalize)" }));
}
// ===========================================================================
// PART A — Telegram Route-1 pull (<=3 getUpdates rounds).
// ===========================================================================
const tgWsHolder = { ws: null, db: null };
let getUpdatesCalls = 0;
{
  const stageStart = Date.now();
  const { ws, db } = freshDb("scenarios-real-tg");
  tgWsHolder.ws = ws;
  tgWsHolder.db = db;
  const dmDomain = `dm:telegram:${ownerUserId}`;
  const groupDomain = `group:telegram:${groupId}`;
  const tgEnvName = "AEGISPI_REAL_TG_TOKEN";
  process.env[tgEnvName] = env.TELEGRAM_BOT_TOKEN;
  createCredentialService(db).registerSlot({ slot: "im", envName: tgEnvName, purpose: "telegram bot token (real)", now: Date.now(), actorId: "owner" });
  const credentials = createCredentialService(db);

  const telegramReal = {
    apiBase: "https://api.telegram.org",
    allowRealPull: true,
    allowedChatIds: [ownerUserId, groupId],
    pullBatchLimit: 100,
    pullTimeoutSeconds: 0,
    timeoutMs: 20000,
    proxyUrl: TG_PROXY,
  };

  // A-0: the fail-closed gate refuses BEFORE any network byte (this call
  // must not spend a getUpdates round — the counting runner proves it).
  const baseRunner = createTelegramPullRunner();
  const countingRunner = (args) => {
    getUpdatesCalls += 1;
    return baseRunner(args);
  };
  const closed = pullTelegramUpdates(db, ws.stateDir, { telegram: { ...telegramReal, allowRealPull: false }, credentials, now: Date.now() });
  suite.check(
    "tg-fail-closed-without-allowrealpull-flag",
    typeof closed.skipped === "string" && /allowRealPull is false/.test(closed.skipped) && getUpdatesCalls === 0,
    `${String(closed.skipped ?? "").slice(0, 80)}; getUpdates spent=${getUpdatesCalls}`,
  );

  const pullOnce = () => pullTelegramUpdates(db, ws.stateDir, { telegram: telegramReal, credentials, now: Date.now(), runner: countingRunner });

  // Round 1 — backlog flush BEFORE the owner window: whatever the platform
  // queue already holds is ingested idempotently per the REAL pull flow
  // (sanctioned by D-102: 幂等入库 or cursor advance within the authorized
  // window — never a blind confirm-and-skip), so the owner's canary
  // messages land in a CLEAN window instead of behind an unknown backlog.
  const flush = pullOnce();
  suite.note(
    "tg-round-1-backlog-flush",
    scrub(`flush round pulled=${flush.pulled ?? "-"} admitted=${flush.admitted ?? "-"} masked-dropped=${flush.skippedUnauthorized ?? 0}; cursor ${flush.offsetBefore ?? "-"} -> ${flush.offsetAfter ?? "-"}`),
  );

  await ownerSendWindow({ windowMs: SEND_WINDOW_MS, label: "Telegram" });

  let first = pullOnce();
  const canaryInDmNow = () => {
    const rows = db
      .prepare("SELECT i.payload_object_id FROM inbox i JOIN scopes s ON s.id=i.scope_id WHERE s.domain_key=? AND i.source='telegram'")
      .all(dmDomain);
    for (const r of rows) {
      const text = readObjectContent(db, ws.stateDir, r.payload_object_id) ?? "";
      if (text.includes(CANARY)) return true;
    }
    return false;
  };
  let usedRetry = false;
  if (!canaryInDmNow()) {
    suite.note(
      "tg-canary-missing-after-window-round",
      scrub(`window round admitted=${first.admitted ?? "?"} pulled=${first.pulled ?? "?"}; waiting 60s for the owner's canary DM, then one retry round`),
    );
    await sleep(60000);
    first = pullOnce();
    usedRetry = true;
  }
  // The replay round proves the persisted cursor: nothing new is consumed
  // and no duplicate rows appear. It only runs when the permit budget still
  // holds a round; the offline test:cross-channel suite owns the crash-window
  // replay proof otherwise.
  let replay = null;
  if (!usedRetry) {
    replay = pullOnce();
  }

  const dmScopeId = db.prepare("SELECT id FROM scopes WHERE domain_key=?").get(dmDomain)?.id;
  const groupScopeId = db.prepare("SELECT id FROM scopes WHERE domain_key=?").get(groupDomain)?.id;
  const dmRows = dmScopeId ? db.prepare("SELECT id, payload_object_id, received_at FROM inbox WHERE scope_id=? AND source='telegram' ORDER BY received_at").all(dmScopeId) : [];
  const groupRows = groupScopeId ? db.prepare("SELECT id, payload_object_id, received_at FROM inbox WHERE scope_id=? AND source='telegram' ORDER BY received_at").all(groupScopeId) : [];

  const canaryHitIds = [];
  for (const r of dmRows) {
    const text = readObjectContent(db, ws.stateDir, r.payload_object_id) ?? "";
    if (text.includes(CANARY)) canaryHitIds.push(r.payload_object_id);
  }
  const groupCanaryHits = [];
  for (const r of groupRows) {
    const text = readObjectContent(db, ws.stateDir, r.payload_object_id) ?? "";
    if (text.includes(CANARY)) groupCanaryHits.push(r.id);
  }
  const otherScopesWithTelegram = db
    .prepare("SELECT count(*) c FROM inbox i JOIN scopes s ON s.id=i.scope_id WHERE i.source='telegram' AND s.domain_key NOT IN (?,?)")
    .get(dmDomain, groupDomain).c;
  const offsetNow = readPullOffset(db);
  const offsetRow = db.prepare("SELECT value FROM system_state WHERE key='telegram_pull_offset'").get();

  suite.check(
    "tg-dm-canary-admitted-into-owner-dm-scope",
    canaryHitIds.length >= 1,
    `canary DM payload objects=${canaryHitIds.length} in the owner-dm scope (rounds spent=${getUpdatesCalls}, last pull admitted=${first.admitted ?? "?"})`,
  );
  suite.check(
    "tg-group-message-admitted-into-test-group-scope",
    groupRows.length >= 1 && groupCanaryHits.length === 0,
    `group inbox rows=${groupRows.length}; canary inside group payloads=${groupCanaryHits.length}`,
  );
  suite.check(
    "tg-unauthorized-chats-zero-persistence",
    otherScopesWithTelegram === 0,
    `whitelisted-only persistence: foreign-scope telegram inbox rows=${otherScopesWithTelegram}; masked-dropped unauthorized=${first.skippedUnauthorized ?? 0}`,
  );

  // Object-layer isolation: the sender principal gets a read grant on the
  // GROUP scope only; the L1 graph walk then serves its own group payload
  // but REFUSES the DM canary object (fail-closed closure, not vacuity).
  const senderPrincipal = `prn:telegram:${ownerUserId}`;
  if (groupRows.length > 0) {
    grantPermission(db, { scopeId: groupScopeId, principalId: senderPrincipal, permission: "read", now: Date.now() });
  }
  const groupWalk =
    groupRows.length > 0
      ? expandObjectGraph(db, { rootObjectIds: [groupRows[groupRows.length - 1].payload_object_id], principalId: senderPrincipal, now: Date.now() })
      : null;
  const dmWalk = canaryHitIds.length > 0 ? expandObjectGraph(db, { rootObjectIds: [canaryHitIds[0]], principalId: senderPrincipal, now: Date.now() }) : null;
  suite.check(
    "tg-group-reader-cannot-reach-dm-canary-object",
    groupWalk !== null && groupWalk.objects.length === 1 && dmWalk !== null && dmWalk.objects.length === 0 && dmWalk.skipped >= 1,
    `group-scope walk serves its own payload (objects=${groupWalk?.objects.length ?? "-"}); the same principal walking the DM canary object is refused (objects=${dmWalk?.objects.length ?? "-"}, skipped=${dmWalk?.skipped ?? "-"})`,
  );

  // CP4 red line: a GROUP task proposing to ship the DM canary toward the
  // group target is killed at proposal with an audit row and zero effect
  // rows — no outbound byte exists to scrub.
  let cp4Blocked = false;
  let cp4Error = null;
  let cp4Effects = -1;
  let cp4Audits = 0;
  if (groupRows.length > 0 && canaryHitIds.length > 0) {
    const newestGroupRow = db.prepare("SELECT * FROM inbox WHERE scope_id=? AND source='telegram' ORDER BY received_at DESC LIMIT 1").get(groupScopeId);
    dispatchEventToTask(db, {
      inboxId: newestGroupRow.id,
      dispatchKey: dispatchKeyForInbox(newestGroupRow),
      now: Date.now(),
      priority: 5,
      maxSteps: 25,
      deadlineAt: Date.now() + 15 * 60 * 1000,
      skillSetHash: "ss-real-cp4-probe",
    });
    const claim = claimNextTask(db, { now: Date.now(), leaseMs: 45000 });
    try {
      proposeEffect(db, ws.stateDir, {
        now: Date.now(),
        taskId: claim.taskId,
        attemptId: claim.attemptId,
        effectType: "notify",
        domainKey: groupDomain,
        naturalKey: "real-cp4-leak-probe",
        operationIntent: {
          targetResource: groupDomain,
          operation: "im.notify",
          contentHash: createHash("sha256").update(`cp4 real probe ${CANARY}`).digest("hex"),
          evidenceManifestHash: "f".repeat(64),
          parentObjectIds: [canaryHitIds[0]],
          payloadContent: `real leak probe quoting the DM canary ${CANARY}`,
        },
        retryMode: "AT_MOST_ONCE",
        provider: "telegram",
        resource: groupDomain,
        requiresApproval: true,
        approverPrincipalId: OWNER_CONSOLE,
        expiresAt: Date.now() + 3600_000,
      });
    } catch (e) {
      cp4Blocked = e instanceof EffectCp4Blocked;
      cp4Error = String(e?.message ?? e).slice(0, 120);
    }
    cp4Effects = db.prepare("SELECT count(*) c FROM effects WHERE operation='im.notify'").get().c;
    cp4Audits = db.prepare("SELECT count(*) c FROM audit_log WHERE code='cp4_recipient_scope_leak_blocked'").get().c;
  }
  suite.check(
    "tg-cp4-blocks-group-proposal-citing-dm-canary",
    cp4Blocked === true && cp4Effects === 0 && cp4Audits >= 1,
    `group-task leak proposal toward the group: blocked=${cp4Blocked}${cp4Error ? ` (${scrub(cp4Error)})` : ""}, effect rows=${cp4Effects}, cp4 audit rows=${cp4Audits} (zero outbound bytes)`,
  );

  suite.check(
    "tg-pull-offset-persisted",
    offsetNow > 0 && offsetRow !== undefined && String(offsetRow.value) === String(offsetNow),
    `telegram_pull_offset persisted=${offsetRow !== undefined} value=${offsetNow} (flush started at ${flush.offsetBefore ?? "-"}; window round reports after=${first.offsetAfter ?? "-"})`,
  );
  if (replay !== null) {
    suite.check(
      "tg-replay-pull-idempotent",
      (replay.pulled ?? 1) === 0 && (replay.admitted ?? 1) === 0 && readPullOffset(db) === offsetNow,
      `replay round pulled=${replay.pulled ?? "-"} admitted=${replay.admitted ?? "-"} duplicates=${replay.duplicates ?? "-"}; cursor stable at ${offsetNow}`,
    );
  } else {
    suite.note(
      "tg-replay-pull-not-run-budget-spent",
      "the canary retry consumed the 3-round permit budget; the crash-window replay proof stays with the offline test:cross-channel suite",
    );
  }
  suite.check(
    "tg-getupdates-rounds-within-permit-budget",
    getUpdatesCalls >= 2 && getUpdatesCalls <= 3,
    `getUpdates rounds spent=${getUpdatesCalls} (1 backlog flush + ${usedRetry ? "1 window + 1 retry" : "1 window + 1 replay"}; permit cap 3)`,
  );

  // Receipt scrubbing: the pull's control receipts (audit rows) never carry
  // message text or credentials.
  const auditRows = db.prepare("SELECT details_json FROM audit_log").all();
  const auditBlob = auditRows.map((r) => String(r.details_json ?? "")).join("\n");
  suite.check(
    "tg-control-receipts-carry-no-content-or-credentials",
    !auditBlob.includes(CANARY) && !auditBlob.includes(env.TELEGRAM_BOT_TOKEN),
    `audit rows=${auditRows.length}; canary in audit=${auditBlob.includes(CANARY)}; token in audit=${auditBlob.includes(env.TELEGRAM_BOT_TOKEN)}`,
  );

  // Canary file-level matrix: every object content file is scanned.
  const allObjectFiles = objectFilesUnder(join(ws.stateDir, "objects"));
  let canaryFiles = 0;
  for (const p of allObjectFiles) {
    try {
      if (readFileSync(p, "utf8").includes(CANARY)) canaryFiles += 1;
    } catch {}
  }
  suite.check(
    "tg-canary-lives-only-in-its-dm-home-file",
    canaryHitIds.length >= 1 && canaryFiles === canaryHitIds.length,
    `canary occurrences in object files=${canaryFiles}, all inside the DM payload home (${canaryHitIds.length} DM payload object(s))`,
  );

  telemetry.telegram = {
    status: canaryHitIds.length >= 1 && groupCanaryHits.length === 0 && canaryFiles === canaryHitIds.length ? "VERIFIED" : "FAILED",
    rounds: getUpdatesCalls,
    admitted: (flush.admitted ?? 0) + (first.admitted ?? 0),
    unauthorized: (flush.skippedUnauthorized ?? 0) + (first.skippedUnauthorized ?? 0),
    offsetBefore: flush.offsetBefore ?? null,
    offsetAfter: offsetNow,
    canary: canaryHitIds.length >= 1 && canaryFiles === canaryHitIds.length ? "dm-home-only" : "leak-suspected",
  };
  telemetry.timings.telegramStageMs = Date.now() - stageStart;
  delete process.env[tgEnvName];
}

// ===========================================================================
// PART B — real mailbox: IMAP pull -> DeepSeek draft -> PARKED -> console
// approve at 127.0.0.1:4310 -> SMTP sends EXACTLY ONE reply.
// ===========================================================================
const mailWsHolder = { ws: null, db: null };
{
  const stageStart = Date.now();
  const { ws, db } = freshDb("scenarios-real-mail");
  mailWsHolder.ws = ws;
  mailWsHolder.db = db;
  const now = Date.now();

  const mailReal = {
    imapHost: env.MAIL_IMAP_HOST,
    imapPort,
    imapTls: true,
    smtpHost: env.MAIL_SMTP_HOST,
    smtpPort,
    smtpTls: true,
    allowRealMailRead: true,
    allowRealMailSend: true,
    allowedFolders: ["INBOX"],
    allowedSenders: [],
    allowedRecipients: [mailRecipient],
    approvalTtlMs: 14400000,
    maxAttachmentBytes: 4194304,
    timeoutMs: 60000,
  };
  const adaptersReal = {
    fixedSendingIdentity: mailUser,
    allowedRecipients: [mailRecipient],
    allowedRepos: [],
    allowedBranches: [],
  };
  const credEnvName = "AEGISPI_REAL_MAIL_CREDENTIAL";
  process.env[credEnvName] = `${mailUser}:${env.MAIL_APP_PASSWORD}`;
  createCredentialService(db).registerSlot({ slot: "mail", envName: credEnvName, purpose: "mailbox app password (real)", now, actorId: "owner" });

  // B-0: fail-closed sanity with the REAL hosts but the read flag off —
  // zero IMAP bytes; then the send gate probe with the send flag off.
  const closedRead = pullMailMessages(db, { mail: { ...mailReal, allowRealMailRead: false }, now });
  const sendGate = createMailUpstream(db, { mail: { ...mailReal, allowRealMailSend: false }, now: () => Date.now() }).gateSummary();
  suite.check(
    "mail-fail-closed-without-read-send-flags",
    typeof closedRead.skipped === "string" && /allowRealMailRead is false/.test(closedRead.skipped) && sendGate.authorized === false,
    `${String(closedRead.skipped ?? "").slice(0, 70)}; send gate authorized=${sendGate.authorized} (${String(sendGate.reason ?? "").slice(0, 60)})`,
  );

  // B-1: real IMAP over TLS, read-only.
  const pulled = pullMailMessages(db, { mail: mailReal, now, limit: 10, timeoutMs: 60000 });
  suite.check(
    "mail-real-imap-pull-over-tls",
    Array.isArray(pulled.fetched) && pulled.fetched.length > 0,
    typeof pulled.failed === "string"
      ? scrub(`IMAP pull failed: ${pulled.failed}`)
      : `INBOX fetched (read-only LOGIN/SELECT/UID SEARCH/UID FETCH) = ${pulled.fetched?.length ?? 0} message(s)`,
  );

  // B-2: the placed test email is the NEWEST message.
  const testEmail = Array.isArray(pulled.fetched) && pulled.fetched.length > 0 ? pulled.fetched[pulled.fetched.length - 1] : null;
  suite.check(
    "mail-test-message-identified",
    testEmail !== null && /^[^@\s]+@[^@\s]+$/.test(String(testEmail?.from?.address ?? "")),
    testEmail === null
      ? "no message to identify (INBOX empty or pull failed)"
      : scrub(`newest INBOX message uid=${testEmail.uid} subject="${String(testEmail.subject ?? "").slice(0, 60)}" from=${testEmail.from?.address}`),
  );

  if (testEmail !== null) {
    // The runtime whitelist for THIS test context only: the placed test
    // email's sender is the sole allowed sender; the reply may only go to
    // MAIL_TEST_RECIPIENT. Both live in the gitignored workspace-state; the
    // evidence copy below is redacted.
    mailReal.allowedSenders = [String(testEmail.from.address).toLowerCase()];
    writeFileSync(
      join(ws.stateDir, "real-mail-config.scrubbed.json"),
      JSON.stringify(
        {
          note: "permit-2 runtime whitelist (gitignored workspace-state only; scrubbed copy for evidence)",
          mail: {
            imapPort,
            smtpPort,
            imapTls: true,
            smtpTls: true,
            allowRealMailRead: true,
            allowRealMailSend: true,
            allowedFolders: ["INBOX"],
            allowedSenders: ["[the placed test email's envelope sender]"],
            allowedRecipients: ["[REDACTED_MAIL_RECIPIENT]"],
          },
          adapters: { fixedSendingIdentity: "[REDACTED_MAIL_USER]", allowedRecipients: ["[REDACTED_MAIL_RECIPIENT]"] },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    ensurePrincipal(db, { platform: "local", subject: "owner" });
    ensureMailScope(db, { account: mailUser, ownerId: OWNER_CONSOLE, policyVersion: "pv1" });
    const mailScopeId = db.prepare("SELECT id FROM scopes WHERE domain_key=?").get(`dm:mail:${mailUser}`)?.id;
    for (const p of ["read", "request", "approve", "admin"]) {
      grantPermission(db, { scopeId: mailScopeId, principalId: OWNER_CONSOLE, permission: p, now });
    }

    // B-3: ingest through the real triage path (identity from the ENVELOPE
    // sender only; redacted summary; sha256 attachments).
    const ing = ingestInboundMail(db, ws.stateDir, {
      now,
      account: mailUser,
      message: testEmail,
      ownerId: OWNER_CONSOLE,
      mailConfig: mailReal,
    });
    const payloadObj = ing.admitted ? JSON.parse(readObjectContent(db, ws.stateDir, ing.objectId)) : null;
    suite.check(
      "mail-envelope-sender-whitelist-admits-test-message",
      ing.admitted === true && payloadObj !== null && payloadObj.envelopeFrom === mailReal.allowedSenders[0],
      ing.admitted
        ? scrub(`admitted into ${ing.scopeId}; thread=${ing.threadKey.slice(0, 24)}…; redacted subject="${String(payloadObj.subject ?? "").slice(0, 50)}"`)
        : `refused: ${String(ing.reason ?? "")}`,
    );

    if (ing.admitted) {
      // B-4: dispatch + claim, then ONE DeepSeek draft call.
      const inboxRow = db.prepare("SELECT * FROM inbox WHERE id=?").get(ing.inboxId);
      dispatchEventToTask(db, {
        inboxId: inboxRow.id,
        dispatchKey: dispatchKeyForInbox(inboxRow),
        now,
        priority: 5,
        maxSteps: 25,
        deadlineAt: now + 15 * 60 * 1000,
        skillSetHash: "ss-real-mail",
      });
      const claim = claimNextTask(db, { now, leaseMs: 45000 });
      suite.check(
        "mail-task-dispatched-and-claimed",
        typeof claim.taskId === "string" && typeof claim.attemptId === "string",
        `task/attempt claimed (${String(claim.taskId).slice(0, 12)}…)`,
      );

      const ledger = createBudgetLedger(db, { taskLimitMicrousd: 800000, dayLimitMicrousd: 5000000, warmingEnabled: false, timeZone: "Asia/Hong_Kong" });
      const CALL_UPPER_MICROUSD = 50000;
      const PEAK_CATALOG = {
        inputPerMTokMicrousd: 300000,
        outputPerMTokMicrousd: 1200000,
        cacheReadPerMTokMicrousd: 6000,
        cacheWritePerMTokMicrousd: null,
      };
      const taskAcc = ledger.ensureTaskAccount({ taskId: claim.taskId, now }).accountId;
      const dayAcc = ledger.ensureDayAccount({ now }).accountId;
      const reservation = ledger.reserve({
        requestKey: `model:real-mail-draft:${claim.taskId}`,
        taskId: claim.taskId,
        purpose: "worker",
        provider: "deepseek",
        priceVersion: "catalog-v1",
        upperMicrousd: CALL_UPPER_MICROUSD,
        accounts: [
          { accountId: taskAcc, amountMicrousd: Math.ceil(CALL_UPPER_MICROUSD / 2) },
          { accountId: dayAcc, amountMicrousd: Math.floor(CALL_UPPER_MICROUSD / 2) },
        ],
        now,
      });

      const messages = [
        {
          role: "system",
          content:
            "你是 AegisPi 宿主的邮件分诊助手。根据一封收件箱邮件的主题与已脱敏摘要，写一封简短、礼貌、专业的中文回复草稿。只输出草稿正文本身，不要任何解释或前后缀；不得编造事实，不得承诺任何未在来信中出现的行动。",
        },
        {
          role: "user",
          content: JSON.stringify({ mailSubject: payloadObj.subject, mailSummary: payloadObj.summary }),
        },
      ];
      const call = callModelOnce({
        baseUrl: "https://api.deepseek.com",
        model: "deepseek/deepseek-flash",
        messages,
        timeoutMs: 120000,
        bearer: env.DEEPSEEK_API_KEY,
        maxTokens: 8192,
      });
      const draft = typeof call.reply === "string" ? call.reply.trim() : "";
      suite.check(
        "mail-deepseek-draft-generated-reasoning-high",
        call.ok === true && draft.length > 0,
        call.ok
          ? `draft chars=${draft.length} sha256=${createHash("sha256").update(draft).digest("hex").slice(0, 12)}… (deepseek/deepseek-flash, reasoning:high, endpoint=${scrub(call.endpoint)})`
          : scrub(`model call failed (${call.kind}): ${String(call.error ?? "").slice(0, 140)}`),
      );

      const priced = call.ok ? microusdForUsage(call.usage, PEAK_CATALOG) : null;
      let settleError = null;
      if (priced !== null) {
        try {
          ledger.settle({
            reservationId: reservation.reservationId,
            usage: { actualMicrousd: priced, source: "pi-ai", basis: "four-field usage from pi-ai 1.5.2 priced by host catalog" },
            now: Date.now(),
            actorId: OWNER_CONSOLE,
          });
        } catch (e) {
          settleError = String(e?.message ?? e);
        }
      }
      const resRow = db.prepare("SELECT state, actual_microusd, upper_microusd FROM budget_reservations WHERE id=?").get(reservation.reservationId);
      // The pi-ai parse contract (microusdForUsage / ADR §6): totalFromProvider
      // is required to EXIST as a boolean — false means pi-ai priced the cost
      // itself from real tokens, absent means a stream placeholder. All four
      // token fields must be non-negative integers; a nonzero category with a
      // null catalog rate keeps the reservation HELD, never a zero settle.
      const usageOk =
        call.usage !== null &&
        Object.prototype.hasOwnProperty.call(call.usage, "totalFromProvider") &&
        typeof call.usage.totalFromProvider === "boolean" &&
        Number.isInteger(call.usage.inputTokens) &&
        call.usage.inputTokens >= 0 &&
        Number.isInteger(call.usage.outputTokens) &&
        call.usage.outputTokens >= 0 &&
        Number.isInteger(call.usage.cacheReadTokens) &&
        call.usage.cacheReadTokens >= 0 &&
        Number.isInteger(call.usage.cacheWriteTokens) &&
        call.usage.cacheWriteTokens >= 0;
      suite.check(
        "mail-budget-reserved-then-settled-four-field",
        resRow?.state === "SETTLED" && resRow.actual_microusd > 0 && resRow.actual_microusd <= CALL_UPPER_MICROUSD && priced === resRow.actual_microusd && usageOk && settleError === null,
        `reservation ${resRow?.state ?? "?"} actual=${resRow?.actual_microusd ?? "-"}u$ upper=${CALL_UPPER_MICROUSD}u$ priced-match=${priced === resRow?.actual_microusd} usage-4field=${usageOk}${settleError ? ` settle-error=${scrub(settleError).slice(0, 60)}` : ""} tokens in/out=${call.usage?.inputTokens ?? "-"}/${call.usage?.outputTokens ?? "-"} (totalFromProvider=${typeof call.usage?.totalFromProvider === "boolean" ? call.usage.totalFromProvider : "absent"})`,
      );
      telemetry.budgetByPurpose.worker = {
        settledMicrousd: resRow?.actual_microusd ?? null,
        upperMicrousd: CALL_UPPER_MICROUSD,
        requests: 1,
        cacheReadTokens: call.usage?.cacheReadTokens ?? null,
        cacheWriteTokens: call.usage?.cacheWriteTokens ?? null,
        note: "cacheWrite rate stays null (unauthorized price); a nonzero cacheWrite usage would keep the reservation HELD, never settle as zero",
      };

      if (draft.length > 0) {
        // B-5: the draft-first proposal parks the attempt WITHOUT a fence
        // bump, with a 4h approval card.
        const draftIntent = buildMailSendIntent({
          to: [mailRecipient],
          subject: `Re: ${String(testEmail.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, 900)}`,
          bodyText: draft,
          sendingIdentity: mailUser,
          threadKey: ing.threadKey,
          inReplyTo: String(testEmail.messageId ?? "") || null,
          references: String(testEmail.references ?? "") || null,
        });
        const draftEvidenceHash = createHash("sha256").update(draftIntent.bodyText).digest("hex");
        insertMailDraftEvidence(db, ws.stateDir, { now: Date.now(), taskId: claim.taskId, scopeId: ing.scopeId, threadObjectIds: [ing.objectId], draftText: draftIntent.bodyText });
        const fenceBefore = db.prepare("SELECT fence FROM tasks WHERE id=?").get(claim.taskId).fence;
        let proposed = null;
        let proposeError = null;
        try {
          proposed = proposeMailReplyEffect(db, ws.stateDir, {
            now: Date.now(),
            taskId: claim.taskId,
            attemptId: claim.attemptId,
            account: mailUser,
            intent: draftIntent,
            mailConfig: mailReal,
            adaptersConfig: adaptersReal,
            evidenceManifestHash: draftEvidenceHash,
            parentObjectIds: [ing.objectId],
            approverPrincipalId: OWNER_CONSOLE,
          });
        } catch (e) {
          proposeError = String(e?.message ?? e);
        }
        const taskAfter = db.prepare("SELECT state, lease_owner, fence FROM tasks WHERE id=?").get(claim.taskId);
        const attemptAfter = db.prepare("SELECT state FROM attempts WHERE id=?").get(claim.attemptId);
        const effectRow = proposed ? db.prepare("SELECT retry_mode, state FROM effects WHERE id=?").get(proposed.effectId) : null;
        suite.check(
          "mail-draft-parks-attempt-waiting-approval",
          proposeError === null &&
            taskAfter.state === "WAITING_APPROVAL" &&
            attemptAfter.state === "PARKED" &&
            taskAfter.lease_owner === null &&
            taskAfter.fence === fenceBefore &&
            effectRow?.state === "WAITING_APPROVAL" &&
            effectRow?.retry_mode === "AT_MOST_ONCE" &&
            proposed?.approvalId !== null,
          proposeError !== null
            ? scrub(`proposal refused: ${proposeError.slice(0, 140)}`)
            : scrub(`task=${taskAfter.state} attempt=${attemptAfter.state} lease=${taskAfter.lease_owner} fence-unchanged=${taskAfter.fence === fenceBefore} effect=${effectRow?.state}/${effectRow?.retry_mode} approval=${proposed.approvalId}`),
        );
        if (proposeError !== null) {
          suite.note("mail-proposal-refused-skipping-console-and-smtp", "the draft proposal was refused; the console approve and SMTP dispatch stages cannot run");
        }

        if (proposed) {
        // B-6: the local console at 127.0.0.1:4310 — real TCP, real
        // Host/Origin gate, bootstrap read-only, session+CSRF mutation.
        const { token } = ensureConsoleToken(ws.stateDir);
        const consoleApp = createConsoleApp(db, {
          recovery: { mode: "open", actions: [], failedStep: null },
          mode: "open",
          token,
          port: CONSOLE_DEFAULT_PORT,
          stateDir: ws.stateDir,
          ownerPrincipalId: OWNER_CONSOLE,
        });
        let served;
        try {
          served = await serveConsole(consoleApp, { port: CONSOLE_DEFAULT_PORT });
        } catch (e) {
          served = { error: String(e?.message ?? e) };
        }
        const consoleOk = served && !served.error;
        const base = `http://${CONSOLE_BIND}:${CONSOLE_DEFAULT_PORT}`;
        let healthOk = false;
        let bootstrapView = null;
        let bootstrapDecide = null;
        let session = null;
        let materials = null;
        let decide = null;
        if (consoleOk) {
          // The approval id carries percent-encoded colons (apr:efx:mail%3A…):
          // placing it RAW in a URL path would let the server decode it once
          // and look up a different id (the D-98 audit probe bug — the console
          // contract is a once-more-encoded path segment).
          const approvalPathId = encodeURIComponent(proposed.approvalId);
          try {
            const healthRes = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } });
            healthOk = healthRes.status === 200;
            const viewRes = await fetch(`${base}/api/approvals/${approvalPathId}`, { headers: { authorization: `Bearer ${token}` } });
            bootstrapView = await viewRes.json();
            bootstrapDecide = await (
              await fetch(`${base}/api/approvals/${approvalPathId}/decide`, {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ decision: "approve", actionHash: "x", nonce: "y" }),
              })
            ).status;
            session = await (
              await fetch(`${base}/api/session`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
                body: JSON.stringify({ token }),
              })
            ).json();
            materials = await (
              await fetch(`${base}/api/approvals/${approvalPathId}`, {
                headers: { authorization: `Bearer ${session.sessionId}` },
              })
            ).json();
            decide = await (
              await fetch(`${base}/api/approvals/${approvalPathId}/decide`, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${session.sessionId}`,
                  "x-csrf-token": session.csrfToken,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  decision: "approve",
                  actionHash: materials.decisionMaterials?.actionHash,
                  nonce: materials.decisionMaterials?.nonce,
                }),
              })
            ).json();
          } finally {
            if (served?.server) await closeServer(served.server);
          }
        }
        const effectAfterDecide = db.prepare("SELECT state FROM effects WHERE id=?").get(proposed.effectId);
        const taskAfterDecide = db.prepare("SELECT state FROM tasks WHERE id=?").get(claim.taskId);
        suite.check(
          "mail-console-approval-via-local-console",
          consoleOk &&
            healthOk &&
            bootstrapView?.decisionMaterials == null &&
            bootstrapDecide === 401 &&
            typeof session?.sessionId === "string" &&
            materials?.decisionMaterials?.actionHash === proposed.actionHash &&
            materials?.decisionMaterials?.nonce === proposed.approvalNonce &&
            decide?.accepted === true &&
            decide?.state === "CONSUMED" &&
            effectAfterDecide.state === "READY" &&
            taskAfterDecide.state === "WAITING_EFFECT",
          `console bind=${CONSOLE_BIND}:${CONSOLE_DEFAULT_PORT} health=${healthOk}; bootstrap sees decisionMaterials=${bootstrapView?.decisionMaterials != null} and its decide=${bootstrapDecide}; session+CSRF consume=${decide?.accepted} (${decide?.state ?? "-"}); effect=${effectAfterDecide.state} task=${taskAfterDecide.state}`,
        );

        // B-7: SMTP over TLS dispatches EXACTLY ONE message and records the
        // external receipt.
        const mailUpstream = createMailUpstream(db, { mail: mailReal, now: () => Date.now() });
        let smtpSubmits = 0;
        const countingUpstream = {
          ...mailUpstream,
          submit: (...args) => {
            smtpSubmits += 1;
            return mailUpstream.submit(...args);
          },
        };
        const adapterUpstream = createAdapterUpstream(db, {
          baseUpstream: null,
          mailUpstream: countingUpstream,
          transportKind: "real",
          policy: { allowRealExternalWrites: true },
          credentials: { mail: "slot-wired" },
          config: adaptersReal,
        });
        let sent = null;
        let dispatchError = null;
        try {
          sent = dispatchEffect(db, adapterUpstream, { effectId: proposed.effectId, now: Date.now() });
        } catch (e) {
          dispatchError = String(e?.message ?? e);
        }
        const sentRow = db.prepare("SELECT state, external_id FROM effects WHERE id=?").get(proposed.effectId);
        const mailSendRows = db.prepare("SELECT count(*) c FROM effects WHERE operation='mail.send'").get().c;
        const mailSendSucceeded = db.prepare("SELECT count(*) c FROM effects WHERE operation='mail.send' AND state='SUCCEEDED'").get().c;
        suite.check(
          "mail-smtp-dispatch-exactly-one-succeeded-external-id-recorded",
          sent?.state === "SUCCEEDED" &&
            typeof sent.externalId === "string" &&
            sent.externalId.length > 0 &&
            sentRow?.state === "SUCCEEDED" &&
            sentRow?.external_id === sent.externalId &&
            smtpSubmits === 1 &&
            mailSendRows === 1 &&
            mailSendSucceeded === 1,
          dispatchError !== null
            ? scrub(`dispatch refused: ${dispatchError.slice(0, 140)}`)
            : `smtp submits=${smtpSubmits}; mail.send rows=${mailSendRows} (SUCCEEDED=${mailSendSucceeded}); external_id=${scrub(String(sent.externalId ?? "").slice(0, 44))} recorded identically on the effect row`,
        );
        telemetry.mail = {
          status: sent?.state === "SUCCEEDED" ? "VERIFIED" : "FAILED",
          inboxFetched: pulled.fetched?.length ?? null,
          testEmail: { uid: testEmail.uid ?? null, subject: scrub(String(testEmail.subject ?? "").slice(0, 60)), from: scrub(String(testEmail.from?.address ?? "")) },
          draft: { chars: draft.length, sha256_12: createHash("sha256").update(draft).digest("hex").slice(0, 12) },
          model: {
            model: "deepseek/deepseek-flash",
            reasoning: "high",
            usage: {
              inputTokens: call.usage?.inputTokens ?? null,
              outputTokens: call.usage?.outputTokens ?? null,
              cacheReadTokens: call.usage?.cacheReadTokens ?? null,
              cacheWriteTokens: call.usage?.cacheWriteTokens ?? null,
            },
            settledMicrousd: resRow?.actual_microusd ?? null,
            upperMicrousd: CALL_UPPER_MICROUSD,
          },
          approval: { via: "console-api 127.0.0.1:4310 (session+CSRF CAS)", decision: "approve", consumed: decide?.accepted === true },
          smtp: { sends: smtpSubmits, tls: true, externalIdMasked: scrub(String(sent?.externalId ?? "").slice(0, 44)) },
        };
        }
      }
    }
  }
  delete process.env[credEnvName];
  telemetry.timings.mailStageMs = Date.now() - stageStart;
}

// ===========================================================================
// PART C — real calendar (CalDAV): honest boundary registration.
// ===========================================================================
{
  const stageStart = Date.now();
  const configured = typeof caldavUrl === "string" && caldavUrl.length > 0 && typeof caldavUser === "string" && caldavUser.length > 0 && typeof caldavPassword === "string" && caldavPassword.length > 0;
  let calPullOk = false;
  if (configured) {
    // Future optional execution: ONE read-only pull, its honest outcome
    // recorded as a note. Never a silent pass, never a write.
    const { ws, db } = freshDb("scenarios-real-caldav");
    const credEnvName = "AEGISPI_REAL_CALDAV_CREDENTIAL";
    process.env[credEnvName] = `${caldavUser}:${caldavPassword}`;
    let outcome = null;
    try {
      createCredentialService(db).registerSlot({ slot: "calendar", envName: credEnvName, purpose: "caldav (real)", now: Date.now(), actorId: "owner" });
      const res = pullCalendarEvents(db, ws.stateDir, {
        now: Date.now(),
        calendar: {
          caldavUrl,
          allowRealCalendarRead: true,
          allowedCalendars: [readEnv("CALDAV_CALENDAR") ?? "personal"],
          defaultTimezone: "Asia/Hong_Kong",
        },
      });
      calPullOk = typeof res.stored === "number";
      outcome = calPullOk
        ? `read-only pull stored=${res.stored} event rows`
        : scrub(`read refused/failed: ${String(res.skipped ?? res.failed ?? JSON.stringify(res)).slice(0, 140)}`);
    } finally {
      delete process.env[credEnvName];
      try { db.close(); } catch {}
      rmSync(ws.stateDir, { recursive: true, force: true });
    }
    suite.note("calendar-optional-read-attempted", String(outcome));
    telemetry.calendar = { status: calPullOk ? "VERIFIED (read-only)" : "FAILED (read-only)", outcome: String(outcome) };
  } else {
    telemetry.calendar = {
      status: "DEFERRED / NOT VERIFIED",
      reason: "CALDAV_* 未配置；主人裁定（D-102）：真实日历实盘延后，不阻塞 Phase 5；场景二闭环已由 Permit 1 环回 TLS 夹具（eval:scenarios）验收在案",
    };
  }
  suite.check(
    "calendar-registration-honest-never-faked",
    configured ? calPullOk : telemetry.calendar.status === "DEFERRED / NOT VERIFIED",
    configured
      ? `CALDAV_* present: read-only pull ${calPullOk ? "succeeded" : "failed"} (${telemetry.calendar.outcome})`
      : "CALDAV_* absent on this host: registered as DEFERRED / NOT VERIFIED — never dressed as a pass",
  );
  telemetry.timings.calendarStageMs = Date.now() - stageStart;
}

// ===========================================================================
// Teardown + evidence + post-write plaintext tripwire.
// ===========================================================================
const rawDefaults = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "config", "defaults.json"), "utf8"));
const defaultsClosed = areDefaultsFailClosed(rawDefaults);
suite.check(
  "defaults-json-still-fully-fail-closed",
  defaultsClosed,
  "repo defaults.json untouched by this real run (model / telegram-pull / mail / calendar gates all closed)",
);

// Evidence FIRST, teardown LAST: a cleanup failure must never cost the run
// its evidence (run 4 of batch 3 crashed exactly here — rmSync before the
// DB handles were closed, EBUSY on Windows, after all 23 checks had passed).
const reportPaths = writeReport({
  suiteId: "scenarios-real",
  suite,
  label: "phase5:scenarios-real — 单元 5.6 许可 2 实盘验收（Telegram Pull 隔离 + 真实邮箱草稿审批发送 + CalDAV 登记边界）",
  extra: {
    dataSources:
      "真实 api.telegram.org getUpdates（经本机 CONNECT 代理出网，≤3 轮）+ 真实 IMAP over TLS 只读拉取 + 真实 deepseek/deepseek-flash（reasoning high，先预留后四字段结清）+ 127.0.0.1:4310 本地控制台 session+CSRF 审批 + 真实 SMTP over TLS 恰 1 封测试回信；.env 只读不入库，全程脱敏；真实 CalDAV 按 D-102 登记 DEFERRED / NOT VERIFIED",
    permit: telemetry.permit,
    telegram: telemetry.telegram,
    mail: telemetry.mail,
    calendar: telemetry.calendar,
    budgetByPurpose: telemetry.budgetByPurpose,
    timings: telemetry.timings,
  },
});

// Post-write tripwire: re-read both evidence files and fail the run if any
// raw secret survived anywhere in them.
const leaked = [];
for (const p of [reportPaths.reportPath, reportPaths.logPath]) {
  const text = readFileSync(p, "utf8");
  for (const secret of RAW_SECRETS) {
    if (secret && text.includes(secret)) leaked.push(`${p.split(/[\\/]/).pop()}:${secret.slice(0, 3)}…`);
  }
}
if (leaked.length > 0) {
  console.error(`PLAINTEXT TRIPWIRE TRIPPED: ${leaked.join(", ")}`);
  try { tgWsHolder.db?.close(); } catch {}
  try { mailWsHolder.db?.close(); } catch {}
  process.exit(1);
}

// Teardown: DB handles close BEFORE any rmSync (an open SQLite handle locks
// the file on Windows), and a failed cleanup degrades to a note — never a
// crash after green evidence.
try { tgWsHolder.db?.close(); } catch {}
try { mailWsHolder.db?.close(); } catch {}
const { fail } = suite.counts;
if (fail === 0) {
  let teardownError = null;
  for (const holder of [tgWsHolder, mailWsHolder]) {
    if (!holder.ws?.stateDir) continue;
    try {
      rmSync(holder.ws.stateDir, { recursive: true, force: true });
    } catch (e) {
      teardownError = String(e?.code ?? e?.message ?? e);
      break;
    }
  }
  if (teardownError === null) {
    suite.note("real-workspace-torn-down", "gitignored workspace-state real-run directories removed after evidence capture and the plaintext tripwire");
  } else {
    suite.note("real-workspace-teardown-failed", scrub(`rmSync refused (${teardownError}); the directories are gitignored and safe to delete manually; evidence and tripwire already captured`));
  }
} else {
  suite.note("real-workspace-kept-for-diagnosis", "suite not green: workspace-state/phase5/scenarios-real-* kept for inspection");
}
process.exit(suiteExit(suite, { label: "phase5:scenarios-real" }));
