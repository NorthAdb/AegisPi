// Phase 3 console (02 section 7, 04 sections 2/4): a LOCAL, authenticated
// console with short-lived sessions, CSRF-protected JSON-only mutations, and
// the approval / cancel / authorize / budget surfaces. The Phase 2 read-only
// diagnostics stay exactly as they were, including bootstrap-token
// authentication for GETs — but the bootstrap token alone can NEVER approve:
// mutations need a session minted from it plus the session's CSRF token.
//
// Auth matrix:
//   GET /api/*            Bearer <bootstrap token from workspace-state> OR
//                         Bearer <session id>
//   POST /api/session     body {token: <bootstrap token>} -> mints a
//                         short-lived session {sessionId, csrfToken, expiresAt}
//   POST /api/* (all mutations) Bearer <session id> + x-csrf-token header +
//                         Content-Type: application/json. Bootstrap-token-only
//                         callers get 401 "mutations require a console
//                         session" — an unauthenticated local process that
//                         can merely reach 127.0.0.1 approves nothing.
// Host/Origin allowlist and read-only maintenance mode keep their Phase 2
// semantics; later-phase endpoints still answer 501 with no fake data.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { decideApproval, hasApproveGrant, readConsoleNonce } from "../approvals.mjs";
import { extraFieldsOfAction, reviseEffect, cancelTask, reconcileUnknown } from "../effects.mjs";
import { grantPermission, revokePermission, hasReadGrant } from "../acl.mjs";
import { classifyControlCommand, ControlCommandRefused, handleDeterministicControl } from "../control.mjs";
import { createTelegramWebhookGuard, mapTelegramUpdate } from "../ingress-telegram.mjs";
import { ensurePrincipal, ensureScope, receiveEvent, scopeId as scopeIdForDomainKey } from "../ingress.mjs";
import { activateMemoryFact, forgetObject } from "../memory.mjs";
import { readObjectContent } from "../objects.mjs";
import { formatGeneralUserPrompt } from "../selfuse-dispatch.mjs";
import { withTx } from "../db/tx.mjs";
import { writeAudit } from "../audit.mjs";
import { ConfigError, loadDaemonConfig } from "../config.mjs";
import { createCredentialService } from "../credentials.mjs";
import {
  ALLOWED_SECRET_KEYS,
  readDotEnvFile,
  syncSelfUseDatabase,
  synthesizeEnvVars,
  upsertDotEnvKeys,
} from "../selfuse-bootstrap.mjs";
import { parseTelegramTargetResource } from "../telegram-send.mjs";
import { timerIdFor } from "../timers.mjs";
import { testConnectivity } from "../connectivity-test.mjs";
import { consoleIndexHtml } from "./ui.mjs";

export const CONSOLE_BIND = "127.0.0.1";
export const CONSOLE_DEFAULT_PORT = 4310;
export const SESSION_TTL_MS = 10 * 60 * 1000;

export function ensureConsoleToken(dataDir) {
  const dir = join(dataDir, "console");
  mkdirSync(dir, { recursive: true });
  const tokenPath = join(dir, "token");
  if (existsSync(tokenPath)) {
    return { tokenPath, token: readFileSync(tokenPath, "utf8").trim() };
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token + "\n", { encoding: "utf8", flag: "wx" });
  return { tokenPath, token };
}

function hashShort(hex) {
  return typeof hex === "string" ? hex.slice(0, 12) : null;
}

