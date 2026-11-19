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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Hono } from "hono";
import { decideApproval, hasApproveGrant } from "../approvals.mjs";
import { reviseEffect, cancelTask, reconcileUnknown } from "../effects.mjs";
import { grantPermission, revokePermission } from "../acl.mjs";

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
      return next();
    }
    const session = findSession(bearer, { now: Date.now() });
    if (session) {
      c.set("authKind", "session");
      c.set("session", session);
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
        `SELECT id, scope_id, state, priority, result_class, attempt_no, fence, available_at, deadline_at,
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
        `SELECT a.id, a.effect_id, a.state, a.approver_id, a.expires_at, a.created_at,
                e.task_id, e.scope_id, e.operation
         FROM approvals a JOIN effects e ON e.id = a.effect_id
         ORDER BY a.created_at DESC LIMIT 100`,
      )
      .all();
    return c.json({ approvals: rows });
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
    return c.json({
      approval: {
        id: approval.id,
        state: approval.state,
        approverId: approval.approver_id,
        expiresAt: approval.expires_at,
        createdAt: approval.created_at,
        actionHashShort: hashShort(approval.action_hash),
      },
      action: {
        // Card fields per 04 section 2. Secrets never enter action_json, so
        // nothing here can leak one.
        operation: effect.operation,
        targetResource: action.target_resource ?? null,
        contentHash: action.content_hash ?? null,
        attachmentHash: action.attachment_hash ?? null,
        expectedHead: action.expected_head ?? null,
        sendingIdentity: action.sending_identity ?? null,
        extra: action.extra ?? {},
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

  // Budget console (04 section 3: Phase 3 adds the budget surface).
  app.get("/api/budget", (c) => {
    const accounts = db
      .prepare(
        "SELECT id, period_key, kind, limit_microusd, spent_microusd, held_microusd, frozen FROM budget_accounts ORDER BY id",
      )
      .all();
    const reservations = db
      .prepare(
        "SELECT id, request_key, purpose, provider, state, upper_microusd, actual_microusd, created_at, settled_at FROM budget_reservations ORDER BY created_at DESC LIMIT 200",
      )
      .all();
    return c.json({
      accounts,
      reservations,
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

  // SSE event stream (04 sections 4/5): authenticated, scope-filtered,
  // replay-from-Last-Event-ID within a bounded window, generation-gated.
  // The snapshot comes FIRST, then the stream from the snapshot's watermark
  // — the client never trusts a stream without its starting cursor.
  app.get("/api/events/stream", async (c) => {
    const since = Number(c.req.header("last-event-id")?.split(":")?.[1] ?? 0);
    const generationRow = db.prepare("SELECT value FROM system_state WHERE key='stream_generation'").get();
    const generation = generationRow ? Number(generationRow.value) : 1;
    const clientGeneration = Number(c.req.header("last-event-id")?.split(":")?.[0] ?? generation);
    // Bounded replay window (the retention bound; older ids are gone).
    const window = db
      .prepare(
        "SELECT seq, scope_id, event_type, entity_id, payload_json, created_at FROM stream_events WHERE seq>? ORDER BY seq LIMIT 500",
      )
      .all(Number.isFinite(since) ? since : 0);
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
