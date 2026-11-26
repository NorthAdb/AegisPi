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
  type GithubWriteAllowlistEntry,
} from "../governance/rules.ts";
import type { GitHubMcpBridge } from "./mcp-bridge.ts";

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
}

export interface EmailSubmissionPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachmentDigests?: Array<{ name: string; sha256: string; sizeBytes: number }>;
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

  const normalizedPayload: Record<string, unknown> = {
    to: [...params.finalPayload.to],
    ...(params.finalPayload.cc ? { cc: [...params.finalPayload.cc] } : {}),
    ...(params.finalPayload.bcc ? { bcc: [...params.finalPayload.bcc] } : {}),
    subject: params.finalPayload.subject,
    body: params.finalPayload.body,
    ...(params.finalPayload.attachmentDigests
      ? { attachmentDigests: params.finalPayload.attachmentDigests }
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
    precondition: params.precondition,
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
    to: params.finalPayload.to,
    subject: params.finalPayload.subject,
    body: params.finalPayload.body,
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

  // T5: Record outcome
  if (smtpRes.status === "succeeded") {
    const rec = recordEffectResult(params.govDb, {
      effectId: params.effectId,
      outcome: "SUCCEEDED",
      receiptRef: smtpRes.receiptRef ?? "250 OK",
      now: params.now(),
    });
    return {
      ok: true,
      claimed: true,
      effectId: params.effectId,
      effectState: rec.state,
      code: "succeeded",
      message: `Email delivered (${smtpRes.receiptRef ?? "250 OK"})`,
      receiptRef: smtpRes.receiptRef ?? null,
    };
  }

  if (smtpRes.status === "failed_remote" || smtpRes.status === "failed_local") {
    const rec = recordEffectResult(params.govDb, {
      effectId: params.effectId,
      outcome: "FAILED",
      reason: `${smtpRes.status}: ${smtpRes.reason ?? "send failed"}`,
      now: params.now(),
    });
    return {
      ok: false,
      claimed: true,
      effectId: params.effectId,
      effectState: rec.state,
      code: smtpRes.status,
      message: smtpRes.reason ?? "SMTP delivery failed",
    };
  }

  const rec = recordEffectResult(params.govDb, {
    effectId: params.effectId,
    outcome: "UNKNOWN",
    reason: smtpRes.reason ?? "smtp_outcome_unknown",
    now: params.now(),
  });
  return {
    ok: false,
    claimed: true,
    effectId: params.effectId,
    effectState: rec.state,
    code: "unknown",
    message: `Delivery outcome unknown (${smtpRes.reason ?? "no receipt"}); manual reconciliation required`,
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

  const policyDecision = evaluateGithubWritePolicy({
    repoId: params.finalPayload.repoId,
    operation: params.finalPayload.operation,
    ref: params.finalPayload.ref,
    path: params.finalPayload.path,
    allowlist: params.allowlist,
  });
  if (!policyDecision.allowed) {
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
    serverId: params.finalPayload.mcpServerId,
    toolName: params.finalPayload.mcpToolName,
    expectedSchemaSha256: params.finalPayload.mcpSchemaSha256,
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
      const livePin = verifyLiveMcpToolPin(params.govDb, {
        serverId: params.finalPayload.mcpServerId,
        toolName: params.finalPayload.mcpToolName,
        expectedSchemaSha256: params.finalPayload.mcpSchemaSha256,
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
    const mcpRes = await params.bridge.callWriteTool(
      params.finalPayload.mcpToolName,
      {
        repo: params.finalPayload.repoId,
        ref: params.finalPayload.ref,
        branch: params.finalPayload.ref.replace(/^refs\/heads\//, ""),
        path: params.finalPayload.path,
        content: params.finalPayload.content,
        message: params.finalPayload.message,
      },
      { expectedSchemaSha256: params.finalPayload.mcpSchemaSha256 },
    );

    if (mcpRes.ok) {
      const receiptRef = mcpRes.text?.slice(0, 200) ?? "github_mcp_ok";
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
        message: `GitHub write committed (${mcpRes.text?.slice(0, 120) ?? "ok"})`,
        receiptRef,
      };
    }

    const rec = recordEffectResult(params.govDb, {
      effectId: params.effectId,
      outcome: "FAILED",
      reason: `${mcpRes.code}: ${mcpRes.reason ?? "mcp_write_failed"}`,
      now: params.now(),
    });
    return {
      ok: false,
      claimed: true,
      effectId: params.effectId,
      effectState: rec.state,
      code: mcpRes.code,
      message: mcpRes.reason ?? "GitHub MCP write failed",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const rec = recordEffectResult(params.govDb, {
      effectId: params.effectId,
      outcome: "UNKNOWN",
      reason: `github_mcp_transport_uncertain: ${reason}`,
      now: params.now(),
    });
    return {
      ok: false,
      claimed: true,
      effectId: params.effectId,
      effectState: rec.state,
      code: "unknown",
      message: `GitHub write outcome unknown (${reason}); manual reconciliation required`,
    };
  }
}
