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
  type Cursor,
  type Harness as HarnessInstance,
  type HarnessInspection,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  ensureScope,
  expireOverdueApprovals,
  isPrincipalAuthorizedForScope,
  registerConversationScope,
  type ScopeRow,
} from "../governance/approvals.ts";
import {
  chatCommandUiStatusLabel,
  listUnreconciledChatCommands,
  markChatCommandPendingReconcile,
  recordChatCommandAdmitted,
  registerOrLookupChatCommand,
  type ChatCommandRow,
  type ChatCommandStatus,
} from "../governance/chat-commands.ts";
import {
  chargeBoundExpiredReservations,
  correctChargedBoundReservation,
  getPersistedBudgetBinding,
  listPersistedBudgetBindings,
  persistBudgetTaskBinding,
  type BudgetPurpose,
} from "../governance/budget.ts";
import { canonicalJson } from "../governance/canonical.ts";
import {
  assertStage1LoopbackModelUrl,
  assertStage1LoopbackSmtpHost,
  type HostCredentialVault,
} from "../governance/credentials.ts";
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
  type DuplicateCheckOutcome,
  type SdkSignalOutcome,
} from "../governance/signal-outbox.ts";
import {
  AEGIS_POLICY_EXTENSION_NAME,
  AegisApprovalSignal,
  createAegisPolicyExtension,
  type ManagedWorkspaceWriteHandler,
} from "./extensions/aegis-policy.ts";
import { createAegisContextExtension } from "./extensions/aegis-context.ts";
import type { ImapEndpointConfig } from "../capabilities/mail/imap-client.ts";
import type { ManagedWorkspaceImporter } from "../capabilities/workspace/importer.ts";
import { inheritConversationSources } from "../governance/policy.ts";
import type { GitHubMcpBridge } from "./mcp-bridge.ts";
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
  defaultMemoryDomain?: string;
  allowedEmailTargets?: string[];
  imapEndpoint?: ImapEndpointConfig | (() => ImapEndpointConfig | null);
  githubMcpBridge?: GitHubMcpBridge | (() => GitHubMcpBridge | null);
  workspaceWriteHandler?: ManagedWorkspaceWriteHandler;
  /** W2-S3: Optional managed workspace importer for startup Step 5c receipt-loss reconciliation. */
  managedWorkspaceImporter?: ManagedWorkspaceImporter;
  /** W2-S1: Async hook executed AFTER govDb/host initialization and STRICTLY BEFORE harness.resume() releases scheduling. */
  beforeResume?: (host: AegisHostRuntime) => Promise<void> | void;
  approvalTtlMs?: number;
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
  /** Optional observer for G2 transport proof */
  onTransportDispatch?: (info: { requestId: string; baseUrl: string; provider: string; modelId: string }) => void;
  /** Optional custom underlying fetch & per-hop observer for G2 redirect/egress tests */
  fetchImpl?: typeof globalThis.fetch;
  onHttpFetchAttempt?: (url: string) => void;
  onReservationRecorded?: (info: {
    requestId: string;
    ownerTaskId: string;
    conversationId: string;
    purpose: BudgetPurpose;
    upperMu: number;
    method: "streamSimple" | "completeSimple";
  }) => void;
  /** V04 deterministic test barriers */
  onAfterChatGovRegister?: (cmd: ChatCommandRow) => void | Promise<void>;
  onAfterPiAdmitBeforeGovReceipt?: (info: {
    commandId: string;
    piRequestId: string;
    submissionId: number;
    conversationId: string;
  }) => void | Promise<void>;
  onAfterChatGovReceiptBeforeHttp?: (info: {
    commandId: string;
    piRequestId: string;
    submissionId: number;
    conversationId: string;
  }) => void | Promise<void>;
  injectChatReconcileReadFailure?: (cmd: ChatCommandRow) => string | null;
}

export interface ChatCommandReconcileReport {
  commandId: string;
  chatKey: string;
  conversationId: string;
  piRequestId: string;
  outcome: "admitted_backfilled" | "kept_registered" | "pending_reconcile";
  submissionId?: number | null;
  reason?: string;
}

export interface FileImportReconcileReport {
  importId: string;
  logicalKey: string;
  conversationId: string;
  targetRelPath: string;
  outcome: "reconciled_installed" | "pending_reconcile";
  installCount: number;
  diskRewritten: false;
}

export interface StartupReport {
  health: HostHealthState;
  runtimeEpoch: string;
  traceIdentity: string;
  govPragmas: GovDbPragmas;
  recoveredSubmittingToUnknown: string[];
  expiredApprovals: string[];
  chargedBoundReservations: string[];
  pairedCheck: PairedCheckResult;
  reconciledQuarantinedEffects: string[];
  reconciledChatCommands: ChatCommandReconcileReport[];
  reconciledFileImports: FileImportReconcileReport[];
  selfCheckErrors: string[];
  schedulingBeforeRelease: "paused" | "running" | "closing" | null;
}

export interface ConversationLiveChange {
  conversationId: string;
  kind: "pi_view" | "pi_task_graph" | "worker_completed" | "governance";
  detail?: Record<string, unknown>;
}

export interface ConversationLiveSummary {
  messages: Array<{ role: string; content: unknown }>;
  livePartial: { text: string; attempt: number } | null;
  activeTools: Array<{ callId: string; name: string; status: string }>;
  workerTasks: Array<{
    workerConversationId: string;
    parentConversationId: string;
    ownerTaskId: string;
    status: "running" | "done" | "error";
    slotName: string;
    summary?: string;
    updatedAt: number;
  }>;
}

export interface SubmitChatCommandResult {
  ok: boolean;
  httpStatus: 200 | 202 | 400 | 403 | 404 | 409 | 503;
  code: string;
  message?: string;
  idempotentReplay?: boolean;
  commandId?: string;
  chatKey?: string;
  piRequestId?: string;
  submissionId?: number | null;
  status?: ChatCommandStatus;
  uiStatusLabel?: string;
  conversationId?: string;
  runtimeEpoch?: string;
}

/**
 * Paginates through ALL committed entries of a conversation using cursor pagination
 * (never truncated at page 1 / 200 items), returning total entry count and any
 * aegis.lineage_anchor traceIdentity found.
 */
async function scanAllConversationEntries(conv: Conversation): Promise<{
  totalCount: number;
  anchorTraceIdentity: string | null;
}> {
  let cursor: Cursor | undefined = undefined;
  let totalCount = 0;
  let anchorTraceIdentity: string | null = null;
  for (;;) {
    const page = await conv.entries({ order: "ascending" }, 200, cursor, BACKGROUND_CONTEXT);
    totalCount += page.items.length;
    for (const e of page.items) {
      if (e.kind === "aegis.lineage_anchor" && e.data && typeof e.data === "object") {
        const d = e.data as Record<string, unknown>;
        if (typeof d["traceIdentity"] === "string") {
          anchorTraceIdentity = d["traceIdentity"];
        }
      }
    }
    if (!page.next || page.items.length === 0) break;
    cursor = page.next;
  }
  return { totalCount, anchorTraceIdentity };
}

/**
 * Inspects Pi's persisted task memos to verify whether a previously delivered signal
 * under (signalName, key) matches the expected canonical JSON payload.
 */
