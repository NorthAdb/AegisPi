import type { DatabaseSync } from "node:sqlite";
import {
  McpAbortError,
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpTimeoutError,
  StdioTransport,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import type { HostCredentialVault, StageProfile } from "../governance/credentials.ts";
import { writeAuditEvent } from "../governance/db.ts";
import {
  computeMcpToolFingerprint,
  quarantineMissingMcpTools,
  verifyLiveMcpToolPin,
  verifyMcpServerBinary,
  verifyOrQuarantineMcpTool,
} from "../governance/mcp-pin.ts";
import { checkSourceReadAuthorized } from "../governance/policy.ts";

export interface GitHubMcpBridgeConfig {
  serverId: string;
  /** Command to execute (for Node-based fake MCP server: locked node.exe; for real exe: github-mcp-server.exe). */
  command: string;
  /** Args to pass to command (for Node-based fake server: [absScriptPath, ...]; for real exe: ["stdio", "--read-only"]). */
  args?: string[];
  /** Absolute path to the binary or script whose SHA-256 is verified against mcp_server_pins BEFORE launch. */
  pinnedArtifactPath?: string;
  credentialSlotId: string;
  patEnvVarName?: string;
  extraNonSecretEnv?: Record<string, string>;
  /** Stage profile (defaults to 1 = strictly read-only; Stage 2 allows write mode only when pin read_only_mode=0). */
  stage?: StageProfile;
  govDb: DatabaseSync;
  vault: HostCredentialVault;
  operatorConnectionId?: string;
  now?: () => number;
}

export interface McpToolCallAuthContext {
  principalId: string;
  scopeId: string;
  repoId: string;
  operation: string;
  ref?: string;
  path?: string;
}

export interface McpCallOutcome {
  ok: boolean;
  /** S2-P0-1: Distinguishes confirmed failures from unconfirmed write outcomes. */
  outcome?: "failed_local" | "failed_remote" | "unknown";
  code: string;
  reason?: string;
  text?: string;
  raw?: unknown;
}

class McpHostPolicyError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "McpHostPolicyError";
    this.code = code;
  }
}

/**
 * S2-P0-4: Strict closed-enum error reducer for all MCP SDK / transport / remote JSON-RPC failures.
 * NEVER copies raw remote error messages, JSON-RPC data fields, or untrusted error strings!
 */
function reduceMcpBridgeError(err: unknown, fallbackCode: string): string {
  if (err instanceof McpHostPolicyError) {
    return /^[a-z0-9_]{1,64}$/.test(err.code) ? err.code : fallbackCode;
  }
  if (err instanceof McpTimeoutError) return "mcp_request_timeout";
  if (err instanceof McpConnectionClosedError) return "mcp_connection_closed";
  if (err instanceof McpAbortError) return "mcp_request_aborted";
  if (err instanceof McpError) {
    if (err.code === -32601) return "mcp_jsonrpc_method_not_found";
    if (err.code === -32602) return "mcp_jsonrpc_invalid_params";
    return "mcp_jsonrpc_error";
  }
  return fallbackCode;
}

function sanitizeMcpToolLabel(toolName: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(toolName) ? toolName : "unknown_tool";
}

const WRITE_TOOL_PREFIXES = ["create_", "update_", "delete_", "push_", "merge_", "fork_", "add_", "write_"];

function buildMinimalWindowsEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "TEMP", "TMP"]) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      out[k] = v;
    }
  }
  return out;
}

export class GitHubMcpBridge {
  readonly #config: GitHubMcpBridgeConfig;
  readonly #now: () => number;
  readonly #stage: StageProfile;
  #client: McpClient | null = null;
  #transport: StdioTransport | null = null;
  #loadedTools = new Map<string, McpTool>();
  #loadedToolFingerprints = new Map<string, string>();
  #verifiedSha256: string | null = null;
  #readOnlyMode = true;
  #admissionPaused = false;
  #lastPauseReason: string | null = null;
  #pendingRecheck: Promise<void> = Promise.resolve();
  #listChangedCount = 0;
  #unsubscribeListeners: Array<() => void> = [];

  constructor(config: GitHubMcpBridgeConfig) {
    this.#config = config;
    this.#now = config.now ?? (() => Date.now());
    this.#stage = config.stage ?? 1;
  }

