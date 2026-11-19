// Probe: a tree whose build context DRIFTED after the recorded build must be
// refused (the recorded digests no longer name an image built from this
// source). The drift is a temporary byte append to a real context file,
// restored byte-exact in the finally block. Exit 0 when the gate refuses.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppImageDigests, DIGEST_REPORT_PATH } from "../../lib/image-gate.mjs";
import { repoRoot } from "../../lib/harness.mjs";

const contextFile = join(repoRoot, "docker", "execution", "src", "runner.mjs");
const original = readFileSync(contextFile, "utf8");
let refused = null;
try {
  writeFileSync(contextFile, original + "// probe drift\n", "utf8");
  try {
    await parseAppImageDigests(DIGEST_REPORT_PATH);
  } catch (e) {
    refused = e;
  }
} finally {
  writeFileSync(contextFile, original, "utf8");
}
const restored = readFileSync(contextFile, "utf8");
if (restored !== original) {
  console.error("probe-refuses-context-drift: context file was not restored byte-exact");
  process.exit(1);
}
if (!refused) {
  console.error("probe-refuses-context-drift: gate ACCEPTED evidence recorded before a context change");
  process.exit(1);
}
if (!/context .* changed/i.test(refused.message)) {
  console.error(`probe-refuses-context-drift: unexpected refusal reason: ${refused.message}`);
  process.exit(1);
}
console.log(`probe-refuses-context-drift: refused -> ${refused.message.slice(0, 120)}`);
process.exit(0);
