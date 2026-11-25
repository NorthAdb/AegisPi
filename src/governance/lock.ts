import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export interface InstanceLockHandle {
  dataDir: string;
  lockKey: string;
  pid: number;
  release: () => Promise<void>;
}

export class InstanceLockBusyError extends Error {
  readonly dataDir: string;
  readonly lockKey: string;
  constructor(dataDir: string, lockKey: string, cause?: unknown) {
    super(`Data directory is already owned by another active AegisPi host instance: ${dataDir}`);
    this.name = "InstanceLockBusyError";
    this.dataDir = dataDir;
    this.lockKey = lockKey;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function lockPipePathForDataDir(dataDir: string): string {
  const normalized = path.resolve(dataDir).toLowerCase();
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\aegispi-v2-lock-${digest}`;
  }
  return path.join(path.resolve(dataDir), `.aegispi-v2-${digest}.sock`);
}

/**
 * Acquires Windows kernel-enforced cross-process exclusive ownership for a data directory.
 * Uses a named pipe bound with exclusive: true (FILE_FLAG_FIRST_PIPE_INSTANCE on Windows).
 * If the owning process is terminated with Stop-Process -Force, the Windows kernel
 * immediately closes the handle so the next instance can acquire ownership cleanly.
 */
export async function acquireDataDirLock(dataDir: string): Promise<InstanceLockHandle> {
  const absDir = path.resolve(dataDir);
  mkdirSync(absDir, { recursive: true });
  const pipePath = lockPipePathForDataDir(absDir);
  const metaPath = path.join(absDir, ".aegispi-instance.json");

  const server = net.createServer((socket) => {
    socket.end(JSON.stringify({ pid: process.pid, dataDir: absDir }) + "\n");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        reject(new InstanceLockBusyError(absDir, pipePath, err));
      } else {
        reject(err);
      }
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ path: pipePath, exclusive: true });
  });

  // Unref so lock server alone does not hang a clean exit if caller closes properly,
  // though explicit release() is always called during graceful shutdown.
  server.unref();

  try {
    writeFileSync(
      metaPath,
      JSON.stringify(
        {
          pid: process.pid,
          dataDir: absDir,
          lockKey: pipePath,
          acquiredAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Metadata file is diagnostic only; the kernel named pipe is the real lock.
  }

  let released = false;
  return {
    dataDir: absDir,
    lockKey: pipePath,
    pid: process.pid,
    release: async () => {
      if (released) return;
      released = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      try {
        unlinkSync(metaPath);
      } catch {
        // Ignore if already removed.
      }
    },
  };
}
