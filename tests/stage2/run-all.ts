import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCKED_NODE_EXE } from "../fakes/client.ts";
import { parseWeek2CliArgs, rmDirWithRetry } from "../week2/cli-helpers.ts";
import { runStage2BrowserE2E } from "./run-browser-e2e.ts";
import { runStage2P0Core } from "./run-p0-core.ts";

const EXPECTED_ROOT_LOCK_SHA256 = "795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291";

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectTsFiles(full, out);
    else if (ent.isFile() && ent.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function checkLayerBoundary(): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const srcRoot = path.resolve("src");
  for (const file of collectTsFiles(srcRoot)) {
    const rel = path.relative(srcRoot, file).replace(/\\/g, "/");
    const content = readFileSync(file, "utf8");
    const importsPi = /from\s+["']@earendil-works\/pi-/.test(content);
    if (importsPi && !rel.startsWith("runtime/")) {
      violations.push(`pi-sdk-outside-runtime:${rel}`);
    }
    if (rel.startsWith("governance/") && /from\s+["']\.\.\/(capabilities|runtime|web)\//.test(content)) {
      violations.push(`l1-upward-import:${rel}`);
    }
    if (rel.startsWith("capabilities/") && /from\s+["']\.\.\/(runtime|web)\//.test(content)) {
      violations.push(`l2-upward-import:${rel}`);
    }
    if (rel.startsWith("runtime/") && /from\s+["']\.\.\/web\//.test(content)) {
      violations.push(`l3-upward-import:${rel}`);
    }
    if (rel.startsWith("web/") && /from\s+["']\.\.\/capabilities\//.test(content)) {
      violations.push(`l4-bypass-runtime-import-capabilities:${rel}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

const cli = parseWeek2CliArgs(process.argv.slice(2));
const runId = `stage2_${randomUUID().slice(0, 8)}`;
const dataDir = path.resolve(cli.dataDir ?? `.tmp-stage2-all-${Date.now()}`);
const evidenceDir = path.resolve(cli.evidenceDir ?? path.join(dataDir, "evidence"));
const keepData = cli.keepData;
mkdirSync(dataDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });

const headSha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const rootLockSha256 = createHash("sha256").update(readFileSync(path.resolve("package-lock.json"))).digest("hex");
const webLockSha256 = createHash("sha256").update(readFileSync(path.resolve("web/package-lock.json"))).digest("hex");

const tscRoot = spawnSync(LOCKED_NODE_EXE, [path.resolve("node_modules/typescript/bin/tsc"), "--noEmit"], {
  encoding: "utf8",
});
const tscWeb = spawnSync(LOCKED_NODE_EXE, [path.resolve("web/node_modules/typescript/bin/tsc"), "-p", path.resolve("web/tsconfig.json"), "--noEmit"], {
  encoding: "utf8",
});
const boundary = checkLayerBoundary();

const results: Record<string, { status: "PASS" | "FAIL" | "NOT_RUN"; [k: string]: unknown }> = {
  rootLockIntegrity: {
    status: rootLockSha256 === EXPECTED_ROOT_LOCK_SHA256 ? "PASS" : "FAIL",
    actualSha256: rootLockSha256,
    expectedSha256: EXPECTED_ROOT_LOCK_SHA256,
    webLockSha256,
  },
  typecheckRoot: { status: tscRoot.status === 0 ? "PASS" : "FAIL", exitCode: tscRoot.status },
  typecheckWeb: { status: tscWeb.status === 0 ? "PASS" : "FAIL", exitCode: tscWeb.status },
  layerBoundary: { status: boundary.ok ? "PASS" : "FAIL", violations: boundary.violations },
  p0Core: { status: "NOT_RUN" },
  browserDesktopAndNarrow: { status: "NOT_RUN" },
};

try {
  try {
    const p0 = await runStage2P0Core({ dataDir: path.join(dataDir, "p0-core"), evidenceDir });
    results["p0Core"] = { status: p0.report["status"] as "PASS" | "FAIL", runId: p0.report["runId"], evidencePath: path.basename(p0.evidencePath) };
  } catch (err) {
    results["p0Core"] = { status: "FAIL", error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const br = await runStage2BrowserE2E({ dataDir: path.join(dataDir, "browser-e2e"), evidenceDir });
    results["browserDesktopAndNarrow"] = { status: br.report.status as "PASS" | "FAIL", runId: br.report.runId, evidencePath: path.basename(br.evidencePath) };
  } catch (err) {
    results["browserDesktopAndNarrow"] = { status: "FAIL", error: err instanceof Error ? err.message : String(err) };
  }
} finally {
  const allPassed = Object.values(results).every((r) => r.status === "PASS");
  const summary = {
    runId,
    commitSha: headSha,
    status: allPassed ? "PASS" : "FAIL",
    executedAt: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      sqliteVersion: process.versions.sqlite,
      platform: process.platform,
      arch: process.arch,
    },
    results,
  };
  const summaryPath = path.join(evidenceDir, "stage2-summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  if (!keepData && !evidenceDir.startsWith(dataDir)) {
    await rmDirWithRetry(dataDir);
  }
  console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
  if (!allPassed) {
    process.exit(1);
  }
}
