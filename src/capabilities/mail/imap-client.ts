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
  operatorConnectionId?: string;
  timeoutMs?: number;
  onObserveChildEnv?: (info: {
    entries?: Array<[string, string]>;
    keys: string[];
    valueDigests: Record<string, string>;
    passwordPresentInEnv: boolean;
  }) => void;
}

export interface ImapReadResult {
  ok: boolean;
  code: string;
  found?: boolean;
  error?: string;
  mode: "direct" | "connect_tunnel";
  tlsVerified: boolean;
  tlsPeerSubject?: string;
  readOnlyExamine?: boolean;
  usedBodyPeek?: boolean;
  seenUnchanged?: boolean;
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
  } | null;
  childEnvKeysObserved?: string[];
  childEnvValueDigests?: Record<string, string>;
}

function buildMinimalChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "TEMP", "TMP"]) {
    const val = process.env[key];
    if (val) out[key] = val;
  }
  return out;
}

function encodeImapMailbox(mailbox: string): string {
  return mailbox.replace(/&|[^\x20-\x7e]+/gu, (part) => {
    if (part === "&") return "&-";
    const encoded = Buffer.from(part, "utf16le").swap16().toString("base64").replaceAll("/", ",").replace(/=+$/, "");
    return `&${encoded}-`;
  });
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
  connectivityOnly?: boolean;
  verifyReadOnly?: boolean;
  now?: number;
}): Promise<ImapReadResult> {
  const now = params.now ?? Date.now();
  const auth = checkSourceReadAuthorized(params.govDb, {
    principalId: params.principalId,
    scopeId: params.scopeId,
    sourceType: "imap",
    resourceId: `imap:${params.endpoint.mailbox}`,
    operation: "read",
    operatorConnectionId: params.endpoint.operatorConnectionId,
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

  // W2-G1: Check grant constraints against target host, TLS servername, and username BEFORE releasing credential!
  const grantConstraints = JSON.parse(auth.grant.constraints_json || "{}") as {
    allowedHosts?: string[];
    allowedServernames?: string[];
    allowedUsernames?: string[];
  };
  if (
    Array.isArray(grantConstraints.allowedHosts) &&
    !grantConstraints.allowedHosts.some((h) => h.toLowerCase() === params.endpoint.host.toLowerCase())
  ) {
    return {
      ok: false,
      code: "imap_grant_host_mismatch",
      error: `IMAP grant does not authorize host ${params.endpoint.host}`,
      mode: params.endpoint.mode,
      tlsVerified: false,
    };
  }
  if (
    Array.isArray(grantConstraints.allowedServernames) &&
    !grantConstraints.allowedServernames.some((s) => s.toLowerCase() === params.endpoint.servername.toLowerCase())
  ) {
    return {
      ok: false,
      code: "imap_grant_tls_identity_mismatch",
      error: `IMAP grant does not authorize TLS servername ${params.endpoint.servername}`,
      mode: params.endpoint.mode,
      tlsVerified: false,
    };
  }
  if (
    Array.isArray(grantConstraints.allowedUsernames) &&
    !grantConstraints.allowedUsernames.includes(params.endpoint.username)
  ) {
    return {
      ok: false,
      code: "imap_grant_account_mismatch",
      error: `IMAP grant does not authorize account ${params.endpoint.username}`,
      mode: params.endpoint.mode,
      tlsVerified: false,
    };
  }

  const secretRes = params.vault.resolveImapSecretForTarget(params.endpoint.credentialSlotId, {
    host: params.endpoint.host,
    port: params.endpoint.port,
    servername: params.endpoint.servername,
    username: params.endpoint.username,
    mailbox: params.endpoint.mailbox,
    proxy: params.endpoint.proxy,
  });
  if (!secretRes.ok) {
    writeAuditEvent(params.govDb, {
      entityType: "imap_read",
      entityId: params.endpoint.mailbox,
      eventKey: `cred_mismatch:${params.principalId}:${now}:${params.endpoint.credentialSlotId}`,
      eventType: "imap_credential_rejected",
      occurredAt: now,
      details: {
        code: secretRes.code,
        reason: secretRes.reason,
        host: params.endpoint.host,
        servername: params.endpoint.servername,
        username: params.endpoint.username,
      },
    });
    return {
      ok: false,
      code: secretRes.code,
      error: secretRes.reason,
      mode: params.endpoint.mode,
      tlsVerified: false,
    };
  }
  const secret = secretRes.secret;

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
    // Web settings take the display name. Existing host configuration already supplies the IMAP wire name.
    mailbox: params.endpoint.operatorConnectionId ? encodeImapMailbox(params.endpoint.mailbox) : params.endpoint.mailbox,
    ...(params.uid !== undefined ? { uid: params.uid } : {}),
    ...(params.subjectContains ? { subjectContains: params.subjectContains } : {}),
    ...(params.connectivityOnly ? { connectivityOnly: true } : {}),
    ...(params.verifyReadOnly ? { verifyReadOnly: true } : {}),
    ...(params.endpoint.onObserveChildEnv ? { includeEnvValuesForAudit: true } : {}),
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

  const parsed = JSON.parse(line) as ImapReadResult & {
    passwordPresentInEnv?: boolean;
    childEnvEntriesObserved?: Array<[string, string]>;
  };
  if (params.endpoint.onObserveChildEnv) {
    params.endpoint.onObserveChildEnv({
      entries: parsed.childEnvEntriesObserved ?? [],
      keys: parsed.childEnvKeysObserved ?? [],
      valueDigests: parsed.childEnvValueDigests ?? {},
      passwordPresentInEnv: Boolean(parsed.passwordPresentInEnv),
    });
  }
  delete parsed.childEnvEntriesObserved;
  if (parsed.ok && parsed.message) {
    parsed.message.contentDigest = sha256Hex(`${parsed.message.subject}\n${parsed.message.body}`);
  }
  if (parsed.ok) {
    writeAuditEvent(params.govDb, {
      entityType: "imap_read",
      entityId: params.endpoint.mailbox,
      eventKey: `completed:${params.principalId}:${now}:${parsed.message?.uid ?? "none"}`,
      eventType: "imap_read_completed",
      occurredAt: now,
      details: {
        mailbox: params.endpoint.mailbox,
        uid: parsed.message?.uid ?? null,
        found: parsed.found ?? Boolean(parsed.message),
        mode: parsed.mode,
        tlsVerified: parsed.tlsVerified,
        readOnlyExamine: parsed.readOnlyExamine ?? false,
        usedBodyPeek: parsed.usedBodyPeek ?? false,
        childEnvKeysObserved: parsed.childEnvKeysObserved ?? [],
        childEnvValueDigests: parsed.childEnvValueDigests ?? {},
        passwordPresentInEnv: Boolean(parsed.passwordPresentInEnv),
      },
    });
  }
  return parsed;
}