export function createConsoleApp(db, {
  recovery,
  mode,
  token,
  port = CONSOLE_DEFAULT_PORT,
  stateDir = null,
  ownerPrincipalId = "prn:local:owner",
  sessionTtlMs = SESSION_TTL_MS,
  // Owner-configured Telegram webhook secret (re-review P1). Null = the
  // webhook route answers 503 fail-closed; a configured but malformed
  // secret (<16 chars) refuses to start the console at all rather than
  // accepting a weak guard.
  telegramWebhookSecret = null,
  configPath = null,
  envFilePath = null,
  imageStatus = null,
  onConfigReload = null,
} = {}) {
  const app = new Hono();
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]);

  // Short-lived sessions minted from the local bootstrap token. In-memory by
  // design: a daemon restart kills every session and the owner logs in again.
  // The session carries the console owner's PRINCIPAL: decisions are made AS
  // that principal, and decideApproval re-verifies it is the card's
  // designated approver — the console never substitutes its own identity.
  const sessions = new Map();
  const mintSession = ({ now, principalId }) => {
    const sessionId = randomBytes(24).toString("hex");
    const csrfToken = randomBytes(24).toString("hex");
    const session = {
      sessionId,
      csrfToken,
      principalId,
      expiresAt: now + sessionTtlMs,
    };
    sessions.set(sessionId, session);
    return session;
  };
  const findSession = (bearer, { now }) => {
    const session = sessions.get(bearer);
    if (!session) return null;
    if (session.expiresAt <= now) {
      sessions.delete(bearer);
      return null;
    }
    return session;
  };

  app.use("*", async (c, next) => {
    // Host/Origin validation: the console is same-origin local only.
    const host = c.req.header("host") ?? "";
    const origin = c.req.header("origin");
    if (!allowedHosts.has(host)) {
      return c.json({ code: "forbidden_host", message: `console host ${host} is not the local same-origin bind` }, 403);
    }
    if (origin !== undefined && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) {
      return c.json({ code: "forbidden_origin", message: "cross-origin console requests are refused" }, 403);
    }
    return next();
  });

  app.use("/api/*", async (c, next) => {
    // Read-only maintenance: only diagnostics stay reachable (04 section 4:
    // 503 recovery/only-read maintenance). Session minting is a state change
    // and stays closed in read-only mode.
    if (mode !== "open" && !c.req.path.startsWith("/api/recovery") && c.req.path !== "/api/health") {
      return c.json(
        { code: "read_only_maintenance", message: `recovery failed at ${recovery.failedStep}; only diagnostics are open` },
        503,
      );
    }
    return next();
  });

  // GETs: bootstrap token or session. Mutations: session only (the specific
  // mutation routes re-check the session and CSRF below).
  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    if (bearer === null) {
      return c.json({ code: "unauthenticated", message: "console endpoints require authentication" }, 401);
    }
    if (bearer === token) {
      c.set("authKind", "bootstrap");
      c.set("principalId", ownerPrincipalId);
      return next();
    }
    const session = findSession(bearer, { now: Date.now() });
    if (session) {
      c.set("authKind", "session");
      c.set("session", session);
      c.set("principalId", session.principalId);
      return next();
    }
    return c.json({ code: "unauthenticated", message: "console endpoints require the local bootstrap token or a live session" }, 401);
  });

  // Every mutation: live session + CSRF + JSON body. The bootstrap token
  // alone never authorizes a state change.
  const mutationGuard = async (c, next) => {
    if (c.get("authKind") !== "session") {
      return c.json(
        { code: "unauthenticated", message: "mutations require a console session; the bootstrap token only reads" },
        401,
      );
    }
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.startsWith("application/json")) {
      return c.json(
        { code: "unsupported_media_type", message: "state-changing requests must be application/json" },
        415,
      );
    }
    const csrf = c.req.header("x-csrf-token") ?? "";
    if (csrf !== c.get("session").csrfToken) {
      return c.json({ code: "csrf_mismatch", message: "state-changing requests carry the session CSRF token" }, 403);
    }
    return next();
  };

  const requireOwnerSession = async (c, next) => {
    if (c.get("authKind") !== "session") {
      return c.json(
        { code: "unauthenticated", error: "unauthenticated", message: "settings access requires a console session" },
        401,
      );
    }
    if (c.get("session").principalId !== ownerPrincipalId) {
      return c.json({ code: "forbidden", error: "owner_required", message: "owner principal required" }, 403);
    }
    return next();
  };

  app.get("/api/health", (c) => c.json({ ok: true, mode, node: process.version }));

  app.get("/api/recovery", (c) => {
    return c.json({
      mode,
      failedStep: recovery.failedStep ?? null,
      actions: recovery.actions,
    });
  });

  app.get("/api/snapshot", (c) => {
    const tasksByState = db
      .prepare("SELECT state, count(*) c FROM tasks GROUP BY state ORDER BY state")
      .all();
    const effectsByState = db
      .prepare("SELECT state, count(*) c FROM effects GROUP BY state ORDER BY state")
      .all();
    const inboxByState = db
      .prepare("SELECT state, count(*) c FROM inbox GROUP BY state ORDER BY state")
      .all();
    const timersByState = db
      .prepare("SELECT state, count(*) c FROM timers GROUP BY state ORDER BY state")
      .all();
    const approvalsByState = db
      .prepare("SELECT state, count(*) c FROM approvals GROUP BY state ORDER BY state")
      .all();
    const budgets = db
      .prepare("SELECT id, period_key, limit_microusd, spent_microusd, held_microusd, frozen FROM budget_accounts ORDER BY id")
      .all();
    const watermark = db
      .prepare("SELECT seq FROM stream_events ORDER BY seq DESC LIMIT 1")
      .get();
    const generation = db
      .prepare("SELECT value FROM system_state WHERE key='stream_generation'")
      .get();
    return c.json({
      generation: generation ? Number(generation.value) : 1,
      watermark: watermark ? watermark.seq : 0,
      overview: {
        tasksByState,
        effectsByState,
        inboxByState,
        timersByState,
        approvalsByState,
      },
      budgetAccounts: budgets,
    });
  });

  app.get("/api/tasks", (c) => {
    const tasks = db
      .prepare(
        `SELECT id, scope_id, state, priority, result_class, result_object_id, attempt_no, fence, available_at, deadline_at,
           step_count, max_steps, created_at, updated_at
         FROM tasks ORDER BY created_at DESC LIMIT 100`,
      )
      .all();
    return c.json({ tasks });
  });

  app.get("/api/tasks/:id", (c) => {
    const task = db
      .prepare(
        `SELECT id, scope_id, principal_id, origin_event_id, dispatch_key, state, priority,
           result_class, result_object_id, attempt_no, fence, available_at, deadline_at,
           step_count, max_steps, created_at, updated_at
         FROM tasks WHERE id=?`,
      )
      .get(c.req.param("id"));
    if (!task) {
      return c.json({ code: "not_found", message: "no such task" }, 404);
    }
    const attempts = db
      .prepare(
        "SELECT id, attempt_no, fence, state, started_at, ended_at, checkpoint_object_id, error_code FROM attempts WHERE task_id=? ORDER BY attempt_no",
      )
      .all(task.id);
    const effects = db
      .prepare(
        "SELECT id, state, retry_mode, business_key, external_id, last_error, updated_at FROM effects WHERE task_id=?",
      )
      .all(task.id);
    const deliveries = db
      .prepare("SELECT event_id, state, command_id, checkpoint_object_id, updated_at FROM event_deliveries WHERE task_id=?")
      .all(task.id);
    return c.json({ task, attempts, effects, deliveries });
  });

  app.get("/api/tasks/:id/checkpoints", (c) => {
    const attempts = db
      .prepare(
        "SELECT attempt_no, checkpoint_object_id FROM attempts WHERE task_id=? AND checkpoint_object_id IS NOT NULL ORDER BY attempt_no",
      )
      .all(c.req.param("id"));
    const checkpoints = attempts.map((a) => {
      const object = db
        .prepare("SELECT id, kind, content_hash, storage_ref, observed_at FROM objects WHERE id=?")
        .get(a.checkpoint_object_id);
      return { attemptNo: a.attempt_no, object };
    });
    return c.json({ checkpoints });
  });

  app.get("/api/notifications", (c) => {
    const rows = db
      .prepare(
        `SELECT o.id, o.effect_id, o.channel, o.destination, o.not_before, o.notify_reason,
                o.supersedes_outbox_id, e.state AS effect_state, e.external_id, e.expires_at
         FROM outbox o JOIN effects e ON e.id=o.effect_id
         ORDER BY o.not_before LIMIT 100`,
      )
      .all();
    return c.json({ notifications: rows, deliveryNote: "delivery status is effects.state; the outbox never keeps a second status" });
  });

  // ---------------------------------------------------------------------
  // Session minting (02 section 7: 随机会话凭据、短有效期).
  app.post("/api/session", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.startsWith("application/json")) {
      return c.json({ code: "unsupported_media_type", message: "session minting accepts application/json" }, 415);
    }
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "session body must be JSON" }, 422);
    }
    if (body?.token !== token) {
      return c.json({ code: "unauthenticated", message: "the local bootstrap token is required to mint a console session" }, 401);
    }
    const session = mintSession({ now: Date.now(), principalId: ownerPrincipalId });
    return c.json({
      sessionId: session.sessionId,
      csrfToken: session.csrfToken,
      principalId: session.principalId,
      expiresAt: session.expiresAt,
      ttlMs: sessionTtlMs,
    });
  });

  // ---------------------------------------------------------------------
  // Approval cards (04 section 2). The card shows what the action IS; a green
  // checkpoint badge would not make it safe, so there are no badges here.
  app.get("/api/approvals", (c) => {
    const rows = db
      .prepare(
        `SELECT a.id, a.effect_id, a.state, a.approver_id, a.expires_at, a.created_at, a.action_hash,
                e.task_id, e.scope_id, e.operation, e.action_json
         FROM approvals a JOIN effects e ON e.id = a.effect_id
         ORDER BY a.created_at DESC LIMIT 100`,
      )
      .all();
    const approvals = rows.map((r) => {
      const summary = summarizeApprovalAction(r.action_json);
      return {
        id: r.id,
        effect_id: r.effect_id,
        state: r.state,
        approver_id: r.approver_id,
        expires_at: r.expires_at,
        created_at: r.created_at,
        actionHashShort: hashShort(r.action_hash),
        task_id: r.task_id,
        scope_id: r.scope_id,
        operation: r.operation,
        ...summary,
      };
    });
    return c.json({ approvals });
  });

  app.get("/api/approvals/:id", (c) => {
    const approval = db.prepare("SELECT * FROM approvals WHERE id=?").get(c.req.param("id"));
    if (!approval) {
      return c.json({ code: "not_found", message: "no such approval" }, 404);
    }
    const effect = db.prepare("SELECT * FROM effects WHERE id=?").get(approval.effect_id);
    const task = db.prepare("SELECT id, scope_id, state, fence, attempt_no FROM tasks WHERE id=?").get(effect.task_id);
    let action = {};
    try {
      action = JSON.parse(effect.action_json);
    } catch {}
    // The nonce and the FULL action hash go only to the designated approver
    // ON A LIVE SESSION — the same authenticated channel the decision uses.
    // The bootstrap token (read-only) never sees them; they never appear in
    // a URL, an SSE payload, or a log line.
    const sessionPrincipal = c.get("authKind") === "session" ? c.get("session").principalId : null;
    const forDesignatedApprover = sessionPrincipal !== null && sessionPrincipal === approval.approver_id && approval.state === "WAITING";
    return c.json({
      approval: {
        id: approval.id,
        state: approval.state,
        approverId: approval.approver_id,
        expiresAt: approval.expires_at,
        createdAt: approval.created_at,
        actionHashShort: hashShort(approval.action_hash),
      },
      // Full hash + raw nonce: designated-approver LIVE SESSION view only —
      // the same authenticated channel the decision uses. The bootstrap
      // token (read-only) never sees them; they never enter a URL, an SSE
      // payload, or a log line.
      decisionMaterials: forDesignatedApprover
        ? { actionHash: approval.action_hash, nonce: readConsoleNonce(db, approval.id) }
        : null,
      action: {
        // Card fields per 04 section 2. Secrets never enter action_json, so
        // nothing here can leak one.
        operation: effect.operation,
        targetResource: action.target_resource ?? null,
        contentHash: action.content_hash ?? null,
        attachmentHash: action.attachment_hash ?? null,
        expectedHead: action.expected_head ?? null,
        sendingIdentity: action.sending_identity ?? null,
        extra: extraFieldsOfAction(action),
        evidenceManifestHash: action.evidence_manifest_hash ?? null,
        expiresAt: effect.expires_at,
      },
      task,
      decisionEndpoint: "POST /api/approvals/:id/decide",
      semantics: "the CAS consume is the authorization; UI greying is only a projection",
    });
  });

  // Decide: the 04 section 2 contract. The session principal is the approver;
  // decideApproval re-verifies the grant, hash, nonce, expiry, fence, epoch,
  // policy and ACL revision in ONE BEGIN IMMEDIATE CAS.
  app.post("/api/approvals/:id/decide", mutationGuard, async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "decide body must be JSON" }, 422);
    }
    if (body?.decision !== "approve" && body?.decision !== "reject") {
      return c.json({ code: "invalid_field", message: "decision must be approve/reject" }, 422);
    }
    if (typeof body?.actionHash !== "string" || typeof body?.nonce !== "string") {
      return c.json({ code: "invalid_field", message: "actionHash and nonce are required" }, 422);
    }
    const result = decideApproval(db, {
      approvalId: c.req.param("id"),
      decision: body.decision,
      actionHash: body.actionHash,
      nonce: body.nonce,
      approverId: c.get("session").principalId,
      now: Date.now(),
    });
    // An unactionable card is not an error: report exactly what happened.
    return c.json(result, result.accepted ? 200 : 409);
  });

  // Revise (04 section 2: "编辑创建新动作和新审批，旧卡失效"): mints a new
  // effect + approval for the edited intent; the old card dies.
  app.post("/api/approvals/:id/revise", mutationGuard, async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "revise body must be JSON" }, 422);
    }
    const approval = db.prepare("SELECT * FROM approvals WHERE id=?").get(c.req.param("id"));
    if (!approval) {
      return c.json({ code: "not_found", message: "no such approval" }, 404);
    }
    const sessionPrincipal = c.get("session").principalId;
    const oldEffect = db.prepare("SELECT * FROM effects WHERE id=?").get(approval.effect_id);
    if (!hasApproveGrant(db, { scopeId: oldEffect.scope_id, principalId: sessionPrincipal, now: Date.now() })) {
      return c.json(
        { code: "forbidden", message: "revising requires a live approve grant on the action's scope" },
        403,
      );
    }
    if (!body?.intent || typeof body.intent !== "object") {
      return c.json({ code: "invalid_field", message: "revise needs the edited intent object" }, 422);
    }
    if (typeof body?.expiresAt !== "number" || body.expiresAt <= Date.now()) {
      return c.json({ code: "invalid_field", message: "revise needs a future expiresAt" }, 422);
    }
    let revised;
    try {
      revised = reviseEffect(db, stateDir, {
        now: Date.now(),
        effectId: approval.effect_id,
        editedIntent: body.intent,
        approverPrincipalId: sessionPrincipal,
        actorId: sessionPrincipal,
        expiresAt: body.expiresAt,
      });
    } catch (e) {
      return c.json({ code: "conflict", message: e.message }, 409);
    }
    return c.json(revised, 200);
  });

  // Cancel (04 section 4): replies cancelledBeforeCommit or
  // committedEffectsPending with the affected scope tasks, honestly.
  app.post("/api/tasks/:id/cancel", mutationGuard, async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "cancel body must be JSON" }, 422);
    }
    const taskId = c.req.param("id");
    const task = db.prepare("SELECT id, scope_id FROM tasks WHERE id=?").get(taskId);
    if (!task) {
      return c.json({ code: "not_found", message: "no such task" }, 404);
    }
    let result;
    try {
      result = cancelTask(db, { taskId, now: Date.now(), actorId: "console" });
    } catch (e) {
      return c.json({ code: "conflict", message: e.message }, 409);
    }
    const committedPending = result.retainedCommitted.length > 0;
    return c.json(
      {
        outcome: committedPending ? "committedEffectsPending" : "cancelledBeforeCommit",
        epochAfter: result.epochAfter,
        cancelledTasks: result.cancelledTasks,
        parkedTasks: result.parkedTasks,
        retainedCommitted: result.retainedCommitted,
        cancelledEffects: result.cancelledEffects,
        note: committedPending
          ? "already-committed actions may have taken effect; they stay UNKNOWN and are being confirmed, not silently cancelled"
          : "nothing had been committed; un-committed proposals are cancelled",
        reason: body?.reason ?? null,
      },
      200,
    );
  });

  // Reconcile (04 section 4): admin only, actor + evidence mandatory, never
  // bulk, and evidence insufficiency cannot become success.
  app.post("/api/effects/:id/reconcile", mutationGuard, async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "reconcile body must be JSON" }, 422);
    }
    if (!["CONFIRMED_SUCCESS", "CONFIRMED_NOT_SENT", "REMAINS_UNKNOWN"].includes(body?.resolution)) {
      return c.json({ code: "invalid_field", message: "resolution must be CONFIRMED_SUCCESS/CONFIRMED_NOT_SENT/REMAINS_UNKNOWN" }, 422);
    }
    if (typeof body?.externalEvidenceRef !== "string" || body.externalEvidenceRef.length === 0) {
      return c.json({ code: "invalid_field", message: "externalEvidenceRef is required; an UNKNOWN never clears on assertion alone" }, 422);
    }
    const effect = db.prepare("SELECT scope_id FROM effects WHERE id=?").get(c.req.param("id"));
    if (!effect) {
      return c.json({ code: "not_found", message: "no such effect" }, 404);
    }
    const now = Date.now();
    const sessionPrincipal = c.get("session").principalId;
    if (!hasAdminGrant(db, { scopeId: effect.scope_id, principalId: sessionPrincipal, now })) {
      return c.json({ code: "forbidden", message: "reconciliation requires an admin grant on the effect's scope" }, 403);
    }
    try {
      const out = reconcileUnknown(db, {
        effectId: c.req.param("id"),
        resolution: body.resolution,
        externalEvidenceRef: body.externalEvidenceRef,
        externalId: body.externalId ?? null,
        actorId: sessionPrincipal,
        now,
      });
      return c.json(out, 200);
    } catch (e) {
      return c.json({ code: "conflict", message: e.message }, 409);
    }
  });

  // Budget console (04 section 3: Phase 3 adds the budget surface). Unit 5.5
  // adds the byPurpose attribution (router/worker/summary/classify ...):
  // spent = SETTLED actuals, held = live HELD uppers, chargedBound = the
  // conservative conversion of unknown-usage uppers. Token-level cache
  // attribution does not exist in this phase and is reported as null —
  // never a fabricated percentage.
  app.get("/api/budget", (c) => {
    // NOTE: budget_accounts has NO kind column in the canonical schema — the
    // Phase 3 query named one and would 500 against a live DB; the Unit 5.5
    // UI is its first real consumer, so the latent defect is fixed here.
    const accounts = db
      .prepare(
        "SELECT id, period_key, limit_microusd, spent_microusd, held_microusd, frozen FROM budget_accounts ORDER BY id",
      )
      .all();
    const reservations = db
      .prepare(
        "SELECT id, request_key, purpose, provider, state, upper_microusd, actual_microusd, created_at, settled_at FROM budget_reservations ORDER BY created_at DESC LIMIT 200",
      )
      .all();
    const byPurposeRows = db
      .prepare(
        `SELECT purpose,
           SUM(CASE WHEN state='SETTLED' THEN actual_microusd ELSE 0 END) AS spent_microusd,
           SUM(CASE WHEN state='HELD' THEN upper_microusd ELSE 0 END) AS held_microusd,
           SUM(CASE WHEN state='CHARGED_BOUND' THEN upper_microusd ELSE 0 END) AS charged_bound_microusd,
           COUNT(*) AS request_count
         FROM budget_reservations GROUP BY purpose`,
      )
      .all();
    const byPurpose = byPurposeRows.map((r) => ({
      purpose: r.purpose,
      spentMicrousd: r.spent_microusd ?? 0,
      heldMicrousd: r.held_microusd ?? 0,
      chargedBoundMicrousd: r.charged_bound_microusd ?? 0,
      requestCount: r.request_count ?? 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      measured: "amounts only; token-level cache attribution is not measured in this phase",
    }));
    return c.json({
      accounts,
      reservations,
      byPurpose,
      semantics: "usage unknown stays HELD and only a timeout converts to CHARGED_BOUND; a trusted bill may correct it later",
    });
  });

  // Authorization console (04 section 3: Phase 3 adds the authorize surface).
  app.get("/api/scopes", (c) => {
    const rows = db
      .prepare("SELECT id, kind, domain_key, channel, epoch, acl_version, policy_version, paused FROM scopes ORDER BY id")
      .all();
    return c.json({ scopes: rows });
  });

  app.get("/api/scopes/:id/grants", (c) => {
    const scopeId = c.req.param("id");
    const scope = db.prepare("SELECT id FROM scopes WHERE id=?").get(scopeId);
    if (!scope) {
      return c.json({ code: "not_found", message: "no such scope" }, 404);
    }
    const rows = db
      .prepare(
        "SELECT principal_id, permission, expires_at, revoked_at FROM acl_grants WHERE scope_id=? ORDER BY principal_id, permission",
      )
      .all(scopeId);
    return c.json({ grants: rows });
  });

  app.post("/api/grants/revoke", mutationGuard, async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "revoke body must be JSON" }, 422);
    }
    if (typeof body?.scopeId !== "string" || typeof body?.principalId !== "string" || typeof body?.permission !== "string") {
      return c.json({ code: "invalid_field", message: "scopeId, principalId and permission are required" }, 422);
    }
    const sessionPrincipal = c.get("session").principalId;
    const now = Date.now();
    if (!hasAdminGrant(db, { scopeId: body.scopeId, principalId: sessionPrincipal, now })) {
      return c.json({ code: "forbidden", message: "grant changes require an admin grant on the scope" }, 403);
    }
    try {
      const out = revokePermission(db, {
        scopeId: body.scopeId,
        principalId: body.principalId,
        permission: body.permission,
        now,
        actorId: sessionPrincipal,
        reason: body.reason ?? "console revocation",
      });
      return c.json(out, 200);
    } catch (e) {
      return c.json({ code: "conflict", message: e.message }, 409);
    }
  });

  app.post("/api/grants", mutationGuard, async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "grant body must be JSON" }, 422);
    }
    if (typeof body?.scopeId !== "string" || typeof body?.principalId !== "string" || typeof body?.permission !== "string") {
      return c.json({ code: "invalid_field", message: "scopeId, principalId and permission are required" }, 422);
    }
    const sessionPrincipal = c.get("session").principalId;
    const now = Date.now();
    if (!hasAdminGrant(db, { scopeId: body.scopeId, principalId: sessionPrincipal, now })) {
      return c.json({ code: "forbidden", message: "grant changes require an admin grant on the scope" }, 403);
    }
    try {
      const out = grantPermission(db, {
        scopeId: body.scopeId,
        principalId: body.principalId,
        permission: body.permission,
        expiresAt: body.expiresAt ?? null,
        now,
        actorId: sessionPrincipal,
      });
      return c.json(out, 200);
    } catch (e) {
      return c.json({ code: "conflict", message: e.message }, 409);
    }
  });

  // ---------------------------------------------------------------------
  // Unit 5.5 (04 sections 2/4): memory governance, routines, object paging,
  // task steering, purpose-attributed budget, and the task trace. All read
  // surfaces re-verify the caller's VISIBLE scopes server-side; all
  // mutations run the session+CSRF mutationGuard and a CAS on the entity
  // revision the caller saw. The scope-visibility rule is the SSE rule:
  // owned scopes, live-grant scopes, and service scopes.
  const visibleScopeIds = (principalId, now) => {
    return db
      .prepare(
        `SELECT id FROM scopes
          WHERE kind='service' OR owner_id=?
             OR id IN (
               SELECT scope_id FROM acl_grants
               WHERE principal_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)
             )`,
      )
      .all(principalId, principalId, now)
      .map((r) => r.id);
  };

  app.get("/api/memory", (c) => {
    const principalId = c.get("principalId");
    const now = Date.now();
    const scopes = visibleScopeIds(principalId, now);
    if (scopes.length === 0) return c.json({ memories: [], scanAlerts: [], suggestions: [] });
    const placeholders = scopes.map(() => "?").join(",");
    const facts = db
      .prepare(
        `SELECT id, scope_id, kind, status, version, supersedes_id, observed_at, expires_at, metadata_json, content_hash
         FROM objects
         WHERE kind='memory_fact' AND status IN ('candidate','active','conflicted') AND scope_id IN (${placeholders})
         ORDER BY observed_at DESC LIMIT 200`,
      )
      .all(...scopes);
    const memories = facts.map((f) => {
      let meta = {};
      try {
        meta = JSON.parse(f.metadata_json || "{}");
      } catch {}
      return {
        id: f.id,
        scopeId: f.scope_id,
        status: f.status,
        revision: f.version,
        factKey: meta.factKey ?? null,
        category: meta.category ?? null,
        factText: String(meta.factValue ?? "").slice(0, 500),
        confidence: meta.confidence ?? null,
        expiresAt: f.expires_at,
        observedAt: f.observed_at,
        quarantinedReasons: Array.isArray(meta.quarantined_reasons) ? meta.quarantined_reasons : [],
        neverActivatable: meta.never_activatable === true,
      };
    });
    // 13-class scan alerts: quarantined candidates, plus the dreaming
    // suggestions the loop filed for this caller's scopes. Suggestion
    // detail lives in the object's DISK content (no content column).
    const scanAlerts = memories.filter((m) => m.quarantinedReasons.length > 0);
    const suggestionRows = db
      .prepare(
        `SELECT id, scope_id, status, version, observed_at FROM objects
         WHERE kind='dreaming_suggestion' AND status IN ('candidate','active') AND scope_id IN (${placeholders})
         ORDER BY observed_at DESC LIMIT 100`,
      )
      .all(...scopes);
    const suggestions = suggestionRows.map((s) => {
      let content = {};
      const text = readObjectContent(db, stateDir ?? "", s.id);
      try {
        content = JSON.parse(text || "{}");
      } catch {}
      return { id: s.id, scopeId: s.scope_id, status: s.status, revision: s.version, observedAt: s.observed_at, type: content.type ?? null, detail: content };
    });
    return c.json({ memories, scanAlerts, suggestions });
  });

  app.post("/api/memory/:id/decide", mutationGuard, async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "decide body must be JSON" }, 422);
    }
    const decision = body?.decision;
    if (!["activate", "reject", "forget"].includes(decision)) {
      return c.json({ code: "invalid_field", message: "decision must be activate/reject/forget" }, 422);
    }
    const objectId = c.req.param("id");
    const row = db.prepare("SELECT id, scope_id, kind, status, version, metadata_json FROM objects WHERE id=?").get(objectId);
    if (!row) return c.json({ code: "not_found", message: "no such memory object" }, 404);
    const sessionPrincipal = c.get("session").principalId;
    const now = Date.now();
    if (!hasAdminGrant(db, { scopeId: row.scope_id, principalId: sessionPrincipal, now })) {
      return c.json({ code: "forbidden", message: "memory decisions require an admin grant on the object's scope" }, 403);
    }
    // CAS on the revision the caller saw (objects.version). A stale caller
    // gets 409 with the current revision; the status CAS inside the memory
    // functions is the second, authoritative gate.
    if (Number.isInteger(body?.expectedRevision) && body.expectedRevision !== row.version) {
      return c.json({ code: "conflict", message: "revision moved", currentRevision: row.version }, 409);
    }
    try {
      if (decision === "activate") {
        const out = activateMemoryFact(db, { objectId, actorId: sessionPrincipal, now });
        return c.json({ decision, ...out }, 200);
      }
      if (decision === "reject") {
        if (!["candidate", "conflicted"].includes(row.status)) {
          return c.json({ code: "conflict", message: `object is ${row.status}; only candidate/conflicted can be rejected`, currentRevision: row.version }, 409);
        }
        return c.json(withTx(db, () => {
          let meta = {};
          try {
            meta = JSON.parse(row.metadata_json || "{}");
          } catch {}
          meta.rejectedBy = sessionPrincipal;
          meta.rejectedAt = now;
          const changed = db
            .prepare("UPDATE objects SET status='expired', metadata_json=? WHERE id=? AND status IN ('candidate','conflicted')")
            .run(JSON.stringify(meta), objectId).changes;
          writeAuditSafe(db, {
            code: "memory_fact_rejected",
            actorId: sessionPrincipal,
            details: { object_id: objectId, scope_id: row.scope_id },
            now,
          });
          return { decision, objectId, status: changed === 1 ? "expired" : row.status };
        }), 200);
      }
      // forget: two-phase + deletion manifest (memory.mjs forgetObject).
      const out = forgetObject(db, stateDir ?? "", { objectId, now, actorId: sessionPrincipal });
      return c.json({ decision, ...out }, 200);
    } catch (e) {
      return c.json({ code: "conflict", message: String(e.message).slice(0, 300) }, 409);
    }
  });

  app.get("/api/routines", (c) => {
    const principalId = c.get("principalId");
    const now = Date.now();
    const scopes = visibleScopeIds(principalId, now);
    if (scopes.length === 0) return c.json({ routines: [], note: "no visible scopes" });
    const placeholders = scopes.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, scope_id, status, version, observed_at, metadata_json FROM objects
         WHERE kind='routine' AND status IN ('candidate','active') AND scope_id IN (${placeholders})
         ORDER BY observed_at DESC LIMIT 100`,
      )
      .all(...scopes);
    const routines = rows.map((r) => {
      let meta = {};
      try {
        meta = JSON.parse(r.metadata_json || "{}");
      } catch {}
      let content = {};
      const text = readObjectContent(db, stateDir ?? "", r.id);
      try {
        content = JSON.parse(text || "{}");
      } catch {}
      return {
        id: r.id,
        scopeId: r.scope_id,
        status: r.status,
        revision: r.version,
        observedAt: r.observed_at,
        routineId: meta.routineId ?? content.id ?? r.id,
        mode: meta.mode ?? content.mode ?? "observe",
        policyVersion: meta.policyVersion ?? content.policyVersion ?? null,
        reviewReportRef: meta.reviewReportRef ?? null,
        autoExternalWritesStillNeedApproval: true,
      };
    });
    return c.json({
      routines,
      note: routines.length === 0 ? "no routines registered in the visible scopes; Observe/Auto switching applies to kind='routine' objects" : null,
    });
  });

  app.post("/api/routines/:id/mode", mutationGuard, async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "mode body must be JSON" }, 422);
    }
    if (!["observe", "auto"].includes(body?.mode)) {
      return c.json({ code: "invalid_field", message: "mode must be observe/auto" }, 422);
    }
    const row = db.prepare("SELECT id, scope_id, kind, status, version, metadata_json FROM objects WHERE id=?").get(c.req.param("id"));
    if (!row || row.kind !== "routine") return c.json({ code: "not_found", message: "no such routine" }, 404);
    const sessionPrincipal = c.get("session").principalId;
    const now = Date.now();
    if (!hasAdminGrant(db, { scopeId: row.scope_id, principalId: sessionPrincipal, now })) {
      return c.json({ code: "forbidden", message: "routine mode changes require an admin grant on the routine's scope" }, 403);
    }
    if (Number.isInteger(body?.expectedRevision) && body.expectedRevision !== row.version) {
      return c.json({ code: "conflict", message: "revision moved", currentRevision: row.version }, 409);
    }
    let meta = {};
    try {
      meta = JSON.parse(row.metadata_json || "{}");
    } catch {}
    if (typeof body.policyVersion === "string" && meta.policyVersion && body.policyVersion !== meta.policyVersion) {
      return c.json({ code: "conflict", message: "policyVersion mismatch", currentRevision: row.version }, 409);
    }
    if (body.mode === "auto") {
      if (typeof body.reviewReportRef !== "string" || body.reviewReportRef.length === 0) {
        return c.json({ code: "invalid_field", message: "switching to auto requires reviewReportRef (a human-approved review record)" }, 422);
      }
    }
    meta.mode = body.mode;
    if (typeof body.reviewReportRef === "string") meta.reviewReportRef = body.reviewReportRef;
    return c.json(withTx(db, () => {
      const changed = db
        .prepare("UPDATE objects SET metadata_json=? WHERE id=? AND kind='routine'")
        .run(JSON.stringify(meta), row.id).changes;
      writeAuditSafe(db, {
        code: "routine_mode_changed",
        actorId: sessionPrincipal,
        details: { routine_id: row.id, mode: body.mode, review_report_ref: meta.reviewReportRef ?? null, note: "auto NEVER exempts external writes from approval" },
        now,
      });
      return { routineId: row.id, mode: meta.mode, autoStillApprovesExternalWrites: true };
    }), 200);
  });

  // The UNKNOWN list the reconcile tab renders (visible scopes only).
  app.get("/api/effects-unknown", (c) => {
    const principalId = c.get("principalId");
    const now = Date.now();
    const scopes = visibleScopeIds(principalId, now);
    if (scopes.length === 0) return c.json({ effects: [] });
    const placeholders = scopes.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, task_id, scope_id, operation, retry_mode, last_error, updated_at FROM effects
         WHERE state='UNKNOWN' AND scope_id IN (${placeholders}) ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(...scopes);
    return c.json({ effects: rows });
  });

  // Object paging (04 section 4: "重验来源ACL后分页读取，禁止任意path").
  // Every object_required_scope must be readable by the caller — missing one
  // returns the SAME 404 as a missing object (no existence oracle).
  app.get("/api/objects/:id", (c) => {
    const objectId = c.req.param("id");
    const row = db.prepare("SELECT id, scope_id, kind, status, content_hash, storage_ref, observed_at, metadata_json FROM objects WHERE id=?").get(objectId);
    const principalId = c.get("principalId");
    const now = Date.now();
    if (!row || row.status === "deleted") {
      return c.json({ code: "not_found", message: "no such object" }, 404);
    }
    const requiredScopes = db
      .prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=?")
      .all(objectId)
      .map((r) => r.scope_id);
    const scopes = requiredScopes.length > 0 ? requiredScopes : [row.scope_id];
    const allowed = scopes.every((s) => hasReadGrant(db, { scopeId: s, principalId, now }));
    if (!allowed) {
      return c.json({ code: "not_found", message: "no such object" }, 404);
    }
    const content = readObjectContent(db, stateDir ?? "", objectId);
    if (content === null) {
      return c.json({ code: "not_found", message: "no such object" }, 404);
    }
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const limitRaw = Number(c.req.query("limit") ?? 2000);
    const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 2000), 10000);
    const slice = content.slice(offset, offset + limit);
    return c.json({
      id: row.id,
      kind: row.kind,
      status: row.status,
      contentHash: row.content_hash,
      observedAt: row.observed_at,
      totalBytes: Buffer.byteLength(content, "utf8"),
      offset,
      limit,
      content: slice,
      truncated: offset + limit < content.length,
    });
  });

  // Chat console: visible-scope thread listing, same-scope message history,
  // and authenticated owner Web Console chat ingress (/api/chat).
  const webChatScopeId = scopeIdForDomainKey("dm:local:owner");

  const isReadableObjectForPrincipal = (objectId, principalId, now, { requireActive = false } = {}) => {
    if (!objectId) return false;
    const objRow = db.prepare("SELECT id, scope_id, status FROM objects WHERE id=?").get(objectId);
    if (!objRow || objRow.status === "deleted") return false;
    if (requireActive && objRow.status !== "active") return false;
    const reqScopes = db
      .prepare("SELECT scope_id FROM object_required_scopes WHERE object_id=?")
      .all(objectId)
      .map((r) => r.scope_id);
    const scopesToCheck = reqScopes.length > 0 ? reqScopes : [objRow.scope_id];
    return scopesToCheck.every((s) => hasReadGrant(db, { scopeId: s, principalId, now }));
  };

  app.get("/api/chat", (c) => {
    const principalId = c.get("principalId");
    const now = Date.now();
    const visible = visibleScopeIds(principalId, now);
    const visibleSet = new Set(visible);
    const reqScopeRaw = c.req.query("scopeId") ?? null;
    const reqThreadRaw = c.req.query("threadKey") ?? null;
    const reqScope = reqScopeRaw && reqScopeRaw.length > 0 ? reqScopeRaw : null;
    const reqThread = reqThreadRaw && reqThreadRaw.length > 0 ? reqThreadRaw : null;

    if (reqScope !== null && !visibleSet.has(reqScope)) {
      return c.json({ code: "not_found", message: "no such scope" }, 404);
    }

    let threads = [];
    if (visible.length > 0) {
      const placeholders = visible.map(() => "?").join(",");
      threads = db
        .prepare(
          `SELECT i.scope_id AS scopeId, i.thread_key AS threadKey, s.domain_key AS domainKey, s.channel AS channel,
                  MAX(i.received_at) AS lastAt, COUNT(*) AS msgCount
           FROM inbox i
           JOIN scopes s ON s.id = i.scope_id
           WHERE i.scope_id IN (${placeholders})
           GROUP BY i.scope_id, i.thread_key
           ORDER BY lastAt DESC
           LIMIT 30`,
        )
        .all(...visible);
    }

    const activeScopeId =
      reqScope ?? (visibleSet.has(webChatScopeId) ? webChatScopeId : threads[0]?.scopeId ?? null);
    const activeThreadKey =
      reqThread ??
      (activeScopeId === webChatScopeId || threads.length === 0
        ? "web:main"
        : threads.find((t) => t.scopeId === activeScopeId)?.threadKey ?? "web:main");

    const messages = [];
    if (
      activeScopeId &&
      activeThreadKey &&
      visibleSet.has(activeScopeId) &&
      hasReadGrant(db, { scopeId: activeScopeId, principalId, now })
    ) {
      const rows = db
        .prepare(
          `SELECT i.id AS inboxId, i.source, i.principal_id AS principalId, i.scope_id AS scopeId,
                  i.payload_object_id AS payloadObjectId, i.thread_key AS threadKey,
                  i.state AS inboxState, i.verdict, i.received_at AS receivedAt,
                  t.id AS taskId, t.state AS taskState, t.result_class AS resultClass,
                  t.result_object_id AS resultObjectId, t.updated_at AS taskUpdatedAt
           FROM inbox i
           LEFT JOIN tasks t ON t.id = (
             SELECT d.task_id FROM event_deliveries d
             JOIN tasks dt ON dt.id = d.task_id
             WHERE d.event_id = i.id
             ORDER BY dt.created_at DESC, d.rowid DESC
             LIMIT 1
           )
           WHERE i.scope_id = ? AND i.thread_key = ?
           ORDER BY i.received_at DESC, i.rowid DESC
           LIMIT 60`,
        )
        .all(activeScopeId, activeThreadKey)
        .reverse();

      for (const r of rows) {
        let userText = null;
        if (isReadableObjectForPrincipal(r.payloadObjectId, principalId, now)) {
          const rawPayload = readObjectContent(db, stateDir ?? "", r.payloadObjectId);
          if (typeof rawPayload === "string" && rawPayload.length > 0) {
            userText = extractChatUserText(rawPayload);
          }
        }

        let replyText = null;
        if (r.resultObjectId && isReadableObjectForPrincipal(r.resultObjectId, principalId, now, { requireActive: true })) {
          const rawReply = readObjectContent(db, stateDir ?? "", r.resultObjectId);
          if (typeof rawReply === "string" && rawReply.length > 0) {
            replyText = extractAssistantReplyText(rawReply);
          }
        }

        let approval = null;
        if (r.taskId) {
          const aprRow = db
            .prepare(
              `SELECT a.id, a.state, a.expires_at AS expiresAt, e.operation, e.action_json
               FROM approvals a
               JOIN effects e ON e.id = a.effect_id
               WHERE e.task_id = ?
               ORDER BY a.created_at DESC
               LIMIT 1`,
            )
            .get(r.taskId);
          if (aprRow) {
            const summary = summarizeApprovalAction(aprRow.action_json);
            approval = {
              id: aprRow.id,
              state: aprRow.state,
              operation: aprRow.operation,
              subject: summary.subject,
              bodyPreview: summary.bodyPreview,
              targetResource: summary.targetResource,
              expiresAt: aprRow.expiresAt,
            };
          }
        }

        messages.push({
          inboxId: r.inboxId,
          source: r.source,
          scopeId: r.scopeId,
          threadKey: r.threadKey,
          receivedAt: r.receivedAt,
          inboxState: r.inboxState,
          taskId: r.taskId ?? null,
          taskState: r.taskState ?? null,
          resultClass: r.resultClass ?? null,
          userText,
          replyText,
          approval,
        });
      }
    }

    return c.json({ activeScopeId, activeThreadKey, threads, messages });
  });

  app.post("/api/chat", mutationGuard, async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "chat body must be JSON" }, 422);
    }
    const message = typeof body?.message === "string" ? body.message : "";
    if (message.trim().length === 0 || message.length > 16384) {
      return c.json({ code: "invalid_field", message: "chat needs a non-empty message of at most 16384 chars" }, 422);
    }
    const threadKey = body?.threadKey === undefined ? "web:main" : body.threadKey;
    if (typeof threadKey !== "string" || !/^[a-zA-Z0-9:._-]{1,64}$/.test(threadKey)) {
      return c.json({ code: "invalid_field", message: "threadKey must match /^[a-zA-Z0-9:._-]{1,64}$/" }, 422);
    }

    const sessionPrincipal = c.get("session").principalId;
    const now = Date.now();
    const ensured = ensureWebChatOwnerScope(db, {
      ownerPrincipalId,
      sessionPrincipal,
      now,
    });

    const command = classifyControlCommand(message);
    if (command !== null) {
      try {
        const outcome = handleDeterministicControl(db, {
          command,
          scopeId: ensured.scopeId,
          threadKey,
          principalId: sessionPrincipal,
          inboxId: null,
          now,
        });
        return c.json({ code: "control_executed", outcome, scopeId: ensured.scopeId, threadKey }, 200);
      } catch (err) {
        if (err instanceof ControlCommandRefused) {
          return c.json({ code: "forbidden", message: err.message }, 403);
        }
        throw err;
      }
    }

    const reqGrant = db
      .prepare(
        `SELECT 1 FROM acl_grants
         WHERE scope_id=? AND principal_id=? AND permission='request'
           AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)
         LIMIT 1`,
      )
      .get(ensured.scopeId, sessionPrincipal, now);
    if (!reqGrant) {
      return c.json({ code: "forbidden", message: "web chat requires a live request grant on the scope" }, 403);
    }

    const received = receiveEvent(db, stateDir ?? "", {
      now,
      source: "console-chat",
      sourceEventId: `chat-${now}-${randomBytes(6).toString("hex")}`,
      principal: { platform: "local", subject: "owner" },
      scope: {
        kind: "owner_dm",
        domainKey: "dm:local:owner",
        channel: "console",
        conversationId: "owner",
      },
      threadKey,
      priority: 6,
      policyVersion: "pv1",
      payload: { kind: "web_chat", text: message, threadKey, by: sessionPrincipal },
      verdict: "ADMIT",
    });
    return c.json({ code: "queued", inboxId: received.inboxId, scopeId: ensured.scopeId, threadKey }, 202);
  });

  // Steer (04 section 4): the message becomes a durable inbox event in the
  // SAME scope; the reply is queued/accepted, never "the tool was
  // interrupted" — only the router's own rules attach it to a live task.
  app.post("/api/tasks/:id/steer", mutationGuard, async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "steer body must be JSON" }, 422);
    }
    const message = typeof body?.message === "string" ? body.message : "";
    if (message.trim().length === 0 || message.length > 16384) {
      return c.json({ code: "invalid_field", message: "steer needs a non-empty message of at most 16384 chars" }, 422);
    }
    const taskId = c.req.param("id");
    const task = db.prepare("SELECT id, scope_id, principal_id, state, updated_at FROM tasks WHERE id=?").get(taskId);
    if (!task) return c.json({ code: "not_found", message: "no such task" }, 404);
    const sessionPrincipal = c.get("session").principalId;
    const now = Date.now();
    const row = db
      .prepare("SELECT 1 FROM acl_grants WHERE scope_id=? AND principal_id=? AND permission='request' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1")
      .get(task.scope_id, sessionPrincipal, now);
    if (!row) {
      return c.json({ code: "forbidden", message: "steering requires a live request grant on the task's scope" }, 403);
    }
    if (Number.isInteger(body?.expectedRevision) && Number(task.updated_at) !== body.expectedRevision) {
      return c.json({ code: "conflict", message: "task revision moved", currentRevision: task.updated_at }, 409);
    }
    const scopeRow = db
      .prepare("SELECT kind, domain_key, channel, conversation_id, repo_id FROM scopes WHERE id=?")
      .get(task.scope_id);
    if (!scopeRow) {
      return c.json({ code: "not_found", message: "no such scope" }, 404);
    }
    const received = receiveEvent(db, stateDir ?? "", {
      now,
      source: "console-steer",
      sourceEventId: `steer-${taskId}-${randomBytes(6).toString("hex")}`,
      principal: { platform: "console", subject: sessionPrincipal },
      scope: {
        kind: scopeRow.kind,
        domainKey: scopeRow.domain_key,
        channel: scopeRow.channel,
        conversationId: scopeRow.conversation_id ?? taskId,
        ...(scopeRow.repo_id ? { repoId: scopeRow.repo_id } : {}),
      },
      threadKey: `task:${taskId}`,
      priority: 8,
      policyVersion: "pv1",
      payload: { kind: "steer", taskId, message, by: sessionPrincipal },
      verdict: "ADMIT",
    });
    return c.json({ code: "queued", inboxId: received.inboxId, note: "the steer is queued as a durable inbox event; it does not interrupt an in-flight tool call" }, 202);
  });

  // Trace (04 sections 3/4): the whole sanitized timeline plus the honest
  // "Task SUCCEEDED but Effect UNKNOWN" flag.
  app.get("/api/tasks/:id/trace", (c) => {
    const taskId = c.req.param("id");
    const principalId = c.get("principalId");
    const now = Date.now();
    const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
    if (!task) return c.json({ code: "not_found", message: "no such task" }, 404);
    const scopes = visibleScopeIds(principalId, now);
    if (!scopes.includes(task.scope_id)) {
      return c.json({ code: "not_found", message: "no such task" }, 404);
    }
    const timeline = [];
    const inboxRows = db.prepare("SELECT id, source, source_event_id, thread_key, state, verdict, received_at FROM inbox WHERE scope_id=? ORDER BY received_at ASC LIMIT 100").all(task.scope_id);
    for (const r of inboxRows) {
      timeline.push({ at: r.received_at, stage: "inbox", ref: r.id, detail: { source: r.source, state: r.state, verdict: r.verdict } });
    }
    const attempts = db.prepare("SELECT id, attempt_no, fence, state, started_at, ended_at, error_code FROM attempts WHERE task_id=? ORDER BY attempt_no").all(taskId);
    for (const a of attempts) {
      timeline.push({ at: a.started_at, stage: "attempt", ref: a.id, detail: { attempt_no: a.attempt_no, fence: a.fence, state: a.state, error_code: a.error_code, ended_at: a.ended_at } });
    }
    const requests = db.prepare("SELECT request_id, attempt_id, purpose, model_id, state, created_at, updated_at FROM model_requests WHERE task_id=? ORDER BY created_at").all(taskId);
    for (const r of requests) {
      timeline.push({ at: r.created_at, stage: "model_request", ref: r.request_id, detail: { purpose: r.purpose, model: r.model_id, state: r.state, updated_at: r.updated_at } });
    }
    const jobs = db.prepare("SELECT id, attempt_id, state, exit_code, created_at, ended_at FROM execution_jobs WHERE task_id=?").all(taskId);
    for (const j of jobs) {
      timeline.push({ at: j.created_at, stage: "execution_job", ref: j.id, detail: { state: j.state, exit_code: j.exit_code ?? null, ended_at: j.ended_at } });
    }
    const effects = db.prepare("SELECT id, operation, state, retry_mode, external_id, last_error, created_at, updated_at FROM effects WHERE task_id=?").all(taskId);
    for (const e of effects) {
      timeline.push({ at: e.created_at, stage: "effect", ref: e.id, detail: { operation: e.operation, state: e.state, retry_mode: e.retry_mode, external_id: e.external_id, last_error: e.last_error } });
    }
    const approvals = db
      .prepare("SELECT a.id, a.state, a.expires_at, a.created_at, e.id AS effect_id FROM approvals a JOIN effects e ON e.id=a.effect_id WHERE e.task_id=?")
      .all(taskId);
    for (const a of approvals) {
      timeline.push({ at: a.created_at, stage: "approval", ref: a.id, detail: { state: a.state, effect_id: a.effect_id, expires_at: a.expires_at } });
    }
    const outboxRows = db
      .prepare("SELECT o.id, o.channel, o.destination, o.not_before, o.notify_reason, e.id AS effect_id FROM outbox o JOIN effects e ON e.id=o.effect_id WHERE e.task_id=?")
      .all(taskId);
    for (const o of outboxRows) {
      timeline.push({ at: o.not_before, stage: "outbox", ref: o.id, detail: { channel: o.channel, destination: o.destination, notify_reason: o.notify_reason, effect_id: o.effect_id } });
    }
    timeline.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const unknownEffects = effects.filter((e) => e.state === "UNKNOWN").map((e) => e.id);
    return c.json({
      taskId,
      taskState: task.state,
      resultClass: task.result_class,
      timeline,
      computedButUnconfirmed: unknownEffects.length > 0,
      unconfirmedEffects: unknownEffects,
      note: unknownEffects.length > 0
        ? "Task SUCCEEDED but one or more effects are UNKNOWN: the computation finished and the external action has NOT been confirmed"
        : null,
    });
  });

  // Local web console (04 sections 2-5): same-origin HTML only, zero
  // external assets; the Host middleware above already refuses any other
  // Host with 403.
  app.get("/", (c) => {
    return c.html(consoleIndexHtml({ port }));
  });

  app.get("/favicon.ico", (c) => c.body(null, 204));


  //
  // Visible scopes (audit F8 fixed the leak where every scope's events
  // reached any bootstrap/session caller): scopes the caller OWNS, scopes
  // with an ACTIVE grant for the caller, and service scopes (daemon-level
  // alerts are for the local owner by construction). Anything else is
  // filtered out of the replay.
  app.get("/api/events/stream", async (c) => {
    const principalId = c.get("principalId");
    if (!principalId) {
      return c.json({ code: "unauthenticated", message: "the event stream requires a principal; no session or bootstrap caller resolved" }, 401);
    }
    const now = Date.now();
    const since = Number(c.req.header("last-event-id")?.split(":")?.[1] ?? 0);
    const generationRow = db.prepare("SELECT value FROM system_state WHERE key='stream_generation'").get();
    const generation = generationRow ? Number(generationRow.value) : 1;
    const clientGeneration = Number(c.req.header("last-event-id")?.split(":")?.[0] ?? generation);
    // Bounded replay window (the retention bound; older ids are gone),
    // filtered to the caller's visible scopes.
    const window = db
      .prepare(
        `SELECT seq, scope_id, event_type, entity_id, payload_json, created_at FROM stream_events
          WHERE seq>?
            AND scope_id IN (
              SELECT id FROM scopes
              WHERE kind='service' OR owner_id=?
                 OR id IN (
                   SELECT scope_id FROM acl_grants
                   WHERE principal_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)
                 )
            )
          ORDER BY seq LIMIT 500`,
      )
      .all(
        Number.isFinite(since) ? since : 0,
        principalId,
        principalId,
        now,
      );
    const lines = [];
    if (clientGeneration !== generation) {
      lines.push(`event: reset`);
      lines.push(`data: ${JSON.stringify({ generation, reason: "generation moved; take a fresh snapshot" })}`);
      lines.push("");
    }
    for (const ev of window) {
      lines.push(`id: ${generation}:${ev.seq}`);
      lines.push(`event: ${ev.event_type}`);
      lines.push(`data: ${ev.payload_json}`);
      lines.push("");
    }
    lines.push(`retry: 2000`);
    lines.push("");
    c.header("content-type", "text/event-stream");
    c.header("cache-control", "no-store");
    c.header("x-accel-buffering", "no");
    return c.body(lines.join("\n"), 200);
  });

  // Telegram webhook endpoint (re-review P1, 06 section 3.1): OUTSIDE
  // /api/* — Telegram's servers cannot carry the console bearer — and
  // guarded by the platform's documented constant-time secret-token header
  // check. The fail-closed ladder, in order: read-only maintenance -> 503;
  // no secret configured -> 503; missing/wrong header -> 403 with ZERO
  // processing; only a valid signature maps the update into the durable
  // queue as OBSERVE (a read, not a consume — dispatch stays a separate,
  // audited decision, same as the pull path; the /api auth matrix does not
  // apply, the guard IS the auth). The host/origin allowlist still binds
  // this route: a public deployment and the owner-authorized secret are
  // recorded open items, and until they exist everything verified here is
  // local-request evidence.
  const telegramGuard = telegramWebhookSecret
    ? createTelegramWebhookGuard({ secret: telegramWebhookSecret })
    : null;
  app.post("/ingress/telegram/webhook", async (c) => {
    if (mode !== "open") {
      return c.json(
        { code: "read_only_maintenance", message: "the daemon is read-only; the webhook accepts nothing" },
        503,
      );
    }
    if (!telegramGuard) {
      return c.json(
        { code: "webhook_not_configured", message: "no webhook secret is configured; the endpoint fails closed instead of guessing" },
        503,
      );
    }
    const verified = telegramGuard.verifyRequest({
      "x-telegram-bot-api-secret-token": c.req.header("x-telegram-bot-api-secret-token") ?? "",
    });
    if (!verified.ok) {
      return c.json({ code: "webhook_refused", message: verified.reason }, 403);
    }
    let update = null;
    try {
      update = await c.req.json();
    } catch {}
    if (!update || typeof update.update_id !== "number") {
      return c.json({ code: "invalid_update", message: "the body is not a Telegram update" }, 400);
    }
    const mapped = mapTelegramUpdate(update);
    if (!mapped.mappable) {
      return c.json({ code: "unmappable", reason: mapped.reason }, 202);
    }
    receiveEvent(db, stateDir, {
      now: Date.now(),
      ...mapped.event,
      policyVersion: "pv1",
      verdict: "OBSERVE",
    });
    return c.json({ code: "queued", verdict: "OBSERVE", sourceEventId: mapped.event.sourceEventId }, 202);
  });

  const buildSettingsSnapshot = () => {
    const writable = Boolean(configPath) && existsSync(configPath);
    const loaded = configPath ? loadDaemonConfig({ path: configPath }) : loadDaemonConfig();
    const envMap = envFilePath ? readDotEnvFile(envFilePath) : {};
    const secrets = {};
    for (const key of ALLOWED_SECRET_KEYS) {
      const inEnvFile = typeof envMap[key] === "string" && envMap[key].trim().length > 0;
      const inProcess = typeof process.env[key] === "string" && process.env[key].trim().length > 0;
      secrets[key] = {
        configured: inEnvFile || inProcess,
        inEnvFile,
      };
    }
    let credentialSlots = [];
    try {
      credentialSlots = createCredentialService(db, { envFile: envFilePath }).describe();
    } catch {}
    let briefingTimeOfDay = null;
    try {
      const row = db
        .prepare("SELECT state, recurrence_json FROM timers WHERE id=?")
        .get(timerIdFor("selfuse-morning-briefing"));
      if (row && row.state === "SCHEDULED" && row.recurrence_json) {
        const rec = JSON.parse(row.recurrence_json);
        if (rec?.type === "daily_wall_clock" && typeof rec.timeOfDay === "string") {
          briefingTimeOfDay = rec.timeOfDay;
        }
      }
    } catch {}
    return {
      ok: true,
      writable,
      configPath,
      envFilePath,
      config: sanitizeConfigForSettings(loaded),
      briefingTimeOfDay,
      secrets,
      credentialSlots,
      imageStatus,
    };
  };

  app.get("/api/settings", requireOwnerSession, (c) => {
    try {
      return c.json(buildSettingsSnapshot(), 200);
    } catch (err) {
      return c.json(
        { code: "settings_unavailable", error: "settings_unavailable", message: String(err?.message ?? err) },
        500,
      );
    }
  });

  app.post("/api/settings", mutationGuard, requireOwnerSession, async (c) => {
    if (!configPath || !existsSync(configPath)) {
      return c.json(
        { code: "settings_read_only", error: "settings_read_only", message: "daemon started without a writable --config file" },
        409,
      );
    }
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", error: "invalid_json", message: "settings body must be JSON" }, 422);
    }
    if (!isPlainObject(body)) {
      return c.json({ code: "invalid_field", error: "invalid_body", message: "settings body must be a JSON object" }, 422);
    }

    const configPatch = body.configPatch;
    if (configPatch !== undefined) {
      if (!isPlainObject(configPatch)) {
        return c.json({ code: "invalid_field", error: "invalid_config_patch", message: "configPatch must be a plain object" }, 422);
      }
      for (const [section, sectionVal] of Object.entries(configPatch)) {
        if (!ALLOWED_CONFIG_PATCH_SECTIONS.has(section)) {
          return c.json(
            { code: "invalid_field", error: "unknown_config_section", section, message: `disallowed configPatch section: ${section}` },
            422,
          );
        }
        if (!isPlainObject(sectionVal)) {
          return c.json(
            { code: "invalid_field", error: "invalid_config_section", section, message: `configPatch.${section} must be a plain object` },
            422,
          );
        }
      }
    }

    const secretsInput = body.secrets;
    const nonEmptySecrets = new Set();
    if (secretsInput !== undefined) {
      if (!isPlainObject(secretsInput)) {
        return c.json({ code: "invalid_field", error: "invalid_secrets", message: "secrets must be a plain object" }, 422);
      }
      for (const [key, val] of Object.entries(secretsInput)) {
        if (!ALLOWED_SECRET_KEYS.has(key)) {
          return c.json({ code: "invalid_field", error: "invalid_secret_key", key, message: `disallowed secret key: ${key}` }, 422);
        }
        if (typeof val !== "string") {
          return c.json({ code: "invalid_field", error: "invalid_secret_value", key, message: `secret value for ${key} must be a string` }, 422);
        }
        if (/[\r\n\0]/.test(val)) {
          return c.json(
            { code: "invalid_field", error: "invalid_secret_value", key, message: `secret value for ${key} contains forbidden control characters` },
            422,
          );
        }
        if (val !== "") {
          if (key === "MAIL_USER" && !/^[^@\s]+@[^@\s]+$/.test(val.trim().toLowerCase())) {
            return c.json({ code: "invalid_field", error: "invalid_secret_value", key, message: "MAIL_USER must be a valid email address" }, 422);
          }
          nonEmptySecrets.add(key);
        }
      }
    }

    const clearSecretsInput = body.clearSecrets;
    if (clearSecretsInput !== undefined) {
      if (!Array.isArray(clearSecretsInput)) {
        return c.json({ code: "invalid_field", error: "invalid_clear_secrets", message: "clearSecrets must be an array" }, 422);
      }
      for (const key of clearSecretsInput) {
        if (typeof key !== "string" || !ALLOWED_SECRET_KEYS.has(key)) {
          return c.json(
            { code: "invalid_field", error: "invalid_secret_key", key, message: `disallowed secret key: ${String(key)}` },
            422,
          );
        }
        if (nonEmptySecrets.has(key)) {
          return c.json(
            { code: "invalid_field", error: "conflicting_secret_key", key, message: `conflicting set and clear for secret key ${key}` },
            422,
          );
        }
      }
    }

    let briefingArg = null;
    if (body.briefingTimeOfDay !== undefined) {
      if (body.briefingTimeOfDay === null || body.briefingTimeOfDay === "") {
        briefingArg = "";
      } else if (typeof body.briefingTimeOfDay === "string" && SETTINGS_HHMM_RE.test(body.briefingTimeOfDay)) {
        briefingArg = body.briefingTimeOfDay;
      } else {
        return c.json(
          {
            code: "invalid_field",
            error: "invalid_briefing_time",
            message: "briefingTimeOfDay must be HH:MM (24h), empty string, or null",
          },
          422,
        );
      }
    }

    let rawConfig;
    try {
      rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
      if (!isPlainObject(rawConfig)) throw new Error("config file must contain a JSON object");
    } catch (err) {
      return c.json({ code: "invalid_config", error: "invalid_config", message: err.message }, 422);
    }

    const mergedRaw = configPatch ? deepMergeConfig(rawConfig, configPatch) : rawConfig;
    const tmpConfigPath = join(
      dirname(configPath),
      `.tmp.settings.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.json`,
    );

    let validatedConfig;
    let movedToTarget = false;
    try {
      writeFileSync(tmpConfigPath, `${JSON.stringify(mergedRaw, null, 2)}\n`, "utf8");
      try {
        validatedConfig = loadDaemonConfig({ path: tmpConfigPath });
      } catch (err) {
        const msg = err instanceof ConfigError ? err.message : String(err?.message ?? err);
        return c.json({ code: "invalid_config", error: "invalid_config", message: msg }, 422);
      }
      for (const chatId of validatedConfig.telegram.allowedChatIds) {
        if (!/^-?\d+$/.test(chatId)) {
          return c.json(
            {
              code: "invalid_config",
              error: "invalid_config",
              message: `telegram.allowedChatIds contains non-numeric entry ${JSON.stringify(chatId)}`,
            },
            422,
          );
        }
      }
      if (typeof briefingArg === "string" && briefingArg.length > 0) {
        if (!stateDir) {
          return c.json(
            { code: "settings_unavailable", error: "missing_state_dir", message: "stateDir is required to schedule morning briefing" },
            409,
          );
        }
        if (!hasOwnerTelegramDmScope(validatedConfig)) {
          return c.json(
            {
              code: "invalid_field",
              error: "invalid_briefing_time",
              message: "briefingTimeOfDay requires telegram.ownerDestination or a non-negative chat ID in telegram.allowedChatIds",
            },
            422,
          );
        }
      }

      renameSync(tmpConfigPath, configPath);
      movedToTarget = true;
    } finally {
      if (!movedToTarget) {
        try {
          if (existsSync(tmpConfigPath)) unlinkSync(tmpConfigPath);
        } catch {}
      }
    }

    const hasEnvMutation =
      (secretsInput && Object.keys(secretsInput).length > 0) ||
      (clearSecretsInput && clearSecretsInput.length > 0);
    let envUpdateResult = { updated: [], cleared: [] };
    if (envFilePath && hasEnvMutation) {
      envUpdateResult = upsertDotEnvKeys(envFilePath, {
        set: secretsInput ?? {},
        clear: clearSecretsInput ?? [],
      });
    } else if (hasEnvMutation && !envFilePath) {
      for (const [k, v] of Object.entries(secretsInput ?? {})) {
        if (v !== "") envUpdateResult.updated.push(k);
      }
      for (const k of clearSecretsInput ?? []) {
        envUpdateResult.cleared.push(k);
      }
    }

    for (const key of envUpdateResult.updated) {
      process.env[key] = secretsInput[key];
    }
    for (const key of envUpdateResult.cleared) {
      delete process.env[key];
    }
    const mergedEnv = envFilePath ? { ...process.env, ...readDotEnvFile(envFilePath) } : { ...process.env };
    synthesizeEnvVars(mergedEnv, { target: process.env, refresh: true });

    const now = Date.now();
    const sessionPrincipal = c.get("session").principalId;
    withTx(db, () => {
      writeAudit(db, {
        code: "host_settings_updated",
        actorId: sessionPrincipal,
        details: {
          sections: configPatch ? Object.keys(configPatch) : [],
          briefingTimeUpdated: body.briefingTimeOfDay !== undefined,
        },
        now,
      });
      if (envUpdateResult.updated.length > 0 || envUpdateResult.cleared.length > 0) {
        writeAudit(db, {
          code: "host_secrets_updated",
          actorId: sessionPrincipal,
          details: {
            updatedKeys: envUpdateResult.updated,
            clearedKeys: envUpdateResult.cleared,
          },
          now,
        });
      }
    });

    syncSelfUseDatabase(db, {
      config: validatedConfig,
      dataDir: stateDir,
      envMap: process.env,
      briefingTime: briefingArg,
      now,
    });

    if (typeof onConfigReload === "function") {
      await onConfigReload();
    }

    return c.json({
      ...buildSettingsSnapshot(),
      reloadOk: true,
    }, 200);
  });

  app.post("/api/settings/test", mutationGuard, requireOwnerSession, async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", error: "invalid_json", message: "test body must be JSON" }, 422);
    }
    const target = body?.target;
    if (target !== "model" && target !== "telegram" && target !== "mail") {
      return c.json(
        { code: "invalid_field", error: "invalid_target", message: "target must be one of model, telegram, mail" },
        422,
      );
    }
    const currentConfig = configPath ? loadDaemonConfig({ path: configPath }) : loadDaemonConfig();
    const dotEnv = envFilePath ? readDotEnvFile(envFilePath) : {};
    const resolvedEnv = synthesizeEnvVars({ ...process.env, ...dotEnv }, { refresh: true });
    const result = await testConnectivity({ target, config: currentConfig, env: resolvedEnv });
    return c.json(result, 200);
  });

  // Later-phase surfaces answer explicitly-not-implemented, never fake data
  // (04 section 4: "phase中尚未实现的端点返回明确不可用，不用假数据模拟完成").
  app.all("/api/*", (c) => {
    return c.json(
      {
        code: "not_implemented_yet",
        message: "this console surface (governance/replay/memory/routines/skills) is a later phase; no fake data is served",
      },
      501,
    );
  });

  return app;
}

function summarizeApprovalAction(actionJson) {
  let action = {};
  try {
    action = JSON.parse(actionJson || "{}");
  } catch {}
  if (!action || typeof action !== "object" || Array.isArray(action)) action = {};
  const extra = extraFieldsOfAction(action);
  const rawBody =
    typeof extra.bodyText === "string"
      ? extra.bodyText
      : typeof extra.body === "string"
        ? extra.body
        : typeof extra.description === "string"
          ? extra.description
          : typeof extra.text === "string"
            ? extra.text
            : null;
  return {
    targetResource: action.target_resource ?? null,
    subject: typeof extra.subject === "string" ? extra.subject : typeof extra.title === "string" ? extra.title : null,
    bodyPreview: rawBody !== null ? rawBody.slice(0, 240) : null,
    sendingIdentity: extra.sendingIdentity ?? action.sending_identity ?? null,
  };
}

function extractChatUserText(rawPayload) {
  const formatted = formatGeneralUserPrompt(rawPayload);
  if (formatted !== rawPayload) return formatted;
  try {
    const obj = JSON.parse(rawPayload);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      if (typeof obj.text === "string" && obj.text.length > 0) return obj.text;
      if (typeof obj.subject === "string" || typeof obj.summary === "string") {
        const parts = [obj.subject, obj.summary]
          .filter((s) => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim());
        if (parts.length > 0) return parts.join("\n");
      }
      if (typeof obj.message === "string" && obj.message.length > 0) return obj.message;
      if (typeof obj.question === "string" && obj.question.length > 0) return obj.question;
    }
  } catch {}
  return rawPayload;
}

function extractAssistantReplyText(rawReply) {
  try {
    const parsed = JSON.parse(rawReply);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.reply === "string") {
      return parsed.reply;
    }
  } catch {}
  return rawReply;
}

function ensureWebChatOwnerScope(db, { ownerPrincipalId, sessionPrincipal, now }) {
  const scope = withTx(db, () => {
    const ownerRef = ensurePrincipal(db, { platform: "local", subject: "owner" });
    const ownerId = ownerPrincipalId ?? ownerRef.id;
    return ensureScope(db, {
      ownerId,
      kind: "owner_dm",
      domainKey: "dm:local:owner",
      channel: "console",
      conversationId: "owner",
      policyVersion: "pv1",
    });
  });
  if (sessionPrincipal === ownerPrincipalId) {
    for (const permission of ["read", "request", "approve", "admin"]) {
      const existing = db
        .prepare("SELECT 1 FROM acl_grants WHERE scope_id=? AND principal_id=? AND permission=? LIMIT 1")
        .get(scope.id, sessionPrincipal, permission);
      if (!existing) {
        grantPermission(db, { scopeId: scope.id, principalId: sessionPrincipal, permission, now, actorId: ownerPrincipalId });
      }
    }
  }
  return { scopeId: scope.id };
}

function hasAdminGrant(db, { scopeId, principalId, now }) {
  const row = db
    .prepare(
      `SELECT 1 FROM acl_grants
        WHERE scope_id=? AND principal_id=? AND permission='admin'
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)
        LIMIT 1`,
    )
    .get(scopeId, principalId, now);
  return row !== undefined;
}

// Console-side audit must never turn a decision into a 500 (the same
// discipline as the adapter's auditRefusal).
function writeAuditSafe(db, entry) {
  try {
    writeAudit(db, entry);
  } catch {}
}

const ALLOWED_CONFIG_PATCH_SECTIONS = new Set(["model", "telegram", "mail", "policy", "adapters"]);
const SETTINGS_HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMergeConfig(target, patch) {
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [key, val] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (isPlainObject(val) && isPlainObject(out[key])) {
      out[key] = deepMergeConfig(out[key], val);
    } else if (Array.isArray(val)) {
      out[key] = [...val];
    } else if (isPlainObject(val)) {
      out[key] = deepMergeConfig({}, val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function hasOwnerTelegramDmScope(config) {
  const ownerDest = config.telegram?.ownerDestination ?? null;
  if (ownerDest && (ownerDest.startsWith("dm:telegram:") || ownerDest.startsWith("group:telegram:") || parseTelegramTargetResource(ownerDest) !== null)) {
    return true;
  }
  return (config.telegram?.allowedChatIds ?? []).some((id) => /^-?\d+$/.test(id) && !id.startsWith("-"));
}

function sanitizeConfigForSettings(loaded) {
  return {
    timezone: loaded.timezone,
    model: loaded.model,
    telegram: loaded.telegram,
    mail: loaded.mail,
    calendar: loaded.calendar,
    policy: loaded.policy,
    adapters: loaded.adapters,
    budget: loaded.budget,
    leases: loaded.leases,
    router: loaded.router,
    memory: loaded.memory,
    upstream: loaded.upstream,
    backup: loaded.backup,
    acquisition: loaded.acquisition,
    triage: loaded.triage,
    credentials: loaded.credentials,
  };
}

export function serveConsole(app, { port = CONSOLE_DEFAULT_PORT }) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      // Keep the Host header: the same-origin middleware validates it.
      const headers = { ...req.headers };
      const body = await new Promise((resolve) => {
        const chunks = [];
        req.on("data", (d) => chunks.push(d));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      });
      const request = new Request(url, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body,
      });
      const response = await app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "console_error", message: e.message }));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, CONSOLE_BIND, () => resolve({ server, port, bind: CONSOLE_BIND }));
  });
}
