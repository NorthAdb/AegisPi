import type { DatabaseSync } from "node:sqlite";
import { McpClient, StdioTransport, type Tool as McpTool } from "@earendil-works/pi-mcp";
import type { HostCredentialVault, StageProfile } from "../governance/credentials.ts";
import { writeAuditEvent } from "../governance/db.ts";
import {
  quarantineMissingMcpTools,
  recordObservedDriftDefinition,
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
  code: string;
  reason?: string;
  text?: string;
  raw?: unknown;
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
        } catch (err) {
          // Keep admission strictly closed when re-verification fails!
          this.#admissionPaused = true;
          this.#lastPauseReason = `tools_list_changed_recheck_failed:${err instanceof Error ? err.message : String(err)}`;
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
      throw new Error("MCP bridge is not connected");
    }
    const tools = await this.#client.listTools();
    const approvedTools: string[] = [];
    const quarantinedTools: Array<{ name: string; code: string; reason: string }> = [];
    const observedNames: string[] = [];
    const now = this.#now();

    for (const tool of tools) {
      observedNames.push(tool.name);
      this.#loadedTools.set(tool.name, tool);
      const observedDef = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
      const pinCheck = verifyOrQuarantineMcpTool(this.#config.govDb, {
        serverId: this.#config.serverId,
        observedDef,
        now,
      });
      if (pinCheck.ok) {
        approvedTools.push(tool.name);
      } else {
        if (pinCheck.code === "mcp_tool_definition_changed") {
          recordObservedDriftDefinition(this.#config.govDb, {
            serverId: this.#config.serverId,
            observedDef,
            now,
          });
        }
        quarantinedTools.push({ name: tool.name, code: pinCheck.code, reason: pinCheck.reason });
      }
    }

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
        throw new Error(`${binCheck.code}: ${binCheck.reason}`);
      }
      const res = await this.#reconcileLiveToolsList();
      this.#admissionPaused = false;
      this.#lastPauseReason = null;
      return res;
    } catch (err) {
      this.#lastPauseReason = err instanceof Error ? err.message : String(err);
      throw err;
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
      if (!this.#client) {
        const c = await this.connect();
        return {
          ok: c.ok,
          code: c.code,
          message: c.ok ? `Connected (${c.approvedTools.length} approved tools)` : (c.reason ?? c.code),
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
      return {
        ok: false,
        code: "mcp_connectivity_failed",
        message: err instanceof Error ? err.message : String(err),
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

    const lowerName = toolName.toLowerCase();
    if (WRITE_TOOL_PREFIXES.some((p) => lowerName.startsWith(p))) {
      return deny("stage1_github_write_disabled", `Read-only path blocks write MCP tool: ${toolName}`);
    }

    const pinCheck = verifyLiveMcpToolPin(this.#config.govDb, {
      serverId: this.#config.serverId,
      toolName,
      expectedSchemaSha256: auth.expectedSchemaSha256,
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
    });
    if (!grantCheck.ok) {
      return deny(grantCheck.code, grantCheck.reason);
    }

    if (!this.#client) {
      return deny("mcp_not_connected", "GitHub MCP bridge is not connected");
    }

    const result = await this.#client.callTool(toolName, args);
    const text = (result.content ?? [])
      .map((blk) => (blk.type === "text" ? blk.text : JSON.stringify(blk)))
      .join("\n");
    if (result.isError) {
      return { ok: false, code: "mcp_tool_error", reason: text, raw: result };
    }
    return { ok: true, code: "ok", text, raw: result };
  }

  /**
   * Stage 2 controlled write execution. Invoked EXCLUSIVELY by the sole host submitter
   * AFTER T4 CAS READY -> SUBMITTING commits. Re-checks admission pause, Stage 2 write mode,
   * and live pin fingerprint BEFORE sending JSON-RPC.
   */
  async callWriteTool(
    toolName: string,
    args: Record<string, unknown>,
    opts: { expectedSchemaSha256: string },
  ): Promise<McpCallOutcome> {
    if (this.#stage < 2 || this.#readOnlyMode) {
      return {
        ok: false,
        code: "mcp_write_disabled",
        reason: "GitHub MCP bridge is in read-only mode",
      };
    }
    if (this.#admissionPaused) {
      return {
        ok: false,
        code: "mcp_admission_paused",
        reason: `MCP execution admission paused (${this.#lastPauseReason ?? "rechecking"})`,
      };
    }
    const pinCheck = verifyLiveMcpToolPin(this.#config.govDb, {
      serverId: this.#config.serverId,
      toolName,
      expectedSchemaSha256: opts.expectedSchemaSha256,
    });
    if (!pinCheck.ok) {
      return { ok: false, code: pinCheck.code, reason: pinCheck.reason };
    }
    if (!this.#client) {
      return { ok: false, code: "mcp_not_connected", reason: "GitHub MCP bridge is not connected" };
    }
    const result = await this.#client.callTool(toolName, args);
    const text = (result.content ?? [])
      .map((blk) => (blk.type === "text" ? blk.text : JSON.stringify(blk)))
      .join("\n");
    if (result.isError) {
      return { ok: false, code: "mcp_tool_error", reason: text, raw: result };
    }
    return { ok: true, code: "ok", text, raw: result };
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
