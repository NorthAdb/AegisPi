// Build the three AegisPi application images for real (Phase 3 first product
// step, 04 Phase 3 entry condition) and record evidence that BINDS each
// digest to the tree that built it (audit F1):
//   <name>            the OCI MANIFEST digest pushed to the local registry
//                     (the reference the suites run on)
//   <name>.config     the image config digest embedded in that manifest
//                     (a local image/config id is NOT a manifest digest)
//   <name>.context    the deterministic hash of the staged build context,
//                     recomputed by evals/phase3/lib/image-gate.mjs before
//                     any isolation suite: a changed tree makes the
//                     recorded digests stale and the gate refuses.
//
//   node tools/build-app-images.mjs
//
// What it does, in order:
//   1. Ensures a throwaway local registry (127.0.0.1:5000) is running so the
//      built images get a registry-issued, content-addressed digest.
//   2. Stages each build context from committed sources into
//      .audit/image-build/<name>/ using the SAME file list the context
//      hash is computed from (evals/phase3/lib/image-bind.mjs).
//   3. Builds with docker build against the digest-pinned base image.
//   4. Pushes to the local registry, reads back RepoDigests (the manifest
//      digest), fetches the manifest from the registry to read its embedded
//      config digest, and pull-verifies the digest resolves.
//   5. Smoke-tests each image at its DIGEST. Output mounts use named
//      volumes so the IMAGE-OWNED /job/output initializes them: no host
//      umask ever decides whether the runner can write (audit F2).
//   6. Rewrites docs/phase3/reports/image-digest.md with the v2 machine
//      block that evals/phase3/lib/image-gate.mjs parses.
//
// Exit code 0 only when every build, digest, and smoke test passes.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appImageContextFiles,
  appImageContextHash,
  contextFileBytes,
  fetchRegistryManifest,
} from "../evals/phase3/lib/image-bind.mjs";

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const STAGE_ROOT = join(REPO, ".audit", "image-build");
const REPORT_PATH = join(REPO, "docs", "phase3", "reports", "image-digest.md");
const REGISTRY_NAME = "aegispi-build-registry";
const REGISTRY = "127.0.0.1:5000";
const BASE_DIGEST = "sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee";

function die(msg) {
  console.error(`build-app-images: ${msg}`);
  process.exit(1);
}

function run(cmd, args, { cwd, capture = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: cwd ?? REPO,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function gitShort() {
  const r = run("git", ["rev-parse", "--short=12", "HEAD"], { capture: true });
  return r.out.trim();
}

function ensureRegistrySync() {
  const inspect = run("docker", ["inspect", "-f", "{{.State.Running}}", REGISTRY_NAME], { capture: true });
  if (inspect.code === 0 && inspect.out.trim() === "true") {
    return;
  }
  if (inspect.code !== 0) {
    const created = run("docker", [
      "run", "-d", "--name", REGISTRY_NAME, "-p", `${REGISTRY}:5000`, "registry:2",
    ]);
    if (created.code !== 0) {
      die(`cannot start the local build registry: ${REGISTRY_NAME}`);
    }
  } else {
    const started = run("docker", ["start", REGISTRY_NAME]);
    if (started.code !== 0) die(`cannot start the existing registry container`);
  }
}

export async function ensureRegistry() {
  ensureRegistrySync();
  // The registry answers /v2/ with 200 (or 401 with auth configured) when up.
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`http://${REGISTRY}/v2/`);
      if (res.status === 200 || res.status === 401) return;
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1000);
  }
  die("local build registry did not come up within 30s");
}

