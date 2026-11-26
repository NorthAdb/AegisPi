import type { DatabaseSync } from "node:sqlite";
import { McpClient, StdioTransport, type Tool as McpTool } from "@earendil-works/pi-mcp";
import type { HostCredentialVault } from "../governance/credentials.ts";
import { writeAuditEvent } from "../governance/db.ts";
import {
  getMcpToolPin,
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
  #client: McpClient | null = null;
  #transport: StdioTransport | null = null;
  #loadedTools = new Map<string, McpTool>();
  #verifiedSha256: string | null = null;

  constructor(config: GitHubMcpBridgeConfig) {
    this.#config = config;
    this.#now = config.now ?? (() => Date.now());
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

  /**
   * 1. Verifies pinned absolute path + SHA-256 BEFORE spawning child.
   * 2. Resolves approved PAT strictly in host memory.
   * 3. Launches StdioTransport with explicit inheritEnv: false and minimal Windows env.
   * 4. Lists tools and verifies every tool definition's canonical SHA-256 fingerprint against mcp_tool_pins.
   */
  async connect(): Promise<{
    ok: boolean;
    code: string;
    reason?: string;
    approvedTools: string[];
    quarantinedTools: Array<{ name: string; code: string; reason: string }>;
  }> {
    const launchArgs = this.#config.args ?? [];
    const binCheck = verifyMcpServerBinary(this.#config.govDb, this.#config.serverId, {
      command: this.#config.command,
      args: launchArgs,
      pinnedArtifactPath: this.#config.pinnedArtifactPath,
    });
    if (!binCheck.ok) {
      return {
        ok: false,
        code: binCheck.code,
        reason: binCheck.reason,
        approvedTools: [],
        quarantinedTools: [],
      };
    }
    if (binCheck.pin.read_only_mode !== 1) {
      return {
        ok: false,
        code: "mcp_not_read_only",
        reason: "Stage 1 requires GitHub MCP server read_only_mode=1",
        approvedTools: [],
        quarantinedTools: [],
      };
    }
    this.#verifiedSha256 = binCheck.actualSha256;

    const patRes = this.#config.vault.resolveGithubMcpSecretForTarget(this.#config.credentialSlotId, {
      serverId: this.#config.serverId,
      command: binCheck.pinnedCommand,
      args: binCheck.pinnedArgs,
      executablePath: binCheck.pin.executable_path,
      executableSha256: binCheck.actualSha256,
      readOnlyMode: binCheck.pin.read_only_mode === 1,
    });
    if (!patRes.ok) {
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
      GITHUB_READ_ONLY: "1",
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

    await client.connect(transport);
    this.#transport = transport;
    this.#client = client;

    const tools = await client.listTools();
    const approvedTools: string[] = [];
    const quarantinedTools: Array<{ name: string; code: string; reason: string }> = [];

    for (const tool of tools) {
      this.#loadedTools.set(tool.name, tool);
      const pinCheck = verifyOrQuarantineMcpTool(this.#config.govDb, {
        serverId: this.#config.serverId,
        observedDef: {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        now: this.#now(),
      });
      if (pinCheck.ok) {
        approvedTools.push(tool.name);
      } else {
        quarantinedTools.push({ name: tool.name, code: pinCheck.code, reason: pinCheck.reason });
      }
    }

    return { ok: true, code: "connected", approvedTools, quarantinedTools };
  }

  /**
   * Re-fetches tools/list from the live MCP server and checks for definition drift.
   */
  async recheckToolPins(): Promise<{
    approvedTools: string[];
    quarantinedTools: Array<{ name: string; code: string; reason: string }>;
  }> {
    if (!this.#client) {
      throw new Error("MCP bridge is not connected");
    }
    const tools = await this.#client.listTools();
    const approvedTools: string[] = [];
    const quarantinedTools: Array<{ name: string; code: string; reason: string }> = [];
    for (const tool of tools) {
      this.#loadedTools.set(tool.name, tool);
      const pinCheck = verifyOrQuarantineMcpTool(this.#config.govDb, {
        serverId: this.#config.serverId,
        observedDef: {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        now: this.#now(),
      });
      if (pinCheck.ok) approvedTools.push(tool.name);
      else quarantinedTools.push({ name: tool.name, code: pinCheck.code, reason: pinCheck.reason });
    }
    return { approvedTools, quarantinedTools };
  }

  /**
   * Executes a Stage-1 read-only MCP tool ONLY after verifying:
   * 1. Tool is NOT a write operation (Stage 1 closes all GitHub writes).
   * 2. Live tool pin in governance DB is APPROVED (not REVOKED or QUARANTINED).
   * 3. Live source_read_grants authorizes (principalId, scopeId, "github_mcp", repoId, operation, ref, path).
   * Any failure blocks strictly BEFORE sending JSON-RPC to the MCP server (0 calls on server!).
   */
  async callReadOnlyTool(
    toolName: string,
    args: Record<string, unknown>,
    auth: McpToolCallAuthContext,
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

    const lowerName = toolName.toLowerCase();
    if (WRITE_TOOL_PREFIXES.some((p) => lowerName.startsWith(p))) {
      return deny("stage1_github_write_disabled", `Stage 1 blocks write MCP tool: ${toolName}`);
    }

    const pin = getMcpToolPin(this.#config.govDb, this.#config.serverId, toolName);
    if (!pin) {
      return deny("mcp_tool_unapproved", `MCP tool ${toolName} has no approved pin`);
    }
    if (pin.state === "REVOKED") {
      return deny("mcp_tool_revoked", `MCP tool ${toolName} has been revoked`);
    }
    if (pin.state !== "APPROVED") {
      return deny("mcp_tool_quarantined", `MCP tool ${toolName} is quarantined (${pin.reason ?? "pin_drift"})`);
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

  async close(): Promise<void> {
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
