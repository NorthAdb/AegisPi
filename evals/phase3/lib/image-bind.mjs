// Image binding: the shared source of truth for WHAT a build context is,
// its deterministic hash, and how to resolve an image manifest digest at
// the local build registry. Used by BOTH tools/build-app-images.mjs (which
// records the evidence) and evals/phase3/lib/image-gate.mjs (which refuses
// to let an isolation suite run on evidence that does not bind).
//
// Why this module exists (audit F1): a bare "sha256:" string proves nothing.
// The gate must prove three bindings before a container suite may run:
//   1. CONTEXT: the recorded digest was built from THIS tree. A context
//      hash is computed from the same file list the build stages, so a
//      changed tree makes the recorded evidence stale and the gate red.
//      The hash is byte-based (no mtimes), so it is engine-independent.
//   2. REGISTRY: the digest actually resolves at the registry the suites
//      pull from, and hashing the returned manifest bytes proves the value
//      is a MANIFEST digest, not a config/image id.
//   3. CONFIG: the manifest's embedded config digest matches the recorded
//      one, so manifest/config confusion cannot slip through.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export class ImageBindError extends Error {}

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export function isSha256(v) {
  return typeof v === "string" && SHA256_RE.test(v);
}

function walkFiles(dir, base = dir) {
  const out = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    throw new ImageBindError(`cannot read context directory ${dir}`);
  }
  for (const name of names.sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkFiles(p, base));
    } else if (st.isFile()) {
      out.push({ rel: relative(base, p).split("\\").join("/"), abs: p });
    }
  }
  return out;
}

// The exact file list tools/build-app-images.mjs stages for each image.
// Order is irrelevant to the hash (files are sorted by staged path), but
// the SET must stay in sync with stage() in the build tool.
export function appImageContextFiles(name, repoRoot) {
  const files = [];
  const push = (abs, stagedRel) => files.push({ abs: join(repoRoot, abs), rel: stagedRel });
  if (name === "agent") {
    push("docker/agent/Dockerfile", "Dockerfile");
    push("package.json", "package.json");
    push("package-lock.json", "package-lock.json");
    push("apps/daemon/package.json", "apps/daemon/package.json");
    for (const f of walkFiles(join(repoRoot, "apps", "daemon", "config"))) {
      push(join("apps/daemon/config", f.rel), join("apps/daemon/config", f.rel));
    }
    for (const f of walkFiles(join(repoRoot, "apps", "daemon", "src"))) {
      push(join("apps/daemon/src", f.rel), join("apps/daemon/src", f.rel));
    }
    push("docker/agent/src/worker.mjs", "apps/containers/agent/worker.mjs");
  } else if (name === "acquisition" || name === "execution") {
    push(join("docker", name, "Dockerfile"), "Dockerfile");
    for (const f of walkFiles(join(repoRoot, "docker", name, "src"))) {
      push(join("docker", name, "src", f.rel), join("src", f.rel));
    }
  } else {
    throw new ImageBindError(`unknown application image ${name}`);
  }
  for (const f of files) {
    try {
      statSync(f.abs);
    } catch {
      throw new ImageBindError(`context file missing for ${name}: ${f.abs}`);
    }
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// Deterministic content hash over the staged context (file list + bytes).
export function appImageContextHash(name, repoRoot) {
  const files = appImageContextFiles(name, repoRoot);
  const record = files.map((f) => ({ path: f.rel, sha256: createHash("sha256").update(readFileSync(f.abs)).digest("hex") }));
  return "sha256:" + createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

// Resolve a manifest digest at the registry and return the parsed manifest
// plus the SHA-256 of the exact bytes served. Accepts both OCI and docker
// v2 manifest media types (registry:2 serves whichever the push produced).
// A manifest LIST/index at the digest is a named refusal: a pinned run
// reference must be the platform manifest itself (BuildKit pushes an index
// when provenance attestations are on; build-app-images disables them so
// the recorded "manifest digest" names the platform manifest, never an
// index and never a config).
export async function fetchRegistryManifest(appName, digest, { registry = "127.0.0.1:5000" } = {}) {
  if (!isSha256(digest)) {
    throw new ImageBindError(`digest for ${appName} is not a sha256 content digest: ${digest}`);
  }
  const url = `http://${registry}/v2/aegispi/${appName}/manifests/${digest}`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, " +
          "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
      },
    });
  } catch (e) {
    throw new ImageBindError(`registry ${registry} is not reachable (${e.message}); a digest that cannot resolve where the suites run it is not an isolation reference`);
  }
  if (res.status !== 200) {
    throw new ImageBindError(
      `registry did not resolve ${appName}@${digest} as a manifest (HTTP ${res.status}); the value may be a config digest, a fabricated string, or the image was never pushed here`,
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const servedSha = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  if (servedSha !== digest) {
    throw new ImageBindError(`registry served ${servedSha} for ${appName}@${digest}; the address does not name these bytes`);
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ImageBindError(`the bytes at ${appName}@${digest} are not a JSON manifest`);
  }
  if (Array.isArray(manifest.manifests)) {
    throw new ImageBindError(
      `${appName}@${digest} is a manifest LIST/index, not the platform manifest; the pinned reference must name the image manifest itself — rebuild with tools/build-app-images.mjs (it builds with --provenance=false --sbom=false)`,
    );
  }
  if (!manifest.config?.digest || !isSha256(manifest.config.digest)) {
    throw new ImageBindError(`the manifest for ${appName}@${digest} carries no valid config digest`);
  }
  return { manifest, configDigest: manifest.config.digest, bytesSha: servedSha };
}
