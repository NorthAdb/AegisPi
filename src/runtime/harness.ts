import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type Conversation,
  type ConversationId,
  type Harness as HarnessInstance,
  type HarnessInspection,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  ensureScope,
  expireOverdueApprovals,
  registerConversationScope,
} from "../governance/approvals.ts";
import type { BudgetPurpose } from "../governance/budget.ts";
import type { HostCredentialVault } from "../governance/credentials.ts";
import { openGovernanceDb, type GovDbPragmas } from "../governance/db.ts";
import {
  quarantineReadyEffect,
  recoverSubmittingEffectsToUnknown,
} from "../governance/effects.ts";
import { acquireDataDirLock, type InstanceLockHandle } from "../governance/lock.ts";
import {
  advancePairedManifest,
  ensureActiveEpochAndManifest,
  getPairedManifest,
  isolateAndRotateEpoch,
  verifyPairedTraceManifest,
  type PairedCheckResult,
} from "../governance/recovery.ts";
import {
  listPendingOutboxItems,
  recordOutboxDeliveryOutcome,
  type SdkSignalOutcome,
} from "../governance/signal-outbox.ts";
import {
  AEGIS_POLICY_EXTENSION_NAME,
  AegisApprovalSignal,
  createAegisPolicyExtension,
} from "./extensions/aegis-policy.ts";
import {
  createHostModelsEgress,
  type HostModelsController,
  type ModelSlotConfig,
  type ResolvedBudgetOwner,
} from "./models.ts";
import type { EmailSubmissionPayload, SmtpEndpointConfig } from "./submitter.ts";
import { HostPhaseTelemetry, type PhaseAttribution } from "./telemetry.ts";

export type HostHealthState = "RECOVERING" | "READY" | "NEEDS_ATTENTION" | "STOPPED";

export interface AegisHostConfig {
  dataDir: string;
  vault: HostCredentialVault;
  modelSlots: ModelSlotConfig[];
  smtpConfig: SmtpEndpointConfig;
  defaultPrincipalId?: string;
  defaultScopeId?: string;
  allowedEmailTargets?: string[];
  now?: () => number;
  zone?: string;
  defaultTaskLimitMu?: number;
  defaultDayLimitMu?: number;
  settleTimeoutMs?: number;
  durableRetryEnabled?: boolean;
  durableMaxRetries?: number;
  durableBaseDelayMs?: number;
  compactionKeepRecentTokens?: number;
  compactionReserveTokens?: number;
  /** Test seams for F02 startup self-check verification */
  faultInjectMissingPolicyHook?: boolean;
  faultInjectMissingModelsWrapper?: boolean;
  /** Test seam: pause outbox delivery after startup (e.g. E02/E03/E04) */
  pauseOutboxDelivery?: boolean;
  /** Test seam for E01 */
  onBeforeToolAfterProposal?: (info: {
    proposalId: string;
    approvalId: string;
    signalKey: string;
    conversationId: string;
    toolTaskId: string;
    callId: string;
  }) => void | Promise<void>;
  /** Test seam for E03: invoked after SDK signal returns and before recording outbox ACK */
  onAfterSignalBeforeAck?: (info: { approvalId: string; sdkResult: SdkSignalOutcome }) => void | Promise<void>;
  /** Test seam for E05 */
  onAfterClaimBeforeTransport?: (effectId: string) => void | Promise<void>;
  /** Test seam for E08 */
  onBeforeClaim?: (effectId: string) => void | Promise<void>;
  /** Test seam for E10 */
  tamperFinalPayloadForTest?: (
    effectId: string,
    payload: EmailSubmissionPayload,
  ) => { payload: EmailSubmissionPayload; target?: string } | null;
  /** Test seam for B06 */
  shouldFailBeforeTransport?: (requestId: string, owner: ResolvedBudgetOwner) => string | null;
  /** Test seam for B07 */
  injectFaultAfterFirstAccount?: () => void;
  onReservationRecorded?: (info: {
    requestId: string;
    ownerTaskId: string;
    conversationId: string;
    purpose: BudgetPurpose;
    upperMu: number;
    method: "streamSimple" | "completeSimple";
  }) => void;
}

export interface StartupReport {
  health: HostHealthState;
  runtimeEpoch: string;
  traceIdentity: string;
  govPragmas: GovDbPragmas;
  recoveredSubmittingToUnknown: string[];
  expiredApprovals: string[];
  pairedCheck: PairedCheckResult;
  reconciledQuarantinedEffects: string[];
  selfCheckErrors: string[];
  schedulingBeforeRelease: "paused" | "running" | "closing" | null;
}

