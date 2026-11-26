import path from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  deleteMemoryNoteWithTombstone,
  freezeDomainL0Snapshot,
  recallMemory,
  type MemoryNoteRow,
} from "../capabilities/memory/store.ts";
import {
  computeActiveSkillSetHash,
  listSkillsIndex,
  readSkillDisclosure,
  revokeSkill,
  setSkillActiveVersion,
} from "../capabilities/skills/store.ts";
import {
  createRoutineWithGovernance,
  formatUtcInTimezone,
  listRoutines,
  parseNaturalLanguageRoutine,
  pauseRoutine,
  resumeRoutine,
  type RoutineScheduleSpec,
  type RoutineSkipCondition,
} from "../capabilities/timers/routines.ts";
import {
  decideApproval,
  fetchAuthorizedApprovalChallenge,
  isPrincipalAuthorizedForScope,
  saveDraftRevision,
  type ApprovalRow,
  type DraftRevisionRow,
  type ProposalRow,
  type ScopeRow,
} from "../governance/approvals.ts";
import { sha256Hex } from "../governance/canonical.ts";
import {
  availableMu,
  DEFAULT_TIME_ZONE,
  formatChargeDay,
  listBudgetDenialsForConversation,
  type BudgetAccountRow,
  type BudgetReservationRow,
} from "../governance/budget.ts";
import {
  chatCommandUiStatusLabel,
  listChatCommandsForConversation,
} from "../governance/chat-commands.ts";
import {
  reconcileUnknownEffect,
  revokeOrCancelScope,
  type EffectRow,
} from "../governance/effects.ts";
import {
  approveStoredMcpToolPin,
  listMcpServerPins,
  listMcpToolPins,
  revokeMcpTool,
} from "../governance/mcp-pin.ts";
import { listManagedFileImportsForConversation } from "../capabilities/workspace/importer.ts";
import {
  checkRecordedSourceReadStillAuthorized,
  getSourceReadRevocationWatermark,
  listConversationSources,
  revokeSourceReadGrant,
} from "../governance/policy.ts";
import {
  createRememberedRule,
  listRememberedRules,
  revokeRememberedRule,
} from "../governance/rules.ts";
import type { AegisHostRuntime } from "../runtime/harness.ts";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  constantTimeTokenMatch,
  createWebSession,
  isAllowedHostForProfile,
  isAllowedOriginForProfile,
  LoginRateLimiter,
  MAX_SESSION_TTL_MS,
  parseCookieHeader,
  revokeWebSession,
  sessionCookieNameFor,
  validateMobileHttpsConfig,
  validateWebSession,
  type AuthSession,
  type MobileHttpsConfig,
} from "./auth.ts";
import { ConversationProjectionHub } from "./projection.ts";
import { readStaticDistFile, STAGE2_CONSOLE_CSP } from "./static.ts";
import { renderMinimalView1Html } from "./view1.ts";

export interface ConnectorReadOnlyStatus {
  gmail: {
    configured: boolean;
    adapterKind: "host_adapter";
    imapMode: string | null;
    imapHost: string | null;
    mailbox: string | null;
    smtpConfigured: boolean;
    smtpTlsMode: string | null;
    smtpHost: string | null;
    readScope: string;
    writePolicy: string;
  };
  githubMcp: {
    configured: boolean;
    adapterKind: "mcp_stdio";
    serverId: string | null;
    connected: boolean;
    admissionPaused: boolean;
    readOnlyMode: boolean;
    binarySha256Prefix: string | null;
    writeAllowlistCount: number;
    writeAllowlistSummary: Array<{
      repoId: string;
      operations: string[];
      allowedRefs: string[];
      allowedPaths: string[];
      tier: 0 | 2;
    }>;
  };
  models: Array<{
    slotName: string;
    provider: string;
    modelId: string;
    baseUrl: string;
    priceVersion: string;
    outboundAuthorized: boolean;
  }>;
}

export interface WebServerConfig {
  host: AegisHostRuntime;
  bindHost?: string;
  port?: number;
  /** UI profile: "stage1" serves minimal View 1 HTML; "stage2" serves built Vite+React+Tailwind web/dist. */
  uiMode?: "stage1" | "stage2";
  /** Directory containing built frontend assets (defaults to web/dist in stage2). */
  webDistDir?: string;
  /** Optional explicit Mobile HTTPS profile (__Host- Secure cookie + exact trusted HTTPS Origin). */
  mobileHttps?: MobileHttpsConfig;
  /** Single principal console token (bound server-side to defaultPrincipalId). */
  consoleToken?: string;
  /** Host-bound map of principalId -> console secret token (G1: client cannot choose principalId). */
  consoleTokens?: Record<string, string>;
  defaultPrincipalId?: string;
  now?: () => number;
  maxSseHistory?: number;
  maxSseClientQueue?: number;
  /** Explicit test-only seam for E02 real process kill before T2 commit. */
  injectBeforeT2Commit?: () => void;
  /** Read-only connector status provider for View ② (NEVER returns secrets). */
  getConnectorsStatus?: () => ConnectorReadOnlyStatus;
  /** Connectivity test hooks for View ② (read-only probes, zero emails sent or repo writes). */
  testGmailConnectivity?: (principalId: string) => Promise<{
    imap: { ok: boolean; tlsVerified?: boolean; message: string };
    smtp: { ok: boolean; tlsVerified?: boolean; message: string };
  }>;
  testGithubMcpConnectivity?: () => Promise<{
    ok: boolean;
    code: string;
    message: string;
    approvedTools: string[];
    quarantinedTools: Array<{ name: string; code: string; reason: string }>;
  }>;
  recheckMcpPins?: () => Promise<{
    approvedTools: string[];
    quarantinedTools: Array<{ name: string; code: string; reason: string }>;
    missingQuarantinedTools: string[];
  }>;
  /** Optional extra snapshot augmentor (wired by Week 2 capabilities: sources, file imports). */
  augmentSnapshot?: (params: {
    principalId: string;
    runtimeEpoch: string;
    conversationId: string;
  }) => Record<string, unknown>;
}

export interface RunningWebServer {
  server: ServerType;
  port: number;
  baseUrl: string;
  projectionHub: ConversationProjectionHub<Record<string, unknown>>;
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
  const uiMode = config.uiMode ?? "stage1";
  const webDistDir = path.resolve(config.webDistDir ?? "web/dist");
  const mobileHttps = validateMobileHttpsConfig(config.mobileHttps);
  const cookieName = sessionCookieNameFor(mobileHttps.enabled);

  // Refuse non-loopback bind unless explicit validated mobile HTTPS profile is configured
  if (bindHost !== "127.0.0.1" && bindHost !== "::1" && bindHost !== "localhost") {
    if (!mobileHttps.enabled) {
      throw new Error(`Refusing non-loopback Web bind address without validated mobile HTTPS profile: ${bindHost}`);
    }
  }

  // G1: Build host-bound principal credentials map; refuse startup if no token configured!
  const defaultPrincipalId = config.defaultPrincipalId ?? "owner";
  const principalCredentials: Array<{ principalId: string; token: string }> = [];
  if (config.consoleTokens) {
    for (const [principalId, token] of Object.entries(config.consoleTokens)) {
      if (principalId.trim().length > 0 && typeof token === "string" && token.length > 0) {
        principalCredentials.push({ principalId: principalId.trim(), token });
      }
    }
  }
  if (typeof config.consoleToken === "string" && config.consoleToken.length > 0) {
    if (!principalCredentials.some((c) => c.principalId === defaultPrincipalId)) {
      principalCredentials.push({ principalId: defaultPrincipalId, token: config.consoleToken });
    }
  }
  if (principalCredentials.length === 0) {
    throw new Error("Refusing to start Web server: console token is required (no default fallback allowed)");
  }

  const nowFn = config.now ?? (() => Date.now());
  const rateLimiter = new LoginRateLimiter(20, 60_000);
  let boundPort = config.port ?? 4310;

  function verifyConversationAccess(targetEpoch: string, convIdStr: string, principalId: string): boolean {
    const convScope = config.host.govDb
      .prepare(
        "SELECT scope_id, principal_id FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?",
      )
      .get(targetEpoch, convIdStr) as { scope_id: string; principal_id: string } | undefined;
    if (!convScope || convScope.principal_id !== principalId) {
      return false;
    }
    const scope = config.host.govDb
      .prepare("SELECT * FROM scopes WHERE scope_id = ?")
      .get(convScope.scope_id) as ScopeRow | undefined;
    return Boolean(scope && isPrincipalAuthorizedForScope(scope, principalId));
  }

