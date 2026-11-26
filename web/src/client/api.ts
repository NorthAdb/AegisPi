export interface HealthInfo {
  health: string;
  uiMode?: string;
  mobileHttpsEnabled?: boolean;
  acceptingCommands: boolean;
  runtimeEpoch: string;
  pairedCheckOk: boolean;
}

export interface ConversationItem {
  conversationId: string;
  scopeId: string;
  principalId: string;
  runtimeEpoch: string;
  isActiveEpoch: boolean;
  createdAt: number;
}

export interface ProposalView {
  proposalId: string;
  runtimeEpoch: string;
  conversationId: string;
  toolTaskId?: string;
  callId?: string;
  toolName: string;
  target: string;
  tier?: 0 | 1 | 2;
  autoIssuedTier0?: boolean;
  revision: number;
  actionHash: string;
  snapshot: Record<string, unknown>;
  draftRedacted?: boolean;
  approvalId: string;
  approvalState: string;
  expiresAt: number;
  expired: boolean;
  hasChallenge: boolean;
  effect: {
    effectId: string;
    state: string;
    claimedAt: number | null;
    receiptRef: string | null;
    reason: string | null;
    reconciledBy: string | null;
    reconcileEvidence: string | null;
  } | null;
  uiStatusLabel: string;
  createdAt?: number;
}

export interface ConversationSnapshot {
  conversationId: string;
  scopeId: string;
  runtimeEpoch: string;
  activeRuntimeEpoch: string;
  isActiveEpoch: boolean;
  health: string;
  streamInstanceId?: string;
  seq?: number;
  cursor?: string;
  serverNow?: number;
  proposals: ProposalView[];
  chatCommands: Array<{
    commandId: string;
    chatKey: string;
    status: string;
    contentPreview: string;
    uiStatusLabel: string;
    createdAt: number;
  }>;
  sources: Array<{
    recordId: string;
    sourceType: string;
    sourceId: string;
    versionRef: string;
    title: string;
    contentDigest: string;
    metadata: Record<string, unknown>;
    createdAt: number;
  }>;
  revokedSourceCount: number;
  fileImports: Array<{
    importId: string;
    targetRelPath: string;
    state: string;
    artifactSha256: string;
    conflictRelPath: string | null;
    reason: string | null;
  }>;
  budgetAccounts: Array<{
    account_id: string;
    kind: string;
    limit_mu: number;
    held_mu: number;
    charged_mu: number;
    frozen: number;
  }>;
  budgetReservations: Array<{
    request_id: string;
    purpose: string;
    upper_mu: number;
    actual_mu: number | null;
    state: string;
    reserved_at: number;
  }>;
  budgetDenials: Array<{
    seq: number;
    occurredAt: number;
    code: string;
    message: string;
  }>;
  messages: Array<{ role: string; content: unknown }>;
  livePartial: { text: string; attempt: number } | null;
  activeTools: Array<{ callId: string; name: string; status: string }>;
  workerTasks: Array<{
    workerConversationId: string;
    parentConversationId: string;
    ownerTaskId: string;
    status: string;
    slotName: string;
    summary?: string;
    updatedAt: number;
  }>;
  streamMetrics?: {
    firstTokenMs: number | null;
    totalMs: number;
    requestId: string;
    completedAt: number;
  } | null;
}

