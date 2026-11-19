// test:ingress-telegram — Phase 3 real-source ingress drill (02 CP1, 04
// Phase 3: "建立平台沙盒适配器测试，不向真实同事或公开仓库发送测试消息。
// 确认凭据生命周期").
//
// The authorized test source is the owner's own bot (Phase 1 owner-side
// prep; read-only precedent: getMe/getChat). This suite:
//   1. fail-closed without a token (refuses BEFORE any network call)
//   2. fail-closed after credential-slot revocation
//   3. maps a recorded update fixture into the durable ingress with
//      provider-event-id dedup (deterministic, local DB)
//   4. performs REAL read-only calls: getMe + getUpdates(limit=1, timeout=0)
//      — no sendMessage exists in the adapter at all, no offset is ever
//      confirmed, the queue is only read
// The bot token transits only this process and the machine's own configured
// proxy (same path as Phase 1). It is never printed, logged or committed;
// all captured output is scrubbed.

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
  suiteExit,
  writeReport,
} from "../lib/harness.mjs";
import { loadCanonicalSchema, migrate } from "../../../apps/daemon/src/db/migrate.mjs";
import { openDatabase } from "../../../apps/daemon/src/db/connect.mjs";
import { receiveEvent } from "../../../apps/daemon/src/ingress.mjs";
import {
  createTelegramPullAdapter,
  TelegramTokenMissing,
} from "../../../apps/daemon/src/ingress-telegram.mjs";
import { createCredentialService } from "../../../apps/daemon/src/credentials.mjs";

lockedNodeGuard();

const suite = makeSuite("ingress-telegram");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

const token = readEnv("TELEGRAM_BOT_TOKEN");

// ---------------------------------------------------------------------------
// 1. Fail-closed: no token, no network call, no guessing.
{
  let refused = null;
  try {
    createTelegramPullAdapter({ token: null, fetchImpl: fetch });
  } catch (e) {
    refused = e;
  }
  suite.check(
    "pull-adapter-refuses-without-token",
    refused instanceof TelegramTokenMissing,
    `-> ${refused?.message?.slice(0, 60)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Credential-slot lifecycle backs the adapter: revocation refuses.
{
  const ws = makeWorkspace("ingress-creds");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  process.env.AEGISPI_TEST_TG_TOKEN = "drill-token-value-not-printed";
  const creds = createCredentialService(db, { now: () => Date.now() });
  creds.registerSlot({ slot: "im.telegram", purpose: "im", source: "telegram", envName: "AEGISPI_TEST_TG_TOKEN", now: Date.now() });
  const live = creds.resolve("im.telegram");
  let revokedRefusal = null;
  creds.revokeSlot({ slot: "im.telegram", reason: "revocation drill", now: Date.now() });
  const afterRevoke = creds.resolve("im.telegram");
  try {
    createTelegramPullAdapter({ token: afterRevoke.ok ? afterRevoke.value : null, fetchImpl: fetch });
  } catch (e) {
    revokedRefusal = e;
  }
  const auditText = db.prepare("SELECT details_json FROM audit_log").all().map((r) => r.details_json).join("\n");
  suite.check(
    "revoked-credential-slot-refuses-pull-adapter",
    live.ok === true && afterRevoke.ok === false && revokedRefusal instanceof TelegramTokenMissing,
    `resolve before=${live.ok} after revoke=${afterRevoke.ok} (${afterRevoke.reason?.slice(0, 40)})`,
  );
  suite.check("drill-token-never-reaches-audit", !auditText.includes("drill-token-value-not-printed"), "audit rows carry slot names only");
  delete process.env.AEGISPI_TEST_TG_TOKEN;
  db.close();
}

// ---------------------------------------------------------------------------
// 3. Recorded fixture -> durable ingress with provider-event-id dedup.
{
  const ws = makeWorkspace("ingress-mapping");
  mkdirSync(join(ws.stateDir, "db"), { recursive: true });
  const db = openDatabase(ws.dbPath);
  migrate(db, loadCanonicalSchema());
  const adapter = createTelegramPullAdapter({ token: "fixture-token", fetchImpl: fetch });
  const fixture = {
    update_id: 88001,
    message: {
      message_id: 1,
      from: { id: 6101, is_bot: false, first_name: "Owner" },
      chat: { id: 6101, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: "authorized test fixture",
    },
  };
  const mapped = adapter.mapUpdate(fixture);
  const first = receiveEvent(db, ws.stateDir, { ...mapped.event, now: Date.now(), verdict: "ADMIT", policyVersion: "pv1", priority: 5 });
  const second = receiveEvent(db, ws.stateDir, { ...mapped.event, now: Date.now() + 10, verdict: "ADMIT", policyVersion: "pv1", priority: 5 });
  const rows = db.prepare("SELECT count(*) c FROM inbox WHERE source='telegram' AND source_event_id='88001'").get().c;
  suite.check(
    "telegram-update-maps-and-dedups-by-update-id",
    mapped.mappable === true && first.duplicate === false && second.duplicate === true && rows === 1,
    `mappable=${mapped.mappable} first=${first.duplicate} second=${second.duplicate} rows=${rows}`,
  );
  const unmappable = adapter.mapUpdate({ update_id: 88002 });
  suite.check("non-message-update-refused-honestly", unmappable.mappable === false, `-> ${unmappable.reason}`);
  db.close();
}

// ---------------------------------------------------------------------------
// 4. REAL read-only calls through the authorized token. api.telegram.org is
// not directly reachable from this network (Phase 1 evidence/07); the same
// proxy-tunnel path is reused. No sendMessage exists; no offset confirmed.
{
  if (!token) {
    suite.note("real-telegram-read-skipped", "TELEGRAM_BOT_TOKEN 未配置于本机 .env；真实只读接入需要主人授权的测试源（失败关闭，不跳过冒充通过）");
  } else {
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
    const tunnelFetch = async (url) => {
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
    };
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
      getMeError ? scrub(getMeError.message).slice(0, 80) : `bot @${me.username} (id masked)`,
    );
    let updatesError = null;
    let updates = null;
    try {
      const adapter = createTelegramPullAdapter({ token, fetchImpl: tunnelFetch });
      updates = await adapter.getUpdates({ limit: 1, timeout: 0 });
    } catch (e) {
      updatesError = e;
    }
    suite.check(
      "authorized-telegram-updates-readable-readonly",
      updatesError === null && Array.isArray(updates),
      updatesError ? scrub(updatesError.message).slice(0, 80) : `queue read returned ${updates.length} update(s), nothing consumed`,
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
        suite.note("real-update-unmappable", mapped.reason);
      }
      db.close();
    } else {
      suite.note("real-queue-empty", "平台队列当前无待读更新；只读调用已实证，未伪造事件");
    }
  }
}

writeReport({
  suiteId: "ingress-telegram",
  suite,
  label: "test:ingress-telegram — 只读真实源接入与凭据生命周期（失败关闭默认）",
  extra: {
    dataSources:
      "确定性用例为本地 SQLite；真实用例经主人授权的 bot token 只读调用 api.telegram.org（getMe/getUpdates，无 sendMessage，无 offset 确认），输出全程脱敏；无付费模型调用",
  },
});
process.exit(suiteExit(suite, { label: "test:ingress-telegram" }));
