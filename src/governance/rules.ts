import type { DatabaseSync } from "node:sqlite";
import { mintId } from "./canonical.ts";
import { isLoopbackHost } from "./credentials.ts";
import { withImmediateTx, writeAuditEvent } from "./db.ts";

export type ActionTier = 0 | 1 | 2;

export interface GithubWriteAllowlistEntry {
  /** Exact repository ID, e.g. "NorthAdb/aegis-sandbox-test" */
  repoId: string;
  /** Explicitly allowed operations, e.g. ["create_or_update_file"] */
  operations: string[];
  /** Explicitly allowed refs (branches), e.g. ["refs/heads/aegis-stage2-test"] */
  allowedRefs: string[];
  /** Explicitly allowed relative file paths (exact or prefix ending with "/"). MUST be non-empty for file-write ops! */
  allowedPaths: string[];
  /** Tier 0 = host positive-list auto-issue (2 CAS, no popup); Tier 2 = explicit approval card. */
  tier: 0 | 2;
  /** S2-P0-3c: Refs explicitly confirmed as non-protected (required for Tier 0 auto-issue; unconfirmed refs escalate to Tier 2). */
  confirmedNonProtectedRefs?: string[];
  /** Optional explicit repository-specific protected refs (always excluded from Tier 0). */
  protectedRefs?: string[];
}

export interface GithubWritePolicyDecision {
  allowed: boolean;
  tier: 0 | 2 | null;
  code: string;
  reason: string;
  controlledMcpToolName?: string;
  matchedEntry?: GithubWriteAllowlistEntry;
}

const CONTROLLED_GITHUB_WRITE_TOOL_MAP: Readonly<Record<string, string>> = {
  create_or_update_file: "create_or_update_file",
};

const FILE_WRITE_GITHUB_OPS = new Set(["create_or_update_file", "push_files", "delete_file"]);

