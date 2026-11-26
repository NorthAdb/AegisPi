import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { withImmediateTx, writeAuditEvent } from "./db.ts";

export interface McpServerPinRow {
  server_id: string;
  executable_path: string;
  executable_sha256: string;
  read_only_mode: number;
  approved_by: string;
  approved_at: number;
}

export interface McpToolPinRow {
  server_id: string;
  tool_name: string;
  schema_sha256: string;
  canonical_def_json: string;
  state: "APPROVED" | "QUARANTINED" | "REVOKED";
  reason: string | null;
  updated_at: number;
}

export interface McpToolDefinitionInput {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export function sha256File(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

export function computeMcpToolFingerprint(def: McpToolDefinitionInput): {
  canonicalDefJson: string;
  schemaSha256: string;
} {
  const canonicalDefJson = canonicalJson({
    name: def.name,
    description: def.description ?? "",
    inputSchema: def.inputSchema ?? {},
  });
  return {
    canonicalDefJson,
    schemaSha256: sha256Hex(canonicalDefJson),
  };
}

export function pinMcpServerBinary(
  db: DatabaseSync,
  params: {
    serverId: string;
    executablePath: string;
    executableSha256: string;
    readOnlyMode?: boolean;
    approvedBy: string;
    now: number;
  },
): McpServerPinRow {
  if (!path.isAbsolute(params.executablePath)) {
    throw new Error(`MCP server executable path must be absolute: ${params.executablePath}`);
  }
  return withImmediateTx(db, () => {
    db.prepare(
      `INSERT INTO mcp_server_pins(server_id, executable_path, executable_sha256, read_only_mode, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         executable_path = excluded.executable_path,
         executable_sha256 = excluded.executable_sha256,
         read_only_mode = excluded.read_only_mode,
         approved_by = excluded.approved_by,
         approved_at = excluded.approved_at`,
    ).run(
      params.serverId,
      params.executablePath,
      params.executableSha256.toLowerCase(),
      params.readOnlyMode === false ? 0 : 1,
      params.approvedBy,
      params.now,
    );
    writeAuditEvent(db, {
      entityType: "mcp_server",
      entityId: params.serverId,
      eventKey: `pin_bin:${params.serverId}:${params.executableSha256.slice(0, 12)}`,
      eventType: "mcp_binary_pinned",
      occurredAt: params.now,
      details: {
        executablePath: params.executablePath,
        executableSha256: params.executableSha256.toLowerCase(),
        readOnlyMode: params.readOnlyMode !== false,
        approvedBy: params.approvedBy,
      },
    });
    return db
      .prepare("SELECT * FROM mcp_server_pins WHERE server_id = ?")
      .get(params.serverId) as unknown as McpServerPinRow;
  });
}

export function verifyMcpServerBinary(
  db: DatabaseSync,
  serverId: string,
): { ok: true; pin: McpServerPinRow; actualSha256: string } | { ok: false; code: string; reason: string } {
  const pin = db
    .prepare("SELECT * FROM mcp_server_pins WHERE server_id = ?")
    .get(serverId) as McpServerPinRow | undefined;
  if (!pin) {
    return { ok: false, code: "mcp_server_unpinned", reason: `No approved binary pin for MCP server ${serverId}` };
  }
  if (!path.isAbsolute(pin.executable_path)) {
    return { ok: false, code: "mcp_path_not_absolute", reason: `Pinned path is not absolute: ${pin.executable_path}` };
  }
  if (!existsSync(pin.executable_path)) {
    return { ok: false, code: "mcp_binary_missing", reason: `Pinned MCP binary does not exist: ${pin.executable_path}` };
  }
  const actualSha256 = sha256File(pin.executable_path);
  if (actualSha256.toLowerCase() !== pin.executable_sha256.toLowerCase()) {
    return {
      ok: false,
      code: "mcp_binary_sha256_mismatch",
      reason: `MCP binary SHA-256 mismatch for ${serverId}: expected ${pin.executable_sha256}, actual ${actualSha256}`,
    };
  }
  return { ok: true, pin, actualSha256 };
}

export function approveMcpToolDefinition(
  db: DatabaseSync,
  params: {
    serverId: string;
    def: McpToolDefinitionInput;
    now: number;
  },
): McpToolPinRow {
  const { canonicalDefJson, schemaSha256 } = computeMcpToolFingerprint(params.def);
  return withImmediateTx(db, () => {
    db.prepare(
      `INSERT INTO mcp_tool_pins(server_id, tool_name, schema_sha256, canonical_def_json, state, reason, updated_at)
       VALUES (?, ?, ?, ?, 'APPROVED', NULL, ?)
       ON CONFLICT(server_id, tool_name) DO UPDATE SET
         schema_sha256 = excluded.schema_sha256,
         canonical_def_json = excluded.canonical_def_json,
         state = 'APPROVED',
         reason = NULL,
         updated_at = excluded.updated_at`,
    ).run(params.serverId, params.def.name, schemaSha256, canonicalDefJson, params.now);
    writeAuditEvent(db, {
      entityType: "mcp_tool",
      entityId: `${params.serverId}:${params.def.name}`,
      eventKey: `approve:${params.serverId}:${params.def.name}:${schemaSha256.slice(0, 12)}`,
      eventType: "mcp_tool_approved",
      occurredAt: params.now,
      details: { serverId: params.serverId, toolName: params.def.name, schemaSha256 },
    });
    return db
      .prepare("SELECT * FROM mcp_tool_pins WHERE server_id = ? AND tool_name = ?")
      .get(params.serverId, params.def.name) as unknown as McpToolPinRow;
  });
}

export function verifyOrQuarantineMcpTool(
  db: DatabaseSync,
  params: {
    serverId: string;
    observedDef: McpToolDefinitionInput;
    now: number;
  },
): { ok: true; pin: McpToolPinRow } | { ok: false; code: string; reason: string; observedSha256: string } {
  const { canonicalDefJson, schemaSha256 } = computeMcpToolFingerprint(params.observedDef);
  return withImmediateTx(db, () => {
    const existing = db
      .prepare("SELECT * FROM mcp_tool_pins WHERE server_id = ? AND tool_name = ?")
      .get(params.serverId, params.observedDef.name) as McpToolPinRow | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO mcp_tool_pins(server_id, tool_name, schema_sha256, canonical_def_json, state, reason, updated_at)
         VALUES (?, ?, ?, ?, 'QUARANTINED', 'unapproved_tool_definition', ?)`,
      ).run(params.serverId, params.observedDef.name, schemaSha256, canonicalDefJson, params.now);
      writeAuditEvent(db, {
        entityType: "mcp_tool",
        entityId: `${params.serverId}:${params.observedDef.name}`,
        eventKey: `quarantine_unapproved:${params.serverId}:${params.observedDef.name}:${schemaSha256.slice(0, 12)}`,
        eventType: "mcp_tool_quarantined",
        occurredAt: params.now,
        details: { reason: "unapproved_tool_definition", observedSha256: schemaSha256 },
      });
      return {
        ok: false,
        code: "mcp_tool_unapproved",
        reason: `MCP tool ${params.observedDef.name} is not approved and has been quarantined`,
        observedSha256: schemaSha256,
      };
    }

    if (existing.state === "REVOKED") {
      return {
        ok: false,
        code: "mcp_tool_revoked",
        reason: `MCP tool ${params.observedDef.name} has been revoked`,
        observedSha256: schemaSha256,
      };
    }

    if (existing.state === "QUARANTINED") {
      return {
        ok: false,
        code: "mcp_tool_quarantined",
        reason: `MCP tool ${params.observedDef.name} is quarantined (${existing.reason ?? "definition_changed"})`,
        observedSha256: schemaSha256,
      };
    }

    if (existing.schema_sha256 !== schemaSha256) {
      db.prepare(
        `UPDATE mcp_tool_pins
            SET state = 'QUARANTINED',
                reason = ?,
                updated_at = ?
          WHERE server_id = ? AND tool_name = ?`,
      ).run(`definition_changed:${schemaSha256}`, params.now, params.serverId, params.observedDef.name);
      writeAuditEvent(db, {
        entityType: "mcp_tool",
        entityId: `${params.serverId}:${params.observedDef.name}`,
        eventKey: `quarantine_drift:${params.serverId}:${params.observedDef.name}:${schemaSha256.slice(0, 12)}`,
        eventType: "mcp_tool_quarantined",
        occurredAt: params.now,
        details: {
          reason: "definition_changed",
          approvedSha256: existing.schema_sha256,
          observedSha256: schemaSha256,
        },
      });
      return {
        ok: false,
        code: "mcp_tool_definition_changed",
        reason: `MCP tool ${params.observedDef.name} definition fingerprint changed (${existing.schema_sha256.slice(0, 12)} -> ${schemaSha256.slice(0, 12)}); quarantined`,
        observedSha256: schemaSha256,
      };
    }

    return { ok: true, pin: existing };
  });
}

export function revokeMcpTool(
  db: DatabaseSync,
  params: { serverId: string; toolName: string; reason: string; now: number },
): boolean {
  return withImmediateTx(db, () => {
    const ch = db
      .prepare("UPDATE mcp_tool_pins SET state = 'REVOKED', reason = ?, updated_at = ? WHERE server_id = ? AND tool_name = ?")
      .run(params.reason, params.now, params.serverId, params.toolName);
    if (Number(ch.changes) === 1) {
      writeAuditEvent(db, {
        entityType: "mcp_tool",
        entityId: `${params.serverId}:${params.toolName}`,
        eventKey: `revoke:${params.serverId}:${params.toolName}:${params.now}`,
        eventType: "mcp_tool_revoked",
        occurredAt: params.now,
        details: { reason: params.reason },
      });
      return true;
    }
    return false;
  });
}

export function getMcpToolPin(
  db: DatabaseSync,
  serverId: string,
  toolName: string,
): McpToolPinRow | null {
  const row = db
    .prepare("SELECT * FROM mcp_tool_pins WHERE server_id = ? AND tool_name = ?")
    .get(serverId, toolName) as McpToolPinRow | undefined;
  return row ?? null;
}
