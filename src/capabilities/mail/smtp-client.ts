import net from "node:net";
import tls from "node:tls";
import {
  assertSmtpHostForStage,
  type StageEgressPolicy,
} from "../../governance/credentials.ts";

export interface SmtpSendRequest {
  host: string;
  port: number;
  from: string;
  to: string[];
  subject: string;
  body: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Stage egress policy (defaults to Stage 1 loopback-only). */
  egressPolicy?: StageEgressPolicy;
  /** TLS transport mode: none (loopback fake), direct_tls (SMTPS 465), or starttls (587). */
  tlsMode?: "none" | "direct_tls" | "starttls";
  servername?: string;
  caPem?: string;
  proxy?: { host: string; port: number };
  /** Host-memory SMTP auth credentials; strictly transmitted over verified TLS and scrubbed from errors. */
  auth?: { username: string; password: string };
  /** Optional transport factory observer for Stage 1 egress tests (defaults to net.createConnection). */
  createConnection?: typeof net.createConnection;
}

export interface SmtpSendResult {
  status: "succeeded" | "failed_remote" | "failed_local" | "unknown";
  receiptRef?: string;
  reason?: string;
  bytesSent: number;
  tlsVerified?: boolean;
  tlsPeerSubject?: string;
}

function scrubSmtpSecret(text: string, secret?: string): string {
  if (!secret || secret.length === 0) return text;
  return text.split(secret).join("[REDACTED_CREDENTIAL]");
}

function dotStuff(text: string): string {
  return text
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? "." + line : line))
    .join("\r\n");
}

async function openConnectTunnelTcp(params: {
  proxyHost: string;
  proxyPort: number;
  targetHost: string;
  targetPort: number;
  timeoutMs: number;
}): Promise<net.Socket> {
  const authority = `${params.targetHost}:${params.targetPort}`;
  return await new Promise<net.Socket>((resolve, reject) => {
    const sock = net.connect({ host: params.proxyHost, port: params.proxyPort });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`SMTP CONNECT tunnel timed out after ${params.timeoutMs}ms`));
    }, params.timeoutMs);
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.once("connect", () => {
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      sock.off("data", onData);
      clearTimeout(timer);
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      if (!/^HTTP\/1\.[01]\s+200\b/i.test(statusLine)) {
        sock.destroy();
        reject(new Error(`SMTP CONNECT proxy rejected tunnel: ${statusLine}`));
        return;
      }
      resolve(sock);
    };
    sock.on("data", onData);
  });
}

async function upgradeSocketToVerifiedTls(params: {
  socket?: net.Socket;
  host?: string;
  port?: number;
  servername: string;
  caPem?: string;
  timeoutMs: number;
}): Promise<{ socket: tls.TLSSocket; peerSubject: string }> {
  return await new Promise((resolve, reject) => {
    const sock = tls.connect(
      {
        ...(params.socket ? { socket: params.socket } : { host: params.host, port: params.port }),
        servername: params.servername,
        ca: params.caPem ? [params.caPem] : undefined,
        rejectUnauthorized: true,
      },
      () => {
        clearTimeout(timer);
        const cert = sock.getPeerCertificate();
        const subj = cert?.subject?.CN ? String(cert.subject.CN) : params.servername;
        resolve({ socket: sock, peerSubject: subj });
      },
    );
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`SMTP TLS handshake timed out after ${params.timeoutMs}ms`));
    }, params.timeoutMs);
    sock.once("error", (err) => {
      clearTimeout(timer);
      if (params.socket) params.socket.destroy();
      reject(err);
    });
  });
}