  function verifyActiveEpochConversationAccess(convIdStr: string, principalId: string): boolean {
    return verifyConversationAccess(config.host.runtimeEpoch, convIdStr, principalId);
  }

  /**
   * Builds the authoritative conversation snapshot scoped strictly to (targetEpoch, conversationId).
   * R3/G1: Enforces epoch-scoped conversation ACLs; live Pi transcript is read ONLY for the active epoch.
   * G3: Plaintext approval nonce is NEVER included here (only hasChallenge).
   */
  async function buildAuthoritativeSnapshot(params: {
    principalId: string;
    runtimeEpoch: string;
    conversationId: string;
  }): Promise<Record<string, unknown> | null> {
    const activeEpoch = config.host.runtimeEpoch;
    const targetEpoch = params.runtimeEpoch;
    const convIdStr = params.conversationId;
    const principalId = params.principalId;

    const convScope = config.host.govDb
      .prepare(
        "SELECT scope_id, principal_id, runtime_epoch FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?",
      )
      .get(targetEpoch, convIdStr) as { scope_id: string; principal_id: string; runtime_epoch: string } | undefined;
    if (!convScope || convScope.principal_id !== principalId) {
      return null;
    }
    const scope = config.host.govDb
      .prepare("SELECT * FROM scopes WHERE scope_id = ?")
      .get(convScope.scope_id) as ScopeRow | undefined;
    if (!scope || !isPrincipalAuthorizedForScope(scope, principalId)) {
      return null;
    }

    const now = nowFn();
    const boundTask = config.host.getConversationBudgetTaskId(convIdStr, targetEpoch);
    const relatedConvIds = new Set<string>([convIdStr]);
    if (boundTask) {
      const boundRows = config.host.govDb
        .prepare(
          `SELECT DISTINCT conversation_id FROM budget_task_bindings
            WHERE runtime_epoch = ? AND owner_task_id = ?`,
        )
        .all(targetEpoch, boundTask) as Array<{ conversation_id: string }>;
      for (const br of boundRows) relatedConvIds.add(br.conversation_id);
    }

    const isWorkerConversation = Boolean(
      config.host.govDb
        .prepare(
          `SELECT 1 AS ok FROM budget_task_bindings
            WHERE runtime_epoch = ? AND binding_kind = 'CONVERSATION' AND binding_key = ? AND purpose = 'worker'`,
        )
        .get(targetEpoch, convIdStr),
    );

    // W2-S2: Re-verify live source_read_grants for every recorded source across this conversation AND related
    // parent/worker conversations (plus recursive parents) BEFORE projecting proposals, messages, drafts, or livePartial!
    const rawSources = listConversationSources(config.host.govDb, targetEpoch, convIdStr);
    const authorizedSources: typeof rawSources = [];
    let revokedSourceCount = 0;
    const checkedSourceIds = new Set<string>();
    for (const s of rawSources) {
      checkedSourceIds.add(s.record_id);
      const stillOk = checkRecordedSourceReadStillAuthorized(config.host.govDb, {
        principalId,
        scopeId: convScope.scope_id,
        source: s,
      });
      if (stillOk.ok) {
        authorizedSources.push(s);
      } else {
        revokedSourceCount++;
      }
    }
    for (const relCid of relatedConvIds) {
      if (relCid === convIdStr) continue;
      for (const rs of listConversationSources(config.host.govDb, targetEpoch, relCid)) {
        if (checkedSourceIds.has(rs.record_id)) continue;
        checkedSourceIds.add(rs.record_id);
        const stillOk = checkRecordedSourceReadStillAuthorized(config.host.govDb, {
          principalId,
          scopeId: convScope.scope_id,
          source: rs,
        });
        if (!stillOk.ok) {
          revokedSourceCount++;
        }
      }
    }

    const proposalRows = config.host.govDb
      .prepare(
        `SELECT * FROM proposals
          WHERE runtime_epoch = ? AND conversation_id = ?
          ORDER BY created_at ASC`,
      )
      .all(targetEpoch, convIdStr) as unknown as ProposalRow[];

    const proposals = proposalRows.map((p) => {
      const draft = config.host.govDb
        .prepare("SELECT * FROM draft_revisions WHERE proposal_id = ? AND revision = ?")
        .get(p.proposal_id, p.head_rev) as unknown as DraftRevisionRow;
      const apr = config.host.govDb
        .prepare("SELECT * FROM approvals WHERE proposal_id = ? AND revision = ?")
        .get(p.proposal_id, p.head_rev) as unknown as ApprovalRow;
      const isExpiredNow = apr.state === "EXPIRED" || (apr.state === "PENDING" && now >= apr.expires_at);
      const effectiveApprovalState = isExpiredNow && apr.state === "PENDING" ? "EXPIRED" : apr.state;
      const hasChallenge =
        effectiveApprovalState === "PENDING" &&
        Boolean(
          config.host.govDb
            .prepare("SELECT 1 AS ok FROM approval_challenges WHERE approval_id = ?")
            .get(apr.approval_id),
        );
      const effect = config.host.govDb
        .prepare("SELECT * FROM effects WHERE approval_id = ?")
        .get(apr.approval_id) as EffectRow | undefined;

      const safeDraftSnapshot =
        revokedSourceCount > 0
          ? { redacted: true, reason: "redacted_after_source_revocation" }
          : (JSON.parse(draft.canonical_snapshot) as Record<string, unknown>);

      return {
        proposalId: p.proposal_id,
        runtimeEpoch: p.runtime_epoch,
        conversationId: p.conversation_id,
        toolTaskId: p.tool_task_id,
        callId: p.call_id,
        toolName: p.tool_name,
        target: revokedSourceCount > 0 ? "[redacted_after_source_revocation]" : p.target,
        revision: p.head_rev,
        actionHash: draft.action_hash,
        snapshot: safeDraftSnapshot,
        draftRedacted: revokedSourceCount > 0,
        approvalId: apr.approval_id,
        approvalState: effectiveApprovalState,
        expiresAt: apr.expires_at,
        expired: isExpiredNow,
        hasChallenge,
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
        uiStatusLabel: uiStatusLabelFor(effectiveApprovalState, effect?.state ?? null),
      };
    });

    const chatCommandRows = listChatCommandsForConversation(config.host.govDb, targetEpoch, convIdStr);
    const chatCommands = chatCommandRows.map((c) => ({
      commandId: c.command_id,
      chatKey: c.chat_key,
      piRequestId: c.pi_request_id,
      submissionId: c.submission_id,
      status: c.status,
      reason: c.reason,
      contentPreview:
        revokedSourceCount > 0 && isWorkerConversation
          ? "[restricted_content_redacted_after_source_revocation]"
          : c.content_preview,
      uiStatusLabel: chatCommandUiStatusLabel(c.status),
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));

    const reservations = (
      boundTask
        ? config.host.govDb
            .prepare(
              `SELECT * FROM budget_reservations
                WHERE runtime_epoch = ? AND (conversation_id = ? OR owner_task_id = ?)
                ORDER BY reserved_at ASC`,
            )
            .all(targetEpoch, convIdStr, boundTask)
        : config.host.govDb
            .prepare(
              `SELECT * FROM budget_reservations
                WHERE runtime_epoch = ? AND conversation_id = ?
                ORDER BY reserved_at ASC`,
            )
            .all(targetEpoch, convIdStr)
    ) as unknown as BudgetReservationRow[];

    const visibleAccountIds = new Set<string>();
    if (boundTask) visibleAccountIds.add(`acct:task:${boundTask}`);
    for (const r of reservations) {
      visibleAccountIds.add(r.task_account);
      visibleAccountIds.add(r.day_account);
    }
    const allAccounts = config.host.govDb
      .prepare("SELECT * FROM budget_accounts ORDER BY account_id ASC")
      .all() as unknown as BudgetAccountRow[];
    const accounts = allAccounts.filter((a) => visibleAccountIds.has(a.account_id));

    const budgetDenials = listBudgetDenialsForConversation(config.host.govDb, convIdStr, targetEpoch);

    // R3/G1: ONLY read live Pi trace DB when inspecting the ACTIVE epoch!
    const isActiveEpoch = targetEpoch === activeEpoch;
    const live = isActiveEpoch
      ? await config.host.readConversationLiveState(convIdStr)
      : { messages: [], livePartial: null, activeTools: [], workerTasks: [] };

    const sources = authorizedSources.map((s) => ({
      recordId: s.record_id,
      sourceType: s.source_type,
      sourceId: s.source_id,
      versionRef: s.version_ref,
      title: s.title,
      contentDigest: s.content_digest,
      metadata: JSON.parse(s.metadata_json) as Record<string, unknown>,
      parentSourceIds: JSON.parse(s.parent_source_ids_json) as string[],
      createdAt: s.created_at,
    }));

    // W2-S2: Redact assistant/tool outputs AND derived role=user inputs on delegated Worker conversations!
    const safeMessages =
      revokedSourceCount > 0
        ? live.messages.map((m) =>
            m.role === "user" && !isWorkerConversation
              ? m
              : {
                  ...m,
                  content: "[restricted_content_redacted_after_source_revocation]",
                },
          )
        : live.messages;
    const safeLivePartial = revokedSourceCount > 0 ? null : live.livePartial;
    const safeWorkerTasks =
      revokedSourceCount > 0
        ? live.workerTasks.map((w) => ({ ...w, summary: "[redacted_after_source_revocation]" }))
        : live.workerTasks;

    const fileImports = listManagedFileImportsForConversation(
      config.host.govDb,
      targetEpoch,
      [...relatedConvIds],
    ).map((f) => ({
      importId: f.import_id,
      logicalKey: f.logical_key,
      targetRelPath: f.target_rel_path,
      baseSha256: f.base_sha256,
      artifactSha256: f.artifact_sha256,
      artifactBytes: f.artifact_bytes,
      volumeName: f.volume_name,
      state: f.state,
      conflictRelPath: f.conflict_rel_path,
      installCount: f.install_count,
      reason: f.reason,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    }));

    const extra = config.augmentSnapshot
      ? config.augmentSnapshot({ principalId, runtimeEpoch: targetEpoch, conversationId: convIdStr })
      : {};

    return {
      conversationId: convIdStr,
      scopeId: convScope.scope_id,
      runtimeEpoch: targetEpoch,
      activeRuntimeEpoch: activeEpoch,
      isActiveEpoch,
      health: config.host.health,
      proposals,
      chatCommands,
      sources,
      revokedSourceCount,
      fileImports,
      budgetAccounts: accounts,
      budgetReservations: reservations,
      budgetDenials,
      messages: safeMessages,
      livePartial: safeLivePartial,
      activeTools: live.activeTools,
      workerTasks: safeWorkerTasks,
      streamMetrics: isActiveEpoch ? config.host.getLastStreamMetrics(convIdStr) : null,
      ...extra,
    };
  }

  const projectionHub = new ConversationProjectionHub<Record<string, unknown>>({
    buildSnapshot: buildAuthoritativeSnapshot,
    getRevocationWatermark: ({ principalId, runtimeEpoch, conversationId }) => {
      const convScopeRow = config.host.govDb
        .prepare("SELECT scope_id FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?")
        .get(runtimeEpoch, conversationId) as { scope_id: string } | undefined;
      const scopeId = convScopeRow?.scope_id ?? "scope:default";
      return getSourceReadRevocationWatermark(config.host.govDb, principalId, scopeId);
    },
    attachPiObserver: async ({ runtimeEpoch, conversationId, onUpdate, onEnd }) => {
      // Only attach live Pi observer for the active epoch
      if (runtimeEpoch !== config.host.runtimeEpoch) {
        return null;
      }
      return await config.host.attachConversationObserver({
        conversationId,
        onUpdate,
        onEnd,
      });
    },
    maxHistory: config.maxSseHistory ?? 200,
    maxClientQueue: config.maxSseClientQueue ?? 32,
    now: nowFn,
  });

  // Subscribe host runtime changes so background worker completions and governance mutations push into projections
  const offHostChanges = config.host.onConversationChange((ev) => {
    void projectionHub.notifyConversationChanged({
      runtimeEpoch: config.host.runtimeEpoch,
      conversationId: ev.conversationId,
      reason: ev.kind,
      detail: ev.detail,
    });
  });

  const app = new Hono<{ Variables: { authSession: AuthSession } }>();

  // Host & Origin guard middleware
  app.use("*", async (c, next) => {
    const hostHeader = c.req.header("host");
    if (!isAllowedHostForProfile(hostHeader, boundPort, mobileHttps)) {
      return c.json({ error: "invalid_host" }, 403);
    }
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const origin = c.req.header("origin");
      if (!isAllowedOriginForProfile(origin, boundPort, mobileHttps)) {
        return c.json({ error: "invalid_origin" }, 403);
      }
    }
    await next();
  });

