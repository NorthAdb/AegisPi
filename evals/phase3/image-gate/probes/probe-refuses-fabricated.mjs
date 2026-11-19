// Probe: a well-formed but FABRICATED manifest digest (real config and
// context values kept) must be refused by registry resolution. Exit 0 when
// the gate refuses; exit 1 when a fabricated digest is accepted.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppImageDigests, DIGEST_REPORT_PATH } from "../../lib/image-gate.mjs";
import { repoRoot } from "../../lib/harness.mjs";

const scratchDir = join(repoRoot, "workspace-state", "phase3", "image-gate-probe-scratch");
mkdirSync(scratchDir, { recursive: true });
const scratch = join(scratchDir, "fabricated.md");
copyFileSync(DIGEST_REPORT_PATH, scratch);
let text = readFileSync(scratch, "utf8");
text = text.replace(
  /^execution: sha256:[0-9a-f]{64}$/m,
  "execution: sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
);
writeFileSync(scratch, text, "utf8");
try {
  await parseAppImageDigests(scratch);
  console.error("probe-refuses-fabricated: gate ACCEPTED a fabricated manifest digest");
  process.exit(1);
} catch (e) {
  if (!/resolve|manifest|registry/i.test(e.message)) {
    console.error(`probe-refuses-fabricated: unexpected refusal reason: ${e.message}`);
    process.exit(1);
  }
  console.log(`probe-refuses-fabricated: refused -> ${e.message.slice(0, 120)}`);
  process.exit(0);
} finally {
  rmSync(scratch, { force: true });
}