function stage(name) {
  const dir = join(STAGE_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Stage exactly the file list image-bind.mjs hashes, with the SAME
  // LF-normalized bytes the context hash reads: the hash input and the
  // docker build context can never drift apart, and a Windows autocrlf
  // worktree stages identical bytes to a Linux checkout (re-review F1).
  for (const f of appImageContextFiles(name, REPO)) {
    const dest = join(dir, f.rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contextFileBytes(f.abs));
  }
  return dir;
}

async function buildAndPush(name, tag) {
  const dir = stage(name);
  const full = `${REGISTRY}/aegispi/${name}:${tag}`;
  // --provenance=false --sbom=false: BuildKit otherwise pushes a manifest
  // LIST (with attestation manifests) and the pushed digest would name the
  // index, not the platform image. The pinned reference must be the
  // platform manifest itself (audit F1: manifest digest, never an index
  // or a config id).
  const b = run("docker", ["build", "--provenance=false", "--sbom=false", "-t", full, dir]);
  if (b.code !== 0) die(`docker build failed for ${name}`);
  const p = run("docker", ["push", full]);
  if (p.code !== 0) die(`docker push failed for ${name} (${full})`);
  const insp = run("docker", ["image", "inspect", full, "--format", "{{json .RepoDigests}}"], { capture: true });
  if (insp.code !== 0) die(`docker image inspect failed for ${name}`);
  let repoDigests;
  try {
    repoDigests = JSON.parse(insp.out.trim());
  } catch {
    die(`cannot parse RepoDigests for ${name}: ${insp.out.trim()}`);
  }
  const mine = repoDigests.filter((d) => d.startsWith(`${REGISTRY}/aegispi/${name}@sha256:`));
  if (mine.length === 0) die(`no registry digest recorded for ${name}; refusing to continue without one`);
  const digest = mine[0].split("@")[1];
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) die(`digest for ${name} is not a sha256 content digest: ${digest}`);
  // The manifest's own config digest, read back from the registry (never a
  // local .Id: config and manifest digests are different namespaces).
  let resolved;
  try {
    resolved = await fetchRegistryManifest(name, digest, { registry: REGISTRY });
  } catch (e) {
    die(`${name}: ${e.message}`);
  }
  if (!resolved.configDigest) die(`no config digest resolved for ${name}`);
  const configDigest = resolved.configDigest;
  // Resolve the digest by PULLING it back through the daemon: proves the
  // content-addressed reference the tests will run on truly resolves.
  const verify = run("docker", ["pull", `${REGISTRY}/aegispi/${name}@${digest}`], { capture: true });
  if (verify.code !== 0) die(`digest ${digest} does not resolve in the registry for ${name}: ${verify.out.trim().slice(0, 300)}`);
  const contextHash = appImageContextHash(name, REPO);
  return { digest, configDigest, contextHash, ref: `${REGISTRY}/aegispi/${name}@${digest}`, full };
}

function smokeAgent(ref) {
  const r = run("docker", ["run", "--rm", ref, "--self-check"]);
  if (r.code !== 0) die(`agent image self-check failed at digest ${ref}`);
}

