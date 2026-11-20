// The Phase 3 isolation-test entry gate (handoff section 2.1: "没有这三份
// 真实 digest 之前，不得开始隔离测试，更不得宣布常开。禁止编造 digest，
// 禁止把 tag 或 PIN_REQUIRED 当成不可变摘要").
// Audit F1 hardened this from a FORMAT check into a BINDING check: suites
// import requireAppImageDigests() FIRST and it now refuses unless the
// evidence binds all three of source tree, registry manifest, and config:
//   1. format      every value is a real sha256 content digest
//   2. context     the recorded context hash equals the hash of THIS tree
//                  (a changed tree makes the digests stale: rebuild and
//                  commit fresh evidence before running any suite). The
//                  hash normalizes staged paths to "/" and file bytes to
//                  LF, so it is a function of committed content and
//                  recomputes identically on Linux and on a Windows
//                  autocrlf checkout (re-review F1).
//   3. registry    the digest resolves at the local build registry AND the
//                  served bytes hash to that digest (proves it is an OCI
//                  manifest digest, never a config/image id)
//   4. config      the manifest's embedded config digest matches the
//                  recorded one, and the config blob behind it declares
//                  linux/amd64 — a foreign-platform config is refused
// A missing or placeholder binding is a refusal (exit 2). A gate refusal
// is not a green suite.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ImageBindError,
  appImageContextHash,
  fetchRegistryConfigBlob,
  fetchRegistryManifest,
  isSha256,
} from "./image-bind.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const DIGEST_REPORT_PATH = join(here, "..", "..", "..", "docs", "phase3", "reports", "image-digest.md");
export const BUILD_REGISTRY = "127.0.0.1:5000";

export const APP_IMAGES = ["agent", "acquisition", "execution"];

export class ImageGateError extends Error {}

export async function parseAppImageDigests(
  reportPath = DIGEST_REPORT_PATH,
  { repoRoot = join(here, "..", "..", ".."), registry = BUILD_REGISTRY } = {},
) {
  if (!existsSync(reportPath)) {
    throw new ImageGateError(`no image digest evidence at ${reportPath}; the three application images have not been recorded as built`);
  }
  const text = readFileSync(reportPath, "utf8");
  if (/<!--\s*app-image-digests v1/.test(text) && !/<!--\s*app-image-digests v2/.test(text)) {
    throw new ImageGateError(
      "the digest evidence is a v1 block: it records digest strings without binding them to the source tree that built them; rebuild with tools/build-app-images.mjs so the v2 block (manifest + config + context) replaces it",
    );
  }
  const blockMatch = text.match(/<!--\s*app-image-digests v2([\s\S]*?)-->/);
  if (!blockMatch) {
    throw new ImageGateError("the digest evidence has no machine-readable app-image-digests v2 block");
  }
  const fields = {};
  for (const line of blockMatch[1].split("\n")) {
    const m = line.trim().match(/^([a-z]+(?:\.(?:manifest|config|context))?):\s*(sha256:[0-9a-f]{64})$/);
    if (m) {
      fields[m[1]] = m[2];
    }
    // Placeholders in VALUE positions are a hard refusal; prose that
    // explains the rule is not a placeholder.
    if (/PIN_REQUIRED/i.test(line)) {
      throw new ImageGateError(`the digest block carries a PIN_REQUIRED placeholder for a line: ${line.trim()}`);
    }
  }
  const digests = {};
  const configs = {};
  const contexts = {};
  const missing = [];
  for (const name of APP_IMAGES) {
    if (fields[name] && fields[`${name}.config`] && fields[`${name}.context`]) {
      digests[name] = fields[name];
      configs[name] = fields[`${name}.config`];
      contexts[name] = fields[`${name}.context`];
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new ImageGateError(
      `the v2 digest block is incomplete for: ${missing.join(", ")} — each image needs <name>, <name>.config and <name>.context`,
    );
  }
  // Context binding: the recorded digests must have been built from THIS
  // tree. A drift means the evidence is stale, not that the tree is wrong.
  for (const name of APP_IMAGES) {
    const treeHash = appImageContextHash(name, repoRoot);
    if (treeHash !== contexts[name]) {
      throw new ImageGateError(
        `the build context for ${name} changed after the recorded build (evidence ${contexts[name]}, this tree ${treeHash}); the recorded digests no longer name an image built from this source — run tools/build-app-images.mjs and commit the refreshed evidence before any isolation suite`,
      );
    }
  }
  // Registry + config binding.
  for (const name of APP_IMAGES) {
    let resolved;
    try {
      resolved = await fetchRegistryManifest(name, digests[name], { registry });
    } catch (e) {
      if (e instanceof ImageBindError) {
        throw new ImageGateError(`${name}: ${e.message}`);
      }
      throw e;
    }
    if (resolved.configDigest !== configs[name]) {
      throw new ImageGateError(
        `the manifest for ${name} embeds config ${resolved.configDigest} but the evidence records ${configs[name]}; manifest and config digests are not interchangeable`,
      );
    }
    // Platform binding (re-review F1): the config blob behind the manifest
    // must declare linux/amd64. A digest that resolves to a foreign-platform
    // config is not a runnable isolation reference on this host — being
    // amd64 by build luck is not the same as the gate enforcing it.
    const cfg = await fetchRegistryConfigBlob(name, resolved.configDigest, { registry });
    if (cfg.os !== "linux" || cfg.architecture !== "amd64") {
      throw new ImageGateError(
        `${name}: the image config declares os=${cfg.os ?? "?"}/${cfg.architecture ?? "?"}; isolation suites run linux/amd64 only, a foreign-platform config blob is refused`,
      );
    }
  }
  return { digests, configs, contexts, reportPath, registry };
}

// Refuse-and-exit form for suite entry points.
export async function requireAppImageDigests(reportPath = DIGEST_REPORT_PATH, opts = {}) {
  try {
    return await parseAppImageDigests(reportPath, opts);
  } catch (e) {
    console.error(`image-gate REFUSED: ${e.message}`);
    process.exit(2);
  }
}

// The docker reference a suite must run on: the local build registry pinned
// by content digest, never a floating tag.
export function imageRef(name, digests) {
  const digest = digests[name];
  if (!digest) {
    throw new ImageGateError(`no digest recorded for ${name}`);
  }
  return `${BUILD_REGISTRY}/aegispi/${name}@${digest}`;
}
