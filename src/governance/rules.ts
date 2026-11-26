import type { DatabaseSync } from "node:sqlite";
import { mintId } from "./canonical.ts";
import { withImmediateTx, writeAuditEvent } from "./db.ts";

export type ActionTier = 0 | 1 | 2;

export interface GithubWriteAllowlistEntry {
  /** Exact repository ID, e.g. "NorthAdb/aegis-sandbox-test" */
  repoId: string;
  /** Explicitly allowed operations, e.g. ["create_or_update_file"] */
  operations: string[];
  /** Explicitly allowed refs (branches), e.g. ["refs/heads/aegis-stage2-test"] */
  allowedRefs: string[];
  /** Explicitly allowed relative file paths (exact or prefix ending with "/") */
  allowedPaths: string[];
  /** Tier 0 = host positive-list auto-issue (2 CAS, no popup); Tier 2 = explicit approval card. */
  tier: 0 | 2;
}

export interface GithubWritePolicyDecision {
  allowed: boolean;
  tier: 0 | 2 | null;
  code: string;
  reason: string;
  matchedEntry?: GithubWriteAllowlistEntry;
}

const PROTECTED_REFS = new Set(["main", "master", "refs/heads/main", "refs/heads/master"]);
const HIGH_RISK_GITHUB_OPS = new Set([
  "delete_file",
  "delete_branch",
  "delete_repository",
  "force_push",
  "create_release",
  "update_release",
  "delete_release",
  "merge_pull_request",
]);

function normalizeRepoPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function isWorkflowOrReleasePath(relPath: string): boolean {
  const norm = normalizeRepoPath(relPath).toLowerCase();
  return (
    norm.startsWith(".github/workflows/") ||
    norm === ".github/workflows" ||
    norm.startsWith(".github/actions/")
  );
}

function isProtectedRef(ref: string): boolean {
  const norm = ref.trim();
  const lower = norm.toLowerCase();
  if (PROTECTED_REFS.has(lower)) return true;
  if (lower.startsWith("refs/tags/")) return true;
  return false;
}