export function resolveControlledGithubMcpTool(operation: string): string | null {
  const op = operation.trim();
  return Object.prototype.hasOwnProperty.call(CONTROLLED_GITHUB_WRITE_TOOL_MAP, op)
    ? CONTROLLED_GITHUB_WRITE_TOOL_MAP[op]!
    : null;
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

function isProtectedRef(ref: string, extraProtectedRefs?: string[]): boolean {
  const norm = ref.trim();
  const lower = norm.toLowerCase();
  if (PROTECTED_REFS.has(lower)) return true;
  if (lower.startsWith("refs/tags/")) return true;
  if (extraProtectedRefs && extraProtectedRefs.some((p) => p.trim().toLowerCase() === lower)) {
    return true;
  }
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
 * S2-P0-3c:
 * - Binds policy, pin, and transport dispatch to one controlled operation -> MCP tool mapping.
 * - File writes MUST match an explicit non-empty allowedPaths list (empty allowedPaths is denied).
 * - Tier 0 is strictly limited to NorthAdb/* owned repos AND explicitly confirmed non-protected refs (`refs/heads/...`).
 * - Protected branches, unconfirmed refs, workflows, tags/releases, force-push, and deletes are ALWAYS excluded from Tier 0.
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
  if (!/^[^/\s]+\/[^/\s]+$/.test(repoId)) {
    return {
      allowed: false,
      tier: null,
      code: "github_write_invalid_repo_id",
      reason: `GitHub write requires owner/repo format, got: ${repoId}`,
    };
  }
  const controlledMcpToolName = resolveControlledGithubMcpTool(operation);
  if (!controlledMcpToolName) {
    return {
      allowed: false,
      tier: null,
      code: "github_write_uncontrolled_operation",
      reason: `Operation '${operation}' is not a controlled Stage 2 GitHub write tool`,
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

  const requiresExplicitPath = FILE_WRITE_GITHUB_OPS.has(operation.toLowerCase());

  for (const entry of params.allowlist) {
    if (entry.repoId !== repoId) continue;
    if (!entry.operations.includes(operation)) continue;
    if (!entry.allowedRefs.includes(ref)) continue;

    // S2-P0-3c: File writes MUST match a non-empty explicit allowedPaths list!
    if (requiresExplicitPath) {
      if (!Array.isArray(entry.allowedPaths) || entry.allowedPaths.length === 0) continue;
      if (!relPath || !pathMatchesAllowlist(relPath, entry.allowedPaths)) continue;
    } else if (entry.allowedPaths.length > 0) {
      if (!relPath || !pathMatchesAllowlist(relPath, entry.allowedPaths)) continue;
    }

    const highRisk =
      HIGH_RISK_GITHUB_OPS.has(operation.toLowerCase()) ||
      isProtectedRef(ref, entry.protectedRefs) ||
      (relPath.length > 0 && isWorkflowOrReleasePath(relPath));

    if (entry.tier === 0) {
      if (!repoId.startsWith("NorthAdb/")) {
        return {
          allowed: true,
          tier: 2,
          code: "github_write_escalated_external_repo",
          reason: `External repository ${repoId} cannot use Tier 0; escalated to Tier 2 approval`,
          controlledMcpToolName,
          matchedEntry: entry,
        };
      }
      if (highRisk) {
        return {
          allowed: true,
          tier: 2,
          code: "github_write_escalated_high_risk",
          reason: `High-risk ref/path/op (${operation} on ${ref}:${relPath}) excluded from Tier 0; escalated to Tier 2`,
          controlledMcpToolName,
          matchedEntry: entry,
        };
      }
      const isExplicitHeadBranch = ref.startsWith("refs/heads/");
      const confirmedNonProtected =
        isExplicitHeadBranch &&
        Array.isArray(entry.confirmedNonProtectedRefs) &&
        entry.confirmedNonProtectedRefs.includes(ref);
      if (!confirmedNonProtected) {
        return {
          allowed: true,
          tier: 2,
          code: "github_write_escalated_unconfirmed_ref",
          reason: `Ref ${ref} is not explicitly confirmed non-protected for Tier 0; escalated to Tier 2 approval`,
          controlledMcpToolName,
          matchedEntry: entry,
        };
      }
      return {
        allowed: true,
        tier: 0,
        code: "github_write_tier0_allowlisted",
        reason: `Matched host Tier 0 positive allowlist for ${repoId}@${ref}:${relPath || "(n/a)"}`,
        controlledMcpToolName,
        matchedEntry: entry,
      };
    }

    return {
      allowed: true,
      tier: 2,
      code: "github_write_tier2_allowlisted",
      reason: `Matched Tier 2 approval allowlist for ${repoId}@${ref}:${relPath || "(n/a)"}`,
      controlledMcpToolName,
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

const SMTP_HEADER_CONTROL_RE = /[\r\n\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function hasSmtpHeaderControlChars(value: string): boolean {
  return SMTP_HEADER_CONTROL_RE.test(value);
}

/**
 * S2-P0-1: Unconditional single-line header safety guard shared across proposal, draft edit,
 * submitter claim, and SMTP serialization to eliminate header injection / MIME smuggling.
 */
export function validateEmailEnvelopeSingleLine(params: {
  from?: string;
  to: string[];
  subject: string;
  headers?: Record<string, string>;
}): { ok: true } | { ok: false; code: string; reason: string } {
  if (params.from !== undefined) {
    if (!params.from || hasSmtpHeaderControlChars(params.from) || /[<>]/.test(params.from)) {
      return {
        ok: false,
        code: "invalid_smtp_from_header",
        reason: "SMTP From header contains forbidden control or angle-bracket characters",
      };
    }
  }
  if (!Array.isArray(params.to) || params.to.length === 0) {
    return { ok: false, code: "missing_email_recipient", reason: "Email requires at least one recipient in 'to'" };
  }
  for (const addr of params.to) {
    if (typeof addr !== "string" || !addr.trim() || hasSmtpHeaderControlChars(addr) || /[<>]/.test(addr)) {
      return {
        ok: false,
        code: "invalid_email_recipient",
        reason: "Email recipient contains forbidden control or angle-bracket characters",
      };
    }
  }
  if (typeof params.subject !== "string" || hasSmtpHeaderControlChars(params.subject)) {
    return {
      ok: false,
      code: "invalid_email_subject_multiline",
      reason: "Email subject must be a single line without CR/LF or control characters",
    };
  }
  if (params.headers) {
    for (const [k, v] of Object.entries(params.headers)) {
      if (!k || hasSmtpHeaderControlChars(k) || /[:\s]/.test(k) || hasSmtpHeaderControlChars(v)) {
        return {
          ok: false,
          code: "invalid_smtp_header",
          reason: "SMTP extra header contains forbidden control characters",
        };
      }
    }
  }
  return { ok: true };
}

/**
 * S2-P0-1: Validates outbound email recipients against the host-bound SMTP recipient allowlist.
 * For non-loopback real SMTP endpoints, an explicit non-empty allowlist with ZERO '*' wildcards is mandatory.
 */
export function validateEmailRecipientsAllowlist(params: {
  to: string[];
  allowedRecipients?: string[];
  smtpHost: string;
}): { ok: true } | { ok: false; code: string; reason: string } {
  const loopback = isLoopbackHost(params.smtpHost);
  const rawList = (params.allowedRecipients ?? [])
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length > 0);

  if (!loopback) {
    if (rawList.length === 0 || rawList.includes("*") || rawList.includes("smtp:*")) {
      return {
        ok: false,
        code: "smtp_recipient_allowlist_required",
        reason: `Remote SMTP host ${params.smtpHost} requires an explicit non-wildcard recipient allowlist`,
      };
    }
  }

  if (rawList.length === 0 || (loopback && (rawList.includes("*") || rawList.includes("smtp:*")))) {
    return { ok: true };
  }

  const allowedSet = new Set(rawList.map((e) => (e.startsWith("smtp:") ? e.slice(5) : e)));
  for (const addr of params.to) {
    const norm = addr.trim().toLowerCase();
    if (!allowedSet.has(norm)) {
      return {
        ok: false,
        code: "smtp_recipient_not_allowlisted",
        reason: `Recipient ${norm} is outside the host-approved SMTP recipient allowlist`,
      };
    }
  }
  return { ok: true };
}

/**
 * S2-P0-1: Shared Stage 2 plain-text email validator used at proposal creation, draft revision save,
 * and sole submitter pre-claim verification.
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
  if ((Array.isArray(cc) && cc.length > 0) || (cc !== undefined && cc !== null && !Array.isArray(cc) && String(cc).trim() !== "")) {
    return { ok: false, code: "unsupported_email_field_cc", reason: "Stage 2 plain-text slice rejects cc recipients" };
  }
  const bcc = raw["bcc"];
  if ((Array.isArray(bcc) && bcc.length > 0) || (bcc !== undefined && bcc !== null && !Array.isArray(bcc) && String(bcc).trim() !== "")) {
    return { ok: false, code: "unsupported_email_field_bcc", reason: "Stage 2 plain-text slice rejects bcc recipients" };
  }
  const attachments = raw["attachments"] ?? raw["attachmentDigests"];
  if (
    (Array.isArray(attachments) && attachments.length > 0) ||
    (attachments !== undefined && attachments !== null && !Array.isArray(attachments))
  ) {
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
    if (hasSmtpHeaderControlChars(addr) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr)) {
      return { ok: false, code: "invalid_email_recipient", reason: `Invalid email recipient: ${addr}` };
    }
  }
  if (typeof raw["subject"] !== "string") {
    return { ok: false, code: "missing_email_subject", reason: "Email requires a string subject" };
  }
  const rawSubject = raw["subject"];
  if (hasSmtpHeaderControlChars(rawSubject)) {
    return {
      ok: false,
      code: "invalid_email_subject_multiline",
      reason: "Email subject must be a single line without CR/LF or control characters",
    };
  }
  const subject = rawSubject.trim();
  if (!subject) {
    return { ok: false, code: "missing_email_subject", reason: "Email requires a non-empty subject" };
  }
  if (typeof raw["body"] !== "string") {
    return { ok: false, code: "invalid_email_body", reason: "Email requires a plain-text string body" };
  }
  const body = raw["body"];
  return { ok: true, to, subject, body };
}

/**
 * S2-P1-1: Upgrades an existing Stage 1 scope row's allowed_tools_json (without editing frozen approvals.ts)
 * so upgraded Stage 1 databases gain authorized Stage 2 tools while preserving scope_epoch/policy_version.
 */
export function upgradeStage2ScopeAllowedTools(
  db: DatabaseSync,
  params: { scopeId: string; requiredTools: string[]; now: number },
): boolean {
  return withImmediateTx(db, () => {
    const row = db
      .prepare("SELECT allowed_tools_json FROM scopes WHERE scope_id = ?")
      .get(params.scopeId) as { allowed_tools_json: string } | undefined;
    if (!row) return false;
    let existing: string[] = [];
    try {
      const parsed = JSON.parse(row.allowed_tools_json) as unknown;
      if (Array.isArray(parsed)) existing = parsed.map(String);
    } catch {
      existing = [];
    }
    const merged = new Set(existing);
    let changed = false;
    for (const tool of params.requiredTools) {
      if (!merged.has(tool)) {
        merged.add(tool);
        changed = true;
      }
    }
    if (!changed) return false;
    db.prepare("UPDATE scopes SET allowed_tools_json = ? WHERE scope_id = ?").run(
      JSON.stringify([...merged]),
      params.scopeId,
    );
    writeAuditEvent(db, {
      entityType: "scope",
      entityId: params.scopeId,
      eventKey: `stage2_tools_upgrade:${params.scopeId}:${merged.size}`,
      eventType: "scope_tools_upgraded_stage2",
      occurredAt: params.now,
      details: { scopeId: params.scopeId, addedTools: params.requiredTools.filter((t) => !existing.includes(t)) },
    });
    return true;
  });
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
