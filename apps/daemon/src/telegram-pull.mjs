// Telegram Route 1 pull runtime (Unit 5.2; owner decision 2026-11-22,
// spec 01 section 2, 03 section 5, 06 section 3.1).
//
// The daemon PULLS: getUpdates over the host's HTTP CONNECT proxy tunnel,
// only ever outbound, zero public listening ports, zero webhook. The
// offset cursor lives in system_state('telegram_pull_offset') and is
// advanced ONLY after the whole batch's inbox transactions have committed
// — a crash between commit and cursor lands in the crash window the
// schema's UNIQUE(source, source_event_id) already makes idempotent: the
// restart re-pulls the same update_ids and receiveEvent absorbs every
// duplicate with zero new tasks.
//
// Fail-closed gates before any network byte: a non-loopback apiBase
// requires telegram.allowRealPull === true AND a non-empty
// telegram.allowedChatIds AND a live (non-revoked) 'im' credential slot.
// A loopback apiBase is the local verification seam (same convention as
// model.baseUrl). Updates from chats NOT on the whitelist are counted
// masked and dropped: no payload object, no inbox row, no task — their
// text is never persisted anywhere.
//
// /stop, /status, /pause, /resume arriving through this channel take the
// deterministic control bypass (control.mjs) — verified, executed, and
// audited in the same pass, never queued behind model inference.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { withTx } from "./db/tx.mjs";
import { receiveEvent, scopeId, principalId } from "./ingress.mjs";
import { mapTelegramUpdate } from "./ingress-telegram.mjs";
import { isLoopbackEndpoint } from "./upstream-http.mjs";
import { buildSafeChildEnv } from "./model-call.mjs";
import { classifyControlCommand, handleDeterministicControl } from "./control.mjs";
import { writeAudit } from "./audit.mjs";
import { crashpoint } from "./testing/crashpoints.mjs";

export const TELEGRAM_PULL_OFFSET_STATE_KEY = "telegram_pull_offset";
const PULL_CHILD = join(dirname(fileURLToPath(import.meta.url)), "ingress-telegram-child.mjs");

export class TelegramPullError extends Error {}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * One-shot pull runner: spawns the isolated child with a clean env and
 * stdin JSON, classifies its single stdout JSON line. A failed pull is a
 * READ failure — safe to treat as local (no state change, no bytes of
 * consequence sent), and the next interval retries.
 */
export function createTelegramPullRunner({ nodePath = process.execPath, childPath = PULL_CHILD } = {}) {
  return function runPull({ apiBase, botToken, proxy, offset, limit, timeoutSeconds, timeoutMs }) {
    const r = spawnSync(nodePath, [childPath], {
      input: JSON.stringify({ apiBase, botToken, proxy, offset, limit, timeoutSeconds, timeoutMs }),
      env: buildSafeChildEnv(),
      encoding: "utf8",
      timeout: timeoutMs + (timeoutSeconds + 10) * 1000,
      maxBuffer: 1024 * 1024,
    });
    if (r.error) {
      return { ok: false, kind: "local", error: `telegram pull child failed to run: ${r.error.message}` };
    }
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      return { ok: false, kind: "local", error: `telegram pull child produced unparseable output (status ${r.status})` };
    }
    if (out.ok !== true) {
      return { ok: false, kind: out.kind === "timeout" ? "timeout" : "local", error: String(out.error ?? "pull failed") };
    }
    const body = out.body;
    if (!body || body.ok !== true || !Array.isArray(body.result)) {
      return { ok: false, kind: "local", error: `telegram getUpdates returned a non-ok body (HTTP ${out.status})` };
    }
    return { ok: true, updates: body.result };
  };
}

