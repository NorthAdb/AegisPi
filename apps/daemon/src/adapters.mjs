// Host-side trusted adapter layer (02 section 4: "宿主提交器先收到规范化
// Action，再选择固定适配器。所有上游地址、HTTP method、resource路径模板、
// header和重定向规则来自可信适配器，不由模型拼接").
//
// This module owns the CP3/CP4 part of the host path:
//   - The OPERATIONS registry is the only source of what an effect may ask
//     for. The dispatcher's adapter upstream refuses anything not in it.
//   - Every adapter owns its own endpoint/method/path templates and reads
//     them from HOST config, never from action_json. The action carries
//     resource identity + content hashes only.
//   - Categories drive the hard gates:
//       model_call        chargeable: a live HELD reservation is required
//                          (06 section 8, D-19) or the submit is refused.
//       external_write    real writes require policy.allowRealExternalWrites
//                          AND wired credentials; otherwise fail closed.
//                          Fake transport is the sanctioned test seam.
//       read / notify     shape-validated like everything else.
//   - Fail-closed is the default: no credentials wired -> the submit never
//     leaves the host ("no upstream adapter is wired" is a refusal, not a
//     guess). Nothing here ever invents a digest, an endpoint, or a method.

import { writeAudit } from "./audit.mjs";
import { assertLiveReservation, PURPOSES } from "./budget.mjs";
import { extraFieldsOfAction } from "./effects.mjs";
import { createCredentialService } from "./credentials.mjs";
import {
  assertValidModelBaseUrl,
  callModelOnce,
  isLoopbackModelEndpoint,
  validateModelMessages,
} from "./model-call.mjs";

export class AdapterRefused extends Error {}

const STRING = (v) => typeof v === "string" && v.length > 0 && v.length <= 512;

// The first-version adapter table (02 section 4). transport "fake" is the
// test seam; "real" transports require both owner authorization (policy
// flag) and wired credentials, checked at submit time.
export const OPERATIONS = {
  "model.inference": {
    category: "model_call",
    transport: "real",
    requiresReservation: true,
    validate: (intent) => {
      if (!STRING(intent.targetResource)) return "model.inference needs a purpose-bound target resource";
      if (!intent.extra || !["router", "worker", "summary", "classify", "rsi", "replay", "warming", "watchdog"].includes(intent.extra.purpose)) {
        return "model.inference needs a known chargeable purpose in extra.purpose";
      }
      if (intent.extra.messages !== undefined) {
        const msgCheck = validateModelMessages(intent.extra.messages);
        if (!msgCheck.ok) return msgCheck.reason;
      }
      return null;
    },
  },
  "repo.read": {
    category: "read",
    transport: "real",
    validate: (intent) => {
      if (!STRING(intent.targetResource) || !/^repo:\/\//.test(intent.targetResource)) {
        return "repo.read needs a repo: resource identity";
      }
      return null;
    },
  },
  "pr.create_draft": {
    category: "external_write",
    transport: "real",
    validate: (intent) => {
      if (!STRING(intent.targetResource) || !/^repo:\/\//.test(intent.targetResource)) {
        return "pr.create_draft needs a repo: resource identity";
      }
      if (!STRING(intent.expectedHead)) return "pr.create_draft needs an expected HEAD (branch state the patch was written against)";
      if (!STRING(intent.contentHash)) return "pr.create_draft needs a patch content hash";
      if (!intent.extra || !STRING(intent.extra.branch)) return "pr.create_draft needs a target branch in extra.branch";
      return null;
    },
  },
  "mail.send": {
    category: "external_write",
    transport: "real",
    validate: (intent) => {
      if (!STRING(intent.contentHash)) return "mail.send needs a body content hash";
      if (!intent.extra || !Array.isArray(intent.extra.recipients) || intent.extra.recipients.length === 0 || intent.extra.recipients.length > 50) {
        return "mail.send needs 1..50 recipients in extra.recipients";
      }
      if (!STRING(intent.extra.sendingIdentity)) return "mail.send needs a fixed sending identity";
      return null;
    },
  },
  "im.notify": {
    category: "notify",
    transport: "real",
    validate: (intent) => {
      if (!STRING(intent.contentHash)) return "im.notify needs a message content hash";
      if (!STRING(intent.targetResource)) return "im.notify needs a destination identity";
      return null;
    },
  },
  // The owner-notification operation the durable protocol suites drive
  // (02 section 4 IM adapter: "固定用户或已授权群、精确消息或书面Routine汇
  // 总。送达状态仍使用effect ledger"). Same shape rules as im.notify.
  "send_message": {
    category: "notify",
    transport: "real",
    validate: (intent) => {
      if (!STRING(intent.contentHash)) return "send_message needs a message content hash";
      if (!STRING(intent.targetResource)) return "send_message needs a destination identity";
      return null;
    },
  },
};

