// test:ingress-telegram — Phase 3 LOCAL ingress checks (02 CP1, 04 Phase 3
// credential lifecycle; deterministic, in-process, zero network).
//
// Audit F7 split this suite in two: the REAL read-only acceptance against
// api.telegram.org now lives in evals/phase3/ingress-telegram/real.mjs
// (script test:ingress-telegram:real), which REFUSES to look green when the
// token is absent (exit 3, explicitly NOT VERIFIED). This local suite can
// therefore never again exit 0 in a way that reads as "real ingress
// verified" on a machine without credentials.
//
// Checks here:
//   1. fail-closed without a token (refuses BEFORE any network call)
//   2. fail-closed after credential-slot revocation; secrets never reach
//      the audit log
//   3. recorded fixtures map into the durable ingress with update_id dedup
//   4. the pull adapter READS the queue without consuming it: the outgoing
//      getUpdates query carries NO offset and repeated reads return the
//      same backlog (the platform queue is never advanced implicitly)
//   5. the Telegram webhook guard (X-Telegram-Bot-Api-Secret-Token header,
//      constant-time) accepts only the exact secret — implemented but not
//      wired to a public endpoint (open item on record, no fake webhook
//      "verification" here)

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
} from "../lib/harness.mjs";
import { loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent } from "../../../apps/daemon/src/ingress.mjs";
import {
  createTelegramPullAdapter,
  createTelegramWebhookGuard,
  TelegramTokenMissing,
  TelegramWebhookSecretMissing,
} from "../../../apps/daemon/src/ingress-telegram.mjs";
import { createCredentialService } from "../../../apps/daemon/src/credentials.mjs";

lockedNodeGuard();

const suite = makeSuite("ingress-telegram");