async function openSmtpTransportSocket(req: {
  host: string;
  port: number;
  tlsMode: "none" | "direct_tls" | "starttls";
  servername?: string;
  caPem?: string;
  proxy?: { host: string; port: number };
  timeoutMs: number;
  createConnection?: typeof net.createConnection;
}): Promise<{ socket: net.Socket | tls.TLSSocket; tlsVerified: boolean; tlsPeerSubject?: string }> {
  const servername = req.servername ?? req.host;
  if (req.tlsMode === "direct_tls") {
    if (req.proxy) {
      const tunneled = await openConnectTunnelTcp({
        proxyHost: req.proxy.host,
        proxyPort: req.proxy.port,
        targetHost: req.host,
        targetPort: req.port,
        timeoutMs: req.timeoutMs,
      });
      const upgraded = await upgradeSocketToVerifiedTls({
        socket: tunneled,
        servername,
        caPem: req.caPem,
        timeoutMs: req.timeoutMs,
      });
      return { socket: upgraded.socket, tlsVerified: true, tlsPeerSubject: upgraded.peerSubject };
    }
    const direct = await upgradeSocketToVerifiedTls({
      host: req.host,
      port: req.port,
      servername,
      caPem: req.caPem,
      timeoutMs: req.timeoutMs,
    });
    return { socket: direct.socket, tlsVerified: true, tlsPeerSubject: direct.peerSubject };
  }

  if (req.proxy) {
    const tunneled = await openConnectTunnelTcp({
      proxyHost: req.proxy.host,
      proxyPort: req.proxy.port,
      targetHost: req.host,
      targetPort: req.port,
      timeoutMs: req.timeoutMs,
    });
    return { socket: tunneled, tlsVerified: false };
  }

  const connectFn = req.createConnection ?? net.createConnection;
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = connectFn({ host: req.host, port: req.port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`SMTP TCP connect timed out after ${req.timeoutMs}ms`));
    }, req.timeoutMs);
    s.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
  });
  return { socket: sock, tlsVerified: false };
}

/**
 * Pure-Node SMTP client used exclusively by the sole host submitter
 * AFTER claimEffectForSubmission (READY -> SUBMITTING) has committed.
 * Supports Stage 1 loopback TCP as well as Stage 2 verified Direct TLS / STARTTLS
 * (direct or via HTTP CONNECT tunnel) with host-memory AUTH credentials.
 */
