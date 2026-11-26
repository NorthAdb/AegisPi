import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface Week2CliOptions {
  dataDir?: string;
  evidenceDir?: string;
  keepData: boolean;
}

export function parseWeek2CliArgs(argv: string[]): Week2CliOptions {
  const map: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        map[k] = v;
        i++;
      } else {
        map[k] = "true";
      }
    }
  }
  return {
    dataDir: map["data-dir"] ? path.resolve(map["data-dir"]) : undefined,
    evidenceDir: map["evidence-dir"] ? path.resolve(map["evidence-dir"]) : undefined,
    keepData: map["keep-data"] === "true",
  };
}

export async function rmDirWithRetry(dirPath: string, retries = 15, delayMs = 150): Promise<void> {
  if (!dirPath || !existsSync(dirPath)) return;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "";
      if (
        (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY" || code === "EACCES") &&
        attempt + 1 < retries
      ) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      // Best-effort final cleanup without crashing passing test after teardown
      return;
    }
  }
}

export async function findFreeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("Failed to allocate free loopback port")));
        return;
      }
      const p = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(p);
      });
    });
  });
}

export function findLocalBrowserExe(): string {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error("No local Edge/Chrome browser found for V01/V05/V06 real-browser E2E");
}

export class MinimalCdpClient {
  readonly #ws: WebSocket;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (typeof msg.id === "number") {
        const p = this.#pending.get(msg.id);
        if (p) {
          this.#pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      }
    });
  }

  static async connect(wsUrl: string): Promise<MinimalCdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP WebSocket connect timeout")), 10_000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("CDP WebSocket connect error"));
      });
    });
    return new MinimalCdpClient(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP call timeout: ${method}`));
      }, 20_000);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `Browser JS exception: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "unknown"}`,
      );
    }
    return res.result?.value as T;
  }

  async waitFor<T>(fnExpr: string, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const val = await this.evalJs<T>(fnExpr);
      if (val) return val;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(`Browser waitFor timed out (${timeoutMs}ms): ${fnExpr.slice(0, 120)}`);
  }

  close(): void {
    try {
      this.#ws.close();
    } catch {
      // ignore
    }
  }
}

export interface HeadlessBrowserHandle {
  exe: string;
  profileDir: string;
  debugPort: number;
  child: ChildProcessWithoutNullStreams;
  cdp: MinimalCdpClient;
  close: () => Promise<void>;
}

function killProcessTreeWindows(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    // ignore
  }
}

async function waitForDevToolsTargets(
  debugPort: number,
  profileDir: string,
  child: ChildProcessWithoutNullStreams,
  getStderr: () => string,
  timeoutMs = 15_000,
): Promise<{ pageWsUrl: string; browserWsUrl?: string }> {
  const deadline = Date.now() + timeoutMs;
  let exitObservedAt: number | null = null;
  let exitCodeObserved: number | null = null;

  const onExit = (code: number | null): void => {
    exitObservedAt = Date.now();
    exitCodeObserved = code;
  };
  child.once("exit", onExit);

  try {
    while (Date.now() < deadline) {
      // Check DevToolsActivePort file or explicit HTTP /json/list on debugPort
      let effectivePort = debugPort;
      const activePortFile = path.join(profileDir, "DevToolsActivePort");
      if (existsSync(activePortFile)) {
        try {
          const lines = readFileSync(activePortFile, "utf8").trim().split(/\r?\n/);
          const parsedPort = Number(lines[0]);
          if (Number.isInteger(parsedPort) && parsedPort > 0) {
            effectivePort = parsedPort;
          }
        } catch {
          // ignore race while writing file
        }
      }

      try {
        const listRes = await fetch(`http://127.0.0.1:${effectivePort}/json/list`, {
          signal: AbortSignal.timeout(1000),
        });
        if (listRes.ok) {
          const targets = (await listRes.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
          const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
          if (pageTarget?.webSocketDebuggerUrl) {
            let browserWsUrl: string | undefined;
            try {
              const verRes = await fetch(`http://127.0.0.1:${effectivePort}/json/version`, {
                signal: AbortSignal.timeout(1000),
              });
              if (verRes.ok) {
                const ver = (await verRes.json()) as { webSocketDebuggerUrl?: string };
                browserWsUrl = ver.webSocketDebuggerUrl;
              }
            } catch {
              // optional
            }
            return { pageWsUrl: pageTarget.webSocketDebuggerUrl, browserWsUrl };
          }
        }
      } catch {
        // not listening yet
      }

      // If parent process exited AND HTTP endpoint still not reachable after 1.5s grace, bail cleanly
      if (exitObservedAt !== null && Date.now() - exitObservedAt > 1500) {
        throw new Error(
          `Browser exited early (${String(exitCodeObserved)}) before CDP ready on port ${effectivePort}. stderr=${getStderr().slice(0, 400)}`,
        );
      }

      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`Browser CDP start timeout on port ${debugPort}. stderr=${getStderr().slice(0, 400)}`);
  } finally {
    child.off("exit", onExit);
  }
}