  get serverId(): string {
    return this.#config.serverId;
  }

  get verifiedBinarySha256(): string | null {
    return this.#verifiedSha256;
  }

  get loadedToolNames(): string[] {
    return [...this.#loadedTools.keys()];
  }

  get isAdmissionPaused(): boolean {
    return this.#admissionPaused;
  }

  get isConnected(): boolean {
    return this.#client !== null;
  }

  get isReadOnlyMode(): boolean {
    return this.#readOnlyMode;
  }

  get listChangedNotificationCount(): number {
    return this.#listChangedCount;
  }

  getToolInputSchema(toolName: string): Record<string, unknown> | null {
    const t = this.#loadedTools.get(toolName);
    if (!t || !t.inputSchema || typeof t.inputSchema !== "object") return null;
    return t.inputSchema as Record<string, unknown>;
  }

  getLiveToolFingerprint(toolName: string): string | null {
    return this.#loadedToolFingerprints.get(toolName) ?? null;
  }

  async waitForPendingRecheck(): Promise<void> {
    await this.#pendingRecheck;
  }

  getStatus(): {
    serverId: string;
    connected: boolean;
    admissionPaused: boolean;
    pauseReason: string | null;
    readOnlyMode: boolean;
    verifiedBinarySha256: string | null;
    loadedTools: string[];
  } {
    return {
      serverId: this.#config.serverId,
      connected: this.#client !== null,
      admissionPaused: this.#admissionPaused,
      pauseReason: this.#lastPauseReason,
      readOnlyMode: this.#readOnlyMode,
      verifiedBinarySha256: this.#verifiedSha256,
      loadedTools: [...this.#loadedTools.keys()],
    };
  }

  /**
   * C4: Pauses execution admission -> verifies binary absolute path & SHA-256 ->
   * resolves host-memory PAT -> spawns StdioTransport (inheritEnv: false) ->
   * verifies every tool in tools/list + quarantines missing/new/drifted tools -> resumes admission.
   */
  async connect(): Promise<{
    ok: boolean;
    code: string;
    reason?: string;
    approvedTools: string[];
    quarantinedTools: Array<{ name: string; code: string; reason: string }>;
    missingQuarantinedTools?: string[];
  }> {
    this.#admissionPaused = true;
    this.#lastPauseReason = "connecting_and_verifying_pins";
    await this.close();

    const launchArgs = this.#config.args ?? [];
    const binCheck = verifyMcpServerBinary(this.#config.govDb, this.#config.serverId, {
      command: this.#config.command,
      args: launchArgs,
      pinnedArtifactPath: this.#config.pinnedArtifactPath,
    });
    if (!binCheck.ok) {
      this.#lastPauseReason = binCheck.code;
      return {
        ok: false,
        code: binCheck.code,
        reason: binCheck.reason,
        approvedTools: [],
        quarantinedTools: [],
      };
    }
    const isReadOnlyPin = binCheck.pin.read_only_mode === 1;
    if (this.#stage === 1 && !isReadOnlyPin) {
      this.#lastPauseReason = "mcp_not_read_only";
      return {
        ok: false,
        code: "mcp_not_read_only",
        reason: "Stage 1 requires GitHub MCP server read_only_mode=1",
        approvedTools: [],
        quarantinedTools: [],
      };
    }
    this.#verifiedSha256 = binCheck.actualSha256;
    this.#readOnlyMode = isReadOnlyPin;

    const patRes = this.#config.vault.resolveGithubMcpSecretForTarget(this.#config.credentialSlotId, {
      serverId: this.#config.serverId,
      command: binCheck.pinnedCommand,
      args: binCheck.pinnedArgs,
      executablePath: binCheck.pin.executable_path,
      executableSha256: binCheck.actualSha256,
      readOnlyMode: isReadOnlyPin,
    });
    if (!patRes.ok) {
      this.#lastPauseReason = patRes.code;
      return {
        ok: false,
        code: patRes.code,
        reason: patRes.reason,
        approvedTools: [],
        quarantinedTools: [],
      };
    }
    const pat = patRes.secret;

