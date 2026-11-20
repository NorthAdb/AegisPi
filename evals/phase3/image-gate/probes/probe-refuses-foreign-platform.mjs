// Probe: a manifest+config pair that resolves correctly, cross-checks
// correctly, and carries the REAL recorded context — but whose config blob
// declares a FOREIGN PLATFORM (linux/arm64) — must be refused by the gate's
// platform binding. Exit 0 when the gate refuses.
//
// The synthetic pair is pushed to the local build registry over its HTTP API
// (content-addressed, idempotent): an arm64 config blob, then a manifest
// embedding it. Nothing real is overwritten — the digests are new content
// addresses under the aegispi/execution repository name.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppImageDigests, DIGEST_REPORT_PATH } from "../../lib/image-gate.mjs";
import { repoRoot } from "../../lib/harness.mjs";

const REGISTRY = "127.0.0.1:5000";
const REPO = "aegispi/execution";

const configJson = Buffer.from(
  JSON.stringify({
    architecture: "arm64",
    os: "linux",
    config: {},
    rootfs: { type: "layers", diff_ids: [] },
  }),
  "utf8",
);
const configSha = "sha256:" + createHash("sha256").update(configJson).digest("hex");

async function pushBlob(bytes, digest) {
  const post = await fetch(`http://${REGISTRY}/v2/${REPO}/blobs/uploads/`, { method: "POST" });
  if (post.status !== 202) throw new Error(`blob upload initiation failed: HTTP ${post.status}`);
  const location = post.headers.get("location");
  if (!location) throw new Error("registry gave no upload location");
  const sep = location.includes("?") ? "&" : "?";
  const put = await fetch(location.startsWith("http") ? `${location}${sep}digest=${digest}` : `http://${REGISTRY}${location}${sep}digest=${digest}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (put.status !== 201) throw new Error(`blob upload failed: HTTP ${put.status}`);
}

await pushBlob(configJson, configSha);

const manifestJson = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    config: {
      mediaType: "application/vnd.docker.container.image.v1+json",
      size: configJson.length,
      digest: configSha,
    },
    layers: [],
  }),
  "utf8",
);
const manifestSha = "sha256:" + createHash("sha256").update(manifestJson).digest("hex");
{
  const put = await fetch(`http://${REGISTRY}/v2/${REPO}/manifests/${manifestSha}`, {
    method: "PUT",
    headers: { "content-type": "application/vnd.docker.distribution.manifest.v2+json" },
    body: manifestJson,
  });
  if (put.status !== 201) throw new Error(`manifest push failed: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
}

// Scratch evidence: everything real EXCEPT the execution manifest/config,
// which point at the synthetic foreign-platform pair. The context row stays
// the real one so only the platform binding can catch the substitution.
const scratchDir = join(repoRoot, "workspace-state", "phase3", "image-gate-probe-scratch");
mkdirSync(scratchDir, { recursive: true });
const scratch = join(scratchDir, "foreign-platform.md");
copyFileSync(DIGEST_REPORT_PATH, scratch);
const text = readFileSync(scratch, "utf8");
const planted = text
  .replace(/^execution: sha256:[0-9a-f]{64}$/m, `execution: ${manifestSha}`)
  .replace(/^execution\.config: sha256:[0-9a-f]{64}$/m, `execution.config: ${configSha}`);
if (planted === text) {
  console.error("probe-refuses-foreign-platform: could not plant the synthetic pair into the scratch evidence");
  process.exit(1);
}
writeFileSync(scratch, planted, "utf8");
try {
  await parseAppImageDigests(scratch);
  console.error("probe-refuses-foreign-platform: gate ACCEPTED a linux/arm64 config blob as an isolation reference");
  process.exit(1);
} catch (e) {
  if (!/amd64|foreign-platform/.test(e.message)) {
    console.error(`probe-refuses-foreign-platform: unexpected refusal reason: ${e.message.slice(0, 160)}`);
    process.exit(1);
  }
  console.log(`probe-refuses-foreign-platform: refused -> ${e.message.slice(0, 120)}`);
  process.exit(0);
} finally {
  rmSync(scratch, { force: true });
}
