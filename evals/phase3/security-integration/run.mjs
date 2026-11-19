// test:security:integration — Phase 3 gate (02 section 8, the REAL isolation
// group: 绝对路径程序、子进程改环境、git -c、直HTTP、网络/DNS/IPv6/metadata、
// 软链与TOCTOU、宿主端口、资源耗尽、秘密canary、直接改验收文件、上传/下载
// 及编码重定向).
//
// Every case runs REAL docker containers at the digest-pinned images. The
// attacker model is 02's: malicious repository code / a poisoned tool /
// an injected instruction INSIDE the sandbox, trying to reach OUT. The
// boundary under test is the container + host wiring, never a prompt. A
// missing container environment is NOT a pass — the image gate (v2) refuses
// to run without evidence that binds source tree, registry manifest and
// config, and no case here is satisfied by a mock.
//
// Audit F5 hardened the network probes: direct HTTP, host ports and env
// manipulation now aim at THIS suite's own local HTTP source, and each
// verdict is derived from the connection's actual outcome. A CONTROL
// container with bridge networking (same image, same caps, only the network
// differs) must report every leak detected — proving the probes can see
// reachability and are not tautologies that print BLOCKED unconditionally.
//
// Audit F4: the acquisition source is reachable on EVERY engine
// (--add-host=host.docker.internal:host-gateway), a `fetch failed` reason
// FAILS a case instead of counting as a policy refusal, and redirects to a
// different host must be refused unless the plan allowlists it.
//
// The acquisition cases use a LOCAL throwaway HTTP source bound on this
// machine only (host.docker.internal): the "authorized test source" for
// download abuse. No external system is touched, no credential exists
// anywhere in these flows.

import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  suiteExit,
  writeReport,
} from "../lib/harness.mjs";
import { requireAppImageDigests, imageRef } from "../lib/image-gate.mjs";

lockedNodeGuard();
const { digests } = await requireAppImageDigests();
const EXECUTION_REF = imageRef("execution", digests);
const AGENT_REF = imageRef("agent", digests);
const ACQUISITION_REF = imageRef("acquisition", digests);

const suite = makeSuite("security-integration");

function dockerRun(args, { capture = true } = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { code: r.status, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

// ASYNC docker run: the local HTTP source lives in THIS process, so the
// event loop must keep serving while the container fetches. A synchronous
// spawnSync would deadlock the downloader against our own server.
function dockerRunAsync(args, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out: String(e.message) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim() });
    });
  });
}

// A job-style container whose evidence lives in an image-owned OUTPUT
// volume: run (no --rm), wait for exit, docker cp the evidence out, remove
// container + volume. The host umask never decides writability (audit F2).
async function runJobStyle(args, { name, outputDir, containerSrc = "/job/output" }) {
  dockerRun(["rm", "-f", name]);
  const volume = `${name}-out`;
  dockerRun(["volume", "rm", "-f", volume]);
  const r = await dockerRunAsync([
    "run", "--name", name,
    "--mount", `type=volume,src=${volume},dst=${containerSrc}`,
    ...args,
  ]);
  dockerRun(["cp", `${name}:${containerSrc}/.`, outputDir]);
  dockerRun(["rm", "-f", name]);
  dockerRun(["volume", "rm", "-f", volume]);
  return r;
}

// ---------------------------------------------------------------------------
// The local throwaway source server. It starts FIRST so the escape battery
// can aim its direct-HTTP, env-manipulation and host-port probes at a REAL
// listening port on this machine, and stays up through the acquisition
// cases.
const ws = makeWorkspace("sec-integration");
mkdirSync(join(ws.stateDir, "input"), { recursive: true });
mkdirSync(join(ws.stateDir, "output"), { recursive: true });
// A host canary OUTSIDE any container mount: if any probe could reach host
// files, it would read this. It cannot.
const canaryDir = join(ws.stateDir, "host-canary");
mkdirSync(canaryDir, { recursive: true });
const CANARY_TEXT = `host-canary-${randomBytes(16).toString("hex")}`;
writeFileSync(join(canaryDir, "secret.txt"), CANARY_TEXT, "utf8");
// An "acceptance file" the attacker would love to rewrite: host-side, never
// mounted.
writeFileSync(join(ws.stateDir, "oracle-acceptance.json"), JSON.stringify({ passes: "host-owned" }), "utf8");

