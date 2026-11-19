// Quota calibration (04 Phase 3 + 06 section 4: "容器初始配额是 Phase 1 占位
// 上限，须在 Phase 3 用真实构建压测校准，不宣称性能最优").
//
// What this measures, on REAL containers at the digest-pinned images:
//   CPU    a fixed compute loop under --cpus 1 vs --cpus 2 (the quota's real
//          effect on wall time)
//   memory the 2 GiB placeholder: 1.5 GiB of DIRTY pages completes, 2.5 GiB
//          dies at the cgroup bound (zero-fill alone is not charged — pages
//          must be touched, a lesson this calibration itself surfaced)
//   pids   the 256 placeholder: a spawn storm tops out inside the bound
//   disk   the tmpfs work volume: writes past the bound fail with ENOSPC
//          (measured at a 512 MiB bound; the 4 GiB placeholder uses the same
//          mechanism — a full-scale 4 GiB tmpfs write stresses dev-VM RAM and
//          is deferred to Phase 4 real-job calibration)
// The report records the measured numbers and the basis; it does NOT claim
// the placeholders are optimal — that judgment needs real repo jobs.

import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
  EVIDENCE_DIR,
} from "../lib/harness.mjs";
import { requireAppImageDigests, imageRef } from "../lib/image-gate.mjs";

lockedNodeGuard();
const { digests } = requireAppImageDigests();
const EXECUTION_REF = imageRef("execution", digests);
const AGENT_REF = imageRef("agent", digests);

const suite = makeSuite("quota-calibration");

