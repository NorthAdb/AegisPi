import type { DatabaseSync } from "node:sqlite";
import { sendSmtpMessage } from "../capabilities/mail/smtp-client.ts";
import { assertStage1LoopbackSmtpHost } from "../governance/credentials.ts";
import {
  claimEffectForSubmission,
  recordEffectResult,
  type EffectState,
} from "../governance/effects.ts";

export interface SmtpEndpointConfig {
  host: string;
  port: number;
  fromAddress: string;
  timeoutMs?: number;
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
  // Stage 1 hard egress guard BEFORE claiming or connecting
  try {
    assertStage1LoopbackSmtpHost(params.smtpConfig.host, params.smtpConfig.port);
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
