import type { DatabaseSync } from "node:sqlite";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context as AiContext,
  type Model,
  type Models,
  type ModelsSimpleStreamOptions,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  stream as openAiCompletionsStream,
  streamSimple as openAiCompletionsStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  BudgetDeniedError,
  DEFAULT_DAY_LIMIT_MU,
  DEFAULT_TASK_LIMIT_MU,
  DEFAULT_TIME_ZONE,
  releaseBudgetReservation,
  reserveBudget,
  settleBudgetReservation,
  type BudgetPurpose,
} from "../governance/budget.ts";
import { mintId } from "../governance/canonical.ts";
import {
  assertModelUrlForStage,
  Stage1EgressBlockedError,
  validateModelPriceScheduleForEndpoint,
  type HostCredentialVault,
  type ModelPriceSchedule,
  type StageEgressPolicy,
  type VerifiedModelBoundContract,
} from "../governance/credentials.ts";
import { withImmediateTx, writeAuditEvent } from "../governance/db.ts";
import { checkConversationModelDisclosure } from "../governance/policy.ts";
import type { HostPhaseTelemetry, PhaseAttribution } from "./telemetry.ts";

export interface ModelSlotConfig {
  slotName: "router" | "worker" | "compaction";
  provider: string;
  modelId: string;
  baseUrl: string;
  credentialSlotId: string;
  contextWindow: number;
  maxTokens: number;
  priceSchedule: ModelPriceSchedule | null;
  outboundAuthorized: boolean;
}

export interface ResolvedBudgetOwner {
  conversationId: string;
  ownerTaskId: string;
  purpose: BudgetPurpose;
}

export interface HostModelsConfig {
  govDb: DatabaseSync;
  getRuntimeEpoch: () => string;
  vault: HostCredentialVault;
  telemetry: HostPhaseTelemetry;
  slots: ModelSlotConfig[];
  resolveBudgetOwner: (attr: PhaseAttribution, model: Model<Api>) => ResolvedBudgetOwner | null;
  resolveConversationAuth?: (conversationId: string) => { principalId: string; scopeId: string } | null;
  now?: () => number;
  zone?: string;
  defaultTaskLimitMu?: number;
  defaultDayLimitMu?: number;
  settleTimeoutMs?: number;
  /** Test seam for B06: simulates provable pre-transport failure after reservation and before HTTP send. */
  shouldFailBeforeTransport?: (requestId: string, owner: ResolvedBudgetOwner) => string | null;
  /** Test seam for B07: injected into reserveBudget after first account update. */
  injectFaultAfterFirstAccount?: () => void;
  /** Optional observer invoked strictly before underlying HTTP transport dispatch (G2 verification). */
  onTransportDispatch?: (info: { requestId: string; baseUrl: string; provider: string; modelId: string }) => void;
  /** Optional custom underlying fetch implementation (for G2 controlled redirect/egress observation). */
  fetchImpl?: typeof globalThis.fetch;
  /** Optional observer invoked on EVERY physical HTTP fetch attempt inside Stage 1 guarded fetch. */
  onHttpFetchAttempt?: (url: string) => void;
  /** Explicit Stage 1 / Stage 2 egress policy (defaults to Stage 1 loopback-only). */
  egressPolicy?: StageEgressPolicy;
  /** Optional coalesced streaming delta observer for real-time progressive SSE projection. */
  onStreamTextDelta?: (info: {
    conversationId: string;
    ownerTaskId: string;
    requestId: string;
    delta: string;
    accumulatedText: string;
    firstTokenMs: number;
    elapsedMs: number;
  }) => void;
  onStreamFinished?: (info: {
    conversationId: string;
    ownerTaskId: string;
    requestId: string;
    firstTokenMs: number | null;
    totalMs: number;
    stopReason?: string;
    errorCode?: string | null;
  }) => void;
  onReservationRecorded?: (info: {
    requestId: string;
    ownerTaskId: string;
    conversationId: string;
    purpose: BudgetPurpose;
    upperMu: number;
    method: "streamSimple" | "completeSimple";
  }) => void;
}

function makeErrorAssistantMessage(model: Model<Api>, errorMessage: string, now: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: now,
  };
}

function createImmediateErrorStream(model: Model<Api>, errorMessage: string, now: number): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const errMsg = makeErrorAssistantMessage(model, errorMessage, now);
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error: errMsg });
    stream.end(errMsg);
  });
  return stream;
}

function hasUnboundedNonTextContent(context: AiContext): boolean {
  for (const msg of context.messages) {
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string" || content === undefined || content === null) continue;
    if (!Array.isArray(content)) return true;
    for (const block of content) {
      if (!block || typeof block !== "object") return true;
      const t = (block as { type?: unknown }).type;
      if (t !== "text" && t !== "thinking" && t !== "toolCall" && t !== "tool_use" && t !== "tool_result") {
        return true;
      }
    }
  }
  return false;
}

