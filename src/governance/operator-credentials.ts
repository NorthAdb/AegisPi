import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export function runWindowsPowerShell(script: string, input: Buffer, maxBuffer = 32_768): Buffer {
  if (process.platform !== "win32") throw new Error("windows_protection_unavailable");
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  const result = spawnSync(
    path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { input, windowsHide: true, timeout: 25_000, maxBuffer, env: { SystemRoot: root } },
  );
  if (result.status !== 0 || !result.stdout.length) throw new Error("windows_helper_failed");
  return result.stdout;
}

function protect(input: Buffer, operation: "Protect" | "Unprotect"): Buffer {
  return runWindowsPowerShell(`
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Security
    $inputBytes = New-Object IO.MemoryStream
    [Console]::OpenStandardInput().CopyTo($inputBytes)
    $result = [Security.Cryptography.ProtectedData]::${operation}(
      $inputBytes.ToArray(), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::OpenStandardOutput().Write($result, 0, $result.Length)
  `, input);
}

export function openOperatorCredentials(dataDir: string) {
  const directory = path.join(dataDir, "operator-credentials");
  function file(ref: string) {
    if (!/^[a-f0-9-]{36}$/.test(ref)) throw new Error("invalid_credential_reference");
    return path.join(directory, `${ref}.dpapi`);
  }
  return {
    save(secret: string) {
      const ref = randomUUID();
      const plaintext = Buffer.from(secret, "utf8");
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        atomicOperatorWrite(file(ref), protect(plaintext, "Protect"));
      } finally {
        plaintext.fill(0);
      }
      return ref;
    },
    resolve(ref: string) {
      const plaintext = protect(readFileSync(file(ref)), "Unprotect");
      try {
        return plaintext.toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    },
    discard(ref: string) {
      rmSync(file(ref), { force: true });
    },
  };
}

export function atomicOperatorWrite(file: string, value: string | Buffer) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