    const patEnvKey = this.#config.patEnvVarName ?? "GITHUB_PERSONAL_ACCESS_TOKEN";
    const env = buildMinimalWindowsEnv({
      ...(this.#config.extraNonSecretEnv ?? {}),
      [patEnvKey]: pat,
      ...(isReadOnlyPin ? { GITHUB_READ_ONLY: "1" } : {}),
    });

    const transport = new StdioTransport({
      command: binCheck.pinnedCommand,
      args: binCheck.pinnedArgs,
      inheritEnv: false,
      env,
      stderr: "pipe",
    });

    const client = new McpClient({
      name: "aegispi-v2-host",
      version: "2.0.0",
      requestTimeoutMs: 15_000,
    });

    // S2-P0-3a: Subscribe to MCP `notifications/tools/list_changed` & unexpected close BEFORE connect
    // so mid-session tool list changes IMMEDIATELY pause admission and trigger full Pin re-verification!
    const offListChanged = client.onNotification("notifications/tools/list_changed", () => {
      this.#handleToolsListChangedNotification();
    });
    const offClose = client.onClose(() => {
      if (this.#client === client) {
        this.#admissionPaused = true;
        this.#lastPauseReason = "mcp_connection_closed";
      }
    });
    this.#unsubscribeListeners.push(offListChanged, offClose);

    try {
      await client.connect(transport);
      this.#transport = transport;
      this.#client = client;

      const pinRes = await this.#reconcileLiveToolsList();
      this.#admissionPaused = false;
      this.#lastPauseReason = null;
      return {
        ok: true,
        code: "connected",
        approvedTools: pinRes.approvedTools,
        quarantinedTools: pinRes.quarantinedTools,
        missingQuarantinedTools: pinRes.missingQuarantinedTools,
      };
    } catch (err) {
      const safeCode = reduceMcpBridgeError(err, "mcp_connect_failed");
      this.#admissionPaused = true;
      this.#lastPauseReason = safeCode;
      this.#transport = transport;
      this.#client = client;
      await this.close();
      return {
        ok: false,
        code: safeCode,
        reason: safeCode,
        approvedTools: [],
        quarantinedTools: [],
      };
    }
  }