function smokeExecution(ref) {
  const tmp = join(STAGE_ROOT, "smoke-execution");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "input"), { recursive: true });
  mkdirSync(join(tmp, "output"), { recursive: true });
  const volume = `aegispi-smoke-execution-out`;
  run("docker", ["volume", "rm", "-f", volume], { capture: true });
  writeFileSync(
    join(tmp, "input", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      jobId: "smoke:build:execution",
      command: "node",
      args: ["-e", "console.log('execution smoke')"],
      deadlineMs: 20000,
    }) + "\n",
    "utf8",
  );
  const r = run("docker", [
    "run", "--network", "none",
    "--name", "aegispi-smoke-execution",
    "-v", `${join(tmp, "input")}:/job/input:ro`,
    "--mount", `type=volume,src=${volume},dst=/job/output`,
    "--tmpfs", "/job/work:rw,noexec,size=64m,mode=1777",
    ref,
  ]);
  // No --rm: the evidence is collected from the stopped container BEFORE
  // it is removed.
  const cp = run("docker", ["cp", `aegispi-smoke-execution:/job/output/.`, join(tmp, "output")], { capture: true });
  run("docker", ["rm", "-f", "aegispi-smoke-execution"], { capture: true });
  run("docker", ["volume", "rm", "-f", volume], { capture: true });
  if (r.code !== 0) die(`execution smoke run exited ${r.code} at digest ${ref}`);
  if (cp.code !== 0) die(`execution smoke could not collect /job/output: ${cp.out.trim().slice(0, 200)}`);
  const resultPath = join(tmp, "output", "result.json");
  if (!existsSync(resultPath)) die(`execution smoke produced no result.json at digest ${ref}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
    die(`execution smoke result is not a clean completion: ${JSON.stringify(result)}`);
  }
}

function smokeAcquisition(ref) {
  const tmp = join(STAGE_ROOT, "smoke-acquisition");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "plan"), { recursive: true });
  mkdirSync(join(tmp, "downloads"), { recursive: true });
  const volume = `aegispi-smoke-acquisition-out`;
  run("docker", ["volume", "rm", "-f", volume], { capture: true });
  // Fail-closed smoke: an unreachable, unauthenticated URL must produce a
  // written report with exactly that failure and exit 1. The full download
  // matrix (caps, traversal, tar abuse) lives in the Phase 3 suites.
  writeFileSync(
    join(tmp, "plan", "plan.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          url: "http://127.0.0.1:9/unreachable",
          destRelPath: "unreachable.txt",
          maxSizeBytes: 1024,
          mode: "file",
        },
      ],
    }) + "\n",
    "utf8",
  );
  const r = run("docker", [
    "run",
    "--name", "aegispi-smoke-acquisition",
    "-v", `${join(tmp, "plan")}:/plan:ro`,
    "--mount", `type=volume,src=${volume},dst=/downloads`,
    ref,
  ]);
  // No --rm: the fail-closed report is collected from the stopped container
  // BEFORE it is removed.
  const cp = run("docker", ["cp", `aegispi-smoke-acquisition:/downloads/.`, join(tmp, "downloads")], { capture: true });
  run("docker", ["rm", "-f", "aegispi-smoke-acquisition"], { capture: true });
  run("docker", ["volume", "rm", "-f", volume], { capture: true });
  if (r.code === 0) die(`acquisition smoke unexpectedly succeeded against an unreachable source`);
  if (cp.code !== 0) die(`acquisition smoke could not collect /downloads: ${cp.out.trim().slice(0, 200)}`);
  const reportPath = join(tmp, "downloads", "report.json");
  if (!existsSync(reportPath)) die(`acquisition smoke produced no report.json at digest ${ref}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.failures !== 1 || report.results?.[0]?.ok !== false) {
    die(`acquisition smoke report does not record the failure: ${JSON.stringify(report)}`);
  }
}

