// Container-side acquisition downloader (02 section 1: "下载器在单独低权限
// 隔离进程或容器中，只按宿主生成的repo/tag/SHA和lockfile拉取白名单对象，
// 不执行生命周期、构建或仓库程序").
// Contract with the host:
//   /plan/plan.json (ro mount, host-generated):
//     { schemaVersion, entries: [{
//         url,               http/https only, no embedded credentials
//         destRelPath,       must stay under /downloads
//         sha256?,           hex, verified when present
//         maxSizeBytes,      download cap (and cap for the decompressed tar)
//         mode,              "file" | "tar"
//         allowedRedirectHosts?,  hostnames a redirect may additionally
//                                  target; by default redirects may only
//                                  stay on the ORIGINAL host (audit F4:
//                                  a source must not aim the fetch at an
//                                  arbitrary third-party host)
//     }] }
//   /downloads (rw mount): artifacts land here, plus report.json.
// The downloader never executes anything it fetched. Archive mode first
// bounds the DECOMPRESSED size (gzip bomb protection), extracts with GNU
// tar, then walks the extracted tree and rejects devices, fifos/sockets and
// any symlink whose target escapes the extraction root.

import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createGunzip } from "node:zlib";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const PLAN_PATH = "/plan/plan.json";
const OUT_ROOT = "/downloads";
const REPORT_PATH = join(OUT_ROOT, "report.json");
const MAX_REDIRECTS = 5;
const MAX_ENTRIES = 20000;
const MAX_DEPTH = 64;

export function parsePlan(raw) {
  let p;
  try {
    p = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `plan is not valid JSON: ${e.message}` };
  }
  if (p === null || typeof p !== "object" || Array.isArray(p)) {
    return { ok: false, reason: "plan must be a JSON object" };
  }
  if (p.schemaVersion !== 1) {
    return { ok: false, reason: `unsupported plan schemaVersion ${JSON.stringify(p.schemaVersion)}` };
  }
  if (!Array.isArray(p.entries) || p.entries.length === 0 || p.entries.length > 100) {
    return { ok: false, reason: "entries must be a non-empty array (<=100 items)" };
  }
  for (const e of p.entries) {
    if (e === null || typeof e !== "object") {
      return { ok: false, reason: "each entry must be an object" };
    }
    let u;
    try {
      u = new URL(e.url);
    } catch {
      return { ok: false, reason: `entry url ${JSON.stringify(e.url)} is not a URL` };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: `entry url scheme ${u.protocol} is not http/https` };
    }
    if (u.username !== "" || u.password !== "") {
      return { ok: false, reason: "entry url embeds credentials; the downloader never carries credentials" };
    }
    if (typeof e.destRelPath !== "string" || e.destRelPath.length === 0) {
      return { ok: false, reason: "destRelPath must be a non-empty string" };
    }
    const pathSegments = e.destRelPath.split(/[\\/]/);
    if (isAbsolute(e.destRelPath) || pathSegments.some((s) => s === "" || s === "." || s === "..")) {
      return { ok: false, reason: `destRelPath ${JSON.stringify(e.destRelPath)} escapes the downloads root` };
    }
    if (e.mode !== "file" && e.mode !== "tar") {
      return { ok: false, reason: "mode must be \"file\" or \"tar\"" };
    }
    if (!Number.isInteger(e.maxSizeBytes) || e.maxSizeBytes <= 0 || e.maxSizeBytes > 1024 * 1024 * 1024) {
      return { ok: false, reason: "maxSizeBytes must be a positive integer (<= 1 GiB)" };
    }
    if (e.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(e.sha256)) {
      return { ok: false, reason: "sha256 must be 64 lowercase hex chars" };
    }
    if (e.allowedRedirectHosts !== undefined) {
      if (
        !Array.isArray(e.allowedRedirectHosts) ||
        e.allowedRedirectHosts.length === 0 ||
        e.allowedRedirectHosts.length > 20
      ) {
        return { ok: false, reason: "allowedRedirectHosts must be an array of 1..20 hostnames when present" };
      }
      for (const h of e.allowedRedirectHosts) {
        if (typeof h !== "string" || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(h) || h.length > 253) {
          return { ok: false, reason: `allowedRedirectHosts entry ${JSON.stringify(h)} is not a bare hostname` };
        }
      }
    }
  }
  return { ok: true, plan: p };
}

export function inside(root, path) {
  const r = resolve(root);
  const rel = resolve(path);
  return rel === r || rel.startsWith(r + sep);
}

function parseIpv4Int(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let val = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    val = (val * 256 + n) >>> 0;
  }
  return val;
}

