// test:ingress-telegram:real — the REAL read-only Telegram acceptance
// (02 CP1; handoff section 2.7), separated from the local deterministic
// suite so it can never masquerade as green without credentials (audit F7).
//
// Exit codes are distinct by contract:
//   0   real read-only verification PASSED (getMe + getUpdates over the
//       owner-authorized bot token, no sendMessage exists, no offset is
//       confirmed, queue only read)
//   1   a real check FAILED (the source answered but broke a contract)
//   3   NOT VERIFIED — no TELEGRAM_BOT_TOKEN on this machine. This is not a
//       skip dressed as a pass: the acceptance is explicitly UNACCEPTED
//       until the owner-authorized source is configured.
//   4   REFUSED — AEGISPI_ALLOW_REAL_TELEGRAM_READ is not set. The C-item
//       authorization ledger is CLOSED ("任何重跑即需新授权"), and the
//       presence of a token on this machine is not an authorization
//       (2026-11-22 incident: an unguarded re-run read the queue once
//       against a closed ledger — the guard below now makes that
//       impossible without an explicit opt-in).
//
// `--simulate-no-token` drills the refusal path on any machine: with the
// token present it behaves exactly like a token-less machine; on a machine
// with no token it reports that machine's real state (the flag never
// claims a token exists). Both forms must exit 3.
//
// The bot token transits only this process and the machine's own configured
// proxy. It is never printed, logged or committed; all captured output is
// scrubbed against the live value before it is written anywhere.

import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import {
  lockedNodeGuard,
  makeSuite,
  makeWorkspace,
  writeReport,
} from "../lib/harness.mjs";
import { loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent } from "../../../apps/daemon/src/ingress.mjs";
import { createTelegramPullAdapter } from "../../../apps/daemon/src/ingress-telegram.mjs";

lockedNodeGuard();

// The authorization ledger is closed: refuse BEFORE reading .env unless
// the owner explicitly opts this run in (the same guard pattern as
// model-real / repo-observe-real / triage-real).
if (process.env.AEGISPI_ALLOW_REAL_TELEGRAM_READ !== "1") {
  console.error("=== test:ingress-telegram:real — REFUSED (exit 4) ===");
  console.error("AEGISPI_ALLOW_REAL_TELEGRAM_READ is not set; the C-item authorization ledger is closed and re-running the real read needs a new owner authorization.");
  process.exit(4);
}

const suite = makeSuite("ingress-telegram-real");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const simulateNoToken = process.argv.includes("--simulate-no-token");

