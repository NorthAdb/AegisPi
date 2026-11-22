// Audit probe: bisect the epoch-14 context drift by substituting delta files
// (singles then pairs) with their baseline blobs and hashing. A match against
// the recorded evidence identifies exactly which files changed after the build.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appImageContextFiles } from "../../../evals/phase3/lib/image-bind.mjs";

const REPO = "D:/AegisPi/aegis-pi";
const BASE = "86f5cd2";
const EVIDENCE = "sha256:4f5312e47507387e832b4692f72d0a7cca11ed20ea771391fa598d0baf4f766f";

function gitBlob(rev, relPath) {
  const r = spawnSync("git", ["show", `${rev}:${relPath}`], { cwd: REPO, maxBuffer: 1 << 26 });
  return r.status === 0 ? r.stdout : null;
}
function lf(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}
const files = appImageContextFiles("agent", REPO);
const repoRel = (f) => f.abs.slice(REPO.length + 1).split("\\").join("/");

const headBytes = new Map(files.map((f) => [repoRel(f), gitBlob("HEAD", repoRel(f))]));
const baseBytes = new Map(files.filter((f) => gitBlob(BASE, repoRel(f)) !== null).map((f) => [repoRel(f), gitBlob(BASE, repoRel(f))]));
const deltaNames = [...headBytes.keys()].filter((k) => {
  const b = baseBytes.get(k);
  const h = createHash("sha256").update(lf(headBytes.get(k))).digest("hex");
  return b === undefined || createHash("sha256").update(lf(b)).digest("hex") !== h;
});

function hashWith(subs) {
  const kept = files.filter((f) => {
    const k = repoRel(f);
    return !(subs.get(k) === "remove");
  });
  const record = kept.map((f) => {
    const k = repoRel(f);
    const bytes = subs.get(k) && subs.get(k) !== "remove" ? baseBytes.get(k) : headBytes.get(k);
    return { path: f.rel, sha256: createHash("sha256").update(lf(bytes)).digest("hex") };
  });
  return "sha256:" + createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

// mode per candidate: "sub" (baseline bytes) if it existed at baseline, else "remove"
const mode = (k) => (baseBytes.has(k) ? "sub" : "remove");

console.log(`delta candidates: ${deltaNames.length}`);
let found = 0;
for (const one of deltaNames) {
  const h = hashWith(new Map([[one, mode(one)]]));
  if (h === EVIDENCE) { console.log(`SINGLE MATCH (${mode(one)}): ${one}`); found++; }
}
for (let i = 0; i < deltaNames.length; i++) {
  for (let j = i + 1; j < deltaNames.length; j++) {
    const subs = new Map([[deltaNames[i], mode(deltaNames[i])], [deltaNames[j], mode(deltaNames[j])]]);
    const h = hashWith(subs);
    if (h === EVIDENCE) { console.log(`PAIR MATCH: ${deltaNames[i]}(${mode(deltaNames[i])}) + ${deltaNames[j]}(${mode(deltaNames[j])})`); found++; }
  }
}
console.log(found === 0 ? "no single/pair substitution matches the recorded epoch-14 context" : `${found} match(es) found`);

// triples, only if nothing matched yet
if (found === 0) {
  for (let i = 0; i < deltaNames.length && found === 0; i++) {
    for (let j = i + 1; j < deltaNames.length && found === 0; j++) {
      for (let k = j + 1; k < deltaNames.length; k++) {
        const subs = new Map([
          [deltaNames[i], mode(deltaNames[i])],
          [deltaNames[j], mode(deltaNames[j])],
          [deltaNames[k], mode(deltaNames[k])],
        ]);
        const h = hashWith(subs);
        if (h === EVIDENCE) {
          console.log(`TRIPLE MATCH: ${deltaNames[i]}(${mode(deltaNames[i])}) + ${deltaNames[j]}(${mode(deltaNames[j])}) + ${deltaNames[k]}(${mode(deltaNames[k])})`);
          found++;
          break;
        }
      }
    }
  }
  console.log(found === 0 ? "no triple matches either: build tree differs from HEAD in >=3 files, or held extra/absent files the commit cannot express" : `total ${found} match(es)`);
}