type HostModelTransportErrorCode =
  | "connection_refused"
  | "connection_reset"
  | "dns_lookup_failed"
  | "timeout"
  | "tls_error"
  | "aborted"
  | "transport_failed";

type ModelFetchBoundaryOutcome =
  | { kind: "http_ok" }
  | { kind: "http_error"; status: number }
  | { kind: "transport_error"; code: HostModelTransportErrorCode }
  | { kind: "egress_blocked" }
  | { kind: "wire_contract_violation" };

function mapLocalFetchTransportErrorCode(err: unknown): HostModelTransportErrorCode {
  const rec = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null | undefined;
  if (rec?.name === "AbortError") return "aborted";
  const rawCode =
    typeof rec?.code === "string"
      ? rec.code
      : typeof rec?.cause?.code === "string"
        ? rec.cause.code
        : "";
  const upper = rawCode.toUpperCase();
  if (upper === "ECONNREFUSED") return "connection_refused";
  if (upper === "ECONNRESET" || upper === "EPIPE" || upper === "UND_ERR_SOCKET") return "connection_reset";
  if (upper === "ENOTFOUND" || upper === "EAI_AGAIN") return "dns_lookup_failed";
  if (upper.includes("TIMEOUT") || upper === "ETIMEDOUT" || upper === "UND_ERR_CONNECT_TIMEOUT" || upper === "UND_ERR_HEADERS_TIMEOUT" || upper === "UND_ERR_BODY_TIMEOUT") {
    return "timeout";
  }
  if (upper.includes("CERT") || upper.includes("TLS") || upper.includes("SSL")) return "tls_error";
  if (upper === "ABORT_ERR") return "aborted";
  return "transport_failed";
}

/**
 * S2-P0-4: Authoritative host-side model error reducer.
 * Derives the error code EXCLUSIVELY from host-observed fetch status / closed host enums and stopReason —
 * NEVER inspects or extracts ANY characters from remote HTTP 200 stream bodies or remote error text!
 */
function reduceAuthoritativeModelErrorCode(
  boundaryOutcome: ModelFetchBoundaryOutcome | null,
  stopReason: string | undefined,
): string {
  if (stopReason === "aborted") {
    return "model_request_aborted";
  }
  if (!boundaryOutcome) {
    return "model_provider_error";
  }
  if (boundaryOutcome.kind === "egress_blocked") {
    return "model_egress_blocked";
  }
  if (boundaryOutcome.kind === "wire_contract_violation") {
    return "model_wire_contract_violation";
  }
  if (boundaryOutcome.kind === "http_error") {
    return `model_provider_http_${boundaryOutcome.status}`;
  }
  if (boundaryOutcome.kind === "transport_error") {
    return `model_transport_error:${boundaryOutcome.code}`;
  }
  if (boundaryOutcome.kind === "http_ok") {
    return "model_provider_stream_error";
  }
  return "model_provider_error";
}

/**
 * S2-P0-2: Computes a provable conservative integer microUSD upper bound for T6 budget reservation.
 * - Synthetic fixed pricing is STRICTLY limited to explicit `fake-local` provider on loopback endpoints.
 * - Real providers must match the verified billing contract for their provider, model and HTTPS base URL.
 * - Uses the provider's published hard context window limit (`contract.publishedContextWindowTokens`) as the
 *   provable conservative input token upper bound (zero fragile tokenizer or framing guesswork!) plus explicit
 *   wire-enforced `effectiveMaxTokens <= contract.maxTokensHardCeiling`, priced at or above the contract's
 *   verified Peak / Cache-Miss rate floor.
 */