export function readPullOffset(db) {
  const row = db.prepare("SELECT value FROM system_state WHERE key=?").get(TELEGRAM_PULL_OFFSET_STATE_KEY);
  if (!row) return 0;
  const parsed = Number.parseInt(String(row.value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function writePullOffsetInTx(db, { offset, now }) {
  withTx(db, () => {
    db.prepare("INSERT INTO system_state(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(TELEGRAM_PULL_OFFSET_STATE_KEY, String(offset));
    writeAudit(db, {
      code: "telegram_pull_offset_advanced",
      details: { offset },
      now,
    });
  });
}

function parseProxyConfig(rawUrl) {
  if (rawUrl === null || rawUrl === undefined) return null;
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    throw new TelegramPullError(`telegram.proxyUrl is not a valid URL for the pull path`);
  }
  if (u.protocol !== "http:") {
    throw new TelegramPullError("telegram.proxyUrl must be an http:// CONNECT proxy origin for the pull path");
  }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
    throw new TelegramPullError("telegram.proxyUrl must be a credential-free pathless origin");
  }
  return { host: u.hostname, port: Number(u.port || 80) };
}

/**
 * One pull pass. Returns an honest result object; throws nothing for
 * gated skips or failed reads (both are recorded and safe).
 */
export function pullTelegramUpdates(db, stateDir, {
  telegram, credentials, now, runner = null, policyVersion = "pv1",
}) {
  const apiBase = telegram?.apiBase ?? null;
  if (apiBase === null) {
    return { skipped: "telegram.apiBase is null; zero pull calls (fail closed)" };
  }
  const loopback = isLoopbackEndpoint(apiBase);
  const allowedChatIds = Array.isArray(telegram.allowedChatIds) ? telegram.allowedChatIds.map(String) : [];
  let botToken = null;
  if (!loopback) {
    if (telegram.allowRealPull !== true) {
      return { skipped: "non-loopback telegram.apiBase requires telegram.allowRealPull=true; zero pull calls" };
    }
    if (allowedChatIds.length === 0) {
      return { skipped: "telegram.allowedChatIds is empty; every chat would be refused; zero pull calls" };
    }
    const resolved = credentials ? credentials.resolve("im") : { ok: false };
    if (!resolved.ok) {
      return { skipped: `the 'im' credential slot is not resolvable (${resolved.reason ?? "not registered"}); zero pull calls` };
    }
    botToken = resolved.value;
  } else {
    // Local verification seam: the token comes from the same 'im' slot
    // when registered (tests register a fake-token slot); without a slot
    // the loopback pull still refuses — the adapter never guesses.
    const resolved = credentials ? credentials.resolve("im") : { ok: false };
    if (!resolved.ok) {
      return { skipped: `the 'im' credential slot is not resolvable; even a loopback pull refuses (${resolved.reason ?? "not registered"})` };
    }
    botToken = resolved.value;
  }

  const proxy = parseProxyConfig(telegram.proxyUrl ?? null);
  const offsetBefore = readPullOffset(db);
  const limit = Number.isInteger(telegram.pullBatchLimit) ? telegram.pullBatchLimit : 20;
  const timeoutSeconds = Number.isInteger(telegram.pullTimeoutSeconds) ? telegram.pullTimeoutSeconds : 0;
  const timeoutMs = Number.isInteger(telegram.timeoutMs) ? telegram.timeoutMs : 15000;

  const run = runner ?? createTelegramPullRunner();
  const pull = run({ apiBase, botToken, proxy, offset: offsetBefore, limit, timeoutSeconds, timeoutMs });
  if (!pull.ok) {
    withTx(db, () => {
      writeAudit(db, {
        code: "telegram_pull_failed",
        details: { kind: pull.kind, error: String(pull.error).slice(0, 200), offset: offsetBefore },
        now,
      });
    });
    return { failed: `telegram pull failed (${pull.kind}): ${String(pull.error).slice(0, 160)}`, offsetBefore, offsetAfter: offsetBefore };
  }

  const updates = pull.updates;
  let admitted = 0;
  let duplicates = 0;
  let skippedUnauthorized = 0;
  let unmappable = 0;
  let controlCommands = 0;
  let maxUpdateId = -1;

  for (const update of updates) {
    const updateId = Number(update?.update_id);
    if (!Number.isInteger(updateId)) continue;
    if (updateId > maxUpdateId) maxUpdateId = updateId;
    const chat = update.message?.chat ?? update.edited_message?.chat ?? update.channel_post?.chat ?? null;
    const chatType = chat?.type ?? null;
    const chatAllowed = chat !== null && allowedChatIds.includes(String(chat.id));
    const mapped = chatAllowed ? mapTelegramUpdate(update) : { mappable: false };
    if (!mapped.mappable) {
      // Masked safety counter only: no payload object, no inbox row, no
      // task. The message text is never persisted for a refused chat.
      unmappable += chatAllowed ? 1 : 0;
      skippedUnauthorized += chatAllowed ? 0 : 1;
      withTx(db, () => {
        writeAudit(db, {
          code: "telegram_pull_skipped_unauthorized",
          details: { update_id: updateId, chat_type: chatType, reason: chatAllowed ? "unmappable update" : "chat not in telegram.allowedChatIds" },
          now,
        });
      });
      continue;
    }
    const received = receiveEvent(db, stateDir, {
      now,
      source: mapped.event.source,
      sourceEventId: mapped.event.sourceEventId,
      principal: mapped.event.principal,
      scope: mapped.event.scope,
      threadKey: mapped.event.threadKey,
      priority: 5,
      policyVersion,
      payload: mapped.event.payload,
      verdict: "ADMIT",
    });
    if (received.duplicate) {
      duplicates += 1;
    } else {
      admitted += 1;
    }
    // Deterministic control bypass: verified, executed, audited — and
    // never dispatched to a model task.
    let text = null;
    try {
      text = JSON.parse(mapped.event.payload).text ?? null;
    } catch {}
    const command = classifyControlCommand(text);
    if (command !== null) {
      controlCommands += 1;
      const cmdScopeId = scopeId(mapped.event.scope.domainKey);
      const cmdPrincipalId = principalId(mapped.event.principal.platform, mapped.event.principal.subject);
      try {
        handleDeterministicControl(db, {
          command,
          scopeId: cmdScopeId,
          threadKey: mapped.event.threadKey,
          principalId: cmdPrincipalId,
          inboxId: received.inboxId,
          now,
        });
      } catch (e) {
        // Refused control commands stay durable as ordinary inbox rows:
        // the event itself was legitimate, only the bypass said no.
        controlCommands -= 1;
        withTx(db, () => {
          writeAudit(db, {
            code: "telegram_pull_control_refused",
            details: { update_id: updateId, command, reason: String(e.message).slice(0, 160) },
            now,
          });
        });
      }
    }
  }

  // The crash window the cursor protocol exists for: everything above is
  // committed; the cursor is not yet. A kill here replays the batch
  // harmlessly (receiveEvent dedup) on the next start.
  crashpoint("telegram-pull:after-receive-before-offset");

  if (maxUpdateId >= 0) {
    const offsetAfter = maxUpdateId + 1;
    writePullOffsetInTx(db, { offset: offsetAfter, now });
    return {
      pulled: updates.length,
      admitted,
      duplicates,
      skippedUnauthorized,
      unmappable,
      controlCommands,
      offsetBefore,
      offsetAfter,
    };
  }
  return {
    pulled: 0,
    admitted,
    duplicates,
    skippedUnauthorized,
    unmappable,
    controlCommands,
    offsetBefore,
    offsetAfter: offsetBefore,
  };
}

export { here as pullModuleDir };