function readEnv(name) {
  try {
    const txt = readFileSync(join(repoRoot, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return undefined;
}

const configuredToken = readEnv("TELEGRAM_BOT_TOKEN");
const token = simulateNoToken ? undefined : configuredToken;
const tokenPresentOnHost = configuredToken !== undefined;

if (!token) {
  console.error("");
  console.error("=== test:ingress-telegram:real — NOT VERIFIED (exit 3) ===");
  console.error(simulateNoToken
    ? tokenPresentOnHost
      ? "TELEGRAM_BOT_TOKEN 存在于本机，但本次以 --simulate-no-token 演练缺凭据路径：真实只读验收未执行，本条不冒充通过。"
      : "本机 .env 本就未配置 TELEGRAM_BOT_TOKEN；--simulate-no-token 在这台机器上演练的是真实缺凭据状态：真实只读验收未执行，本条不冒充通过。"
    : "TELEGRAM_BOT_TOKEN 未配置于本机 .env；真实只读验收未执行（未验收，非跳过冒充通过）。需主人授权的测试源；本地确定性检查在 test:ingress-telegram。");
  console.error("");
  process.exit(3);
}

const scrub = (s) => String(s).split(token).join("***");

function parseProxy(s) {
  const withoutScheme = String(s).replace(/^https?:\/\//, "");
  const [host, port] = withoutScheme.split(":");
  const p = Number(port);
  return host && Number.isFinite(p) ? { host, port: p } : null;
}
function winInetProxy() {
  try {
    const reg = (value) =>
      spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", value], { encoding: "utf8" });
    const enable = reg("ProxyEnable");
    if (enable.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(enable.stdout)) return null;
    const server = reg("ProxyServer");
    const m = (server.stdout ?? "").match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    return m ? parseProxy(m[1]) : null;
  } catch {
    return null;
  }
}
const proxy =
  parseProxy(
    process.env.AEGISPI_TG_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      "",
  ) || winInetProxy();

class TunnelAgent extends HttpsAgent {
  constructor(proxyHost, proxyPort) {
    super({ keepAlive: false });
    this.proxyHost = proxyHost;
    this.proxyPort = proxyPort;
  }
  createConnection(options, callback) {
    const { host, port, servername } = options;
    const sock = netConnect(this.proxyPort, this.proxyHost);
    let settled = false;
    const done = (err, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        sock.destroy();
        callback(err);
      } else {
        callback(null, socket);
      }
    };
    const timer = setTimeout(() => done(new Error("proxy CONNECT timeout (15s)")), 15000);
    sock.once("connect", () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let head = "";
    const onData = (chunk) => {
      head += chunk.toString("latin1");
      const idx = head.indexOf("\r\n\r\n");
      if (idx === -1) {
        if (head.length > 8192) done(new Error("proxy CONNECT response header too large"));
        return;
      }
      sock.off("data", onData);
      const statusLine = head.slice(0, head.indexOf("\r\n"));
      if (!/\s200\s/.test(` ${statusLine} `)) {
        done(new Error(`proxy CONNECT refused: ${statusLine}`));
        return;
      }
      const rest = Buffer.from(head.slice(idx + 4), "latin1");
      if (rest.length > 0) sock.unshift(rest);
      const tls = tlsConnect({ socket: sock, servername: servername || host });
      tls.once("error", (e) => done(e));
      done(null, tls);
    };
    sock.on("data", onData);
    sock.once("error", (e) => done(e));
  }
}

// Captured so the suite can ASSERT on the outgoing request shape; every
// printed byte passes through scrub() first.
const capturedUrls = [];
async function tunnelFetch(url) {
  capturedUrls.push(String(url));
  const body = await new Promise((resolve, reject) => {
    const agent = proxy ? new TunnelAgent(proxy.host, proxy.port) : undefined;
    const req = httpsRequest(url, { method: "GET", agent }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.setTimeout(30000, () => req.destroy(new Error("request timeout (30s)")));
    req.on("error", reject);
    req.end();
  });
  return {
    status: body.status,
    json: async () => {
      try {
        return JSON.parse(body.text);
      } catch {
        throw new Error(`non-JSON response (status ${body.status})`);
      }
    },
  };
}

let getMeError = null;
let me = null;
try {
  const adapter = createTelegramPullAdapter({ token, fetchImpl: tunnelFetch });
  me = await adapter.getMe();
} catch (e) {
  getMeError = e;
}
suite.check(
  "authorized-telegram-identity-readable",
  getMeError === null && me?.is_bot === true,
  getMeError ? scrub(getMeError.message).slice(0, 100) : `bot @${me.username} (id masked)`,
);

let updatesError = null;
let updates = null;
try {
  const adapter = createTelegramPullAdapter({ token, fetchImpl: tunnelFetch });
  updates = await adapter.getUpdates({ limit: 1, timeout: 0 });
} catch (e) {
  updatesError = e;
}
const noOffsetParam = capturedUrls.every((u) => !/[?&]offset=/.test(u));
suite.check(
  "authorized-telegram-updates-readable-readonly",
  updatesError === null && Array.isArray(updates) && noOffsetParam,
  updatesError
    ? scrub(updatesError.message).slice(0, 100)
    : `queue read returned ${updates.length} update(s); offset-param-present=${!noOffsetParam} (nothing consumed, nothing confirmed)`,
);

if (Array.isArray(updates) && updates.length > 0) {
  const adapter = createTelegramPullAdapter({ token, fetchImpl: tunnelFetch });
  const ws = makeWorkspace("ingress-real-update");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const mapped = adapter.mapUpdate(updates[0]);
  if (mapped.mappable) {
    const received = receiveEvent(db, ws.stateDir, { ...mapped.event, now: Date.now(), verdict: "OBSERVE", policyVersion: "pv1", priority: 0 });
    suite.check(
      "real-update-maps-into-durable-ingress-observe-only",
      received.duplicate === false,
      `update ${updates[0].update_id} mapped; verdict OBSERVE (no automatic action)`,
    );
  } else {
    suite.note("real-update-unmappable", scrub(mapped.reason));
  }
  db.close();
} else {
  suite.note("real-queue-empty", "平台队列当前无待读更新；只读调用已实证，未伪造事件");
}

writeReport({
  suiteId: "ingress-telegram-real",
  suite,
  label: "test:ingress-telegram:real — 真实只读 Telegram 验收（getMe/getUpdates；零发送、零 offset 确认）",
  extra: {
    dataSources: `主人授权 bot token 的只读 api.telegram.org 调用（getMe/getUpdates，无 sendMessage，无 offset 确认），经本机代理出网；输出全程脱敏；无付费模型调用；simulate-no-token=${simulateNoToken}`,
  },
});
const { pass, fail } = suite.counts;
console.log(`\n=== test:ingress-telegram:real: ${pass} pass, ${fail} fail, ${pass + fail} judged ===`);
process.exit(fail > 0 ? 1 : 0);
