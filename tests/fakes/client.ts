import { readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { ModelArrivalRecord, ScriptedResponse } from "./fake-model-server.ts";
import type { SmtpReceiptRecord } from "./fake-smtp-server.ts";

export const LOCKED_NODE_EXE = process.env["AEGISPI_NODE_EXE"] ?? process.execPath;

export interface FakeModelHandle {
  pid: number;
  baseUrl: string;
  port: number;
  dataDir: string;
  logPath: string;
  child: ChildProcessWithoutNullStreams;
  stats: () => Promise<{
    pid: number;
    totalPhysicalRequests: number;
    logPath: string;
    queuedScripts: number;
    arrivedBarriers: string[];
    records: ModelArrivalRecord[];
  }>;
  queue: (opts: {
    scripts?: ScriptedResponse[];
    clear?: boolean;
    defaultScript?: ScriptedResponse;
    watchMarkers?: string[];
  }) => Promise<void>;
  waitBarrier: (key: string, timeoutMs?: number) => Promise<{ arrived: boolean; totalPhysicalRequests: number }>;
  releaseBarrier: (key: string) => Promise<void>;
  stop: () => Promise<void>;
}

export interface FakeSmtpHandle {
  pid: number;
  host: string;
  smtpPort: number;
  controlPort: number;
  dataDir: string;
  logPath: string;
  child: ChildProcessWithoutNullStreams;
  stats: () => Promise<{
    pid: number;
    mode: string;
    totalReceived: number;
    heldCount: number;
    logPath: string;
    records: SmtpReceiptRecord[];
  }>;
  setMode: (mode: "normal" | "hold_after_receive" | "reject_550") => Promise<void>;
  releaseHeld: () => Promise<{ released: number }>;
  waitArrival: (seq: number, timeoutMs?: number) => Promise<{ arrived: boolean; record?: SmtpReceiptRecord; totalReceived: number }>;
  stop: () => Promise<void>;
}

function waitForReadyLine<T>(child: ChildProcessWithoutNullStreams, label: string, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not print ready line within ${timeoutMs}ms. stderr=${stderrBuf}`));
    }, timeoutMs);

    const onStdout = (chunk: Buffer): void => {
      stdoutBuf += chunk.toString("utf8");
      const idx = stdoutBuf.indexOf("\n");
      if (idx !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        cleanup();
        try {
          resolve(JSON.parse(line) as T);
        } catch (err) {
          reject(new Error(`${label} invalid ready JSON: ${line} (${String(err)})`));
        }
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderrBuf += chunk.toString("utf8");
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`${label} exited prematurely with code ${String(code)}. stderr=${stderrBuf}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

export async function startFakeModelServer(dataDir: string, port = 0): Promise<FakeModelHandle> {
  const scriptPath = path.resolve("tests/fakes/fake-model-server.ts");
  const child = spawn(LOCKED_NODE_EXE, [scriptPath, "--data-dir", dataDir, "--port", String(port)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = await waitForReadyLine<{
    pid: number;
    baseUrl: string;
    port: number;
    dataDir: string;
    logPath: string;
  }>(child, "fake-model-server");

  return {
    pid: ready.pid,
    baseUrl: ready.baseUrl,
    port: ready.port,
    dataDir: ready.dataDir,
    logPath: ready.logPath,
    child,
    stats: async () => {
      const res = await fetch(`${ready.baseUrl}/__control/stats`);
      return (await res.json()) as {
        pid: number;
        totalPhysicalRequests: number;
        logPath: string;
        queuedScripts: number;
        arrivedBarriers: string[];
        records: ModelArrivalRecord[];
      };
    },
    queue: async (opts) => {
      const res = await fetch(`${ready.baseUrl}/__control/queue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (!res.ok) throw new Error(`fake-model queue failed: ${res.status}`);
    },
    waitBarrier: async (key, timeoutMs = 15_000) => {
      const res = await fetch(
        `${ready.baseUrl}/__control/wait-barrier?key=${encodeURIComponent(key)}&timeoutMs=${timeoutMs}`,
      );
      return (await res.json()) as { arrived: boolean; totalPhysicalRequests: number };
    },
    releaseBarrier: async (key) => {
      const res = await fetch(`${ready.baseUrl}/__control/release-barrier`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) throw new Error(`fake-model release-barrier failed: ${res.status}`);
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      try {
        await fetch(`${ready.baseUrl}/__control/shutdown`, { method: "POST" });
      } catch {
        // ignore if already down
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

export async function startFakeSmtpServer(
  dataDir: string,
  opts: { smtpPort?: number; controlPort?: number; mode?: "normal" | "hold_after_receive" | "reject_550" } = {},
): Promise<FakeSmtpHandle> {
  const scriptPath = path.resolve("tests/fakes/fake-smtp-server.ts");
  const child = spawn(
    LOCKED_NODE_EXE,
    [
      scriptPath,
      "--data-dir",
      dataDir,
      "--smtp-port",
      String(opts.smtpPort ?? 0),
      "--control-port",
      String(opts.controlPort ?? 0),
      "--mode",
      opts.mode ?? "normal",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const ready = await waitForReadyLine<{
    pid: number;
    host: string;
    smtpPort: number;
    controlPort: number;
    dataDir: string;
    logPath: string;
  }>(child, "fake-smtp-server");
  const ctrlBase = `http://${ready.host}:${ready.controlPort}`;

  return {
    pid: ready.pid,
    host: ready.host,
    smtpPort: ready.smtpPort,
    controlPort: ready.controlPort,
    dataDir: ready.dataDir,
    logPath: ready.logPath,
    child,
    stats: async () => {
      const res = await fetch(`${ctrlBase}/__control/stats`);
      return (await res.json()) as {
        pid: number;
        mode: string;
        totalReceived: number;
        heldCount: number;
        logPath: string;
        records: SmtpReceiptRecord[];
      };
    },
    setMode: async (mode) => {
      const res = await fetch(`${ctrlBase}/__control/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error(`fake-smtp setMode failed: ${res.status}`);
    },
    releaseHeld: async () => {
      const res = await fetch(`${ctrlBase}/__control/release`, { method: "POST" });
      return (await res.json()) as { released: number };
    },
    waitArrival: async (seq, timeoutMs = 15_000) => {
      const res = await fetch(`${ctrlBase}/__control/wait-arrival?seq=${seq}&timeoutMs=${timeoutMs}`);
      return (await res.json()) as { arrived: boolean; record?: SmtpReceiptRecord; totalReceived: number };
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      try {
        await fetch(`${ctrlBase}/__control/shutdown`, { method: "POST" });
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

export interface FakeImapHandle {
  pid: number;
  host: string;
  imapPort: number;
  controlPort: number;
  certCn: string;
  certPem: string;
  uidValidity: number;
  logPath: string;
  stats: () => Promise<{
    pid: number;
    certCn: string;
    uidValidity: number;
    totalLogins: number;
    totalExamine: number;
    totalSelect: number;
    totalBodyPeekFetch: number;
    totalNonPeekFetch: number;
    messages: Array<{ uid: number; subject: string; date: string; flags: string[] }>;
    eventsCount: number;
  }>;
  stop: () => Promise<void>;
}

export async function startFakeImapServer(
  dataDir: string,
  opts: { certCn?: string; user?: string; pass?: string; uidValidity?: number } = {},
): Promise<FakeImapHandle> {
  const scriptPath = path.resolve("tests/fakes/fake-imap-server.ts");
  const child = spawn(
    LOCKED_NODE_EXE,
    [
      scriptPath,
      "--data-dir",
      dataDir,
      "--cert-cn",
      opts.certCn ?? "imap.local.test",
      "--user",
      opts.user ?? "owner@local.test",
      "--pass",
      opts.pass ?? "SYNTHETIC_IMAP_APP_PASS_V2",
      "--uid-validity",
      String(opts.uidValidity ?? 20261126),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const ready = await waitForReadyLine<{
    pid: number;
    host: string;
    imapPort: number;
    controlPort: number;
    certCn: string;
    certPath: string;
    uidValidity: number;
    logPath: string;
  }>(child, "fake-imap-server");
  const ctrlBase = `http://${ready.host}:${ready.controlPort}`;
  const certPem = readFileSync(ready.certPath, "utf8");

  return {
    pid: ready.pid,
    host: ready.host,
    imapPort: ready.imapPort,
    controlPort: ready.controlPort,
    certCn: ready.certCn,
    certPem,
    uidValidity: ready.uidValidity,
    logPath: ready.logPath,
    stats: async () => {
      const res = await fetch(`${ctrlBase}/__control/stats`);
      return (await res.json()) as Awaited<ReturnType<FakeImapHandle["stats"]>>;
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      await fetch(`${ctrlBase}/__control/shutdown`, { method: "POST" }).catch(() => {});
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

export interface FakeConnectProxyHandle {
  pid: number;
  host: string;
  proxyPort: number;
  controlPort: number;
  logPath: string;
  stats: () => Promise<{ pid: number; totalTunnels: number; records: Array<{ seq: number; target: string; status: number }> }>;
  stop: () => Promise<void>;
}

export async function startFakeConnectProxy(dataDir: string): Promise<FakeConnectProxyHandle> {
  const scriptPath = path.resolve("tests/fakes/fake-connect-proxy.ts");
  const child = spawn(LOCKED_NODE_EXE, [scriptPath, "--data-dir", dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = await waitForReadyLine<{
    pid: number;
    host: string;
    proxyPort: number;
    controlPort: number;
    logPath: string;
  }>(child, "fake-connect-proxy");
  const ctrlBase = `http://${ready.host}:${ready.controlPort}`;
  return {
    ...ready,
    stats: async () => {
      const res = await fetch(`${ctrlBase}/__control/stats`);
      return (await res.json()) as Awaited<ReturnType<FakeConnectProxyHandle["stats"]>>;
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      await fetch(`${ctrlBase}/__control/shutdown`, { method: "POST" }).catch(() => {});
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}
