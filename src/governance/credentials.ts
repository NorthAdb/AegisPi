export class Stage1EgressBlockedError extends Error {
  readonly code = "stage1_egress_blocked";
  readonly target: string;
  constructor(target: string, message: string) {
    super(message);
    this.name = "Stage1EgressBlockedError";
    this.target = target;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

export function assertStage1LoopbackModelUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Stage1EgressBlockedError(rawUrl, `Stage 1 blocks malformed model base URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Stage1EgressBlockedError(
      rawUrl,
      `Stage 1 blocks non-HTTP(S) model base URL protocol: ${parsed.protocol}`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Stage1EgressBlockedError(rawUrl, "Stage 1 blocks embedded credentials in model base URL");
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Stage1EgressBlockedError(
      rawUrl,
      `Stage 1 blocks non-loopback model endpoint: ${parsed.hostname}`,
    );
  }
  return rawUrl.replace(/\/+$/, "");
}

export function assertStage1LoopbackSmtpHost(host: string, port: number): void {
  if (!host || !isLoopbackHost(host)) {
    throw new Stage1EgressBlockedError(
      `${host}:${port}`,
      `Stage 1 blocks non-loopback SMTP host: ${host}`,
    );
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Stage1EgressBlockedError(
      `${host}:${port}`,
      `Stage 1 blocks invalid SMTP port: ${String(port)}`,
    );
  }
}

export type StageProfile = 1 | 2;

export interface StageEgressPolicy {
  stage: StageProfile;
  allowedRemoteModelHosts?: string[];
  allowedRemoteSmtpHosts?: string[];
}

export function assertModelUrlForStage(rawUrl: string, policy?: StageEgressPolicy): string {
  const stage = policy?.stage ?? 1;
  if (stage === 1) {
    return assertStage1LoopbackModelUrl(rawUrl);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Stage1EgressBlockedError(rawUrl, `Stage 2 blocks malformed model base URL: ${rawUrl}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Stage1EgressBlockedError(rawUrl, "Stage 2 blocks embedded credentials in model base URL");
  }
  if (isLoopbackHost(parsed.hostname)) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Stage1EgressBlockedError(rawUrl, `Stage 2 blocks non-HTTP(S) loopback model URL: ${parsed.protocol}`);
    }
    return rawUrl.replace(/\/+$/, "");
  }
  if (parsed.protocol !== "https:") {
    throw new Stage1EgressBlockedError(rawUrl, `Stage 2 requires HTTPS for remote model endpoint: ${rawUrl}`);
  }
  const allowed = (policy?.allowedRemoteModelHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(parsed.hostname.trim().toLowerCase())) {
    throw new Stage1EgressBlockedError(
      rawUrl,
      `Stage 2 blocks non-allowlisted remote model host: ${parsed.hostname}`,
    );
  }
  return rawUrl.replace(/\/+$/, "");
}

export function assertSmtpHostForStage(
  host: string,
  port: number,
  policy?: StageEgressPolicy,
  opts?: { tlsEnabled?: boolean },
): void {
  const stage = policy?.stage ?? 1;
  if (stage === 1) {
    assertStage1LoopbackSmtpHost(host, port);
    return;
  }
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Stage1EgressBlockedError(`${host}:${port}`, `Stage 2 blocks invalid SMTP endpoint: ${host}:${String(port)}`);
  }
  if (isLoopbackHost(host)) {
    return;
  }
  if (!opts?.tlsEnabled) {
    throw new Stage1EgressBlockedError(
      `${host}:${port}`,
      `Stage 2 requires verified TLS for remote SMTP host: ${host}`,
    );
  }
  const allowed = (policy?.allowedRemoteSmtpHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(host.trim().toLowerCase())) {
    throw new Stage1EgressBlockedError(
      `${host}:${port}`,
      `Stage 2 blocks non-allowlisted remote SMTP host: ${host}`,
    );
  }
}

export interface CredentialSlotBinding {
  slotId: string;
  provider: string;
  allowedBaseUrls: string[];
  allowedModelIds: string[];
  priceVersion: string;
}

export interface ModelPriceSchedule {
  priceVersion: string;
  /** Per-1M token rates in integer microUSD (1 USD = 1_000_000 mu). */
  inputPerMTokMu: number;
  outputPerMTokMu: number;
  cacheReadPerMTokMu?: number;
  /** Provable integer microUSD per-request upper bound required for T6 reservation in Stage 1. */
  syntheticFixedUpperMu?: number | null;
  syntheticFixedActualMu?: number | null;
  /** Stage 2 real-provider mode: compute conservative integer microUSD upper bound from input + maxTokens. */
  allowTokenBoundEstimation?: boolean;
}

export interface ImapCredentialBinding {
  host: string;
  port?: number;
  servername: string;
  username: string;
  allowedMailboxes?: string[];
  proxyHost?: string;
  proxyPort?: number;
}

