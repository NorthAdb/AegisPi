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
  command: string;
  args_json: string;
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
    command?: string;
    args?: string[];
    readOnlyMode?: boolean;
    approvedBy: string;
    now: number;
  },
): McpServerPinRow {
  if (!path.isAbsolute(params.executablePath)) {
    throw new Error(`MCP server executable path must be absolute: ${params.executablePath}`);
  }
  const command = params.command ?? params.executablePath;
  if (!path.isAbsolute(command)) {
    throw new Error(`MCP server launch command must be absolute: ${command}`);
  }
  const args = params.args ? [...params.args] : [];
  if (command !== params.executablePath && !args.includes(params.executablePath)) {
    throw new Error(
      `MCP server launch args must include pinned artifact ${params.executablePath} when launching via wrapper ${command}`,
    );
  }
  return withImmediateTx(db, () => {
    db.prepare(
      `INSERT INTO mcp_server_pins(
         server_id, executable_path, executable_sha256, command, args_json, read_only_mode, approved_by, approved_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         executable_path = excluded.executable_path,
         executable_sha256 = excluded.executable_sha256,
         command = excluded.command,
         args_json = excluded.args_json,
         read_only_mode = excluded.read_only_mode,
         approved_by = excluded.approved_by,
         approved_at = excluded.approved_at`,
    ).run(
      params.serverId,
      params.executablePath,
      params.executableSha256.toLowerCase(),
      command,
      JSON.stringify(args),
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
        command,
        args,
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
  launch?: {
    command: string;
    args: string[];
    pinnedArtifactPath?: string;
  },
): { ok: true; pin: McpServerPinRow; actualSha256: string; pinnedCommand: string; pinnedArgs: string[] } | { ok: false; code: string; reason: string } {
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
  const pinnedCommand = pin.command && pin.command.length > 0 ? pin.command : pin.executable_path;
  let pinnedArgs: string[] = [];
  try {
    const parsed = JSON.parse(pin.args_json || "[]") as unknown;
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === "string")) {
      return { ok: false, code: "mcp_pin_args_invalid", reason: `Invalid pinned args_json for ${serverId}` };
    }
    pinnedArgs = parsed;
  } catch {
    return { ok: false, code: "mcp_pin_args_invalid", reason: `Malformed pinned args_json for ${serverId}` };
  }
  if (!path.isAbsolute(pinnedCommand) || !existsSync(pinnedCommand)) {
    return {
      ok: false,
      code: "mcp_command_missing",
      reason: `Pinned MCP command does not exist or is not absolute: ${pinnedCommand}`,
    };
  }
  if (launch) {
    if (launch.pinnedArtifactPath && launch.pinnedArtifactPath !== pin.executable_path) {
      return {
        ok: false,
        code: "mcp_binary_path_mismatch",
        reason: `Configured artifact ${launch.pinnedArtifactPath} does not match pinned path ${pin.executable_path}`,
      };
    }
    if (launch.command !== pinnedCommand) {
      return {
        ok: false,
        code: "mcp_command_mismatch",
        reason: `Launch command ${launch.command} does not match pinned command ${pinnedCommand}`,
      };
    }
    if (
      launch.args.length !== pinnedArgs.length ||
      launch.args.some((arg, i) => arg !== pinnedArgs[i])
    ) {
      return {
        ok: false,
        code: "mcp_args_mismatch",
        reason: `Launch args do not match pinned args for ${serverId}`,
      };
    }
  }
  return { ok: true, pin, actualSha256, pinnedCommand, pinnedArgs };
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

export function listMcpServerPins(db: DatabaseSync): McpServerPinRow[] {
  return db
    .prepare("SELECT * FROM mcp_server_pins ORDER BY server_id ASC")
    .all() as unknown as McpServerPinRow[];
}

export function listMcpToolPins(db: DatabaseSync, serverId?: string): McpToolPinRow[] {
  if (serverId) {
    return db
      .prepare("SELECT * FROM mcp_tool_pins WHERE server_id = ? ORDER BY tool_name ASC")
      .all(serverId) as unknown as McpToolPinRow[];
  }
  return db
    .prepare("SELECT * FROM mcp_tool_pins ORDER BY server_id ASC, tool_name ASC")
    .all() as unknown as McpToolPinRow[];
}

/**
 * C4: Quarantine any previously APPROVED tools that disappeared from tools/list on reconnect/refresh,
 * and update observed canonical_def_json on quarantined drift so human approval can review the latest schema.
 */
export function quarantineMissingMcpTools(
  db: DatabaseSync,
  params: { serverId: string; observedToolNames: string[]; now: number },
): string[] {
  const observed = new Set(params.observedToolNames);
  return withImmediateTx(db, () => {
    const existing = db
      .prepare("SELECT * FROM mcp_tool_pins WHERE server_id = ? AND state = 'APPROVED'")
      .all(params.serverId) as unknown as McpToolPinRow[];
    const quarantined: string[] = [];
    for (const row of existing) {
      if (!observed.has(row.tool_name)) {
        db.prepare(
          `UPDATE mcp_tool_pins
              SET state = 'QUARANTINED',
                  reason = 'missing_from_tools_list',
                  updated_at = ?
            WHERE server_id = ? AND tool_name = ?`,
        ).run(params.now, params.serverId, row.tool_name);
        writeAuditEvent(db, {
          entityType: "mcp_tool",
          entityId: `${params.serverId}:${row.tool_name}`,
          eventKey: `quarantine_missing:${params.serverId}:${row.tool_name}:${params.now}`,
          eventType: "mcp_tool_quarantined",
          occurredAt: params.now,
          details: { reason: "missing_from_tools_list", previousSha256: row.schema_sha256 },
        });
        quarantined.push(row.tool_name);
      }
    }
    return quarantined;
  });
}

/**
 * C4: When verifyOrQuarantineMcpTool observes drift on an existing tool, also persist the latest
 * observed definition so human review/approval can inspect and explicitly approve the new fingerprint.
 */
export function recordObservedDriftDefinition(
  db: DatabaseSync,
  params: { serverId: string; observedDef: McpToolDefinitionInput; now: number },
): { canonicalDefJson: string; schemaSha256: string } {
  const { canonicalDefJson, schemaSha256 } = computeMcpToolFingerprint(params.observedDef);
  withImmediateTx(db, () => {
    db.prepare(
      `UPDATE mcp_tool_pins
          SET canonical_def_json = ?,
              updated_at = ?
        WHERE server_id = ? AND tool_name = ? AND state = 'QUARANTINED'`,
    ).run(canonicalDefJson, params.now, params.serverId, params.observedDef.name);
  });
  return { canonicalDefJson, schemaSha256 };
}

/**
 * S2-P0-3b: Returns full canonical definition & freshly computed observed SHA-256 for human Pin review.
 */
export function inspectStoredMcpToolPin(row: McpToolPinRow): {
  serverId: string;
  toolName: string;
  pinnedSchemaSha256: string;
  observedSchemaSha256: string;
  canonicalDefJson: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
  drifted: boolean;
  state: McpToolPinRow["state"];
  reason: string | null;
  updatedAt: number;
} {
  let description = "";
  let inputSchema: Record<string, unknown> | null = null;
  let canonicalDefJson = row.canonical_def_json;
  let observedSchemaSha256 = row.schema_sha256;
  try {
    const parsed = JSON.parse(row.canonical_def_json) as McpToolDefinitionInput;
    description = typeof parsed.description === "string" ? parsed.description : "";
    inputSchema =
      parsed.inputSchema && typeof parsed.inputSchema === "object"
        ? (parsed.inputSchema as Record<string, unknown>)
        : null;
    const fp = computeMcpToolFingerprint(parsed);
    canonicalDefJson = fp.canonicalDefJson;
    observedSchemaSha256 = fp.schemaSha256;
  } catch {
    // keep stored values
  }
  return {
    serverId: row.server_id,
    toolName: row.tool_name,
    pinnedSchemaSha256: row.schema_sha256,
    observedSchemaSha256,
    canonicalDefJson,
    description,
    inputSchema,
    drifted: observedSchemaSha256 !== row.schema_sha256,
    state: row.state,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

/**
 * C4 / S2-P0-3b: Human approval of a quarantined/revoked MCP tool strictly bound to the
 * exact canonical definition and SHA-256 fingerprint the human reviewed.
 * Stale or mismatched approval requests are rejected atomically inside the same IMMEDIATE transaction!
 */
export function approveStoredMcpToolPin(
  db: DatabaseSync,
  params: {
    serverId: string;
    toolName: string;
    expectedSchemaSha256: string;
    expectedCanonicalDefJson?: string;
    approvedBy: string;
    now: number;
  },
): { ok: true; pin: McpToolPinRow } | { ok: false; httpStatus: 400 | 404 | 409; code: string; reason: string } {
  const expectedSha = typeof params.expectedSchemaSha256 === "string" ? params.expectedSchemaSha256.trim().toLowerCase() : "";
  if (!expectedSha) {
    return {
      ok: false,
      httpStatus: 400,
      code: "mcp_pin_expected_sha_required",
      reason: "Human Pin approval requires expectedSchemaSha256 matching the reviewed definition",
    };
  }
  return withImmediateTx(db, () => {
    const existing = db
      .prepare("SELECT * FROM mcp_tool_pins WHERE server_id = ? AND tool_name = ?")
      .get(params.serverId, params.toolName) as McpToolPinRow | undefined;
    if (!existing) {
      return {
        ok: false,
        httpStatus: 404,
        code: "mcp_tool_not_found",
        reason: `MCP tool ${params.serverId}:${params.toolName} not found`,
      };
    }
    const parsed = JSON.parse(existing.canonical_def_json) as McpToolDefinitionInput;
    const { canonicalDefJson, schemaSha256 } = computeMcpToolFingerprint(parsed);
    if (schemaSha256.toLowerCase() !== expectedSha) {
      return {
        ok: false,
        httpStatus: 409,
        code: "mcp_pin_fingerprint_mismatch",
        reason: `Stale MCP tool Pin approval: expected ${expectedSha.slice(0, 12)}, stored definition is ${schemaSha256.slice(0, 12)}`,
      };
    }
    if (
      params.expectedCanonicalDefJson !== undefined &&
      params.expectedCanonicalDefJson !== canonicalDefJson
    ) {
      return {
        ok: false,
        httpStatus: 409,
        code: "mcp_pin_definition_mismatch",
        reason: "Stale MCP tool Pin approval: canonical definition changed since review",
      };
    }
    db.prepare(
      `UPDATE mcp_tool_pins
          SET schema_sha256 = ?,
              canonical_def_json = ?,
              state = 'APPROVED',
              reason = NULL,
              updated_at = ?
        WHERE server_id = ? AND tool_name = ?`,
    ).run(schemaSha256, canonicalDefJson, params.now, params.serverId, params.toolName);
    writeAuditEvent(db, {
      entityType: "mcp_tool",
      entityId: `${params.serverId}:${params.toolName}`,
      eventKey: `approve_ui:${params.serverId}:${params.toolName}:${schemaSha256.slice(0, 12)}:${params.now}`,
      eventType: "mcp_tool_approved",
      occurredAt: params.now,
      details: {
        serverId: params.serverId,
        toolName: params.toolName,
        schemaSha256,
        approvedBy: params.approvedBy,
      },
    });
    const updated = db
      .prepare("SELECT * FROM mcp_tool_pins WHERE server_id = ? AND tool_name = ?")
      .get(params.serverId, params.toolName) as unknown as McpToolPinRow;
    return { ok: true, pin: updated };
  });
}

/**
 * C4: Re-checks live tool pin admission AND optional expected schema fingerprint (for queued/pending calls).
 */
export function verifyLiveMcpToolPin(
  db: DatabaseSync,
  params: { serverId: string; toolName: string; expectedSchemaSha256?: string | null },
): { ok: true; pin: McpToolPinRow } | { ok: false; code: string; reason: string } {
  const pin = getMcpToolPin(db, params.serverId, params.toolName);
  if (!pin) {
    return { ok: false, code: "mcp_tool_unapproved", reason: `MCP tool ${params.toolName} has no approved pin` };
  }
  if (pin.state === "REVOKED") {
    return { ok: false, code: "mcp_tool_revoked", reason: `MCP tool ${params.toolName} has been revoked` };
  }
  if (pin.state !== "APPROVED") {
    return {
      ok: false,
      code: "mcp_tool_quarantined",
      reason: `MCP tool ${params.toolName} is quarantined (${pin.reason ?? "pin_drift"})`,
    };
  }
  if (params.expectedSchemaSha256 && pin.schema_sha256 !== params.expectedSchemaSha256) {
    return {
      ok: false,
      code: "mcp_tool_fingerprint_changed",
      reason: `MCP tool ${params.toolName} fingerprint changed since proposal (${params.expectedSchemaSha256.slice(0, 12)} -> ${pin.schema_sha256.slice(0, 12)}); re-proposal required`,
    };
  }
  return { ok: true, pin };
}
