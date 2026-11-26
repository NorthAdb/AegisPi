import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCKED_NODE_EXE } from "../fakes/client.ts";
import { runS6 } from "./run-s6.ts";
import { runV01V06Browser } from "./run-v01-v06-browser.ts";
import { runV02 } from "./run-v02.ts";
import { runV03 } from "./run-v03.ts";
import { runV04V05 } from "./run-v04-v05.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        out[k] = v;
        i++;
      } else {
        out[k] = "true";
      }
    }
  }
  return out;
}

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

const args = parseArgs(process.argv.slice(2));
const runId = `week2_${randomUUID().slice(0, 8)}`;
const dataDir = path.resolve(args["data-dir"] ?? `.tmp-week2-all-${Date.now()}`);
const evidenceDir = path.resolve(args["evidence-dir"] ?? path.join(dataDir, "evidence"));
const keepData = args["keep-data"] === "true";

mkdirSync(dataDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });

const headSha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const tscRun = spawnSync(LOCKED_NODE_EXE, [path.resolve("node_modules/typescript/bin/tsc"), "--noEmit"], {
  encoding: "utf8",
});
const tscOk = tscRun.status === 0;
const boundary = checkLayerBoundary();

const v04v05 = await runV04V05({ dataDir: path.join(dataDir, "v04-v05"), evidenceDir });
const v02 = await runV02({ dataDir: path.join(dataDir, "v02"), evidenceDir });
const v03 = await runV03({ dataDir: path.join(dataDir, "v03"), evidenceDir });
const s6 = await runS6({ dataDir: path.join(dataDir, "s6"), evidenceDir });
const browserSuite = await runV01V06Browser({ dataDir: path.join(dataDir, "v01-v06-browser"), evidenceDir });

const summary = {
  runId,
  commitSha: headSha,
  executedAt: new Date().toISOString(),
  environment: {
    nodeExe: path.basename(LOCKED_NODE_EXE),
    nodeVersion: process.version,
    sqliteVersion: process.versions.sqlite,
    platform: process.platform,
    arch: process.arch,
  },
  results: {
    typecheck: { status: tscOk ? "PASS" : "FAIL", exitCode: tscRun.status },
    layerBoundary: { status: boundary.ok ? "PASS" : "FAIL", violations: boundary.violations },
    s6: { status: s6.report.status, runId: s6.report.runId, totalForbiddenHits: s6.report.totalForbiddenHits },
    v04_v05: { status: v04v05.report.status, runId: v04v05.report.runId },
    v02: {
      status: v02.report.status,
      runId: v02.report.runId,
      environmentMode: v02.report.environmentMode,
      realConnectorsStatus: v02.report.realConnectorsStatus,
    },
    v03: { status: v03.report.status, runId: v03.report.runId },
    v01_v05_v06_browser: { status: browserSuite.report.status, runId: browserSuite.report.runId },
  },
};

const summaryPath = path.join(evidenceDir, "week2-summary.json");
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

if (!keepData && !evidenceDir.startsWith(dataDir)) {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));

const allPassed =
  tscOk &&
  boundary.ok &&
  s6.report.status === "PASS" &&
  v04v05.report.status === "PASS" &&
  v02.report.status === "PASS" &&
  v03.report.status === "PASS" &&
  browserSuite.report.status === "PASS";
if (!allPassed) {
  process.exit(1);
}
