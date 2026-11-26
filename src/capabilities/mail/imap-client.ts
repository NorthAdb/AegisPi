import { spawn } from "node:child_process";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../../governance/canonical.ts";
import type { HostCredentialVault } from "../../governance/credentials.ts";
import { writeAuditEvent } from "../../governance/db.ts";
import { checkSourceReadAuthorized } from "../../governance/policy.ts";

export interface ImapEndpointConfig {
  mode: "direct" | "connect_tunnel";
  host: string;
  port: number;
  servername: string;
  caPem?: string;
  proxy?: { host: string; port: number };
  username: string;
  credentialSlotId: string;
  mailbox: string;
  timeoutMs?: number;
}

export interface ImapReadResult {
  ok: boolean;
  code: string;
  error?: string;
  mode: "direct" | "connect_tunnel";
  tlsVerified: boolean;
  tlsPeerSubject?: string;
  readOnlyExamine?: boolean;
  usedBodyPeek?: boolean;
  mailbox?: string;
  uidValidity?: number;
  message?: {
    uid: number;
    flags: string[];
    from: string;
    to: string;
    subject: string;
    date: string;
    messageId: string;
    body: string;
    contentDigest: string;
  };
  childEnvKeysObserved?: string[];
}

function buildMinimalChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "TEMP", "TMP"]) {
    const val = process.env[key];
    if (val) out[key] = val;
  }
  return out;
}

/**
 * Host read-only IMAP adapter.
 * 1. Verifies live source_read_grants for (principalId, scopeId, "imap", mailbox, "read").
 * 2. Resolves credential strictly in host memory from HostCredentialVault.
 * 3. Spawns isolated short-lived imap-child.ts with minimal non-secret env and passes credential ONLY via stdin.
 */
export async function readImapMessageReadOnly(params: {
  govDb: DatabaseSync;
  vault: HostCredentialVault;
  endpoint: ImapEndpointConfig;
  principalId: string;
  scopeId: string;
  uid?: number;
  subjectContains?: string;
  now?: number;
}): Promise<ImapReadResult> {
  const now = params.now ?? Date.now();
  const auth = checkSourceReadAuthorized(params.govDb, {
    principalId: params.principalId,
    scopeId: params.scopeId,
    sourceType: "imap",
    resourceId: `imap:${params.endpoint.mailbox}`,
    operation: "read",
  });
  if (!auth.ok) {
    writeAuditEvent(params.govDb, {
      entityType: "imap_read",
      entityId: params.endpoint.mailbox,
      eventKey: `denied:${params.principalId}:${now}:${params.uid ?? "latest"}`,
      eventType: "imap_read_denied",
      occurredAt: now,
      details: { principalId: params.principalId, scopeId: params.scopeId, reason: auth.reason },
    });
    return {
      ok: false,
      code: auth.code,
      error: auth.reason,
      mode: params.endpoint.mode,
      tlsVerified: false,
    };
  }

  const secret = params.vault.resolveConnectorSecretInMemory(params.endpoint.credentialSlotId, "imap");
  if (!secret) {
    return {
      ok: false,
      code: "missing_imap_credential",
      error: `IMAP credential slot ${params.endpoint.credentialSlotId} not loaded in host memory`,
      mode: params.endpoint.mode,
      tlsVerified: false,
    };
  }

  const childScript = path.resolve("src/capabilities/mail/imap-child.ts");
  const child = spawn(process.execPath, [childScript], {
    stdio: ["pipe", "pipe", "pipe"],
    env: buildMinimalChildEnv(),
    windowsHide: true,
  });

  const stdinPayload = JSON.stringify({
    mode: params.endpoint.mode,
    host: params.endpoint.host,
    port: params.endpoint.port,
    servername: params.endpoint.servername,
    ...(params.endpoint.caPem ? { caPem: params.endpoint.caPem } : {}),
    ...(params.endpoint.proxy ? { proxy: params.endpoint.proxy } : {}),
    username: params.endpoint.username,
    password: secret,
    mailbox: params.endpoint.mailbox,
    ...(params.uid !== undefined ? { uid: params.uid } : {}),
    ...(params.subjectContains ? { subjectContains: params.subjectContains } : {}),
    timeoutMs: params.endpoint.timeoutMs ?? 15_000,
  });

  let stdout = "";
  let stderr = "";
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });

  child.stdin.end(stdinPayload, "utf8");
  await exitPromise;

  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  if (!line) {
    return {
      ok: false,
      code: "imap_child_no_output",
      error: stderr.split(secret).join("[REDACTED_CREDENTIAL]") || "IMAP child produced no output",
      mode: params.endpoint.mode,
      tlsVerified: false,
    };
  }

  const parsed = JSON.parse(line) as ImapReadResult;
  if (parsed.ok && parsed.message) {
    parsed.message.contentDigest = sha256Hex(`${parsed.message.subject}\n${parsed.message.body}`);
  }
  return parsed;
}