function writeReport(digests, { tag, builtAt, node, docker }) {
  mkdirSync(join(REPO, "docs", "phase3", "reports"), { recursive: true });
  const lines = [];
  lines.push(`# Phase 3 应用镜像 digest 证据`);
  lines.push("");
  lines.push(`三个应用镜像的真实构建记录（04 Phase 3 入口硬条件），按 v2 证据格式绑定源码树。基础镜像与 Phase 1 记录一致：\`node:22.23.5-bookworm-slim\`，index digest \`${BASE_DIGEST}\`（见 docs/phase1/reports/image-digest.md）。`);
  lines.push("");
  lines.push(`- **manifest digest**：推送到本机构建 registry（${REGISTRY}，registry:2）后由 \`\`docker image inspect --format '{{json .RepoDigests}}'\`\` 读出的 OCI manifest 内容摘要，并经 \`\`docker pull <ref>@<digest>\`\` 回拉核验；隔离套件只跑 manifest digest。`);
  lines.push(`- **config digest**：同一 manifest 从 registry 读回的内嵌 image config 摘要（本地 image/config id 与 manifest digest 是不同命名空间，不可互换）。`);
  lines.push(`- **context digest**：构建上下文（Dockerfile + 分台源码，见 evals/phase3/lib/image-bind.mjs 的文件清单）的确定性字节哈希；staged 路径固定 \`/\`、文件字节按 LF 规范化，摘要是提交内容的函数——同一提交在 Linux 检出与 Windows autocrlf 检出上重算一致（复审 F1）。image-gate 在每条套件前重算本树哈希，漂移即拒绝；并核验 manifest 内嵌 config blob 声明 linux/amd64，非本平台 config 拒绝。`);
  lines.push(`- 输出挂载为镜像所有的 named volume（镜像内 /job/output、/downloads 属 uid 999），宿主 umask 不再决定可写性（审计 F2）；不使用全局 chmod 777。`);
  lines.push("");
  lines.push(`| 镜像 | tag | manifest digest | config digest | context digest | 构建冒烟 |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const name of ["agent", "acquisition", "execution"]) {
    lines.push(
      `| ${name} | \`${digests[name].full}\` | \`${digests[name].digest}\` | \`${digests[name].configDigest}\` | \`${digests[name].contextHash}\` | ${digests[name].smoke} |`,
    );
  }
  lines.push("");
  lines.push(`- 构建时间：${builtAt}（Asia/Hong_Kong）；源码提交：${tag}；构建 Node：${node}；Docker：${docker}。apt 安装的 git 随 bookworm 源浮动（执行镜像内的 git -c 边界夹具，审计 F5）；基础镜像仍按 digest 固定。`);
  lines.push(`- 冒烟记录：agent \`--self-check\` 退出码 0；execution 在 \`\`--network none\`\` 下经 volume 输出真实执行一个 job（result.json 干净完成）；acquisition 对不可达 URL 失败关闭并经 volume 写出 report.json。`);
  lines.push(`- 隔离与逃逸测试必须跑在 manifest digest 上（\`docker run … ${REGISTRY}/aegispi/<name>@<digest>\`），不得使用浮动 tag。配额校准（06 §4 占位值）见 docs/phase3/reports/quota-calibration.md。`);
  lines.push("");
  lines.push("机器可读块（image-gate.mjs 解析，勿手改格式）：");
  lines.push("");
  lines.push("<!-- app-image-digests v2");
  for (const name of ["agent", "acquisition", "execution"]) {
    lines.push(`${name}: ${digests[name].digest}`);
    lines.push(`${name}.config: ${digests[name].configDigest}`);
    lines.push(`${name}.context: ${digests[name].contextHash}`);
  }
  lines.push("-->");
  lines.push("");
  writeFileSync(REPORT_PATH, lines.join("\n"), "utf8");
}

async function main() {
  if (process.version !== "v22.23.5" && !process.argv.includes("--skip-node-guard")) {
    die(`refusing to run on ${process.version}; image evidence must be produced on the locked Node 22.23.5 (use the explicit path D:/AegisPi/tools/node-v22.23.5/node.exe)`);
  }
  const dockerVersion = run("docker", ["--version"], { capture: true });
  if (dockerVersion.code !== 0) die("docker is not available");
  const tag = `phase3-${gitShort()}`;
  await ensureRegistry();
  const digests = {};
  for (const name of ["agent", "acquisition", "execution"]) {
    console.log(`== building ${name} (tag ${tag})`);
    const built = await buildAndPush(name, tag);
    console.log(`== ${name} manifest: ${built.digest}`);
    console.log(`== ${name} config:   ${built.configDigest}`);
    console.log(`== ${name} context:  ${built.contextHash}`);
    digests[name] = { ...built, smoke: "pending" };
  }
  // Smoke tests run AT THE DIGEST, not the tag.
  console.log("== smoke: agent --self-check");
  smokeAgent(digests.agent.ref);
  digests.agent.smoke = "self-check exit 0";
  console.log("== smoke: execution no-network job");
  smokeExecution(digests.execution.ref);
  digests.execution.smoke = "no-network job completed clean";
  console.log("== smoke: acquisition fail-closed fetch");
  smokeAcquisition(digests.acquisition.ref);
  digests.acquisition.smoke = "fail-closed fetch + report";
  writeReport(digests, {
    tag: gitShort(),
    base: BASE_DIGEST,
    builtAt: new Date().toLocaleString("en-GB", { timeZone: "Asia/Hong_Kong", hour12: false }),
    node: process.version,
    docker: dockerVersion.out.trim(),
  });
  console.log(`== report written: docs/phase3/reports/image-digest.md`);
  console.log("== done");
}

main().catch((e) => die(e.message));