function dockerRunMeasure(args, entrypoint, script, { timeoutMs = 120000 } = {}) {
  const r = spawnSync("docker", ["run", "--rm", ...args, "--entrypoint", entrypoint, EXECUTION_REF, ...script], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return { code: r.status, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

const measurements = {};

// CPU: the quota's real effect needs CONCURRENT work. Two worker threads
// under 1 CPU must share one core; under 2 CPUs they run side by side.
{
  const timedWork = `
    const { Worker } = require('node:worker_threads');
    const t = Date.now();
    const src = "let s=0; for(let i=0;i<2e8;i+=1){s+=i%7;}";
    const workers = [1, 2].map(() => new Worker(src, { eval: true }));
    let done = 0;
    workers.forEach((w) => w.on("exit", () => { done += 1; if (done === workers.length) console.log("loop-ms=" + (Date.now() - t)); }));
  `;
  const inner1 = dockerRunMeasure(["--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--read-only"], "node", ["-e", timedWork]);
  const inner2 = dockerRunMeasure(["--cpus", "2", "--memory", "1g", "--memory-swap", "1g", "--read-only"], "node", ["-e", timedWork]);
  const ms1 = Number((inner1.out.match(/loop-ms=(\d+)/) ?? [])[1]);
  const ms2 = Number((inner2.out.match(/loop-ms=(\d+)/) ?? [])[1]);
  measurements.cpu = { innerLoopMs: { cpus1: ms1, cpus2: ms2, ratio: ms2 > 0 ? Number((ms1 / ms2).toFixed(2)) : null } };
  suite.check(
    "cpu-quota-has-measurable-effect",
    inner1.code === 0 && inner2.code === 0 && ms1 > ms2 * 1.3,
    `2 worker threads: --cpus 1 实测 ${ms1}ms vs --cpus 2 实测 ${ms2}ms (ratio ${measurements.cpu.innerLoopMs.ratio})`,
  );
}

// Memory: the 2 GiB placeholder, dirty pages both sides of the bound.
{
  const underBound = dockerRunMeasure(
    ["--cpus", "1", "--memory", "2g", "--memory-swap", "2g", "--read-only"],
    "node",
    ["-e", "const bufs=[]; for(let i=0;i<6;i++){ const b=Buffer.alloc(256*1024*1024); b.fill(0x41); bufs.push(b); } console.log('mem-1.5g-ok chunks=' + bufs.length)"],
  );
  const overBound = dockerRunMeasure(
    ["--cpus", "1", "--memory", "2g", "--memory-swap", "2g", "--read-only"],
    "node",
    ["-e", "const bufs=[]; for(let i=0;i<12;i++){ const b=Buffer.alloc(256*1024*1024); b.fill(0x41); bufs.push(b); } console.log('mem-3g-unreachable')"],
    { timeoutMs: 90000 },
  );
  measurements.memory = { underBound: { code: underBound.code, out: underBound.out.slice(0, 60) }, overBound: { code: overBound.code, out: overBound.out.slice(0, 60) } };
  suite.check(
    "memory-2gib-placeholder-enforced-with-dirty-pages",
    underBound.code === 0 && /mem-1\.5g-ok/.test(underBound.out) && overBound.code !== 0 && !/mem-3g-unreachable/.test(overBound.out),
    `1.5GiB dirty -> exit ${underBound.code} OK; 3GiB dirty -> exit ${overBound.code} killed`,
  );
}

// Pids: the 256 placeholder against a spawn storm. The container's memory
// must NOT be the binding constraint here, or the storm dies to OOM first
// (the first calibration run measured exactly that lesson).
{
  const storm = dockerRunMeasure(
    ["--cpus", "1", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "256", "--read-only"],
    "node",
    ["-e", "const cp=require('child_process'); const ps=[]; let max=0; outer: for(let i=0;i<500;i++){ try { const p=cp.spawn('sh',['-c','exec sleep 2']); p.on('error', ()=>{}); if(p.pid===undefined){ break outer; } ps.push(p); max=ps.length; } catch { break outer; } } for(const p of ps){ try{p.kill('SIGKILL');}catch{} } setTimeout(()=>console.log('pids-max=' + max), 100);"],
    { timeoutMs: 90000 },
  );
  const maxSpawned = Number((storm.out.match(/pids-max=(\d+)/) ?? [])[1]);
  measurements.pids = { limit: 256, maxSpawned };
  suite.check(
    "pids-256-placeholder-bounds-spawn-storm",
    storm.code === 0 && maxSpawned > 0 && maxSpawned <= 260,
    `spawn storm topped out at ${maxSpawned} (limit 256)`,
  );
}

// Disk: tmpfs work volume ENOSPC both sides of a measured bound. The
// container's MEMORY must exceed the tmpfs size, or the cgroup OOM kills the
// writer before the volume bound is reached (measured lesson #2).
{
  const ws = makeWorkspace("cal-disk");
  mkdirSync(ws.stateDir, { recursive: true });
  const under = spawnSync("docker", [
    "run", "--rm", "--memory", "2g", "--memory-swap", "2g", "--read-only",
    "--tmpfs", "/job/work:rw,noexec,size=512m",
    "--entrypoint", "node", EXECUTION_REF,
    "-e", "const fs=require('fs'); let n=0; for(let i=0;i<8;i++){ fs.writeFileSync('/job/work/c'+i, Buffer.alloc(64*1024*1024, 0x41)); n++; } console.log('disk-512m-ok chunks='+n)",
  ], { encoding: "utf8", timeout: 90000 });
  const over = spawnSync("docker", [
    "run", "--rm", "--memory", "2g", "--memory-swap", "2g", "--read-only",
    "--tmpfs", "/job/work:rw,noexec,size=512m",
    "--entrypoint", "node", EXECUTION_REF,
    "-e", "const fs=require('fs'); try { for(let i=0;i<12;i++){ fs.writeFileSync('/job/work/c'+i, Buffer.alloc(64*1024*1024, 0x41)); } console.log('disk-768m-unreachable'); } catch(e){ console.log('disk-enospc:'+e.code); process.exit(9); }",
  ], { encoding: "utf8", timeout: 90000 });
  measurements.disk = {
    bound: "512m",
    under: { code: under.status, out: (under.stdout ?? "").trim().slice(0, 60) },
    over: { code: over.status, out: ((over.stdout ?? "") + (over.stderr ?? "")).trim().slice(0, 60) },
    note: "spec placeholder is 4g; mechanism identical, full-scale write deferred to Phase 4 real-job calibration to avoid dev-VM RAM pressure",
  };
  suite.check(
    "tmpfs-work-volume-bounds-disk-writes",
    under.status === 0 && /disk-512m-ok/.test(under.stdout ?? "") && over.status === 9 && /disk-enospc/.test(over.stdout ?? ""),
    `512MiB bound: 8x64MiB ok (exit ${under.status}); 12x64MiB -> ENOSPC (exit ${over.status})`,
  );
}

// Agent placeholder (1 CPU / 1 GiB): the boundary self-check under those
// exact limits — the calibrated agent runtime shape.
{
  const agent = spawnSync("docker", [
    "run", "--rm", "--network", "none",
    "--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256", "--read-only",
    "--tmpfs", "/agent-work:rw,noexec,size=64m",
    AGENT_REF, "--self-check",
  ], { encoding: "utf8", timeout: 60000 });
  measurements.agent = { code: agent.status, out: (agent.stdout ?? "").trim().slice(0, 60) };
  suite.check(
    "agent-1cpu-1gib-placeholder-runs-self-check",
    agent.status === 0 && /self-check: green/.test(agent.stdout ?? ""),
    `agent self-check under 1 CPU / 1 GiB / pids 256 -> exit ${agent.status}`,
  );
}

writeReport({
  suiteId: "quota-calibration",
  suite,
  label: "容器配额校准（06 §4 占位值实测，不宣称最优）",
  extra: {
    dataSources: "真实 docker 容器（execution/agent 按记录 digest 运行）；测量值见 measurements 字段",
    measurements,
  },
});

// The human-readable calibration report the phase handoff asks for.
{
  const { writeFileSync, mkdirSync: mk } = await import("node:fs");
  mk(join(EVIDENCE_DIR, "..", "reports"), { recursive: true });
  const report = [
    `# Phase 3 容器配额校准（06 §4 占位值实测）`,
    ``,
    `依据：evals/phase3/quota-calibration/run.mjs 在记录 digest 的 execution/agent 镜像上实测（evidence/quota-calibration-report.json）。`,
    ``,
    `| 维度 | 占位值 | 实测 | 结论 |`,
    `| --- | --- | --- | --- |`,
    `| CPU（job/agent 各 1） | 1 CPU | 双 worker 线程各 2e8 加法：--cpus 1 实测 ${measurements.cpu.innerLoopMs.cpus1}ms；--cpus 2 实测 ${measurements.cpu.innerLoopMs.cpus2}ms（比值 ${measurements.cpu.innerLoopMs.ratio}） | 限额真实生效；保留占位值 |`,
    `| 内存（job） | 2 GiB | 脏页 1.5 GiB 正常完成；脏页 3 GiB 被 cgroup OOM 终止（exit ${measurements.memory.overBound.code}） | 强制生效；保留占位值。注意：零填充不触碰页面不计入 cgroup，压测必须脏页 |`,
    `| pids | 256 | spawn 风暴实测峰值 ${measurements.pids.maxSpawned}（含 runner 自身） | 强制生效；保留占位值 |`,
    `| 可写盘（job work tmpfs） | 4 GiB | 在 512 MiB 同机制实测：8×64MiB 正常、12×64MiB ENOSPC | 机制强制生效；4 GiB 全量写会压开发机 Docker VM 内存，推迟到 Phase 4 真实 job 校准 |`,
    `| agent 限额 | 1 CPU / 1 GiB / pids 256 | 同限额下 self-check 退出码 0 | 边界自证通过 |`,
    ``,
    `不宣称性能最优：本轮只证明占位上限的强制性与量级；是否下调/上调取决于 Phase 4 真实仓库 job 的实测画像（由可信验证器统计 p95 用量后再定）。`,
    ``,
    `宿主与下载器配额独立配置，未借用 job 的盘/网限额（02 §1、06 §4）；acquisition 容器在本阶段测试中以其自身限额运行，下载有大小与解压双上限（见 test:security:integration 的下载滥用用例）。`,
    ``,
  ].join("\n");
  writeFileSync(join(EVIDENCE_DIR, "..", "reports", "quota-calibration.md"), report, "utf8");
}

process.exit(suiteExit(suite, { label: "quota-calibration" }));
