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
} from "@earendil-works/pi-ai";
import {
  stream as openAiCompletionsStream,
  streamSimple as openAiCompletionsStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
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

/**
 * S2-P0-2: Computes a provable conservative integer microUSD upper bound for T6 budget reservation.
 * - Synthetic fixed pricing is ONLY allowed on loopback fake endpoints.
 * - Real remote endpoints MUST supply a non-synthetic versioned ModelPriceSchedule with allowTokenBoundEstimation=true.
 * - Uses worst-case byte-level BPE bound (1 UTF-8 byte = 1 token) across full systemPrompt + messages + tools
 *   plus explicit per-message / per-tool framing overhead, NEVER truncating downwards to contextWindow,
 *   and bounding output strictly by the request's enforced effectiveMaxTokens (+ optional reasoning headroom).
 * - Fails closed (returns null -> unknown_upper_bound, 0 physical sends) if price schedule is missing/invalid,
 *   if non-text unbounded content blocks (e.g. images) are present, or if effectiveMaxTokens is invalid.
 */
function estimateUpperBoundMu(
  context: AiContext,
  _model: Model<Api>,
  schedule: ModelPriceSchedule | null,
  effectiveBaseUrl: string,
  effectiveMaxTokens: number,
): number | null {
  const scheduleCheck = validateModelPriceScheduleForEndpoint(effectiveBaseUrl, schedule);
  if (!scheduleCheck.ok || !schedule) return null;

  if (
    scheduleCheck.isLoopback &&
    typeof schedule.syntheticFixedUpperMu === "number" &&
    Number.isSafeInteger(schedule.syntheticFixedUpperMu) &&
    schedule.syntheticFixedUpperMu >= 0
  ) {
    return schedule.syntheticFixedUpperMu;
  }
  if (!schedule.allowTokenBoundEstimation) {
    return null;
  }
  if (
    !Number.isFinite(schedule.inputPerMTokMu) ||
    schedule.inputPerMTokMu < 0 ||
    !Number.isFinite(schedule.outputPerMTokMu) ||
    schedule.outputPerMTokMu < 0 ||
    !Number.isSafeInteger(effectiveMaxTokens) ||
    effectiveMaxTokens <= 0
  ) {
    return null;
  }
  if (hasUnboundedNonTextContent(context)) {
    return null;
  }
  let payloadUtf8Bytes = 0;
  try {
    payloadUtf8Bytes = Buffer.byteLength(
      JSON.stringify({
        systemPrompt: context.systemPrompt ?? "",
        messages: context.messages,
        tools: context.tools ?? [],
      }),
      "utf8",
    );
  } catch {
    return null;
  }
  const provableMaxInputTokens =
    payloadUtf8Bytes + context.messages.length * 64 + (context.tools?.length ?? 0) * 128 + 256;
  const reasoningHeadroom =
    typeof schedule.maxReasoningTokens === "number" &&
    Number.isFinite(schedule.maxReasoningTokens) &&
    schedule.maxReasoningTokens > 0
      ? Math.ceil(schedule.maxReasoningTokens)
      : 0;
  const provableMaxOutputTokens = effectiveMaxTokens + reasoningHeadroom;

  const maxInputRateMu = Math.max(
    schedule.inputPerMTokMu,
    schedule.cacheReadPerMTokMu ?? 0,
    schedule.cacheWritePerMTokMu ?? 0,
  );
  const inputUpperMu = Math.ceil((provableMaxInputTokens * maxInputRateMu) / 1_000_000);
  const outputUpperMu = Math.ceil((provableMaxOutputTokens * schedule.outputPerMTokMu) / 1_000_000);
  const totalUpperMu = Math.max(1, inputUpperMu + outputUpperMu);
  if (!Number.isSafeInteger(totalUpperMu) || totalUpperMu <= 0) {
    return null;
  }
  return totalUpperMu;
}

function computeActualMu(
  msg: AssistantMessage,
  schedule: ModelPriceSchedule,
  effectiveBaseUrl: string,
): number | null {
  const scheduleCheck = validateModelPriceScheduleForEndpoint(effectiveBaseUrl, schedule);
  if (!scheduleCheck.ok) return null;
  const u = msg.usage;
  if (!u) return null;
  const totalTok = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  if (totalTok <= 0) return null;
  if (
    scheduleCheck.isLoopback &&
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
): typeof globalThis.fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assertModelUrlForStage(rawUrl, egressPolicy);
    onHttpFetchAttempt?.(rawUrl);
    const guardedInit: RequestInit = {
      ...init,
      redirect: "manual",
    };
    const response = await underlyingFetch(input, guardedInit);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "(missing)";
      throw new Stage1EgressBlockedError(
        location,
        `Model egress blocks HTTP ${response.status} redirect from ${rawUrl} to ${location}`,
      );
    }
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

/**
 * Builds the unified host Models egress wrapping pi-ai Models.
 * Every streamSimple (Router / Worker) and completeSimple (Compaction) call passes through
 * phase attribution, outbound/credential binding validation, integer microUSD upper-bound
 * calculation, atomic TASK+DAY reservation (T6), maxRetries=0 dispatch, and idempotent settlement (T7).
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
      const modelDefs: Model<"openai-completions">[] = providerSlots.map((s) => ({
        id: s.modelId,
        name: `${s.provider}/${s.modelId}`,
        api: "openai-completions",
        provider: s.provider,
        baseUrl: s.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: s.contextWindow,
        maxTokens: s.maxTokens,
      }));
      inner.setProvider(
        createProvider({
          id: providerId,
          name: providerId,
          baseUrl: first.baseUrl,
          auth: {
            apiKey: {
              name: `host-slot:${first.credentialSlotId}`,
              resolve: async () => {
                // Inject secret strictly from host memory vault; never persisted in checkpoints.
                const secret = config.vault.resolveSecretInMemory(first.credentialSlotId);
                if (!secret) return undefined;
                return {
                  auth: { apiKey: secret },
                  source: `host-memory:${first.credentialSlotId}`,
                };
              },
            },
          },
          models: modelDefs,
          api: {
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
    const upperMu = estimateUpperBoundMu(ctx, model, slot.priceSchedule, effectiveBaseUrl, effectiveMaxTokens);
    if (upperMu === null) {
      const msg = `Blocked model send (${requestId}): cannot determine provable conservative microUSD upper bound for ${model.provider}/${model.id}`;
      recordEgressDenial(requestId, "unknown_upper_bound", msg, {
        conversationId: owner.conversationId,
        ownerTaskId: owner.ownerTaskId,
        purpose: owner.purpose,
      });
      return createImmediateErrorStream(model, msg, now);
    }

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
    const guardedFetch = createGuardedModelFetch(
      config.fetchImpl ?? globalThis.fetch,
      config.onHttpFetchAttempt,
      egressPolicy,
    );
    // Resolve this exact slot's secret strictly in host memory (S6 per-slot credential separation)
    const slotApiKey = config.vault.resolveSecretInMemory(slot.credentialSlotId);
    const enforcedOptions: ModelsSimpleStreamOptions = {
      ...options,
      ...(slotApiKey ? { apiKey: slotApiKey } : {}),
      maxTokens: effectiveMaxTokens,
      maxRetries: 0,
      fetch: guardedFetch,
    };
    const streamStartedAt = performance.now();
    const underlyingStream = inner.streamSimple(model, ctx, enforcedOptions);

    // Non-invasive streaming delta tap for real-time progressive SSE projection & firstTokenMs metrics
    let firstTokenMs: number | null = null;
    let accumulatedText = "";
    let lastEmitAt = 0;
    const origPush = underlyingStream.push.bind(underlyingStream);
    underlyingStream.push = ((event: Parameters<AssistantMessageEventStream["push"]>[0]) => {
      if (event.type === "text_delta" && typeof event.delta === "string" && event.delta.length > 0) {
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

    // 7. Observe terminal AssistantMessage for idempotent settlement (T7)
    // Missing usage or transport error leaves reservation HELD for CHARGED_BOUND timeout!
    void underlyingStream.result().then(
      (finalMsg) => {
        const totalMs = Math.max(0, Math.round(performance.now() - streamStartedAt));
        config.onStreamFinished?.({
          conversationId: owner.conversationId,
          ownerTaskId: owner.ownerTaskId,
          requestId,
          firstTokenMs,
          totalMs,
        });
        if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
          return;
        }
        const actualMu = slot.priceSchedule
          ? computeActualMu(finalMsg, slot.priceSchedule, effectiveBaseUrl)
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
