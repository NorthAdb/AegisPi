import { createHash, randomBytes } from "node:crypto";

export interface SlotMarkerSpec {
  slotId: string;
  marker: string;
}

export interface BufferSecretScanResult {
  scannedBytes: number;
  forbiddenHitsBySlot: Record<string, number>;
  totalForbiddenHits: number;
}

export interface SaltedMarkerCommitment {
  slotId: string;
  charLength: number;
  sha256Hex: string;
}

export interface SaltedMarkerCommitmentsFile {
  saltHex: string;
  commitments: SaltedMarkerCommitment[];
}

/**
 * W2-S6: Pure in-memory buffer substring scan across all registered secret slots.
 * Never persists raw buffer bytes or raw secret markers to disk.
 */
export function scanBufferInMemory(
  buf: Buffer | string,
  markers: SlotMarkerSpec[],
  opts?: { excludeSlots?: string[] },
): BufferSecretScanResult {
  const bytes = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  const excluded = new Set(opts?.excludeSlots ?? []);
  const forbiddenHitsBySlot: Record<string, number> = {};
  let totalForbiddenHits = 0;

  for (const { slotId, marker } of markers) {
    if (excluded.has(slotId) || !marker) continue;
    const needle = Buffer.from(marker, "utf8");
    let count = 0;
    let idx = 0;
    while (idx <= bytes.length - needle.length) {
      const found = bytes.indexOf(needle, idx);
      if (found === -1) break;
      count++;
      idx = found + Math.max(1, needle.length);
    }
    forbiddenHitsBySlot[slotId] = (forbiddenHitsBySlot[slotId] ?? 0) + count;
    totalForbiddenHits += count;
  }

  return {
    scannedBytes: bytes.length,
    forbiddenHitsBySlot,
    totalForbiddenHits,
  };
}

/**
 * W2-S6: Produces cryptographic per-run salted SHA-256 commitments for secret markers so an
 * external child process (e.g. MCP subprocess) can substring-scan its live `process.env`
 * in memory WITHOUT ever receiving other slots' raw secret strings or writing raw env values to disk.
 */
export function createSaltedMarkerCommitments(markers: SlotMarkerSpec[]): SaltedMarkerCommitmentsFile {
  const saltHex = randomBytes(16).toString("hex");
  const seen = new Set<string>();
  const commitments: SaltedMarkerCommitment[] = [];
  for (const { slotId, marker } of markers) {
    if (!marker) continue;
    const dedupKey = `${slotId}\0${marker}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const sha256Hex = createHash("sha256").update(saltHex).update(":").update(marker, "utf8").digest("hex");
    commitments.push({
      slotId,
      charLength: marker.length,
      sha256Hex,
    });
  }
  return { saltHex, commitments };
}

/**
 * W2-S6: Substring-scans actual `[key, value]` env entries strictly in child RAM against
 * salted marker commitments, enforcing allowed `(slotId -> envKeys)` placement rules:
 * - An allowed placement matches ONLY when BOTH `envKey` is allowlisted for `slotId` AND
 *   the entire env value equals the single committed marker (`v.length === len`, zero extra wrapping).
 * - Any substring match in a non-allowed env key, or wrapped inside a larger string, is recorded as a hit.
 */
export function scanEntriesAgainstCommitmentsInMemory(
  entries: Array<[string, string]>,
  commitmentsFile: SaltedMarkerCommitmentsFile,
  opts?: { allowSlotInKeys?: Record<string, string[]> },
): {
  envEntriesCount: number;
  scannedBytes: number;
  forbiddenHitsBySlot: Record<string, number>;
  totalForbiddenHits: number;
} {
  const forbiddenHitsBySlot: Record<string, number> = {};
  const byLength = new Map<number, Map<string, string[]>>();

  for (const c of commitmentsFile.commitments) {
    if (!(c.slotId in forbiddenHitsBySlot)) {
      forbiddenHitsBySlot[c.slotId] = 0;
    }
    if (c.charLength <= 0) continue;
    let digestMap = byLength.get(c.charLength);
    if (!digestMap) {
      digestMap = new Map<string, string[]>();
      byLength.set(c.charLength, digestMap);
    }
    const existingSlots = digestMap.get(c.sha256Hex) ?? [];
    existingSlots.push(c.slotId);
    digestMap.set(c.sha256Hex, existingSlots);
  }

  let scannedBytes = 0;
  let totalForbiddenHits = 0;

  for (const [key, value] of entries) {
    scannedBytes += Buffer.byteLength(`${key}=${value}\n`, "utf8");
    for (const [len, digestMap] of byLength.entries()) {
      if (value.length < len) continue;
      for (let i = 0; i <= value.length - len; i++) {
        const window = value.slice(i, i + len);
        const h = createHash("sha256")
          .update(commitmentsFile.saltHex)
          .update(":")
          .update(window, "utf8")
          .digest("hex");
        const matchedSlots = digestMap.get(h);
        if (!matchedSlots) continue;
        for (const slotId of matchedSlots) {
          const allowedKeys = opts?.allowSlotInKeys?.[slotId];
          const isAllowedExact = Boolean(allowedKeys && allowedKeys.includes(key) && value.length === len);
          if (!isAllowedExact) {
            forbiddenHitsBySlot[slotId] = (forbiddenHitsBySlot[slotId] ?? 0) + 1;
            totalForbiddenHits++;
          }
        }
      }
    }
  }

  return {
    envEntriesCount: entries.length,
    scannedBytes,
    forbiddenHitsBySlot,
    totalForbiddenHits,
  };
}
