import type { DatabaseSync } from "node:sqlite";
import { sendSmtpMessage } from "../capabilities/mail/smtp-client.ts";
import {
  assertSmtpHostForStage,
  type HostCredentialVault,
  type StageEgressPolicy,
} from "../governance/credentials.ts";
import {
  claimEffectForSubmission,
  recordEffectResult,
  type EffectState,
} from "../governance/effects.ts";
import { verifyLiveMcpToolPin } from "../governance/mcp-pin.ts";
import {
  evaluateGithubWritePolicy,
  isStrictPlainTextEmailRequired,
  resolveControlledGithubMcpTool,
  validateEmailEnvelopeSingleLine,
  validateEmailRecipientsAllowlist,
  validateStage2PlainTextEmail,
  type GithubWriteAllowlistEntry,
} from "../governance/rules.ts";
import type { GitHubMcpBridge } from "./mcp-bridge.ts";

function sanitizeControlledCode(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(trimmed) ? trimmed : fallback;
}

function parseSafeGithubCommitReceipt(rawText: string | undefined): string {
  if (!rawText) return "github:write:committed";
  try {
    const parsed = JSON.parse(rawText) as {
      commitSha?: unknown;
      commit?: { sha?: unknown };
      content?: { sha?: unknown };
    };
    const candidates = [parsed.commitSha, parsed.commit?.sha, parsed.content?.sha];
    for (const c of candidates) {
      if (typeof c === "string" && /^[0-9a-f]{7,64}$/i.test(c.trim())) {
        return `github:commit:${c.trim().toLowerCase()}`;
      }
    }
  } catch {
    // Ignore untrusted/non-JSON remote text; never persist raw remote MCP text!
  }
  return "github:write:committed";
}

export interface SmtpEndpointConfig {
  host: string;
  port: number;
  fromAddress: string;
  timeoutMs?: number;
  tlsMode?: "none" | "direct_tls" | "starttls";
  servername?: string;
  caPem?: string;
  proxy?: { host: string; port: number };
  username?: string;
  credentialSlotId?: string;
  credentialRequired?: boolean;
}

export interface EmailSubmissionPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachmentDigests?: Array<{ name: string; sha256: string; sizeBytes: number }>;
  smtpSender?: string;
}

export interface SubmitEmailEffectParams {
  govDb: DatabaseSync;
  runtimeEpoch: string;
  effectId: string;
  conversationId: string;
  toolTaskId: string;
  callId: string;
  toolName: string;
  finalTarget: string;
  finalPayload: EmailSubmissionPayload;
  smtpConfig: SmtpEndpointConfig;
  egressPolicy?: StageEgressPolicy;
  strictPlainTextEmail?: boolean;
  allowedEmailRecipients?: string[];
  vault?: HostCredentialVault;
  now: () => number;
  precondition?: () => boolean;
  /** Test seam for E05: runs strictly AFTER READY->SUBMITTING commits and BEFORE SMTP connect. */
  onAfterClaimBeforeTransport?: (effectId: string) => void | Promise<void>;
  /** Test seam for E08: runs right before claim CAS to test cancel/claim race order. */
  onBeforeClaim?: (effectId: string) => void | Promise<void>;
}

export interface SubmitEmailEffectResult {
  ok: boolean;
  claimed: boolean;
  effectId: string;
  effectState: EffectState | "REFUSED";
  code: string;
  message: string;
  receiptRef?: string | null;
}

/**
 * Sole host outbound submitter.
 * Performs T4 claiming CAS (READY -> SUBMITTING) inside a short governance transaction,
 * invokes SMTP strictly AFTER commit, and records T5 outcome (SUCCEEDED / FAILED / UNKNOWN).
 * Never auto-resends on UNKNOWN.
 */
