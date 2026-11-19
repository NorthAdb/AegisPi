// Phase 2 test harness. Inherits the Phase 1 exit-code discipline:
// - Refuses to run on any Node other than the locked 22.23.5 (exit 2).
// - Any FAIL check fails the suite (exit 1). A suite where zero checks were
//   judged also fails (decision D-12/D-14: zero checks is not a pass).
// - Checks carry a falsifiable detail string; notes never upgrade a suite.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..", "..");

export const LOCKED_NODE = "v22.23.5";

export function lockedNodeGuard() {
  if (process.version !== LOCKED_NODE) {
    console.error(
      `Refusing to run: process.version=${process.version}, locked Node is ${LOCKED_NODE}`,
    );
    process.exit(2);
  }
}

export function makeSuite(id) {
  const results = [];
  let pass = 0;
  let fail = 0;
  const suite = {
    id,
    check(name, cond, detail) {
      const ok = cond === true;
      if (ok) pass += 1;
      else fail += 1;
      results.push({ name, status: ok ? "PASS" : "FAIL", detail: String(detail) });
      console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
      return ok;
    },
    note(name, detail) {
      results.push({ name, status: "NOTE", detail: String(detail) });
      console.log(`NOTE  ${name} — ${detail}`);
    },
    get counts() {
      return { pass, fail };
    },
    get results() {
      return results;
    },
  };
  return suite;
}

export function suiteExit(suite, { label }) {
  const { pass, fail } = suite.counts;
  const judged = pass + fail;
  console.log(`\n=== ${label}: ${pass} pass, ${fail} fail, ${judged} judged ===`);
  if (fail > 0) return 1;
  if (judged === 0) return 1; // NOTHING RAN is not a pass (D-14).
  return 0;
}

// Fresh scratch workspace per case under the gitignored workspace-state/.
export function makeWorkspace(tag) {
  const stateDir = join(repoRoot, "workspace-state", "phase2", tag);
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  return {
    tag,
    stateDir,
    dbPath: join(stateDir, "db", "aegis.db"),
    objectsDir: join(stateDir, "objects"),
    backupsDir: join(stateDir, "backups"),
    jobsDir: join(stateDir, "jobs"),
    scopesDir: join(stateDir, "scopes"),
    consoleDir: join(stateDir, "console"),
  };
}

export function writeReport({ suiteId, extra, suite, evidenceDir, label }) {
  const report = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    suite: suiteId,
    label,
    counts: suite.counts,
    results: suite.results,
    ...extra,
  };
  mkdirSync(evidenceDir, { recursive: true });
  const reportPath = join(evidenceDir, `${suiteId}-report.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  const lines = [
    `# ${label}`,
    ``,
    `生成：${report.generatedAt}；Node ${process.version}；suite \`${suiteId}\`。`,
    ``,
    `| 状态 | 检查 | 证据 |`,
    `| --- | --- | --- |`,
    ...suite.results.map((r) => `| ${r.status} | ${r.name} | ${r.detail} |`),
    ``,
    `合计：${suite.counts.pass} PASS / ${suite.counts.fail} FAIL。`,
    ``,
  ];
  if (extra && extra.dataSources) {
    lines.push(`数据源：${extra.dataSources}（fake 远端与录制数据，无真实外部连接）。`);
    lines.push("");
  }
  const logPath = join(evidenceDir, `${suiteId}-log.md`);
  writeFileSync(logPath, lines.join("\n"));
  return { reportPath, logPath };
}

// Spawn a child on the same (locked) Node binary that runs this suite.
export function spawnNode(scriptPath, args = [], { env = {}, cwd = repoRoot } = {}) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return {
    child,
    done: new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
    }),
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

export async function killHard(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("exit", resolve));
}