function pathMatchesAllowlist(relPath: string, allowedPaths: string[]): boolean {
  const norm = normalizeRepoPath(relPath);
  if (!norm || norm.includes("..") || norm.includes("\0")) return false;
  for (const rawPattern of allowedPaths) {
    const pattern = normalizeRepoPath(rawPattern);
    if (!pattern) continue;
    if (pattern.endsWith("/")) {
      if (norm.startsWith(pattern)) return true;
    } else if (norm === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates a Stage 2 GitHub write operation strictly against the host-configured positive allowlist.
 * Default-deny. Protected branches, workflows, tags/releases, force-push, and deletes are ALWAYS excluded from Tier 0.
 * Repo name prefixes, frontend toggles, and MCP tool visibility NEVER grant permission.
 */
export function evaluateGithubWritePolicy(params: {
  repoId: string;
  operation: string;
  ref: string;
  path?: string;
  allowlist: GithubWriteAllowlistEntry[];
}): GithubWritePolicyDecision {
  const repoId = params.repoId.trim();
  const operation = params.operation.trim();
  const ref = params.ref.trim();
  const relPath = params.path ? normalizeRepoPath(params.path) : "";

  if (!repoId || !operation || !ref) {
    return {
      allowed: false,
      tier: null,
      code: "github_write_invalid_target",
      reason: "GitHub write requires explicit repoId, operation, and ref",
    };
  }
  if (relPath.includes("..") || relPath.includes("\0")) {
    return {
      allowed: false,
      tier: null,
      code: "github_write_invalid_path",
      reason: `Unsafe GitHub write path rejected: ${params.path ?? ""}`,
    };
  }

  const highRisk =
    HIGH_RISK_GITHUB_OPS.has(operation.toLowerCase()) ||
    isProtectedRef(ref) ||
    (relPath.length > 0 && isWorkflowOrReleasePath(relPath));

  for (const entry of params.allowlist) {
    if (entry.repoId !== repoId) continue;
    if (!entry.operations.includes(operation)) continue;
    if (!entry.allowedRefs.includes(ref)) continue;
    if (entry.allowedPaths.length > 0) {
      if (!relPath || !pathMatchesAllowlist(relPath, entry.allowedPaths)) continue;
    }

    if (entry.tier === 0) {
      // Tier 0 strictly limited to explicit NorthAdb/* owned repos & non-high-risk operations/refs/paths
      if (!repoId.startsWith("NorthAdb/")) {
        return {
          allowed: true,
          tier: 2,
          code: "github_write_escalated_external_repo",
          reason: `External repository ${repoId} cannot use Tier 0; escalated to Tier 2 approval`,
          matchedEntry: entry,
        };
      }
      if (highRisk) {
        return {
          allowed: true,
          tier: 2,
          code: "github_write_escalated_high_risk",
          reason: `High-risk ref/path/op (${operation} on ${ref}:${relPath}) excluded from Tier 0; escalated to Tier 2`,
          matchedEntry: entry,
        };
      }
      return {
        allowed: true,
        tier: 0,
        code: "github_write_tier0_allowlisted",
        reason: `Matched host Tier 0 positive allowlist for ${repoId}@${ref}:${relPath || "(n/a)"}`,
        matchedEntry: entry,
      };
    }

    return {
      allowed: true,
      tier: 2,
      code: "github_write_tier2_allowlisted",
      reason: `Matched Tier 2 approval allowlist for ${repoId}@${ref}:${relPath || "(n/a)"}`,
      matchedEntry: entry,
    };
  }

  return {
    allowed: false,
    tier: null,
    code: "github_write_not_allowlisted",
    reason: `Default-deny: GitHub write (${operation} on ${repoId}@${ref}:${relPath || "(none)"}) is not in host allowlist`,
  };
}

/**
 * Stage 2 first-slice plain-text email guard: rejects unsupported attachments and unsupported cc/bcc fields at proposal time.
 */
export function validateStage2PlainTextEmail(raw: Record<string, unknown>): {
  ok: true;
  to: string[];
  subject: string;
  body: string;
} | {
  ok: false;
  code: string;
  reason: string;
} {
  const cc = raw["cc"];
  if (Array.isArray(cc) && cc.length > 0) {
    return { ok: false, code: "unsupported_email_field_cc", reason: "Stage 2 plain-text slice rejects cc recipients" };
  }
  const bcc = raw["bcc"];
  if (Array.isArray(bcc) && bcc.length > 0) {
    return { ok: false, code: "unsupported_email_field_bcc", reason: "Stage 2 plain-text slice rejects bcc recipients" };
  }
  const attachments = raw["attachments"] ?? raw["attachmentDigests"];
  if (Array.isArray(attachments) && attachments.length > 0) {
    return {
      ok: false,
      code: "unsupported_email_attachments",
      reason: "Stage 2 plain-text slice rejects email attachments",
    };
  }
  const toRaw = raw["to"];
  const to = Array.isArray(toRaw)
    ? toRaw.map((x) => String(x).trim()).filter(Boolean)
    : typeof toRaw === "string"
      ? [toRaw.trim()].filter(Boolean)
      : [];
  if (to.length === 0) {
    return { ok: false, code: "missing_email_recipient", reason: "Email requires at least one recipient in 'to'" };
  }
  for (const addr of to) {
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr)) {
      return { ok: false, code: "invalid_email_recipient", reason: `Invalid email recipient: ${addr}` };
    }
  }
  const subject = String(raw["subject"] ?? "").trim();
  const body = String(raw["body"] ?? "");
  if (!subject) {
    return { ok: false, code: "missing_email_subject", reason: "Email requires a non-empty subject" };
  }
  return { ok: true, to, subject, body };
}

export interface ApprovalRuleRow {
  rule_id: string;
  principal_id: string;
  scope_id: string;
  tool_name: string;
  tier: number;
  target_pattern: string;
  action_summary: string;
  expires_at: number;
  created_at: number;
  revoked_at: number | null;
  revoke_reason: string | null;
}

const TIER1_RULE_ELIGIBLE_TOOLS = new Set([
  "routine_create",
  "routine_enable",
  "workspace_write_managed",
  "local_draft_save",
]);

export function createRememberedRule(
  db: DatabaseSync,
  params: {
    principalId: string;
    scopeId: string;
    toolName: string;
    targetPattern: string;
    actionSummary?: string;
    expiresAt: number;
    now: number;
  },
): { ok: true; rule: ApprovalRuleRow } | { ok: false; code: string; reason: string } {
  if (!TIER1_RULE_ELIGIBLE_TOOLS.has(params.toolName)) {
    return {
      ok: false,
      code: "tool_not_eligible_for_remembered_rule",
      reason: `Tool ${params.toolName} is not Tier 1 rule-eligible (Tier 2 actions always require per-action approval)`,
    };
  }
  if (!Number.isSafeInteger(params.expiresAt) || params.expiresAt <= params.now) {
    return {
      ok: false,
      code: "invalid_rule_expiry",
      reason: "Remembered rule requires a future expiresAt timestamp",
    };
  }
  const ruleId = mintId("rule");
  const row = withImmediateTx(db, () => {
    db.prepare(
      `INSERT INTO approval_rules(
         rule_id, principal_id, scope_id, tool_name, tier, target_pattern, action_summary, expires_at, created_at, revoked_at, revoke_reason
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      ruleId,
      params.principalId,
      params.scopeId,
      params.toolName,
      params.targetPattern,
      params.actionSummary ?? "",
      params.expiresAt,
      params.now,
    );
    writeAuditEvent(db, {
      entityType: "approval_rule",
      entityId: ruleId,
      eventKey: `create:${ruleId}`,
      eventType: "approval_rule_created",
      occurredAt: params.now,
      details: {
        principalId: params.principalId,
        scopeId: params.scopeId,
        toolName: params.toolName,
        targetPattern: params.targetPattern,
        expiresAt: params.expiresAt,
      },
    });
    return db
      .prepare("SELECT * FROM approval_rules WHERE rule_id = ?")
      .get(ruleId) as unknown as ApprovalRuleRow;
  });
  return { ok: true, rule: row };
}

export function matchRememberedRule(
  db: DatabaseSync,
  params: {
    principalId: string;
    scopeId: string;
    toolName: string;
    target: string;
    now: number;
  },
): ApprovalRuleRow | null {
  if (!TIER1_RULE_ELIGIBLE_TOOLS.has(params.toolName)) {
    return null;
  }
  const rows = db
    .prepare(
      `SELECT * FROM approval_rules
        WHERE principal_id = ? AND scope_id = ? AND tool_name = ?
          AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`,
    )
    .all(params.principalId, params.scopeId, params.toolName, params.now) as unknown as ApprovalRuleRow[];
  for (const r of rows) {
    if (
      r.target_pattern === "*" ||
      r.target_pattern === params.target ||
      (r.target_pattern.endsWith("*") && params.target.startsWith(r.target_pattern.slice(0, -1)))
    ) {
      return r;
    }
  }
  return null;
}

export function listRememberedRules(
  db: DatabaseSync,
  params: { principalId?: string; includeRevoked?: boolean } = {},
): ApprovalRuleRow[] {
  if (params.principalId) {
    return db
      .prepare(
        params.includeRevoked
          ? "SELECT * FROM approval_rules WHERE principal_id = ? ORDER BY created_at DESC"
          : "SELECT * FROM approval_rules WHERE principal_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
      )
      .all(params.principalId) as unknown as ApprovalRuleRow[];
  }
  return db
    .prepare(
      params.includeRevoked
        ? "SELECT * FROM approval_rules ORDER BY created_at DESC"
        : "SELECT * FROM approval_rules WHERE revoked_at IS NULL ORDER BY created_at DESC",
    )
    .all() as unknown as ApprovalRuleRow[];
}

export function revokeRememberedRule(
  db: DatabaseSync,
  params: { ruleId: string; principalId: string; reason: string; now: number },
): { ok: true; rule: ApprovalRuleRow } | { ok: false; httpStatus: 403 | 404; code: string; reason: string } {
  return withImmediateTx(db, () => {
    const existing = db
      .prepare("SELECT * FROM approval_rules WHERE rule_id = ?")
      .get(params.ruleId) as ApprovalRuleRow | undefined;
    if (!existing) {
      return { ok: false, httpStatus: 404, code: "rule_not_found", reason: `Rule not found: ${params.ruleId}` };
    }
    if (existing.principal_id !== params.principalId) {
      return { ok: false, httpStatus: 403, code: "forbidden", reason: "Not authorized to revoke this rule" };
    }
    db.prepare(
      `UPDATE approval_rules
          SET revoked_at = COALESCE(revoked_at, ?),
              revoke_reason = COALESCE(revoke_reason, ?)
        WHERE rule_id = ?`,
    ).run(params.now, params.reason, params.ruleId);
    writeAuditEvent(db, {
      entityType: "approval_rule",
      entityId: params.ruleId,
      eventKey: `revoke:${params.ruleId}:${params.now}`,
      eventType: "approval_rule_revoked",
      occurredAt: params.now,
      details: { principalId: params.principalId, toolName: existing.tool_name, reason: params.reason },
    });
    const updated = db
      .prepare("SELECT * FROM approval_rules WHERE rule_id = ?")
      .get(params.ruleId) as unknown as ApprovalRuleRow;
    return { ok: true, rule: updated };
  });
}