/**
 * Reliable Windows Edge/Chrome headless launcher:
 * - Always uses a fresh short ASCII temp user-data-dir under os.tmpdir() (avoids long paths / junctions).
 * - Allocates an explicit free loopback debug port and polls HTTP /json/list + DevToolsActivePort (not only stderr).
 * - Retries across headless modes ("--headless=new", "--headless") if Edge exits early.
 * - Gracefully closes via CDP Browser.close, then taskkill /T /F, then retryable rmSync to avoid Windows EBUSY!
 */
export async function launchReliableHeadlessBrowser(): Promise<HeadlessBrowserHandle> {
  const exe = findLocalBrowserExe();
  const modes = ["--headless=new", "--headless"];
  let lastErr: Error | null = null;

  for (const headlessFlag of modes) {
    const profileDir = path.join(os.tmpdir(), `agp-edge-${randomUUID().slice(0, 8)}`);
    mkdirSync(profileDir, { recursive: true });
    const debugPort = await findFreeLoopbackPort();
    const child = spawn(
      exe,
      [
        headlessFlag,
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-extensions",
        "--disable-sync",
        "--disable-component-update",
        "--disable-features=msEdgeStartupBoost",
        "--remote-allow-origins=*",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileDir}`,
        "--enable-logging=stderr",
        "--v=0",
        "about:blank",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );

    let stderr = "";
    child.stderr.on("data", (buf: Buffer) => {
      if (stderr.length < 4096) stderr += buf.toString("utf8");
    });

    try {
      const { pageWsUrl } = await waitForDevToolsTargets(
        debugPort,
        profileDir,
        child,
        () => stderr,
        12_000,
      );
      const cdp = await MinimalCdpClient.connect(pageWsUrl);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      assert.ok(cdp, "CDP connected");

      return {
        exe,
        profileDir,
        debugPort,
        child,
        cdp,
        close: async () => {
          try {
            await Promise.race([
              cdp.send("Browser.close").catch(() => {}),
              new Promise((r) => setTimeout(r, 1500)),
            ]);
          } catch {
            // ignore
          }
          cdp.close();
          if (child.exitCode === null && child.pid) {
            await Promise.race([
              new Promise<void>((r) => child.once("exit", () => r())),
              new Promise<void>((r) => setTimeout(r, 1500)),
            ]);
            if (child.exitCode === null) {
              killProcessTreeWindows(child.pid);
              await Promise.race([
                new Promise<void>((r) => child.once("exit", () => r())),
                new Promise<void>((r) => setTimeout(r, 2000)),
              ]);
            }
          }
          await rmDirWithRetry(profileDir);
        },
      };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (child.exitCode === null && child.pid) {
        killProcessTreeWindows(child.pid);
      }
      await rmDirWithRetry(profileDir);
    }
  }

  throw lastErr ?? new Error("Failed to launch local headless browser");
}