// ---------------------------------------------------------------------------
// 1. Fail-closed: no token, no network call, no guessing.
{
  let refused = null;
  try {
    createTelegramPullAdapter({ token: null, fetchImpl: fetch });
  } catch (e) {
    refused = e;
  }
  suite.check(
    "pull-adapter-refuses-without-token",
    refused instanceof TelegramTokenMissing,
    `-> ${refused?.message?.slice(0, 60)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Credential-slot lifecycle backs the adapter: revocation refuses.
{
  const ws = makeWorkspace("ingress-creds");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  process.env.AEGISPI_TEST_TG_TOKEN = "drill-token-value-not-printed";
  const creds = createCredentialService(db, { now: () => Date.now() });
  creds.registerSlot({ slot: "im.telegram", purpose: "im", source: "telegram", envName: "AEGISPI_TEST_TG_TOKEN", now: Date.now() });
  const live = creds.resolve("im.telegram");
  let revokedRefusal = null;
  creds.revokeSlot({ slot: "im.telegram", reason: "revocation drill", now: Date.now() });
  const afterRevoke = creds.resolve("im.telegram");
  try {
    createTelegramPullAdapter({ token: afterRevoke.ok ? afterRevoke.value : null, fetchImpl: fetch });
  } catch (e) {
    revokedRefusal = e;
  }
  const auditText = db.prepare("SELECT details_json FROM audit_log").all().map((r) => r.details_json).join("\n");
  suite.check(
    "revoked-credential-slot-refuses-pull-adapter",
    live.ok === true && afterRevoke.ok === false && revokedRefusal instanceof TelegramTokenMissing,
    `resolve before=${live.ok} after revoke=${afterRevoke.ok} (${afterRevoke.reason?.slice(0, 40)})`,
  );
  suite.check("drill-token-never-reaches-audit", !auditText.includes("drill-token-value-not-printed"), "audit rows carry slot names only");
  delete process.env.AEGISPI_TEST_TG_TOKEN;
  db.close();
}

// ---------------------------------------------------------------------------
// 3. Recorded fixture -> durable ingress with provider-event-id dedup.
{
  const ws = makeWorkspace("ingress-mapping");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const adapter = createTelegramPullAdapter({ token: "fixture-token", fetchImpl: fetch });
  const fixture = {
    update_id: 88001,
    message: {
      message_id: 1,
      from: { id: 6101, is_bot: false, first_name: "Owner" },
      chat: { id: 6101, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: "authorized test fixture",
    },
  };
  const mapped = adapter.mapUpdate(fixture);
  const first = receiveEvent(db, ws.stateDir, { ...mapped.event, now: Date.now(), verdict: "ADMIT", policyVersion: "pv1", priority: 5 });
  const second = receiveEvent(db, ws.stateDir, { ...mapped.event, now: Date.now() + 10, verdict: "ADMIT", policyVersion: "pv1", priority: 5 });
  const rows = db.prepare("SELECT count(*) c FROM inbox WHERE source='telegram' AND source_event_id='88001'").get().c;
  suite.check(
    "telegram-update-maps-and-dedups-by-update-id",
    mapped.mappable === true && first.duplicate === false && second.duplicate === true && rows === 1,
    `mappable=${mapped.mappable} first=${first.duplicate} second=${second.duplicate} rows=${rows}`,
  );
  const unmappable = adapter.mapUpdate({ update_id: 88002 });
  suite.check("non-message-update-refused-honestly", unmappable.mappable === false, `-> ${unmappable.reason}`);
  db.close();
}

// ---------------------------------------------------------------------------
// 4. Read-without-consuming: the outgoing getUpdates query never carries an
// offset, and repeated reads return the same backlog. The captured URL is
// asserted directly — no hardcoded "nothing consumed" string (audit F7).
{
  const captured = [];
  const fakeFetch = async (url) => {
    captured.push(String(url));
    return {
      status: 200,
      json: async () => ({
        ok: true,
        result: [
          {
            update_id: 88001,
            message: {
              message_id: 1,
              from: { id: 6101, is_bot: false, first_name: "Owner" },
              chat: { id: 6101, type: "private" },
              date: Math.floor(Date.now() / 1000),
              text: "queued fixture",
            },
          },
        ],
      }),
    };
  };
  const adapter = createTelegramPullAdapter({ token: "fixture-token", fetchImpl: fakeFetch });
  const firstRead = await adapter.getUpdates({ limit: 1, timeout: 0 });
  const secondRead = await adapter.getUpdates({ limit: 1, timeout: 0 });
  const noOffset = captured.every((u) => !/[?&]offset=/.test(u));
  suite.check(
    "getUpdates-reads-queue-without-advancing-offset",
    Array.isArray(firstRead) &&
      Array.isArray(secondRead) &&
      noOffset &&
      firstRead[0]?.update_id === secondRead[0]?.update_id &&
      captured.length === 2,
    `requests=${captured.length} offset-param-present=${!noOffset} same-backlog=${firstRead[0]?.update_id === secondRead[0]?.update_id} — the queue stays unconsumed; only an explicit, audited advance elsewhere could change that`,
  );
}

// ---------------------------------------------------------------------------
// 5. The Telegram webhook guard: exact secret token header, constant-time.
{
  let noSecretRefusal = null;
  try {
    createTelegramWebhookGuard({ secret: null });
  } catch (e) {
    noSecretRefusal = e;
  }
  const guard = createTelegramWebhookGuard({ secret: "webhook-secret-not-printed-16ch" });
  const ok = guard.verifyRequest({ "x-telegram-bot-api-secret-token": "webhook-secret-not-printed-16ch" });
  const wrong = guard.verifyRequest({ "x-telegram-bot-api-secret-token": "webhook-secret-typo-16chars" });
  const missing = guard.verifyRequest({});
  suite.check(
    "webhook-guard-verifies-secret-token-header",
    noSecretRefusal instanceof TelegramWebhookSecretMissing && ok.ok === true && wrong.ok === false && missing.ok === false,
    `no-secret->refused ${noSecretRefusal !== null}; exact=${ok.ok} wrong=${wrong.ok} missing=${missing.ok} (implemented, NOT wired to any public endpoint)`,
  );
}

suite.note(
  "real-read-acceptance-not-run-here",
  "本套件只含本地确定性检查；真实只读验收在 test:ingress-telegram:real（缺 token 时 exit 3、明确记未验收），不在本套件内冒充完成",
);

writeReport({
  suiteId: "ingress-telegram",
  suite,
  label: "test:ingress-telegram — 本地确定性 ingress 检查（真实只读验收已拆分至 test:ingress-telegram:real）",
  extra: {
    dataSources: "本地 SQLite 与注入 fetch 的确定性用例；零网络调用、零模型调用、零发送",
  },
});
process.exit(suiteExit(suite, { label: "test:ingress-telegram" }));
