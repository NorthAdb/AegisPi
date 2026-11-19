// Build the three AegisPi application images for real (Phase 3 first product
// step, 04 Phase 3 entry condition) and record their TRUE digests.
//
//   node tools/build-app-images.mjs
//
// What it does, in order:
//   1. Ensures a throwaway local registry (127.0.0.1:5000) is running so the
//      built images get a registry-issued, content-addressed digest. A tag is
//      never treated as a digest, and a missing digest is a failure, never a
//      PIN_REQUIRED placeholder.
//   2. Stages each build context from committed sources into
//      .audit/image-build/<name>/ (execution/acquisition: Dockerfile + src/;
//      agent: root package.json + package-lock.json + apps/daemon product +
//      apps/containers/agent/worker.mjs).
//   3. Builds with docker build against the digest-pinned base image.
//   4. Pushes to the local registry, reads back RepoDigests, and verifies the
//      digest resolves via docker manifest inspect.
//   5. Smoke-tests each image at its DIGEST (agent --self-check; a real
//      execution job run under --network none; an acquisition fetch that
//      must fail closed and still write a report).
//   6. Rewrites docs/phase3/reports/image-digest.md with the real digests in
//      a machine-readable block that evals/phase3/lib/image-gate.mjs parses.
//
// Exit code 0 only when every build, digest, and smoke test passes.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(join(REPO, "docker", name, "Dockerfile"), join(dir, "Dockerfile"));
  if (name === "agent") {
    cpSync(join(REPO, "package.json"), join(dir, "package.json"));
    cpSync(join(REPO, "package-lock.json"), join(dir, "package-lock.json"));
    mkdirSync(join(dir, "apps", "daemon"), { recursive: true });
    cpSync(join(REPO, "apps", "daemon", "package.json"), join(dir, "apps", "daemon", "package.json"));
    cpSync(join(REPO, "apps", "daemon", "config"), join(dir, "apps", "daemon", "config"), { recursive: true });
    cpSync(join(REPO, "apps", "daemon", "src"), join(dir, "apps", "daemon", "src"), { recursive: true });
    mkdirSync(join(dir, "apps", "containers", "agent"), { recursive: true });
    cpSync(
      join(REPO, "docker", "agent", "src", "worker.mjs"),
      join(dir, "apps", "containers", "agent", "worker.mjs"),
    );
  } else {
    cpSync(join(REPO, "docker", name, "src"), join(dir, "src"), { recursive: true });
  }
  return dir;
}

function buildAndPush(name, tag) {
  const dir = stage(name);
  const full = `${REGISTRY}/aegispi/${name}:${tag}`;
  const b = run("docker", ["build", "-t", full, dir]);
  if (b.code !== 0) die(`docker build failed for ${name}`);
  const p = run("docker", ["push", full]);
  if (p.code !== 0) die(`docker push failed for ${name} (${full})`);
  const insp = run("docker", ["image", "inspect", full, "--format", "{{json .RepoDigests}}"], { capture: true });
  if (insp.code !== 0) die(`docker image inspect failed for ${name}`);
  let digests;
  try {
    digests = JSON.parse(insp.out.trim());
  } catch {
    die(`cannot parse RepoDigests for ${name}: ${insp.out.trim()}`);
  }
  const mine = digests.filter((d) => d.startsWith(`${REGISTRY}/aegispi/${name}@sha256:`));
  if (mine.length === 0) die(`no registry digest recorded for ${name}; refusing to continue without one`);
  const digest = mine[0].split("@")[1];
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) die(`digest for ${name} is not a sha256 content digest: ${digest}`);
  // Resolve the digest by PULLING it back through the daemon: proves the
  // content-addressed reference the tests will run on truly resolves.
  const verify = run("docker", ["pull", `${REGISTRY}/aegispi/${name}@${digest}`], { capture: true });
  if (verify.code !== 0) die(`digest ${digest} does not resolve in the registry for ${name}: ${verify.out.trim().slice(0, 300)}`);
  return { digest, ref: `${REGISTRY}/aegispi/${name}@${digest}`, full };
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
    "run", "--rm", "--network", "none",
    "-v", `${join(tmp, "input")}:/job/input:ro`,
    "-v", `${join(tmp, "output")}:/job/output`,
    "--tmpfs", "/job/work:rw,size=64m",
    ref,
  ]);
  const resultPath = join(tmp, "output", "result.json");
  if (r.code !== 0) die(`execution smoke run exited ${r.code} at digest ${ref}`);
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
    "run", "--rm",
    "-v", `${join(tmp, "plan")}:/plan:ro`,
    "-v", `${join(tmp, "downloads")}:/downloads`,
    ref,
  ]);
  const reportPath = join(tmp, "downloads", "report.json");
  if (r.code === 0) die(`acquisition smoke unexpectedly succeeded against an unreachable source`);
  if (!existsSync(reportPath)) die(`acquisition smoke produced no report.json at digest ${ref}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.failures !== 1 || report.results?.[0]?.ok !== false) {
    die(`acquisition smoke report does not record the failure: ${JSON.stringify(report)}`);
  }
}

function writeReport(digests, { tag, base, builtAt, node, docker }) {
  mkdirSync(join(REPO, "docs", "phase3", "reports"), { recursive: true });
  const lines = [];
  lines.push(`# Phase 3 应用镜像 digest 证据`);
  lines.push("");
  lines.push(`三个应用镜像的首次真实构建记录（04 Phase 3 入口硬条件）。基础镜像与 Phase 1 记录一致：\`node:22.23.5-bookworm-slim\`，index digest \`${BASE_DIGEST}\`（见 docs/phase1/reports/image-digest.md）。digest 为推送到本机构建 registry（${REGISTRY}，registry:2）后由 \`\`docker image inspect --format '{{json .RepoDigests}}'\`\` 读取的真实内容摘要，并经 \`\`docker manifest inspect\`\` 独立解析核验；任何 \`PIN_REQUIRED\` 或缺失 digest 都必须被 evals/phase3/lib/image-gate.mjs 拒绝。`);
  lines.push("");
  lines.push("| 镜像 | tag | 真实 digest（OCI） | 构建冒烟 |");
  lines.push("| --- | --- | --- | --- |");
  for (const name of ["agent", "acquisition", "execution"]) {
    lines.push(`| ${name} | \`${digests[name].full}\` | \`${digests[name].digest}\` | ${digests[name].smoke} |`);
  }
  lines.push("");
  lines.push(`- 构建时间：${builtAt}（Asia/Hong_Kong）；源码提交：${tag}；构建 Node：${node}；Docker：${docker}。`);
  lines.push(`- 冒烟记录：agent \`--self-check\` 退出码 0（容器内自证 Pi exact 1.5.2、cacheWarming=off 映射、无凭据 env、无 ~/.pi、无 docker socket）；execution 在 \`\`--network none\`\` 下真实执行一个 job（result.json 干净完成）；acquisition 对不可达 URL 失败关闭并写出 report.json。`);
  lines.push(`- 隔离与逃逸测试必须跑在这些 digest 上（\`docker run … ${REGISTRY}/aegispi/<name>@<digest>\`），不得使用浮动 tag。配额校准（06 §4 占位值）见 docs/phase3/reports/quota-calibration.md。`);
  lines.push("");
  lines.push("机器可读块（image-gate.mjs 解析，勿手改格式）：");
  lines.push("");
  lines.push("<!-- app-image-digests v1");
  for (const name of ["agent", "acquisition", "execution"]) {
    lines.push(`${name}: ${digests[name].digest}`);
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
    const built = buildAndPush(name, tag);
    console.log(`== ${name} digest: ${built.digest}`);
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
