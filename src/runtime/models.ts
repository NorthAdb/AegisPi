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
  assertStage1LoopbackModelUrl,
  Stage1EgressBlockedError,
  type HostCredentialVault,
  type ModelPriceSchedule,
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

/**
 * Computes a provable conservative integer microUSD upper bound for T6 budget reservation.
 * Stage 1 fails closed (returns null -> unknown_upper_bound, 0 physical sends) for any
 * price schedule without an explicitly verified per-request integer upper bound;
 * approximate character-length heuristics are explicitly rejected.
 */
function estimateUpperBoundMu(
  _context: AiContext,
  _model: Model<Api>,
  schedule: ModelPriceSchedule | null,
): number | null {
  if (!schedule) return null;
  if (
    typeof schedule.syntheticFixedUpperMu === "number" &&
    Number.isSafeInteger(schedule.syntheticFixedUpperMu) &&
    schedule.syntheticFixedUpperMu >= 0
  ) {
    return schedule.syntheticFixedUpperMu;
  }
  return null;
}

function computeActualMu(msg: AssistantMessage, schedule: ModelPriceSchedule): number | null {
  const u = msg.usage;
  if (!u) return null;
  const totalTok = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  // Missing usage or all-zero usage MUST stay HELD (never treated as free!)
  if (totalTok <= 0) return null;
  if (schedule.syntheticFixedActualMu !== undefined && schedule.syntheticFixedActualMu !== null) {
    return schedule.syntheticFixedActualMu;
  }
  const inputCost = ((u.input ?? 0) * schedule.inputPerMTokMu) / 1_000_000;
  const outputCost = ((u.output ?? 0) * schedule.outputPerMTokMu) / 1_000_000;
  return Math.max(1, Math.ceil(inputCost + outputCost));
}

/**
 * Stage 1 guarded HTTP fetch transport passed directly into pi-ai's OpenAI client.
 * 1. Re-enforces Stage 1 loopback-only URL validation on EVERY physical fetch attempt.
 * 2. Sets redirect: "manual" so Node's fetch NEVER auto-follows 3xx redirects to off-loopback hosts.
 * 3. Explicitly rejects any 3xx redirect response with Stage1EgressBlockedError (0 secondary hops).
 */
export function createStage1GuardedFetch(
  underlyingFetch: typeof globalThis.fetch = globalThis.fetch,
  onHttpFetchAttempt?: (url: string) => void,
): typeof globalThis.fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assertStage1LoopbackModelUrl(rawUrl);
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
        `Stage 1 blocks HTTP ${response.status} redirect from ${rawUrl} to ${location}`,
      );
    }
    return response;
  };
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
  const inner = createModels();
  let slotList: ModelSlotConfig[] = [];

  const applySlots = (slots: ModelSlotConfig[]): void => {
    for (const s of slots) {
      assertStage1LoopbackModelUrl(s.baseUrl);
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
          recordEgressDenial(requestId, "disclosure_denied", msg, {
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
    const bindingCheck = config.vault.validateBinding({
      slotId: slot.credentialSlotId,
      provider: model.provider,
      modelId: model.id,
      baseUrl: model.baseUrl ?? slot.baseUrl,
    });
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

    // 3. Calculate conservative integer microUSD upper bound (fail closed if unknown!)
    const upperMu = estimateUpperBoundMu(ctx, model, slot.priceSchedule);
    if (upperMu === null) {
      const msg = `Blocked model send (${requestId}): cannot determine conservative microUSD upper bound for ${model.provider}/${model.id}`;
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

    // 6. Enforce maxRetries: 0 (no hidden provider retries; durable retries must re-reserve!)
    // Also re-verify Stage 1 loopback URL strictly before transport dispatch.
    const effectiveBaseUrl = model.baseUrl ?? slot.baseUrl;
    try {
      assertStage1LoopbackModelUrl(effectiveBaseUrl);
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
    const guardedFetch = createStage1GuardedFetch(
      config.fetchImpl ?? globalThis.fetch,
      config.onHttpFetchAttempt,
    );
    // Resolve this exact slot's secret strictly in host memory (S6 per-slot credential separation)
    const slotApiKey = config.vault.resolveSecretInMemory(slot.credentialSlotId);
    const enforcedOptions: ModelsSimpleStreamOptions = {
      ...options,
      ...(slotApiKey ? { apiKey: slotApiKey } : {}),
      maxRetries: 0,
      fetch: guardedFetch,
    };
    const underlyingStream = inner.streamSimple(model, ctx, enforcedOptions);

    // 7. Observe terminal AssistantMessage for idempotent settlement (T7)
    // Missing usage or transport error leaves reservation HELD for CHARGED_BOUND timeout!
    void underlyingStream.result().then(
      (finalMsg) => {
        if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
          return;
        }
        const actualMu = slot.priceSchedule ? computeActualMu(finalMsg, slot.priceSchedule) : null;
        if (actualMu === null) {
          // Usage missing / all-zero: MUST stay HELD (never treat as free!)
          return;
        }
        try {
          settleBudgetReservation(config.govDb, {
            requestId,
            actualMu,
            eventKey: `provider_usage:${requestId}`,
            evidenceRef: `usage:in=${finalMsg.usage.input},out=${finalMsg.usage.output}`,
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