export class AegisHostRuntime {
  readonly config: AegisHostConfig;
  readonly govDb: DatabaseSync;
  readonly harness: HarnessInstance;
  readonly telemetry: HostPhaseTelemetry;
  readonly modelsController: HostModelsController;
  readonly lock: InstanceLockHandle;
  readonly startupReport: StartupReport;
  readonly tracePath: string;
  readonly govPath: string;

  #health: HostHealthState;
  #runtimeEpoch: string;
  #outboxDeliveryEnabled: boolean;
  #outboxTimer: ReturnType<typeof setInterval> | null = null;
  #drainingOutbox = false;
  #closed = false;

  // Task/conversation -> budget owner bindings
  readonly #taskBudgetOwner = new Map<number, { ownerTaskId: string; purpose: BudgetPurpose; conversationId: string }>();
  readonly #conversationBudgetOwner = new Map<number, { ownerTaskId: string; purpose: BudgetPurpose }>();
  readonly #knownTaskConversation = new Map<number, number>();
  readonly #defaultPrincipalId: string;
  readonly #defaultScopeId: string;
  readonly #now: () => number;

  private constructor(params: {
    config: AegisHostConfig;
    govDb: DatabaseSync;
    harness: HarnessInstance;
    telemetry: HostPhaseTelemetry;
    modelsController: HostModelsController;
    lock: InstanceLockHandle;
    startupReport: StartupReport;
    tracePath: string;
    govPath: string;
    runtimeEpoch: string;
    taskBudgetOwner: Map<number, { ownerTaskId: string; purpose: BudgetPurpose; conversationId: string }>;
    conversationBudgetOwner: Map<number, { ownerTaskId: string; purpose: BudgetPurpose }>;
    knownTaskConversation: Map<number, number>;
    now: () => number;
  }) {
    this.config = params.config;
    this.govDb = params.govDb;
    this.harness = params.harness;
    this.telemetry = params.telemetry;
    this.modelsController = params.modelsController;
    this.lock = params.lock;
    this.startupReport = params.startupReport;
    this.tracePath = params.tracePath;
    this.govPath = params.govPath;
    this.#health = params.startupReport.health;
    this.#runtimeEpoch = params.runtimeEpoch;
    this.#outboxDeliveryEnabled = params.startupReport.health === "READY" && !params.config.pauseOutboxDelivery;
    this.#taskBudgetOwner = params.taskBudgetOwner;
    this.#conversationBudgetOwner = params.conversationBudgetOwner;
    this.#knownTaskConversation = params.knownTaskConversation;
    this.#defaultPrincipalId = params.config.defaultPrincipalId ?? "owner";
    this.#defaultScopeId = params.config.defaultScopeId ?? "scope:default";
    this.#now = params.now;

    if (this.#outboxDeliveryEnabled) {
      this.#startOutboxLoop();
    }
  }

  get health(): HostHealthState {
    return this.#health;
  }

  get runtimeEpoch(): string {
    return this.#runtimeEpoch;
  }

  get isAcceptingCommands(): boolean {
    return this.#health === "READY" && !this.#closed;
  }

  setOutboxDeliveryPaused(paused: boolean): void {
    this.#outboxDeliveryEnabled = !paused && this.#health === "READY";
    if (this.#outboxDeliveryEnabled && !this.#outboxTimer) {
      this.#startOutboxLoop();
    }
  }

  bindConversationBudgetOwner(conversationId: number, ownerTaskId: string, purpose: BudgetPurpose): void {
    this.#conversationBudgetOwner.set(conversationId, { ownerTaskId, purpose });
  }

