import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCKED_NODE_EXE } from "../fakes/client.ts";
import { parseWeek2CliArgs, rmDirWithRetry } from "./cli-helpers.ts";
import { runS6 } from "./run-s6.ts";
import { runV01V06Browser } from "./run-v01-v06-browser.ts";
import { runV02 } from "./run-v02.ts";
import { runV03 } from "./run-v03.ts";
import { runV04V05 } from "./run-v04-v05.ts";

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
  }
  return { ok: violations.length === 0, violations };
}

const cli = parseWeek2CliArgs(process.argv.slice(2));
const runId = `week2_${randomUUID().slice(0, 8)}`;
const dataDir = path.resolve(cli.dataDir ?? `.tmp-week2-all-${Date.now()}`);
const evidenceDir = path.resolve(cli.evidenceDir ?? path.join(dataDir, "evidence"));
const keepData = cli.keepData;

mkdirSync(dataDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });

const headSha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const tscRun = spawnSync(LOCKED_NODE_EXE, [path.resolve("node_modules/typescript/bin/tsc"), "--noEmit"], {
  encoding: "utf8",
});
const tscOk = tscRun.status === 0;
const boundary = checkLayerBoundary();

type SuiteResultEntry = {
  status: "PASS" | "FAIL" | "NOT_RUN";
  runId?: string;
  error?: string;
  [k: string]: unknown;
};

const results: Record<string, SuiteResultEntry> = {
  typecheck: { status: tscOk ? "PASS" : "FAIL", exitCode: tscRun.status },
  layerBoundary: { status: boundary.ok ? "PASS" : "FAIL", violations: boundary.violations },
  v04_v05: { status: "NOT_RUN" },
  v02: { status: "NOT_RUN" },
  v03: { status: "NOT_RUN" },
  s6: { status: "NOT_RUN" },
  v01_v05_v06_browser: { status: "NOT_RUN" },
};

async function execSuite(name: string, fn: () => Promise<SuiteResultEntry>): Promise<void> {
  try {
    results[name] = await fn();
  } catch (err) {
    results[name] = {
      status: "FAIL",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

try {
  await execSuite("v04_v05", async () => {
    const r = await runV04V05({ dataDir: path.join(dataDir, "v04-v05"), evidenceDir });
    return { status: r.report.status as "PASS" | "FAIL", runId: r.report.runId };
  });
  await execSuite("v02", async () => {
    const r = await runV02({ dataDir: path.join(dataDir, "v02"), evidenceDir });
    return {
      status: r.report.status as "PASS" | "FAIL",
      runId: r.report.runId,
      environmentMode: r.report.environmentMode,
      realConnectorsStatus: r.report.realConnectorsStatus,
    };
  });
  await execSuite("v03", async () => {
    const r = await runV03({ dataDir: path.join(dataDir, "v03"), evidenceDir });
    return { status: r.report.status as "PASS" | "FAIL", runId: r.report.runId };
  });
  await execSuite("s6", async () => {
    const r = await runS6({ dataDir: path.join(dataDir, "s6"), evidenceDir });
    return {
      status: r.report.status as "PASS" | "FAIL",
      runId: r.report.runId,
      totalForbiddenHits: r.report.totalForbiddenHits,
    };
  });
  await execSuite("v01_v05_v06_browser", async () => {
    const r = await runV01V06Browser({ dataDir: path.join(dataDir, "v01-v06-browser"), evidenceDir });
    return { status: r.report.status as "PASS" | "FAIL", runId: r.report.runId };
  });
} finally {
  const allPassed = Object.values(results).every((r) => r.status === "PASS");
  const summary = {
    runId,
    commitSha: headSha,
    status: allPassed ? "PASS" : "FAIL",
    executedAt: new Date().toISOString(),
    environment: {
      nodeExe: path.basename(LOCKED_NODE_EXE),
      nodeVersion: process.version,
      sqliteVersion: process.versions.sqlite,
      platform: process.platform,
      arch: process.arch,
    },
    results,
  };
  const summaryPath = path.join(evidenceDir, "week2-summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

  if (!keepData && !evidenceDir.startsWith(dataDir)) {
    await rmDirWithRetry(dataDir);
  }

  console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
  if (!allPassed) {
    process.exit(1);
  }
}
