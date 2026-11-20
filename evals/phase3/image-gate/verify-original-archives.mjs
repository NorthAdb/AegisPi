// verify-original-archives.mjs — local, read-only identity verification of
// the three original OCI archives (re-review 33d6361 follow-up; owner
// authorization 2026-11-20: the original-image item is closed by LOCAL
// verification, not by shipping to a third party).
//
// What it does (and never does):
//   - hashes each tar (SHA-256 + byte count) and compares against the
//     documented delivery values (image-transfer-manifest.md §1, identical
//     to image-delivery.md §1);
//   - extracts each tar into a temp dir (originals never modified/deleted/
//     uploaded) and verifies the OCI layout end to end: index.json's
//     manifests[0].digest, the docker-compat manifest.json (RepoTags +
//     Config), the manifest blob's own content hash, the config blob's
//     content hash + os/arch declaration, and EVERY layer digest referenced
//     by the manifest (content-addressed check of all blobs);
//   - prints the manifest digest and the config/image ID side by side,
//     explicitly distinguished — they are different identifiers and must
//     never be conflated;
//   - removes only the temp extraction dirs it created.
//
// Exit 0: every check holds on all three archives. Exit 1: any mismatch,
// recorded honestly.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const NODE = process.version;
if (NODE !== "v22.23.5") {
  console.error(`Refusing to run: process.version=${NODE}, locked Node is v22.23.5`);
  process.exit(2);
}

const ARCHIVE_DIR = "D:\\AegisPi\\phase3-image-archives";
const EXTRACT_ROOT = join("C:\\Users\\1\\AppData\\Local\\Temp\\opencode", "aegispi-imgverify");

// Expected values: image-transfer-manifest.md §1 (byte-identical to the
// committed delivery table). manifestDigest is the REGISTRY content digest;
// configDigest is the image config digest (a different identifier).
const EXPECTED = [
  {
    name: "agent",
    tar: "aegispi-agent_phase3-5250243_1bed0ab1663f.tar",
    bytes: 105477120,
    tarSha256: "a569d4557a4edb7644f3cb93568155e81d9c1e2efee29177b9c6ccb808aed42c",
    manifestDigest: "1bed0ab1663fbd0d549ef9742b7190d582b80eb550906d1e5f3f07c7b3d35319",
    configDigest: "e5d9951897686e35602ae12e2583aad70fc91856e478591852ef68898ef81cd5",
    tag: "127.0.0.1:5000/aegispi/agent:phase3-52502432d21f",
  },
  {
    name: "acquisition",
    tar: "aegispi-acquisition_phase3-5250243_3c5b4dba28b.tar",
    bytes: 79900160,
    tarSha256: "723a03953dde4ad1283519310a9795c34e4fc80e8a660df1ffd25044e950487b",
    manifestDigest: "3c5b4dba28b503bbb2075fd95ab0fbf0c55ecbb356d85a717e8370e300f7d658",
    configDigest: "665f9c54d5f764cafd77e91c43ffc6a8ad11464fcde01a39572fd40c1a89e83f",
    tag: "127.0.0.1:5000/aegispi/acquisition:phase3-52502432d21f",
  },
  {
    name: "execution",
    tar: "aegispi-execution_phase3-5250243_202dfcd4fca2.tar",
    bytes: 112399360,
    tarSha256: "1661868dc22a3adada29a2f2c5af722d4d2ea24da730e97597e33edf27a2b111",
    manifestDigest: "202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050",
    configDigest: "9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e",
    tag: "127.0.0.1:5000/aegispi/execution:phase3-52502432d21f",
  },
];

const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
let failures = 0;
const fail = (msg) => { failures += 1; console.log(`FAIL  ${msg}`); };
const pass = (msg) => console.log(`PASS  ${msg}`);

mkdirSync(EXTRACT_ROOT, { recursive: true });
const results = [];