export async function sendSmtpMessage(req: SmtpSendRequest): Promise<SmtpSendResult> {
  const tlsMode = req.tlsMode ?? "none";
  try {
    assertSmtpHostForStage(req.host, req.port, req.egressPolicy, {
      tlsEnabled: tlsMode === "direct_tls" || tlsMode === "starttls",
    });
  } catch (err) {
    return {
      status: "failed_local",
      reason: scrubSmtpSecret(err instanceof Error ? err.message : String(err), req.auth?.password),
      bytesSent: 0,
      tlsVerified: false,
    };
  }
  if (req.auth && tlsMode === "none") {
    return {
      status: "failed_local",
      reason: "SMTP AUTH requires verified TLS (direct_tls or starttls)",
      bytesSent: 0,
      tlsVerified: false,
    };
  }

  const timeoutMs = req.timeoutMs ?? 15_000;
  let transport: { socket: net.Socket | tls.TLSSocket; tlsVerified: boolean; tlsPeerSubject?: string };
  try {
    transport = await openSmtpTransportSocket({
      host: req.host,
      port: req.port,
      tlsMode,
      servername: req.servername,
      caPem: req.caPem,
      proxy: req.proxy,
      timeoutMs,
      createConnection: req.createConnection,
    });
  } catch (err) {
    return {
      status: "failed_local",
      reason: scrubSmtpSecret(err instanceof Error ? err.message : String(err), req.auth?.password),
      bytesSent: 0,
      tlsVerified: false,
    };
  }

  let activeSocket: net.Socket | tls.TLSSocket = transport.socket;
  let tlsVerified = transport.tlsVerified;
  let tlsPeerSubject = transport.tlsPeerSubject;

  return await new Promise<SmtpSendResult>((resolve) => {
    let settled = false;
    let bytesSent = 0;
    let dataTransmitted = false;

    const finish = (result: SmtpSendResult): void => {
      if (settled) return;
      settled = true;
      activeSocket.destroy();
      resolve({
        ...result,
        ...(result.reason ? { reason: scrubSmtpSecret(result.reason, req.auth?.password) } : {}),
        tlsVerified,
        ...(tlsPeerSubject ? { tlsPeerSubject } : {}),
      });
    };

    let buffer = "";
    const lineWaiters: Array<(line: string) => void> = [];
    const bufferedLines: string[] = [];

    const attachSocketListeners = (sock: net.Socket | tls.TLSSocket): void => {
      sock.setEncoding("utf8");
      sock.setTimeout(timeoutMs);
      sock.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          let line = buffer.slice(0, idx);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          buffer = buffer.slice(idx + 1);
          const waiter = lineWaiters.shift();
          if (waiter) {
            waiter(line);
          } else {
            bufferedLines.push(line);
          }
          idx = buffer.indexOf("\n");
        }
      });
      sock.on("timeout", () => {
        finish({
          status: dataTransmitted ? "unknown" : bytesSent === 0 ? "failed_local" : "unknown",
          reason: dataTransmitted ? "smtp_reply_timeout_after_data" : "smtp_timeout",
          bytesSent,
        });
      });
      sock.on("error", (err) => {
        finish({
          status: dataTransmitted ? "unknown" : bytesSent === 0 ? "failed_local" : "unknown",
          reason: `smtp_socket_error: ${err.message}`,
          bytesSent,
        });
      });
      sock.on("close", () => {
        if (!settled && sock === activeSocket) {
          finish({
            status: dataTransmitted ? "unknown" : "failed_local",
            reason: dataTransmitted ? "smtp_closed_before_receipt" : "smtp_closed_before_data",
            bytesSent,
          });
        }
      });
    };

    const nextReply = (): Promise<{ code: number; lines: string[] }> => {
      return new Promise((resReply) => {
        const lines: string[] = [];
        const onLine = (line: string): void => {
          lines.push(line);
          if (/^\d{3} /.test(line)) {
            resReply({ code: Number(line.slice(0, 3)), lines });
          } else {
            takeLine(onLine);
          }
        };
        takeLine(onLine);
      });
    };

    const takeLine = (cb: (line: string) => void): void => {
      const existing = bufferedLines.shift();
      if (existing !== undefined) {
        cb(existing);
      } else {
        lineWaiters.push(cb);
      }
    };

    const writeCmd = (cmd: string): void => {
      const wire = cmd + "\r\n";
      bytesSent += Buffer.byteLength(wire, "utf8");
      activeSocket.write(wire);
    };

    attachSocketListeners(activeSocket);

    void (async () => {
      try {
        const greeting = await nextReply();
        if (greeting.code !== 220) {
          finish({ status: "failed_remote", reason: `unexpected greeting: ${greeting.lines.join(" | ")}`, bytesSent });
          return;
        }
        writeCmd("EHLO aegispi.local");
        let ehlo = await nextReply();
        if (ehlo.code !== 250) {
          finish({ status: "failed_remote", reason: `EHLO failed: ${ehlo.lines.join(" | ")}`, bytesSent });
          return;
        }

        if (tlsMode === "starttls") {
          writeCmd("STARTTLS");
          const st = await nextReply();
          if (st.code !== 220) {
            finish({ status: "failed_remote", reason: `STARTTLS rejected: ${st.lines.join(" | ")}`, bytesSent });
            return;
          }
          activeSocket.removeAllListeners("data");
          activeSocket.removeAllListeners("timeout");
          activeSocket.removeAllListeners("error");
          activeSocket.removeAllListeners("close");
          const upgraded = await upgradeSocketToVerifiedTls({
            socket: activeSocket,
            servername: req.servername ?? req.host,
            caPem: req.caPem,
            timeoutMs,
          });
          activeSocket = upgraded.socket;
          tlsVerified = true;
          tlsPeerSubject = upgraded.peerSubject;
          buffer = "";
          attachSocketListeners(activeSocket);
          writeCmd("EHLO aegispi.local");
          ehlo = await nextReply();
          if (ehlo.code !== 250) {
            finish({ status: "failed_remote", reason: `Post-STARTTLS EHLO failed: ${ehlo.lines.join(" | ")}`, bytesSent });
            return;
          }
        }

        if (req.auth) {
          if (!tlsVerified) {
            finish({ status: "failed_local", reason: "Refusing SMTP AUTH on unverified transport", bytesSent });
            return;
          }
          const plainB64 = Buffer.from(`\u0000${req.auth.username}\u0000${req.auth.password}`, "utf8").toString("base64");
          writeCmd(`AUTH PLAIN ${plainB64}`);
          const authReply = await nextReply();
          if (authReply.code !== 235) {
            finish({ status: "failed_remote", reason: `SMTP AUTH failed (${authReply.code})`, bytesSent });
            return;
          }
        }

        writeCmd(`MAIL FROM:<${req.from}>`);
        const mf = await nextReply();
        if (mf.code !== 250) {
          finish({ status: "failed_remote", reason: `MAIL FROM failed: ${mf.lines.join(" | ")}`, bytesSent });
          return;
        }
        for (const recipient of req.to) {
          writeCmd(`RCPT TO:<${recipient}>`);
          const rt = await nextReply();
          if (rt.code !== 250 && rt.code !== 251) {
            finish({ status: "failed_remote", reason: `RCPT TO failed: ${rt.lines.join(" | ")}`, bytesSent });
            return;
          }
        }
        writeCmd("DATA");
        const dataReady = await nextReply();
        if (dataReady.code !== 354) {
          finish({ status: "failed_remote", reason: `DATA rejected: ${dataReady.lines.join(" | ")}`, bytesSent });
          return;
        }

        const extraHeaders = Object.entries(req.headers ?? {})
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n");
        const messagePayload = [
          `From: ${req.from}`,
          `To: ${req.to.join(", ")}`,
          `Subject: ${req.subject}`,
          ...(extraHeaders ? [extraHeaders] : []),
          "",
          dotStuff(req.body),
          ".",
        ].join("\r\n");

        dataTransmitted = true;
        writeCmd(messagePayload);
        const dataReply = await nextReply();
        if (dataReply.code >= 200 && dataReply.code < 300) {
          const receiptRef = dataReply.lines[dataReply.lines.length - 1] ?? "250 OK";
          writeCmd("QUIT");
          finish({ status: "succeeded", receiptRef, bytesSent });
        } else if (dataReply.code >= 500) {
          writeCmd("QUIT");
          finish({ status: "failed_remote", reason: dataReply.lines.join(" | "), bytesSent });
        } else {
          finish({ status: "unknown", reason: `ambiguous DATA reply: ${dataReply.lines.join(" | ")}`, bytesSent });
        }
      } catch (err) {
        finish({
          status: dataTransmitted ? "unknown" : "failed_local",
          reason: err instanceof Error ? err.message : String(err),
          bytesSent,
        });
      }
    })();
  });
}