function estimateUpperBoundMu(
  context: AiContext,
  model: Model<Api>,
  schedule: ModelPriceSchedule | null,
  effectiveBaseUrl: string,
  effectiveMaxTokens: number,
  reasoningOption?: unknown,
): { upperMu: number; contract: VerifiedModelBoundContract | null } | null {
  const scheduleCheck = validateModelPriceScheduleForEndpoint(effectiveBaseUrl, schedule, {
    provider: model.provider,
    modelId: model.id,
  });
  if (!scheduleCheck.ok || !schedule) return null;

  if (
    scheduleCheck.isExplicitFake &&
    typeof schedule.syntheticFixedUpperMu === "number" &&
    Number.isSafeInteger(schedule.syntheticFixedUpperMu) &&
    schedule.syntheticFixedUpperMu >= 0
  ) {
    return { upperMu: schedule.syntheticFixedUpperMu, contract: null };
  }
  if (!schedule.allowTokenBoundEstimation) {
    return null;
  }
  const contract = scheduleCheck.contract;
  if (!contract) {
    // Explicit fake-local without syntheticFixedUpperMu OR any unproven model MUST fail closed!
    return null;
  }
  if (
    !Number.isSafeInteger(effectiveMaxTokens) ||
    effectiveMaxTokens <= 0 ||
    effectiveMaxTokens > contract.maxTokensHardCeiling ||
    !Number.isFinite(model.contextWindow) ||
    model.contextWindow <= 0 ||
    model.contextWindow > contract.publishedContextWindowTokens
  ) {
    return null;
  }
  if (
    contract.requiredWireThinkingMode === "disabled" &&
    reasoningOption !== undefined &&
    reasoningOption !== null &&
    reasoningOption !== "off"
  ) {
    return null;
  }
  if (
    reasoningOption !== undefined &&
    reasoningOption !== null &&
    reasoningOption !== "off" &&
    !contract.maxTokensIncludesReasoning
  ) {
    return null;
  }
  if (!contract.supportsNonTextInput && hasUnboundedNonTextContent(context)) {
    return null;
  }

  // Provable conservative input upper bound = provider's published hard context window limit!
  const provableMaxInputTokens = contract.publishedContextWindowTokens;
  const provableMaxOutputTokens = effectiveMaxTokens;

  const maxInputRateMu = Math.max(
    schedule.inputPerMTokMu,
    schedule.cacheReadPerMTokMu ?? 0,
    schedule.cacheWritePerMTokMu ?? 0,
    contract.minInputPerMTokMu,
    contract.minCacheReadPerMTokMu,
    contract.minCacheWritePerMTokMu,
  );
  const maxOutputRateMu = Math.max(schedule.outputPerMTokMu, contract.minOutputPerMTokMu);
  const inputUpperMu = Math.ceil((provableMaxInputTokens * maxInputRateMu) / 1_000_000);
  const outputUpperMu = Math.ceil((provableMaxOutputTokens * maxOutputRateMu) / 1_000_000);
  const totalUpperMu = Math.max(1, inputUpperMu + outputUpperMu);
  if (!Number.isSafeInteger(totalUpperMu) || totalUpperMu <= 0) {
    return null;
  }
  return { upperMu: totalUpperMu, contract };
}

function validateOutgoingWireRequestForContract(
  rawBody: string | undefined,
  expectedModelId: string,
  expectedMaxTokens: number,
  contract: VerifiedModelBoundContract,
): { ok: true } | { ok: false; code: string } {
  if (typeof rawBody !== "string" || rawBody.trim().length === 0) {
    return { ok: false, code: "wire_missing_json_body" };
  }
  let parsed: Record<string, unknown>;
  try {
    const val = JSON.parse(rawBody);
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      return { ok: false, code: "wire_invalid_json_body" };
    }
    parsed = val as Record<string, unknown>;
  } catch {
    return { ok: false, code: "wire_invalid_json_body" };
  }
  if (parsed["model"] !== expectedModelId) {
    return { ok: false, code: "wire_model_mismatch" };
  }
  const wireMaxTokens = parsed["max_tokens"];
  if (
    typeof wireMaxTokens !== "number" ||
    !Number.isSafeInteger(wireMaxTokens) ||
    wireMaxTokens <= 0 ||
    wireMaxTokens > expectedMaxTokens
  ) {
    return { ok: false, code: "wire_max_tokens_mismatch" };
  }
  if (contract.requiredWireThinkingMode === "disabled") {
    const thinking = parsed["thinking"];
    if (
      !thinking ||
      typeof thinking !== "object" ||
      Array.isArray(thinking) ||
      (thinking as Record<string, unknown>)["type"] !== "disabled"
    ) {
      return { ok: false, code: "wire_thinking_disabled_required" };
    }
    if (parsed["reasoning_effort"] !== undefined) {
      return { ok: false, code: "wire_reasoning_effort_forbidden" };
    }
  }
  return { ok: true };
}

function computeActualMu(
  msg: AssistantMessage,
  schedule: ModelPriceSchedule,
  effectiveBaseUrl: string,
  model: Model<Api>,
): number | null {
  const scheduleCheck = validateModelPriceScheduleForEndpoint(effectiveBaseUrl, schedule, {
    provider: model.provider,
    modelId: model.id,
  });
  if (!scheduleCheck.ok) return null;
  const u = msg.usage;
  if (!u) return null;
  const totalTok = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  if (totalTok <= 0) return null;
  if (
    scheduleCheck.isExplicitFake &&
    schedule.syntheticFixedActualMu !== undefined &&
    schedule.syntheticFixedActualMu !== null
  ) {
    return schedule.syntheticFixedActualMu;
  }
  const cacheReadRate = schedule.cacheReadPerMTokMu ?? schedule.inputPerMTokMu;
  const cacheWriteRate = schedule.cacheWritePerMTokMu ?? schedule.inputPerMTokMu;
  const inputCost = ((u.input ?? 0) * schedule.inputPerMTokMu) / 1_000_000;
  const cacheReadCost = ((u.cacheRead ?? 0) * cacheReadRate) / 1_000_000;
  const cacheWriteCost = ((u.cacheWrite ?? 0) * cacheWriteRate) / 1_000_000;
  const outputCost = ((u.output ?? 0) * schedule.outputPerMTokMu) / 1_000_000;
  return Math.max(1, Math.ceil(inputCost + cacheReadCost + cacheWriteCost + outputCost));
}