function isDisallowedIp(rawIp) {
  const ip = String(rawIp ?? "").replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const ver = isIP(ip);
  if (ver === 4) {
    const n = parseIpv4Int(ip);
    if (n === null) return true;
    const a = (n >>> 24) & 0xff;
    const b = (n >>> 16) & 0xff;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (ver === 6) {
    if (ip === "::" || ip === "::1") return true;
    if (ip.startsWith("::ffff:")) {
      const rest = ip.slice("::ffff:".length);
      if (isIP(rest) === 4) return isDisallowedIp(rest);
      const hexParts = rest.split(":");
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          return isDisallowedIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
        }
      }
      return true;
    }
    const firstWord = parseInt(ip.split(":")[0] || "0", 16);
    if ((firstWord & 0xfe00) === 0xfc00) return true;
    if ((firstWord & 0xffc0) === 0xfe80) return true;
    if ((firstWord & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

function isLocalGatewayHttpTarget(u) {
  if (u.protocol !== "http:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "host.docker.internal" ||
    host.endsWith(".host-gateway.local") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost"
  );
}

function requestWithPinnedLookup(u, { timeoutMs = 30000 } = {}) {
  return new Promise((resolveReq, rejectReq) => {
    const isHttps = u.protocol === "https:";
    const allowPrivate = isLocalGatewayHttpTarget(u);
    const fn = isHttps ? httpsRequest : httpRequest;
    const hostClean = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostClean) !== 0 && !allowPrivate && isDisallowedIp(hostClean)) {
      const err = new Error(`refused non-public IP address ${hostClean}`);
      err.isPolicyBlock = true;
      rejectReq(err);
      return;
    }
    const safeLookup = (hostname, opts, cb) => {
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      if (isIP(hostname) !== 0) {
        if (!allowPrivate && isDisallowedIp(hostname)) {
          const err = new Error(`refused non-public IP address ${hostname}`);
          err.isPolicyBlock = true;
          cb(err);
          return;
        }
        if (opts?.all) cb(null, [{ address: hostname, family: isIP(hostname) }]);
        else cb(null, hostname, isIP(hostname));
        return;
      }
      dnsLookup(hostname, { all: true })
        .then((addrs) => {
          if (!addrs || addrs.length === 0) {
            cb(Object.assign(new Error(`DNS returned no addresses for ${hostname}`), { code: "ENOTFOUND" }));
            return;
          }
          if (!allowPrivate) {
            const bad = addrs.find((a) => isDisallowedIp(a.address));
            if (bad) {
              const err = new Error(`refused non-public IP ${bad.address} resolved for ${hostname}`);
              err.isPolicyBlock = true;
              cb(err);
              return;
            }
          }
          if (opts?.all) cb(null, addrs);
          else cb(null, addrs[0].address, addrs[0].family);
        })
        .catch((err) => cb(err));
    };

    const req = fn(
      {
        protocol: u.protocol,
        hostname: hostClean,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: "GET",
        lookup: safeLookup,
        timeout: timeoutMs,
      },
      (res) => resolveReq(res),
    );
    req.on("timeout", () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on("error", rejectReq);
    req.end();
  });
}

// Follows redirects manually so every hop stays http/https, prevents https->http
// downgrade and same-host cross-port jumps, blocks non-public IPs atomically in
// socket lookup, and restricts redirects to explicit allowedRedirectHosts.
export async function fetchTo(url, destPath, { maxSizeBytes, sha256, allowedRedirectHosts = [], timeoutMs = 60000 } = {}) {
  const original = new URL(url);
  const allowedNames = new Set(allowedRedirectHosts.map((h) => String(h).toLowerCase()));
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: `redirect changed scheme to ${u.protocol}` };
    }
    if (original.protocol === "https:" && u.protocol !== "https:") {
      return { ok: false, reason: `redirect downgraded scheme from https: to ${u.protocol}` };
    }
    if (u.username !== "" || u.password !== "") {
      return { ok: false, reason: "redirect target embeds credentials; the downloader never carries credentials" };
    }
    const sameOriginHost = u.host === original.host;
    const sameHostnameOtherPort = u.hostname === original.hostname && u.host !== original.host;
    if (sameHostnameOtherPort || (!sameOriginHost && !allowedNames.has(u.hostname.toLowerCase()))) {
      return {
        ok: false,
        reason: `redirect host ${u.host} is not in the allowed host set (original ${original.host}${allowedRedirectHosts.length > 0 ? ` + ${allowedRedirectHosts.join(",")}` : ""})`,
      };
    }
    let res;
    try {
      res = await requestWithPinnedLookup(u, { timeoutMs });
    } catch (e) {
      return {
        ok: false,
        reason: e?.isPolicyBlock ? e.message : `fetch failed (${e?.code ?? e?.message ?? e})`,
      };
    }
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const loc = res.headers.location;
      res.destroy();
      if (!loc) return { ok: false, reason: `redirect ${status} without Location` };
      let next;
      try {
        next = new URL(Array.isArray(loc) ? loc[0] : loc, u);
      } catch {
        return { ok: false, reason: `redirect Location ${JSON.stringify(loc)} is not a URL` };
      }
      current = next.href;
      continue;
    }
    if (status < 200 || status >= 300) {
      res.destroy();
      return { ok: false, reason: `HTTP ${status} fetching ${u.href}` };
    }
    mkdirSync(dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.part`;
    const hash = createHash("sha256");
    let bytes = 0;
    let capped = false;
    let streamErr = null;
    const out = createWriteStream(tmpPath);
    out.on("error", (err) => {
      streamErr = err;
    });
    try {
      for await (const value of res) {
        if (streamErr) break;
        bytes += value.byteLength;
        if (bytes > maxSizeBytes) {
          capped = true;
          res.destroy();
          break;
        }
        hash.update(value);
        if (!out.write(value)) {
          await new Promise((r) => out.once("drain", r));
        }
      }
      if (!capped && !streamErr && !res.complete) {
        streamErr = new Error("response truncated before HTTP completion");
      }
    } catch (err) {
      streamErr = err;
    } finally {
      out.end();
      await new Promise((r) => out.on("close", r));
    }
    if (capped) {
      rmSync(tmpPath, { force: true });
      return { ok: false, reason: `size cap exceeded: >${maxSizeBytes} bytes` };
    }
    if (streamErr) {
      rmSync(tmpPath, { force: true });
      return { ok: false, reason: `fetch failed (${streamErr.message})` };
    }
    const actualSha256 = hash.digest("hex");
    if (sha256 && actualSha256 !== sha256) {
      rmSync(tmpPath, { force: true });
      return { ok: false, reason: `sha256 mismatch: expected ${sha256}` };
    }
    renameSync(tmpPath, destPath);
    return { ok: true, bytes, sha256: actualSha256 };
  }
  return { ok: false, reason: `more than ${MAX_REDIRECTS} redirects` };
}

// Bounds the DECOMPRESSED byte count before tar ever sees the archive, so a
// gzip bomb dies at the cap instead of at the disk.
export function boundedGunzip(archivePath, outPath, { maxSizeBytes }) {
  let bytes = 0;
  let capped = false;
  const gate = new Transform({
    transform(chunk, enc, cb) {
      bytes += chunk.byteLength;
      if (bytes > maxSizeBytes) {
        capped = true;
        cb(new Error(`decompressed size exceeds cap ${maxSizeBytes}`));
        return;
      }
      cb(null, chunk);
    },
  });
  return pipeline(createReadStream(archivePath), createGunzip(), gate, createWriteStream(outPath))
    .then(() => {
      if (capped) {
        rmSync(outPath, { force: true });
        return { ok: false, reason: `decompressed size cap exceeded: >${maxSizeBytes} bytes` };
      }
      return { ok: true, bytes };
    })
    .catch((e) => {
      rmSync(outPath, { force: true });
      if (capped) return { ok: false, reason: `decompressed size cap exceeded: >${maxSizeBytes} bytes` };
      return { ok: false, reason: `gunzip failed: ${e.message}` };
    });
}

export function walkVerify(root, { maxEntries, maxDepth, maxTotalBytes }) {
  const problems = [];
  let entries = 0;
  let totalBytes = 0;
  const visit = (dir, depth) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch (e) {
      problems.push(`cannot read directory ${dir}: ${e.message}`);
      return;
    }
    for (const name of names) {
      entries += 1;
      if (entries > maxEntries) {
        problems.push(`more than ${maxEntries} entries`);
        return;
      }
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p);
      } catch (e) {
        problems.push(`cannot lstat ${p}: ${e.message}`);
        continue;
      }
      if (st.isSymbolicLink()) {
        let target;
        try {
          target = readlinkSync(p);
        } catch (e) {
          problems.push(`cannot readlink ${p}: ${e.message}`);
          continue;
        }
        const resolved = resolve(dirname(p), target);
        if (!inside(root, resolved)) {
          problems.push(`symlink ${p} escapes the extraction root -> ${target}`);
        }
        continue;
      }
      if (st.isDirectory()) {
        if (depth + 1 > maxDepth) {
          problems.push(`depth exceeds ${maxDepth} at ${p}`);
          continue;
        }
        visit(p, depth + 1);
        if (entries > maxEntries) return;
      } else if (st.isFile()) {
        totalBytes += st.size;
        if (totalBytes > maxTotalBytes) {
          problems.push(`extracted bytes exceed ${maxTotalBytes}`);
        }
      } else {
        problems.push(`non-regular, non-directory entry at ${p} (device/fifo/socket)`);
      }
    }
  };
  visit(root, 1);
  return { problems: [...new Set(problems)].slice(0, 20), entries, totalBytes };
}

function runTar(args) {
  return new Promise((resolveRun) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    child.on("close", (code) => resolveRun({ code, stderr }));
    child.on("error", (e) => resolveRun({ code: 127, stderr: e.message }));
  });
}

export async function extractTar(archivePath, destDir, { maxSizeBytes }) {
  const plainTar = `${archivePath}.tar`;
  const bounded = await boundedGunzip(archivePath, plainTar, { maxSizeBytes });
  if (!bounded.ok) return bounded;
  mkdirSync(destDir, { recursive: true });
  // GNU tar itself refuses absolute members and `..` members; the walk below
  // verifies what actually landed on disk.
  const ex = await runTar(["-xf", plainTar, "-C", destDir, "--no-same-owner", "--no-same-permissions"]);
  rmSync(plainTar, { force: true });
  if (ex.code !== 0) {
    return {
      ok: false,
      reason: `tar extract failed (exit ${ex.code}): ${ex.stderr.trim().split("\n").slice(0, 3).join(" | ")}`,
    };
  }
  const walk = walkVerify(destDir, { maxEntries: MAX_ENTRIES, maxDepth: MAX_DEPTH, maxTotalBytes: maxSizeBytes });
  if (walk.problems.length > 0) {
    rmSync(destDir, { recursive: true, force: true });
    return { ok: false, reason: `extracted tree rejected: ${walk.problems.join("; ")}` };
  }
  return { ok: true, entries: walk.entries, totalBytes: walk.totalBytes };
}

export async function main() {
  mkdirSync(OUT_ROOT, { recursive: true });
  if (!existsSync(PLAN_PATH)) {
    console.error(`downloader: no plan at ${PLAN_PATH}; nothing to do`);
    process.exit(126);
  }
  const parsed = parsePlan(readFileSync(PLAN_PATH, "utf8"));
  if (!parsed.ok) {
    console.error(`downloader: refusing plan: ${parsed.reason}`);
    writeFileSync(REPORT_PATH, JSON.stringify({ error: parsed.reason, refused: true }) + "\n", "utf8");
    process.exit(126);
  }
  const results = [];
  let failures = 0;
  for (const entry of parsed.plan.entries) {
    const dest = join(OUT_ROOT, entry.destRelPath);
    if (!inside(OUT_ROOT, dest)) {
      results.push({ destRelPath: entry.destRelPath, ok: false, reason: "destination escapes the downloads root" });
      failures += 1;
      continue;
    }
    try {
      if (entry.mode === "tar") {
        const archive = `${dest}.tar.gz`;
        const got = await fetchTo(entry.url, archive, {
          maxSizeBytes: entry.maxSizeBytes,
          sha256: entry.sha256,
          allowedRedirectHosts: entry.allowedRedirectHosts,
        });
        if (!got.ok) {
          results.push({ destRelPath: entry.destRelPath, ok: false, reason: got.reason });
          failures += 1;
          continue;
        }
        const ex = await extractTar(archive, dest, { maxSizeBytes: entry.maxSizeBytes });
        rmSync(archive, { force: true });
        results.push({
          destRelPath: entry.destRelPath,
          ok: ex.ok,
          reason: ex.ok ? undefined : ex.reason,
          entries: ex.entries,
          totalBytes: ex.totalBytes,
          downloadedBytes: got.bytes,
          sha256: got.sha256,
        });
        if (!ex.ok) failures += 1;
      } else {
        const got = await fetchTo(entry.url, dest, {
          maxSizeBytes: entry.maxSizeBytes,
          sha256: entry.sha256,
          allowedRedirectHosts: entry.allowedRedirectHosts,
        });
        results.push({
          destRelPath: entry.destRelPath,
          ok: got.ok,
          reason: got.ok ? undefined : got.reason,
          bytes: got.bytes,
          sha256: got.sha256,
        });
        if (!got.ok) failures += 1;
      }
    } catch (e) {
      results.push({ destRelPath: entry.destRelPath, ok: false, reason: `unexpected: ${e.message}` });
      failures += 1;
    }
  }
  const report = {
    schemaVersion: 1,
    finishedAt: Date.now(),
    entries: parsed.plan.entries.length,
    failures,
    results,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report) + "\n", "utf8");
  console.log(`downloader: ${report.entries - failures}/${report.entries} entries ok; report at ${REPORT_PATH}`);
  process.exit(failures > 0 ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("downloader.mjs") && !process.env.AEGISPI_DOWNLOADER_IMPORT_ONLY) {
  main();
}
