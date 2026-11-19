// Credential lifecycle (02 section 4: "长期密钥只由宿主凭据服务读取，不写入
// 模型、容器、审计、构建层或备份明文"; PRE-READ Phase 3: "密钥安全录入及撤
// 销流程").
//
// The database stores ONLY slot references and lifecycle metadata: which
// secret slot exists, for which purpose/source, since when, rotated when,
// revoked when. Secret VALUES never enter the DB, logs, or audit rows — they
// live in the host's secret store (a local .env / secret file owned by the
// operator user, never committed, never mounted into any container).
//
// Adapters resolve values through resolve(slot) at submit time. A REVOKED
// slot resolves to null and the adapter must fail closed.

import { existsSync, readFileSync } from "node:fs";
import { withTx } from "./db/tx.mjs";
import { writeAudit } from "./audit.mjs";

export class CredentialError extends Error {}

export function createCredentialService(db, { now = () => Date.now(), envFile = null } = {}) {
  function ensureTable() {
    // The credential slot registry rides on system_state-shaped storage but
    // keeps its own table-free discipline: slots are small, auditable rows.
    db.prepare(
      `CREATE TABLE IF NOT EXISTS credential_slots(
         slot TEXT PRIMARY KEY,
         purpose TEXT NOT NULL,
         source TEXT,
         env_name TEXT NOT NULL,
         registered_at INTEGER NOT NULL,
         rotated_at INTEGER,
         revoked_at INTEGER
       )`,
    ).run();
  }
  ensureTable();

  function registerSlot({ slot, purpose, source = null, envName, actorId = null, now: at = now() }) {
    if (!/^[a-z0-9_.-]{1,64}$/.test(slot)) {
      throw new CredentialError(`slot ${slot} must be a short lowercase identifier`);
    }
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(envName)) {
      throw new CredentialError(`env name ${envName} must be an uppercase identifier`);
    }
    return withTx(db, () => {
      db.prepare(
        `INSERT INTO credential_slots(slot, purpose, source, env_name, registered_at, rotated_at, revoked_at)
         VALUES (?,?,?,?,?,NULL,NULL)
         ON CONFLICT(slot) DO UPDATE SET purpose=excluded.purpose, source=excluded.source,
           env_name=excluded.env_name, rotated_at=excluded.registered_at, revoked_at=NULL`,
      ).run(slot, purpose, source, envName, at);
      writeAudit(db, {
        code: "credential_slot_registered",
        actorId,
        details: { slot, purpose, source, env_name: envName },
        now: at,
      });
      return { slot, envName };
    });
  }

  function rotateSlot({ slot, envName, actorId = null, now: at = now() }) {
    return withTx(db, () => {
      const changed = db
        .prepare(
          "UPDATE credential_slots SET env_name=?, rotated_at=?, revoked_at=NULL WHERE slot=?",
        )
        .run(envName, at, slot).changes;
      if (changed !== 1) {
        throw new CredentialError(`slot ${slot} is not registered`);
      }
      writeAudit(db, {
        code: "credential_slot_rotated",
        actorId,
        details: { slot, env_name: envName, note: "the old value is dead the moment the new env name is read; rotate the value in the host store first" },
        now: at,
      });
      return { slot, envName, rotatedAt: at };
    });
  }

  function revokeSlot({ slot, actorId = null, reason = "", now: at = now() }) {
    return withTx(db, () => {
      const changed = db
        .prepare("UPDATE credential_slots SET revoked_at=? WHERE slot=? AND revoked_at IS NULL")
        .run(at, slot).changes;
      if (changed !== 1) {
        throw new CredentialError(`slot ${slot} is not live`);
      }
      writeAudit(db, {
        code: "credential_slot_revoked",
        actorId,
        details: { slot, reason },
        now: at,
      });
      return { slot, revokedAt: at };
    });
  }

  function slotRow(slot) {
    return db.prepare("SELECT * FROM credential_slots WHERE slot=?").get(slot);
  }

  function readEnvStore() {
    // Values come from the host environment (the operator's .env), read at
    // CALL time and never persisted here.
    const out = { ...process.env };
    if (envFile && existsSync(envFile)) {
      for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m) out[m[1]] = m[2];
      }
    }
    return out;
  }

  function resolve(slot) {
    const row = slotRow(slot);
    if (!row) return { ok: false, reason: `slot ${slot} is not registered` };
    if (row.revoked_at !== null) {
      return { ok: false, reason: `slot ${slot} was revoked at ${row.revoked_at}; adapters must fail closed` };
    }
    const value = readEnvStore()[row.env_name];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, reason: `slot ${slot} env ${row.env_name} is not set in the host secret store` };
    }
    return { ok: true, value, purpose: row.purpose, source: row.source };
  }

  // The adapter-facing view: never exposes values, only liveness.
  function describe() {
    return db.prepare("SELECT slot, purpose, source, env_name, registered_at, rotated_at, revoked_at FROM credential_slots ORDER BY slot").all();
  }

  return { registerSlot, rotateSlot, revokeSlot, resolve, describe, slotRow };
}
