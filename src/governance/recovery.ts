import { closeSync, existsSync, openSync, readSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { mintId } from "./canonical.ts";
import { withImmediateTx, writeAuditEvent } from "./db.ts";

export interface RuntimeEpochRow {
  runtime_epoch: string;
  trace_identity: string;
  status: "ACTIVE" | "RETIRED";
  created_at: number;
  retired_at: number | null;
  retire_reason: string | null;
}

export interface PairedManifestRow {
  singleton_id: number;
  runtime_epoch: string;
  trace_identity: string;
  anchor_conversation_id: string;
  last_trace_watermark: number;
  last_change_counter: number;
  known_pi_task_ids_json: string;
  updated_at: number;
}

/**
 * Reads SQLite header file-change-counter (bytes 24..27, big-endian uint32)
 * strictly read-only without opening a write connection on Pi's trace DB.
 */
export function readSqliteChangeCounterReadOnly(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(32);
    const bytesRead = readSync(fd, buf, 0, 32, 0);
    if (bytesRead < 28) return 0;
    return buf.readUInt32BE(24);
  } finally {
    closeSync(fd);
  }
}

export function getActiveEpoch(db: DatabaseSync): RuntimeEpochRow | null {
  const row = db
    .prepare("SELECT * FROM runtime_epochs WHERE status = 'ACTIVE' LIMIT 1")
    .get() as RuntimeEpochRow | undefined;
  return row ?? null;
}

export function getPairedManifest(db: DatabaseSync): PairedManifestRow | null {
  const row = db
    .prepare("SELECT * FROM paired_manifest WHERE singleton_id = 1")
    .get() as PairedManifestRow | undefined;
  return row ?? null;
}

export function ensureActiveEpochAndManifest(
  db: DatabaseSync,
  now: number,
): { epoch: RuntimeEpochRow; manifest: PairedManifestRow; newlyCreated: boolean } {
  return withImmediateTx(db, () => {
    const existingEpoch = getActiveEpoch(db);
    const existingManifest = getPairedManifest(db);
    if (existingEpoch && existingManifest) {
      return { epoch: existingEpoch, manifest: existingManifest, newlyCreated: false };
    }

    const runtimeEpoch = mintId("ep");
    const traceIdentity = mintId("tr");
    const anchorConversationId = `aegis-lineage:${traceIdentity}`;

    db.prepare(
      `INSERT INTO runtime_epochs(runtime_epoch, trace_identity, status, created_at)
       VALUES (?, ?, 'ACTIVE', ?)`,
    ).run(runtimeEpoch, traceIdentity, now);

    db.prepare(
      `INSERT INTO paired_manifest(
         singleton_id, runtime_epoch, trace_identity, anchor_conversation_id,
         last_trace_watermark, last_change_counter, known_pi_task_ids_json, updated_at
       ) VALUES (1, ?, ?, ?, 0, 0, '[]', ?)`,
    ).run(runtimeEpoch, traceIdentity, anchorConversationId, now);

    writeAuditEvent(db, {
      entityType: "runtime_epoch",
      entityId: runtimeEpoch,
      eventKey: `epoch_init:${runtimeEpoch}`,
      eventType: "runtime_epoch_initialized",
      occurredAt: now,
      details: { traceIdentity, anchorConversationId },
    });

    return {
      epoch: getActiveEpoch(db)!,
      manifest: getPairedManifest(db)!,
      newlyCreated: true,
    };
  });
}

export interface PairedTraceObservation {
  tracePath: string;
  anchorPresent: boolean;
  anchorTraceIdentityFound: string | null;
  currentWatermark: number;
  missingKnownTaskIds: number[];
  missingKnownConversationIds: number[];
}

export type PairedCheckResult =
  | { ok: true; observedChangeCounter: number }
  | { ok: false; code: string; message: string; details: Record<string, unknown> };

/**
 * Verifies that Pi's trace DB matches aegis-gov.sqlite's paired manifest.
 * Detects BOTH trace DB replacement (missing or mismatched lineage anchor)
 * AND trace DB rollback to an older snapshot of the same runtime_epoch
 * (regressed watermark, missing previously observed task/conversation, or regressed SQLite change counter).
 */