export interface GithubMcpCredentialBinding {
  serverId: string;
  command: string;
  args: string[];
  executablePath: string;
  executableSha256: string;
  readOnlyRequired?: boolean;
}

export interface SmtpCredentialBinding {
  host: string;
  port?: number;
  servername?: string;
  username?: string;
  fromAddress?: string;
  proxyHost?: string;
  proxyPort?: number;
}

export type ConnectorCredentialBinding =
  | { kind: "imap"; binding: ImapCredentialBinding }
  | { kind: "github_mcp"; binding: GithubMcpCredentialBinding }
  | { kind: "smtp"; binding: SmtpCredentialBinding };

interface StoredConnectorSecret {
  kind: "imap" | "github_mcp" | "smtp";
  target: string;
  secret: string;
  imapBinding?: ImapCredentialBinding;
  githubMcpBinding?: GithubMcpCredentialBinding;
  smtpBinding?: SmtpCredentialBinding;
}

export class HostCredentialVault {
  readonly #secrets = new Map<string, string>();
  readonly #bindings = new Map<string, CredentialSlotBinding>();
  readonly #connectorSecrets = new Map<string, StoredConnectorSecret>();

  registerConnectorSlot(params: {
    slotId: string;
    kind: "imap" | "github_mcp" | "smtp";
    target: string;
    secretValue: string;
    imapBinding?: ImapCredentialBinding;
    githubMcpBinding?: GithubMcpCredentialBinding;
    smtpBinding?: SmtpCredentialBinding;
  }): void {
    if (!params.slotId || !params.secretValue) {
      throw new Error("Connector credential slot requires slotId and non-empty secretValue");
    }
    this.#connectorSecrets.set(params.slotId, {
      kind: params.kind,
      target: params.target,
      secret: params.secretValue,
      ...(params.imapBinding
        ? {
            imapBinding: {
              ...params.imapBinding,
              allowedMailboxes: params.imapBinding.allowedMailboxes
                ? [...params.imapBinding.allowedMailboxes]
                : undefined,
            },
          }
        : {}),
      ...(params.githubMcpBinding
        ? {
            githubMcpBinding: {
              ...params.githubMcpBinding,
              args: [...params.githubMcpBinding.args],
              executableSha256: params.githubMcpBinding.executableSha256.toLowerCase(),
              readOnlyRequired: params.githubMcpBinding.readOnlyRequired ?? true,
            },
          }
        : {}),
      ...(params.smtpBinding ? { smtpBinding: { ...params.smtpBinding } } : {}),
    });
  }

  resolveImapSecretForTarget(
    slotId: string,
    target: {
      host: string;
      port: number;
      servername: string;
      username: string;
      mailbox: string;
      proxy?: { host: string; port: number };
    },
  ): { ok: true; secret: string } | { ok: false; code: string; reason: string } {
    const entry = this.#connectorSecrets.get(slotId);
    if (!entry || entry.kind !== "imap") {
      return {
        ok: false,
        code: "missing_imap_credential",
        reason: `IMAP credential slot ${slotId} not loaded in host memory`,
      };
    }
    const b = entry.imapBinding;
    if (!b) {
      return {
        ok: false,
        code: "imap_credential_unbound",
        reason: `IMAP credential slot ${slotId} lacks required target/TLS/account binding`,
      };
    }
    if (b.host.trim().toLowerCase() !== target.host.trim().toLowerCase()) {
      return {
        ok: false,
        code: "imap_credential_target_mismatch",
        reason: `IMAP slot ${slotId} bound to host ${b.host}, not ${target.host}`,
      };
    }
    if (b.port !== undefined && b.port !== target.port) {
      return {
        ok: false,
        code: "imap_credential_target_mismatch",
        reason: `IMAP slot ${slotId} bound to port ${b.port}, not ${target.port}`,
      };
    }
    if (b.servername.trim().toLowerCase() !== target.servername.trim().toLowerCase()) {
      return {
        ok: false,
        code: "imap_credential_tls_identity_mismatch",
        reason: `IMAP slot ${slotId} bound to TLS servername ${b.servername}, not ${target.servername}`,
      };
    }
    if (b.username !== target.username) {
      return {
        ok: false,
        code: "imap_credential_account_mismatch",
        reason: `IMAP slot ${slotId} bound to account ${b.username}, not ${target.username}`,
      };
    }
    if (b.allowedMailboxes && b.allowedMailboxes.length > 0) {
      if (!b.allowedMailboxes.includes(target.mailbox) && !b.allowedMailboxes.includes("*")) {
        return {
          ok: false,
          code: "imap_credential_mailbox_mismatch",
          reason: `IMAP slot ${slotId} does not allow mailbox ${target.mailbox}`,
        };
      }
    }
    if (b.proxyHost !== undefined) {
      if (!target.proxy || b.proxyHost.toLowerCase() !== target.proxy.host.toLowerCase()) {
        return {
          ok: false,
          code: "imap_credential_proxy_mismatch",
          reason: `IMAP slot ${slotId} proxy host mismatch`,
        };
      }
      if (b.proxyPort !== undefined && b.proxyPort !== target.proxy.port) {
        return {
          ok: false,
          code: "imap_credential_proxy_mismatch",
          reason: `IMAP slot ${slotId} proxy port mismatch`,
        };
      }
    }
    return { ok: true, secret: entry.secret };
  }

  resolveGithubMcpSecretForTarget(
    slotId: string,
    target: {
      serverId: string;
      command: string;
      args: string[];
      executablePath: string;
      executableSha256: string;
      readOnlyMode: boolean;
    },
  ): { ok: true; secret: string } | { ok: false; code: string; reason: string } {
    const entry = this.#connectorSecrets.get(slotId);
    if (!entry || entry.kind !== "github_mcp") {
      return {
        ok: false,
        code: "missing_mcp_credential",
        reason: `GitHub MCP credential slot ${slotId} not found in host memory`,
      };
    }
    const b = entry.githubMcpBinding;
    if (!b) {
      return {
        ok: false,
        code: "mcp_credential_unbound",
        reason: `GitHub MCP credential slot ${slotId} lacks required artifact/launch binding`,
      };
    }
    if (b.serverId !== target.serverId) {
      return {
        ok: false,
        code: "mcp_credential_server_mismatch",
        reason: `GitHub MCP slot ${slotId} bound to server ${b.serverId}, not ${target.serverId}`,
      };
    }
    if (b.readOnlyRequired !== false && !target.readOnlyMode) {
      return {
        ok: false,
        code: "mcp_not_read_only",
        reason: `GitHub MCP slot ${slotId} requires readOnlyMode=true`,
      };
    }
    if (b.executablePath !== target.executablePath) {
      return {
        ok: false,
        code: "mcp_credential_artifact_mismatch",
        reason: `GitHub MCP slot ${slotId} bound to artifact ${b.executablePath}, not ${target.executablePath}`,
      };
    }
    if (b.executableSha256.toLowerCase() !== target.executableSha256.toLowerCase()) {
      return {
        ok: false,
        code: "mcp_credential_sha256_mismatch",
        reason: `GitHub MCP slot ${slotId} artifact SHA-256 mismatch`,
      };
    }
    if (b.command !== target.command) {
      return {
        ok: false,
        code: "mcp_credential_command_mismatch",
        reason: `GitHub MCP slot ${slotId} bound to command ${b.command}, not ${target.command}`,
      };
    }
    if (
      b.args.length !== target.args.length ||
      b.args.some((arg, i) => arg !== target.args[i])
    ) {
      return {
        ok: false,
        code: "mcp_credential_args_mismatch",
        reason: `GitHub MCP slot ${slotId} launch args do not match pinned binding`,
      };
    }
    return { ok: true, secret: entry.secret };
  }

  resolveSmtpSecretForTarget(
    slotId: string,
    target: {
      host: string;
      port: number;
      servername?: string;
      username?: string;
      fromAddress?: string;
      proxy?: { host: string; port: number };
    },
  ): { ok: true; secret: string } | { ok: false; code: string; reason: string } {
    const entry = this.#connectorSecrets.get(slotId);
    if (!entry || entry.kind !== "smtp") {
      return {
        ok: false,
        code: "missing_smtp_credential",
        reason: `SMTP credential slot ${slotId} not loaded in host memory`,
      };
    }
    const b = entry.smtpBinding;
    if (!b) {
      return {
        ok: false,
        code: "smtp_credential_unbound",
        reason: `SMTP credential slot ${slotId} lacks required target binding`,
      };
    }
    if (b.host.trim().toLowerCase() !== target.host.trim().toLowerCase()) {
      return {
        ok: false,
        code: "smtp_credential_target_mismatch",
        reason: `SMTP slot ${slotId} bound to host ${b.host}, not ${target.host}`,
      };
    }
    if (b.port !== undefined && b.port !== target.port) {
      return {
        ok: false,
        code: "smtp_credential_target_mismatch",
        reason: `SMTP slot ${slotId} bound to port ${b.port}, not ${target.port}`,
      };
    }
    if (b.servername && target.servername && b.servername.trim().toLowerCase() !== target.servername.trim().toLowerCase()) {
      return {
        ok: false,
        code: "smtp_credential_tls_identity_mismatch",
        reason: `SMTP slot ${slotId} bound to TLS servername ${b.servername}, not ${target.servername}`,
      };
    }
    if (b.username && target.username && b.username !== target.username) {
      return {
        ok: false,
        code: "smtp_credential_account_mismatch",
        reason: `SMTP slot ${slotId} bound to account ${b.username}, not ${target.username}`,
      };
    }
    if (b.fromAddress && target.fromAddress && b.fromAddress.toLowerCase() !== target.fromAddress.toLowerCase()) {
      return {
        ok: false,
        code: "smtp_credential_from_mismatch",
        reason: `SMTP slot ${slotId} bound to sender ${b.fromAddress}, not ${target.fromAddress}`,
      };
    }
    if (b.proxyHost !== undefined) {
      if (!target.proxy || b.proxyHost.toLowerCase() !== target.proxy.host.toLowerCase()) {
        return {
          ok: false,
          code: "smtp_credential_proxy_mismatch",
          reason: `SMTP slot ${slotId} proxy host mismatch`,
        };
      }
      if (b.proxyPort !== undefined && b.proxyPort !== target.proxy.port) {
        return {
          ok: false,
          code: "smtp_credential_proxy_mismatch",
          reason: `SMTP slot ${slotId} proxy port mismatch`,
        };
      }
    }
    return { ok: true, secret: entry.secret };
  }

  resolveConnectorSecretInMemory(slotId: string, expectedKind?: "imap" | "github_mcp" | "smtp"): string | undefined {
    const entry = this.#connectorSecrets.get(slotId);
    if (!entry) return undefined;
    if (expectedKind && entry.kind !== expectedKind) return undefined;
    return entry.secret;
  }

  registerSlot(binding: CredentialSlotBinding, secretValue: string, egressPolicy?: StageEgressPolicy): void {
    if (!binding.slotId || !binding.provider) {
      throw new Error("Credential slot requires slotId and provider");
    }
    if (!secretValue) {
      throw new Error(`Credential slot ${binding.slotId} requires non-empty secret`);
    }
    if (!Array.isArray(binding.allowedBaseUrls) || binding.allowedBaseUrls.length === 0) {
      throw new Error(`Credential slot ${binding.slotId} requires at least one allowed base URL`);
    }
    const normalizedUrls = binding.allowedBaseUrls.map((u) => assertModelUrlForStage(u, egressPolicy));
    this.#bindings.set(binding.slotId, {
      ...binding,
      allowedBaseUrls: normalizedUrls,
      allowedModelIds: [...binding.allowedModelIds],
    });
    this.#secrets.set(binding.slotId, secretValue);
  }

  getBinding(slotId: string): CredentialSlotBinding | undefined {
    return this.#bindings.get(slotId);
  }

  validateBinding(
    params: {
      slotId: string;
      provider: string;
      modelId: string;
      baseUrl: string;
    },
    egressPolicy?: StageEgressPolicy,
  ): { ok: true; binding: CredentialSlotBinding } | { ok: false; reason: string } {
    let normalizedUrl: string;
    try {
      normalizedUrl = assertModelUrlForStage(params.baseUrl, egressPolicy);
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    const binding = this.#bindings.get(params.slotId);
    if (!binding) {
      return { ok: false, reason: `Unknown credential slot: ${params.slotId}` };
    }
    if (binding.provider !== params.provider) {
      return {
        ok: false,
        reason: `Credential slot ${params.slotId} is bound to provider ${binding.provider}, not ${params.provider}`,
      };
    }
    const allowedNormalized = binding.allowedBaseUrls.map((u) => u.replace(/\/+$/, ""));
    if (!allowedNormalized.includes(normalizedUrl)) {
      return {
        ok: false,
        reason: `Base URL ${params.baseUrl} is not allowed for credential slot ${params.slotId}`,
      };
    }
    if (!binding.allowedModelIds.includes(params.modelId) && !binding.allowedModelIds.includes("*")) {
      return {
        ok: false,
        reason: `Model ${params.modelId} is not allowed for credential slot ${params.slotId}`,
      };
    }
    return { ok: true, binding };
  }

  /**
   * Resolves secret strictly in host memory. Never serialize return value into DB, logs, or checkpoints.
   */
  resolveSecretInMemory(slotId: string): string | undefined {
    return this.#secrets.get(slotId);
  }

  /** Returns all registered secret values strictly for test leak-scanning assertions. */
  registeredSecretMarkersForAudit(): string[] {
    return [...this.#secrets.values(), ...[...this.#connectorSecrets.values()].map((c) => c.secret)];
  }

  registeredSlotMarkersForAudit(): Array<{ slotId: string; kind: string; marker: string }> {
    const out: Array<{ slotId: string; kind: string; marker: string }> = [];
    for (const [slotId, marker] of this.#secrets.entries()) {
      out.push({ slotId, kind: "model", marker });
    }
    for (const [slotId, entry] of this.#connectorSecrets.entries()) {
      out.push({ slotId, kind: entry.kind, marker: entry.secret });
    }
    return out;
  }
}