export function createGuardedModelFetch(
  underlyingFetch: typeof globalThis.fetch = globalThis.fetch,
  onHttpFetchAttempt?: (url: string) => void,
  egressPolicy?: StageEgressPolicy,
  hooks?: {
    wireValidator?: (rawBody: string | undefined) => { ok: true } | { ok: false; code: string };
    onBoundaryOutcome?: (outcome: ModelFetchBoundaryOutcome) => void;
  },
): typeof globalThis.fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    try {
      assertModelUrlForStage(rawUrl, egressPolicy);
    } catch (err) {
      hooks?.onBoundaryOutcome?.({ kind: "egress_blocked" });
      throw err;
    }
    if (hooks?.wireValidator) {
      const bodyStr = typeof init?.body === "string" ? init.body : undefined;
      const wireCheck = hooks.wireValidator(bodyStr);
      if (!wireCheck.ok) {
        hooks.onBoundaryOutcome?.({ kind: "wire_contract_violation" });
        throw new Error(`model_wire_contract_violation:${wireCheck.code}`);
      }
    }
    onHttpFetchAttempt?.(rawUrl);
    const guardedInit: RequestInit = {
      ...init,
      redirect: "manual",
    };
    let response: Response;
    try {
      response = await underlyingFetch(input, guardedInit);
    } catch (err) {
      if (err instanceof Stage1EgressBlockedError) {
        hooks?.onBoundaryOutcome?.({ kind: "egress_blocked" });
        throw err;
      }
      const code = mapLocalFetchTransportErrorCode(err);
      hooks?.onBoundaryOutcome?.({ kind: "transport_error", code });
      throw new Error(`model_transport_error:${code}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "(missing)";
      void response.body?.cancel().catch(() => {});
      hooks?.onBoundaryOutcome?.({ kind: "egress_blocked" });
      throw new Stage1EgressBlockedError(
        location,
        `Model egress blocks HTTP ${response.status} redirect from ${rawUrl} to ${location}`,
      );
    }
    // S2-P0-4: NEVER forward arbitrary remote HTTP error bodies into pi-ai errorMessage!
    // Cancel raw remote body immediately and substitute a controlled HTTP status JSON payload.
    if (!response.ok) {
      const status = Number.isInteger(response.status) ? response.status : 500;
      void response.body?.cancel().catch(() => {});
      hooks?.onBoundaryOutcome?.({ kind: "http_error", status });
      return new Response(
        JSON.stringify({
          error: {
            message: `model_provider_http_${status}`,
            type: "model_provider_http_error",
            code: `model_provider_http_${status}`,
          },
        }),
        {
          status,
          statusText: `HTTP ${status}`,
          headers: { "content-type": "application/json" },
        },
      );
    }
    hooks?.onBoundaryOutcome?.({ kind: "http_ok" });
    return response;
  };
}

/**
 * Stage 1 guarded HTTP fetch transport passed directly into pi-ai's OpenAI client.
 * Preserved with identical Stage 1 loopback-only semantics.
 */
export function createStage1GuardedFetch(
  underlyingFetch: typeof globalThis.fetch = globalThis.fetch,
  onHttpFetchAttempt?: (url: string) => void,
): typeof globalThis.fetch {
  return createGuardedModelFetch(underlyingFetch, onHttpFetchAttempt, { stage: 1 });
}

export interface HostModelsController {
  models: Models;
  isWrappedEgress: true;
  updateSlots: (slots: ModelSlotConfig[]) => void;
}

let cachedBuiltinProviders: Map<string, Provider> | null = null;

function getBuiltinProviderById(providerId: string): Provider | undefined {
  if (!cachedBuiltinProviders) {
    cachedBuiltinProviders = new Map(builtinProviders().map((p) => [p.id, p]));
  }
  return cachedBuiltinProviders.get(providerId);
}

/**
 * Builds the unified host Models egress wrapping pi-ai Models.
 * Reuses pi-ai's built-in provider catalog & wire protocols for all known providers
 * (zero hand-maintained provider dialects), while keeping auth (HostCredentialVault),
 * endpoint/disclosure/billing admission, T6 atomic reservation, maxRetries=0, wire
 * contract verification, error reduction, and T7 settlement strictly under host control.
 */
export function createHostModelsEgress(config: HostModelsConfig): HostModelsController {
  const nowFn = config.now ?? (() => Date.now());
  const egressPolicy = config.egressPolicy ?? { stage: 1 };
  const inner = createModels();
  let slotList: ModelSlotConfig[] = [];

  const applySlots = (slots: ModelSlotConfig[]): void => {
    for (const s of slots) {
      assertModelUrlForStage(s.baseUrl, egressPolicy);
    }
    slotList = [...slots];
    inner.clearProviders();
    const byProvider = new Map<string, ModelSlotConfig[]>();
    for (const s of slots) {
      const list = byProvider.get(s.provider) ?? [];
      list.push(s);
      byProvider.set(s.provider, list);
    }

    for (const [providerId, providerSlots] of byProvider.entries()) {
      const first = providerSlots[0]!;
      const builtin = getBuiltinProviderById(providerId);
      const builtinModelsById = new Map<string, Model<Api>>(
        (builtin?.getModels() ?? []).map((m) => [m.id, m]),
      );

      const modelDefs: Model<Api>[] = providerSlots.map((s) => {
        const hostCost = s.priceSchedule
          ? {
              input: s.priceSchedule.inputPerMTokMu / 1_000_000,
              output: s.priceSchedule.outputPerMTokMu / 1_000_000,
              cacheRead: (s.priceSchedule.cacheReadPerMTokMu ?? 0) / 1_000_000,
              cacheWrite: (s.priceSchedule.cacheWritePerMTokMu ?? 0) / 1_000_000,
            }
          : undefined;
        const builtinModel = builtinModelsById.get(s.modelId);
        if (builtinModel) {
          // Reuse pi-ai's authoritative built-in model definition (api, reasoning, thinkingLevelMap, compat, headers)
          // while overriding ONLY host-governed endpoint, text-only input boundary, caps, and cost schedule.
          return {
            ...builtinModel,
            baseUrl: s.baseUrl,
            input: ["text"],
            contextWindow: s.contextWindow,
            maxTokens: s.maxTokens,
            ...(hostCost ? { cost: hostCost } : {}),
          };
        }
        return {
          id: s.modelId,
          name: `${s.provider}/${s.modelId}`,
          api: "openai-completions",
          provider: s.provider,
          baseUrl: s.baseUrl,
          reasoning: false,
          input: ["text"],
          cost: hostCost ?? { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: s.contextWindow,
          maxTokens: s.maxTokens,
        };
      });

      const hostAuth = {
        apiKey: {
          name: `host-slot:${first.credentialSlotId}`,
          resolve: async () => {
            // Inject secret strictly from host memory vault; never persisted in checkpoints or read from process.env.
            const secret = config.vault.resolveSecretInMemory(first.credentialSlotId);
            if (!secret) return undefined;
            return {
              auth: { apiKey: secret },
              source: `host-memory:${first.credentialSlotId}`,
            };
          },
        },
      };

      const usesBuiltinModels = Boolean(builtin && providerSlots.every((s) => builtinModelsById.has(s.modelId)));
      inner.setProvider(
        createProvider({
          id: providerId,
          name: builtin?.name ?? providerId,
          baseUrl: first.baseUrl,
          ...(builtin?.headers ? { headers: builtin.headers } : {}),
          auth: hostAuth,
          models: modelDefs,
          api: usesBuiltinModels && builtin
            ? {
                stream: (m, ctx, opts) => builtin.stream(m, ctx, opts),
                streamSimple: (m, ctx, opts) => builtin.streamSimple(m, ctx, opts),
              }
            : {
                stream: openAiCompletionsStream,
                streamSimple: openAiCompletionsStreamSimple,
              },
        }),
      );
    }
  };

  applySlots(config.slots);

  const findSlot = (model: Model<Api>, purpose?: BudgetPurpose): ModelSlotConfig | undefined => {
    if (purpose) {
      const exact = slotList.find(
        (s) => s.provider === model.provider && s.modelId === model.id && s.slotName === purpose,
      );
      if (exact) return exact;
    }
    return slotList.find((s) => s.provider === model.provider && s.modelId === model.id);
  };

  const recordEgressDenial = (
    requestId: string,
    code: string,
    message: string,
    extra: Record<string, unknown>,
  ): void => {
    withImmediateTx(config.govDb, () => {
      writeAuditEvent(config.govDb, {
        entityType: "budget_denial",
        entityId: requestId,
        eventKey: `deny:${requestId}`,
        eventType: "budget_denied",
        occurredAt: nowFn(),
        details: { code, message, runtimeEpoch: config.getRuntimeEpoch(), ...extra },
      });
    });
  };

  const guardedStreamSimple = (
    model: Model<Api>,
    ctx: AiContext,
    options: ModelsSimpleStreamOptions | undefined,
    entryMethod: "streamSimple" | "completeSimple",
  ): AssistantMessageEventStream => {
    const now = nowFn();
    const requestId = mintId("mreq");

    // 1. Resolve unforgeable phase attribution from HostPhaseTelemetry WeakMap
    const attr = config.telemetry.resolve(options?.telemetry);
    if (!attr) {
      const msg = `Blocked model send (${requestId}): missing trusted pi.durable.phase telemetry attribution`;
      recordEgressDenial(requestId, "unknown_budget_owner", msg, {
        provider: model.provider,
        modelId: model.id,
        entryMethod,
      });
      return createImmediateErrorStream(model, msg, now);
    }

    const owner = config.resolveBudgetOwner(attr, model);
    if (!owner) {
      const msg = `Blocked model send (${requestId}): cannot attribute task ${attr.taskId} (${attr.taskName}) to a budget owner`;
      recordEgressDenial(requestId, "unknown_budget_owner", msg, {
        piTaskId: attr.taskId,
        piTaskName: attr.taskName,
        provider: model.provider,
        modelId: model.id,
        entryMethod,
      });
      return createImmediateErrorStream(model, msg, now);
    }

    // 2. Validate model slot, outbound authorization, and credential/endpoint binding
    const slot = findSlot(model, owner.purpose);
    if (!slot) {
      const msg = `Blocked model send (${requestId}): unregistered model ${model.provider}/${model.id}`;
      recordEgressDenial(requestId, "invalid_binding", msg, {
        conversationId: owner.conversationId,
        ownerTaskId: owner.ownerTaskId,
        purpose: owner.purpose,
      });
      return createImmediateErrorStream(model, msg, now);
    }
    if (!slot.outboundAuthorized) {
      const msg = `Blocked model send (${requestId}): outbound data authorization denied for ${slot.provider}/${slot.modelId}`;
      recordEgressDenial(requestId, "outbound_denied", msg, {
        conversationId: owner.conversationId,
        ownerTaskId: owner.ownerTaskId,
        purpose: owner.purpose,
      });
      return createImmediateErrorStream(model, msg, now);
    }

    // 2b. V02 Data Disclosure re-verification on EVERY send (generation, delegation, compaction, durable retry)
    if (config.resolveConversationAuth) {
      const convAuth = config.resolveConversationAuth(owner.conversationId);
      if (convAuth) {
        const disclosureSlot = owner.purpose === "compaction" ? "compaction" : slot.slotName;
        const discCheck = checkConversationModelDisclosure(config.govDb, {
          runtimeEpoch: config.getRuntimeEpoch(),
          conversationId: owner.conversationId,
          principalId: convAuth.principalId,
          scopeId: convAuth.scopeId,
          provider: model.provider,
          modelId: model.id,
          baseUrl: model.baseUrl ?? slot.baseUrl,
          slotName: disclosureSlot,
        });
        if (!discCheck.ok) {
          const msg = `Blocked model send (${requestId}): ${discCheck.reason}`;
          recordEgressDenial(requestId, discCheck.code, msg, {
            conversationId: owner.conversationId,
            ownerTaskId: owner.ownerTaskId,
            purpose: owner.purpose,
            blockedSource: discCheck.blockedSource,
            provider: model.provider,
            modelId: model.id,
            baseUrl: model.baseUrl ?? slot.baseUrl,
            slotName: disclosureSlot,
          });
          return createImmediateErrorStream(model, msg, now);
        }
      }
    }
    const bindingCheck = config.vault.validateBinding(
      {
        slotId: slot.credentialSlotId,
        provider: model.provider,
        modelId: model.id,
        baseUrl: model.baseUrl ?? slot.baseUrl,
      },
      egressPolicy,
    );
    if (!bindingCheck.ok) {
      const msg = `Blocked model send (${requestId}): ${bindingCheck.reason}`;
      recordEgressDenial(requestId, "invalid_binding", msg, {
        conversationId: owner.conversationId,
        ownerTaskId: owner.ownerTaskId,
        purpose: owner.purpose,
        credentialSlotId: slot.credentialSlotId,
      });
      return createImmediateErrorStream(model, msg, now);
    }

    // 3. Calculate provable conservative integer microUSD upper bound (fail closed if unknown!)
    const effectiveBaseUrl = model.baseUrl ?? slot.baseUrl;
    const requestedMaxTokens =
      typeof options?.maxTokens === "number" && Number.isFinite(options.maxTokens) && options.maxTokens > 0
        ? Math.floor(options.maxTokens)
        : undefined;
    const modelMaxTokens =
      Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? Math.floor(model.maxTokens) : 0;
    const effectiveMaxTokens =
      requestedMaxTokens !== undefined && modelMaxTokens > 0
        ? Math.min(requestedMaxTokens, modelMaxTokens)
        : modelMaxTokens;
    const boundEst = estimateUpperBoundMu(
      ctx,
      model,
      slot.priceSchedule,
      effectiveBaseUrl,
      effectiveMaxTokens,
      options?.reasoning,
    );
    if (boundEst === null) {
      const msg = `Blocked model send (${requestId}): cannot determine provable conservative microUSD upper bound for ${model.provider}/${model.id}`;
      recordEgressDenial(requestId, "unknown_upper_bound", msg, {
        conversationId: owner.conversationId,
        ownerTaskId: owner.ownerTaskId,
        purpose: owner.purpose,
      });
      return createImmediateErrorStream(model, msg, now);
    }
    const { upperMu, contract } = boundEst;

    // 4. Atomic dual-account reservation (T6) strictly BEFORE any physical send
    try {
      reserveBudget(config.govDb, {
        requestId,
        runtimeEpoch: config.getRuntimeEpoch(),
        conversationId: owner.conversationId,
        ownerTaskId: owner.ownerTaskId,
        purpose: owner.purpose,
        upperMu,
        now,
        zone: config.zone ?? DEFAULT_TIME_ZONE,
        defaultTaskLimitMu: config.defaultTaskLimitMu ?? DEFAULT_TASK_LIMIT_MU,
        defaultDayLimitMu: config.defaultDayLimitMu ?? DEFAULT_DAY_LIMIT_MU,
        settleTimeoutMs: config.settleTimeoutMs ?? 300_000,
        binding: {
          provider: model.provider,
          modelId: model.id,
          baseUrl: slot.baseUrl,
          credentialSlotId: slot.credentialSlotId,
          priceVersion: slot.priceSchedule?.priceVersion ?? "unknown",
          piTaskId: attr.taskId,
          piTaskName: attr.taskName,
          entryMethod,
        },
        injectFaultAfterFirstAccount: config.injectFaultAfterFirstAccount,
      });
    } catch (err) {
      const errMsg = err instanceof BudgetDeniedError ? err.message : err instanceof Error ? err.message : String(err);
      return createImmediateErrorStream(model, errMsg, now);
    }

    config.onReservationRecorded?.({
      requestId,
      ownerTaskId: owner.ownerTaskId,
      conversationId: owner.conversationId,
      purpose: owner.purpose,
      upperMu,
      method: entryMethod,
    });

    // 5. Provable pre-transport failure check (B06): releases both holds with evidence, 0 HTTP sent!
    const preTransportErr = config.shouldFailBeforeTransport?.(requestId, owner);
    if (preTransportErr) {
      releaseBudgetReservation(config.govDb, {
        requestId,
        reason: preTransportErr,
        evidenceRef: `pre_transport_abort:${requestId}`,
        now: nowFn(),
      });
      return createImmediateErrorStream(model, `Pre-transport failure (released): ${preTransportErr}`, now);
    }

    // 6. Enforce maxRetries: 0 & explicit maxTokens ceiling matching reserved output bound!
    // Also re-verify egress URL strictly before transport dispatch.
    try {
      assertModelUrlForStage(effectiveBaseUrl, egressPolicy);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      releaseBudgetReservation(config.govDb, {
        requestId,
        reason,
        evidenceRef: `stage1_egress_blocked:${requestId}`,
        now: nowFn(),
      });
      return createImmediateErrorStream(model, `Blocked model send (${requestId}): ${reason}`, now);
    }
    config.onTransportDispatch?.({
      requestId,
      baseUrl: effectiveBaseUrl,
      provider: model.provider,
      modelId: model.id,
    });
    let fetchBoundaryOutcome: ModelFetchBoundaryOutcome | null = null;
    const guardedFetch = createGuardedModelFetch(
      config.fetchImpl ?? globalThis.fetch,
      config.onHttpFetchAttempt,
      egressPolicy,
      {
        ...(contract
          ? {
              wireValidator: (rawBody: string | undefined) =>
                validateOutgoingWireRequestForContract(rawBody, model.id, effectiveMaxTokens, contract),
            }
          : {}),
        onBoundaryOutcome: (outcome: ModelFetchBoundaryOutcome) => {
          fetchBoundaryOutcome = outcome;
        },
      },
    );
    // Resolve this exact slot's secret strictly in host memory (S6 per-slot credential separation)
    const slotApiKey = config.vault.resolveSecretInMemory(slot.credentialSlotId);
    const enforceDisableThinking = !model.reasoning || contract?.requiredWireThinkingMode === "disabled";
    const enforcedOptions: ModelsSimpleStreamOptions = {
      ...options,
      ...(enforceDisableThinking ? { reasoning: undefined } : {}),
      ...(slotApiKey ? { apiKey: slotApiKey } : {}),
      maxTokens: effectiveMaxTokens,
      maxRetries: 0,
      fetch: guardedFetch,
    };
    const streamStartedAt = performance.now();
    const underlyingStream = inner.streamSimple(model, ctx, enforcedOptions);

    // Non-invasive streaming delta tap + S2-P0-4 authoritative host-side error reducer
    // Reduces any remote error event/result strictly from host fetch outcome + closed enums (NEVER remote text!)
    let firstTokenMs: number | null = null;
    let accumulatedText = "";
    let lastEmitAt = 0;
    const origPush = underlyingStream.push.bind(underlyingStream);
    const origEnd = underlyingStream.end.bind(underlyingStream);
    underlyingStream.push = ((event: Parameters<AssistantMessageEventStream["push"]>[0]) => {
      if (event.type === "error" && event.error) {
        event.error.errorMessage = reduceAuthoritativeModelErrorCode(
          fetchBoundaryOutcome,
          event.error.stopReason,
        );
      } else if (
        event.type === "done" &&
        event.message &&
        (event.message.stopReason === "error" || event.message.stopReason === "aborted")
      ) {
        event.message.errorMessage = reduceAuthoritativeModelErrorCode(
          fetchBoundaryOutcome,
          event.message.stopReason,
        );
      } else if (event.type === "text_delta" && typeof event.delta === "string" && event.delta.length > 0) {
        const elapsedMs = Math.max(0, Math.round(performance.now() - streamStartedAt));
        const isFirst = firstTokenMs === null;
        if (isFirst) firstTokenMs = elapsedMs;
        accumulatedText += event.delta;
        const nowPerf = performance.now();
        if (config.onStreamTextDelta && (isFirst || nowPerf - lastEmitAt >= 40)) {
          lastEmitAt = nowPerf;
          config.onStreamTextDelta({
            conversationId: owner.conversationId,
            ownerTaskId: owner.ownerTaskId,
            requestId,
            delta: event.delta,
            accumulatedText,
            firstTokenMs: firstTokenMs!,
            elapsedMs,
          });
        }
      }
      return origPush(event);
    }) as AssistantMessageEventStream["push"];
    underlyingStream.end = ((result?: AssistantMessage) => {
      if (result && (result.stopReason === "error" || result.stopReason === "aborted")) {
        result.errorMessage = reduceAuthoritativeModelErrorCode(fetchBoundaryOutcome, result.stopReason);
      }
      return origEnd(result);
    }) as AssistantMessageEventStream["end"];

    // 7. Observe terminal AssistantMessage for idempotent settlement (T7)
    // Missing usage or transport error leaves reservation HELD for CHARGED_BOUND timeout!
    void underlyingStream.result().then(
      (finalMsg) => {
        const totalMs = Math.max(0, Math.round(performance.now() - streamStartedAt));
        const isTerminalError = finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted";
        const reducedErrCode = isTerminalError
          ? reduceAuthoritativeModelErrorCode(fetchBoundaryOutcome, finalMsg.stopReason)
          : null;
        config.onStreamFinished?.({
          conversationId: owner.conversationId,
          ownerTaskId: owner.ownerTaskId,
          requestId,
          firstTokenMs,
          totalMs,
          stopReason: finalMsg.stopReason,
          errorCode: reducedErrCode,
        });
        if (isTerminalError) {
          if (fetchBoundaryOutcome?.kind === "wire_contract_violation") {
            // Provably failed BEFORE any HTTP byte hit the wire -> release reservation cleanly
            try {
              releaseBudgetReservation(config.govDb, {
                requestId,
                reason: "model_wire_contract_violation",
                evidenceRef: `wire_contract_violation:${requestId}`,
                now: nowFn(),
              });
            } catch {
              // ignore if closed
            }
          }
          return;
        }
        const actualMu = slot.priceSchedule
          ? computeActualMu(finalMsg, slot.priceSchedule, effectiveBaseUrl, model)
          : null;
        if (actualMu === null) {
          // Usage missing / all-zero: MUST stay HELD (never treat as free!)
          return;
        }
        try {
          settleBudgetReservation(config.govDb, {
            requestId,
            actualMu,
            eventKey: `provider_usage:${requestId}`,
            evidenceRef: `usage:in=${finalMsg.usage.input},out=${finalMsg.usage.output},cacheRead=${finalMsg.usage.cacheRead ?? 0},cacheWrite=${finalMsg.usage.cacheWrite ?? 0}`,
            now: nowFn(),
          });
        } catch {
          // If DB closed during shutdown/kill, reservation remains HELD safely
        }
      },
      () => {
        // Transport rejection: leave HELD conservatively
      },
    );

    return underlyingStream;
  };

  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "streamSimple") {
        return (model: Model<Api>, ctx: AiContext, options?: ModelsSimpleStreamOptions) =>
          guardedStreamSimple(model, ctx, options, "streamSimple");
      }
      if (prop === "completeSimple") {
        return async (model: Model<Api>, ctx: AiContext, options?: ModelsSimpleStreamOptions) =>
          await guardedStreamSimple(model, ctx, options, "completeSimple").result();
      }
      if (prop === "stream" || prop === "complete") {
        return () => {
          throw new Error(`Direct Models.${String(prop)} is disabled; use streamSimple/completeSimple egress`);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });

  return {
    models: proxy,
    isWrappedEgress: true,
    updateSlots: applySlots,
  };
}