export function verifyPairedTraceManifest(
  db: DatabaseSync,
  obs: PairedTraceObservation,
): PairedCheckResult {
  const manifest = getPairedManifest(db);
  if (!manifest) {
    return {
      ok: false,
      code: "manifest_missing",
      message: "paired_manifest row missing in governance DB",
      details: {},
    };
  }

  const observedChangeCounter = readSqliteChangeCounterReadOnly(obs.tracePath);

  // Freshly initialized manifest (watermark=0 and never anchored yet) skips regression checks.
  const wasAnchored = manifest.last_trace_watermark > 0 || manifest.last_change_counter > 0;
  if (!wasAnchored) {
    return { ok: true, observedChangeCounter };
  }

  if (!obs.anchorPresent || obs.anchorTraceIdentityFound !== manifest.trace_identity) {
    return {
      ok: false,
      code: "trace_replaced_or_anchor_mismatch",
      message: `Trace DB lineage mismatch: expected trace_identity=${manifest.trace_identity}, observed=${String(obs.anchorTraceIdentityFound)}`,
      details: {
        expectedTraceIdentity: manifest.trace_identity,
        observedTraceIdentity: obs.anchorTraceIdentityFound,
        anchorPresent: obs.anchorPresent,
      },
    };
  }

  if (obs.missingKnownConversationIds.length > 0) {
    return {
      ok: false,
      code: "trace_rollback_missing_conversations",
      message: `Trace DB rolled back: previously committed conversations missing: ${obs.missingKnownConversationIds.join(",")}`,
      details: { missingKnownConversationIds: obs.missingKnownConversationIds },
    };
  }

  if (obs.missingKnownTaskIds.length > 0) {
    return {
      ok: false,
      code: "trace_rollback_missing_tasks",
      message: `Trace DB rolled back: previously committed tasks missing: ${obs.missingKnownTaskIds.join(",")}`,
      details: { missingKnownTaskIds: obs.missingKnownTaskIds },
    };
  }

  if (obs.currentWatermark < manifest.last_trace_watermark) {
    return {
      ok: false,
      code: "trace_rollback_watermark_regressed",
      message: `Trace watermark regressed from ${manifest.last_trace_watermark} to ${obs.currentWatermark}`,
      details: {
        expectedMinWatermark: manifest.last_trace_watermark,
        observedWatermark: obs.currentWatermark,
      },
    };
  }

  if (
    observedChangeCounter > 0 &&
    manifest.last_change_counter > 0 &&
    observedChangeCounter < manifest.last_change_counter
  ) {
    return {
      ok: false,
      code: "trace_rollback_change_counter_regressed",
      message: `Trace SQLite change counter regressed from ${manifest.last_change_counter} to ${observedChangeCounter}`,
      details: {
        expectedMinChangeCounter: manifest.last_change_counter,
        observedChangeCounter,
      },
    };
  }

  return { ok: true, observedChangeCounter };
}

/**
 * Monotonically advances the paired manifest watermark & known Pi task IDs.
 */
export function advancePairedManifest(
  db: DatabaseSync,
  params: {
    tracePath: string;
    watermark: number;
    knownTaskIds?: number[];
    now: number;
  },
): PairedManifestRow {
  const changeCounter = readSqliteChangeCounterReadOnly(params.tracePath);
  return withImmediateTx(db, () => {
    const manifest = getPairedManifest(db);
    if (!manifest) {
      throw new Error("paired_manifest not initialized");
    }
    const existingIds = new Set<number>(JSON.parse(manifest.known_pi_task_ids_json) as number[]);
    for (const id of params.knownTaskIds ?? []) {
      existingIds.add(id);
    }
    const nextWatermark = Math.max(manifest.last_trace_watermark, params.watermark);
    const nextChangeCounter = Math.max(manifest.last_change_counter, changeCounter);
    const mergedJson = JSON.stringify([...existingIds].sort((a, b) => a - b));

    db.prepare(
      `UPDATE paired_manifest
          SET last_trace_watermark = ?,
              last_change_counter = ?,
              known_pi_task_ids_json = ?,
              updated_at = ?
        WHERE singleton_id = 1`,
    ).run(nextWatermark, nextChangeCounter, mergedJson, params.now);

    return getPairedManifest(db)!;
  });
}

/**
 * Retires the active runtime epoch after trace DB replacement/rollback detection.
 * Isolates all unclaimed READY effects and PENDING outbox rows of the old epoch,
 * preserves all HELD/CHARGED_BOUND/SETTLED budget reservations and UNKNOWN effects
 * for audit, and rotates to a brand new ACTIVE runtime_epoch.
 */