export async function submitApprovedEmailEffect(
  params: SubmitEmailEffectParams,
): Promise<SubmitEmailEffectResult> {
  const tlsMode = params.smtpConfig.tlsMode ?? "none";
  // Hard egress guard BEFORE claiming or connecting
  try {
    assertSmtpHostForStage(params.smtpConfig.host, params.smtpConfig.port, params.egressPolicy, {
      tlsEnabled: tlsMode === "direct_tls" || tlsMode === "starttls",
    });
  } catch (err) {
    return {
      ok: false,
      claimed: false,
      effectId: params.effectId,
      effectState: "REFUSED",
      code: "stage1_egress_blocked",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const enforceStrictPlainText = isStrictPlainTextEmailRequired({
    stage: params.egressPolicy?.stage,
    smtpHost: params.smtpConfig.host,
    strictPlainTextEmail: params.strictPlainTextEmail,
  });

  // S2-P0-1: Validate final email snapshot (single-line headers, Stage 2 plain-text, recipient allowlist, target match)
  // BEFORE T4 claim CAS so malformed/injected/out-of-scope/unsupported-field emails NEVER claim or serialize!
  const emailPrecheck = (): { ok: true; payload: EmailSubmissionPayload } | { ok: false; code: string; message: string } => {
    const { smtpSender, ...mail } = params.finalPayload;
    if (params.smtpConfig.credentialRequired &&
        (!params.smtpConfig.credentialSlotId || !params.smtpConfig.username || smtpSender !== params.smtpConfig.fromAddress)) {
      return { ok: false, code: "smtp_sender_binding_required", message: "SMTP credential and approved sender binding are required" };
    }
    const headerCheck = validateEmailEnvelopeSingleLine({
      from: params.smtpConfig.fromAddress,
      to: params.finalPayload.to,
      subject: params.finalPayload.subject,
    });
    if (!headerCheck.ok) {
      return { ok: false, code: headerCheck.code, message: headerCheck.reason };
    }
    let validatedPayload = params.finalPayload;
    if (enforceStrictPlainText) {
      const plainCheck = validateStage2PlainTextEmail(mail);
      if (!plainCheck.ok) {
        return { ok: false, code: plainCheck.code, message: plainCheck.reason };
      }
      validatedPayload = {
        to: plainCheck.to,
        subject: plainCheck.subject,
        body: plainCheck.body,
        ...(smtpSender ? { smtpSender } : {}),
      };
    }
    const recipCheck = validateEmailRecipientsAllowlist({
      to: validatedPayload.to,
      allowedRecipients: params.allowedEmailRecipients,
      smtpHost: params.smtpConfig.host,
    });
    if (!recipCheck.ok) {
      return { ok: false, code: recipCheck.code, message: recipCheck.reason };
    }
    const expectedTarget = `smtp:${validatedPayload.to.join(",")}`;
    if (params.finalTarget !== expectedTarget) {
      return {
        ok: false,
        code: "smtp_target_payload_mismatch",
        message: `Email target '${params.finalTarget}' does not match validated recipients '${expectedTarget}'`,
      };
    }
    return { ok: true, payload: validatedPayload };
  };

  const checkedEmail = emailPrecheck();
  if (!checkedEmail.ok) {
    return {
      ok: false,
      claimed: false,
      effectId: params.effectId,
      effectState: "REFUSED",
      code: checkedEmail.code,
      message: checkedEmail.message,
    };
  }

  let smtpAuth: { username: string; password: string } | undefined;
  if (params.smtpConfig.credentialSlotId && params.smtpConfig.username) {
    if (!params.vault) {
      return {
        ok: false,
        claimed: false,
        effectId: params.effectId,
        effectState: "REFUSED",
        code: "missing_smtp_vault",
        message: "SMTP credential slot configured without host vault",
      };
    }
    const sec = params.vault.resolveSmtpSecretForTarget(params.smtpConfig.credentialSlotId, {
      host: params.smtpConfig.host,
      port: params.smtpConfig.port,
      servername: params.smtpConfig.servername,
      username: params.smtpConfig.username,
      fromAddress: params.smtpConfig.fromAddress,
      proxy: params.smtpConfig.proxy,
    });
    if (!sec.ok) {
      return {
        ok: false,
        claimed: false,
        effectId: params.effectId,
        effectState: "REFUSED",
        code: sec.code,
        message: sec.reason,
      };
    }
    smtpAuth = { username: params.smtpConfig.username, password: sec.secret };
  }

  if (params.onBeforeClaim) {
    await params.onBeforeClaim(params.effectId);
  }

  const verifiedPayload = checkedEmail.payload;
  const normalizedPayload: Record<string, unknown> = enforceStrictPlainText
    ? {
        to: [...verifiedPayload.to],
        subject: verifiedPayload.subject,
        body: verifiedPayload.body,
        ...(verifiedPayload.smtpSender ? { smtpSender: verifiedPayload.smtpSender } : {}),
      }
    : {
        to: [...verifiedPayload.to],
        ...(verifiedPayload.cc ? { cc: [...verifiedPayload.cc] } : {}),
        ...(verifiedPayload.bcc ? { bcc: [...verifiedPayload.bcc] } : {}),
        subject: verifiedPayload.subject,
        body: verifiedPayload.body,
        ...(verifiedPayload.attachmentDigests
          ? { attachmentDigests: verifiedPayload.attachmentDigests }
          : {}),
      };

  // T4: Claim CAS READY -> SUBMITTING
  const claim = claimEffectForSubmission(params.govDb, {
    effectId: params.effectId,
    runtimeEpoch: params.runtimeEpoch,
    conversationId: params.conversationId,
    toolTaskId: params.toolTaskId,
    callId: params.callId,
    toolName: params.toolName,
    finalTarget: params.finalTarget,
    finalPayload: normalizedPayload,
    now: params.now(),
    precondition: () => {
      if (!emailPrecheck().ok) return false;
      return params.precondition ? params.precondition() : true;
    },
  });

  if (!claim.claimed) {
    return {
      ok: false,
      claimed: false,
      effectId: params.effectId,
      effectState: claim.state ?? "REFUSED",
      code: claim.code,
      message: claim.message,
    };
  }

  // Linearization point passed: effect is durably SUBMITTING.
  if (params.onAfterClaimBeforeTransport) {
    await params.onAfterClaimBeforeTransport(params.effectId);
  }

  const smtpRes = await sendSmtpMessage({
    host: params.smtpConfig.host,
    port: params.smtpConfig.port,
    from: params.smtpConfig.fromAddress,
    to: verifiedPayload.to,
    subject: verifiedPayload.subject,
    body: verifiedPayload.body,
    headers: {
      "X-AegisPi-Effect-Id": params.effectId,
      "X-AegisPi-Action-Hash": claim.actionHash ?? "",
    },
    timeoutMs: params.smtpConfig.timeoutMs ?? 15_000,
    egressPolicy: params.egressPolicy,
    tlsMode,
    servername: params.smtpConfig.servername,
    caPem: params.smtpConfig.caPem,
    proxy: params.smtpConfig.proxy,
    auth: smtpAuth,
  });

  // T5 / S2-P0-4: Persist ONLY reduced controlled status codes (never raw remote text or remote queue tokens!)
  if (smtpRes.status === "succeeded") {
    const safeReceipt =
      smtpRes.receiptRef && /^smtp:2\d{2}:accepted$/.test(smtpRes.receiptRef)
        ? smtpRes.receiptRef
        : "smtp:250:accepted";
    const rec = recordEffectResult(params.govDb, {
      effectId: params.effectId,
      outcome: "SUCCEEDED",
      receiptRef: safeReceipt,
      now: params.now(),
    });
    return {
      ok: true,
      claimed: true,
      effectId: params.effectId,
      effectState: rec.state,
      code: "succeeded",
      message: `Email delivered (${safeReceipt})`,
      receiptRef: safeReceipt,
    };
  }

  if (smtpRes.status === "failed_remote" || smtpRes.status === "failed_local") {
    const safeReason = sanitizeControlledCode(smtpRes.reason, "smtp_delivery_failed");
    const rec = recordEffectResult(params.govDb, {
      effectId: params.effectId,
      outcome: "FAILED",
      reason: `${smtpRes.status}:${safeReason}`,
      now: params.now(),
    });
    return {
      ok: false,
      claimed: true,
      effectId: params.effectId,
      effectState: rec.state,
      code: smtpRes.status,
      message: `SMTP delivery failed (${safeReason})`,
    };
  }

  const safeUnknownReason = sanitizeControlledCode(smtpRes.reason, "smtp_outcome_unknown");
  const rec = recordEffectResult(params.govDb, {
    effectId: params.effectId,
    outcome: "UNKNOWN",
    reason: safeUnknownReason,
    now: params.now(),
  });
  return {
    ok: false,
    claimed: true,
    effectId: params.effectId,
    effectState: rec.state,
    code: "unknown",
    message: `Delivery outcome unknown (${safeUnknownReason}); manual reconciliation required`,
  };
}

export interface GithubWriteSubmissionPayload {
  repoId: string;
  operation: string;
  ref: string;
  path: string;
  content: string;
  message: string;
  mcpServerId: string;
  mcpToolName: string;
  mcpSchemaSha256: string;
}

/**
 * Sole host outbound submitter for Stage 2 controlled GitHub writes.
 * Re-verifies host positive allowlist AND C4 live MCP tool pin fingerprint BEFORE T4 CAS READY->SUBMITTING.
 * Never auto-retries on UNKNOWN.
 */
export async function submitApprovedGithubWriteEffect(params: {
  govDb: DatabaseSync;
  runtimeEpoch: string;
  effectId: string;
  conversationId: string;
  toolTaskId: string;
  callId: string;
  toolName: string;
  finalTarget: string;
  finalPayload: GithubWriteSubmissionPayload;
  allowlist: GithubWriteAllowlistEntry[];
  bridge: GitHubMcpBridge | null;
  now: () => number;
  onBeforeClaim?: (effectId: string) => void | Promise<void>;
  onAfterClaimBeforeTransport?: (effectId: string) => void | Promise<void>;
}): Promise<SubmitEmailEffectResult> {
  if (!params.bridge || !params.bridge.isConnected) {
    return {
      ok: false,
      claimed: false,
      effectId: params.effectId,
      effectState: "REFUSED",
      code: "mcp_not_connected",
      message: "GitHub MCP bridge is not connected",
    };
  }
  if (params.bridge.isAdmissionPaused) {
    return {
      ok: false,
      claimed: false,
      effectId: params.effectId,
      effectState: "REFUSED",
      code: "mcp_admission_paused",
      message: "GitHub MCP bridge admission is paused during pin verification",
    };
  }

  // S2-P0-3c: Bind policy, Pin, and actual transport dispatch strictly to the SAME controlled operation!
  const controlledTool = resolveControlledGithubMcpTool(params.finalPayload.operation);
  if (!controlledTool || params.finalPayload.mcpToolName !== controlledTool) {
    return {
      ok: false,
      claimed: false,
      effectId: params.effectId,
      effectState: "REFUSED",
      code: "github_write_tool_mismatch",
      message: `Controlled operation '${params.finalPayload.operation}' does not match MCP tool '${params.finalPayload.mcpToolName}'`,
    };
  }
  if (params.finalPayload.mcpServerId !== params.bridge.serverId) {
    return {
      ok: false,
      claimed: false,
      effectId: params.effectId,
      effectState: "REFUSED",
      code: "github_write_server_mismatch",
      message: `MCP server '${params.finalPayload.mcpServerId}' does not match connected bridge '${params.bridge.serverId}'`,
    };
  }

  const policyDecision = evaluateGithubWritePolicy({
    repoId: params.finalPayload.repoId,
    operation: params.finalPayload.operation,
    ref: params.finalPayload.ref,
    path: params.finalPayload.path,
    allowlist: params.allowlist,
  });
  if (!policyDecision.allowed || policyDecision.controlledMcpToolName !== controlledTool) {
    return {
      ok: false,
      claimed: false,
      effectId: params.effectId,
      effectState: "REFUSED",
      code: policyDecision.code,
      message: policyDecision.reason,
    };
  }

  const pinPreCheck = verifyLiveMcpToolPin(params.govDb, {
    serverId: params.bridge.serverId,
    toolName: controlledTool,
    expectedSchemaSha256: params.finalPayload.mcpSchemaSha256,
    liveObservedSha256: params.bridge.getLiveToolFingerprint(controlledTool),
  });
  if (!pinPreCheck.ok) {
    return {
      ok: false,
      claimed: false,
      effectId: params.effectId,
      effectState: "REFUSED",
      code: pinPreCheck.code,
      message: pinPreCheck.reason,
    };
  }

  if (params.onBeforeClaim) {
    await params.onBeforeClaim(params.effectId);
  }

  const claim = claimEffectForSubmission(params.govDb, {
    effectId: params.effectId,
    runtimeEpoch: params.runtimeEpoch,
    conversationId: params.conversationId,
    toolTaskId: params.toolTaskId,
    callId: params.callId,
    toolName: params.toolName,
    finalTarget: params.finalTarget,
    finalPayload: params.finalPayload as unknown as Record<string, unknown>,
    now: params.now(),
    precondition: () => {
      if (!params.bridge || params.bridge.isAdmissionPaused) return false;
      if (params.finalPayload.mcpToolName !== controlledTool) return false;
      const livePin = verifyLiveMcpToolPin(params.govDb, {
        serverId: params.bridge.serverId,
        toolName: controlledTool,
        expectedSchemaSha256: params.finalPayload.mcpSchemaSha256,
        liveObservedSha256: params.bridge.getLiveToolFingerprint(controlledTool),
      });
      return livePin.ok;
    },
  });

  if (!claim.claimed) {
    return {
      ok: false,
      claimed: false,
      effectId: params.effectId,
      effectState: claim.state ?? "REFUSED",
      code: claim.code,
      message: claim.message,
    };
  }

  if (params.onAfterClaimBeforeTransport) {
    await params.onAfterClaimBeforeTransport(params.effectId);
  }

  try {
    // S2-P1-1: Map controlled owner/repo arguments according to the pinned tool's actual inputSchema!
    const schema = params.bridge.getToolInputSchema(controlledTool);
    const props = schema && typeof schema["properties"] === "object" ? (schema["properties"] as Record<string, unknown>) : null;
    const usesOwnerField = Boolean(props && Object.prototype.hasOwnProperty.call(props, "owner"));
    const slashIdx = params.finalPayload.repoId.indexOf("/");
    const ownerPart = slashIdx > 0 ? params.finalPayload.repoId.slice(0, slashIdx) : "";
    const repoPart = slashIdx > 0 ? params.finalPayload.repoId.slice(slashIdx + 1) : params.finalPayload.repoId;
    const branchName = params.finalPayload.ref.replace(/^refs\/heads\//, "");

    const mcpArgs: Record<string, unknown> = usesOwnerField
      ? {
          owner: ownerPart,
          repo: repoPart,
          branch: branchName,
          path: params.finalPayload.path,
          content: params.finalPayload.content,
          message: params.finalPayload.message,
        }
      : {
          repo: params.finalPayload.repoId,
          ref: params.finalPayload.ref,
          branch: branchName,
          path: params.finalPayload.path,
          content: params.finalPayload.content,
          message: params.finalPayload.message,
        };

    const mcpRes = await params.bridge.callWriteTool(
      controlledTool,
      mcpArgs,
      { expectedSchemaSha256: params.finalPayload.mcpSchemaSha256 },
    );

    // S2-P0-4: Reduce remote MCP response strictly to validated commit SHA or controlled status code!
    if (mcpRes.ok) {
      const receiptRef = parseSafeGithubCommitReceipt(mcpRes.text);
      const rec = recordEffectResult(params.govDb, {
        effectId: params.effectId,
        outcome: "SUCCEEDED",
        receiptRef,
        now: params.now(),
      });
      return {
        ok: true,
        claimed: true,
        effectId: params.effectId,
        effectState: rec.state,
        code: "succeeded",
        message: `GitHub write committed (${receiptRef})`,
        receiptRef,
      };
    }

    // S2-P0-1: Unconfirmed post-dispatch outcomes stay UNKNOWN for manual reconciliation.
    if (
      mcpRes.outcome === "unknown" ||
      mcpRes.code === "mcp_transport_uncertain" ||
      mcpRes.code === "mcp_transport_error"
    ) {
      const safeUnknownReason = sanitizeControlledCode(mcpRes.reason, "github_mcp_transport_uncertain");
      const rec = recordEffectResult(params.govDb, {
        effectId: params.effectId,
        outcome: "UNKNOWN",
        reason: safeUnknownReason,
        now: params.now(),
      });
      return {
        ok: false,
        claimed: true,
        effectId: params.effectId,
        effectState: rec.state,
        code: "unknown",
        message: `GitHub write outcome unknown (${safeUnknownReason}); manual reconciliation required`,
      };
    }

    const safeCode = sanitizeControlledCode(mcpRes.code, "github_mcp_write_failed");
    const rec = recordEffectResult(params.govDb, {
      effectId: params.effectId,
      outcome: "FAILED",
      reason: safeCode,
      now: params.now(),
    });
    return {
      ok: false,
      claimed: true,
      effectId: params.effectId,
      effectState: rec.state,
      code: safeCode,
      message: `GitHub MCP write failed (${safeCode})`,
    };
  } catch {
    const safeReason = "github_mcp_transport_uncertain";
    const rec = recordEffectResult(params.govDb, {
      effectId: params.effectId,
      outcome: "UNKNOWN",
      reason: safeReason,
      now: params.now(),
    });
    return {
      ok: false,
      claimed: true,
      effectId: params.effectId,
      effectState: rec.state,
      code: "unknown",
      message: `GitHub write outcome unknown (${safeReason}); manual reconciliation required`,
    };
  }
}
