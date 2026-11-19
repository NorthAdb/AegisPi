// Fake upstream for Phase 2 (04 Phase 2: "先用fake远端验证四种retry_mode").
// State persists to a JSON file under the workspace so it survives process
// kills — crash-window children and their recoveries see the same applied
// actions. Modes simulate the outcomes that matter to the protocol:
// ok, apply_then_die (remote applied, connection died -> UNKNOWN locally),
// local_error (zero request bytes left the host), reject, timeout.
// lookup() can be strongly consistent or eventual, to prove that a weak
// not-found never triggers a resend.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function createFakeRemote(stateDir, { label = "fake-remote" } = {}) {
  const statePath = join(stateDir, "fake-remote.json");
  let state = { applied: {}, deliveryCounts: {}, submitLog: [] };
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  }
  function persist() {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  persist();
  return {
    label,
    submit({ businessKey, idempotencyKey, operation, now, mode = "ok" }) {
      state.submitLog.push({ businessKey, idempotencyKey, mode, at: now });
      if (mode === "local_error") {
        persist();
        return { status: "failed_local", error: "connect failed before any request byte was sent" };
      }
      if (mode === "reject") {
        persist();
        return { status: "failed_remote", error: "upstream rejected the operation (policy)" };
      }
      if (mode === "timeout") {
        persist();
        return { status: "unknown", error: "no response within deadline; request bytes may have been sent" };
      }
      // ok and apply_then_die both APPLY the action at the remote first.
      // Record under the idempotency key when the caller sent one, else under
      // a business-key slot so LOOKUP_THEN_RETRY can still find it. Without
      // an idempotency key there is nothing to dedup by: every submit is a
      // fresh delivery — exactly why AT_LEAST_ONCE declares duplicates.
      const appliedKey = idempotencyKey ?? `biz:${businessKey}`;
      const already = idempotencyKey ? state.applied[appliedKey] : undefined;
      let externalId;
      if (already) {
        externalId = already.externalId;
      } else {
        externalId = `ext-${String(Object.keys(state.applied).length + 1).padStart(4, "0")}`;
        state.applied[appliedKey] = { externalId, businessKey, at: now };
        state.deliveryCounts[businessKey] = (state.deliveryCounts[businessKey] ?? 0) + 1;
      }
      persist();
      if (mode === "apply_then_die") {
        return { status: "unknown", error: "remote applied the action, then the connection died before the response" };
      }
      return { status: "succeeded", externalId, duplicate: Boolean(already) };
    },
    lookup({ businessKey, consistency = "strong" }) {
      const hit = Object.entries(state.applied).find(([, v]) => v.businessKey === businessKey);
      if (consistency !== "strong") {
        return { found: false, strong: false };
      }
      if (!hit) {
        return { found: false, strong: true };
      }
      return { found: true, externalId: hit[1].externalId, strong: true };
    },
    // Head state for dispatcher precondition tests (06 section 6: the CAS
    // transaction re-checks the target resource precondition). Tests mutate
    // this to simulate HEAD drift between approval and dispatch.
    setHead(targetResource, head) {
      state.heads = state.heads ?? {};
      state.heads[targetResource] = head;
      persist();
    },
    lookupHead({ targetResource }) {
      state.heads = state.heads ?? {};
      const head = state.heads[targetResource];
      if (head === undefined) {
        return { ok: false, reason: `no head recorded for ${targetResource}` };
      }
      return { ok: true, head };
    },
    appliedCount(businessKey) {
      return state.deliveryCounts[businessKey] ?? 0;
    },
    appliedByIdempotencyKey(idempotencyKey) {
      return state.applied[idempotencyKey] ?? null;
    },
    get statePath() {
      return statePath;
    },
  };
}