export function isolateAndRotateEpoch(
  db: DatabaseSync,
  params: {
    reason: string;
    now: number;
  },
): {
  retiredEpoch: string;
  newEpoch: RuntimeEpochRow;
  newManifest: PairedManifestRow;
  quarantinedReadyEffectIds: string[];
  isolatedOutboxIds: string[];
  preservedHeldReservationIds: string[];
} {
  return withImmediateTx(db, () => {
    const oldEpoch = getActiveEpoch(db);
    if (!oldEpoch) {
      throw new Error("No active runtime_epoch to rotate");
    }

    const readyEffects = db
      .prepare(
        `SELECT e.effect_id FROM effects e
           JOIN approvals a ON a.approval_id = e.approval_id
           JOIN proposals p ON p.proposal_id = a.proposal_id
          WHERE p.runtime_epoch = ? AND e.state = 'READY'`,
      )
      .all(oldEpoch.runtime_epoch) as Array<{ effect_id: string }>;

    const quarantinedReadyEffectIds: string[] = [];
    for (const r of readyEffects) {
      const ch = db
        .prepare("UPDATE effects SET state = 'QUARANTINED', reason = ? WHERE effect_id = ? AND state = 'READY'")
        .run(`epoch_retired:${params.reason}`, r.effect_id);
      if (Number(ch.changes) === 1) {
        quarantinedReadyEffectIds.push(r.effect_id);
        writeAuditEvent(db, {
          entityType: "effect",
          entityId: r.effect_id,
          eventKey: `quarantine:epoch_retire:${oldEpoch.runtime_epoch}`,
          eventType: "effect_quarantined",
          occurredAt: params.now,
          details: { reason: params.reason, retiredEpoch: oldEpoch.runtime_epoch },
        });
      }
    }

    const pendingOutbox = db
      .prepare(
        `SELECT o.approval_id FROM signal_outbox o
           JOIN approvals a ON a.approval_id = o.approval_id
           JOIN proposals p ON p.proposal_id = a.proposal_id
          WHERE p.runtime_epoch = ? AND o.state = 'PENDING'`,
      )
      .all(oldEpoch.runtime_epoch) as Array<{ approval_id: string }>;

    const isolatedOutboxIds: string[] = [];
    for (const o of pendingOutbox) {
      const ch = db
        .prepare("UPDATE signal_outbox SET state = 'ISOLATED', reason = ?, updated_at = ? WHERE approval_id = ? AND state = 'PENDING'")
        .run(`epoch_retired:${params.reason}`, params.now, o.approval_id);
      if (Number(ch.changes) === 1) {
        isolatedOutboxIds.push(o.approval_id);
      }
    }

    // Mark any unconfirmed REGISTERED chat commands of the retired epoch as PENDING_RECONCILE
    db.prepare(
      `UPDATE chat_commands
          SET status = 'PENDING_RECONCILE', reason = ?, updated_at = ?
        WHERE runtime_epoch = ? AND status = 'REGISTERED'`,
    ).run(`epoch_retired:${params.reason}`, params.now, oldEpoch.runtime_epoch);

    // Preserve all HELD budget reservations untouched (audit + conservative bound path)
    const heldRows = db
      .prepare("SELECT request_id FROM budget_reservations WHERE runtime_epoch = ? AND state = 'HELD'")
      .all(oldEpoch.runtime_epoch) as Array<{ request_id: string }>;
    const preservedHeldReservationIds = heldRows.map((r) => r.request_id);

    db.prepare(
      "UPDATE runtime_epochs SET status = 'RETIRED', retired_at = ?, retire_reason = ? WHERE runtime_epoch = ? AND status = 'ACTIVE'",
    ).run(params.now, params.reason, oldEpoch.runtime_epoch);

    const newEpochId = mintId("ep");
    const newTraceIdentity = mintId("tr");
    const newAnchorId = `aegis-lineage:${newTraceIdentity}`;

    db.prepare(
      `INSERT INTO runtime_epochs(runtime_epoch, trace_identity, status, created_at)
       VALUES (?, ?, 'ACTIVE', ?)`,
    ).run(newEpochId, newTraceIdentity, params.now);

    db.prepare(
      `UPDATE paired_manifest
          SET runtime_epoch = ?,
              trace_identity = ?,
              anchor_conversation_id = ?,
              last_trace_watermark = 0,
              last_change_counter = 0,
              known_pi_task_ids_json = '[]',
              updated_at = ?
        WHERE singleton_id = 1`,
    ).run(newEpochId, newTraceIdentity, newAnchorId, params.now);

    writeAuditEvent(db, {
      entityType: "runtime_epoch",
      entityId: newEpochId,
      eventKey: `epoch_rotate:${oldEpoch.runtime_epoch}->${newEpochId}`,
      eventType: "runtime_epoch_rotated",
      occurredAt: params.now,
      details: {
        retiredEpoch: oldEpoch.runtime_epoch,
        newEpoch: newEpochId,
        reason: params.reason,
        quarantinedReadyEffectIds,
        isolatedOutboxIds,
        preservedHeldReservationIds,
      },
    });

    return {
      retiredEpoch: oldEpoch.runtime_epoch,
      newEpoch: getActiveEpoch(db)!,
      newManifest: getPairedManifest(db)!,
      quarantinedReadyEffectIds,
      isolatedOutboxIds,
      preservedHeldReservationIds,
    };
  });
}