function verifyDuplicateSignalValue(
  memos: Readonly<Record<string, unknown>> | undefined,
  signalName: string,
  deliveryKey: string,
  expectedPayload: Record<string, unknown>,
): DuplicateCheckOutcome {
  if (!memos) return "unverifiable";
  const memoKey = `pi.signal.${signalName}/${deliveryKey}`;
  const stored = memos[memoKey];
  if (!stored || typeof stored !== "object" || !("value" in stored)) {
    return "unverifiable";
  }
  const storedVal = (stored as { value: unknown }).value;
  try {
    return canonicalJson(storedVal) === canonicalJson(expectedPayload) ? "matched" : "conflict";
  } catch {
    return "unverifiable";
  }
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
  readonly #epochBox: { current: string };
  #outboxDeliveryEnabled: boolean;
  #maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  #drainingOutbox = false;
  #closed = false;

  // Authoritative host task/conversation -> budget owner bindings (backed by budget_task_bindings in govDb)
  readonly #taskBudgetOwner = new Map<number, { ownerTaskId: string; purpose: BudgetPurpose; conversationId: string }>();
  readonly #conversationBudgetOwner = new Map<number, { ownerTaskId: string; purpose: BudgetPurpose }>();
  readonly #knownTaskConversation = new Map<number, number>();
  readonly #inFlightChatAdmissions = new Map<string, Promise<SubmitChatCommandResult>>();
  readonly #changeListeners = new Set<(ev: ConversationLiveChange) => void>();
  readonly #workerTasksByParent: Map<
    string,
    Array<{
      workerConversationId: string;
      parentConversationId: string;
      ownerTaskId: string;
      status: "running" | "done" | "error";
      slotName: string;
      summary?: string;
      updatedAt: number;
    }>
  >;
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
    epochBox: { current: string };
    taskBudgetOwner: Map<number, { ownerTaskId: string; purpose: BudgetPurpose; conversationId: string }>;
    conversationBudgetOwner: Map<number, { ownerTaskId: string; purpose: BudgetPurpose }>;
    knownTaskConversation: Map<number, number>;
    workerTasksByParent: Map<
      string,
      Array<{
        workerConversationId: string;
        parentConversationId: string;
        ownerTaskId: string;
        status: "running" | "done" | "error";
        slotName: string;
        summary?: string;
        updatedAt: number;
      }>
    >;
    changeListeners: Set<(ev: ConversationLiveChange) => void>;
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
    this.#epochBox = params.epochBox;
    this.#outboxDeliveryEnabled = params.startupReport.health === "READY" && !params.config.pauseOutboxDelivery;
    this.#taskBudgetOwner = params.taskBudgetOwner;
    this.#conversationBudgetOwner = params.conversationBudgetOwner;
    this.#knownTaskConversation = params.knownTaskConversation;
    this.#workerTasksByParent = params.workerTasksByParent;
    this.#changeListeners = params.changeListeners;
    this.#defaultPrincipalId = params.config.defaultPrincipalId ?? "owner";
    this.#defaultScopeId = params.config.defaultScopeId ?? "scope:default";
    this.#now = params.now;

    if (this.#health === "READY") {
      this.#startMaintenanceLoop();
    }
  }

  onConversationChange(listener: (ev: ConversationLiveChange) => void): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  emitConversationChange(ev: ConversationLiveChange): void {
    for (const fn of [...this.#changeListeners]) {
      try {
        fn(ev);
      } catch {
        // never break caller on listener error
      }
    }
  }

  get health(): HostHealthState {
    return this.#health;
  }

  get runtimeEpoch(): string {
    return this.#epochBox.current;
  }

  get isAcceptingCommands(): boolean {
    return this.#health === "READY" && !this.#closed;
  }

  setOutboxDeliveryPaused(paused: boolean): void {
    this.#outboxDeliveryEnabled = !paused && this.#health === "READY";
    if (this.#health === "READY" && !this.#maintenanceTimer) {
      this.#startMaintenanceLoop();
    }
  }

  bindConversationBudgetOwner(
    conversationId: number,
    ownerTaskId: string,
    purpose: BudgetPurpose,
    opts?: { overwrite?: boolean },
  ): void {
    const overwrite = opts?.overwrite ?? false;
    if (!overwrite && this.#conversationBudgetOwner.has(conversationId)) {
      return;
    }
    this.#conversationBudgetOwner.set(conversationId, { ownerTaskId, purpose });
    persistBudgetTaskBinding(this.govDb, {
      runtimeEpoch: this.#epochBox.current,
      bindingKind: "CONVERSATION",
      bindingKey: String(conversationId),
      conversationId: String(conversationId),
      ownerTaskId,
      purpose,
      now: this.#now(),
      overwrite,
    });
  }

  bindPiTaskBudgetOwner(
    piTaskId: number,
    conversationId: number,
    ownerTaskId: string,
    purpose: BudgetPurpose,
    opts?: { overwrite?: boolean },
  ): void {
    const overwrite = opts?.overwrite ?? true;
    this.#taskBudgetOwner.set(piTaskId, {
      ownerTaskId,
      purpose,
      conversationId: String(conversationId),
    });
    this.#knownTaskConversation.set(piTaskId, conversationId);
    persistBudgetTaskBinding(this.govDb, {
      runtimeEpoch: this.#epochBox.current,
      bindingKind: "PI_TASK",
      bindingKey: String(piTaskId),
      conversationId: String(conversationId),
      ownerTaskId,
      purpose,
      now: this.#now(),
      overwrite,
    });
  }

  /**
   * Runs periodic timeout settlement (HELD -> CHARGED_BOUND) on the host clock.
   * Invoked both during startup Step 2 and continuously during runtime maintenance ticks.
   */
  runBudgetSettlementSweep(): string[] {
    if (this.#closed) return [];
    return chargeBoundExpiredReservations(this.govDb, { now: this.#now() });
  }

  /**
   * Host-level entry point to apply a trusted late provider bill to a CHARGED_BOUND reservation.
   */
  applyTrustedLateBill(params: {
    requestId: string;
    actualMu: number;
    billEventKey: string;
    evidenceRef: string;
    actorId: string;
  }) {
    return correctChargedBoundReservation(this.govDb, {
      requestId: params.requestId,
      actualMu: params.actualMu,
      billEventKey: params.billEventKey,
      evidenceRef: params.evidenceRef,
      actorId: params.actorId,
      now: this.#now(),
    });
  }

  /**
   * 6-Step Startup & Recovery Sequence (Taskbook 1 Section 2).
   */
  static async start(config: AegisHostConfig): Promise<AegisHostRuntime> {
    // Stage 1 hard egress boundary check BEFORE opening any writable DB or lock
    assertStage1LoopbackSmtpHost(config.smtpConfig.host, config.smtpConfig.port);
    for (const s of config.modelSlots) {
      assertStage1LoopbackModelUrl(s.baseUrl);
    }

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
      // Shared mutable epoch box so Models, policy extension, and runtime always observe epoch rotation immediately!
      const epochBox = { current: epoch.runtime_epoch };
      const recoveredSubmittingToUnknown = recoverSubmittingEffectsToUnknown(govDb, nowFn());
      const expiredApprovals = expireOverdueApprovals(govDb, nowFn());
      const chargedBoundReservations = chargeBoundExpiredReservations(govDb, { now: nowFn() });

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
      const workerTasksByParent = new Map<
        string,
        Array<{
          workerConversationId: string;
          parentConversationId: string;
          ownerTaskId: string;
          status: "running" | "done" | "error";
          slotName: string;
          summary?: string;
          updatedAt: number;
        }>
      >();
      const parentByWorkerConv = new Map<string, string>();
      const workerExecutionRootByConv = new Map<string, string>();
      const resolveExecutionRootTaskId = async (conversationId: string, taskId: string): Promise<string> => {
        const mapped = workerExecutionRootByConv.get(conversationId);
        if (mapped) return mapped;
        const cid = Number(conversationId) as ConversationId;
        if (harnessRef && Number.isFinite(cid)) {
          try {
            const obs = await harnessRef.observeConversation(
              cid,
              { advance: () => {}, end: () => {} },
              BACKGROUND_CONTEXT,
            );
            try {
              const liveDoc = obs.value.docs["pi.live"] as
                | { run?: { taskId?: number; inputs?: number[]; first?: number } }
                | undefined;
              const run = liveDoc?.run;
              if (run && (Array.isArray(run.inputs) && run.inputs.length > 0)) {
                return `run:${conversationId}:subs:${run.inputs.join(",")}:first:${run.first ?? "none"}`;
              }
              if (run && run.taskId !== undefined) {
                return `run:${conversationId}:task:${run.taskId}:first:${run.first ?? "none"}`;
              }
            } finally {
              obs.detach();
            }
          } catch {
            // fallback to task owner walk below
          }
        }
        if (!harnessRef) return `task:${taskId}`;
        let curId = Number(taskId);
        const visited = new Set<number>();
        while (Number.isFinite(curId) && !visited.has(curId)) {
          visited.add(curId);
          const rec = await harnessRef.getTask(curId as TaskId, BACKGROUND_CONTEXT);
          if (!rec) break;
          if (rec.owner === undefined || rec.owner === null) {
            return `pitask:${rec.id}`;
          }
          curId = rec.owner;
        }
        return `task:${taskId}`;
      };
      const changeListeners = new Set<(ev: ConversationLiveChange) => void>();
      const emitChange = (ev: ConversationLiveChange): void => {
        for (const fn of [...changeListeners]) {
          try {
            fn(ev);
          } catch {
            // ignore listener error
          }
        }
        const parentCid = parentByWorkerConv.get(ev.conversationId);
        if (parentCid && parentCid !== ev.conversationId) {
          for (const fn of [...changeListeners]) {
            try {
              fn({ ...ev, conversationId: parentCid });
            } catch {
              // ignore listener error
            }
          }
        }
      };
      let harnessRef: HarnessInstance | null = null;

      // Hydrate persisted budget task bindings for the active epoch from aegis-gov.sqlite (survives restarts!)
      for (const b of listPersistedBudgetBindings(govDb, epochBox.current)) {
        if (b.binding_kind === "PI_TASK") {
          const tid = Number(b.binding_key);
          const cid = Number(b.conversation_id);
          if (Number.isFinite(tid)) {
            taskBudgetOwner.set(tid, {
              ownerTaskId: b.owner_task_id,
              purpose: b.purpose,
              conversationId: b.conversation_id,
            });
            if (Number.isFinite(cid)) {
              knownTaskConversation.set(tid, cid);
            }
          }
        } else if (b.binding_kind === "CONVERSATION") {
          const cid = Number(b.binding_key);
          if (Number.isFinite(cid)) {
            conversationBudgetOwner.set(cid, {
              ownerTaskId: b.owner_task_id,
              purpose: b.purpose,
            });
          }
        }
      }

      const telemetry = new HostPhaseTelemetry();
      const resolveBudgetOwner = (attr: PhaseAttribution, _model: Model<Api>): ResolvedBudgetOwner | null => {
        const activeEpoch = epochBox.current;
        // 1. Authoritative per-Pi-task binding wins (handles concurrent compaction & generation in same conversation!)
        const direct = taskBudgetOwner.get(attr.taskId);
        if (direct) {
          return {
            conversationId: direct.conversationId,
            ownerTaskId: direct.ownerTaskId,
            purpose: attr.taskName === "pi.compaction" ? "compaction" : direct.purpose,
          };
        }
        const persistedTask = getPersistedBudgetBinding(govDb!, {
          runtimeEpoch: activeEpoch,
          bindingKind: "PI_TASK",
          bindingKey: String(attr.taskId),
        });
        if (persistedTask) {
          taskBudgetOwner.set(attr.taskId, {
            ownerTaskId: persistedTask.owner_task_id,
            purpose: persistedTask.purpose,
            conversationId: persistedTask.conversation_id,
          });
          return {
            conversationId: persistedTask.conversation_id,
            ownerTaskId: persistedTask.owner_task_id,
            purpose: attr.taskName === "pi.compaction" ? "compaction" : persistedTask.purpose,
          };
        }

        // 2. Authoritative persisted conversation binding (e.g. after restart or normal router/worker turns)
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
          const persistedConv = getPersistedBudgetBinding(govDb!, {
            runtimeEpoch: activeEpoch,
            bindingKind: "CONVERSATION",
            bindingKey: String(convId),
          });
          if (persistedConv) {
            conversationBudgetOwner.set(convId, {
              ownerTaskId: persistedConv.owner_task_id,
              purpose: persistedConv.purpose,
            });
            return {
              conversationId: String(convId),
              ownerTaskId: persistedConv.owner_task_id,
              purpose: attr.taskName === "pi.compaction" ? "compaction" : persistedConv.purpose,
            };
          }
        }

        // 3. Fail closed: never synthesize a fresh default-quota task account for an unattributed task!
        return null;
      };

      const resolveScopeRow = (conversationId: string): { scopeId: string; principalId: string } => {
        const row = govDb!
          .prepare("SELECT scope_id, principal_id FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?")
          .get(epochBox.current, conversationId) as { scope_id: string; principal_id: string } | undefined;
        return {
          scopeId: row?.scope_id ?? defaultScopeId,
          principalId: row?.principal_id ?? defaultPrincipalId,
        };
      };
      const resolveScopeId = (conversationId: string): string => resolveScopeRow(conversationId).scopeId;

      const modelsController = createHostModelsEgress({
        govDb,
        getRuntimeEpoch: () => epochBox.current,
        vault: config.vault,
        telemetry,
        slots: config.modelSlots,
        resolveBudgetOwner,
        resolveConversationAuth: (conversationId) => resolveScopeRow(conversationId),
        now: nowFn,
        zone: config.zone,
        defaultTaskLimitMu: config.defaultTaskLimitMu,
        defaultDayLimitMu: config.defaultDayLimitMu,
        settleTimeoutMs: config.settleTimeoutMs,
        shouldFailBeforeTransport: config.shouldFailBeforeTransport,
        injectFaultAfterFirstAccount: config.injectFaultAfterFirstAccount,
        onTransportDispatch: config.onTransportDispatch,
        fetchImpl: config.fetchImpl,
        onHttpFetchAttempt: config.onHttpFetchAttempt,
        onReservationRecorded: config.onReservationRecorded,
      });

      const workerSlot = config.modelSlots.find((s) => s.slotName === "worker") ?? config.modelSlots[0];
      const routerSlot = config.modelSlots.find((s) => s.slotName === "router") ?? config.modelSlots[0];
      const registry = createRegistry();
      if (!config.faultInjectMissingPolicyHook) {
        let contextExtRef: ReturnType<typeof createAegisContextExtension> | null = null;
        const policyExt = createAegisPolicyExtension({
          govDb,
          vault: config.vault,
          getRuntimeEpoch: () => epochBox.current,
          resolveScopeId,
          resolveConversationAuth: (conversationId) => resolveScopeRow(conversationId),
          smtpConfig: config.smtpConfig,
          imapEndpoint: () =>
            typeof config.imapEndpoint === "function"
              ? config.imapEndpoint()
              : (config.imapEndpoint ?? null),
          githubMcpBridge: () =>
            typeof config.githubMcpBridge === "function"
              ? config.githubMcpBridge()
              : (config.githubMcpBridge ?? null),
          workspaceWriteHandler: config.workspaceWriteHandler,
          resolveExecutionRootTaskId,
          approvalTtlMs: config.approvalTtlMs,
          onGovernanceMutated: (conversationId, reason) => {
            emitChange({ conversationId, kind: "governance", detail: { reason } });
          },
          now: nowFn,
          onBeforeToolAfterProposal: config.onBeforeToolAfterProposal,
          onAfterClaimBeforeTransport: config.onAfterClaimBeforeTransport,
          onBeforeClaim: config.onBeforeClaim,
          tamperFinalPayloadForTest: config.tamperFinalPayloadForTest,
          runWorkerDelegation: async ({ parentConversationId, parentTaskId, prompt }) => {
            if (!harnessRef || !workerSlot) {
              return { ok: false, text: "", error: "Harness or worker slot unavailable" };
            }
            const activeEpoch = epochBox.current;
            const parentTidNum = Number(parentTaskId);
            const parentCidNum = Number(parentConversationId);
            const parentOwnerTaskId =
              (Number.isFinite(parentTidNum) ? taskBudgetOwner.get(parentTidNum)?.ownerTaskId : undefined) ??
              getPersistedBudgetBinding(govDb!, {
                runtimeEpoch: activeEpoch,
                bindingKind: "PI_TASK",
                bindingKey: parentTaskId,
              })?.owner_task_id ??
              (Number.isFinite(parentCidNum) ? conversationBudgetOwner.get(parentCidNum)?.ownerTaskId : undefined) ??
              getPersistedBudgetBinding(govDb!, {
                runtimeEpoch: activeEpoch,
                bindingKind: "CONVERSATION",
                bindingKey: parentConversationId,
              })?.owner_task_id;

            if (!parentOwnerTaskId) {
              return {
                ok: false,
                text: "",
                error: `unknown_budget_owner: parent conversation ${parentConversationId} / task ${parentTaskId} has no bound host budget task`,
              };
            }

            const parentScope = resolveScopeRow(parentConversationId);
            const workerConv = await harnessRef.createConversation(
              {
                ownership: { kind: "ownerless" },
                agent: {
                  model: { provider: workerSlot.provider, modelId: workerSlot.modelId },
                  extensions: contextExtRef ? [policyExt, contextExtRef] : [policyExt],
                },
              },
              BACKGROUND_CONTEXT,
            );
            conversationBudgetOwner.set(workerConv.id, {
              ownerTaskId: parentOwnerTaskId,
              purpose: "worker",
            });
            persistBudgetTaskBinding(govDb!, {
              runtimeEpoch: activeEpoch,
              bindingKind: "CONVERSATION",
              bindingKey: String(workerConv.id),
              conversationId: String(workerConv.id),
              ownerTaskId: parentOwnerTaskId,
              purpose: "worker",
              now: nowFn(),
              overwrite: true,
            });
            registerConversationScope(govDb!, {
              conversationId: String(workerConv.id),
              scopeId: parentScope.scopeId,
              principalId: parentScope.principalId,
              runtimeEpoch: activeEpoch,
              now: nowFn(),
            });
            // Inherit parent provenance/taint into worker BEFORE worker model call (V02 disclosure propagation!)
            inheritConversationSources(govDb!, {
              runtimeEpoch: activeEpoch,
              fromConversationId: parentConversationId,
              toConversationId: String(workerConv.id),
              principalId: parentScope.principalId,
              now: nowFn(),
            });
            const workerEntry: {
              workerConversationId: string;
              parentConversationId: string;
              ownerTaskId: string;
              status: "running" | "done" | "error";
              slotName: string;
              summary?: string;
              updatedAt: number;
            } = {
              workerConversationId: String(workerConv.id),
              parentConversationId,
              ownerTaskId: parentOwnerTaskId,
              status: "running",
              slotName: workerSlot.slotName,
              updatedAt: nowFn(),
            };
            const list = workerTasksByParent.get(parentConversationId) ?? [];
            list.push(workerEntry);
            workerTasksByParent.set(parentConversationId, list);
            parentByWorkerConv.set(String(workerConv.id), parentConversationId);
            const parentExecRoot = await resolveExecutionRootTaskId(parentConversationId, parentTaskId);
            workerExecutionRootByConv.set(String(workerConv.id), parentExecRoot);
            emitChange({
              conversationId: parentConversationId,
              kind: "pi_task_graph",
              detail: { workerConversationId: String(workerConv.id), status: "running" },
            });

            const sub = await workerConv.submit({ type: "input", content: prompt }, BACKGROUND_CONTEXT);
            const settled = await sub.wait(BACKGROUND_CONTEXT);
            // Propagate any sources read by the worker back into parent conversation provenance!
            inheritConversationSources(govDb!, {
              runtimeEpoch: activeEpoch,
              fromConversationId: String(workerConv.id),
              toConversationId: parentConversationId,
              principalId: parentScope.principalId,
              now: nowFn(),
            });
            if (settled.status === "done") {
              const ctxView = await workerConv.context(BACKGROUND_CONTEXT);
              const lastMsg = [...ctxView.messages].reverse().find((m) => m.role === "assistant");
              const text =
                lastMsg && Array.isArray(lastMsg.content)
                  ? lastMsg.content
                      .map((b) => (b.type === "text" ? b.text : ""))
                      .join("\n")
                  : "ok";
              workerEntry.status = "done";
              workerEntry.summary = text.slice(0, 200);
              workerEntry.updatedAt = nowFn();
              emitChange({
                conversationId: parentConversationId,
                kind: "worker_completed",
                detail: { workerConversationId: String(workerConv.id), status: "done" },
              });
              return { ok: true, text, workerConversationId: workerConv.id };
            }
            workerEntry.status = "error";
            workerEntry.summary = `worker_${settled.reason}: ${String(settled.detail ?? "")}`;
            workerEntry.updatedAt = nowFn();
            emitChange({
              conversationId: parentConversationId,
              kind: "worker_completed",
              detail: { workerConversationId: String(workerConv.id), status: "error" },
            });
            return {
              ok: false,
              text: "",
              error: `worker_${settled.reason}: ${String(settled.detail ?? "")}`,
              workerConversationId: workerConv.id,
            };
          },
        });
        registry.install(policyExt);

        const contextExt = createAegisContextExtension({
          govDb,
          getRuntimeEpoch: () => epochBox.current,
          resolveConversationAuth: (conversationId) => {
            const s = resolveScopeRow(conversationId);
            return { ...s, domain: config.defaultMemoryDomain ?? "default" };
          },
          resolveModelDestinationForConversation: (conversationId) => {
            const cidNum = Number(conversationId);
            const binding = Number.isFinite(cidNum) ? conversationBudgetOwner.get(cidNum) : undefined;
            const slot = binding?.purpose === "worker" ? workerSlot : routerSlot;
            if (!slot) return null;
            return {
              provider: slot.provider,
              modelId: slot.modelId,
              baseUrl: slot.baseUrl,
              slotName: slot.slotName,
            };
          },
          now: nowFn,
        });
        contextExtRef = contextExt;
        registry.install(contextExt);
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
            const touchedConvs = new Set<string>();
            for (const node of Object.values(call.value.tasks)) {
              knownTaskConversation.set(node.id, node.conversationId);
              touchedConvs.add(String(node.conversationId));
              if (node.owner !== undefined && !taskBudgetOwner.has(node.id)) {
                const ownerBinding = taskBudgetOwner.get(node.owner);
                if (ownerBinding) {
                  const childPurpose: BudgetPurpose =
                    node.kind === "pi.compaction" ? "compaction" : ownerBinding.purpose;
                  taskBudgetOwner.set(node.id, {
                    ownerTaskId: ownerBinding.ownerTaskId,
                    purpose: childPurpose,
                    conversationId: String(node.conversationId),
                  });
                  try {
                    persistBudgetTaskBinding(govDb!, {
                      runtimeEpoch: epochBox.current,
                      bindingKind: "PI_TASK",
                      bindingKey: String(node.id),
                      conversationId: String(node.conversationId),
                      ownerTaskId: ownerBinding.ownerTaskId,
                      purpose: childPurpose,
                      now: nowFn(),
                      overwrite: false,
                    });
                  } catch {
                    // ignore if DB closing during shutdown
                  }
                }
              }
            }
            for (const cidStr of touchedConvs) {
              emitChange({ conversationId: cidStr, kind: "pi_task_graph" });
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
          runtimeEpoch: epochBox.current,
          traceIdentity: epoch.trace_identity,
          govPragmas: opened.pragmas,
          recoveredSubmittingToUnknown,
          expiredApprovals,
          chargedBoundReservations,
          pairedCheck: { ok: true, observedChangeCounter: 0 },
          reconciledQuarantinedEffects: [],
          reconciledChatCommands: [],
          reconciledFileImports: [],
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
          epochBox,
          taskBudgetOwner,
          conversationBudgetOwner,
          knownTaskConversation,
          workerTasksByParent,
          changeListeners,
          now: nowFn,
        });
      }

      // Observe trace lineage anchor & known conversations/tasks strictly read-only with FULL cursor pagination!
      const anchorConv = await harness.conversation(1 as ConversationId, BACKGROUND_CONTEXT);
      let anchorFoundIdentity: string | null = null;
      let currentWatermark = 0;
      if (anchorConv) {
        const rootScan = await scanAllConversationEntries(anchorConv);
        currentWatermark += rootScan.totalCount;
        anchorFoundIdentity = rootScan.anchorTraceIdentity;
      }

      // Also scan all known conversations & known Pi tasks from governance DB with full pagination
      const knownConvRows = govDb
        .prepare("SELECT conversation_id FROM conversation_scopes WHERE runtime_epoch = ?")
        .all(epochBox.current) as Array<{ conversation_id: string }>;
      const missingKnownConversationIds: number[] = [];
      for (const r of knownConvRows) {
        const cid = Number(r.conversation_id);
        if (!Number.isFinite(cid)) continue;
        const c = await harness.conversation(cid as ConversationId, BACKGROUND_CONTEXT);
        if (!c) {
          missingKnownConversationIds.push(cid);
        } else {
          const scan = await scanAllConversationEntries(c);
          currentWatermark += scan.totalCount;
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
          runtimeEpoch: epochBox.current,
          traceIdentity: epoch.trace_identity,
          govPragmas: opened.pragmas,
          recoveredSubmittingToUnknown,
          expiredApprovals,
          chargedBoundReservations,
          pairedCheck,
          reconciledQuarantinedEffects: [],
          reconciledChatCommands: [],
          reconciledFileImports: [],
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
          epochBox,
          taskBudgetOwner,
          conversationBudgetOwner,
          knownTaskConversation,
          workerTasksByParent,
          changeListeners,
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
              runtimeEpoch: epochBox.current,
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
        .all(epochBox.current) as Array<{ effect_id: string; tool_task_id: string; approval_id: string }>;

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

      // 5b: V04 Chat Command cross-DB reconciliation strictly BEFORE scheduling release / intake open!
      // Queries Pi's durable submissions via Tx.submissionByRequest (covers queued, placed, and completed submissions)
      // without calling resume(). Never infers admission from message text or last message!
      const reconciledChatCommands: ChatCommandReconcileReport[] = [];
      const unreconciledChats = listUnreconciledChatCommands(govDb, epochBox.current);
      for (const cmd of unreconciledChats) {
        const cidNum = Number(cmd.conversation_id) as ConversationId;
        const injectedFailure = config.injectChatReconcileReadFailure?.(cmd) ?? null;
        if (injectedFailure) {
          markChatCommandPendingReconcile(govDb, {
            commandId: cmd.command_id,
            reason: injectedFailure,
            now: nowFn(),
          });
          reconciledChatCommands.push({
            commandId: cmd.command_id,
            chatKey: cmd.chat_key,
            conversationId: cmd.conversation_id,
            piRequestId: cmd.pi_request_id,
            outcome: "pending_reconcile",
            reason: injectedFailure,
          });
          continue;
        }
        if (!Number.isFinite(cidNum)) {
          markChatCommandPendingReconcile(govDb, {
            commandId: cmd.command_id,
            reason: "invalid_conversation_id",
            now: nowFn(),
          });
          reconciledChatCommands.push({
            commandId: cmd.command_id,
            chatKey: cmd.chat_key,
            conversationId: cmd.conversation_id,
            piRequestId: cmd.pi_request_id,
            outcome: "pending_reconcile",
            reason: "invalid_conversation_id",
          });
          continue;
        }
        try {
          const conv = await harness.conversation(cidNum, BACKGROUND_CONTEXT);
          if (!conv) {
            markChatCommandPendingReconcile(govDb, {
              commandId: cmd.command_id,
              reason: "conversation_missing_on_reconcile",
              now: nowFn(),
            });
            reconciledChatCommands.push({
              commandId: cmd.command_id,
              chatKey: cmd.chat_key,
              conversationId: cmd.conversation_id,
              piRequestId: cmd.pi_request_id,
              outcome: "pending_reconcile",
              reason: "conversation_missing_on_reconcile",
            });
            continue;
          }
          const subRec = await conv.commit(
            async (tx) => tx.submissionByRequest(cidNum, cmd.pi_request_id),
            BACKGROUND_CONTEXT,
          );
          if (subRec) {
            if (subRec.type !== "input" || subRec.conversationId !== cidNum) {
              markChatCommandPendingReconcile(govDb, {
                commandId: cmd.command_id,
                reason: "pi_submission_lineage_conflict",
                now: nowFn(),
              });
              reconciledChatCommands.push({
                commandId: cmd.command_id,
                chatKey: cmd.chat_key,
                conversationId: cmd.conversation_id,
                piRequestId: cmd.pi_request_id,
                outcome: "pending_reconcile",
                reason: "pi_submission_lineage_conflict",
              });
            } else {
              recordChatCommandAdmitted(govDb, {
                commandId: cmd.command_id,
                submissionId: Number(subRec.id),
                reconciled: true,
                now: nowFn(),
              });
              reconciledChatCommands.push({
                commandId: cmd.command_id,
                chatKey: cmd.chat_key,
                conversationId: cmd.conversation_id,
                piRequestId: cmd.pi_request_id,
                outcome: "admitted_backfilled",
                submissionId: Number(subRec.id),
              });
            }
          } else {
            // Provably absent on verified same-lineage active epoch: verify permission is still valid.
            const convScope = govDb
              .prepare(
                "SELECT scope_id, principal_id FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?",
              )
              .get(epochBox.current, cmd.conversation_id) as { scope_id: string; principal_id: string } | undefined;
            const scope = convScope
              ? (govDb.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(convScope.scope_id) as ScopeRow | undefined)
              : undefined;
            const permOk =
              Boolean(convScope && scope) &&
              convScope!.principal_id === cmd.principal_id &&
              scope!.cancelled === 0 &&
              isPrincipalAuthorizedForScope(scope!, cmd.principal_id);
            if (!permOk) {
              markChatCommandPendingReconcile(govDb, {
                commandId: cmd.command_id,
                reason: "permission_invalid_during_reconcile",
                now: nowFn(),
              });
              reconciledChatCommands.push({
                commandId: cmd.command_id,
                chatKey: cmd.chat_key,
                conversationId: cmd.conversation_id,
                piRequestId: cmd.pi_request_id,
                outcome: "pending_reconcile",
                reason: "permission_invalid_during_reconcile",
              });
            } else {
              reconciledChatCommands.push({
                commandId: cmd.command_id,
                chatKey: cmd.chat_key,
                conversationId: cmd.conversation_id,
                piRequestId: cmd.pi_request_id,
                outcome: "kept_registered",
                reason: "provably_unadmitted_safe_to_retry",
              });
            }
          }
        } catch (err) {
          const reason = `pi_reconcile_read_error:${err instanceof Error ? err.message : String(err)}`;
          markChatCommandPendingReconcile(govDb, {
            commandId: cmd.command_id,
            reason,
            now: nowFn(),
          });
          reconciledChatCommands.push({
            commandId: cmd.command_id,
            chatKey: cmd.chat_key,
            conversationId: cmd.conversation_id,
            piRequestId: cmd.pi_request_id,
            outcome: "pending_reconcile",
            reason,
          });
        }
      }

      // 5c: W2-S3 Managed File Import receipt-loss reconciliation strictly BEFORE scheduling release!
      const reconciledFileImports: FileImportReconcileReport[] = config.managedWorkspaceImporter
        ? config.managedWorkspaceImporter.reconcilePendingImportsOnStartup(govDb, epochBox.current, nowFn())
        : [];

      // STEP 6: Release recovery scheduling and open intake
      const report: StartupReport = {
        health: "READY",
        runtimeEpoch: epochBox.current,
        traceIdentity: epoch.trace_identity,
        govPragmas: opened.pragmas,
        recoveredSubmittingToUnknown,
        expiredApprovals,
        chargedBoundReservations,
        pairedCheck,
        reconciledQuarantinedEffects,
        reconciledChatCommands,
        reconciledFileImports,
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
        epochBox,
        taskBudgetOwner,
        conversationBudgetOwner,
        knownTaskConversation,
        workerTasksByParent,
        changeListeners,
        now: nowFn,
      });

      // W2-S1: Allow caller (e.g. formal entrypoint) to bind hostRef and connect MCP/connector dependencies
      // STRICTLY BEFORE harness.resume() releases any suspended/recovered Pi tasks!
      if (config.beforeResume) {
        await config.beforeResume(host);
      }

      // Enable Pi scheduler ONLY AFTER Steps 1-5 and beforeResume connector readiness passed
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
   * Updates the shared epochBox so Models, aegis-policy, and runtime all use newEpoch immediately.
   */
  async rotateEpochAfterMismatch(reason: string): Promise<{
    retiredEpoch: string;
    newEpoch: string;
    quarantinedReadyEffectIds: string[];
    isolatedOutboxIds: string[];
    preservedHeldReservationIds: string[];
  }> {
    const res = isolateAndRotateEpoch(this.govDb, { reason, now: this.#now() });
    this.#epochBox.current = res.newEpoch.runtime_epoch;
    this.#taskBudgetOwner.clear();
    this.#conversationBudgetOwner.clear();

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
    await this.syncPairedManifestWatermark();
    this.#health = "READY";
    if (!this.config.pauseOutboxDelivery) {
      this.#outboxDeliveryEnabled = true;
    }
    this.#startMaintenanceLoop();
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
      runtimeEpoch: this.#epochBox.current,
      now: this.#now(),
    });
    const effectiveBudgetTaskId = opts?.budgetTaskId ?? `host-task:${this.#epochBox.current}:conv:${conv.id}`;
    this.bindConversationBudgetOwner(conv.id, effectiveBudgetTaskId, opts?.slotName ?? "router", { overwrite: true });
    await this.syncPairedManifestWatermark();
    return conv;
  }

  getConversationBudgetTaskId(conversationId: string, runtimeEpoch?: string): string | null {
    const targetEpoch = runtimeEpoch ?? this.#epochBox.current;
    if (targetEpoch === this.#epochBox.current) {
      const cid = Number(conversationId);
      if (Number.isFinite(cid)) {
        const cached = this.#conversationBudgetOwner.get(cid);
        if (cached) return cached.ownerTaskId;
      }
    }
    const row = getPersistedBudgetBinding(this.govDb, {
      runtimeEpoch: targetEpoch,
      bindingKind: "CONVERSATION",
      bindingKey: conversationId,
    });
    return row?.owner_task_id ?? null;
  }

  async submitChatCommand(params: {
    principalId: string;
    runtimeEpoch: string;
    conversationId: string;
    chatKey: string;
    content: string;
  }): Promise<SubmitChatCommandResult> {
    if (!this.isAcceptingCommands) {
      return {
        ok: false,
        httpStatus: 503,
        code: "host_not_ready",
        message: `Host health is ${this.#health}`,
      };
    }
    const activeEpoch = this.#epochBox.current;
    if (params.runtimeEpoch !== activeEpoch) {
      return {
        ok: false,
        httpStatus: 409,
        code: "runtime_epoch_mismatch",
        message: `Command targets runtimeEpoch ${params.runtimeEpoch}, active epoch is ${activeEpoch}`,
        runtimeEpoch: activeEpoch,
      };
    }
    const cid = Number(params.conversationId) as ConversationId;
    if (!Number.isFinite(cid)) {
      return { ok: false, httpStatus: 400, code: "invalid_conversation_id" };
    }
    if (!params.chatKey || params.chatKey.trim().length === 0) {
      return { ok: false, httpStatus: 400, code: "missing_chat_key" };
    }
    if (!params.content || typeof params.content !== "string") {
      return { ok: false, httpStatus: 400, code: "missing_content" };
    }

    const convScope = this.govDb
      .prepare(
        "SELECT scope_id, principal_id FROM conversation_scopes WHERE runtime_epoch = ? AND conversation_id = ?",
      )
      .get(activeEpoch, params.conversationId) as { scope_id: string; principal_id: string } | undefined;
    const scope = convScope
      ? (this.govDb.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(convScope.scope_id) as ScopeRow | undefined)
      : undefined;
    if (
      !convScope ||
      convScope.principal_id !== params.principalId ||
      !scope ||
      scope.cancelled === 1 ||
      !isPrincipalAuthorizedForScope(scope, params.principalId)
    ) {
      return { ok: false, httpStatus: 403, code: "forbidden" };
    }

    const bound = this.getConversationBudgetTaskId(params.conversationId, activeEpoch);
    if (!bound) {
      return { ok: false, httpStatus: 404, code: "unknown_budget_owner" };
    }

    const inflightKey = `${params.principalId}|${activeEpoch}|${params.conversationId}|${params.chatKey}`;
    const reg = registerOrLookupChatCommand(this.govDb, {
      principalId: params.principalId,
      runtimeEpoch: activeEpoch,
      conversationId: params.conversationId,
      chatKey: params.chatKey,
      content: params.content,
      now: this.#now(),
    });

    if (reg.action === "conflict") {
      return {
        ok: false,
        httpStatus: 409,
        code: "chat_key_conflict",
        message: "chatKey was already registered with different content",
        commandId: reg.command.command_id,
        chatKey: reg.command.chat_key,
        piRequestId: reg.command.pi_request_id,
        submissionId: reg.command.submission_id,
        status: reg.command.status,
        uiStatusLabel: chatCommandUiStatusLabel(reg.command.status),
        conversationId: params.conversationId,
        runtimeEpoch: activeEpoch,
      };
    }

    if (reg.action === "already_admitted") {
      return {
        ok: true,
        httpStatus: 200,
        code: "idempotent_replay",
        idempotentReplay: true,
        commandId: reg.command.command_id,
        chatKey: reg.command.chat_key,
        piRequestId: reg.command.pi_request_id,
        submissionId: reg.command.submission_id,
        status: reg.command.status,
        uiStatusLabel: chatCommandUiStatusLabel(reg.command.status),
        conversationId: params.conversationId,
        runtimeEpoch: activeEpoch,
      };
    }

    if (reg.action === "pending_reconcile") {
      return {
        ok: true,
        httpStatus: 202,
        code: "pending_reconcile",
        message: "受理待核对：无法确认 Pi 受理结果，已停止自动重复提交",
        idempotentReplay: true,
        commandId: reg.command.command_id,
        chatKey: reg.command.chat_key,
        piRequestId: reg.command.pi_request_id,
        submissionId: null,
        status: "PENDING_RECONCILE",
        uiStatusLabel: chatCommandUiStatusLabel("PENDING_RECONCILE"),
        conversationId: params.conversationId,
        runtimeEpoch: activeEpoch,
      };
    }

    // Serialize concurrent identical chatKey submissions in-process
    const existingInflight = this.#inFlightChatAdmissions.get(inflightKey);
    if (existingInflight) {
      return await existingInflight;
    }

    const admitPromise = (async (): Promise<SubmitChatCommandResult> => {
      const cmd = reg.command;
      this.emitConversationChange({
        conversationId: params.conversationId,
        kind: "governance",
        detail: { commandId: cmd.command_id, status: "REGISTERED" },
      });

      if (this.config.onAfterChatGovRegister) {
        await this.config.onAfterChatGovRegister(cmd);
      }

      const conv = await this.harness.conversation(cid, BACKGROUND_CONTEXT);
      if (!conv) {
        return { ok: false, httpStatus: 404, code: "conversation_not_found" };
      }

      const sub = await conv.submit(
        {
          type: "input",
          content: params.content,
          requestId: cmd.pi_request_id,
        },
        BACKGROUND_CONTEXT,
      );
      const submissionId = Number(sub.id);

      if (this.config.onAfterPiAdmitBeforeGovReceipt) {
        await this.config.onAfterPiAdmitBeforeGovReceipt({
          commandId: cmd.command_id,
          piRequestId: cmd.pi_request_id,
          submissionId,
          conversationId: params.conversationId,
        });
      }

      recordChatCommandAdmitted(this.govDb, {
        commandId: cmd.command_id,
        submissionId,
        now: this.#now(),
      });

      this.emitConversationChange({
        conversationId: params.conversationId,
        kind: "governance",
        detail: { commandId: cmd.command_id, status: "ADMITTED", submissionId },
      });

      if (this.config.onAfterChatGovReceiptBeforeHttp) {
        await this.config.onAfterChatGovReceiptBeforeHttp({
          commandId: cmd.command_id,
          piRequestId: cmd.pi_request_id,
          submissionId,
          conversationId: params.conversationId,
        });
      }

      return {
        ok: true,
        httpStatus: 200,
        code: "admitted",
        idempotentReplay: !reg.created,
        commandId: cmd.command_id,
        chatKey: cmd.chat_key,
        piRequestId: cmd.pi_request_id,
        submissionId,
        status: "ADMITTED",
        uiStatusLabel: chatCommandUiStatusLabel("ADMITTED"),
        conversationId: params.conversationId,
        runtimeEpoch: activeEpoch,
      };
    })();

    this.#inFlightChatAdmissions.set(inflightKey, admitPromise);
    try {
      return await admitPromise;
    } finally {
      this.#inFlightChatAdmissions.delete(inflightKey);
    }
  }

  async submitChatInput(params: {
    conversationId: string;
    content: string;
    requestId?: string;
  }): Promise<{ ok: true; submissionId: number } | { ok: false; code: string }> {
    const cid = Number(params.conversationId) as ConversationId;
    if (!Number.isFinite(cid)) return { ok: false, code: "invalid_conversation_id" };
    const bound = this.getConversationBudgetTaskId(params.conversationId, this.#epochBox.current);
    if (!bound) return { ok: false, code: "unknown_budget_owner" };
    const conv = await this.harness.conversation(cid, BACKGROUND_CONTEXT);
    if (!conv) return { ok: false, code: "conversation_not_found" };
    const sub = await conv.submit(
      {
        type: "input",
        content: params.content,
        ...(params.requestId ? { requestId: params.requestId } : {}),
      },
      BACKGROUND_CONTEXT,
    );
    return { ok: true, submissionId: Number(sub.id) };
  }

  async attachConversationObserver(params: {
    conversationId: string;
    onUpdate: (kind: "pi_view" | "pi_task_graph", detail?: Record<string, unknown>) => void;
    onEnd: (reason: string) => void;
  }): Promise<{ detach: () => void } | null> {
    const cid = Number(params.conversationId) as ConversationId;
    if (!Number.isFinite(cid)) return null;
    try {
      const obs = await this.harness.observeConversation(
        cid,
        {
          advance: (call) => {
            if (call.kind === "value") {
              params.onUpdate("pi_view", { entries: call.value.entries.length });
            }
          },
          end: (end) => {
            params.onEnd(end.kind);
          },
        },
        BACKGROUND_CONTEXT,
      );
      const offChange = this.onConversationChange((ev) => {
        if (ev.conversationId === params.conversationId) {
          params.onUpdate(ev.kind === "pi_view" ? "pi_view" : "pi_task_graph", ev.detail);
        }
      });
      return {
        detach: () => {
          offChange();
          obs.detach();
        },
      };
    } catch {
      return null;
    }
  }

  async readConversationLiveState(conversationId: string): Promise<ConversationLiveSummary> {
    const messages = await this.readConversationMessages(conversationId);
    const workerTasks = (this.#workerTasksByParent.get(conversationId) ?? []).map((w) => ({ ...w }));
    const cid = Number(conversationId) as ConversationId;
    if (!Number.isFinite(cid)) {
      return { messages, livePartial: null, activeTools: [], workerTasks };
    }
    let livePartial: { text: string; attempt: number } | null = null;
    const activeTools: Array<{ callId: string; name: string; status: string }> = [];
    try {
      const conv = await this.harness.conversation(cid, BACKGROUND_CONTEXT);
      if (conv) {
        const obs = await this.harness.observeConversation(
          cid,
          { advance: () => {}, end: () => {} },
          BACKGROUND_CONTEXT,
        );
        try {
          const liveDoc = obs.value.docs["pi.live"] as
            | {
                generation?: {
                  attempt?: number;
                  message?: { content?: Array<{ type?: string; text?: string }> };
                };
                tools?: Array<{ callId: string; name: string; status: string }>;
              }
            | undefined;
          if (liveDoc?.generation?.message?.content) {
            const text = liveDoc.generation.message.content
              .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
              .join("");
            if (text.length > 0) {
              livePartial = { text, attempt: liveDoc.generation.attempt ?? 1 };
            }
          }
          if (Array.isArray(liveDoc?.tools)) {
            for (const t of liveDoc.tools) {
              activeTools.push({ callId: t.callId, name: t.name, status: t.status });
            }
          }
        } finally {
          obs.detach();
        }
      }
    } catch {
      // ignore if conversation not active
    }
    return { messages, livePartial, activeTools, workerTasks };
  }

  async triggerCompaction(params: {
    conversationId: string;
    instructions?: string;
    /** Trusted host-internal override ONLY (e.g. S4 dual-task concurrency fixture). Ordinary Web routes MUST omit this. */
    budgetTaskId?: string;
  }): Promise<{ ok: true; compactionTaskId: number } | { ok: false; code: string }> {
    const cid = Number(params.conversationId) as ConversationId;
    if (!Number.isFinite(cid)) return { ok: false, code: "invalid_conversation_id" };
    const effectiveOwner =
      params.budgetTaskId ?? this.getConversationBudgetTaskId(params.conversationId, this.#epochBox.current);
    if (!effectiveOwner) {
      return { ok: false, code: "unknown_budget_owner" };
    }
    const conv = await this.harness.conversation(cid, BACKGROUND_CONTEXT);
    if (!conv) return { ok: false, code: "conversation_not_found" };
    const compactTaskId = await conv.compact(
      params.instructions ?? "Summarize conversation",
      BACKGROUND_CONTEXT,
    );
    this.bindPiTaskBudgetOwner(compactTaskId, cid, effectiveOwner, "compaction", { overwrite: true });
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
      .all(this.#epochBox.current) as Array<{ conversation_id: string }>;

    let watermark = 0;
    const rootConv = await this.harness.conversation(1 as ConversationId, BACKGROUND_CONTEXT);
    if (rootConv) {
      const rootScan = await scanAllConversationEntries(rootConv);
      watermark += rootScan.totalCount;
    }
    for (const r of convRows) {
      const cid = Number(r.conversation_id);
      if (!Number.isFinite(cid)) continue;
      const c = await this.harness.conversation(cid as ConversationId, BACKGROUND_CONTEXT);
      if (c) {
        const scan = await scanAllConversationEntries(c);
        watermark += scan.totalCount;
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
   * Explicitly invokes SDK harness.signal for an approval's tool task to test/record
   * duplicate wakeup behavior (R4 / W1-B) without mutating already-consumed effects.
   */
  async replayApprovalSignal(approvalId: string): Promise<{
    sdkResult: SdkSignalOutcome;
    deliveryKey: string;
    duplicateCheck: DuplicateCheckOutcome | null;
    outbox: Record<string, unknown> | null;
    effect: Record<string, unknown> | null;
  }> {
    const row = this.govDb
      .prepare(
        `SELECT o.approval_id, o.signal_key, o.state AS outbox_state, o.sdk_result, o.reason AS outbox_reason,
                a.proposal_id, a.revision, a.state AS approval_state,
                p.runtime_epoch, p.tool_task_id
           FROM signal_outbox o
           JOIN approvals a ON a.approval_id = o.approval_id
           JOIN proposals p ON p.proposal_id = a.proposal_id
          WHERE o.approval_id = ?`,
      )
      .get(approvalId) as
      | {
          approval_id: string;
          signal_key: string;
          outbox_state: string;
          sdk_result: string | null;
          outbox_reason: string | null;
          proposal_id: string;
          revision: number;
          approval_state: string;
          runtime_epoch: string;
          tool_task_id: string;
        }
      | undefined;
    if (!row) {
      throw new Error(`No signal_outbox row found for approval ${approvalId}`);
    }
    const tid = Number(row.tool_task_id) as TaskId;
    const taskBefore = await this.harness.getTask(tid, BACKGROUND_CONTEXT);
    const proposalKeyPrefix = `sig:${row.runtime_epoch}:${row.proposal_id}:r`;
    const awaitedSignal =
      taskBefore?.state.status === "sleeping"
        ? taskBefore.state.signals?.find(
            (s) => s.signal === AegisApprovalSignal.name && s.key.startsWith(proposalKeyPrefix),
          )
        : undefined;
    const deliveryKey = awaitedSignal?.key ?? row.signal_key;
    const payload = {
      approvalId: row.approval_id,
      decision: row.approval_state,
      revision: row.revision,
    };
    const sdkResult = await this.harness.signal(
      tid,
      AegisApprovalSignal,
      deliveryKey,
      payload,
      BACKGROUND_CONTEXT,
    );
    let duplicateCheck: DuplicateCheckOutcome | null = null;
    if (sdkResult === "duplicate") {
      const latest = await this.harness.getTask(tid, BACKGROUND_CONTEXT);
      const memos = latest && "memos" in latest ? latest.memos : undefined;
      duplicateCheck = verifyDuplicateSignalValue(memos, AegisApprovalSignal.name, deliveryKey, payload);
    }
    const outbox =
      (this.govDb.prepare("SELECT * FROM signal_outbox WHERE approval_id = ?").get(approvalId) as
        | Record<string, unknown>
        | undefined) ?? null;
    const effect =
      (this.govDb.prepare("SELECT * FROM effects WHERE approval_id = ?").get(approvalId) as
        | Record<string, unknown>
        | undefined) ?? null;
    return { sdkResult, deliveryKey, duplicateCheck, outbox, effect };
  }

  /**
   * T3: Deliver pending signal_outbox entries to matching parked Pi tool tasks
   * and reconcile all 5 SDK outcomes (delivered, duplicate, invalid, closed, not_found).
   * On 'duplicate', verifies stored signal value in Pi task memos before ACKing;
   * mismatch or unverifiable value fails closed to ISOLATED + QUARANTINED.
   */
  async deliverPendingOutbox(opts?: { respectPause?: boolean }): Promise<
    Array<{
      approvalId: string;
      signalKey: string;
      sdkResult: string;
      duplicateCheck?: DuplicateCheckOutcome;
      action: string;
    }>
  > {
    if (this.#closed || this.#health !== "READY" || this.#drainingOutbox) return [];
    if (opts?.respectPause && !this.#outboxDeliveryEnabled) return [];
    this.#drainingOutbox = true;
    const results: Array<{
      approvalId: string;
      signalKey: string;
      sdkResult: string;
      duplicateCheck?: DuplicateCheckOutcome;
      action: string;
    }> = [];
    try {
      const items = listPendingOutboxItems(this.govDb, this.#epochBox.current);
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
          const alreadyConsumed = item.effect_state !== null && item.effect_state !== "READY";
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

        const proposalKeyPrefix = `sig:${item.runtime_epoch}:${item.proposal_id}:r`;
        const awaitedSignal =
          taskRec.state.status === "sleeping"
            ? taskRec.state.signals?.find(
                (s) => s.signal === AegisApprovalSignal.name && s.key.startsWith(proposalKeyPrefix),
              )
            : undefined;
        const deliveryKey = awaitedSignal?.key ?? item.signal_key;
        const existingMemo =
          "memos" in taskRec && taskRec.memos
            ? taskRec.memos[`pi.signal.${AegisApprovalSignal.name}/${deliveryKey}`]
            : undefined;

        if (taskRec.state.status !== "sleeping" && existingMemo === undefined) {
          continue;
        }

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

        let duplicateCheck: DuplicateCheckOutcome | undefined = undefined;
        if (sdkResult === "duplicate") {
          const latestTask = await this.harness.getTask(tid, BACKGROUND_CONTEXT);
          const memos = latestTask && "memos" in latestTask ? latestTask.memos : undefined;
          duplicateCheck = verifyDuplicateSignalValue(memos, AegisApprovalSignal.name, deliveryKey, payload);
        }

        const alreadyConsumed = item.effect_state !== null && item.effect_state !== "READY";
        const outcome = recordOutboxDeliveryOutcome(this.govDb, {
          approvalId: item.approval_id,
          sdkOutcome: sdkResult,
          duplicateCheck,
          taskObservedDecisionOrFinished: alreadyConsumed,
          now: this.#now(),
        });
        results.push({
          approvalId: item.approval_id,
          signalKey: item.signal_key,
          sdkResult,
          ...(duplicateCheck ? { duplicateCheck } : {}),
          action: outcome.outboxState === "ACKED" ? "acked" : "isolated",
        });
      }
    } finally {
      this.#drainingOutbox = false;
    }
    return results;
  }

  #startMaintenanceLoop(): void {
    if (this.#maintenanceTimer) return;
    this.#maintenanceTimer = setInterval(() => {
      if (this.#closed || this.#health !== "READY") return;
      try {
        chargeBoundExpiredReservations(this.govDb, { now: this.#now() });
      } catch {
        // ignore transient contention / shutdown race
      }
      if (this.#outboxDeliveryEnabled) {
        void this.deliverPendingOutbox().catch(() => {});
      }
    }, 40);
    this.#maintenanceTimer.unref();
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
    if (this.#maintenanceTimer) {
      clearInterval(this.#maintenanceTimer);
      this.#maintenanceTimer = null;
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