export interface ConnectorsStatus {
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

export interface McpPinsResponse {
  servers: Array<{
    serverId: string;
    executablePath: string;
    executableSha256Prefix: string;
    readOnlyMode: boolean;
    approvedBy: string;
    approvedAt: number;
  }>;
  tools: Array<{
    serverId: string;
    toolName: string;
    schemaSha256: string;
    pinnedSchemaSha256: string;
    observedSchemaSha256: string;
    canonicalDefJson: string;
    inputSchema: Record<string, unknown> | null;
    drifted: boolean;
    description: string;
    state: "APPROVED" | "QUARANTINED" | "REVOKED";
    reason: string | null;
    updatedAt: number;
  }>;
}

export interface SkillIndexItem {
  skillId: string;
  name: string;
  summary: string;
  version: number;
  state: "ACTIVE" | "REVOKED";
  scriptCount: number;
  versions: number[];
}

export interface SkillBodyDetail {
  skillId: string;
  name: string;
  version: number;
  summary: string;
  body: string;
  bodySha256: string;
  scripts: Array<{
    scriptId: string;
    name: string;
    description: string;
    runtime: string;
    scriptSha256: string;
    reviewedBy: string;
  }>;
}

export interface RoutinePreview {
  name: string;
  prompt: string;
  timezone: string;
  scheduleKind: "once" | "daily" | "weekly";
  scheduleSpec: Record<string, unknown>;
  skipCondition: { kind: string; label: string } | null;
  nextRunUtcMs: number;
  nextRunLocalText: string;
  scopeSummary: string;
  requiresConfirmation: boolean;
  matchedRuleId: string | null;
}

export interface RoutineItem {
  routineId: string;
  scopeId: string;
  name: string;
  prompt: string;
  timezone: string;
  scheduleKind: string;
  skipCondition: { kind: string; label: string } | null;
  enabled: boolean;
  nextRunUtcMs: number | null;
  nextRunLocalText: string | null;
  lastRunUtcMs: number | null;
  lastStatus: string | null;
  lastResultSummary: string | null;
  lastConversationId: string | null;
  triggers: Array<{
    triggerId: string;
    scheduledInstantUtc: number;
    correlationKey: string;
    conversationId: string | null;
    state: string;
    reason: string | null;
    updatedAt: number;
  }>;
}

export interface RuleItem {
  ruleId: string;
  scopeId: string;
  toolName: string;
  tier: number;
  targetPattern: string;
  actionSummary: string;
  expiresAt: number;
  createdAt: number;
  revokedAt: number | null;
  revokeReason: string | null;
}

export interface MemoryResponse {
  l0Snapshot: {
    domain: string;
    noteCount: number;
    renderedText: string;
    snapshotDigest: string;
  };
  notes: Array<{
    noteId: string;
    domain: string;
    tier: string;
    title: string;
    body: string;
    version: number;
    contentDigest: string;
    createdAt: number;
  }>;
  tombstones: Array<{
    noteId: string;
    title: string;
    domain: string;
    deletedAt: number;
    reason: string;
    ftsCleaned: boolean;
  }>;
}

export interface BudgetSummary {
  zone: string;
  chargeDay: string;
  runtimeEpoch: string;
  dayAccount: {
    accountId: string;
    limitMu: number;
    heldMu: number;
    chargedMu: number;
    availableMu: number;
    frozen: boolean;
  };
  taskAccounts: Array<{
    accountId: string;
    limitMu: number;
    heldMu: number;
    chargedMu: number;
    availableMu: number;
    frozen: boolean;
  }>;
  totals: {
    settledMu: number;
    chargedBoundMu: number;
    chargedBoundCount: number;
    heldMu: number;
    byPurpose: Record<string, { count: number; chargedMu: number; heldMu: number; boundMu: number }>;
  };
  reservations: Array<{
    requestId: string;
    conversationId: string;
    ownerTaskId: string;
    purpose: string;
    chargeDay: string;
    upperMu: number;
    actualMu: number | null;
    state: string;
    reservedAt: number;
  }>;
}

export function formatMicroUsd(mu: number): string {
  const usd = mu / 1_000_000;
  return `$${usd.toFixed(4)}`;
}

export function extractPlainMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const obj = part as Record<string, unknown>;
          if (obj["type"] === "text" && typeof obj["text"] === "string") return obj["text"];
          if (obj["type"] === "toolCall") {
            return `[调用工具 ${String(obj["name"] ?? "unknown")}] ${JSON.stringify(obj["arguments"] ?? {})}`;
          }
          return JSON.stringify(obj);
        }
        return String(part ?? "");
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content, null, 2);
  }
  return String(content ?? "");
}

