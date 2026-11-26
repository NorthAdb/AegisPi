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

export interface CredentialSlotBinding {
  slotId: string;
  provider: string;
  allowedBaseUrls: string[];
  allowedModelIds: string[];
  priceVersion: string;
}

export interface ModelPriceSchedule {
  priceVersion: string;
  /** Per-1M token rates (for reference; Stage 1 requires provable syntheticFixedUpperMu). */
  inputPerMTokMu: number;
  outputPerMTokMu: number;
  /** Provable integer microUSD per-request upper bound required for T6 reservation in Stage 1. */
  syntheticFixedUpperMu?: number | null;
  syntheticFixedActualMu?: number | null;
}

export class HostCredentialVault {
  readonly #secrets = new Map<string, string>();
  readonly #bindings = new Map<string, CredentialSlotBinding>();
  readonly #connectorSecrets = new Map<string, { kind: "imap" | "github_mcp" | "smtp"; target: string; secret: string }>();

  registerConnectorSlot(params: {
    slotId: string;
    kind: "imap" | "github_mcp" | "smtp";
    target: string;
    secretValue: string;
  }): void {
    if (!params.slotId || !params.secretValue) {
      throw new Error("Connector credential slot requires slotId and non-empty secretValue");
    }
    this.#connectorSecrets.set(params.slotId, {
      kind: params.kind,
      target: params.target,
      secret: params.secretValue,
    });
  }

  resolveConnectorSecretInMemory(slotId: string, expectedKind?: "imap" | "github_mcp" | "smtp"): string | undefined {
    const entry = this.#connectorSecrets.get(slotId);
    if (!entry) return undefined;
    if (expectedKind && entry.kind !== expectedKind) return undefined;
    return entry.secret;
  }

  registerSlot(binding: CredentialSlotBinding, secretValue: string): void {
    if (!binding.slotId || !binding.provider) {
      throw new Error("Credential slot requires slotId and provider");
    }
    if (!secretValue) {
      throw new Error(`Credential slot ${binding.slotId} requires non-empty secret`);
    }
    if (!Array.isArray(binding.allowedBaseUrls) || binding.allowedBaseUrls.length === 0) {
      throw new Error(`Credential slot ${binding.slotId} requires at least one loopback base URL`);
    }
    const normalizedUrls = binding.allowedBaseUrls.map((u) => assertStage1LoopbackModelUrl(u));
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

  validateBinding(params: {
    slotId: string;
    provider: string;
    modelId: string;
    baseUrl: string;
  }): { ok: true; binding: CredentialSlotBinding } | { ok: false; reason: string } {
    let normalizedUrl: string;
    try {
      normalizedUrl = assertStage1LoopbackModelUrl(params.baseUrl);
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
