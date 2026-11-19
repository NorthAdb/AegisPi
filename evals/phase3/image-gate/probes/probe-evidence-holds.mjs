// Baseline probe: the committed v2 evidence must fully bind (format +
// context + registry + config) on the clean gate.
import { parseAppImageDigests, DIGEST_REPORT_PATH, APP_IMAGES } from "../../lib/image-gate.mjs";

let out;
try {
  out = await parseAppImageDigests(DIGEST_REPORT_PATH);
} catch (e) {
  console.error(`probe-evidence-holds: gate refused the real evidence: ${e.message}`);
  process.exit(1);
}
for (const name of APP_IMAGES) {
  if (!out.digests[name] || !out.configs[name] || !out.contexts[name]) {
    console.error(`probe-evidence-holds: incomplete binding for ${name}`);
    process.exit(1);
  }
}
console.log("probe-evidence-holds: manifest+config+context all bound");
process.exit(0);
