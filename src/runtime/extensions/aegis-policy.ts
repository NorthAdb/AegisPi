import type { DatabaseSync } from "node:sqlite";
import {
  defineExtension,
  defineSignal,
  defineTool,
  hook,
  ToolTask,
  type Extension,
  type JsonObject,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
  proposeOrGetApproval,
  readProposalGovernanceState,
} from "../../governance/approvals.ts";
import { markOutboxObservedByReentry } from "../../governance/signal-outbox.ts";
import {
  submitApprovedEmailEffect,
  type EmailSubmissionPayload,
  type SmtpEndpointConfig,
} from "../submitter.ts";

export const AegisApprovalSignal = defineSignal({
  name: "aegis.approval.v2",
  version: 1,
  schema: {
    type: "object",
    properties: {
      approvalId: { type: "string" },
      decision: { type: "string" },
      revision: { type: "number" },
    },
    required: ["approvalId", "decision", "revision"],
  },
});

export const AEGIS_POLICY_EXTENSION_NAME = "aegis-policy";

export interface AegisPolicyExtensionOptions {
  govDb: DatabaseSync;
  getRuntimeEpoch: () => string;
  resolveScopeId: (conversationId: string) => string;
  smtpConfig: SmtpEndpointConfig;
  now?: () => number;
  approvalTtlMs?: number;
  /** Callback invoked when run_worker delegates to an isolated worker conversation/task. */
  runWorkerDelegation?: (params: {
    parentConversationId: string;
    parentTaskId: string;
    prompt: string;
  }) => Promise<{ ok: boolean; text: string; error?: string; workerConversationId?: number }>;
  /** Test seam for E01: allows pausing/hook after proposal creation and before returning sleep park. */
  onBeforeToolAfterProposal?: (info: {
    proposalId: string;
    approvalId: string;
    signalKey: string;
    conversationId: string;
    toolTaskId: string;
    callId: string;
  }) => void | Promise<void>;
  /** Test seam for E05: invoked after claim CAS and before SMTP transport. */
  onAfterClaimBeforeTransport?: (effectId: string) => void | Promise<void>;
  /** Test seam for E08: invoked before claim CAS. */
  onBeforeClaim?: (effectId: string) => void | Promise<void>;
  /** Test seam for E10: tamper final args right before submitter verification. */
  tamperFinalPayloadForTest?: (
    effectId: string,
    payload: EmailSubmissionPayload,
  ) => { payload: EmailSubmissionPayload; target?: string } | null;
}

function normalizeEmailPayload(raw: Record<string, unknown>): {
  payload: EmailSubmissionPayload;
  target: string;
} {
  const toRaw = raw["to"];
  const to = Array.isArray(toRaw)
    ? toRaw.map((x) => String(x).trim()).filter(Boolean)
    : typeof toRaw === "string"
      ? [toRaw.trim()].filter(Boolean)
      : [];
  const subject = String(raw["subject"] ?? "");
  const body = String(raw["body"] ?? "");
  const payload: EmailSubmissionPayload = {
    to,
    subject,
    body,
    ...(Array.isArray(raw["cc"]) ? { cc: (raw["cc"] as unknown[]).map(String) } : {}),
    ...(Array.isArray(raw["bcc"]) ? { bcc: (raw["bcc"] as unknown[]).map(String) } : {}),
    ...(Array.isArray(raw["attachmentDigests"])
      ? {
          attachmentDigests: raw["attachmentDigests"] as Array<{
            name: string;
            sha256: string;
            sizeBytes: number;
          }>,
        }
      : {}),
  };
  const target = `smtp:${to.join(",")}`;
  return { payload, target };
}