// Minimal tar writer (POSIX ustar): enough to build every abuse case.
function tarEntry({ name, type = "0", content = Buffer.alloc(0), linkName = "", mode = "0000644", devmajor = 0, devminor = 0 }) {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, "utf8");
  header.write(mode, 100, "utf8");
  header.write("0000000", 108, "utf8"); // uid
  header.write("0000000", 116, "utf8"); // gid
  header.write(String(content.length).padStart(11, "0") + "\0", 124, "utf8");
  header.write("00000000000", 136, "utf8"); // mtime
  header.write(type, 156, "utf8");
  header.write(linkName.slice(0, 100), 157, "utf8");
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  if (type === "3" || type === "4") {
    header.write(String(devmajor).padStart(7, "0") + " ", 329, "utf8");
    header.write(String(devminor).padStart(7, "0") + " ", 337, "utf8");
  }
  let checksum = 0;
  for (let i = 0; i < 512; i += 1) {
    if (i >= 148 && i < 156) checksum += 32;
    else checksum += header[i];
  }
  // The checksum field is OCTAL (GNU tar parses it that way); a decimal
  // value makes the whole archive unreadable.
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  const contentBlocks = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(contentBlocks);
  return Buffer.concat([header, contentBlocks]);
}
function buildTar(entries) {
  const parts = entries.map((e) => tarEntry(e));
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const goodTar = buildTar([
  { name: "src/", type: "5", mode: "0000755" },
  { name: "src/hello.txt", type: "0", content: Buffer.from("hello from the acquisition drill\n") },
]);
const traversalTar = buildTar([
  { name: "good.txt", type: "0", content: Buffer.from("ok\n") },
  { name: "../escape.txt", type: "0", content: Buffer.from("escaped\n") },
]);
const symlinkTar = buildTar([
  { name: "innocent.txt", type: "0", content: Buffer.from("ok\n") },
  { name: "link-out", type: "2", linkName: "../../../../etc/passwd" },
]);
const deviceTar = buildTar([
  { name: "dev-kmem", type: "3", devmajor: 1, devminor: 1 },
]);
// A gzip bomb: 24MB of zeros compresses tiny; the download cap is 8MB so the
// bomb must die at the DECOMPRESSED bound, not the compressed size.
const bombInner = Buffer.alloc(24 * 1024 * 1024, 0x41);
const served = {};
function serve(name, body, contentType = "application/octet-stream") {
  served[name] = { body, contentType };
}
serve("/good.tar.gz", gzipSync(goodTar), "application/gzip");
serve("/traversal.tar.gz", gzipSync(traversalTar), "application/gzip");
serve("/symlink.tar.gz", gzipSync(symlinkTar), "application/gzip");
serve("/device.tar.gz", gzipSync(deviceTar), "application/gzip");
serve("/bomb.tar.gz", gzipSync(bombInner), "application/gzip");
serve("/big.bin", Buffer.alloc(9 * 1024 * 1024, 0x42), "application/octet-stream");
serve("/hit-direct", Buffer.from("direct-source-alive"), "text/plain");
serve("/hit-via-proxy", Buffer.from("proxy-probe-source-alive"), "text/plain");

const server = createServer((req, res) => {
  if (req.url === "/redirect-once") {
    res.writeHead(302, { location: "/good.tar.gz" });
    res.end();
    return;
  }
  if (req.url === "/redirect-file-scheme") {
    res.writeHead(302, { location: "file:///etc/passwd" });
    res.end();
    return;
  }
  if (req.url === "/redirect-loop-a") {
    res.writeHead(302, { location: "/redirect-loop-b" });
    res.end();
    return;
  }
  if (req.url === "/redirect-loop-b") {
    res.writeHead(302, { location: "/redirect-loop-a" });
    res.end();
    return;
  }
  if (req.url === "/evil-redirect") {
    res.writeHead(302, { location: "/redirect-once" });
    res.end();
    return;
  }
  if (req.url === "/redirect-cross-host") {
    // A DIFFERENT host name that still resolves to this machine from the
    // container (added via --add-host): the downloader must refuse it by
    // default and follow it only when the plan allowlists the name. Using
    // "localhost" here would be wrong — inside the container that name is
    // the container itself, so the allowlisted fetch would never reach the
    // source.
    res.writeHead(302, { location: `http://allowlist-demo.host-gateway.local:${sourcePort}/good.tar.gz` });
    res.end();
    return;
  }
  const hit = served[req.url];
  if (hit) {
    res.writeHead(200, { "content-type": hit.contentType });
    res.end(hit.body);
    return;
  }
  res.writeHead(404);
  res.end("no");
});
await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
const sourcePort = server.address().port;
const SOURCE_HOSTPORT = `host.docker.internal:${sourcePort}`;
const SOURCE = `http://${SOURCE_HOSTPORT}`;

// ---------------------------------------------------------------------------
// F2 gate: the image must own its output mount so no host umask can deny the
// image user its own evidence directory. A fresh volume at /job/output
// initializes from the image's directory; the assertion is engine-agnostic.
{
  const volume = `aegispi-ownership-probe-out`;
  dockerRun(["volume", "rm", "-f", volume]);
  const probe = dockerRun([
    "run", "--rm",
    "--mount", `type=volume,src=${volume},dst=/job/output`,
    "--entrypoint", "sh",
    EXECUTION_REF,
    "-c", "id -u; test -w /job/output && echo OUTPUT_WRITABLE || echo OUTPUT_DENIED",
  ]);
  dockerRun(["volume", "rm", "-f", volume]);
  const uid = (probe.out.match(/^\s*(\d+)\s*$/m) ?? [])[1];
  const writable = /OUTPUT_WRITABLE/.test(probe.out);
  suite.check(
    "execution-image-owns-its-output-mount",
    uid === "999" && writable,
    `uid=${uid} writable=${writable} (a fresh volume at /job/output initializes from the image's uid-999 directory; the host umask never decides)`,
  );
}

// ---------------------------------------------------------------------------
// The escape battery: ONE malicious job whose manifest commands every escape
// probe from 02 section 8 in order, each writing a verdict line derived from
// the ATTEMPT'S ACTUAL OUTCOME (audit F5: no probe reports BLOCKED without
// observing a failure). The host then asserts every verdict is a block and,
// separately, a bridge-networked CONTROL container proves the network probes
// would have seen a leak.
writeFileSync(
  join(ws.stateDir, "input", "manifest.json"),
  JSON.stringify({
    schemaVersion: 1,
    jobId: "job:sec-integration:escape-battery",
    command: "node",
    args: ["-e", batteryScript()],
    deadlineMs: 60000,
  }) + "\n",
  "utf8",
);
function batteryScript() {
  return `
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const cp = require('child_process');
const out = [];
function probe(name, fn) {
  try { out.push(name + '=' + fn()); } catch (e) { out.push(name + '=ERR:' + (e && e.code ? e.code : String(e && e.message).slice(0, 60))); }
}
// direct HTTP against this suite's OWN listening source: only a response is a leak.
probe('direct_http', () => {
  const r = cp.spawnSync('node', ['-e', "require('http').get('http://${SOURCE_HOSTPORT}/hit-direct', res=>{console.log('LEAK:'+res.statusCode); res.resume();}).on('error', e=>console.log('BLOCKED:'+e.code))"], { timeout: 6000 });
  return r.stdout.toString().trim() || 'no-output(status=' + r.status + ')';
});
// DNS + IPv6: resolution must fail inside the namespace.
probe('dns_ipv6', () => {
  const r = cp.spawnSync('node', ['-e', "require('dns').lookup('example.com', (e)=>{ console.log(e ? 'BLOCKED:'+e.code : 'DNS_LEAK'); })"]);
  const seen = ((r.stdout ?? '') + (r.stderr ?? '')).toString().trim();
  return /BLOCKED/.test(seen) ? seen : (seen || 'no-output');
});
// host ports: an ACTUAL TCP connect against the source port, verdict from
// the connection's own result — never decided before the attempt.
probe('host_ports', () => {
  const r = cp.spawnSync('node', ['-e', "const net=require('net'); const s=net.connect({host:'${SOURCE_HOSTPORT.split(':')[0]}',port:${sourcePort},timeout:2500}); s.on('connect',()=>{console.log('CONNECTED:'+s.remotePort); s.destroy();}); s.on('timeout',()=>{console.log('BLOCKED:ETIMEDOUT'); s.destroy();}); s.on('error',e=>console.log('BLOCKED:'+e.code));"], { timeout: 8000 });
  return r.stdout.toString().trim() || 'no-output(status=' + r.status + ')';
});
// cloud metadata endpoint: must be unreachable at the namespace level.
probe('metadata', () => {
  const r = cp.spawnSync('node', ['-e', "require('http').get('http://169.254.169.254/latest/meta-data/', res=>{console.log('LEAK:'+res.statusCode); res.resume();}).on('error', e=>console.log('BLOCKED:'+e.code))"], { timeout: 5000 });
  return r.stdout.toString().trim() || 'no-output(status=' + r.status + ')';
});
// absolute path programs: read host-ish paths
probe('absolute_paths', () => {
  const tries = ['/etc/shadow', '/var/run/docker.sock', '/proc/1/cmdline', '/host', '/workspace', '/root'];
  const results = [];
  for (const p of tries) {
    try { results.push(p + ':' + (fs.readFileSync(p, 'utf8') || '').length); }
    catch (e) { results.push(p + ':BLOCKED:' + e.code); }
  }
  return results.join('|').slice(0, 300);
});
// docker socket existence
probe('docker_socket', () => (fs.existsSync('/var/run/docker.sock') ? 'PRESENT_ESCAPE' : 'BLOCKED:absent'));
// secret env: nothing credential-shaped in the environment
probe('env_secrets', () => {
  const bad = Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD|AEGISPI/.test(k));
  return bad.length === 0 ? 'CLEAN' : 'LEAK:' + bad.join(',');
});
// symlink escape: link to the container root, read through it
probe('symlink_escape', () => {
  try {
    fs.symlinkSync('/', '/job/work/root-link');
    const seen = fs.readdirSync('/job/work/root-link').slice(0, 20).join(',');
    return 'CONTAINER_LOCAL(' + seen + ')';
  } catch (e) { return 'BLOCKED:' + e.code; }
});
// TOCTOU against the runner's own input: the manifest the runner read is
// read-only at the mount level; rewriting it after the read must fail.
probe('toctou_input', () => {
  try { fs.writeFileSync('/job/input/manifest.json', '{"schemaVersion":1}'); return 'TAMPERED'; }
  catch (e) { return 'BLOCKED:' + e.code; }
});
// host canary: this path exists only OUTSIDE the container
probe('host_canary', () => {
  try { return 'ESCAPED:' + fs.readFileSync('/host-canary/secret.txt', 'utf8').slice(0, 30); }
  catch (e) { return 'BLOCKED:' + e.code; }
});
// acceptance tampering: the oracle file is host-side
probe('acceptance_file', () => {
  try { fs.writeFileSync('/oracle-acceptance.json', '{\\"passes\\":\\"attacker-owned\\"}'); return 'TAMPERED'; }
  catch (e) { return 'BLOCKED:' + e.code; }
});
// git -c: config-driven execution must genuinely RUN (git is present in the
// image) and stay inside the tmpfs. A missing git is GIT_ABSENT and the
// assertion below FAILS on it — an image without the tool proves nothing.
probe('git_c_execution', () => {
  try {
    const ver = cp.spawnSync('git', ['--version'], { timeout: 4000 });
    if (ver.status !== 0 || !/git version/i.test(((ver.stdout ?? '') + (ver.stderr ?? '')).toString())) {
      return 'GIT_ABSENT:' + ((ver.error && ver.error.code) || 'no-git-in-image');
    }
    fs.mkdirSync('/job/work/repo', { recursive: true });
    cp.spawnSync('git', ['init', '-q', '/job/work/repo'], { timeout: 8000 });
    // The in-sandbox execution: an alias landing INSIDE the bounded tmpfs.
    const inside = cp.spawnSync('git', ['-c', 'alias.probe=!touch /job/work/alias-ran', '-C', '/job/work/repo', 'probe'], { timeout: 8000 });
    const aliasRan = fs.existsSync('/job/work/alias-ran');
    // The escape attempt: the SAME config mechanism aimed OUTSIDE every mount.
    cp.spawnSync('git', ['-c', 'alias.esc=!touch /escape-marker', '-C', '/job/work/repo', 'esc'], { timeout: 8000 });
    const escapedMarker = fs.existsSync('/escape-marker');
    if (escapedMarker) return 'ESCAPED:/escape-marker-exists';
    return 'EXECUTED_IN_SANDBOX alias=' + aliasRan + ' run=' + inside.status;
  } catch (e) { return 'ERR:' + (e.code || String(e.message).slice(0, 40)); }
});
// env manipulation: a child with a hostile proxy env still cannot reach the
// local source. Runs BEFORE the fork storm.
probe('env_manipulation', () => {
  const r = cp.spawnSync('node', ['-e', "require('http').get({host:'${SOURCE_HOSTPORT.split(':')[0]}',port:${sourcePort},path:'/hit-via-proxy'}, res=>{console.log('LEAK:'+res.statusCode); res.resume();}).on('error', e=>console.log('BLOCKED:'+e.code))"], { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HTTPS_PROXY: 'http://192.0.2.2:3128' }, timeout: 6000 });
  const seen = ((r.stdout ?? '') + (r.stderr ?? '')).toString().trim();
  if (seen) return seen;
  return 'no-output(status=' + r.status + ',err=' + (r.error ? r.error.code : 'none') + ',sig=' + r.signal + ')';
});
// resource exhaustion LAST (it poisons the process table: killed-but-
// unreaped children hold the pids budget while the sync event loop is
// blocked, so anything running after this probe would see EAGAIN — itself
// a real measured behavior of the bound). Lightweight exec children: one
// process per spawn, no orphans.
probe('pids_exhaust', () => {
  const procs = [];
  for (let i = 0; i < 500; i += 1) {
    try {
      const p = cp.spawn('sh', ['-c', 'exec sleep 2']);
      p.on('error', () => {});
      if (p.pid === undefined) break;
      procs.push(p);
    } catch { break; }
  }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  return 'spawned=' + procs.length;
});
console.log(out.join('\\n'));
`;
}

const batteryRun = await runJobStyle([
  "--network", "none",
  "--init",
  "--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256",
  "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--tmpfs", "/job/work:rw,noexec,size=64m,mode=1777",
  "-v", `${join(ws.stateDir, "input")}:/job/input:ro`,
  EXECUTION_REF,
], { name: "aegispi-battery", outputDir: join(ws.stateDir, "output") });
const batteryOut = readFileSync(join(ws.stateDir, "output", "stdout.txt"), "utf8");
const batteryResult = readFileSync(join(ws.stateDir, "output", "result.json"), "utf8");
const batteryLines = Object.fromEntries(
  batteryOut.split("\n").filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1)];
  }),
);

