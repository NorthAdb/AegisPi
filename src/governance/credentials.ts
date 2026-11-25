export interface CredentialSlotBinding {
  slotId: string;
  provider: string;
  allowedBaseUrls: string[];
  allowedModelIds: string[];
  priceVersion: string;
}

export interface ModelPriceSchedule {
  priceVersion: string;
  /** Fixed conservative upper bound microUSD per request if token estimate matches, or per-1M token rates. */
  inputPerMTokMu: number;
  outputPerMTokMu: number;
  /** Optional synthetic fixed upper bound / per-request ceiling override for deterministic tests. */
  syntheticFixedUpperMu?: number | null;
  syntheticFixedActualMu?: number | null;
}

export class HostCredentialVault {
  readonly #secrets = new Map<string, string>();
  readonly #bindings = new Map<string, CredentialSlotBinding>();

  registerSlot(binding: CredentialSlotBinding, secretValue: string): void {
    if (!binding.slotId || !binding.provider) {
      throw new Error("Credential slot requires slotId and provider");
    }
    if (!secretValue) {
      throw new Error(`Credential slot ${binding.slotId} requires non-empty secret`);
    }
    this.#bindings.set(binding.slotId, {
      ...binding,
      allowedBaseUrls: [...binding.allowedBaseUrls],
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
    const normalizedUrl = params.baseUrl.replace(/\/+$/, "");
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
    return [...this.#secrets.values()];
  }
}
