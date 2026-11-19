// Transaction helper. 06 pins the write pattern as BEGIN IMMEDIATE inside
// one connection with a single writer; network calls never happen inside
// these transactions. ROLLBACK on any throw, always.

export function withTx(db, fn, { immediate = true } = {}) {
  db.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
  let result;
  try {
    result = fn();
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Connection already failed the transaction; surface the original error.
    }
    throw e;
  }
  db.exec("COMMIT");
  return result;
}

export class TxAborted extends Error {}
