// The Phase 3 isolation-test entry gate (handoff section 2.1: "没有这三份
// 真实 digest 之前，不得开始隔离测试，更不得宣布常开。禁止编造 digest，
// 禁止把 tag 或 PIN_REQUIRED 当成不可变摘要").
// Suites import this and call requireAppImageDigests() FIRST: if any of the
// three application images lacks a real sha256 digest (or the evidence holds
// a placeholder), the suite refuses to run (exit 2) — a missing gate is not
// a green suite.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DIGEST_REPORT_PATH = join(here, "..", "..", "..", "docs", "phase3", "reports", "image-digest.md");

export const APP_IMAGES = ["agent", "acquisition", "execution"];

export class ImageGateError extends Error {}

export function parseAppImageDigests(reportPath = DIGEST_REPORT_PATH) {
  if (!existsSync(reportPath)) {
    throw new ImageGateError(`no image digest evidence at ${reportPath}; the three application images have not been recorded as built`);
  }
  const text = readFileSync(reportPath, "utf8");
  const blockMatch = text.match(/<!--\s*app-image-digests v1([\s\S]*?)-->/);
  if (!blockMatch) {
    throw new ImageGateError("the digest evidence has no machine-readable app-image-digests block");
  }
  const found = {};
  for (const line of blockMatch[1].split("\n")) {
    const m = line.trim().match(/^([a-z]+):\s*(sha256:[0-9a-f]{64})$/);
    if (m) {
      found[m[1]] = m[2];
    }
    // Placeholders in VALUE positions are a hard refusal; prose that
    // explains the rule is not a placeholder.
    if (/PIN_REQUIRED/i.test(line)) {
      throw new ImageGateError(`the digest block carries a PIN_REQUIRED placeholder for a line: ${line.trim()}`);
    }
  }
  const missing = [];
  for (const name of APP_IMAGES) {
    if (!found[name]) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new ImageGateError(
      `missing real digests for: ${missing.join(", ")} — a tag, an absent digest or a placeholder is not an immutable reference`,
    );
  }
  return { digests: found, reportPath };
}

// Refuse-and-exit form for suite entry points.
export function requireAppImageDigests() {
  try {
    return parseAppImageDigests();
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
  return `127.0.0.1:5000/aegispi/${name}@${digest}`;
}