async function reqJson<T>(url: string, init?: RequestInit): Promise<{ status: number; data: T }> {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

export const api = {
  health: () => reqJson<HealthInfo>("/api/health"),
  me: () =>
    reqJson<{ ok: boolean; principalId?: string; activeRuntimeEpoch?: string; mobileHttpsEnabled?: boolean }>(
      "/api/auth/me",
    ),
  login: (token: string) =>
    reqJson<{ ok: boolean; principalId?: string; error?: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  logout: () => reqJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  listConversations: () =>
    reqJson<{ principalId: string; activeRuntimeEpoch: string; conversations: ConversationItem[] }>(
      "/api/conversations",
    ),
  createConversation: (slotName: "router" | "worker" = "router") =>
    reqJson<{ ok: boolean; conversationId: string; runtimeEpoch: string }>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ slotName }),
    }),
  getSnapshot: (conversationId: string, epoch?: string) =>
    reqJson<ConversationSnapshot>(
      `/api/conversations/${encodeURIComponent(conversationId)}/snapshot${epoch ? `?epoch=${encodeURIComponent(epoch)}` : ""}`,
    ),
  sendChat: (conversationId: string, params: { content: string; chatKey: string; runtimeEpoch: string }) =>
    reqJson<{
      ok: boolean;
      code?: string;
      status?: string;
      uiStatusLabel?: string;
      chatKey?: string;
      message?: string;
    }>(`/api/conversations/${encodeURIComponent(conversationId)}/chat`, {
      method: "POST",
      body: JSON.stringify(params),
    }),
  saveDraft: (
    proposalId: string,
    params: { conversationId: string; expectedHeadRev: number; target?: string; payload: Record<string, unknown> },
  ) =>
    reqJson<{
      ok: boolean;
      code?: string;
      message?: string;
      revision?: { revision: number; action_hash: string };
      approval?: { approval_id: string };
    }>(`/api/proposals/${encodeURIComponent(proposalId)}/draft`, {
      method: "POST",
      body: JSON.stringify(params),
    }),
  fetchApprovalChallenge: (approvalId: string, conversationId: string) =>
    reqJson<{ ok: boolean; nonce?: string; code?: string; message?: string }>(
      `/api/approvals/${encodeURIComponent(approvalId)}/challenge`,
      {
        method: "POST",
        body: JSON.stringify({ conversationId }),
      },
    ),
  decideApproval: (params: {
    approvalId: string;
    conversationId: string;
    decision: "APPROVE" | "REJECT";
    expectedRevision: number;
    expectedActionHash: string;
    nonce: string;
    decisionKey: string;
  }) =>
    reqJson<{
      ok: boolean;
      code?: string;
      message?: string;
      approvalState?: string;
      effectId?: string | null;
      effectState?: string | null;
    }>("/api/approvals/decide", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  reconcileEffect: (
    effectId: string,
    params: {
      conclusion: "CONFIRMED_SUCCEEDED" | "CONFIRMED_NOT_SENT" | "REMAINS_UNKNOWN";
      evidenceRef: string;
      receiptRef?: string;
    },
  ) =>
    reqJson<{ ok: boolean; code?: string; message?: string }>(
      `/api/effects/${encodeURIComponent(effectId)}/reconcile`,
      {
        method: "POST",
        body: JSON.stringify(params),
      },
    ),
  getConnectorsStatus: () => reqJson<{ ok: boolean; status: ConnectorsStatus }>("/api/connectors/status"),
  testConnectors: (connector: "gmail" | "github_mcp" | "all") =>
    reqJson<Record<string, unknown>>("/api/connectors/test", {
      method: "POST",
      body: JSON.stringify({ connector }),
    }),
  getMcpPins: () => reqJson<{ ok: boolean } & McpPinsResponse>("/api/mcp/pins"),
  recheckMcpPins: () => reqJson<{ ok: boolean; error?: string }>("/api/mcp/pins/recheck", { method: "POST" }),
  approveMcpPin: (
    serverId: string,
    toolName: string,
    params: { expectedSchemaSha256: string; expectedCanonicalDefJson?: string },
  ) =>
    reqJson<{ ok: boolean; code?: string; error?: string }>(
      `/api/mcp/pins/${encodeURIComponent(serverId)}/${encodeURIComponent(toolName)}/approve`,
      { method: "POST", body: JSON.stringify(params) },
    ),
  revokeMcpPin: (serverId: string, toolName: string, reason?: string) =>
    reqJson<{ ok: boolean; error?: string }>(
      `/api/mcp/pins/${encodeURIComponent(serverId)}/${encodeURIComponent(toolName)}/revoke`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
  listSkills: () => reqJson<{ ok: boolean; skillSetHash: string; skills: SkillIndexItem[] }>("/api/skills"),
  getSkillBody: (skillId: string) =>
    reqJson<{ ok: boolean; error?: string } & SkillBodyDetail>(
      `/api/skills/${encodeURIComponent(skillId)}/body`,
    ),
  activateSkillVersion: (skillId: string, version: number) =>
    reqJson<{ ok: boolean; error?: string }>(`/api/skills/${encodeURIComponent(skillId)}/activate`, {
      method: "POST",
      body: JSON.stringify({ version }),
    }),
  revokeSkill: (skillId: string, reason?: string) =>
    reqJson<{ ok: boolean; error?: string }>(`/api/skills/${encodeURIComponent(skillId)}/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  listRoutines: () => reqJson<{ ok: boolean; routines: RoutineItem[] }>("/api/routines"),
  previewRoutine: (text: string, timezone?: string) =>
    reqJson<{ ok: boolean; preview?: RoutinePreview; error?: string }>("/api/routines/preview", {
      method: "POST",
      body: JSON.stringify({ text, timezone }),
    }),
  createRoutine: (params: {
    name: string;
    prompt: string;
    timezone: string;
    scheduleSpec: Record<string, unknown>;
    skipCondition: { kind: string; label: string } | null;
    nextRunUtcMs: number;
    confirmed: boolean;
    rememberRule: boolean;
  }) =>
    reqJson<{ ok: boolean; routineId?: string; code?: string; error?: string }>("/api/routines", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  pauseRoutine: (routineId: string) =>
    reqJson<{ ok: boolean; error?: string }>(`/api/routines/${encodeURIComponent(routineId)}/pause`, {
      method: "POST",
    }),
  resumeRoutine: (routineId: string, confirmed: boolean) =>
    reqJson<{ ok: boolean; code?: string; error?: string }>(
      `/api/routines/${encodeURIComponent(routineId)}/resume`,
      { method: "POST", body: JSON.stringify({ confirmed }) },
    ),
  listApprovals: () =>
    reqJson<{ ok: boolean; runtimeEpoch: string; serverNow: number; approvals: ProposalView[] }>("/api/approvals"),
  listRules: () => reqJson<{ ok: boolean; rules: RuleItem[] }>("/api/rules"),
  revokeRule: (ruleId: string, reason?: string) =>
    reqJson<{ ok: boolean; error?: string }>(`/api/rules/${encodeURIComponent(ruleId)}/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  getMemory: (q?: string) =>
    reqJson<{ ok: boolean } & MemoryResponse>(q ? `/api/memory?q=${encodeURIComponent(q)}` : "/api/memory"),
  forgetMemory: (noteId: string, reason?: string) =>
    reqJson<{ ok: boolean; tombstoneRecorded?: boolean; ftsCleaned?: boolean; receipt?: string; error?: string }>(
      `/api/memory/${encodeURIComponent(noteId)}/forget`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
  getBudgetSummary: () => reqJson<{ ok: boolean } & BudgetSummary>("/api/budget/summary"),
};