export function operationSpec(operation) {
  return OPERATIONS[operation] ?? null;
}

// The production upstream: wraps a transport with the adapter gates. The
// daemon and the console dispatch through THIS object, never the raw fake.
// transportKind is declared by the CALLER (the daemon sets "fake" exactly when
// it was started with --fake-upstream), never sniffed from a label: a label
// is data, not a trust decision.
export function createAdapterUpstream(db, {
  baseUpstream, // the wired transport (fake remote in tests) or null
  transportKind = "fake", // "fake" (test seam) | "real"
  policy = { allowRealExternalWrites: false },
  credentials = {}, // host-wired secrets; empty means nothing real is wired
  config = { fixedSendingIdentity: "aegispi@local", allowedRecipients: [], allowedRepos: [], allowedBranches: [] },
  modelConfig = null, // host model config for model.inference (ADR-0001 §5)
  now = () => Date.now(),
} = {}) {
  const auditRefusal = (operation, reason, effectId = null) => {
    try {
      writeAudit(db, {
        code: "adapter_refused",
        details: { operation, reason, effect_id: effectId },
        now: now(),
      });
    } catch {
      // Auditing must not turn a refusal into a crash.
    }
  };

  return {
    label: `adapter-upstream(${baseUpstream?.label ?? "none"})`,
    // CP4 target validation, run before a single request byte is built.
    validateIntent(operation, intent) {
      const spec = operationSpec(operation);
      if (!spec) {
        return { ok: false, reason: `operation ${operation} is not in the trusted adapter registry` };
      }
      if (typeof intent !== "object" || intent === null) {
        return { ok: false, reason: "operation intent must be an object" };
      }
      const shape = spec.validate(intent);
      if (shape) {
        return { ok: false, reason: shape };
      }
      if (operation === "mail.send") {
        if (intent.extra.sendingIdentity !== config.fixedSendingIdentity) {
          return { ok: false, reason: `sending identity ${intent.extra.sendingIdentity} is not the configured fixed identity` };
        }
        for (const r of intent.extra.recipients) {
          if (!config.allowedRecipients.includes(r)) {
            return { ok: false, reason: `recipient ${r} is not on the authorized recipient list` };
          }
        }
      }
      if (operation === "pr.create_draft") {
        if (config.allowedRepos.length > 0 && !config.allowedRepos.includes(intent.targetResource)) {
          return { ok: false, reason: `repo ${intent.targetResource} is not on the authorized repo list` };
        }
        if (config.allowedBranches.length > 0 && !config.allowedBranches.includes(intent.extra.branch)) {
          return { ok: false, reason: `branch ${intent.extra.branch} is not on the authorized branch list` };
        }
      }
      return { ok: true, spec };
    },
    // dispatchEffect calls submit({businessKey, idempotencyKey, operation,
    // now, mode, reservationId?, effectId?}) where `operation` is the effects
    // row {operation, provider, resource, action_json}.
    submit({ businessKey, idempotencyKey, operation: opRow, now: submitNow, mode, reservationId = null, effectId = null }) {
      const opName = opRow?.operation;
      if (typeof opName !== "string") {
        auditRefusal("(missing)", "operation row without an operation name", effectId);
        return { status: "failed_local", error: "adapter refused: effect row has no operation" };
      }
      const spec = operationSpec(opName);
      if (!spec) {
        auditRefusal(opName, "operation not in the trusted adapter registry", effectId);
        return { status: "failed_local", error: `adapter refused: operation ${opName} is not in the trusted registry` };
      }
      let action = {};
      try {
        action = JSON.parse(opRow.action_json ?? "{}");
      } catch {
        auditRefusal(opName, "action_json is not parseable", effectId);
        return { status: "failed_local", error: "adapter refused: action_json is not parseable" };
      }
      // canonicalActionJson spreads operationIntent.extra at the TOP level of
      // the action, so the adapter's view of "extra" is the same recovery:
      // every key that is not one of the canonical fields.
      const intent = {
        targetResource: action.target_resource ?? null,
        contentHash: action.content_hash ?? null,
        expectedHead: action.expected_head ?? null,
        extra: extraFieldsOfAction(action),
      };
      // Chargeable submits must hold a live reservation (06 section 8; the
      // reservation id is the proof, not a stdout line).
      if (spec.requiresReservation) {
        if (!reservationId) {
          auditRefusal(opName, "chargeable submit without a reservation id", effectId);
          return { status: "failed_local", error: "adapter refused: chargeable operation submitted without a budget reservation" };
        }
        try {
          assertLiveReservation(db, { reservationId, purpose: intent.extra.purpose ?? null });
        } catch (e) {
          auditRefusal(opName, e.message, effectId);
          return { status: "failed_local", error: `adapter refused: ${e.message}` };
        }
      }
      // External writes AND owner notifications through a REAL transport
      // need the owner's authorization plus wired credentials; the fake
      // transportKind is the sanctioned test seam, declared by the caller.
      if (
        (spec.category === "external_write" || spec.category === "notify") &&
        transportKind !== "fake"
      ) {
        if (!policy.allowRealExternalWrites) {
          auditRefusal(opName, "real external write while policy is fail-closed", effectId);
          return {
            status: "failed_local",
            error: "adapter refused: real external writes are not authorized in this phase (fail closed; no request bytes sent)",
          };
        }
        const needed = opName.startsWith("pr.") ? "repo" : opName.startsWith("mail.") ? "mail" : opName.startsWith("im.") || opName === "send_message" ? "im" : "generic";
        if (!credentials[needed]) {
          auditRefusal(opName, `real external write without wired ${needed} credentials`, effectId);
          return {
            status: "failed_local",
            error: `adapter refused: real external write for ${opName} has no wired ${needed} credentials (fail closed; no request bytes sent)`,
          };
        }
      }
      if (opName === "model.inference" && transportKind !== "fake") {
        const validated = this.validateIntent(opName, intent);
        if (!validated.ok) {
          auditRefusal(opName, validated.reason, effectId);
          return { status: "failed_local", error: `adapter refused: ${validated.reason}` };
        }
        if (!modelConfig?.baseUrl) {
          auditRefusal(opName, "model.baseUrl is null (fail closed)", effectId);
          return { status: "failed_local", error: "adapter refused: model.baseUrl is not configured (fail closed)" };
        }
        try {
          assertValidModelBaseUrl(modelConfig.baseUrl);
        } catch (e) {
          auditRefusal(opName, e.message, effectId);
          return { status: "failed_local", error: `adapter refused: ${e.message}` };
        }
        if (!isLoopbackModelEndpoint(modelConfig.baseUrl) && modelConfig.allowRealModelCalls !== true) {
          auditRefusal(opName, "non-loopback model.baseUrl without allowRealModelCalls", effectId);
          return { status: "failed_local", error: "adapter refused: model.baseUrl is not authorized (allowRealModelCalls is false)" };
        }
        const purpose = intent.extra.purpose;
        const allowedPurposes = Array.isArray(modelConfig.allowedPurposes) ? modelConfig.allowedPurposes : [];
        if (!PURPOSES.includes(purpose) || !allowedPurposes.includes(purpose)) {
          auditRefusal(opName, `purpose ${purpose} not in model.allowedPurposes`, effectId);
          return { status: "failed_local", error: `adapter refused: purpose ${purpose} is not in model.allowedPurposes` };
        }
        const modelKey = intent.targetResource.startsWith("model://")
          ? intent.targetResource.slice("model://".length)
          : intent.targetResource;
        const allowedModels = Array.isArray(modelConfig.allowedModelIds) ? modelConfig.allowedModelIds : [];
        if (!allowedModels.includes(modelKey)) {
          auditRefusal(opName, `modelId ${modelKey} not in model.allowedModelIds`, effectId);
          return { status: "failed_local", error: `adapter refused: modelId ${modelKey} is not in model.allowedModelIds` };
        }
        const cred = createCredentialService(db).resolve("model");
        const bearer = cred.ok ? cred.value : null;
        if (!bearer || !bearer.trim()) {
          auditRefusal(opName, "credential slot model is unwired or empty", effectId);
          return { status: "failed_local", error: "adapter refused: model credential slot is not wired or revoked" };
        }
        const messages = Array.isArray(intent.extra.messages) && intent.extra.messages.length > 0
          ? intent.extra.messages
          : [{ role: "user", content: typeof intent.extra.prompt === "string" && intent.extra.prompt.length > 0 ? intent.extra.prompt : `effect ${effectId ?? businessKey}` }];
        const msgCheck = validateModelMessages(messages);
        if (!msgCheck.ok) {
          auditRefusal(opName, msgCheck.reason, effectId);
          return { status: "failed_local", error: `adapter refused: ${msgCheck.reason}` };
        }
        let call;
        try {
          call = callModelOnce({
            baseUrl: modelConfig.baseUrl,
            model: modelKey,
            messages,
            timeoutMs: modelConfig.callTimeoutMs ?? 60000,
            bearer,
          });
        } catch (e) {
          auditRefusal(opName, e.message, effectId);
          return { status: "failed_local", error: `adapter refused: ${e.message}` };
        }
        if (!call.ok) {
          if (call.kind === "timeout") return { status: "unknown", error: call.error };
          if (call.kind === "local") return { status: "failed_local", error: call.error };
          return { status: "failed_remote", error: call.error };
        }
        return {
          status: "succeeded",
          externalId: `model:${idempotencyKey ?? businessKey}`,
          reply: call.reply,
          usage: call.usage,
          model: call.model,
        };
      }
      if (!baseUpstream) {
        auditRefusal(opName, "no transport wired", effectId);
        return { status: "failed_local", error: "adapter refused: no upstream transport is wired" };
      }
      const validated = this.validateIntent(opName, intent);
      if (!validated.ok) {
        auditRefusal(opName, validated.reason, effectId);
        return { status: "failed_local", error: `adapter refused: ${validated.reason}` };
      }
      // The transport receives only registry-known fields; the adapter owns
      // addresses and templates, so nothing here can smuggle an arbitrary URL.
      return baseUpstream.submit({
        businessKey,
        idempotencyKey,
        operation: { operation: opName, targetResource: intent.targetResource, expectedHead: intent.expectedHead },
        now: submitNow,
        mode,
      });
    },
    lookup({ businessKey, consistency = "strong" }) {
      if (!baseUpstream) return { found: false, strong: false };
      return baseUpstream.lookup({ businessKey, consistency });
    },
    // Head precondition source for the dispatcher (06 section 6: the CAS
    // transaction re-checks the target resource precondition).
    lookupHead({ targetResource }) {
      if (!baseUpstream || typeof baseUpstream.lookupHead !== "function") return { ok: false, reason: "transport cannot verify resource heads" };
      return baseUpstream.lookupHead({ targetResource });
    },
  };
}

// Build the dispatcher precondition for an effect: when the action pins an
// expected HEAD, the adapter upstream must confirm the target still has it
// INSIDE the CAS transaction window. Effects without expectedHead pass.
export function headPrecondition(adapterUpstream, effectRow) {
  let action = null;
  try {
    action = JSON.parse(effectRow.action_json);
  } catch {
    return () => false;
  }
  if (action.expected_head === null || action.expected_head === undefined) {
    return () => true;
  }
  return () => {
    const head = adapterUpstream.lookupHead({ targetResource: action.target_resource });
    if (!head.ok) {
      throw new AdapterRefused(`cannot verify target head for ${action.target_resource}: ${head.reason}`);
    }
    if (head.head !== action.expected_head) {
      throw new AdapterRefused(`head_changed: target ${action.target_resource} is at ${head.head}, action pinned ${action.expected_head}`);
    }
    return true;
  };
}