suite.check(
  "escape-battery-direct-http-and-env-manipulation-blocked",
  /^BLOCKED:/.test(batteryLines.direct_http ?? "") && /^BLOCKED:/.test(batteryLines.env_manipulation ?? ""),
  `direct_http=${(batteryLines.direct_http ?? "none").slice(0, 40)} env_manipulation=${(batteryLines.env_manipulation ?? "none").slice(0, 40)}`,
);
suite.check(
  "escape-battery-no-egress-dns-blocked",
  /BLOCKED/.test(batteryLines.dns_ipv6 ?? ""),
  `dns_ipv6=${(batteryLines.dns_ipv6 ?? "none").slice(0, 60)}`,
);
suite.check(
  "escape-battery-host-ports-unreachable",
  /^BLOCKED:/.test(batteryLines.host_ports ?? ""),
  `host_ports=${(batteryLines.host_ports ?? "none").slice(0, 60)} (verdict from a real TCP connect to this suite's own listening source)`,
);
suite.check(
  "escape-battery-metadata-endpoint-unreachable",
  /^BLOCKED:/.test(batteryLines.metadata ?? ""),
  `metadata=${(batteryLines.metadata ?? "none").slice(0, 50)}`,
);
suite.check(
  "escape-battery-host-paths-and-socket-absent",
  (batteryLines.absolute_paths ?? "").includes("/var/run/docker.sock:BLOCKED") &&
    (batteryLines.absolute_paths ?? "").includes("/etc/shadow:BLOCKED") &&
    batteryLines.docker_socket === "BLOCKED:absent",
  `absolute_paths=${(batteryLines.absolute_paths ?? "none").slice(0, 120)} socket=${batteryLines.docker_socket}`,
);
suite.check(
  "escape-battery-toctou-input-readonly",
  /^BLOCKED:/.test(batteryLines.toctou_input ?? ""),
  `toctou_input=${(batteryLines.toctou_input ?? "none").slice(0, 40)} (the runner's manifest mount refuses a post-read rewrite)`,
);
suite.check(
  "escape-battery-no-secret-env-in-sandbox",
  batteryLines.env_secrets === "CLEAN",
  `env_secrets=${batteryLines.env_secrets}`,
);
suite.check(
  "escape-battery-symlink-stays-container-local",
  (batteryLines.symlink_escape ?? "").startsWith("CONTAINER_LOCAL"),
  `symlink_escape=${(batteryLines.symlink_escape ?? "none").slice(0, 80)}`,
);
suite.check(
  "escape-battery-host-canary-and-acceptance-unreachable",
  (batteryLines.host_canary ?? "").startsWith("BLOCKED") && (batteryLines.acceptance_file ?? "").startsWith("BLOCKED"),
  `host_canary=${batteryLines.host_canary} acceptance_file=${batteryLines.acceptance_file}`,
);
suite.check(
  "escape-battery-git-c-executes-and-stays-in-sandbox",
  (batteryLines.git_c_execution ?? "").startsWith("EXECUTED_IN_SANDBOX alias=true"),
  `git_c_execution=${(batteryLines.git_c_execution ?? "none").slice(0, 80)} (git genuinely present and executed; GIT_ABSENT would fail this check)`,
);
suite.check(
  "escape-battery-pids-limit-bounds-the-fork-storm",
  /^spawned=\d+$/.test(batteryLines.pids_exhaust ?? "") && Number((batteryLines.pids_exhaust ?? "spawned=999").split("=")[1]) <= 256,
  `pids_exhaust=${batteryLines.pids_exhaust} (limit 256; the few processes above the storm count are the runner and its reaper)`,
);
suite.check(
  "escape-battery-completed-with-evidence",
  JSON.parse(batteryResult).exitCode === 0,
  `battery exit=${JSON.parse(batteryResult).exitCode} run-exit=${batteryRun.code}`,
);
// The host canary file is untouched and the acceptance file still says
// host-owned: the strongest end-to-end statement of the whole battery.
const canaryUntouched = readFileSync(join(canaryDir, "secret.txt"), "utf8") === CANARY_TEXT;
const acceptanceUntouched = JSON.parse(readFileSync(join(ws.stateDir, "oracle-acceptance.json"), "utf8")).passes === "host-owned";
suite.check(
  "host-canary-and-oracle-untouched-after-battery",
  canaryUntouched && acceptanceUntouched,
  `canary intact=${canaryUntouched}; oracle intact=${acceptanceUntouched}`,
);

