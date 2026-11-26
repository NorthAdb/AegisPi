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
  readImapMessageReadOnly,
  type ImapEndpointConfig,
} from "../../capabilities/mail/imap-client.ts";
import { recallMemory } from "../../capabilities/memory/store.ts";
import {
  readSkillDisclosure,
  resolveVerifiedSkillScript,
} from "../../capabilities/skills/store.ts";
import {
  createRoutineWithGovernance,
  parseNaturalLanguageRoutine,
} from "../../capabilities/timers/routines.ts";
import {
  decideApproval,
  proposeOrGetApproval,
  readProposalGovernanceState,
} from "../../governance/approvals.ts";
import { sha256Hex } from "../../governance/canonical.ts";
import type { HostCredentialVault, StageEgressPolicy } from "../../governance/credentials.ts";
import { verifyLiveMcpToolPin } from "../../governance/mcp-pin.ts";
import { recordConversationSource } from "../../governance/policy.ts";
import {
  evaluateGithubWritePolicy,
  validateStage2PlainTextEmail,
  type GithubWriteAllowlistEntry,
} from "../../governance/rules.ts";
import { markOutboxObservedByReentry } from "../../governance/signal-outbox.ts";
import type { GitHubMcpBridge } from "../mcp-bridge.ts";
import {
  submitApprovedEmailEffect,
  submitApprovedGithubWriteEffect,
  type EmailSubmissionPayload,
  type GithubWriteSubmissionPayload,
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

export interface ManagedWorkspaceWriteHandler {
  (params: {
    runtimeEpoch: string;
    conversationId: string;
    toolTaskId: string;
    executionRootTaskId: string;
    principalId: string;
    scopeId: string;
    logicalKey: string;
    relPath: string;
    content: string;
    useDockerSandbox?: boolean;
  }): Promise<{
    ok: boolean;
    code: string;
    message: string;
    importId?: string;
    state?: string;
    targetRelPath?: string;
    artifactSha256?: string;
    conflictPath?: string | null;
    installCount?: number;
    executorImageId?: string | null;
    exporterImageId?: string | null;
  }>;
}

export interface AegisPolicyExtensionOptions {
  govDb: DatabaseSync;
  vault?: HostCredentialVault;
  getRuntimeEpoch: () => string;
  resolveScopeId: (conversationId: string) => string;
  resolveConversationAuth?: (conversationId: string) => { principalId: string; scopeId: string };
  smtpConfig: SmtpEndpointConfig;
  egressPolicy?: StageEgressPolicy;
  strictPlainTextEmail?: boolean;
  githubWriteAllowlist?: GithubWriteAllowlistEntry[];
  skillScriptRunner?: (params: {
    skillId: string;
    scriptId: string;
    scriptSha256: string;
    sourceCode: string;
    inputJson: string;
    conversationId: string;
    principalId: string;
    scopeId: string;
  }) => Promise<{ ok: boolean; code: string; output: string; error?: string }>;
  imapEndpoint?: () => ImapEndpointConfig | null;
  githubMcpBridge?: () => GitHubMcpBridge | null;
  workspaceWriteHandler?: ManagedWorkspaceWriteHandler;
  resolveExecutionRootTaskId?: (conversationId: string, toolTaskId: string) => Promise<string> | string;
  onGovernanceMutated?: (conversationId: string, reason: string) => void;
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

const ALLOWED_TIER0_OR_DELEGATE_TOOLS = new Set([
  "run_worker",
  "memory_recall",
  "mail_read_latest",
  "github_read_file",
  "workspace_write_managed",
  "skill_read_body",
  "skill_run_script",
  "routine_create",
]);

export function createAegisPolicyExtension(options: AegisPolicyExtensionOptions): Extension {
  const nowFn = options.now ?? (() => Date.now());
  const ttlMs = options.approvalTtlMs ?? 30 * 60 * 1000;
  const resolveAuth = (conversationId: string): { principalId: string; scopeId: string } => {
    if (options.resolveConversationAuth) {
      return options.resolveConversationAuth(conversationId);
    }
    return { principalId: "owner", scopeId: options.resolveScopeId(conversationId) };
  };

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
        egressPolicy: options.egressPolicy,
        vault: options.vault,
        now: nowFn,
        onAfterClaimBeforeTransport: options.onAfterClaimBeforeTransport,
        onBeforeClaim: options.onBeforeClaim,
      });

      options.onGovernanceMutated?.(conversationId, "effect_updated");

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

  const memoryRecallTool = defineTool({
    name: "memory_recall",
    description: "Recall authorized memory notes (FTS5 + 2-hop reference expansion) scoped to the session principal.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        domain: { type: "string" },
        maxHops: { type: "number" },
      },
      required: ["query"],
    },
    async execute(args, api): Promise<ToolExecutionResult> {
      const typed = args as { query: string; domain?: string; maxHops?: number };
      const conversationId = String(api.conversationId);
      const auth = resolveAuth(conversationId);
      const now = nowFn();
      const res = recallMemory(options.govDb, {
        principalId: auth.principalId,
        scopeId: auth.scopeId,
        domain: typed.domain,
        query: typed.query,
        maxHops: typed.maxHops ?? 2,
        now,
      });
      if (!res.ok) {
        return {
          isError: true,
          output: [{ type: "text", text: `memory_recall denied (${res.code}): ${res.reason ?? ""}` }],
        };
      }
      for (const item of res.items) {
        recordConversationSource(options.govDb, {
          runtimeEpoch: options.getRuntimeEpoch(),
          conversationId,
          principalId: auth.principalId,
          sourceType: "memory",
          sourceId: `memory:${item.noteId}`,
          versionRef: `v${item.version}`,
          title: item.title,
          contentDigest: item.contentDigest,
          metadata: { domain: item.domain, tier: item.tier, hop: item.hop, parentNoteId: item.parentNoteId },
          now,
        });
      }
      options.onGovernanceMutated?.(conversationId, "memory_recalled");
      return {
        output: [{ type: "text", text: JSON.stringify({ items: res.items, filteredCounts: res.filteredCounts }) }],
        details: { count: res.items.length, noteIds: res.items.map((i) => i.noteId) },
      };
    },
  });

  const mailReadLatestTool = defineTool({
    name: "mail_read_latest",
    description: "Read the latest matching email via read-only IMAP (EXAMINE + BODY.PEEK, preserving unread flags).",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        mailbox: { type: "string" },
        uid: { type: "number" },
        subjectContains: { type: "string" },
      },
    },
    async execute(args, api): Promise<ToolExecutionResult> {
      const typed = args as { mailbox?: string; uid?: number; subjectContains?: string };
      const endpoint = options.imapEndpoint?.() ?? null;
      if (!endpoint || !options.vault) {
        return {
          isError: true,
          output: [{ type: "text", text: "IMAP read connector is not configured on this host" }],
        };
      }
      const conversationId = String(api.conversationId);
      const auth = resolveAuth(conversationId);
      const now = nowFn();
      const effectiveEndpoint: ImapEndpointConfig = {
        ...endpoint,
        mailbox: typed.mailbox ?? endpoint.mailbox,
      };
      const res = await readImapMessageReadOnly({
        govDb: options.govDb,
        vault: options.vault,
        endpoint: effectiveEndpoint,
        principalId: auth.principalId,
        scopeId: auth.scopeId,
        uid: typed.uid,
        subjectContains: typed.subjectContains,
        now,
      });
      if (!res.ok || !res.message) {
        return {
          isError: true,
          output: [{ type: "text", text: `mail_read_latest failed (${res.code}): ${res.error ?? "no message"}` }],
        };
      }
      recordConversationSource(options.govDb, {
        runtimeEpoch: options.getRuntimeEpoch(),
        conversationId,
        principalId: auth.principalId,
        sourceType: "imap",
        sourceId: `imap:${effectiveEndpoint.mailbox}:uid:${res.message.uid}`,
        versionRef: `uidvalidity=${res.uidValidity ?? 0};uid=${res.message.uid}`,
        title: res.message.subject,
        contentDigest: res.message.contentDigest,
        metadata: {
          mailbox: effectiveEndpoint.mailbox,
          uidValidity: res.uidValidity ?? 0,
          uid: res.message.uid,
          date: res.message.date,
          from: res.message.from,
          flags: res.message.flags,
          mode: res.mode,
          tlsVerified: res.tlsVerified,
        },
        now,
      });
      options.onGovernanceMutated?.(conversationId, "mail_read");
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify({
              mailbox: effectiveEndpoint.mailbox,
              uidValidity: res.uidValidity,
              uid: res.message.uid,
              subject: res.message.subject,
              date: res.message.date,
              from: res.message.from,
              flags: res.message.flags,
              body: res.message.body,
            }),
          },
        ],
        details: {
          uid: res.message.uid,
          uidValidity: res.uidValidity ?? 0,
          subject: res.message.subject,
          flags: res.message.flags,
        },
      };
    },
  });

  const githubReadFileTool = defineTool({
    name: "github_read_file",
    description: "Read a file from an approved read-only GitHub repository via pinned GitHub MCP server.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string" },
        ref: { type: "string" },
        path: { type: "string" },
      },
      required: ["repoId", "ref", "path"],
    },
    async execute(args, api): Promise<ToolExecutionResult> {
      const typed = args as { repoId: string; ref: string; path: string };
      const bridge = options.githubMcpBridge?.() ?? null;
      if (!bridge) {
        return {
          isError: true,
          output: [{ type: "text", text: "GitHub MCP bridge is not configured on this host" }],
        };
      }
      const conversationId = String(api.conversationId);
      const auth = resolveAuth(conversationId);
      const now = nowFn();
      const res = await bridge.callReadOnlyTool(
        "get_file_contents",
        {
          repo: typed.repoId,
          ref: typed.ref,
          path: typed.path,
        },
        {
          principalId: auth.principalId,
          scopeId: auth.scopeId,
          repoId: typed.repoId,
          operation: "read_file",
          ref: typed.ref,
          path: typed.path,
        },
      );
      if (!res.ok) {
        return {
          isError: true,
          output: [{ type: "text", text: `github_read_file denied/failed (${res.code}): ${res.reason ?? ""}` }],
        };
      }
      const text = res.text ?? "";
      const contentDigest = sha256Hex(text);
      recordConversationSource(options.govDb, {
        runtimeEpoch: options.getRuntimeEpoch(),
        conversationId,
        principalId: auth.principalId,
        sourceType: "github_mcp",
        sourceId: `github:${typed.repoId}:${typed.path}`,
        versionRef: `${typed.ref}:${typed.path}`,
        title: `${typed.repoId}/${typed.path}`,
        contentDigest,
        metadata: {
          repoId: typed.repoId,
          ref: typed.ref,
          path: typed.path,
          serverId: bridge.serverId,
        },
        now,
      });
      options.onGovernanceMutated?.(conversationId, "github_read");
      return {
        output: [{ type: "text", text }],
        details: { repoId: typed.repoId, ref: typed.ref, path: typed.path, contentDigest },
      };
    },
  });

  const workspaceWriteManagedTool = defineTool({
    name: "workspace_write_managed",
    description: "Write a file into an authorized relative workspace path via isolated sandbox volume & host managed importer.",
    replay: "unsafe",
    parameters: {
      type: "object",
      properties: {
        relPath: { type: "string" },
        content: { type: "string" },
        useDockerSandbox: { type: "boolean" },
      },
      required: ["relPath", "content"],
    },
    async execute(args, api): Promise<ToolExecutionResult> {
      if (!options.workspaceWriteHandler) {
        return {
          isError: true,
          output: [{ type: "text", text: "Managed workspace importer is not configured on this host" }],
        };
      }
      // W2-S3: Deliberately IGNORE any model-supplied baseSha256! Host resolves baseline strictly from task snapshot.
      const typed = args as {
        relPath: string;
        content: string;
        useDockerSandbox?: boolean;
      };
      const conversationId = String(api.conversationId);
      const auth = resolveAuth(conversationId);
      const runtimeEpoch = options.getRuntimeEpoch();
      const toolTaskId = String(api.taskId);
      const executionRootTaskId = options.resolveExecutionRootTaskId
        ? await options.resolveExecutionRootTaskId(conversationId, toolTaskId)
        : `task:${toolTaskId}`;
      const logicalKey = `wimp:${runtimeEpoch}:${conversationId}:${toolTaskId}:${api.callId}`;
      const res = await options.workspaceWriteHandler({
        runtimeEpoch,
        conversationId,
        toolTaskId,
        executionRootTaskId,
        principalId: auth.principalId,
        scopeId: auth.scopeId,
        logicalKey,
        relPath: typed.relPath,
        content: typed.content,
        useDockerSandbox: typed.useDockerSandbox ?? true,
      });
      options.onGovernanceMutated?.(conversationId, "workspace_file_imported");
      if (!res.ok) {
        return {
          isError: true,
          output: [{ type: "text", text: `workspace_write_managed failed (${res.code}): ${res.message}` }],
          details: res as unknown as JsonObject,
        };
      }
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify(res),
          },
        ],
        details: res as unknown as JsonObject,
      };
    },
  });

  const githubWriteFileTool = defineTool({
    name: "github_write_file",
    description: "Write a file to an allowlisted GitHub repository branch through the sole host submitter (Tier 0 positive list or Tier 2 approval).",
    replay: "unsafe",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string" },
        ref: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        message: { type: "string" },
        operation: { type: "string" },
      },
      required: ["repoId", "ref", "path", "content", "message"],
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
              text: `Refused github_write_file: no approved READY effect (state=${govState?.state ?? "missing"})`,
            },
          ],
        };
      }
      const typed = args as unknown as GithubWriteSubmissionPayload;
      const finalTarget = `github:${typed.repoId}@${typed.ref}:${typed.path}`;
      const res = await submitApprovedGithubWriteEffect({
        govDb: options.govDb,
        runtimeEpoch,
        effectId: govState.effectId,
        conversationId,
        toolTaskId,
        callId,
        toolName: "github_write_file",
        finalTarget,
        finalPayload: typed,
        allowlist: options.githubWriteAllowlist ?? [],
        bridge: options.githubMcpBridge?.() ?? null,
        now: nowFn,
        onBeforeClaim: options.onBeforeClaim,
        onAfterClaimBeforeTransport: options.onAfterClaimBeforeTransport,
      });
      options.onGovernanceMutated?.(conversationId, "github_write_effect_updated");
      if (!res.ok) {
        return {
          isError: true,
          output: [{ type: "text", text: `github_write_file ${res.effectState} (${res.code}): ${res.message}` }],
          details: { effectId: res.effectId, effectState: res.effectState, code: res.code },
        };
      }
      return {
        output: [{ type: "text", text: res.message }],
        details: { effectId: res.effectId, effectState: res.effectState, receiptRef: res.receiptRef ?? null },
      };
    },
  });

  const skillReadBodyTool = defineTool({
    name: "skill_read_body",
    description: "Level 2 on-demand skill disclosure: reads full instructions and reviewed L3 script hashes for an active skill.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string" },
      },
      required: ["skillId"],
    },
    async execute(args, api): Promise<ToolExecutionResult> {
      const typed = args as { skillId: string };
      const conversationId = String(api.conversationId);
      const res = readSkillDisclosure(options.govDb, {
        skillId: typed.skillId,
        runtimeEpoch: options.getRuntimeEpoch(),
        conversationId,
      });
      if (!res.ok) {
        return {
          isError: true,
          output: [{ type: "text", text: `skill_read_body refused (${res.code}): ${res.reason}` }],
        };
      }
      options.onGovernanceMutated?.(conversationId, "skill_body_disclosed");
      return {
        output: [{ type: "text", text: JSON.stringify(res) }],
        details: { skillId: res.skillId, version: res.version, bodySha256: res.bodySha256 },
      };
    },
  });

  const skillRunScriptTool = defineTool({
    name: "skill_run_script",
    description: "Level 3 skill execution: runs a human-reviewed SHA-256 pinned skill script inside the no-net sandbox.",
    replay: "unsafe",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string" },
        scriptId: { type: "string" },
        expectedSha256: { type: "string" },
        inputJson: { type: "string" },
      },
      required: ["skillId", "scriptId"],
    },
    async execute(args, api): Promise<ToolExecutionResult> {
      if (!options.skillScriptRunner) {
        return {
          isError: true,
          output: [{ type: "text", text: "Skill L3 script sandbox runner is not configured on this host" }],
        };
      }
      const typed = args as { skillId: string; scriptId: string; expectedSha256?: string; inputJson?: string };
      const conversationId = String(api.conversationId);
      const auth = resolveAuth(conversationId);
      const verified = resolveVerifiedSkillScript(options.govDb, {
        skillId: typed.skillId,
        scriptId: typed.scriptId,
        expectedSha256: typed.expectedSha256,
        runtimeEpoch: options.getRuntimeEpoch(),
        conversationId,
      });
      if (!verified.ok) {
        return {
          isError: true,
          output: [{ type: "text", text: `skill_run_script refused (${verified.code}): ${verified.reason}` }],
        };
      }
      const res = await options.skillScriptRunner({
        skillId: typed.skillId,
        scriptId: verified.script.scriptId,
        scriptSha256: verified.script.scriptSha256,
        sourceCode: verified.script.sourceCode,
        inputJson: typed.inputJson ?? "{}",
        conversationId,
        principalId: auth.principalId,
        scopeId: auth.scopeId,
      });
      options.onGovernanceMutated?.(conversationId, "skill_script_executed");
      if (!res.ok) {
        return {
          isError: true,
          output: [{ type: "text", text: `skill_run_script failed (${res.code}): ${res.error ?? res.output}` }],
        };
      }
      return {
        output: [{ type: "text", text: res.output }],
        details: { skillId: typed.skillId, scriptId: verified.script.scriptId, scriptSha256: verified.script.scriptSha256 },
      };
    },
  });

  const routineCreateTool = defineTool({
    name: "routine_create",
    description: "Parse a natural language routine and register it if a valid Tier 1 remembered rule authorizes it; otherwise returns a preview requiring explicit confirmation.",
    replay: "unsafe",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        timezone: { type: "string" },
      },
      required: ["text"],
    },
    async execute(args, api): Promise<ToolExecutionResult> {
      const typed = args as { text: string; timezone?: string };
      const conversationId = String(api.conversationId);
      const auth = resolveAuth(conversationId);
      const now = nowFn();
      const preview = parseNaturalLanguageRoutine(options.govDb, {
        text: typed.text,
        principalId: auth.principalId,
        scopeId: auth.scopeId,
        timezone: typed.timezone,
        now,
      });
      if (preview.requiresConfirmation) {
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: JSON.stringify({
                code: "tier1_confirmation_required",
                message: "创建并启用例程需要 Tier 1 人工确认（或在规则台启用记住规则）。请在视图②确认预览。",
                preview,
              }),
            },
          ],
        };
      }
      const created = createRoutineWithGovernance(options.govDb, {
        principalId: auth.principalId,
        scopeId: auth.scopeId,
        name: preview.name,
        prompt: preview.prompt,
        timezone: preview.timezone,
        scheduleSpec: preview.scheduleSpec,
        skipCondition: preview.skipCondition,
        nextRunUtcMs: preview.nextRunUtcMs,
        confirmed: false,
        now,
      });
      if (!created.ok) {
        return {
          isError: true,
          output: [{ type: "text", text: JSON.stringify({ code: created.code, message: created.reason, preview }) }],
        };
      }
      options.onGovernanceMutated?.(conversationId, "routine_created");
      return {
        output: [{ type: "text", text: JSON.stringify({ ok: true, routine: created.routine, ruleUsedId: created.ruleUsedId }) }],
      };
    },
  });

  return defineExtension({
    name: AEGIS_POLICY_EXTENSION_NAME,
    tools: [
      sendEmailTool,
      runWorkerTool,
      memoryRecallTool,
      mailReadLatestTool,
      githubReadFileTool,
      workspaceWriteManagedTool,
      githubWriteFileTool,
      skillReadBodyTool,
      skillRunScriptTool,
      routineCreateTool,
    ],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          if (ALLOWED_TIER0_OR_DELEGATE_TOOLS.has(call.name)) {
            return undefined;
          }

          const now = nowFn();
          const runtimeEpoch = options.getRuntimeEpoch();
          const conversationId = String(api.conversationId);
          const toolTaskId = String(api.taskId);
          const callId = call.id;
          const auth = resolveAuth(conversationId);
          const scopeId = auth.scopeId;

          if (call.name === "github_write_file") {
            const rawArgs = call.arguments as Record<string, unknown>;
            const repoId = String(rawArgs["repoId"] ?? "").trim();
            const ref = String(rawArgs["ref"] ?? "").trim();
            const relPath = String(rawArgs["path"] ?? "").trim();
            const content = String(rawArgs["content"] ?? "");
            const message = String(rawArgs["message"] ?? "AegisPi controlled update");
            const operation = String(rawArgs["operation"] ?? "create_or_update_file").trim();

            const bridge = options.githubMcpBridge?.() ?? null;
            if (!bridge || !bridge.isConnected) {
              return { block: "GitHub MCP bridge is not connected" };
            }
            if (bridge.isAdmissionPaused) {
              return { block: "GitHub MCP admission paused during pin verification" };
            }
            const policyDecision = evaluateGithubWritePolicy({
              repoId,
              operation,
              ref,
              path: relPath,
              allowlist: options.githubWriteAllowlist ?? [],
            });
            if (!policyDecision.allowed || policyDecision.tier === null) {
              return { block: `${policyDecision.code}: ${policyDecision.reason}` };
            }
            const pinCheck = verifyLiveMcpToolPin(options.govDb, {
              serverId: bridge.serverId,
              toolName: operation,
            });
            if (!pinCheck.ok) {
              return { block: `${pinCheck.code}: ${pinCheck.reason}` };
            }

            const payload: GithubWriteSubmissionPayload = {
              repoId,
              operation,
              ref,
              path: relPath,
              content,
              message,
              mcpServerId: bridge.serverId,
              mcpToolName: operation,
              mcpSchemaSha256: pinCheck.pin.schema_sha256,
            };
            const target = `github:${repoId}@${ref}:${relPath}`;

            const snap = proposeOrGetApproval(options.govDb, {
              runtimeEpoch,
              conversationId,
              toolTaskId,
              callId,
              scopeId,
              toolName: "github_write_file",
              target,
              payload: payload as unknown as Record<string, unknown>,
              expiresAt: now + ttlMs,
              now,
            });

            // Tier 0 positive allowlist: host auto-issues T2 decision (First CAS -> APPROVED + READY)
            // without showing an approval popup; sole submitter still executes Second CAS (T4) + C4 check!
            if (policyDecision.tier === 0 && snap.approval.state === "PENDING" && snap.nonce) {
              const autoRes = decideApproval(options.govDb, {
                approvalId: snap.approval.approval_id,
                conversationId,
                principalId: auth.principalId,
                decision: "APPROVE",
                expectedRevision: snap.revision.revision,
                expectedActionHash: snap.revision.action_hash,
                nonce: snap.nonce,
                decisionKey: `auto:tier0:${snap.proposal.proposal_id}:r${snap.revision.revision}`,
                now,
              });
              if (!autoRes.ok) {
                return { block: `Tier 0 host auto-issue refused (${autoRes.code}): ${autoRes.message}` };
              }
            }

            options.onGovernanceMutated?.(conversationId, "github_write_proposal");
            const govState = readProposalGovernanceState(options.govDb, {
              runtimeEpoch,
              conversationId,
              toolTaskId,
              callId,
            });
            if (!govState) return { block: "Governance proposal disappeared" };
            if (govState.state === "PENDING") {
              return {
                sleep: {
                  signals: [AegisApprovalSignal.key(govState.signalKey)],
                },
              };
            }
            if (govState.state === "APPROVED") {
              markOutboxObservedByReentry(options.govDb, govState.approvalId, now);
              if (govState.effectState !== "READY") {
                return {
                  block: `Effect ${govState.effectId ?? "unknown"} is ${govState.effectState ?? "missing"}; refusing re-execution`,
                };
              }
              const approvedPayload = govState.parsedSnapshot["payload"] as JsonObject | undefined;
              if (!approvedPayload || typeof approvedPayload !== "object") {
                return { block: "Approved snapshot missing payload" };
              }
              return { arguments: approvedPayload };
            }
            markOutboxObservedByReentry(options.govDb, govState.approvalId, now);
            return { block: `Action ${govState.proposalId} not approved (state=${govState.state})` };
          }

          if (call.name !== "send_email") {
            return { block: `Default-deny policy: unapproved tool ${call.name}` };
          }

          if (options.strictPlainTextEmail) {
            const plainCheck = validateStage2PlainTextEmail(call.arguments as Record<string, unknown>);
            if (!plainCheck.ok) {
              return { block: `${plainCheck.code}: ${plainCheck.reason}` };
            }
          }

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
          options.onGovernanceMutated?.(conversationId, "proposal_created");

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
            markOutboxObservedByReentry(options.govDb, govState.approvalId, now);
            if (govState.effectState !== "READY") {
              return {
                block: `Effect ${govState.effectId ?? "unknown"} is ${govState.effectState ?? "missing"}; refusing re-execution`,
              };
            }
            const approvedPayload = govState.parsedSnapshot["payload"] as JsonObject | undefined;
            if (!approvedPayload || typeof approvedPayload !== "object") {
              return { block: "Approved snapshot missing payload" };
            }
            return { arguments: approvedPayload };
          }

          markOutboxObservedByReentry(options.govDb, govState.approvalId, now);
          return {
            block: `Action ${govState.proposalId} not approved (state=${govState.state})`,
          };
        },
      }),
    ],
  });
}
