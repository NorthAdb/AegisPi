import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  decideApproval,
  saveDraftRevision,
  type ApprovalRow,
  type DraftRevisionRow,
  type ProposalRow,
} from "../governance/approvals.ts";
import {
  listBudgetDenialsForConversation,
  type BudgetAccountRow,
  type BudgetReservationRow,
} from "../governance/budget.ts";
import {
  reconcileUnknownEffect,
  revokeOrCancelScope,
  type EffectRow,
} from "../governance/effects.ts";
import type { AegisHostRuntime } from "../runtime/harness.ts";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  constantTimeTokenMatch,
  createWebSession,
  isAllowedLoopbackHost,
  isAllowedLoopbackOrigin,
  LoginRateLimiter,
  MAX_SESSION_TTL_MS,
  parseCookieHeader,
  revokeWebSession,
  SESSION_COOKIE_NAME,
  validateWebSession,
  type AuthSession,
} from "./auth.ts";
import { renderMinimalView1Html } from "./view1.ts";

export interface WebServerConfig {
  host: AegisHostRuntime;
  bindHost?: string;
  port?: number;
  consoleToken: string;
  defaultPrincipalId?: string;
  now?: () => number;
}

export interface RunningWebServer {
  server: ServerType;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

export function uiStatusLabelFor(approvalState: string, effectState: string | null): string {
  if (effectState === "UNKNOWN") return "结果待核对";
  if (effectState === "SUCCEEDED") return "远端已确认";
  if (effectState === "SUBMITTING") return "正在提交";
  if (effectState === "QUARANTINED") return "未提交，待核对";
  if (effectState === "FAILED") return "发送失败";
  if (effectState === "READY") return "已批准";
  if (approvalState === "PENDING") return "待审批";
  if (approvalState === "REJECTED") return "已拒绝";
  if (approvalState === "EXPIRED") return "已过期";
  if (approvalState === "SUPERSEDED") return "已替代";
  return approvalState;
}

export async function startWebServer(config: WebServerConfig): Promise<RunningWebServer> {
  const bindHost = config.bindHost ?? "127.0.0.1";
  // Stage 1 hard guard: refuse non-loopback bind
  if (bindHost !== "127.0.0.1" && bindHost !== "::1" && bindHost !== "localhost") {
    throw new Error(`Stage 1 refuses non-loopback Web bind address: ${bindHost}`);
  }

  const nowFn = config.now ?? (() => Date.now());
  const defaultPrincipalId = config.defaultPrincipalId ?? "owner";
  const rateLimiter = new LoginRateLimiter(20, 60_000);
  let boundPort = config.port ?? 4310;
  let snapshotVersion = 1;
  const activeSseClosers = new Set<() => void>();

  const app = new Hono<{ Variables: { authSession: AuthSession } }>();

  // Host & Origin guard middleware
  app.use("*", async (c, next) => {
    const hostHeader = c.req.header("host");
    if (!isAllowedLoopbackHost(hostHeader, boundPort)) {
      return c.json({ error: "invalid_host" }, 403);
    }
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const origin = c.req.header("origin");
      if (!isAllowedLoopbackOrigin(origin, boundPort)) {
        return c.json({ error: "invalid_origin" }, 403);
      }
    }
    await next();
  });

  app.get("/", (c) => {
    c.header("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'self'");
    return c.html(renderMinimalView1Html());
  });

  app.get("/api/health", (c) => {
    return c.json({
      health: config.host.health,
      acceptingCommands: config.host.isAcceptingCommands,
      runtimeEpoch: config.host.runtimeEpoch,
      recoveredSubmittingToUnknown: config.host.startupReport.recoveredSubmittingToUnknown,
      reconciledQuarantinedEffects: config.host.startupReport.reconciledQuarantinedEffects,
      selfCheckErrors: config.host.startupReport.selfCheckErrors,
      pairedCheckOk: config.host.startupReport.pairedCheck.ok,
    });
  });