  bindPiTaskBudgetOwner(
    piTaskId: number,
    conversationId: number,
    ownerTaskId: string,
    purpose: BudgetPurpose,
  ): void {
    this.#taskBudgetOwner.set(piTaskId, {
      ownerTaskId,
      purpose,
      conversationId: String(conversationId),
    });
    this.#knownTaskConversation.set(piTaskId, conversationId);
  }

  /**
   * 6-Step Startup & Recovery Sequence (Taskbook 1 Section 2).
   */
  static async start(config: AegisHostConfig): Promise<AegisHostRuntime> {
    const nowFn = config.now ?? (() => Date.now());
    const absDataDir = path.resolve(config.dataDir);
    mkdirSync(absDataDir, { recursive: true });
    const govPath = path.join(absDataDir, "aegis-gov.sqlite");
    const tracePath = path.join(absDataDir, "pi-durable.sqlite");

    // STEP 1: Acquire exclusive OS process lock BEFORE opening any writable DB
    const lock = await acquireDataDirLock(absDataDir);

    let govDb: DatabaseSync | null = null;
    let harness: HarnessInstance | null = null;

    try {
      // STEP 2: Open Governance DB (WAL + FULL + FK) & exclusive recovery
      const opened = openGovernanceDb(govPath);
      govDb = opened.db;
      const defaultPrincipalId = config.defaultPrincipalId ?? "owner";
      const defaultScopeId = config.defaultScopeId ?? "scope:default";
      ensureScope(govDb, {
        scopeId: defaultScopeId,
        allowedPrincipals: [defaultPrincipalId],
        allowedTools: ["send_email", "run_worker"],
        allowedTargets: config.allowedEmailTargets ?? ["*"],
      });

      const { epoch, manifest } = ensureActiveEpochAndManifest(govDb, nowFn());
      let activeEpochId = epoch.runtime_epoch;
      const recoveredSubmittingToUnknown = recoverSubmittingEffectsToUnknown(govDb, nowFn());
      const expiredApprovals = expireOverdueApprovals(govDb, nowFn());

      // STEP 3: Configure hooks, Models egress, sole submitter, and startup self-checks (delivery paused)
      const selfCheckErrors: string[] = [];
      if (config.faultInjectMissingPolicyHook) {
        selfCheckErrors.push("missing_required_extension:aegis-policy");
      }
      if (config.faultInjectMissingModelsWrapper) {
        selfCheckErrors.push("missing_required_models_egress_wrapper");
      }

      const taskBudgetOwner = new Map<
        number,
        { ownerTaskId: string; purpose: BudgetPurpose; conversationId: string }
      >();
      const conversationBudgetOwner = new Map<number, { ownerTaskId: string; purpose: BudgetPurpose }>();
      const knownTaskConversation = new Map<number, number>();
      let harnessRef: HarnessInstance | null = null;

      const telemetry = new HostPhaseTelemetry();
      const resolveBudgetOwner = (attr: PhaseAttribution, _model: Model<Api>): ResolvedBudgetOwner | null => {
        // 1. Explicit per-Pi-task binding wins (handles concurrent compaction & generation in same conversation!)
        const direct = taskBudgetOwner.get(attr.taskId);
        if (direct) {
          return {
            conversationId: direct.conversationId,
            ownerTaskId: direct.ownerTaskId,
            purpose: attr.taskName === "pi.compaction" ? "compaction" : direct.purpose,
          };
        }
        // 2. Fallback to conversation binding recorded when task was observed
        const convId = knownTaskConversation.get(attr.taskId);
        if (convId !== undefined) {
          const convBinding = conversationBudgetOwner.get(convId);
          if (convBinding) {
            return {
              conversationId: String(convId),
              ownerTaskId: convBinding.ownerTaskId,
              purpose: attr.taskName === "pi.compaction" ? "compaction" : convBinding.purpose,
            };
          }
          return {
            conversationId: String(convId),
            ownerTaskId: `conv:${convId}:task:${attr.taskId}`,
            purpose: attr.taskName === "pi.compaction" ? "compaction" : "router",
          };
        }
        return null;
      };

      const modelsController = createHostModelsEgress({
        govDb,
        getRuntimeEpoch: () => activeEpochId,
        vault: config.vault,
        telemetry,
        slots: config.modelSlots,
        resolveBudgetOwner,
        now: nowFn,
        zone: config.zone,
        defaultTaskLimitMu: config.defaultTaskLimitMu,
        defaultDayLimitMu: config.defaultDayLimitMu,
        settleTimeoutMs: config.settleTimeoutMs,
        shouldFailBeforeTransport: config.shouldFailBeforeTransport,
        injectFaultAfterFirstAccount: config.injectFaultAfterFirstAccount,
        onReservationRecorded: config.onReservationRecorded,
      });

      const resolveScopeId = (conversationId: string): string => {
        const row = govDb!
          .prepare("SELECT scope_id FROM conversation_scopes WHERE conversation_id = ?")
          .get(conversationId) as { scope_id: string } | undefined;
        return row?.scope_id ?? defaultScopeId;
      };

      const workerSlot = config.modelSlots.find((s) => s.slotName === "worker") ?? config.modelSlots[0];
      const registry = createRegistry();
      if (!config.faultInjectMissingPolicyHook) {
        const policyExt = createAegisPolicyExtension({
          govDb,
          getRuntimeEpoch: () => activeEpochId,
          resolveScopeId,
          smtpConfig: config.smtpConfig,
          now: nowFn,
          onBeforeToolAfterProposal: config.onBeforeToolAfterProposal,
          onAfterClaimBeforeTransport: config.onAfterClaimBeforeTransport,
          onBeforeClaim: config.onBeforeClaim,
          tamperFinalPayloadForTest: config.tamperFinalPayloadForTest,
          runWorkerDelegation: async ({ parentConversationId, parentTaskId, prompt, budgetTaskId }) => {
            if (!harnessRef || !workerSlot) {
              return { ok: false, text: "", error: "Harness or worker slot unavailable" };
            }
            const workerConv = await harnessRef.createConversation(
              {
                ownership: { kind: "ownerless" },
                agent: {
                  model: { provider: workerSlot.provider, modelId: workerSlot.modelId },
                  extensions: [],
                },
              },
              BACKGROUND_CONTEXT,
            );
            const effectiveBudgetTask = budgetTaskId ?? `worker:${parentConversationId}:${parentTaskId}:${workerConv.id}`;
            conversationBudgetOwner.set(workerConv.id, {
              ownerTaskId: effectiveBudgetTask,
              purpose: "worker",
            });
            registerConversationScope(govDb!, {
              conversationId: String(workerConv.id),
              scopeId: resolveScopeId(parentConversationId),
              principalId: defaultPrincipalId,
              runtimeEpoch: activeEpochId,
              now: nowFn(),
            });
            const sub = await workerConv.submit({ type: "input", content: prompt }, BACKGROUND_CONTEXT);
            const settled = await sub.wait(BACKGROUND_CONTEXT);
            if (settled.status === "done") {
              const ctxView = await workerConv.context(BACKGROUND_CONTEXT);
              const lastMsg = [...ctxView.messages].reverse().find((m) => m.role === "assistant");
              const text =
                lastMsg && Array.isArray(lastMsg.content)
                  ? lastMsg.content
                      .map((b) => (b.type === "text" ? b.text : ""))
                      .join("\n")
                  : "ok";
              return { ok: true, text, workerConversationId: workerConv.id };
            }
            return {
              ok: false,
              text: "",
              error: `worker_${settled.reason}: ${String(settled.detail ?? "")}`,
              workerConversationId: workerConv.id,
            };
          },
        });
        registry.install(policyExt);
      }

      // Verify installed extension & wrapped models before opening Pi
      if (!registry.snapshot().extension(AEGIS_POLICY_EXTENSION_NAME)) {
        if (!selfCheckErrors.includes("missing_required_extension:aegis-policy")) {
          selfCheckErrors.push("missing_required_extension:aegis-policy");
        }
      }
      if (!modelsController.isWrappedEgress) {
        selfCheckErrors.push("missing_required_models_egress_wrapper");
      }

      // STEP 4: Open Pi Storage & Harness in PAUSED mode (read-only observation only!)
      const storage = await openNodeSqliteStorage(tracePath);
      harness = await Harness.open(
        storage,
        {
          models: modelsController.models,
          registry,
          telemetry,
          now: nowFn,
          settings: {
            stream: { maxRetries: 0 },
            retry: {
              enabled: config.durableRetryEnabled ?? false,
              maxRetries: config.durableMaxRetries ?? 0,
              baseDelayMs: config.durableBaseDelayMs ?? 15,
            },
            compaction: {
              enabled: true,
              keepRecentTokens: config.compactionKeepRecentTokens ?? 20,
              reserveTokens: config.compactionReserveTokens ?? 256,
              backgroundTokens: 0,
            },
          },
        },
        BACKGROUND_CONTEXT,
      );
      harnessRef = harness;

      // Track every task -> (conversationId, owner) synchronously via public observeTaskGraph API
      const taskGraphObs = await harness.observeTaskGraph(
        {
          advance: (call) => {
            if (call.kind !== "value") return;
            for (const node of Object.values(call.value.tasks)) {
              knownTaskConversation.set(node.id, node.conversationId);
              if (node.owner !== undefined && !taskBudgetOwner.has(node.id)) {
                const ownerBinding = taskBudgetOwner.get(node.owner);
                if (ownerBinding) {
                  taskBudgetOwner.set(node.id, {
                    ownerTaskId: ownerBinding.ownerTaskId,
                    purpose: node.kind === "pi.compaction" ? "compaction" : ownerBinding.purpose,
                    conversationId: String(node.conversationId),
                  });
                }
              }
            }
          },
          end: () => {},
        },
        BACKGROUND_CONTEXT,
      );
      for (const node of Object.values(taskGraphObs.value.tasks)) {
        knownTaskConversation.set(node.id, node.conversationId);
      }

      const inspBeforeRelease: HarnessInspection = await harness.inspect(BACKGROUND_CONTEXT);
      for (const item of inspBeforeRelease.tasks) {
        knownTaskConversation.set(item.record.id, item.record.conversationId);
      }

      // If startup self-check failed (F02), stop BEFORE scheduling or calling signal/resume/wait!
      if (selfCheckErrors.length > 0) {
        const report: StartupReport = {
          health: "NEEDS_ATTENTION",
          runtimeEpoch: activeEpochId,
          traceIdentity: epoch.trace_identity,
          govPragmas: opened.pragmas,
          recoveredSubmittingToUnknown,
          expiredApprovals,
          pairedCheck: { ok: true, observedChangeCounter: 0 },
          reconciledQuarantinedEffects: [],
          selfCheckErrors,
          schedulingBeforeRelease: inspBeforeRelease.scheduling,
        };
        return new AegisHostRuntime({
          config,
          govDb,
          harness,
          telemetry,
          modelsController,
          lock,
          startupReport: report,
          tracePath,
          govPath,
          runtimeEpoch: activeEpochId,
          taskBudgetOwner,
          conversationBudgetOwner,
          knownTaskConversation,
          now: nowFn,
        });
      }

      // Observe trace lineage anchor & known conversations/tasks strictly read-only!
      const anchorConv = await harness.conversation(1 as ConversationId, BACKGROUND_CONTEXT);
      let anchorFoundIdentity: string | null = null;
      let currentWatermark = 0;
      if (anchorConv) {
        const rootEntries = await anchorConv.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
        currentWatermark += rootEntries.items.length;
        for (const e of rootEntries.items) {
          if (e.kind === "aegis.lineage_anchor" && e.data && typeof e.data === "object") {
            const d = e.data as Record<string, unknown>;
            if (typeof d["traceIdentity"] === "string") {
              anchorFoundIdentity = d["traceIdentity"];
            }
          }
        }
      }

      // Also check all known conversations & known Pi tasks from governance DB
      const knownConvRows = govDb
        .prepare("SELECT conversation_id FROM conversation_scopes WHERE runtime_epoch = ?")
        .all(activeEpochId) as Array<{ conversation_id: string }>;
      const missingKnownConversationIds: number[] = [];
      for (const r of knownConvRows) {
        const cid = Number(r.conversation_id);
        if (!Number.isFinite(cid)) continue;
        const c = await harness.conversation(cid as ConversationId, BACKGROUND_CONTEXT);
        if (!c) {
          missingKnownConversationIds.push(cid);
        } else {
          const ents = await c.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
          currentWatermark += ents.items.length;
        }
      }

      const knownTaskIds = JSON.parse(manifest.known_pi_task_ids_json) as number[];
      const missingKnownTaskIds: number[] = [];
      for (const tid of knownTaskIds) {
        const rec = await harness.getTask(tid as TaskId, BACKGROUND_CONTEXT);
        if (!rec) {
          missingKnownTaskIds.push(tid);
        } else {
          currentWatermark += 1;
          knownTaskConversation.set(rec.id, rec.conversationId);
        }
      }

      const pairedCheck = verifyPairedTraceManifest(govDb, {
        tracePath,
        anchorPresent: anchorFoundIdentity !== null,
        anchorTraceIdentityFound: anchorFoundIdentity,
        currentWatermark,
        missingKnownTaskIds,
        missingKnownConversationIds,
      });

      if (!pairedCheck.ok) {
        // Trace DB was replaced or rolled back! Do NOT call resume/signal/wait!
        const report: StartupReport = {
          health: "NEEDS_ATTENTION",
          runtimeEpoch: activeEpochId,
          traceIdentity: epoch.trace_identity,
          govPragmas: opened.pragmas,
          recoveredSubmittingToUnknown,
          expiredApprovals,
          pairedCheck,
          reconciledQuarantinedEffects: [],
          selfCheckErrors: [`paired_trace_mismatch:${pairedCheck.code}`],
          schedulingBeforeRelease: inspBeforeRelease.scheduling,
        };
        return new AegisHostRuntime({
          config,
          govDb,
          harness,
          telemetry,
          modelsController,
          lock,
          startupReport: report,
          tracePath,
          govPath,
          runtimeEpoch: activeEpochId,
          taskBudgetOwner,
          conversationBudgetOwner,
          knownTaskConversation,
          now: nowFn,
        });
      }

      // If this is a fresh DB (never anchored), anchor the lineage marker into root conversation via SDK
      if (anchorFoundIdentity === null) {
        const root = await harness.root(BACKGROUND_CONTEXT);
        await root.commit(async (tx) => {
          await tx.appendEntry(root.id, {
            kind: "aegis.lineage_anchor",
            data: {
              runtimeEpoch: activeEpochId,
              traceIdentity: epoch.trace_identity,
              createdAt: nowFn(),
            },
          });
        }, BACKGROUND_CONTEXT);
        advancePairedManifest(govDb, {
          tracePath,
          watermark: Math.max(1, currentWatermark + 1),
          now: nowFn(),
        });
      }

      // STEP 5: Bidirectional reconciliation (still BEFORE scheduling release!)
      const reconciledQuarantinedEffects: string[] = [];

      // 5a: Check all unclaimed READY effects of active epoch against Pi task records
      const readyRows = govDb
        .prepare(
          `SELECT e.effect_id, p.tool_task_id, a.approval_id
             FROM effects e
             JOIN approvals a ON a.approval_id = e.approval_id
             JOIN proposals p ON p.proposal_id = a.proposal_id
            WHERE p.runtime_epoch = ? AND e.state = 'READY'`,
        )
        .all(activeEpochId) as Array<{ effect_id: string; tool_task_id: string; approval_id: string }>;

      for (const r of readyRows) {
        const tid = Number(r.tool_task_id) as TaskId;
        const taskRec = await harness.getTask(tid, BACKGROUND_CONTEXT);
        const isTerminalOrGone = !taskRec || taskRec.state.status === "terminal" || taskRec.abortRequested;
        if (isTerminalOrGone) {
          const q = quarantineReadyEffect(govDb, {
            effectId: r.effect_id,
            reason: !taskRec ? "pi_task_not_found_on_recovery" : "pi_tool_terminated_before_claim",
            now: nowFn(),
          });
          if (q) reconciledQuarantinedEffects.push(r.effect_id);
          // Also reconcile any pending outbox row for this approval
          const outboxRow = govDb
            .prepare("SELECT state FROM signal_outbox WHERE approval_id = ?")
            .get(r.approval_id) as { state: string } | undefined;
          if (outboxRow?.state === "PENDING") {
            recordOutboxDeliveryOutcome(govDb, {
              approvalId: r.approval_id,
              sdkOutcome: !taskRec ? "not_found" : "closed",
              taskObservedDecisionOrFinished: false,
              reason: !taskRec ? "pi_task_not_found_on_recovery" : "pi_tool_terminated_before_claim",
              now: nowFn(),
            });
          }
        }
      }

      // STEP 6: Release recovery scheduling and open intake
      const report: StartupReport = {
        health: "READY",
        runtimeEpoch: activeEpochId,
        traceIdentity: epoch.trace_identity,
        govPragmas: opened.pragmas,
        recoveredSubmittingToUnknown,
        expiredApprovals,
        pairedCheck,
        reconciledQuarantinedEffects,
        selfCheckErrors: [],
        schedulingBeforeRelease: inspBeforeRelease.scheduling,
      };

      const host = new AegisHostRuntime({
        config,
        govDb,
        harness,
        telemetry,
        modelsController,
        lock,
        startupReport: report,
        tracePath,
        govPath,
        runtimeEpoch: activeEpochId,
        taskBudgetOwner,
        conversationBudgetOwner,
        knownTaskConversation,
        now: nowFn,
      });

      // Enable Pi scheduler ONLY AFTER Steps 1-5 passed
      harness.resume();
      if (!config.pauseOutboxDelivery) {
        await host.deliverPendingOutbox();
      }

      return host;
    } catch (err) {
      if (harness) {
        await harness.close(BACKGROUND_CONTEXT).catch(() => {});
      }
      if (govDb) {
        try {
          govDb.close();
        } catch {
          // ignore
        }
      }
      await lock.release().catch(() => {});
      throw err;
    }
  }

  /**
   * Explicitly isolates the old epoch & rotates to a brand new epoch after
   * a trace replacement/rollback mismatch was detected on startup (F03).
   */
  async rotateEpochAfterMismatch(reason: string): Promise<{
    retiredEpoch: string;
    newEpoch: string;
    quarantinedReadyEffectIds: string[];
    isolatedOutboxIds: string[];
    preservedHeldReservationIds: string[];
  }> {
    const res = isolateAndRotateEpoch(this.govDb, { reason, now: this.#now() });
    this.#runtimeEpoch = res.newEpoch.runtime_epoch;
    const root = await this.harness.root(BACKGROUND_CONTEXT);
    await root.commit(async (tx) => {
      await tx.appendEntry(root.id, {
        kind: "aegis.lineage_anchor",
        data: {
          runtimeEpoch: res.newEpoch.runtime_epoch,
          traceIdentity: res.newEpoch.trace_identity,
          createdAt: this.#now(),
          rotatedFrom: res.retiredEpoch,
        },
      });
    }, BACKGROUND_CONTEXT);
    advancePairedManifest(this.govDb, {
      tracePath: this.tracePath,
      watermark: 1,
      now: this.#now(),
    });
    this.#health = "READY";
    if (!this.config.pauseOutboxDelivery) {
      this.#outboxDeliveryEnabled = true;
      this.#startOutboxLoop();
    }
    this.harness.resume();
    return {
      retiredEpoch: res.retiredEpoch,
      newEpoch: res.newEpoch.runtime_epoch,
      quarantinedReadyEffectIds: res.quarantinedReadyEffectIds,
      isolatedOutboxIds: res.isolatedOutboxIds,
      preservedHeldReservationIds: res.preservedHeldReservationIds,
    };
  }

  async createManagedConversation(opts?: {
    scopeId?: string;
    principalId?: string;
    slotName?: "router" | "worker";
    budgetTaskId?: string;
  }): Promise<Conversation> {
    const slot =
      this.config.modelSlots.find((s) => s.slotName === (opts?.slotName ?? "router")) ??
      this.config.modelSlots[0];
    if (!slot) {
      throw new Error("No model slots configured");
    }
    const policyExt = this.harness ? undefined : undefined;
    void policyExt;
    const conv = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: slot.provider, modelId: slot.modelId },
        },
      },
      BACKGROUND_CONTEXT,
    );
    const scopeId = opts?.scopeId ?? this.#defaultScopeId;
    const principalId = opts?.principalId ?? this.#defaultPrincipalId;
    registerConversationScope(this.govDb, {
      conversationId: String(conv.id),
      scopeId,
      principalId,
      runtimeEpoch: this.#runtimeEpoch,
      now: this.#now(),
    });
    if (opts?.budgetTaskId) {
      this.bindConversationBudgetOwner(conv.id, opts.budgetTaskId, opts.slotName ?? "router");
    }
    await this.syncPairedManifestWatermark();
    return conv;
  }

  async submitChatInput(params: {
    conversationId: string;
    content: string;
    budgetTaskId?: string;
  }): Promise<{ ok: true; submissionId: number } | { ok: false; code: string }> {
    const cid = Number(params.conversationId) as ConversationId;
    if (!Number.isFinite(cid)) return { ok: false, code: "invalid_conversation_id" };
    if (params.budgetTaskId) {
      const existing = this.#conversationBudgetOwner.get(cid);
      this.bindConversationBudgetOwner(cid, params.budgetTaskId, existing?.purpose ?? "router");
    }
    const conv = await this.harness.conversation(cid, BACKGROUND_CONTEXT);
    if (!conv) return { ok: false, code: "conversation_not_found" };
    const sub = await conv.submit({ type: "input", content: params.content }, BACKGROUND_CONTEXT);
    return { ok: true, submissionId: Number(sub.id) };
  }

  async triggerCompaction(params: {
    conversationId: string;
    instructions?: string;
    budgetTaskId?: string;
  }): Promise<{ ok: true; compactionTaskId: number } | { ok: false; code: string }> {
    const cid = Number(params.conversationId) as ConversationId;
    if (!Number.isFinite(cid)) return { ok: false, code: "invalid_conversation_id" };
    const conv = await this.harness.conversation(cid, BACKGROUND_CONTEXT);
    if (!conv) return { ok: false, code: "conversation_not_found" };
    const compactTaskId = await conv.compact(
      params.instructions ?? "Summarize conversation",
      BACKGROUND_CONTEXT,
    );
    if (params.budgetTaskId) {
      this.bindPiTaskBudgetOwner(compactTaskId, cid, params.budgetTaskId, "compaction");
    }
    return { ok: true, compactionTaskId: Number(compactTaskId) };
  }

  async readConversationMessages(
    conversationId: string,
  ): Promise<Array<{ role: string; content: unknown }>> {
    const cid = Number(conversationId) as ConversationId;
    if (!Number.isFinite(cid)) return [];
    const conv = await this.harness.conversation(cid, BACKGROUND_CONTEXT);
    if (!conv) return [];
    const ctxView = await conv.context(BACKGROUND_CONTEXT);
    return ctxView.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  async syncPairedManifestWatermark(): Promise<void> {
    const manifest = getPairedManifest(this.govDb);
    if (!manifest) return;
    const insp = await this.harness.inspect(BACKGROUND_CONTEXT);
    const taskIds = insp.tasks.map((t) => t.record.id);
    const convRows = this.govDb
      .prepare("SELECT conversation_id FROM conversation_scopes WHERE runtime_epoch = ?")
      .all(this.#runtimeEpoch) as Array<{ conversation_id: string }>;
    let watermark = 1; // root anchor
    for (const r of convRows) {
      const cid = Number(r.conversation_id);
      if (!Number.isFinite(cid)) continue;
      const c = await this.harness.conversation(cid as ConversationId, BACKGROUND_CONTEXT);
      if (c) {
        const ents = await c.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
        watermark += ents.items.length;
      }
    }
    watermark += taskIds.length;
    advancePairedManifest(this.govDb, {
      tracePath: this.tracePath,
      watermark,
      knownTaskIds: taskIds,
      now: this.#now(),
    });
  }

  /**
   * T3: Deliver pending signal_outbox entries to matching parked Pi tool tasks
   * and reconcile all 5 SDK outcomes (delivered, duplicate, invalid, closed, not_found).
   */
  async deliverPendingOutbox(): Promise<
    Array<{ approvalId: string; signalKey: string; sdkResult: string; action: string }>
  > {
    if (this.#closed || this.#health !== "READY" || this.#drainingOutbox) return [];
    this.#drainingOutbox = true;
    const results: Array<{ approvalId: string; signalKey: string; sdkResult: string; action: string }> = [];
    try {
      const items = listPendingOutboxItems(this.govDb, this.#runtimeEpoch);
      for (const item of items) {
        if (this.#closed) break;
        const tid = Number(item.tool_task_id) as TaskId;
        const taskRec = await this.harness.getTask(tid, BACKGROUND_CONTEXT);

        if (!taskRec) {
          recordOutboxDeliveryOutcome(this.govDb, {
            approvalId: item.approval_id,
            sdkOutcome: "not_found",
            taskObservedDecisionOrFinished: false,
            reason: "task_not_found_during_delivery",
            now: this.#now(),
          });
          results.push({
            approvalId: item.approval_id,
            signalKey: item.signal_key,
            sdkResult: "not_found",
            action: "isolated",
          });
          continue;
        }

        if (taskRec.state.status === "terminal" || taskRec.abortRequested) {
          // Check if the effect was already claimed/succeeded (tool already observed decision!)
          const alreadyConsumed =
            item.effect_state !== null && item.effect_state !== "READY";
          recordOutboxDeliveryOutcome(this.govDb, {
            approvalId: item.approval_id,
            sdkOutcome: "closed",
            taskObservedDecisionOrFinished: alreadyConsumed,
            reason: alreadyConsumed ? "already_consumed_before_close" : "tool_terminated_before_claim",
            now: this.#now(),
          });
          results.push({
            approvalId: item.approval_id,
            signalKey: item.signal_key,
            sdkResult: "closed",
            action: alreadyConsumed ? "acked" : "isolated",
          });
          continue;
        }

        // Only deliver when the target tool task is actually sleeping (parked at gate).
        // If approval arrived before park (E01), keep PENDING so either beforeTool re-entry
        // observes it directly or the next poll delivers once sleeping!
        if (taskRec.state.status !== "sleeping") {
          continue;
        }

        // Resolve the exact signal key this sleeping task is awaiting for this (runtimeEpoch, proposalId).
        // When a draft is edited from r1 -> r2 while the tool is still parked on r1's wake key,
        // waking on the awaited proposal key triggers beforeTool re-entry, which reads r2 from govDb.
        const proposalKeyPrefix = `sig:${item.runtime_epoch}:${item.proposal_id}:r`;
        const awaitedSignal = taskRec.state.signals?.find(
          (s) => s.signal === AegisApprovalSignal.name && s.key.startsWith(proposalKeyPrefix),
        );
        const deliveryKey = awaitedSignal?.key ?? item.signal_key;

        const payload = {
          approvalId: item.approval_id,
          decision: item.approval_state,
          revision: item.revision,
        };
        const sdkResult = await this.harness.signal(
          tid,
          AegisApprovalSignal,
          deliveryKey,
          payload,
          BACKGROUND_CONTEXT,
        );

        // E03 test seam: crash/hook right after SDK accepted signal and before local ACK
        if (this.config.onAfterSignalBeforeAck) {
          await this.config.onAfterSignalBeforeAck({
            approvalId: item.approval_id,
            sdkResult,
          });
        }

        const alreadyConsumed = item.effect_state !== null && item.effect_state !== "READY";
        recordOutboxDeliveryOutcome(this.govDb, {
          approvalId: item.approval_id,
          sdkOutcome: sdkResult,
          duplicateValueMatches: true,
          taskObservedDecisionOrFinished: alreadyConsumed,
          now: this.#now(),
        });
        results.push({
          approvalId: item.approval_id,
          signalKey: item.signal_key,
          sdkResult,
          action: sdkResult === "delivered" || sdkResult === "duplicate" ? "acked" : "reconciled",
        });
      }
    } finally {
      this.#drainingOutbox = false;
    }
    return results;
  }

  #startOutboxLoop(): void {
    if (this.#outboxTimer) return;
    this.#outboxTimer = setInterval(() => {
      if (this.#outboxDeliveryEnabled && !this.#closed) {
        void this.deliverPendingOutbox().catch(() => {});
      }
    }, 40);
    this.#outboxTimer.unref();
  }

  /**
   * Graceful shutdown order (Taskbook 1 Section 2):
   * 1. Stop intake & outbox delivery -> 2. Sync watermark -> 3. await harness.close()
   * -> 4. Close governance DB -> 5. Release exclusive OS lock.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#health = "STOPPED";
    this.#outboxDeliveryEnabled = false;
    if (this.#outboxTimer) {
      clearInterval(this.#outboxTimer);
      this.#outboxTimer = null;
    }
    try {
      await this.syncPairedManifestWatermark();
    } catch {
      // ignore if startup failed before anchoring
    }
    try {
      await this.harness.close(BACKGROUND_CONTEXT);
    } finally {
      try {
        this.govDb.close();
      } finally {
        await this.lock.release();
      }
    }
  }
}
