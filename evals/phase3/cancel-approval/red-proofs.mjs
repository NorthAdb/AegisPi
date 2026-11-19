// Mutation red proofs for the Phase 3 approval gates (the repo's standing
// discipline: every new gate must be proven RED-able, not vacuously green).
// For each gate: apply a targeted source mutation that disables it, run the
// probe (must FAIL, i.e. exit nonzero), restore the source byte-exact, run
// the probe again (must PASS). Any step out of order fails this script.
//
//   node evals/phase3/cancel-approval/red-proofs.mjs
//
// Mutations:
//   M1 revise-without-invalidation : effects.mjs skips invalidateApproval
//   M2 head-precondition-off       : adapters.mjs never compares heads
//   M3 console-session-guard-off   : console/api.mjs lets bootstrap tokens
//                                    reach mutation routes

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lockedNodeGuard, repoRoot } from "../lib/harness.mjs";

lockedNodeGuard();

const here = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;

const MUTATIONS = [
  {
    id: "M1-revise-without-invalidation",
    file: join(repoRoot, "apps", "daemon", "src", "effects.mjs"),
    from: 'const invalidation = invalidateApproval(db, { approvalId, reason: "revised by editor", now });',
    to: 'const invalidation = { invalidated: true, state: "WAITING" };',
    probe: join(here, "probes", "probe-revise.mjs"),
  },
  {
    id: "M2-head-precondition-off",
    file: join(repoRoot, "apps", "daemon", "src", "adapters.mjs"),
    from: "if (head.head !== action.expected_head) {",
    to: "if (false) { // MUTATED",
    probe: join(here, "probes", "probe-head.mjs"),
  },
  {
    id: "M3-console-session-guard-off",
    file: join(repoRoot, "apps", "daemon", "src", "console", "api.mjs"),
    from: 'if (c.get("authKind") !== "session") {',
    to: 'if (false) { // MUTATED',
    probe: join(here, "probes", "probe-console-guard.mjs"),
  },
];

function runProbe(path) {
  const r = spawnSync(node, [path], { cwd: repoRoot, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

let failures = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.error(`RED-PROOF SETUP FAIL: anchor not found for ${m.id} in ${m.file}`);
    failures += 1;
    continue;
  }
  // Clean-tree probe must hold.
  const clean = runProbe(m.probe);
  if (clean.code !== 0) {
    console.error(`RED-PROOF FAIL: probe does not hold on the clean tree (${m.id}): ${clean.out.slice(-400)}`);
    failures += 1;
    continue;
  }
  // Mutated-tree probe must go red.
  writeFileSync(m.file, original.replace(m.from, m.to), "utf8");
  let mutated;
  try {
    mutated = runProbe(m.probe);
  } finally {
    writeFileSync(m.file, original, "utf8");
  }
  const restored = readFileSync(m.file, "utf8");
  if (restored !== original) {
    console.error(`RED-PROOF FAIL: source restoration mismatch for ${m.id}`);
    failures += 1;
    continue;
  }
  if (mutated.code === 0) {
    console.error(`RED-PROOF FAIL: mutation ${m.id} did NOT turn the probe red (still exit 0)`);
    failures += 1;
    continue;
  }
  console.log(`RED-PROOF PASS: ${m.id} — clean probe exit 0; mutated probe exit ${mutated.code}; source restored byte-exact`);
}

if (failures > 0) {
  console.error(`red-proofs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("red-proofs: all mutation gates proven red-able");
process.exit(0);
