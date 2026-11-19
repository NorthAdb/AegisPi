// Probe: a manifest field that resolves correctly but whose recorded
// CONFIG digest does not match the manifest's embedded config must be
// refused by the config cross-check (manifest and config are different
// namespaces; recording a real manifest digest next to a fabricated config
// value must not pass). Exit 0 when the gate refuses.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppImageDigests, DIGEST_REPORT_PATH } from "../../lib/image-gate.mjs";
import { repoRoot } from "../../lib/harness.mjs";

const scratchDir = join(repoRoot, "workspace-state", "phase3", "image-gate-probe-scratch");
mkdirSync(scratchDir, { recursive: true });
const scratch = join(scratchDir, "config-mismatch.md");
copyFileSync(DIGEST_REPORT_PATH, scratch);
const text = readFileSync(scratch, "utf8");
const agentConfig = (text.match(/^agent\.config: (sha256:[0-9a-f]{64})$/m) ?? [])[1];
if (!agentConfig) {
  console.error("probe-refuses-config-as-manifest: no recorded agent config digest to plant as the execution config");
  process.exit(1);
}
// The execution MANIFEST stays real (it resolves and hashes correctly); the
// recorded CONFIG is a different image's real config value: only the
// manifest-embedded config cross-check can catch this substitution.
const planted = text.replace(/^execution\.config: sha256:[0-9a-f]{64}$/m, `execution.config: ${agentConfig}`);
writeFileSync(scratch, planted, "utf8");
try {
  await parseAppImageDigests(scratch);
  console.error("probe-refuses-config-as-manifest: gate ACCEPTED a config digest that contradicts the manifest");
  process.exit(1);
} catch (e) {
  if (!/config/.test(e.message)) {
    console.error(`probe-refuses-config-as-manifest: unexpected refusal reason: ${e.message}`);
    process.exit(1);
  }
  console.log(`probe-refuses-config-as-manifest: refused -> ${e.message.slice(0, 120)}`);
  process.exit(0);
} finally {
  rmSync(scratch, { force: true });
}