  #handleToolsListChangedNotification(): void {
    this.#listChangedCount++;
    this.#admissionPaused = true;
    this.#lastPauseReason = "tools_list_changed_rechecking";
    const now = this.#now();
    writeAuditEvent(this.#config.govDb, {
      entityType: "mcp_server",
      entityId: this.#config.serverId,
      eventKey: `tools_list_changed:${this.#config.serverId}:${this.#listChangedCount}:${now}`,
      eventType: "mcp_tools_list_changed_received",
      occurredAt: now,
      details: { serverId: this.#config.serverId, notificationSeq: this.#listChangedCount },
    });
    this.#pendingRecheck = this.#pendingRecheck
      .catch(() => {})
      .then(async () => {
        if (!this.#client) {
          this.#admissionPaused = true;
          this.#lastPauseReason = "mcp_not_connected";
          return;
        }
        try {
          await this.recheckToolPins();
        } catch {
          // Keep admission strictly closed when re-verification fails (controlled status code only)!
          this.#admissionPaused = true;
          this.#lastPauseReason = "tools_list_changed_recheck_failed";
        }
      });
  }

  /**
   * C4: Full reconnect: pauses admission, closes existing child, re-verifies binary SHA-256,
   * re-spawns child, re-verifies tools/list fingerprints, quarantines new/missing/changed tools.
   */
  async reconnect(): Promise<{
    ok: boolean;
    code: string;
    reason?: string;
    approvedTools: string[];
    quarantinedTools: Array<{ name: string; code: string; reason: string }>;
    missingQuarantinedTools?: string[];
  }> {
    return await this.connect();
  }

  async #reconcileLiveToolsList(): Promise<{
    approvedTools: string[];
    quarantinedTools: Array<{ name: string; code: string; reason: string }>;
    missingQuarantinedTools: string[];
  }> {
    if (!this.#client) {
      throw new McpHostPolicyError("mcp_not_connected");
    }
    const tools = await this.#client.listTools();
    const approvedTools: string[] = [];
    const quarantinedTools: Array<{ name: string; code: string; reason: string }> = [];
    const observedNames: string[] = [];
    const nextLoadedTools = new Map<string, McpTool>();
    const nextLoadedFingerprints = new Map<string, string>();
    const now = this.#now();

    for (const tool of tools) {
      observedNames.push(tool.name);
      const observedDef = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
      const fp = computeMcpToolFingerprint(observedDef);
      nextLoadedTools.set(tool.name, tool);
      nextLoadedFingerprints.set(tool.name, fp.schemaSha256);

      // S2-P0-3: verifyOrQuarantineMcpTool atomically persists the latest observed definition,
      // observed_schema_sha256, and present_in_last_list=1 in ALL states (including already QUARANTINED / REVOKED)!
      const pinCheck = verifyOrQuarantineMcpTool(this.#config.govDb, {
        serverId: this.#config.serverId,
        observedDef,
        now,
      });
      if (pinCheck.ok) {
        approvedTools.push(tool.name);
      } else {
        quarantinedTools.push({ name: tool.name, code: pinCheck.code, reason: pinCheck.reason });
      }
    }

    // Replace live in-memory snapshot atomically so disappeared tools vanish from memory as well as DB!
    this.#loadedTools = nextLoadedTools;
    this.#loadedToolFingerprints = nextLoadedFingerprints;

    const missingQuarantinedTools = quarantineMissingMcpTools(this.#config.govDb, {
      serverId: this.#config.serverId,
      observedToolNames: observedNames,
      now,
    });
    for (const missingName of missingQuarantinedTools) {
      quarantinedTools.push({
        name: missingName,
        code: "mcp_tool_missing",
        reason: `MCP tool ${missingName} disappeared from tools/list and was quarantined`,
      });
    }

    return { approvedTools, quarantinedTools, missingQuarantinedTools };
  }

  /**
   * C4: Pauses admission, re-fetches tools/list from live MCP server, checks drift & missing tools,
   * then resumes admission.
   */
  async recheckToolPins(): Promise<{
    approvedTools: string[];
    quarantinedTools: Array<{ name: string; code: string; reason: string }>;
    missingQuarantinedTools: string[];
  }> {
    this.#admissionPaused = true;
    this.#lastPauseReason = "rechecking_tool_pins";
    try {
      const binCheck = verifyMcpServerBinary(this.#config.govDb, this.#config.serverId, {
        command: this.#config.command,
        args: this.#config.args ?? [],
        pinnedArtifactPath: this.#config.pinnedArtifactPath,
      });
      if (!binCheck.ok) {
        this.#lastPauseReason = binCheck.code;
        await this.close();
        throw new McpHostPolicyError(binCheck.code);
      }
      const res = await this.#reconcileLiveToolsList();
      this.#admissionPaused = false;
      this.#lastPauseReason = null;
      return res;
    } catch (err) {
      // S2-P0-4: NEVER persist raw SDK/remote error text into #lastPauseReason (flows to View ② & audit)!
      const safeCode = reduceMcpBridgeError(err, "mcp_recheck_failed");
      this.#admissionPaused = true;
      this.#lastPauseReason = safeCode;
      throw new McpHostPolicyError(safeCode);
    }
  }

  async testConnectivity(): Promise<{
    ok: boolean;
    code: string;
    message: string;
    approvedTools: string[];
    quarantinedTools: Array<{ name: string; code: string; reason: string }>;
  }> {
    try {
      if (!this.#client || this.#lastPauseReason === "mcp_connection_closed") {
        const c = await this.connect();
        return {
          ok: c.ok,
          code: c.code,
          message: c.ok ? `Connected (${c.approvedTools.length} approved tools)` : c.code,
          approvedTools: c.approvedTools,
          quarantinedTools: c.quarantinedTools,
        };
      }
      const r = await this.recheckToolPins();
      return {
        ok: true,
        code: "ok",
        message: `Connected (${r.approvedTools.length} approved, ${r.quarantinedTools.length} quarantined)`,
        approvedTools: r.approvedTools,
        quarantinedTools: r.quarantinedTools,
      };
    } catch (err) {
      const safeCode = reduceMcpBridgeError(err, "mcp_connectivity_failed");
      return {
        ok: false,
        code: safeCode,
        message: safeCode,
        approvedTools: [],
        quarantinedTools: [],
      };
    }
  }

  /**
   * Executes a read-only MCP tool ONLY after verifying:
   * 1. Admission is NOT paused (C4 reconnect/pin check).
   * 2. Tool is NOT a write operation.
   * 3. Live tool pin in governance DB is APPROVED (not REVOKED or QUARANTINED) & matches optional expected fingerprint.
   * 4. Live source_read_grants authorizes (principalId, scopeId, "github_mcp", repoId, operation, ref, path).
   * Any failure blocks strictly BEFORE sending JSON-RPC to the MCP server (0 calls on server!).
   */
  get operatorConnectionId(): string | undefined {
    return this.#config.operatorConnectionId;
  }

  async readRepositoryFile(auth: Omit<McpToolCallAuthContext, "operation"> & { ref: string; path: string }) {
    const schema = this.getToolInputSchema("get_file_contents");
    const properties = schema?.["properties"];
    const slash = auth.repoId.indexOf("/");
    const target = properties && typeof properties === "object" && Object.hasOwn(properties, "owner")
      ? { owner: slash > 0 ? auth.repoId.slice(0, slash) : "", repo: slash > 0 ? auth.repoId.slice(slash + 1) : auth.repoId }
      : { repo: auth.repoId };
    return this.callReadOnlyTool(
      "get_file_contents", { ...target, ref: auth.ref, path: auth.path }, { ...auth, operation: "read_file" },
    );
  }

  async callReadOnlyTool(
    toolName: string,
    args: Record<string, unknown>,
    auth: McpToolCallAuthContext & { expectedSchemaSha256?: string },
  ): Promise<McpCallOutcome> {
    const now = this.#now();
    const deny = (code: string, reason: string): McpCallOutcome => {
      writeAuditEvent(this.#config.govDb, {
        entityType: "mcp_call",
        entityId: `${this.#config.serverId}:${toolName}`,
        eventKey: `deny:${code}:${now}:${auth.repoId}:${auth.path ?? ""}`,
        eventType: "mcp_call_denied",
        occurredAt: now,
        details: {
          code,
          reason,
          principalId: auth.principalId,
          scopeId: auth.scopeId,
          repoId: auth.repoId,
          ref: auth.ref ?? null,
          path: auth.path ?? null,
        },
      });
      return { ok: false, code, reason };
    };

    if (this.#admissionPaused) {
      return deny("mcp_admission_paused", `MCP execution admission paused (${this.#lastPauseReason ?? "rechecking"})`);
    }
    if (this.#config.operatorConnectionId && (toolName !== "get_file_contents" || auth.operation !== "read_file")) {
      return deny("operator_read_scope_denied", "The connector is scoped to reading the selected repository file");
    }

    const lowerName = toolName.toLowerCase();
    if (WRITE_TOOL_PREFIXES.some((p) => lowerName.startsWith(p))) {
      return deny("stage1_github_write_disabled", `Read-only path blocks write MCP tool: ${toolName}`);
    }

    const liveObservedSha256 = this.#loadedToolFingerprints.get(toolName) ?? null;
    const pinCheck = verifyLiveMcpToolPin(this.#config.govDb, {
      serverId: this.#config.serverId,
      toolName,
      expectedSchemaSha256: auth.expectedSchemaSha256,
      liveObservedSha256,
    });
    if (!pinCheck.ok) {
      return deny(pinCheck.code, pinCheck.reason);
    }

    const grantCheck = checkSourceReadAuthorized(this.#config.govDb, {
      principalId: auth.principalId,
      scopeId: auth.scopeId,
      sourceType: "github_mcp",
      resourceId: `github:${auth.repoId}`,
      operation: auth.operation,
      ref: auth.ref,
      path: auth.path,
      operatorConnectionId: this.#config.operatorConnectionId,
    });
    if (!grantCheck.ok) {
      return deny(grantCheck.code, grantCheck.reason);
    }

    if (!this.#client) {
      return deny("mcp_not_connected", "GitHub MCP bridge is not connected");
    }

    // S2-P0-4: Reduce remote MCP errors strictly to closed host enums (NEVER leak raw remote error text!)
    const safeToolLabel = sanitizeMcpToolLabel(toolName);
    try {
      const result = await this.#client.callTool(toolName, args);
      if (result.isError) {
        return {
          ok: false,
          outcome: "failed_remote",
          code: "mcp_remote_tool_error",
          reason: `mcp_remote_tool_error:${safeToolLabel}`,
        };
      }
      const text = (result.content ?? [])
        .map((blk) => (blk.type === "text" ? blk.text : JSON.stringify(blk)))
        .join("\n");
      return { ok: true, code: "ok", text };
    } catch (err) {
      const safeCode = reduceMcpBridgeError(err, "mcp_transport_error");
      return {
        ok: false,
        outcome: "unknown",
        code: "mcp_transport_error",
        reason: safeCode,
      };
    }
  }

  /**
   * Stage 2 controlled write execution. Invoked EXCLUSIVELY by the sole host submitter
   * AFTER T4 CAS READY -> SUBMITTING commits. Re-checks admission pause, Stage 2 write mode,
   * live in-memory tool presence/fingerprint, AND live DB pin fingerprint BEFORE sending JSON-RPC.
   *
   * S2-P0-1 & S2-P0-4: Unconfirmed write outcomes require manual reconciliation.
   * Errors are reported using host-controlled codes.
   */
  async callWriteTool(
    toolName: string,
    args: Record<string, unknown>,
    opts: { expectedSchemaSha256: string },
  ): Promise<McpCallOutcome> {
    if (this.#stage < 2 || this.#readOnlyMode) {
      return {
        ok: false,
        outcome: "failed_local",
        code: "mcp_write_disabled",
        reason: "GitHub MCP bridge is in read-only mode",
      };
    }
    if (this.#admissionPaused) {
      return {
        ok: false,
        outcome: "failed_local",
        code: "mcp_admission_paused",
        reason: `MCP execution admission paused (${this.#lastPauseReason ?? "rechecking"})`,
      };
    }
    const liveObservedSha256 = this.#loadedToolFingerprints.get(toolName) ?? null;
    const pinCheck = verifyLiveMcpToolPin(this.#config.govDb, {
      serverId: this.#config.serverId,
      toolName,
      expectedSchemaSha256: opts.expectedSchemaSha256,
      liveObservedSha256,
    });
    if (!pinCheck.ok) {
      return { ok: false, outcome: "failed_local", code: pinCheck.code, reason: pinCheck.reason };
    }
    if (!this.#client) {
      return { ok: false, outcome: "failed_local", code: "mcp_not_connected", reason: "GitHub MCP bridge is not connected" };
    }
    try {
      const result = await this.#client.callTool(toolName, args);
      if (result.isError) {
        // The MCP server may report an upstream error after GitHub has applied the write.
        return {
          ok: false,
          outcome: "unknown",
          code: "mcp_remote_write_unconfirmed",
          reason: "mcp_remote_write_unconfirmed",
        };
      }
      const text = (result.content ?? [])
        .map((blk) => (blk.type === "text" ? blk.text : JSON.stringify(blk)))
        .join("\n");
      return { ok: true, code: "ok", text };
    } catch (err) {
      if (err instanceof McpError && (err.code === -32601 || err.code === -32602)) {
        const preExecCode = err.code === -32601 ? "mcp_jsonrpc_method_not_found" : "mcp_jsonrpc_invalid_params";
        return {
          ok: false,
          outcome: "failed_remote",
          code: preExecCode,
          reason: preExecCode,
        };
      }
      const safeCode = reduceMcpBridgeError(err, "mcp_transport_uncertain");
      return {
        ok: false,
        outcome: "unknown",
        code: "mcp_transport_uncertain",
        reason: safeCode,
      };
    }
  }

  async close(): Promise<void> {
    for (const off of this.#unsubscribeListeners) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    this.#unsubscribeListeners = [];
    this.#loadedTools.clear();
    this.#loadedToolFingerprints.clear();
    if (this.#client) {
      await this.#client.close().catch(() => {});
      this.#client = null;
    }
    if (this.#transport) {
      await this.#transport.close().catch(() => {});
      this.#transport = null;
    }
  }
}