  app.post("/api/auth/login", async (c) => {
    const now = nowFn();
    if (!rateLimiter.checkAndRecord("loopback", now)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as { token?: string; principalId?: string };
    if (typeof body.token !== "string" || !constantTimeTokenMatch(config.consoleToken, body.token)) {
      return c.json({ error: "invalid_credentials" }, 401);
    }
    const principalId =
      typeof body.principalId === "string" && body.principalId.trim().length > 0
        ? body.principalId.trim()
        : defaultPrincipalId;
    const session = createWebSession(config.host.govDb, {
      principalId,
      now,
      ttlMs: MAX_SESSION_TTL_MS,
    });
    c.header("set-cookie", buildSessionCookie(session.rawToken, Math.floor(MAX_SESSION_TTL_MS / 1000)));
    return c.json({ ok: true, principalId, expiresAt: session.expiresAt });
  });

  // Auth middleware for all protected /api/* routes
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health" || c.req.path === "/api/auth/login") {
      await next();
      return;
    }
    const cookies = parseCookieHeader(c.req.header("cookie"));
    const session = validateWebSession(config.host.govDb, cookies[SESSION_COOKIE_NAME], nowFn());
    if (!session) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("authSession", session);
    await next();
  });

  app.post("/api/auth/logout", (c) => {
    const session = c.get("authSession");
    revokeWebSession(config.host.govDb, session.tokenDigest, nowFn());
    for (const closer of activeSseClosers) closer();
    c.header("set-cookie", buildClearSessionCookie());
    return c.json({ ok: true });
  });

  app.get("/api/conversations", (c) => {
    const session = c.get("authSession");
    const rows = config.host.govDb
      .prepare(
        `SELECT conversation_id, scope_id, principal_id, runtime_epoch, created_at
           FROM conversation_scopes
          WHERE principal_id = ?
          ORDER BY created_at ASC`,
      )
      .all(session.principalId) as Array<{
      conversation_id: string;
      scope_id: string;
      principal_id: string;
      runtime_epoch: string;
      created_at: number;
    }>;
    return c.json({
      conversations: rows.map((r) => ({
        conversationId: r.conversation_id,
        scopeId: r.scope_id,
        principalId: r.principal_id,
        runtimeEpoch: r.runtime_epoch,
        createdAt: r.created_at,
      })),
    });
  });

  app.post("/api/conversations", async (c) => {
    if (!config.host.isAcceptingCommands) {
      return c.json({ error: "host_not_ready", health: config.host.health }, 503);
    }
    const session = c.get("authSession");
    const body = (await c.req.json().catch(() => ({}))) as {
      slotName?: "router" | "worker";
      budgetTaskId?: string;
      scopeId?: string;
    };
    const conv = await config.host.createManagedConversation({
      principalId: session.principalId,
      slotName: body.slotName,
      budgetTaskId: body.budgetTaskId,
      scopeId: body.scopeId,
    });
    snapshotVersion++;
    return c.json({ ok: true, conversationId: String(conv.id), runtimeEpoch: config.host.runtimeEpoch });
  });

  app.post("/api/conversations/:id/chat", async (c) => {
    if (!config.host.isAcceptingCommands) {
      return c.json({ error: "host_not_ready", health: config.host.health }, 503);
    }
    const session = c.get("authSession");
    const convIdStr = c.req.param("id");
    const convScope = config.host.govDb
      .prepare("SELECT * FROM conversation_scopes WHERE conversation_id = ?")
      .get(convIdStr) as { principal_id: string } | undefined;
    if (!convScope || convScope.principal_id !== session.principalId) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { content?: string; budgetTaskId?: string };
    if (!body.content || typeof body.content !== "string") {
      return c.json({ error: "missing_content" }, 400);
    }
    const res = await config.host.submitChatInput({
      conversationId: convIdStr,
      content: body.content,
      budgetTaskId: body.budgetTaskId,
    });
    if (!res.ok) {
      return c.json({ error: res.code }, 404);
    }
    snapshotVersion++;
    return c.json({ ok: true, submissionId: res.submissionId, conversationId: convIdStr });
  });

  app.post("/api/conversations/:id/compact", async (c) => {
    if (!config.host.isAcceptingCommands) {
      return c.json({ error: "host_not_ready", health: config.host.health }, 503);
    }
    const session = c.get("authSession");
    const convIdStr = c.req.param("id");
    const convScope = config.host.govDb
      .prepare("SELECT * FROM conversation_scopes WHERE conversation_id = ?")
      .get(convIdStr) as { principal_id: string } | undefined;
    if (!convScope || convScope.principal_id !== session.principalId) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { instructions?: string; budgetTaskId?: string };
    const res = await config.host.triggerCompaction({
      conversationId: convIdStr,
      instructions: body.instructions,
      budgetTaskId: body.budgetTaskId,
    });
    if (!res.ok) {
      return c.json({ error: res.code }, 404);
    }
    snapshotVersion++;
    return c.json({ ok: true, compactionTaskId: res.compactionTaskId, conversationId: convIdStr });
  });

  async function buildAuthoritativeSnapshot(convIdStr: string, principalId: string) {
    const convScope = config.host.govDb
      .prepare("SELECT * FROM conversation_scopes WHERE conversation_id = ?")
      .get(convIdStr) as { scope_id: string; principal_id: string; runtime_epoch: string } | undefined;
    if (!convScope || convScope.principal_id !== principalId) {
      return null;
    }

    const proposalRows = config.host.govDb
      .prepare(
        `SELECT * FROM proposals
          WHERE conversation_id = ?
          ORDER BY created_at ASC`,
      )
      .all(convIdStr) as unknown as ProposalRow[];

    const proposals = proposalRows.map((p) => {
      const draft = config.host.govDb
        .prepare("SELECT * FROM draft_revisions WHERE proposal_id = ? AND revision = ?")
        .get(p.proposal_id, p.head_rev) as unknown as DraftRevisionRow;
      const apr = config.host.govDb
        .prepare("SELECT * FROM approvals WHERE proposal_id = ? AND revision = ?")
        .get(p.proposal_id, p.head_rev) as unknown as ApprovalRow;
      const challenge =
        apr.state === "PENDING"
          ? (config.host.govDb
              .prepare("SELECT nonce_value FROM approval_challenges WHERE approval_id = ?")
              .get(apr.approval_id) as { nonce_value: string } | undefined)
          : undefined;
      const effect = config.host.govDb
        .prepare("SELECT * FROM effects WHERE approval_id = ?")
        .get(apr.approval_id) as EffectRow | undefined;

      return {
        proposalId: p.proposal_id,
        runtimeEpoch: p.runtime_epoch,
        conversationId: p.conversation_id,
        toolTaskId: p.tool_task_id,
        callId: p.call_id,
        toolName: p.tool_name,
        target: p.target,
        revision: p.head_rev,
        actionHash: draft.action_hash,
        snapshot: JSON.parse(draft.canonical_snapshot) as Record<string, unknown>,
        approvalId: apr.approval_id,
        approvalState: apr.state,
        nonce: challenge?.nonce_value ?? null,
        effect: effect
          ? {
              effectId: effect.effect_id,
              state: effect.state,
              claimedAt: effect.claimed_at,
              receiptRef: effect.receipt_ref,
              reason: effect.reason,
              reconciledBy: effect.reconciled_by,
              reconcileEvidence: effect.reconcile_evidence,
            }
          : null,
        uiStatusLabel: uiStatusLabelFor(apr.state, effect?.state ?? null),
      };
    });

    const reservations = config.host.govDb
      .prepare(
        `SELECT * FROM budget_reservations
          WHERE conversation_id = ?
          ORDER BY reserved_at ASC`,
      )
      .all(convIdStr) as unknown as BudgetReservationRow[];

    const accounts = config.host.govDb
      .prepare("SELECT * FROM budget_accounts ORDER BY account_id ASC")
      .all() as unknown as BudgetAccountRow[];

    const budgetDenials = listBudgetDenialsForConversation(config.host.govDb, convIdStr);

    const messages = await config.host.readConversationMessages(convIdStr);

    return {
      conversationId: convIdStr,
      scopeId: convScope.scope_id,
      runtimeEpoch: config.host.runtimeEpoch,
      health: config.host.health,
      snapshotVersion,
      proposals,
      budgetAccounts: accounts,
      budgetReservations: reservations,
      budgetDenials,
      messages,
    };
  }

  app.get("/api/conversations/:id/snapshot", async (c) => {
    const session = c.get("authSession");
    const convIdStr = c.req.param("id");
    const snap = await buildAuthoritativeSnapshot(convIdStr, session.principalId);
    if (!snap) {
      return c.json({ error: "forbidden_or_not_found" }, 403);
    }
    return c.json(snap);
  });

  app.post("/api/proposals/:id/draft", async (c) => {
    if (!config.host.isAcceptingCommands) {
      return c.json({ error: "host_not_ready", health: config.host.health }, 503);
    }
    const session = c.get("authSession");
    const proposalId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      conversationId?: string;
      expectedHeadRev?: number;
      target?: string;
      payload?: Record<string, unknown>;
    };
    if (!body.conversationId || typeof body.expectedHeadRev !== "number" || !body.payload) {
      return c.json({ error: "invalid_draft_request" }, 400);
    }
    const res = saveDraftRevision(config.host.govDb, {
      proposalId,
      conversationId: body.conversationId,
      principalId: session.principalId,
      expectedHeadRev: body.expectedHeadRev,
      target: body.target,
      payload: body.payload,
      expiresAt: nowFn() + 30 * 60 * 1000,
      now: nowFn(),
    });
    if (res.ok) snapshotVersion++;
    return c.json(res, res.httpStatus);
  });

  // Unified decision route: POST /api/approvals/decide
  app.post("/api/approvals/decide", async (c) => {
    if (!config.host.isAcceptingCommands) {
      return c.json({ error: "host_not_ready", health: config.host.health }, 503);
    }
    const session = c.get("authSession");
    const body = (await c.req.json().catch(() => ({}))) as {
      approvalId?: string;
      conversationId?: string;
      decision?: "APPROVE" | "REJECT";
      expectedRevision?: number;
      expectedActionHash?: string;
      nonce?: string;
      decisionKey?: string;
    };
    if (
      !body.approvalId ||
      !body.conversationId ||
      (body.decision !== "APPROVE" && body.decision !== "REJECT") ||
      typeof body.expectedRevision !== "number" ||
      !body.expectedActionHash ||
      typeof body.nonce !== "string" ||
      !body.decisionKey
    ) {
      return c.json({ error: "invalid_decision_request" }, 400);
    }

    const res = decideApproval(config.host.govDb, {
      approvalId: body.approvalId,
      conversationId: body.conversationId,
      principalId: session.principalId,
      decision: body.decision,
      expectedRevision: body.expectedRevision,
      expectedActionHash: body.expectedActionHash,
      nonce: body.nonce,
      decisionKey: body.decisionKey,
      now: nowFn(),
    });

    if (res.ok) {
      snapshotVersion++;
      // Trigger asynchronous outbox delivery without blocking HTTP response
      void config.host.deliverPendingOutbox().catch(() => {});
    }

    return c.json(res, res.httpStatus);
  });

  app.post("/api/effects/:id/reconcile", async (c) => {
    const session = c.get("authSession");
    const effectId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      conclusion?: "CONFIRMED_SUCCEEDED" | "CONFIRMED_NOT_SENT" | "REMAINS_UNKNOWN";
      evidenceRef?: string;
      receiptRef?: string;
    };
    if (!body.conclusion || !body.evidenceRef) {
      return c.json({ error: "missing_reconcile_fields" }, 400);
    }
    const res = reconcileUnknownEffect(config.host.govDb, {
      effectId,
      actorId: session.principalId,
      conclusion: body.conclusion,
      evidenceRef: body.evidenceRef,
      receiptRef: body.receiptRef,
      now: nowFn(),
    });
    snapshotVersion++;
    return c.json(res, res.ok ? 200 : 409);
  });

  app.post("/api/scopes/:id/revoke", async (c) => {
    const session = c.get("authSession");
    const scopeId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string; markCancelled?: boolean };
    const res = revokeOrCancelScope(config.host.govDb, {
      scopeId,
      actorId: session.principalId,
      reason: body.reason ?? "user_revoked",
      markCancelled: body.markCancelled,
      now: nowFn(),
    });
    snapshotVersion++;
    return c.json({ ok: true, ...res });
  });

  app.get("/api/conversations/:id/events", async (c) => {
    const session = c.get("authSession");
    const convIdStr = c.req.param("id");
    const initial = await buildAuthoritativeSnapshot(convIdStr, session.principalId);
    if (!initial) {
      return c.json({ error: "forbidden_or_not_found" }, 403);
    }
    return streamSSE(c, async (stream) => {
      let open = true;
      const closeMe = (): void => {
        open = false;
      };
      activeSseClosers.add(closeMe);
      try {
        let lastSentVersion = -1;
        while (open) {
          // Verify session still valid on every tick (logout closes existing streams)
          const stillValid = config.host.govDb
            .prepare("SELECT revoked_at, expires_at FROM sessions WHERE token_digest = ?")
            .get(session.tokenDigest) as { revoked_at: number | null; expires_at: number } | undefined;
          if (!stillValid || stillValid.revoked_at !== null || nowFn() >= stillValid.expires_at) {
            break;
          }
          if (snapshotVersion !== lastSentVersion) {
            const snap = await buildAuthoritativeSnapshot(convIdStr, session.principalId);
            if (!snap) break;
            lastSentVersion = snap.snapshotVersion;
            await stream.writeSSE({
              id: String(snap.snapshotVersion),
              event: "snapshot",
              data: JSON.stringify(snap),
            });
          }
          await stream.sleep(200);
        }
      } finally {
        activeSseClosers.delete(closeMe);
      }
    });
  });

  const server = await new Promise<ServerType>((resolve) => {
    const srv = serve(
      {
        fetch: app.fetch,
        hostname: bindHost,
        port: config.port ?? 4310,
      },
      (info) => {
        boundPort = info.port;
        resolve(srv);
      },
    );
  });

  return {
    server,
    port: boundPort,
    baseUrl: `http://${bindHost}:${boundPort}`,
    close: async () => {
      for (const closer of activeSseClosers) closer();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
