// Host-side job oracle (02 section 5: "恶意代码可控制全部自身stdout和文件，
// 因此宿主只把它们当证据输入，不当授权或自动成功标记。... oracle由宿主保存
// 为只读版本对象。... passes 只由可信验证器根据绑定 manifest 的测试结果更新").
//
// Re-review P1: the executor used to record SUCCEEDED from the container's
// exit code 0 alone and never read the bound oracle. This module is the
// host's acceptance decision, in the pack's oracle shape
// (docs/reference/oracle.schema.json, v1):
//   - validateJobOracle runs at SUBMIT time: a job without a host-authored
//     acceptance definition is refused before anything runs, and a
//     definition with no machine-checkable assertion (neither
//     expectedExitCode nor requiredOutputHash on any assertion) cannot gate
//     success and is refused too.
//   - evaluateJobOracle runs at FINISH time over trusted facts and evidence:
//     the container exit code (reported by the daemon, not by the job) and
//     the collected stdout bytes. result.json fields are evidence INPUTS and
//     never decide the state.
// The oracle content is stored as a content-addressed object; the job row
// binds its id. A job can overwrite its own copy of anything - it cannot
// touch this definition.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class JobOracleError extends Error {}

const ASSERTION_KINDS = new Set([
  "baseline_passes",
  "target_affected",
  "target_unaffected",
  "exploit_success_exit0",
  "infra_failure",
  "coverage_required",
]);

const STRING = (v, what) => {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) {
    throw new JobOracleError(`${what} must be a non-empty string`);
  }
  return v;
};

// The pack's oracle schema v1 (oracle.schema.json), enforced at the boundary
// where a host author binds an acceptance definition to a job.
export function validateJobOracle(oracle) {
  if (typeof oracle !== "object" || oracle === null || Array.isArray(oracle)) {
    throw new JobOracleError("a job oracle must be a JSON object");
  }
  if (oracle.schemaVersion !== 1) {
    throw new JobOracleError(`unsupported oracle schemaVersion ${JSON.stringify(oracle.schemaVersion)} (the pack shape is v1)`);
  }
  STRING(oracle.oracleId, "oracle.oracleId");
  STRING(oracle.proposition, "oracle.proposition");
  if (!Array.isArray(oracle.assertions) || oracle.assertions.length === 0) {
    throw new JobOracleError("an oracle needs at least one assertion");
  }
  let checkable = 0;
  for (const a of oracle.assertions) {
    if (typeof a !== "object" || a === null || Array.isArray(a)) {
      throw new JobOracleError("each assertion must be an object");
    }
    STRING(a.id, "assertion.id");
    if (!ASSERTION_KINDS.has(a.kind)) {
      throw new JobOracleError(`assertion ${a.id} kind ${JSON.stringify(a.kind)} is not in the pack enum`);
    }
    STRING(a.description, `assertion ${a.id} description`);
    if (a.expectedExitCode !== null && a.expectedExitCode !== undefined) {
      if (!Number.isInteger(a.expectedExitCode) || a.expectedExitCode < 0 || a.expectedExitCode > 255) {
        throw new JobOracleError(`assertion ${a.id} expectedExitCode must be null or an integer in 0..255`);
      }
    }
    if (a.requiredOutputHash !== null && a.requiredOutputHash !== undefined) {
      if (typeof a.requiredOutputHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(a.requiredOutputHash)) {
        throw new JobOracleError(`assertion ${a.id} requiredOutputHash must be null or a sha256: digest`);
      }
    }
    if (
      (a.expectedExitCode !== null && a.expectedExitCode !== undefined) ||
      (a.requiredOutputHash !== null && a.requiredOutputHash !== undefined)
    ) {
      checkable += 1;
    }
  }
  if (checkable === 0) {
    throw new JobOracleError(
      "an acceptance definition without a checkable assertion (expectedExitCode or requiredOutputHash) cannot gate success; prose alone is not a verification",
    );
  }
  const rules = oracle.resultClassRules;
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
    throw new JobOracleError("oracle.resultClassRules must be an object");
  }
  for (const key of ["affected", "unaffected", "unknown", "infra_error"]) {
    STRING(rules[key], `resultClassRules.${key}`);
  }
  return { assertionCount: oracle.assertions.length, checkableCount: checkable };
}

// Read the bound oracle back from its content-addressed object. Returns
// null when the object is unreadable or malformed: the host then refuses
// success (fail closed) rather than guessing.
export function loadJobOracleContent(db, stateDir, oracleObjectId) {
  const row = db.prepare("SELECT storage_ref, content_hash FROM objects WHERE id=?").get(oracleObjectId);
  if (!row || !row.storage_ref) return null;
  const path = join(stateDir, ...row.storage_ref.split("/"));
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  try {
    validateJobOracle(parsed);
  } catch {
    return null;
  }
  return parsed;
}

// Compare trusted facts and collected evidence against the bound definition.
// checkedIds are the assertions that carry a machine-checkable expectation;
// failedIds the ones that do not hold. ok is true only when every checkable
// assertion holds (and at least one was checked - submit enforced that).
export function evaluateJobOracle(oracle, { containerExitCode, stdoutBytes }) {
  const failedIds = [];
  const checkedIds = [];
  for (const a of oracle.assertions) {
    const wantsExit = a.expectedExitCode !== null && a.expectedExitCode !== undefined;
    const wantsHash = a.requiredOutputHash !== null && a.requiredOutputHash !== undefined;
    if (!wantsExit && !wantsHash) continue;
    checkedIds.push(a.id);
    let holds = true;
    if (wantsExit && a.expectedExitCode !== containerExitCode) holds = false;
    if (wantsHash) {
      if (!stdoutBytes) {
        holds = false;
      } else {
        const actual = "sha256:" + createHash("sha256").update(stdoutBytes).digest("hex");
        if (actual !== a.requiredOutputHash) holds = false;
      }
    }
    if (!holds) failedIds.push(a.id);
  }
  return { ok: checkedIds.length > 0 && failedIds.length === 0, checkedIds, failedIds };
}