for (const exp of EXPECTED) {
  const tarPath = join(ARCHIVE_DIR, exp.tar);
  const section = { name: exp.name, checks: [] };
  const record = (ok, msg) => { section.checks.push({ ok, msg }); (ok ? pass : fail)(`${exp.name}: ${msg}`); };

  // 1) transport integrity: bytes + tar hash against the delivery table
  const bytes = statSync(tarPath).size;
  const tarHash = sha256File(tarPath);
  record(bytes === exp.bytes, `tar bytes ${bytes} (expected ${exp.bytes})`);
  record(tarHash === exp.tarSha256, `tar sha256 ${tarHash}`);

  // 2) extract into a fresh temp dir (originals untouched)
  const outDir = join(EXTRACT_ROOT, exp.name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const x = spawnSync("tar", ["-xf", tarPath, "-C", outDir], { timeout: 300000 });
  if (x.status !== 0) {
    record(false, `tar extract exit=${x.status}: ${String(x.stderr ?? "").slice(0, 120)}`);
    results.push(section);
    continue;
  }

  // 3) OCI index: manifests[0].digest must equal the documented manifest digest
  const index = JSON.parse(readFileSync(join(outDir, "index.json"), "utf8"));
  const idxDigest = index.manifests?.[0]?.digest ?? "(missing)";
  record(
    idxDigest === `sha256:${exp.manifestDigest}`,
    `index.json manifests[0].digest ${idxDigest} (expected sha256:${exp.manifestDigest})`,
  );

  // 4) docker-compat manifest.json: config reference + tag note.
  //    This Docker writes Config as a PATH (blobs/sha256/<hex>) — the hex
  //    inside must equal the documented config digest. RepoTags is EMPTY for
  //    digest-pinned docker save output (the known limit image-delivery.md §3
  //    reserves its re-tag step for): the tag is daemon-side and is verified
  //    against `docker image ls` before/after load instead.
  const compat = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  const compatTags = compat[0]?.RepoTags ?? [];
  const compatConfig = String(compat[0]?.Config ?? "");
  const compatConfigHex = compatConfig.replace(/^blobs\/sha256\//, "").replace(/^sha256:/, "");
  record(
    compatConfigHex === exp.configDigest,
    `manifest.json Config ${compatConfig} (digest ${compatConfigHex} equals documented config digest)`,
  );
  if (compatTags.length === 0) {
    console.log(`NOTE  ${exp.name}: manifest.json RepoTags empty — digest-pinned export; tag verified daemon-side`);
  } else {
    record(
      compatTags.includes(exp.tag),
      `manifest.json RepoTags ${compatTags.join(",")}`,
    );
  }

  // 5) manifest blob content hash == its own filename == documented digest
  const manifestBlobPath = join(outDir, "blobs", "sha256", exp.manifestDigest);
  const manifestBlobHash = sha256File(manifestBlobPath);
  const manifest = JSON.parse(readFileSync(manifestBlobPath, "utf8"));
  record(
    manifestBlobHash === exp.manifestDigest,
    `manifest blob sha256 ${manifestBlobHash} (self-addressed, equals documented manifest digest)`,
  );

  // 6) config blob: content hash + platform declaration (config digest is the
  //    image ID — a DIFFERENT identifier from the manifest digest)
  const cfgPath = join(outDir, "blobs", "sha256", exp.configDigest);
  const cfgHash = sha256File(cfgPath);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  record(cfgHash === exp.configDigest, `config blob sha256 ${cfgHash} (self-addressed, equals documented config digest)`);
  record(
    manifest.config?.digest === `sha256:${exp.configDigest}`,
    `manifest.config.digest ${manifest.config?.digest} points at the config blob`,
  );
  record(
    cfg.os === "linux" && cfg.architecture === "amd64",
    `config declares os=${cfg.os} architecture=${cfg.architecture}`,
  );

  // 7) EVERY referenced layer: content hash must equal its digest (filename)
  const layers = manifest.layers ?? [];
  let layerOk = true;
  let layerHashed = 0;
  for (const l of layers) {
    const hex = String(l.digest).replace("sha256:", "");
    const p = join(outDir, "blobs", "sha256", hex);
    try {
      if (sha256File(p) !== hex) { layerOk = false; break; }
      layerHashed += 1;
    } catch {
      layerOk = false;
      break;
    }
  }
  record(
    layerOk && layerHashed === layers.length,
    `all ${layerHashed}/${layers.length} referenced layer blobs hash to their own digests`,
  );

  // cleanup ONLY the extraction dir created by this run
  rmSync(outDir, { recursive: true, force: true });

  section.summary = {
    manifestDigest: `sha256:${exp.manifestDigest}`,
    configImageId: `sha256:${exp.configDigest}`,
    layers: layers.length,
    tag: exp.tag,
    tarSha256: tarHash,
    bytes,
  };
  results.push(section);
}

console.log("");
for (const r of results) {
  if (r.summary) {
    console.log(
      `IDENTITY ${r.name}: manifestDigest=${r.summary.manifestDigest} config/imageID=${r.summary.configImageId} layers=${r.summary.layers} tag=${r.summary.tag}`,
    );
  }
}
rmSync(EXTRACT_ROOT, { recursive: true, force: true });
console.log("");
const total = results.reduce((n, r) => n + r.checks.length, 0);
console.log(`=== verify-original-archives: ${total - failures} pass, ${failures} fail, ${total} judged ===`);
process.exit(failures > 0 ? 1 : 0);
