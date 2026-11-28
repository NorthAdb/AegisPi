import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { atomicOperatorWrite, openOperatorCredentials } from "../governance/operator-credentials.ts";
import { grantSourceRead, revokeSourceReadGrant } from "../governance/policy.ts";
import { resolveOperatorModel } from "./models.ts";

const kinds = ["model", "gmail", "github"] as const;
type Kind = typeof kinds[number];
type Ref = { credentialRef: string; connectionId: string };
export type OperatorConnections = {
  model?: Ref & { provider: string; modelId: string; baseUrl: string };
  gmail?: Ref & { email: string; mailbox: string };
  github?: Ref & { repoId: string; ref: string; filePath: string };
};

function address(value: string) {
  return value.length <= 254 && /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(value);
}

function publicConnections(connections: OperatorConnections) {
  const { model, gmail, github } = connections;
  return {
    model: model && { provider: model.provider, modelId: model.modelId, baseUrl: model.baseUrl, credentialConfigured: true },
    gmail: gmail && { email: gmail.email, mailbox: gmail.mailbox, credentialConfigured: true },
    github: github && { repoId: github.repoId, ref: github.ref, filePath: github.filePath, credentialConfigured: true },
  };
}

export function openOperatorConnections(dataDir: string, prepareGithub: () => Promise<unknown>) {
  const file = path.join(dataDir, "operator-connections.json");
  const credentials = openOperatorCredentials(dataDir);
  let active: OperatorConnections = {};
  try {
    active = JSON.parse(readFileSync(file, "utf8")) as OperatorConnections;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("operator_connections_read_failed");
  }
  let saved = active;
  let saving = false;
  let applying = false;
  return {
    active,
    resolveSecret: credentials.resolve,
    status: () => ({
      available: process.platform === "win32",
      active: publicConnections(active),
      saved: publicConnections(saved),
      pendingRestart: saved !== active,
    }),
    beginApply() {
      if (applying || saving) return false;
      applying = true;
      return true;
    },
    async save(input: unknown): Promise<string | null> {
      if (applying || saving) return "settings_busy";
      if (process.platform !== "win32") return "windows_protection_unavailable";
      if (!input || typeof input !== "object" || Array.isArray(input)) return "invalid_connection";
      const fields = input as Record<string, unknown>;
      const get = (key: string) => typeof fields[key] === "string" ? fields[key].trim() : "";
      const kind = fields["kind"] as Kind;
      if (!kinds.includes(kind) || fields["authorize"] !== true) return "connection_authorization_required";
      let secret = get("secret");
      if (kind === "gmail") secret = secret.replace(/ /g, "");
      if (!secret || secret.length > 2048 || /[\x00-\x20\x7f]/.test(secret)) return "invalid_credential";
      const current = saved[kind];
      const connectionId = randomUUID();
      const credentialRef = "";
      let change: OperatorConnections;
      switch (kind) {
        case "model": {
          const provider = get("provider");
          const modelId = get("modelId");
          const profile = resolveOperatorModel(provider, modelId, get("baseUrl"));
          if (!profile) return "unverified_model_profile";
          change = { model: { provider, modelId, baseUrl: profile.baseUrl, credentialRef, connectionId } };
          break;
        }
        case "gmail": {
          const email = get("email");
          const mailbox = get("mailbox");
          if (!address(email) || !/^[a-z]{16}$/i.test(secret) || !mailbox || mailbox.length > 128 ||
              /[\x00-\x1f\x7f-\x9f]/.test(mailbox)) {
            return "invalid_gmail_connection";
          }
          const prior = saved.gmail;
          change = { gmail: {
            email, mailbox, credentialRef,
            connectionId: prior?.email === email && prior.mailbox === mailbox ? prior.connectionId : connectionId,
          } };
          break;
        }
        case "github": {
          const repoId = get("repoId");
          const branch = get("branch").replace(/^refs\/heads\//, "");
          const filePath = get("filePath");
          const segments = filePath.split("/");
          if (!/^github_pat_[\w]{20,240}$/.test(secret) ||
              !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repoId) ||
              !/^[A-Za-z0-9_./-]{1,180}$/.test(branch) || branch.startsWith("-") || branch.endsWith(".") ||
              branch.split("/").some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock")) ||
              !/^[A-Za-z0-9_./ -]{1,400}$/.test(filePath) || segments.some((segment) => !segment || segment === "." || segment === "..")) {
            return "invalid_github_connection";
          }
          const ref = `refs/heads/${branch}`;
          const prior = saved.github;
          change = { github: {
            repoId, ref, filePath, credentialRef,
            connectionId: prior?.repoId === repoId && prior.ref === ref && prior.filePath === filePath ? prior.connectionId : connectionId,
          } };
          break;
        }
      }
      if (JSON.stringify(change).includes(secret)) return "invalid_connection";
      saving = true;
      const entry = change[kind]!;
      try {
        if (kind === "github") {
          try {
            await prepareGithub();
          } catch {
            return "github_binary_unavailable";
          }
        }
        entry.credentialRef = credentials.save(secret);
        mkdirSync(dataDir, { recursive: true });
        const next = { ...saved, ...change };
        atomicOperatorWrite(file, JSON.stringify(next, null, 2) + "\n");
        saved = next;
      } catch {
        if (entry.credentialRef) {
          try { credentials.discard(entry.credentialRef); } catch { /* encrypted orphan */ }
        }
        return "connection_save_failed";
      } finally {
        saving = false;
      }
      if (current) {
        try { credentials.discard(current.credentialRef); } catch { /* encrypted orphan */ }
      }
      return null;
    },
  };
}

export function synchronizeOperatorReadGrants(db: DatabaseSync, principalId: string, connections: OperatorConnections) {
  const { gmail, github } = connections;
  for (const [type, entry] of [["imap", gmail], ["github_mcp", github]] as const) {
    if (!entry) continue;
    const rows = db.prepare(`
      SELECT grant_id, principal_id, revoked_at, json_extract(constraints_json, '$.operatorConnectionId') AS connection_id
      FROM source_read_grants WHERE scope_id = 'scope:default'
        AND source_type = ? AND json_extract(constraints_json, '$.operatorConnectionId') IS NOT NULL
    `).all(type) as Array<{ grant_id: string; principal_id: string; revoked_at: number | null; connection_id: string }>;
    const now = Date.now();
    for (const row of rows) {
      if (!row.revoked_at && (row.connection_id !== entry.connectionId || row.principal_id !== principalId)) {
        revokeSourceReadGrant(db, { grantId: row.grant_id, now, reason: "operator_connection_replaced" });
      }
    }
    // A manual revocation remains effective across restarts for this connection.
    if (rows.some((row) => row.connection_id === entry.connectionId && row.principal_id === principalId)) continue;
    const target = "mailbox" in entry ? {
      resourceId: `imap:${entry.mailbox}`,
      operations: ["read"],
      constraints: { allowedUsernames: [entry.email] },
    } : {
      resourceId: `github:${entry.repoId}`,
      operations: ["read_file"],
      constraints: { allowedRefs: [entry.ref], allowedPaths: [entry.filePath] },
    };
    grantSourceRead(db, {
      ...target, principalId, scopeId: "scope:default", sourceType: type, now,
      constraints: { ...target.constraints, operatorConnectionId: entry.connectionId },
    });
  }
}
