// Mutation red proofs for the hardened image gate (audit F1). Repo
// discipline: every gate must be proven RED-able, not vacuously green.
// For each mutation: run the probe on the clean gate (must pass), apply a
// targeted mutation that DISABLES one binding, run the probe again (must go
// red), restore the gate byte-exact, re-run (must pass).
//
//   node evals/phase3/image-gate/red-proofs.mjs
//
// Requires the v2 evidence to exist (run tools/build-app-images.mjs first).
//
// Mutations:
//   M1 registry-resolution-off   : the gate stops resolving manifests at the
//                                  registry; a fabricated digest would pass
//   M2 context-binding-off       : the gate stops comparing the tree to the
//                                  recorded context hash
//   M3 config-crosscheck-off    : the gate stops cross-checking the
//                                  manifest's embedded config digest

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lockedNodeGuard, repoRoot } from "../lib/harness.mjs";

lockedNodeGuard();

const here = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const GATE = join(repoRoot, "evals", "phase3", "lib", "image-gate.mjs");

const MUTATIONS = [
  {
    id: "M1-registry-resolution-off",
    file: GATE,
    from: "    let resolved;\n    try {\n      resolved = await fetchRegistryManifest(name, digests[name], { registry });",
    to: "    let resolved;\n    try {\n      resolved = { manifest: null, configDigest: configs[name], bytesSha: digests[name] }; // MUTATED",
    probe: join(here, "probes", "probe-refuses-fabricated.mjs"),
  },
  {
    id: "M2-context-binding-off",
    file: GATE,
    from: "    if (treeHash !== contexts[name]) {",
    to: "    if (false) { // MUTATED",
    probe: join(here, "probes", "probe-refuses-context-drift.mjs"),
  },
  {
    id: "M3-config-crosscheck-off",
    file: GATE,
    from: "    if (resolved.configDigest !== configs[name]) {",
    to: "    if (false) { // MUTATED",
    probe: join(here, "probes", "probe-refuses-config-as-manifest.mjs"),
  },
];

function runProbe(path) {
  const r = spawnSync(node, [path], { cwd: repoRoot, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

// The probes refuse fabricated evidence by writing a scratch report; they
// never touch the committed evidence file.
const scratchDir = join(repoRoot, "workspace-state", "phase3", "image-gate-probe-scratch");
mkdirSync(scratchDir, { recursive: true });

let failures = 0;
// Baseline: the real evidence must hold on the clean gate.
const clean = runProbe(join(here, "probes", "probe-evidence-holds.mjs"));
if (clean.code !== 0) {
  console.error(`RED-PROOF FAIL: the real evidence does not pass the clean gate: ${clean.out.slice(-400)}`);
  failures += 1;
}
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.error(`RED-PROOF SETUP FAIL: anchor not found for ${m.id} in ${m.file}`);
    failures += 1;
    continue;
  }
  // Clean-tree probe must hold.
  const cleanProbe = runProbe(m.probe);
  if (cleanProbe.code !== 0) {
    console.error(`RED-PROOF FAIL: probe does not hold on the clean gate (${m.id}): ${cleanProbe.out.slice(-400)}`);
    failures += 1;
    continue;
  }
  // Mutated gate must go red.
  writeFileSync(m.file, original.replace(m.from, m.to), "utf8");
  let mutated;
  try {
    mutated = runProbe(m.probe);
  } finally {
    writeFileSync(m.file, original, "utf8");
  }
  const restored = readFileSync(m.file, "utf8");
  if (restored !== original) {
    console.error(`RED-PROOF FAIL: gate restoration mismatch for ${m.id}`);
    failures += 1;
    continue;
  }
  if (mutated.code === 0) {
    console.error(`RED-PROOF FAIL: ${m.id} mutation did NOT turn the probe red (probe still passed)`);
    failures += 1;
    continue;
  }
  const again = runProbe(m.probe);
  if (again.code !== 0) {
    console.error(`RED-PROOF FAIL: probe did not recover after restoring the gate (${m.id}): ${again.out.slice(-300)}`);
    failures += 1;
    continue;
  }
  console.log(`RED-PROOF OK: ${m.id} -> probe red under mutation, green after restore`);
}
rmSync(scratchDir, { recursive: true, force: true });
process.exit(failures > 0 ? 1 : 0);
