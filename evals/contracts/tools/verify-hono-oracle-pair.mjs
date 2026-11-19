// hono oracle pair self-check: proves the A1/A2 exit-code matrix holds when
// the checks load hono EXPLICITLY from each snapshot's install directory
// (argv + createRequire), regardless of where this tool or the check scripts
// live (audit round 2 N4: cwd-based or script-location-based resolution
// silently loads the repo's hono 4.13.19 and false-greens the target).
//
// Default mode: copy the committed snapshot fixture dirs
// (evals/contracts/fixtures/hono-triage/snapshots/hono-<ver>/) into a temp
// dir each and `npm ci` them (installs exactly the committed lock, incl. the
// recorded registry integrity), then run both checks per snapshot.
// Explicit mode: --baseline=<dir> --target=<dir> to reuse existing installs.
//
// Expected matrix — baseline 4.13.19: csrf exit 0, cors exit 0;
// target 4.12.24: csrf exit 1, cors exit 1. Any deviation exits 1.
//
// Run (locked Node): node evals/contracts/tools/verify-hono-oracle-pair.mjs
//   [--baseline=<dir>] [--target=<dir>]
// Linux/other hosts: set AEGISPI_NODE_BIN / AEGISPI_NPM_BIN to the
// v22.23.5 binaries (same convention as the probe suite).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const fixtures = join(repoRoot, "evals", "contracts", "fixtures", "hono-triage");
const LOCKED_NPM = process.env.AEGISPI_NPM_BIN ?? "D:\\AegisPi\\tools\\node-v22.23.5\\npm.cmd";
const LOCKED_NODE = process.env.AEGISPI_NODE_BIN ?? "D:\\AegisPi\\tools\\node-v22.23.5\\node.exe";

const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function npmCi(snapshotName) {
  const tmp = mkdtempSync(join(tmpdir(), "hono-pair-"));
  cpSync(join(fixtures, "snapshots", snapshotName), tmp, { recursive: true });
  // Windows: npm is npm.cmd, which cannot be spawned directly since Node's
  // CVE-2024-27980 hardening — route through the shell there. The temp path
  // contains no spaces, so plain argument joining is safe.
  const res = spawnSync(LOCKED_NPM, ["ci", "--no-fund", "--no-audit"], {
    cwd: tmp,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    console.error(`npm ci failed in ${tmp} (status=${res.status}):\n${res.stdout}\n${res.stderr}\n${res.error ?? ""}`);
    process.exit(2);
  }
  return tmp;
}

function runCheck(script, installDir) {
  // Script stays in the repo; cwd is the repo: any resolution that follows
  // cwd or script location would load the repo's hono 4.13.19. The check
  // must report honoFrom === the requested install dir.
  const res = spawnSync(LOCKED_NODE, [join(fixtures, "checks", script), installDir], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {}
  return { exit: res.status, honoFrom: parsed?.honoFrom ?? null, stdout: res.stdout.trim().slice(0, 200) };
}

const rows = [
  { role: "baseline", version: "4.13.19", snapshot: "hono-4.13.19", dir: arg("baseline"), expect: { csrf: 0, cors: 0 } },
  { role: "target", version: "4.12.24", snapshot: "hono-4.12.24", dir: arg("target"), expect: { csrf: 1, cors: 1 } },
];

let failures = 0;
const createdTemp = [];
try {
  for (const row of rows) {
    if (!row.dir) {
      row.dir = npmCi(row.snapshot);
      createdTemp.push(row.dir);
    }
    const expectedDir = resolve(row.dir);
    for (const kind of ["csrf", "cors"]) {
      const script = kind === "csrf" ? "csrf-textping-check.mjs" : "cors-credential-check.mjs";
      const r = runCheck(script, expectedDir);
      const resolutionOk = r.honoFrom === expectedDir;
      const exitOk = r.exit === row.expect[kind];
      const ok = exitOk && resolutionOk;
      if (!ok) failures++;
      console.log(
        `[${row.role} hono@${row.version}] ${kind} exit=${r.exit} (expected ${row.expect[kind]}) resolution=${resolutionOk ? "target-dir" : "MISRESOLVED"} ${ok ? "OK" : "FAIL"}`,
      );
      if (!ok) console.log(`   honoFrom=${r.honoFrom} expected=${expectedDir}\n   output: ${r.stdout}`);
    }
  }
} finally {
  for (const t of createdTemp) rmSync(t, { recursive: true, force: true });
}

// Recompute the committed lockfile hashes so a third party sees them match
// the manifest values byte-for-byte.
for (const row of rows) {
  const lock = readFileSync(join(fixtures, "snapshots", row.snapshot, "package-lock.json"));
  console.log(`${row.snapshot} lockfile sha256 ${createHash("sha256").update(lock).digest("hex")}`);
}

process.exit(failures > 0 ? 1 : 0);