export function createAegisPolicyExtension(options: AegisPolicyExtensionOptions): Extension {
  const nowFn = options.now ?? (() => Date.now());
  const ttlMs = options.approvalTtlMs ?? 30 * 60 * 1000;

  const sendEmailTool = defineTool({
    name: "send_email",
    description: "Send an email through the sole host SMTP submitter after explicit Tier 2 approval.",
    replay: "unsafe",
    parameters: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
    async execute(args, api): Promise<ToolExecutionResult> {
      const runtimeEpoch = options.getRuntimeEpoch();
      const conversationId = String(api.conversationId);
      const toolTaskId = String(api.taskId);
      const callId = api.callId;

      const govState = readProposalGovernanceState(options.govDb, {
        runtimeEpoch,
        conversationId,
        toolTaskId,
        callId,
      });

      if (!govState || govState.state !== "APPROVED" || !govState.effectId) {
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: `Refused send_email: no approved READY effect in governance DB (state=${govState?.state ?? "missing"})`,
            },
          ],
        };
      }

      const norm = normalizeEmailPayload(args as Record<string, unknown>);
      let finalPayload = norm.payload;
      let finalTarget = norm.target;

      if (options.tamperFinalPayloadForTest) {
        const tampered = options.tamperFinalPayloadForTest(govState.effectId, finalPayload);
        if (tampered) {
          finalPayload = tampered.payload;
          if (tampered.target) finalTarget = tampered.target;
        }
      }

      const res = await submitApprovedEmailEffect({
        govDb: options.govDb,
        runtimeEpoch,
        effectId: govState.effectId,
        conversationId,
        toolTaskId,
        callId,
        toolName: "send_email",
        finalTarget,
        finalPayload,
        smtpConfig: options.smtpConfig,
        now: nowFn,
        onAfterClaimBeforeTransport: options.onAfterClaimBeforeTransport,
        onBeforeClaim: options.onBeforeClaim,
      });

      if (!res.ok) {
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: `send_email ${res.effectState} (${res.code}): ${res.message}`,
            },
          ],
          details: {
            effectId: res.effectId,
            effectState: res.effectState,
            code: res.code,
          },
        };
      }

      return {
        output: [
          {
            type: "text",
            text: `Email sent successfully. effectId=${res.effectId} receipt=${res.receiptRef ?? "ok"}`,
          },
        ],
        details: {
          effectId: res.effectId,
          effectState: res.effectState,
          receiptRef: res.receiptRef ?? null,
        },
      };
    },
  });

  const runWorkerTool = defineTool({
    name: "run_worker",
    description: "Delegate a task to the isolated Worker model slot under the host's owning budget task.",
    replay: "unsafe",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
      },
      required: ["prompt"],
    },
    async execute(args, api): Promise<ToolExecutionResult> {
      if (!options.runWorkerDelegation) {
        return {
          isError: true,
          output: [{ type: "text", text: "Worker delegation is not configured on this host" }],
        };
      }
      const typed = args as { prompt: string };
      // Never accept budgetTaskId from untrusted model arguments; host binds worker budget authoritatively.
      const res = await options.runWorkerDelegation({
        parentConversationId: String(api.conversationId),
        parentTaskId: String(api.taskId),
        prompt: typed.prompt,
      });
      if (!res.ok) {
        return {
          isError: true,
          output: [{ type: "text", text: `Worker failed: ${res.error ?? res.text}` }],
        };
      }
      return {
        output: [{ type: "text", text: res.text }],
      };
    },
  });

  return defineExtension({
    name: AEGIS_POLICY_EXTENSION_NAME,
    tools: [sendEmailTool, runWorkerTool],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          // Tier 0 / internal delegation tool does not require Tier 2 mail approval
          if (call.name === "run_worker") {
            return undefined;
          }

          // Tier 2 outbound tool (send_email) requires explicit host approval
          if (call.name !== "send_email") {
            return { block: `Default-deny policy: unapproved tool ${call.name}` };
          }

          const now = nowFn();
          const runtimeEpoch = options.getRuntimeEpoch();
          const conversationId = String(api.conversationId);
          const toolTaskId = String(api.taskId);
          const callId = call.id;
          const scopeId = options.resolveScopeId(conversationId);

          const { payload, target } = normalizeEmailPayload(call.arguments as Record<string, unknown>);
          const snap = proposeOrGetApproval(options.govDb, {
            runtimeEpoch,
            conversationId,
            toolTaskId,
            callId,
            scopeId,
            toolName: call.name,
            target,
            payload: payload as unknown as Record<string, unknown>,
            expiresAt: now + ttlMs,
            now,
          });

          if (options.onBeforeToolAfterProposal) {
            await options.onBeforeToolAfterProposal({
              proposalId: snap.proposal.proposal_id,
              approvalId: snap.approval.approval_id,
              signalKey: `sig:${runtimeEpoch}:${snap.proposal.proposal_id}:r${snap.approval.revision}`,
              conversationId,
              toolTaskId,
              callId,
            });
          }

          // Always re-read authoritative state from governance DB (never trust signal payload!)
          const govState = readProposalGovernanceState(options.govDb, {
            runtimeEpoch,
            conversationId,
            toolTaskId,
            callId,
          });
          if (!govState) {
            return { block: "Governance proposal disappeared" };
          }

          if (govState.state === "PENDING") {
            return {
              sleep: {
                signals: [AegisApprovalSignal.key(govState.signalKey)],
              },
            };
          }

          if (govState.state === "APPROVED") {
            // Mark outbox observed in case decision arrived before park (E01)
            markOutboxObservedByReentry(options.govDb, govState.approvalId, now);

            if (govState.effectState !== "READY") {
              return {
                block: `Effect ${govState.effectId ?? "unknown"} is ${govState.effectState ?? "missing"}; refusing re-execution`,
              };
            }

            // Deliver the exact approved canonical draft arguments to execute()
            const approvedPayload = govState.parsedSnapshot["payload"] as JsonObject | undefined;
            if (!approvedPayload || typeof approvedPayload !== "object") {
              return { block: "Approved snapshot missing payload" };
            }
            return { arguments: approvedPayload };
          }

          // REJECTED / EXPIRED / CANCELLED / SUPERSEDED
          markOutboxObservedByReentry(options.govDb, govState.approvalId, now);
          return {
            block: `Action ${govState.proposalId} not approved (state=${govState.state})`,
          };
        },
      }),
    ],
  });
}
