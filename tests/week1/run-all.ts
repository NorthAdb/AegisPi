import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCKED_NODE_EXE } from "../fakes/client.ts";
import { runMatrix } from "./run-matrix.ts";
import { runW1A } from "./run-w1-a.ts";
import { runW1B } from "./run-w1-b.ts";

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

const args = parseArgs(process.argv.slice(2));
const runId = `week1_${randomUUID().slice(0, 8)}`;
const dataDir = path.resolve(args["data-dir"] ?? `.tmp-week1-all-${Date.now()}`);
const evidenceDir = path.resolve(args["evidence-dir"] ?? path.join(dataDir, "evidence"));
const keepData = args["keep-data"] === "true";

mkdirSync(dataDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });

// 1. Run TypeScript strict typecheck (tsc --noEmit)
const tscRun = spawnSync(LOCKED_NODE_EXE, [path.resolve("node_modules/typescript/bin/tsc"), "--noEmit"], {
  encoding: "utf8",
});
const tscOk = tscRun.status === 0;

// 2. Run S1-S5 SDK Contracts in fresh process
const s1s5Run = spawnSync(LOCKED_NODE_EXE, [path.resolve("tests/week1/run-sdk-contracts.ts")], {
  encoding: "utf8",
});
const s1s5Ok = s1s5Run.status === 0;
let s1s5Json: unknown = null;
try {
  const raw = s1s5Run.stdout.trim();
  s1s5Json = JSON.parse(raw);
} catch {
  s1s5Json = { rawStdout: s1s5Run.stdout, rawStderr: s1s5Run.stderr };
}
writeFileSync(path.join(evidenceDir, "s1-s5-evidence.json"), JSON.stringify(s1s5Json, null, 2) + "\n", "utf8");

// 3. Run W1-A (covers W1-A sign-off + B01)
const w1a = await runW1A({
  dataDir: path.join(dataDir, "w1-a"),
  evidenceDir,
});

// 4. Run W1-B (covers W1-B sign-off + E06 with real Windows Stop-Process -Force)
const w1b = await runW1B({
  dataDir: path.join(dataDir, "w1-b"),
  evidenceDir,
});

// 5. Run F01-F03, B02-B07, E01-E05, E07-E10, GUARD-BOUNDARY
const matrix = await runMatrix({
  dataDir: path.join(dataDir, "matrix"),
  evidenceDir,
});

const summary = {
  runId,
  executedAt: new Date().toISOString(),
  environment: {
    nodeExe: path.basename(LOCKED_NODE_EXE),
    nodeVersion: process.version,
    sqliteVersion: process.versions.sqlite,
    platform: process.platform,
    arch: process.arch,
  },
  dataDirLabel: path.basename(dataDir),
  evidenceDirRelative: path.relative(process.cwd(), evidenceDir).replace(/\\/g, "/"),
  results: {
    typecheck: { status: tscOk ? "PASS" : "FAIL", exitCode: tscRun.status },
    s1_s5: { status: s1s5Ok ? "PASS" : "FAIL", exitCode: s1s5Run.status },
    w1_a_and_b01: { status: w1a.report.status, cases: w1a.report.cases.length },
    w1_b_and_e06: {
      status: w1b.report.status,
      effectId: w1b.report.identifiers.effectId,
      smtpTotalReceived: w1b.report.finalFakeSmtp.totalReceived,
      finalEffectState: w1b.report.finalView1Evidence.effectState,
      view1Label: w1b.report.finalView1Evidence.uiStatusLabel,
    },
    matrix: {
      status: matrix.report.status,
      passed: matrix.report.passed,
      total: matrix.report.total,
      cases: matrix.report.results.map((r) => ({ id: r.id, status: r.status, summary: r.summary })),
    },
  },
};

const summaryPath = path.join(evidenceDir, "week1-summary.json");
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

if (!keepData && !evidenceDir.startsWith(dataDir)) {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // ignore transient Windows handle release
  }
}

console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));

const allPassed = tscOk && s1s5Ok && w1a.report.status === "PASS" && w1b.report.status === "PASS" && !matrix.failed;
if (!allPassed) {
  process.exit(1);
}