  app.get("/", (c) => {
    if (uiMode === "stage2") {
      const idx = readStaticDistFile(webDistDir, "index.html");
      if (idx.ok) {
        c.header("content-security-policy", STAGE2_CONSOLE_CSP);
        c.header("x-content-type-options", "nosniff");
        return c.body(new Uint8Array(idx.body), 200, { "content-type": idx.contentType });
      }
      return c.text("Stage 2 frontend build (web/dist/index.html) not found. Run npm --prefix web run build.", 503);
    }
    c.header(
      "content-security-policy",
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'self'",
    );
    return c.html(renderMinimalView1Html());
  });

  app.get("/assets/*", (c) => {
    if (uiMode !== "stage2") {
      return c.text("Not found", 404);
    }
    const assetRel = c.req.path.replace(/^\/+/, "");
    const file = readStaticDistFile(webDistDir, assetRel);
    if (!file.ok) {
      return c.text("Asset not found", 404);
    }
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "public, max-age=31536000, immutable");
    return c.body(new Uint8Array(file.body), 200, { "content-type": file.contentType });
  });

  app.get("/api/health", (c) => {
    return c.json({
      health: config.host.health,
      uiMode,
      mobileHttpsEnabled: mobileHttps.enabled,
      acceptingCommands: config.host.isAcceptingCommands,
      runtimeEpoch: config.host.runtimeEpoch,
      recoveredSubmittingToUnknown: config.host.startupReport.recoveredSubmittingToUnknown,
      reconciledQuarantinedEffects: config.host.startupReport.reconciledQuarantinedEffects,
      reconciledChatCommands: config.host.startupReport.reconciledChatCommands,
      reconciledFileImports: config.host.startupReport.reconciledFileImports,
      chargedBoundReservations: config.host.startupReport.chargedBoundReservations,
      selfCheckErrors: config.host.startupReport.selfCheckErrors,
      pairedCheckOk: config.host.startupReport.pairedCheck.ok,
    });
  });

  app.post("/api/auth/login", async (c) => {
    const now = nowFn();
    if (!rateLimiter.checkAndRecord("loopback", now)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (typeof body.token !== "string" || body.token.length === 0) {
      return c.json({ error: "invalid_credentials" }, 401);
    }
    // G1: Always derive principalId strictly from host-bound credential match
    let matchedPrincipal: string | null = null;
    for (const cred of principalCredentials) {
      if (constantTimeTokenMatch(cred.token, body.token)) {
        matchedPrincipal = cred.principalId;
      }
    }
    if (!matchedPrincipal) {
      return c.json({ error: "invalid_credentials" }, 401);
    }
    const session = createWebSession(config.host.govDb, {
      principalId: matchedPrincipal,
      now,
      ttlMs: MAX_SESSION_TTL_MS,
    });
    c.header(
      "set-cookie",
      buildSessionCookie(session.rawToken, Math.floor(MAX_SESSION_TTL_MS / 1000), {
        mobileHttps: mobileHttps.enabled,
      }),
    );
    return c.json({ ok: true, principalId: matchedPrincipal, expiresAt: session.expiresAt });
  });

  // Auth middleware for all protected /api/* routes
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health" || c.req.path === "/api/auth/login") {
      await next();
      return;
    }
    const cookies = parseCookieHeader(c.req.header("cookie"));
    const session = validateWebSession(config.host.govDb, cookies[cookieName], nowFn());
    if (!session) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("authSession", session);
    await next();
  });

  app.get("/api/auth/me", (c) => {
    const session = c.get("authSession");
    return c.json({
      ok: true,
      principalId: session.principalId,
      expiresAt: session.expiresAt,
      activeRuntimeEpoch: config.host.runtimeEpoch,
      uiMode,
      mobileHttpsEnabled: mobileHttps.enabled,
    });
  });

  app.post("/api/auth/logout", (c) => {
    const session = c.get("authSession");
    revokeWebSession(config.host.govDb, session.tokenDigest, nowFn());
    projectionHub.closeStreamsForSession(session.tokenDigest);
    c.header("set-cookie", buildClearSessionCookie({ mobileHttps: mobileHttps.enabled }));
    return c.json({ ok: true });
  });

  app.get("/api/conversations", (c) => {
    const session = c.get("authSession");
    const activeEpoch = config.host.runtimeEpoch;
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
      principalId: session.principalId,
      activeRuntimeEpoch: activeEpoch,
      conversations: rows.map((r) => ({
        conversationId: r.conversation_id,
        scopeId: r.scope_id,
        principalId: r.principal_id,
        runtimeEpoch: r.runtime_epoch,
        isActiveEpoch: r.runtime_epoch === activeEpoch,
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
      scopeId?: string;
    };
    if (body.scopeId) {
      const scopeRow = config.host.govDb
        .prepare("SELECT * FROM scopes WHERE scope_id = ?")
        .get(body.scopeId) as ScopeRow | undefined;
      if (!scopeRow || !isPrincipalAuthorizedForScope(scopeRow, session.principalId)) {
        return c.json({ error: "forbidden_scope" }, 403);
      }
    }
    const conv = await config.host.createManagedConversation({
      principalId: session.principalId,
      slotName: body.slotName,
      scopeId: body.scopeId,
    });
    const budgetTaskId = config.host.getConversationBudgetTaskId(String(conv.id), config.host.runtimeEpoch);
    return c.json({
      ok: true,
      conversationId: String(conv.id),
      runtimeEpoch: config.host.runtimeEpoch,
      budgetTaskId,
    });
  });

  // V04: Idempotent cross-DB chat admission requiring explicit runtimeEpoch and chatKey
  app.post("/api/conversations/:id/chat", async (c) => {
    if (!config.host.isAcceptingCommands) {
      return c.json({ error: "host_not_ready", health: config.host.health }, 503);
    }
    const session = c.get("authSession");
    const convIdStr = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      content?: string;
      chatKey?: string;
      runtimeEpoch?: string;
    };
    if (!body.content || typeof body.content !== "string") {
      return c.json({ error: "missing_content" }, 400);
    }
    if (!body.chatKey || typeof body.chatKey !== "string" || body.chatKey.trim().length === 0) {
      return c.json({ error: "missing_chat_key" }, 400);
    }
    if (!body.runtimeEpoch || typeof body.runtimeEpoch !== "string" || body.runtimeEpoch.trim().length === 0) {
      return c.json({ error: "missing_runtime_epoch" }, 400);
    }

    const res = await config.host.submitChatCommand({
      principalId: session.principalId,
      runtimeEpoch: body.runtimeEpoch.trim(),
      conversationId: convIdStr,
      chatKey: body.chatKey.trim(),
      content: body.content,
    });

    if (res.ok) {
      await projectionHub.notifyConversationChanged({
        runtimeEpoch: config.host.runtimeEpoch,
        conversationId: convIdStr,
        reason: "chat_command",
        detail: { commandId: res.commandId, status: res.status },
      });
    }

    return c.json(
      res.ok
        ? {
            ok: true,
            code: res.code,
            idempotentReplay: Boolean(res.idempotentReplay),
            commandId: res.commandId,
            chatKey: res.chatKey,
            piRequestId: res.piRequestId,
            submissionId: res.submissionId,
            status: res.status,
            uiStatusLabel: res.uiStatusLabel,
            conversationId: convIdStr,
            runtimeEpoch: res.runtimeEpoch,
          }
        : {
            ok: false,
            error: res.code,
            code: res.code,
            message: res.message,
            commandId: res.commandId,
            status: res.status,
            uiStatusLabel: res.uiStatusLabel,
            runtimeEpoch: res.runtimeEpoch,
          },
      res.httpStatus,
    );
  });

  app.post("/api/conversations/:id/compact", async (c) => {
    if (!config.host.isAcceptingCommands) {
      return c.json({ error: "host_not_ready", health: config.host.health }, 503);
    }
    const session = c.get("authSession");
    const convIdStr = c.req.param("id");
    if (!verifyActiveEpochConversationAccess(convIdStr, session.principalId)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { instructions?: string };
    const res = await config.host.triggerCompaction({
      conversationId: convIdStr,
      instructions: body.instructions,
    });
    if (!res.ok) {
      return c.json({ error: res.code }, 404);
    }
    await projectionHub.notifyConversationChanged({
      runtimeEpoch: config.host.runtimeEpoch,
      conversationId: convIdStr,
      reason: "compaction_triggered",
    });
    return c.json({ ok: true, compactionTaskId: res.compactionTaskId, conversationId: convIdStr });
  });

  app.get("/api/conversations/:id/snapshot", async (c) => {
    const session = c.get("authSession");
    const convIdStr = c.req.param("id");
    const requestedEpoch = c.req.query("epoch");
    const targetEpoch =
      requestedEpoch && requestedEpoch.trim().length > 0 ? requestedEpoch.trim() : config.host.runtimeEpoch;
    const envelope = await projectionHub.getSnapshotAndCursor({
      principalId: session.principalId,
      runtimeEpoch: targetEpoch,
      conversationId: convIdStr,
    });
    if (!envelope) {
      return c.json({ error: "forbidden_or_not_found" }, 403);
    }
    return c.json({ ...envelope.snapshot, serverNow: nowFn() });
  });

  // G3: Dedicated authorized endpoint to fetch single-use approval challenge nonce
  app.post("/api/approvals/:id/challenge", async (c) => {
    const session = c.get("authSession");
    const approvalId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { conversationId?: string };
    if (!body.conversationId || typeof body.conversationId !== "string") {
      return c.json({ error: "missing_conversation_id" }, 400);
    }
    const res = fetchAuthorizedApprovalChallenge(config.host.govDb, {
      approvalId,
      conversationId: body.conversationId,
      principalId: session.principalId,
      now: nowFn(),
    });
    c.header("cache-control", "no-store");
    return c.json(res, res.httpStatus);
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
      expiresAt: nowFn() + (config.host.config.approvalTtlMs ?? 30 * 60 * 1000),
      now: nowFn(),
    });
    if (res.ok) {
      await projectionHub.notifyConversationChanged({
        runtimeEpoch: config.host.runtimeEpoch,
        conversationId: body.conversationId,
        reason: "draft_revision_saved",
        detail: { proposalId, revision: res.revision?.revision },
      });
    }
    const { nonce: _omitted, ...safeRes } = res;
    void _omitted;
    return c.json(safeRes, res.httpStatus);
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
      injectCrashBeforeCommit: config.injectBeforeT2Commit,
    });

    if (res.ok || res.httpStatus === 410) {
      await projectionHub.notifyConversationChanged({
        runtimeEpoch: config.host.runtimeEpoch,
        conversationId: body.conversationId,
        reason: "approval_decided",
        detail: {
          approvalId: body.approvalId,
          approvalState: res.approvalState,
          effectId: res.effectId ?? null,
        },
      });
    }
    if (res.ok) {
      void config.host.deliverPendingOutbox({ respectPause: true }).catch(() => {});
    }

    return c.json(res, res.httpStatus);
  });

  // Authorized signal re-delivery route for duplicate wakeup verification (R4 / W1-B)
  app.post("/api/approvals/:id/redeliver", async (c) => {
    if (!config.host.isAcceptingCommands) {
      return c.json({ error: "host_not_ready", health: config.host.health }, 503);
    }
    const session = c.get("authSession");
    const approvalId = c.req.param("id");
    const lineage = config.host.govDb
      .prepare(
        `SELECT p.runtime_epoch, p.scope_id, p.conversation_id
           FROM approvals a
           JOIN proposals p ON p.proposal_id = a.proposal_id
          WHERE a.approval_id = ?`,
      )
      .get(approvalId) as { runtime_epoch: string; scope_id: string; conversation_id: string } | undefined;
    if (!lineage) {
      return c.json({ error: "approval_not_found" }, 404);
    }
    const scope = config.host.govDb
      .prepare("SELECT * FROM scopes WHERE scope_id = ?")
      .get(lineage.scope_id) as ScopeRow | undefined;
    const convScope = config.host.govDb
      .prepare("SELECT principal_id FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?")
      .get(lineage.runtime_epoch, lineage.conversation_id) as { principal_id: string } | undefined;
    if (
      !scope ||
      !isPrincipalAuthorizedForScope(scope, session.principalId) ||
      (convScope && convScope.principal_id !== session.principalId)
    ) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (lineage.runtime_epoch !== config.host.runtimeEpoch) {
      return c.json({ error: "runtime_epoch_retired" }, 409);
    }
    const result = await config.host.replayApprovalSignal(approvalId);
    await projectionHub.notifyConversationChanged({
      runtimeEpoch: lineage.runtime_epoch,
      conversationId: lineage.conversation_id,
      reason: "signal_redelivered",
    });
    return c.json({ ok: true, ...result });
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
    if (res.ok) {
      await projectionHub.notifyAllActive("effect_reconciled");
    }
    return c.json(res, res.httpStatus);
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
    if (res.ok) {
      await projectionHub.notifyAllActive("scope_revoked");
    }
    return c.json(res, res.httpStatus);
  });

  app.post("/api/source-grants/:id/revoke", async (c) => {
    const session = c.get("authSession");
    const grantId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const grantRow = config.host.govDb
      .prepare("SELECT grant_id, principal_id, scope_id, revoked_at FROM source_read_grants WHERE grant_id = ?")
      .get(grantId) as
      | { grant_id: string; principal_id: string; scope_id: string; revoked_at: number | null }
      | undefined;
    if (!grantRow) {
      return c.json({ ok: false, code: "grant_not_found" }, 404);
    }
    if (grantRow.principal_id !== session.principalId) {
      return c.json({ ok: false, code: "forbidden" }, 403);
    }
    const revoked = revokeSourceReadGrant(config.host.govDb, {
      grantId,
      reason: body.reason ?? "user_revoked_source_grant",
      now: nowFn(),
    });
    await projectionHub.notifyAllActive("source_read_revoked");
    return c.json({ ok: true, revoked, grantId });
  });

  // =========================================================================
  // Stage 2 View ② / ③ / ④ Authenticated Governance & Capability Endpoints
  // =========================================================================

  app.get("/api/connectors/status", (c) => {
    if (config.getConnectorsStatus) {
      return c.json({ ok: true, status: config.getConnectorsStatus() });
    }
    const bridge =
      typeof config.host.config.githubMcpBridge === "function"
        ? config.host.config.githubMcpBridge()
        : (config.host.config.githubMcpBridge ?? null);
    const imap =
      typeof config.host.config.imapEndpoint === "function"
        ? config.host.config.imapEndpoint()
        : (config.host.config.imapEndpoint ?? null);
    const bridgeStatus = bridge?.getStatus() ?? null;
    const allowlist = config.host.config.githubWriteAllowlist ?? [];
    return c.json({
      ok: true,
      status: {
        gmail: {
          configured: Boolean(imap),
          adapterKind: "host_adapter",
          imapMode: imap?.mode ?? null,
          imapHost: imap ? `${imap.host}:${imap.port}` : null,
          mailbox: imap?.mailbox ?? null,
          smtpConfigured: Boolean(config.host.config.smtpConfig.host),
          smtpTlsMode: config.host.config.smtpConfig.tlsMode ?? "none",
          smtpHost: `${config.host.config.smtpConfig.host}:${config.host.config.smtpConfig.port}`,
          readScope: imap ? `只读 EXAMINE + BODY.PEEK (${imap.mailbox})` : "未配置",
          writePolicy: "Tier 2 逐次审批 · 唯一提交器",
        },
        githubMcp: {
          configured: Boolean(bridge),
          adapterKind: "mcp_stdio",
          serverId: bridgeStatus?.serverId ?? null,
          connected: Boolean(bridgeStatus?.connected),
          admissionPaused: Boolean(bridgeStatus?.admissionPaused),
          readOnlyMode: bridgeStatus?.readOnlyMode ?? true,
          binarySha256Prefix: bridgeStatus?.verifiedBinarySha256?.slice(0, 16) ?? null,
          writeAllowlistCount: allowlist.length,
          writeAllowlistSummary: allowlist.map((a) => ({
            repoId: a.repoId,
            operations: a.operations,
            allowedRefs: a.allowedRefs,
            allowedPaths: a.allowedPaths,
            tier: a.tier,
          })),
        },
        models: config.host.config.modelSlots.map((s) => ({
          slotName: s.slotName,
          provider: s.provider,
          modelId: s.modelId,
          baseUrl: s.baseUrl,
          priceVersion: s.priceSchedule?.priceVersion ?? "none",
          outboundAuthorized: s.outboundAuthorized,
        })),
      } satisfies ConnectorReadOnlyStatus,
    });
  });

  app.post("/api/connectors/test", async (c) => {
    const session = c.get("authSession");
    const body = (await c.req.json().catch(() => ({}))) as { connector?: "gmail" | "github_mcp" | "all" };
    const target = body.connector ?? "all";
    const result: Record<string, unknown> = { ok: true, testedAt: nowFn() };
    if (target === "gmail" || target === "all") {
      if (config.testGmailConnectivity) {
        result["gmail"] = await config.testGmailConnectivity(session.principalId);
      } else {
        result["gmail"] = {
          imap: { ok: false, message: "IMAP connector not configured" },
          smtp: { ok: false, message: "SMTP probe not configured" },
        };
      }
    }
    if (target === "github_mcp" || target === "all") {
      if (config.testGithubMcpConnectivity) {
        result["githubMcp"] = await config.testGithubMcpConnectivity();
      } else {
        const bridge =
          typeof config.host.config.githubMcpBridge === "function"
            ? config.host.config.githubMcpBridge()
            : (config.host.config.githubMcpBridge ?? null);
        result["githubMcp"] = bridge
          ? await bridge.testConnectivity()
          : { ok: false, code: "not_configured", message: "GitHub MCP bridge not configured", approvedTools: [], quarantinedTools: [] };
      }
    }
    return c.json(result);
  });

  app.get("/api/mcp/pins", (c) => {
    const servers = listMcpServerPins(config.host.govDb).map((s) => ({
      serverId: s.server_id,
      executablePath: path.basename(s.executable_path),
      executableSha256Prefix: s.executable_sha256.slice(0, 16),
      readOnlyMode: s.read_only_mode === 1,
      approvedBy: s.approved_by,
      approvedAt: s.approved_at,
    }));
    const tools = listMcpToolPins(config.host.govDb).map((t) => {
      let description = "";
      try {
        const parsed = JSON.parse(t.canonical_def_json) as { description?: string };
        description = parsed.description ?? "";
      } catch {
        description = "";
      }
      return {
        serverId: t.server_id,
        toolName: t.tool_name,
        schemaSha256: t.schema_sha256,
        description,
        state: t.state,
        reason: t.reason,
        updatedAt: t.updated_at,
      };
    });
    return c.json({ ok: true, servers, tools });
  });

  app.post("/api/mcp/pins/recheck", async (c) => {
    try {
      if (config.recheckMcpPins) {
        const res = await config.recheckMcpPins();
        return c.json({ ok: true, ...res });
      }
      const bridge =
        typeof config.host.config.githubMcpBridge === "function"
          ? config.host.config.githubMcpBridge()
          : (config.host.config.githubMcpBridge ?? null);
      if (!bridge) {
        return c.json({ ok: false, error: "mcp_not_configured" }, 404);
      }
      const res = await bridge.recheckToolPins();
      return c.json({ ok: true, ...res });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  app.post("/api/mcp/pins/:serverId/:toolName/approve", (c) => {
    const session = c.get("authSession");
    const serverId = c.req.param("serverId");
    const toolName = c.req.param("toolName");
    const res = approveStoredMcpToolPin(config.host.govDb, {
      serverId,
      toolName,
      approvedBy: session.principalId,
      now: nowFn(),
    });
    if (!res.ok) {
      return c.json({ ok: false, code: res.code, error: res.reason }, 404);
    }
    return c.json({
      ok: true,
      pin: {
        serverId: res.pin.server_id,
        toolName: res.pin.tool_name,
        schemaSha256: res.pin.schema_sha256,
        state: res.pin.state,
        updatedAt: res.pin.updated_at,
      },
    });
  });

  app.post("/api/mcp/pins/:serverId/:toolName/revoke", async (c) => {
    const serverId = c.req.param("serverId");
    const toolName = c.req.param("toolName");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const revoked = revokeMcpTool(config.host.govDb, {
      serverId,
      toolName,
      reason: body.reason ?? "revoked_by_user_in_console",
      now: nowFn(),
    });
    if (!revoked) {
      return c.json({ ok: false, error: "mcp_tool_not_found" }, 404);
    }
    return c.json({ ok: true, serverId, toolName, state: "REVOKED" });
  });

  app.get("/api/skills", (c) => {
    const skills = listSkillsIndex(config.host.govDb);
    const activeSet = computeActiveSkillSetHash(config.host.govDb);
    return c.json({
      ok: true,
      skillSetHash: activeSet.skillSetHash,
      skills,
    });
  });

  app.get("/api/skills/:skillId/body", (c) => {
    const skillId = c.req.param("skillId");
    const convId = c.req.query("conversationId");
    const verRaw = c.req.query("version");
    const res = readSkillDisclosure(config.host.govDb, {
      skillId,
      ...(convId ? { runtimeEpoch: config.host.runtimeEpoch, conversationId: convId } : {}),
      ...(verRaw && /^\d+$/.test(verRaw) ? { requestedVersion: Number(verRaw) } : {}),
    });
    if (!res.ok) {
      return c.json({ ok: false, code: res.code, error: res.reason }, res.code === "skill_not_found" ? 404 : 403);
    }
    return c.json(res);
  });

  app.post("/api/skills/:skillId/activate", async (c) => {
    const session = c.get("authSession");
    const skillId = c.req.param("skillId");
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 1) {
      return c.json({ ok: false, error: "invalid_version" }, 400);
    }
    const res = setSkillActiveVersion(config.host.govDb, {
      skillId,
      version: body.version,
      actorId: session.principalId,
      now: nowFn(),
    });
    if (!res.ok) {
      return c.json({ ok: false, code: res.code, error: res.reason }, 404);
    }
    return c.json({ ok: true, skill: res.skill });
  });

  app.post("/api/skills/:skillId/revoke", async (c) => {
    const session = c.get("authSession");
    const skillId = c.req.param("skillId");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const res = revokeSkill(config.host.govDb, {
      skillId,
      actorId: session.principalId,
      reason: body.reason ?? "revoked_by_user",
      now: nowFn(),
    });
    if (!res.ok) {
      return c.json({ ok: false, code: res.code, error: res.reason }, 404);
    }
    return c.json({ ok: true, skill: res.skill });
  });

  app.get("/api/routines", (c) => {
    const session = c.get("authSession");
    const rows = listRoutines(config.host.govDb, session.principalId);
    return c.json({
      ok: true,
      routines: rows.map((r) => ({
        routineId: r.routine_id,
        scopeId: r.scope_id,
        name: r.name,
        prompt: r.prompt,
        timezone: r.timezone,
        scheduleKind: r.schedule_kind,
        scheduleSpec: JSON.parse(r.schedule_json),
        skipCondition: r.skip_condition_json ? JSON.parse(r.skip_condition_json) : null,
        enabled: r.enabled === 1,
        nextRunUtcMs: r.next_run_utc_ms,
        nextRunLocalText: r.next_run_utc_ms ? formatUtcInTimezone(r.next_run_utc_ms, r.timezone) : null,
        lastRunUtcMs: r.last_run_utc_ms,
        lastStatus: r.last_status,
        lastResultSummary: r.last_result_summary,
        triggers: r.triggers.map((t) => ({
          triggerId: t.trigger_id,
          scheduledInstantUtc: t.scheduled_instant_utc,
          correlationKey: t.correlation_key,
          conversationId: t.conversation_id,
          state: t.state,
          reason: t.reason,
          updatedAt: t.updated_at,
        })),
      })),
    });
  });

  app.post("/api/routines/preview", async (c) => {
    const session = c.get("authSession");
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string;
      timezone?: string;
      scopeId?: string;
    };
    if (!body.text || typeof body.text !== "string" || body.text.trim().length === 0) {
      return c.json({ ok: false, error: "missing_routine_text" }, 400);
    }
    const scopeId = body.scopeId ?? config.host.config.defaultScopeId ?? "scope:default";
    const preview = parseNaturalLanguageRoutine(config.host.govDb, {
      text: body.text,
      principalId: session.principalId,
      scopeId,
      timezone: body.timezone ?? config.host.config.zone ?? DEFAULT_TIME_ZONE,
      now: nowFn(),
    });
    return c.json({ ok: true, preview });
  });

  app.post("/api/routines", async (c) => {
    const session = c.get("authSession");
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      prompt?: string;
      timezone?: string;
      scheduleSpec?: RoutineScheduleSpec;
      skipCondition?: RoutineSkipCondition | null;
      nextRunUtcMs?: number;
      confirmed?: boolean;
      rememberRule?: boolean;
      scopeId?: string;
    };
    if (!body.name || !body.prompt || !body.scheduleSpec) {
      return c.json({ ok: false, error: "invalid_routine_payload" }, 400);
    }
    const scopeId = body.scopeId ?? config.host.config.defaultScopeId ?? "scope:default";
    const scopeRow = config.host.govDb
      .prepare("SELECT * FROM scopes WHERE scope_id = ?")
      .get(scopeId) as ScopeRow | undefined;
    if (!scopeRow || !isPrincipalAuthorizedForScope(scopeRow, session.principalId)) {
      return c.json({ ok: false, error: "forbidden_scope" }, 403);
    }
    const res = createRoutineWithGovernance(config.host.govDb, {
      principalId: session.principalId,
      scopeId,
      name: body.name,
      prompt: body.prompt,
      timezone: body.timezone ?? config.host.config.zone ?? DEFAULT_TIME_ZONE,
      scheduleSpec: body.scheduleSpec,
      skipCondition: body.skipCondition ?? null,
      nextRunUtcMs: body.nextRunUtcMs,
      confirmed: body.confirmed,
      rememberRule: body.rememberRule,
      now: nowFn(),
    });
    if (!res.ok) {
      return c.json({ ok: false, code: res.code, error: res.reason }, res.httpStatus);
    }
    return c.json({
      ok: true,
      routineId: res.routine.routine_id,
      ruleUsedId: res.ruleUsedId,
      ruleCreatedId: res.ruleCreatedId,
      nextRunUtcMs: res.routine.next_run_utc_ms,
      nextRunLocalText: res.routine.next_run_utc_ms
        ? formatUtcInTimezone(res.routine.next_run_utc_ms, res.routine.timezone)
        : null,
    });
  });

  app.post("/api/routines/:id/pause", (c) => {
    const session = c.get("authSession");
    const routineId = c.req.param("id");
    const res = pauseRoutine(config.host.govDb, {
      routineId,
      principalId: session.principalId,
      now: nowFn(),
    });
    if (!res.ok) {
      return c.json({ ok: false, code: res.code, error: res.reason }, res.httpStatus);
    }
    return c.json({ ok: true, routineId, enabled: false });
  });

  app.post("/api/routines/:id/resume", async (c) => {
    const session = c.get("authSession");
    const routineId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { confirmed?: boolean };
    const res = resumeRoutine(config.host.govDb, {
      routineId,
      principalId: session.principalId,
      confirmed: body.confirmed,
      now: nowFn(),
    });
    if (!res.ok) {
      return c.json({ ok: false, code: res.code, error: res.reason }, res.httpStatus);
    }
    return c.json({
      ok: true,
      routineId,
      enabled: true,
      nextRunUtcMs: res.routine.next_run_utc_ms,
      nextRunLocalText: res.routine.next_run_utc_ms
        ? formatUtcInTimezone(res.routine.next_run_utc_ms, res.routine.timezone)
        : null,
    });
  });

  app.get("/api/approvals", (c) => {
    const session = c.get("authSession");
    const now = nowFn();
    const activeEpoch = config.host.runtimeEpoch;
    const rows = config.host.govDb
      .prepare(
        `SELECT p.*, cs.principal_id AS owner_principal
           FROM proposals p
           JOIN conversation_scopes cs
             ON cs.runtime_epoch = p.runtime_epoch AND cs.conversation_id = p.conversation_id
          WHERE p.runtime_epoch = ? AND cs.principal_id = ?
          ORDER BY p.created_at DESC
          LIMIT 100`,
      )
      .all(activeEpoch, session.principalId) as unknown as Array<ProposalRow & { owner_principal: string }>;

    const items = rows.map((p) => {
      const draft = config.host.govDb
        .prepare("SELECT * FROM draft_revisions WHERE proposal_id = ? AND revision = ?")
        .get(p.proposal_id, p.head_rev) as unknown as DraftRevisionRow;
      const apr = config.host.govDb
        .prepare("SELECT * FROM approvals WHERE proposal_id = ? AND revision = ?")
        .get(p.proposal_id, p.head_rev) as unknown as ApprovalRow;
      const effect = config.host.govDb
        .prepare("SELECT * FROM effects WHERE approval_id = ?")
        .get(apr.approval_id) as EffectRow | undefined;
      const isExpiredNow = apr.state === "EXPIRED" || (apr.state === "PENDING" && now >= apr.expires_at);
      const effectiveApprovalState = isExpiredNow && apr.state === "PENDING" ? "EXPIRED" : apr.state;
      const hasChallenge =
        effectiveApprovalState === "PENDING" &&
        Boolean(
          config.host.govDb
            .prepare("SELECT 1 AS ok FROM approval_challenges WHERE approval_id = ?")
            .get(apr.approval_id),
        );
      const autoIssuedTier0 = typeof apr.decision_key === "string" && apr.decision_key.startsWith("auto:tier0:");
      const tier = autoIssuedTier0 ? 0 : p.tool_name === "send_email" || p.tool_name === "github_write_file" ? 2 : 1;
      return {
        proposalId: p.proposal_id,
        runtimeEpoch: p.runtime_epoch,
        conversationId: p.conversation_id,
        toolName: p.tool_name,
        target: p.target,
        tier,
        autoIssuedTier0,
        revision: p.head_rev,
        actionHash: draft.action_hash,
        snapshot: JSON.parse(draft.canonical_snapshot) as Record<string, unknown>,
        approvalId: apr.approval_id,
        approvalState: effectiveApprovalState,
        expiresAt: apr.expires_at,
        expired: isExpiredNow,
        hasChallenge,
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
        uiStatusLabel: uiStatusLabelFor(effectiveApprovalState, effect?.state ?? null),
        createdAt: p.created_at,
      };
    });
    return c.json({ ok: true, runtimeEpoch: activeEpoch, serverNow: now, approvals: items });
  });

  app.get("/api/rules", (c) => {
    const session = c.get("authSession");
    const includeRevoked = c.req.query("includeRevoked") === "true";
    const rows = listRememberedRules(config.host.govDb, {
      principalId: session.principalId,
      includeRevoked,
    });
    return c.json({
      ok: true,
      rules: rows.map((r) => ({
        ruleId: r.rule_id,
        scopeId: r.scope_id,
        toolName: r.tool_name,
        tier: r.tier,
        targetPattern: r.target_pattern,
        actionSummary: r.action_summary,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
        revokeReason: r.revoke_reason,
      })),
    });
  });

  app.post("/api/rules", async (c) => {
    const session = c.get("authSession");
    const body = (await c.req.json().catch(() => ({}))) as {
      toolName?: string;
      targetPattern?: string;
      actionSummary?: string;
      ttlDays?: number;
      scopeId?: string;
    };
    if (!body.toolName || !body.targetPattern) {
      return c.json({ ok: false, error: "missing_rule_fields" }, 400);
    }
    const ttlMs = Math.max(1, Math.min(90, body.ttlDays ?? 30)) * 24 * 60 * 60 * 1000;
    const now = nowFn();
    const res = createRememberedRule(config.host.govDb, {
      principalId: session.principalId,
      scopeId: body.scopeId ?? config.host.config.defaultScopeId ?? "scope:default",
      toolName: body.toolName,
      targetPattern: body.targetPattern,
      actionSummary: body.actionSummary,
      expiresAt: now + ttlMs,
      now,
    });
    if (!res.ok) {
      return c.json({ ok: false, code: res.code, error: res.reason }, 400);
    }
    return c.json({ ok: true, rule: res.rule });
  });

  app.post("/api/rules/:id/revoke", async (c) => {
    const session = c.get("authSession");
    const ruleId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const res = revokeRememberedRule(config.host.govDb, {
      ruleId,
      principalId: session.principalId,
      reason: body.reason ?? "revoked_by_user",
      now: nowFn(),
    });
    if (!res.ok) {
      return c.json({ ok: false, code: res.code, error: res.reason }, res.httpStatus);
    }
    return c.json({ ok: true, ruleId, revokedAt: res.rule.revoked_at });
  });

  app.get("/api/memory", (c) => {
    const session = c.get("authSession");
    const query = (c.req.query("q") ?? "").trim();
    const domain = c.req.query("domain") ?? config.host.config.defaultMemoryDomain ?? "default";
    const scopeId = c.req.query("scopeId") ?? config.host.config.defaultScopeId ?? "scope:default";
    const now = nowFn();

    const l0 = freezeDomainL0Snapshot(config.host.govDb, {
      principalId: session.principalId,
      scopeId,
      domain,
      now,
    });

    let notes: Array<{
      noteId: string;
      domain: string;
      tier: string;
      title: string;
      body: string;
      version: number;
      contentDigest: string;
      createdAt: number;
    }> = [];

    if (query.length > 0) {
      const rec = recallMemory(config.host.govDb, {
        principalId: session.principalId,
        scopeId,
        domain: c.req.query("domain") ? domain : undefined,
        query,
        maxHops: 2,
        now,
      });
      if (rec.ok) {
        notes = rec.items.map((item) => ({
          noteId: item.noteId,
          domain: item.domain,
          tier: item.tier,
          title: item.title,
          body: item.body,
          version: item.version,
          contentDigest: item.contentDigest,
          createdAt: now,
        }));
      }
    } else {
      const rawRows = config.host.govDb
        .prepare(
          `SELECT * FROM memory_notes
            WHERE principal_id = ? AND scope_id = ? AND deleted_at IS NULL AND quarantined = 0
              AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY created_at DESC
            LIMIT 100`,
        )
        .all(session.principalId, scopeId, now) as unknown as MemoryNoteRow[];
      notes = rawRows.map((n) => ({
        noteId: n.note_id,
        domain: n.domain,
        tier: n.tier,
        title: n.title,
        body: n.body,
        version: n.version,
        contentDigest: n.content_digest,
        createdAt: n.created_at,
      }));
    }

    const tombstones = config.host.govDb
      .prepare(
        `SELECT t.note_id, t.deleted_at, t.reason, n.title, n.domain
           FROM memory_tombstones t
           LEFT JOIN memory_notes n ON n.note_id = t.note_id
          WHERE n.principal_id = ? OR n.principal_id IS NULL
          ORDER BY t.deleted_at DESC
          LIMIT 50`,
      )
      .all(session.principalId) as Array<{
      note_id: string;
      deleted_at: number;
      reason: string;
      title: string | null;
      domain: string | null;
    }>;

    return c.json({
      ok: true,
      l0Snapshot: {
        domain: l0.domain,
        noteCount: l0.notes.length,
        renderedText: l0.renderedText,
        snapshotDigest: sha256Hex(l0.renderedText),
      },
      notes,
      tombstones: tombstones.map((t) => ({
        noteId: t.note_id,
        title: t.title ?? t.note_id,
        domain: t.domain ?? "unknown",
        deletedAt: t.deleted_at,
        reason: t.reason,
        ftsCleaned: !Boolean(
          config.host.govDb.prepare("SELECT 1 AS ok FROM memory_notes_fts WHERE note_id = ?").get(t.note_id),
        ),
      })),
    });
  });

  app.post("/api/memory/:noteId/forget", async (c) => {
    const session = c.get("authSession");
    const noteId = c.req.param("noteId");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const existing = config.host.govDb
      .prepare("SELECT note_id, principal_id, deleted_at FROM memory_notes WHERE note_id = ?")
      .get(noteId) as { note_id: string; principal_id: string; deleted_at: number | null } | undefined;
    if (!existing) {
      return c.json({ ok: false, error: "memory_note_not_found" }, 404);
    }
    if (existing.principal_id !== session.principalId) {
      return c.json({ ok: false, error: "forbidden" }, 403);
    }
    const now = nowFn();
    deleteMemoryNoteWithTombstone(config.host.govDb, {
      noteId,
      reason: body.reason ?? "user_forgotten_in_console",
      now,
    });
    const tombstone = config.host.govDb
      .prepare("SELECT * FROM memory_tombstones WHERE note_id = ?")
      .get(noteId) as { note_id: string; deleted_at: number; reason: string } | undefined;
    const ftsRemaining = config.host.govDb
      .prepare("SELECT count(*) AS n FROM memory_notes_fts WHERE note_id = ?")
      .get(noteId) as { n: number };
    await projectionHub.notifyAllActive("memory_forgotten");
    return c.json({
      ok: true,
      noteId,
      tombstoneRecorded: Boolean(tombstone),
      deletedAt: tombstone?.deleted_at ?? now,
      ftsCleaned: ftsRemaining.n === 0,
      receipt: `tombstone:${noteId}@${tombstone?.deleted_at ?? now}`,
    });
  });

  app.get("/api/budget/summary", (c) => {
    const zone = config.host.config.zone ?? DEFAULT_TIME_ZONE;
    const today = formatChargeDay(nowFn(), zone);
    const activeEpoch = config.host.runtimeEpoch;
    const accounts = config.host.govDb
      .prepare("SELECT * FROM budget_accounts ORDER BY kind ASC, account_id ASC")
      .all() as unknown as BudgetAccountRow[];
    const reservations = config.host.govDb
      .prepare("SELECT * FROM budget_reservations WHERE runtime_epoch = ? ORDER BY reserved_at DESC LIMIT 100")
      .all(activeEpoch) as unknown as BudgetReservationRow[];

    const dayAccountId = `acct:day:${zone}:${today}`;
    const dayAccount = accounts.find((a) => a.account_id === dayAccountId) ?? null;
    const taskAccounts = accounts.filter((a) => a.kind === "TASK");

    let settledMu = 0;
    let chargedBoundMu = 0;
    let chargedBoundCount = 0;
    let heldMu = 0;
    const byPurpose: Record<string, { count: number; chargedMu: number; heldMu: number; boundMu: number }> = {};

    for (const r of reservations) {
      const bucket = byPurpose[r.purpose] ?? { count: 0, chargedMu: 0, heldMu: 0, boundMu: 0 };
      bucket.count++;
      if (r.state === "SETTLED") {
        settledMu += r.actual_mu ?? 0;
        bucket.chargedMu += r.actual_mu ?? 0;
      } else if (r.state === "CHARGED_BOUND") {
        chargedBoundMu += r.actual_mu ?? r.upper_mu;
        chargedBoundCount++;
        bucket.boundMu += r.actual_mu ?? r.upper_mu;
      } else if (r.state === "HELD") {
        heldMu += r.upper_mu;
        bucket.heldMu += r.upper_mu;
      }
      byPurpose[r.purpose] = bucket;
    }

    return c.json({
      ok: true,
      zone,
      chargeDay: today,
      runtimeEpoch: activeEpoch,
      dayAccount: dayAccount
        ? {
            accountId: dayAccount.account_id,
            limitMu: dayAccount.limit_mu,
            heldMu: dayAccount.held_mu,
            chargedMu: dayAccount.charged_mu,
            availableMu: availableMu(dayAccount),
            frozen: dayAccount.frozen === 1,
          }
        : {
            accountId: dayAccountId,
            limitMu: config.host.config.defaultDayLimitMu ?? 5_000_000,
            heldMu: 0,
            chargedMu: 0,
            availableMu: config.host.config.defaultDayLimitMu ?? 5_000_000,
            frozen: false,
          },
      taskAccounts: taskAccounts.map((a) => ({
        accountId: a.account_id,
        limitMu: a.limit_mu,
        heldMu: a.held_mu,
        chargedMu: a.charged_mu,
        availableMu: availableMu(a),
        frozen: a.frozen === 1,
      })),
      totals: {
        settledMu,
        chargedBoundMu,
        chargedBoundCount,
        heldMu,
        byPurpose,
      },
      reservations: reservations.map((r) => ({
        requestId: r.request_id,
        conversationId: r.conversation_id,
        ownerTaskId: r.owner_task_id,
        purpose: r.purpose,
        chargeDay: r.charge_day,
        upperMu: r.upper_mu,
        actualMu: r.actual_mu,
        state: r.state,
        reservedAt: r.reserved_at,
      })),
    });
  });

  // V05: Principal-, epoch-, and conversation-scoped SSE with cursor continuity & Last-Event-ID
  app.get("/api/conversations/:id/events", async (c) => {
    const session = c.get("authSession");
    const convIdStr = c.req.param("id");
    const requestedEpoch = c.req.query("epoch");
    const targetEpoch =
      requestedEpoch && requestedEpoch.trim().length > 0 ? requestedEpoch.trim() : config.host.runtimeEpoch;
    const cursorRaw = c.req.header("last-event-id") ?? c.req.query("cursor") ?? null;

    if (!verifyConversationAccess(targetEpoch, convIdStr, session.principalId)) {
      return c.json({ error: "forbidden_or_not_found" }, 403);
    }

    const subRes = await projectionHub.openSubscription({
      tokenDigest: session.tokenDigest,
      principalId: session.principalId,
      runtimeEpoch: targetEpoch,
      conversationId: convIdStr,
      cursorRaw,
    });

    if (!subRes.ok) {
      if (subRes.resyncReason === "forbidden_or_not_found") {
        return c.json({ error: "forbidden_or_not_found" }, 403);
      }
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: "resync",
          data: JSON.stringify({
            reason: subRes.resyncReason,
            streamInstanceId: subRes.streamInstanceId ?? null,
            currentSeq: subRes.currentSeq ?? null,
          }),
        });
      });
    }

    const { subscriber, unsubscribe, revocationWatermark: initialSourceRevokeWatermark } = subRes;
    const convScopeRow = config.host.govDb
      .prepare("SELECT scope_id FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?")
      .get(targetEpoch, convIdStr) as { scope_id: string } | undefined;
    const streamScopeId = convScopeRow?.scope_id ?? "scope:default";

    const isSessionAndAclStillValid = (): boolean => {
      const stillValid = config.host.govDb
        .prepare("SELECT revoked_at, expires_at FROM sessions WHERE token_digest = ?")
        .get(session.tokenDigest) as { revoked_at: number | null; expires_at: number } | undefined;
      if (!stillValid || stillValid.revoked_at !== null || nowFn() >= stillValid.expires_at) {
        return false;
      }
      return verifyConversationAccess(targetEpoch, convIdStr, session.principalId);
    };

    const hasSourceBeenRevokedSinceOpen = (): boolean => {
      const curWatermark = getSourceReadRevocationWatermark(
        config.host.govDb,
        session.principalId,
        streamScopeId,
      );
      return curWatermark !== initialSourceRevokeWatermark;
    };

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        unsubscribe();
      });
      try {
        for (;;) {
          if (!isSessionAndAclStillValid()) {
            break;
          }
          if (hasSourceBeenRevokedSinceOpen()) {
            // W2-S2: Immediately terminate old stream with 0 restricted business frames and invalidate cached projection!
            subscriber.queue.length = 0;
            projectionHub.invalidateConversation(
              { principalId: session.principalId, runtimeEpoch: targetEpoch, conversationId: convIdStr },
              "source_read_revoked",
            );
            await stream.writeSSE({
              event: "resync",
              data: JSON.stringify({ reason: "source_read_revoked" }),
            });
            return;
          }
          while (subscriber.queue.length > 0) {
            if (!isSessionAndAclStillValid()) {
              subscriber.queue.length = 0;
              return;
            }
            if (hasSourceBeenRevokedSinceOpen()) {
              subscriber.queue.length = 0;
              projectionHub.invalidateConversation(
                { principalId: session.principalId, runtimeEpoch: targetEpoch, conversationId: convIdStr },
                "source_read_revoked",
              );
              await stream.writeSSE({
                event: "resync",
                data: JSON.stringify({ reason: "source_read_revoked" }),
              });
              return;
            }
            const frame = subscriber.queue.shift()!;
            await stream.writeSSE({
              event: frame.event,
              ...(frame.id ? { id: frame.id } : {}),
              data: frame.data,
            });
            if (frame.event === "resync") {
              return;
            }
          }
          if (subscriber.closed) {
            break;
          }
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 100);
            subscriber.wake = () => {
              clearTimeout(t);
              subscriber.wake = null;
              resolve();
            };
          });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  const server = await new Promise<ServerType>((resolve, reject) => {
    const srv = serve(
      {
        fetch: app.fetch,
        hostname: bindHost,
        port: config.port ?? 4310,
      },
      (info) => {
        boundPort = info.port;
        srv.off("error", onErr);
        resolve(srv);
      },
    );
    const onErr = (err: Error): void => {
      reject(err);
    };
    srv.once("error", onErr);
  });
  if ("keepAliveTimeout" in server) {
    (server as { keepAliveTimeout: number; headersTimeout: number }).keepAliveTimeout = 65_000;
    (server as { keepAliveTimeout: number; headersTimeout: number }).headersTimeout = 66_000;
  }

  return {
    server,
    port: boundPort,
    baseUrl: `http://${bindHost}:${boundPort}`,
    projectionHub,
    close: async () => {
      offHostChanges();
      projectionHub.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
