// Audit probe: characterize the epoch-14 agent context drift at HEAD (1d019fc).
// Computes the gate's context record three ways:
//   A  HEAD blob bytes for every context file
//   A2 working-tree disk bytes (walkFiles also sees untracked files)
//   B  baseline 86f5cd2 blob bytes
//   C  HEAD record with selected single files substituted by 86f5cd2 blobs
// Prints composite hashes and per-file sha deltas. Audit-only; reads, never writes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { appImageContextFiles } from "../../../evals/phase3/lib/image-bind.mjs";

const REPO = "D:/AegisPi/aegis-pi";
const BASE = "86f5cd2";
const EVIDENCE = "sha256:4f5312e47507387e832b4692f72d0a7cca11ed20ea771391fa598d0baf4f766f";

function gitBlob(rev, relPath) {
  const r = spawnSync("git", ["show", `${rev}:${relPath.split("\\").join("/")}`], { cwd: REPO, maxBuffer: 1 << 26 });
  return r.status === 0 ? r.stdout : null;
}

function lf(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

function hashRecord(files, bytesFor) {
  const record = files.map((f) => ({ path: f.rel, sha256: createHash("sha256").update(lf(bytesFor(f))).digest("hex") }));
  return "sha256:" + createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

const files = appImageContextFiles("agent", REPO);
const repoRel = (f) => f.abs.slice(REPO.length + 1).split("\\").join("/");

const headHash = hashRecord(files, (f) => gitBlob("HEAD", repoRel(f)));
const diskHash = hashRecord(files, (f) => readFileSync(f.abs));
const baselineFiles = files.filter((f) => gitBlob(BASE, repoRel(f)) !== null);
const newAtHead = files.filter((f) => gitBlob(BASE, repoRel(f)) === null).map(repoRel);
const baseHash = hashRecord(baselineFiles, (f) => gitBlob(BASE, repoRel(f)));

for (const target of ["package.json", "apps/daemon/config/defaults.json"]) {
  const sub = hashRecord(files, (f) => (repoRel(f) === target ? gitBlob(BASE, target) : gitBlob("HEAD", repoRel(f))));
  const tag = sub === EVIDENCE ? "  <== MATCHES EPOCH-14 EVIDENCE" : "";
  console.log(`C ${target}@base substituted: ${sub}${tag}`);
}

const short = (b) => (b === null ? "ABSENT" : createHash("sha256").update(lf(b)).digest("hex").slice(0, 12));
const deltas = [];
for (const f of files) {
  const hHead = short(gitBlob("HEAD", repoRel(f)));
  const hDisk = short(readFileSync(f.abs));
  const hBase = short(gitBlob(BASE, repoRel(f)));
  if (hHead !== hBase || hHead !== hDisk) deltas.push(`${repoRel(f)}: head=${hHead} disk=${hDisk} base=${hBase}`);
}

console.log(`A  HEAD-blob record: ${headHash}`);
console.log(`A2 disk record     : ${diskHash}`);
console.log(`B  baseline record : ${baseHash}`);
console.log(`Evidence agent.context: ${EVIDENCE}`);
console.log(`files new at HEAD (absent at baseline): ${newAtHead.join(", ")}`);
console.log(`per-file deltas (${deltas.length}):`);
for (const d of deltas) console.log(`  ${d}`);
