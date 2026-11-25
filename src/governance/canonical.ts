import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * RFC 8785-compatible canonical JSON serialization:
 * - UTF-8 output, no insignificant whitespace
 * - Recursively sorted object keys (UTF-16 code unit order per ES6/JCS)
 * - Rejects non-finite numbers, undefined, bigint, functions, symbols, circular refs
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonicalJson: non-finite number is not representable");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "bigint") {
    throw new Error("canonicalJson: bigint must be converted by the caller");
  }
  if (t === "undefined" || t === "function" || t === "symbol") {
    throw new Error(`canonicalJson: ${t} is not representable`);
  }
  if (t === "object") {
    const obj = value as object;
    if (seen.has(obj)) {
      throw new Error("canonicalJson: circular reference");
    }
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        return "[" + obj.map((v) => serialize(v, seen)).join(",") + "]";
      }
      const record = obj as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const k of keys) {
        parts.push(JSON.stringify(k) + ":" + serialize(record[k], seen));
      }
      return "{" + parts.join(",") + "}";
    } finally {
      seen.delete(obj);
    }
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

export function sha256BytesHex(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256LfHex(text: string): string {
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return sha256Hex(lf);
}

export function mintNonce(): string {
  return randomBytes(16).toString("hex");
}

export function digestSecret(secret: string): string {
  return sha256Hex(secret);
}

export function mintId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export interface EmailDraftPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachmentDigests?: Array<{ name: string; sha256: string; sizeBytes: number }>;
}

export interface CanonicalDraftInput {
  schemaVersion?: number;
  runtimeEpoch: string;
  conversationId: string;
  toolTaskId: string;
  callId: string;
  proposalId: string;
  revision: number;
  tool: string;
  target: string;
  scopeId: string;
  scopeEpoch: number;
  policyVersion: number;
  payload: Record<string, unknown>;
}

export interface CanonicalDraftResult {
  canonicalSnapshot: string;
  actionHash: string;
}

export function buildCanonicalDraft(input: CanonicalDraftInput): CanonicalDraftResult {
  const snapshotObj = {
    schema_version: input.schemaVersion ?? 2,
    runtime_epoch: input.runtimeEpoch,
    conversation_id: input.conversationId,
    tool_task_id: input.toolTaskId,
    call_id: input.callId,
    proposal_id: input.proposalId,
    revision: input.revision,
    tool: input.tool,
    target: input.target,
    scope_id: input.scopeId,
    scope_epoch: input.scopeEpoch,
    policy_version: input.policyVersion,
    payload: input.payload,
  };
  const canonicalSnapshot = canonicalJson(snapshotObj);
  const actionHash = sha256Hex(canonicalSnapshot);
  return { canonicalSnapshot, actionHash };
}