/**
 * Non-sending SMTP connectivity test (greeting + TLS + QUIT, 0 MAIL FROM / DATA).
 */
export async function testSmtpConnectivity(req: {
  host: string;
  port: number;
  egressPolicy?: StageEgressPolicy;
  tlsMode?: "none" | "direct_tls" | "starttls";
  servername?: string;
  caPem?: string;
  proxy?: { host: string; port: number };
  auth?: { username: string; password: string };
  timeoutMs?: number;
}): Promise<{ ok: boolean; tlsVerified: boolean; tlsPeerSubject?: string; message: string }> {
  const tlsMode = req.tlsMode ?? "none";
  try {
    assertSmtpHostForStage(req.host, req.port, req.egressPolicy, {
      tlsEnabled: tlsMode === "direct_tls" || tlsMode === "starttls",
    });
  } catch (err) {
    return {
      ok: false,
      tlsVerified: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const timeoutMs = req.timeoutMs ?? 10_000;
  try {
    const transport = await openSmtpTransportSocket({
      host: req.host,
      port: req.port,
      tlsMode,
      servername: req.servername,
      caPem: req.caPem,
      proxy: req.proxy,
      timeoutMs,
    });
    const sock = transport.socket;
    sock.setEncoding("utf8");
    const greeting = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("SMTP greeting timeout")), timeoutMs);
      let buf = "";
      sock.on("data", (c: string) => {
        buf += c;
        const idx = buf.indexOf("\n");
        if (idx !== -1) {
          clearTimeout(t);
          resolve(buf.slice(0, idx).trim());
        }
      });
      sock.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    sock.write("QUIT\r\n");
    sock.destroy();
    const ok = greeting.startsWith("220");
    return {
      ok,
      tlsVerified: transport.tlsVerified,
      tlsPeerSubject: transport.tlsPeerSubject,
      message: ok ? `Connected (${greeting.slice(0, 60)})` : `Unexpected greeting: ${greeting.slice(0, 60)}`,
    };
  } catch (err) {
    return {
      ok: false,
      tlsVerified: false,
      message: scrubSmtpSecret(err instanceof Error ? err.message : String(err), req.auth?.password),
    };
  }
}