// ---------------------------------------------------------------------------
// The CONTROL container (audit F5 falsifier): same image, same caps, same
// read-only rootfs — ONLY the network differs (bridge + host-gateway). The
// direct-HTTP, host-port and DNS probes MUST report the leak here. If a
// probe cannot see reachability when there IS reachability, it is a
// tautology and the suite goes red above.
{
  const control = await dockerRunAsync([
    "run", "--rm",
    "--network", "bridge",
    "--add-host", "host.docker.internal:host-gateway",
    "--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--tmpfs", "/job/work:rw,noexec,size=16m,mode=1777",
    "--entrypoint", "node",
    EXECUTION_REF,
    "-e", `
const cp = require('child_process');
const out = [];
function probe(name, fn) { try { out.push(name + '=' + fn()); } catch (e) { out.push(name + '=ERR:' + (e.code || String(e.message).slice(0, 40))); } }
probe('control_direct', () => {
  const r = cp.spawnSync('node', ['-e', "require('http').get('http://${SOURCE_HOSTPORT}/hit-direct', res=>{console.log('CONNECTED:'+res.statusCode); res.resume();}).on('error', e=>console.log('NOT_REACHED:'+e.code))"], { timeout: 8000 });
  return r.stdout.toString().trim() || 'no-output(status=' + r.status + ')';
});
probe('control_ports', () => {
  const r = cp.spawnSync('node', ['-e', "const net=require('net'); const s=net.connect({host:'${SOURCE_HOSTPORT.split(':')[0]}',port:${sourcePort},timeout:3000}); s.on('connect',()=>{console.log('CONNECTED'); s.destroy();}); s.on('timeout',()=>{console.log('NOT_REACHED:ETIMEDOUT'); s.destroy();}); s.on('error',e=>console.log('NOT_REACHED:'+e.code));"], { timeout: 8000 });
  return r.stdout.toString().trim() || 'no-output(status=' + r.status + ')';
});
probe('control_dns', () => {
  const r = cp.spawnSync('node', ['-e', "require('dns').lookup('host.docker.internal', (e,a)=>{ console.log(e ? 'NOT_REACHED:'+e.code : 'RESOLVED:'+a); })"]);
  return r.stdout.toString().trim() || 'no-output';
});
console.log(out.join('\\n'));
`,
  ]);
  const lines = Object.fromEntries(
    control.out.split("\n").filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
  suite.check(
    "escape-probes-detect-reachability-under-bridge-control",
    /^CONNECTED:/.test(lines.control_direct ?? "") &&
      lines.control_ports === "CONNECTED" &&
      /^RESOLVED:/.test(lines.control_dns ?? ""),
    `direct=${(lines.control_direct ?? "none").slice(0, 30)} ports=${lines.control_ports} dns=${(lines.control_dns ?? "none").slice(0, 30)} — the probes can see a leak, so the BLOCKED verdicts above are falsifiable, not tautologies`,
  );
}

// ---------------------------------------------------------------------------
// The agent container boundary: read-only rootfs, only the proposals tmpfs
// is writable, no network, and the self-check still passes under those
// conditions. A model-side tool bypass has nothing to write THROUGH.
{
  const agentRun = dockerRun([
    "run", "--rm", "--network", "none",
    "--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--tmpfs", "/agent-work:rw,noexec,size=64m,mode=1777",
    "--entrypoint", "node",
    AGENT_REF,
    "-e", `
const fs = require('fs');
const out = [];
try { fs.writeFileSync('/workspace/escape.txt', 'x'); out.push('rootfs_write=ESCAPED'); }
catch (e) { out.push('rootfs_write=BLOCKED:' + e.code); }
try { fs.writeFileSync('/agent-work/proposal.json', '{}'); out.push('proposals_write=OK'); }
catch (e) { out.push('proposals_write=BLOCKED:' + e.code); }
try {
  const r = require('child_process').spawnSync('node', ['-e', "require('dns').lookup('example.com',(e)=>console.log(e?'BLOCKED:'+e.code:'LEAK'))"], { timeout: 4000 });
  out.push('dns=' + r.stdout.toString().trim());
} catch (e) { out.push('dns=ERR'); }
try { out.push('socket=' + (fs.existsSync('/var/run/docker.sock') ? 'PRESENT' : 'absent')); } catch (e) { out.push('socket=ERR'); }
console.log(out.join('\\n'));
`,
  ]);
  const lines = Object.fromEntries(
    agentRun.out.split("\n").filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
  suite.check(
    "agent-container-rootfs-readonly-proposals-only-no-network",
    lines.rootfs_write?.startsWith("BLOCKED") &&
      lines.proposals_write === "OK" &&
      lines.dns?.startsWith("BLOCKED") &&
      lines.socket === "absent",
    `rootfs=${lines.rootfs_write} proposals=${lines.proposals_write} dns=${lines.dns} socket=${lines.socket}`,
  );
}

// ---------------------------------------------------------------------------
// Acquisition download abuse (02 section 1: the downloader validates and
// never executes; 02 section 8: 上传/下载及编码重定向). The LOCAL source is
// reachable on every engine (host-gateway). A `fetch failed` reason means
// the SOURCE was unreachable and FAILS the case — it is never a policy
// refusal (audit F4). Redirects may only stay on the planned host unless
// the plan allowlists another name.

async function downloadCase(tag, entries) {
  const dir = join(ws.stateDir, "dl-" + tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "plan"), { recursive: true });
  mkdirSync(join(dir, "downloads"), { recursive: true });
  writeFileSync(
    join(dir, "plan", "plan.json"),
    JSON.stringify({ schemaVersion: 1, entries }) + "\n",
    "utf8",
  );
  const name = `aegispi-acq-${tag}`;
  const r = await runJobStyle([
    "--network", "bridge",
    "--add-host", "host.docker.internal:host-gateway",
    // A second host-gateway alias: a genuinely different NAME for the same
    // machine, so the redirect allowlist demo exercises name policy, not
    // container-local resolution.
    "--add-host", "allowlist-demo.host-gateway.local:host-gateway",
    "--cpus", "1", "--memory", "512m", "--memory-swap", "512m", "--pids-limit", "128",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "-v", `${join(dir, "plan")}:/plan:ro`,
    ACQUISITION_REF,
  ], { name, outputDir: join(dir, "downloads"), containerSrc: "/downloads" });
  let report = null;
  try {
    report = JSON.parse(readFileSync(join(dir, "downloads", "report.json"), "utf8"));
  } catch {}
  return { code: r.code, report };
}

// Good archive: extracts, report clean.
{
  const { code, report } = await downloadCase("good", [
    { url: `${SOURCE}/good.tar.gz`, destRelPath: "repo.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  const hello = existsSync(join(ws.stateDir, "dl-good", "downloads", "repo.tar.gz", "src", "hello.txt"));
  suite.check(
    "acquisition-good-archive-extracts",
    code === 0 && report?.failures === 0 && hello,
    `exit=${code} failures=${report?.failures} extracted=${hello}`,
  );
}

// Path traversal member: GNU tar refuses it BY NAME (or the walk rejects the
// tree) — a fetch failure is NOT this refusal and fails the case.
{
  const { code, report } = await downloadCase("traversal", [
    { url: `${SOURCE}/traversal.tar.gz`, destRelPath: "t.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  const reason = report?.results?.[0]?.reason ?? "";
  const escapeFile = existsSync(join(ws.stateDir, "dl-traversal", "escape.txt"));
  suite.check(
    "acquisition-refuses-path-traversal-members",
    code === 1 &&
      report?.failures === 1 &&
      !/fetch failed/.test(reason) &&
      /tar extract failed|extracted tree rejected/.test(reason) &&
      escapeFile === false,
    `exit=${code} reason=${reason.slice(0, 60)} escape-file-present=${escapeFile}`,
  );
}

// Escaping symlink: extracted, then rejected by the walk; the target never
// resolves outside.
{
  const { code, report } = await downloadCase("symlink", [
    { url: `${SOURCE}/symlink.tar.gz`, destRelPath: "s.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  const reason = report?.results?.[0]?.reason ?? "";
  suite.check(
    "acquisition-refuses-escaping-symlinks",
    code === 1 && report?.failures === 1 && !/fetch failed/.test(reason) && /symlink.*escapes/.test(reason),
    `exit=${code} reason=${reason.slice(0, 60)}`,
  );
}

// Device file member: refused either by GNU tar itself (mknod is not
// permitted for a cap-dropped non-root sandbox) or by the walk — both are
// the sandbox refusing a device node.
{
  const { code, report } = await downloadCase("device", [
    { url: `${SOURCE}/device.tar.gz`, destRelPath: "d.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  const reason = report?.results?.[0]?.reason ?? "";
  const devFile = existsSync(join(ws.stateDir, "dl-device", "downloads", "d.tar.gz", "dev-kmem"));
  suite.check(
    "acquisition-refuses-device-members",
    code === 1 &&
      report?.failures === 1 &&
      !/fetch failed/.test(reason) &&
      /Cannot mknod|device\/fifo\/socket/.test(reason) &&
      devFile === false,
    `exit=${code} reason=${reason.slice(0, 60)} dev-node-present=${devFile}`,
  );
}

// Gzip bomb: the DECOMPRESSED cap kills it before the disk is at risk.
{
  const { code, report } = await downloadCase("bomb", [
    { url: `${SOURCE}/bomb.tar.gz`, destRelPath: "b.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  const reason = report?.results?.[0]?.reason ?? "";
  suite.check(
    "acquisition-bounds-gzip-bombs-at-decompressed-size",
    code === 1 && report?.failures === 1 && !/fetch failed/.test(reason) && /decompressed size cap/.test(reason),
    `exit=${code} reason=${reason.slice(0, 60)}`,
  );
}

// Plain download above its size cap.
{
  const { code, report } = await downloadCase("oversize", [
    { url: `${SOURCE}/big.bin`, destRelPath: "big.bin", maxSizeBytes: 1024 * 1024, mode: "file" },
  ]);
  const reason = report?.results?.[0]?.reason ?? "";
  suite.check(
    "acquisition-enforces-download-size-cap",
    code === 1 && report?.failures === 1 && !/fetch failed/.test(reason) && /size cap/.test(reason),
    `exit=${code} reason=${reason.slice(0, 60)}`,
  );
}

// Redirect abuse: a cross-scheme redirect is refused; a redirect loop is
// refused; a redirect to a DIFFERENT host is refused unless the plan
// allowlists it.
{
  const { code, report } = await downloadCase("redirect-file", [
    { url: `${SOURCE}/redirect-file-scheme`, destRelPath: "r.txt", maxSizeBytes: 65536, mode: "file" },
  ]);
  const reason = report?.results?.[0]?.reason ?? "";
  suite.check(
    "acquisition-refuses-scheme-changing-redirects",
    code === 1 && report?.failures === 1 && !/fetch failed/.test(reason) && /scheme/.test(reason),
    `exit=${code} reason=${reason.slice(0, 60)}`,
  );
  const { code: loopCode, report: loopReport } = await downloadCase("redirect-loop", [
    { url: `${SOURCE}/redirect-loop-a`, destRelPath: "l.txt", maxSizeBytes: 65536, mode: "file" },
  ]);
  const loopReason = loopReport?.results?.[0]?.reason ?? "";
  suite.check(
    "acquisition-refuses-redirect-loops",
    loopCode === 1 && !/fetch failed/.test(loopReason) && /redirect/.test(loopReason),
    `exit=${loopCode} reason=${loopReason.slice(0, 60)}`,
  );
  // Cross-host redirect: refused by host policy, not by an unreachable target.
  const { code: crossCode, report: crossReport } = await downloadCase("redirect-cross-host", [
    { url: `${SOURCE}/redirect-cross-host`, destRelPath: "cross.txt", maxSizeBytes: 65536, mode: "file" },
  ]);
  const crossReason = crossReport?.results?.[0]?.reason ?? "";
  suite.check(
    "acquisition-refuses-cross-host-redirects",
    crossCode === 1 &&
      crossReport?.failures === 1 &&
      !/fetch failed/.test(crossReason) &&
      /allowed host set/.test(crossReason),
    `exit=${crossCode} reason=${crossReason.slice(0, 70)}`,
  );
  // The SAME redirect with the host explicitly allowlisted by the plan.
  const { code: okCrossCode, report: okCrossReport } = await downloadCase("redirect-allowlisted", [
    {
      url: `${SOURCE}/redirect-cross-host`,
      destRelPath: "via-allowlist.tar.gz",
      maxSizeBytes: 8 * 1024 * 1024,
      mode: "tar",
      allowedRedirectHosts: ["allowlist-demo.host-gateway.local"],
    },
  ]);
  const allowlisted = existsSync(join(ws.stateDir, "dl-redirect-allowlisted", "downloads", "via-allowlist.tar.gz", "src", "hello.txt"));
  suite.check(
    "acquisition-follows-plan-allowlisted-redirect-hosts",
    okCrossCode === 0 && okCrossReport?.failures === 0 && allowlisted,
    `exit=${okCrossCode} failures=${okCrossReport?.failures} extracted=${allowlisted} (allowlist-demo.host-gateway.local explicitly allowlisted by the host-generated plan)`,
  );
  // Same-host redirects stay followed.
  const { code: okCode, report: okReport } = await downloadCase("redirect-ok", [
    { url: `${SOURCE}/evil-redirect`, destRelPath: "via-redirect.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  suite.check(
    "acquisition-follows-same-host-http-redirects",
    okCode === 0 && okReport?.failures === 0,
    `exit=${okCode} failures=${okReport?.failures}`,
  );
}

// The F4 falsifier itself, codified: an UNREACHABLE source must never
// satisfy a refusal predicate. A dead port produces `fetch failed`, which
// the suite treats as a test-environment failure, not a security pass.
{
  const { code, report } = await downloadCase("dead-source", [
    { url: `http://host.docker.internal:9/traversal.tar.gz`, destRelPath: "dead.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  const reason = report?.results?.[0]?.reason ?? "";
  suite.check(
    "acquisition-dead-source-is-not-a-security-refusal",
    code === 1 && report?.failures === 1 && /fetch failed/.test(reason),
    `exit=${code} reason=${reason.slice(0, 60)} — recorded as DEAD SOURCE, never counted as traversal/redirect/limit refusal above`,
  );
}

server.close();

// ---------------------------------------------------------------------------
// Composition: the offline-job behaviors (execute/timeout/cancel, quota
// separation, orphan reaping) are part of this integration gate. Run the
// dedicated suite and count its verdict here too.
{
  const r = spawnSync(process.execPath, [join("evals", "phase3", "offline-jobs", "run.mjs")], {
    cwd: join(process.cwd()),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = ((r.stdout ?? "") + (r.stderr ?? "")).trim().split("\n").slice(-2).join(" | ");
  suite.check(
    "offline-jobs-suite-green-under-integration-gate",
    r.status === 0,
    `exit=${r.status} ${tail.slice(0, 120)}`,
  );
}

writeReport({
  suiteId: "security-integration",
  suite,
  label: "test:security:integration — 真实容器隔离与逃逸矩阵（02 §8 第二组；探针经 bridge 对照证伪）",
  extra: {
    dataSources:
      "真实 docker 容器（execution/agent/acquisition 按记录 manifest digest 运行）+ 本机一次性 HTTP 源（host.docker.internal 经 host-gateway，仅本机回环网关）+ bridge 对照容器（同镜像仅网络不同，证探针可见泄漏）；无模型调用、无真实外部写、无凭据入容器",
    images: { execution: EXECUTION_REF, agent: AGENT_REF, acquisition: ACQUISITION_REF },
  },
});
process.exit(suiteExit(suite, { label: "test:security:integration" }));
