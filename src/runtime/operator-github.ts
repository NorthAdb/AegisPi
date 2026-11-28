import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { sha256File } from "../governance/mcp-pin.ts";
import { atomicOperatorWrite, runWindowsPowerShell } from "../governance/operator-credentials.ts";

const version = "2.1.0";
const releases = {
  x64: {
    architecture: "x86_64",
    archive: "ddce274916ebf31346dee71a0ed3345e80cd36b060a0bfb8160db0afc411e9d3",
    executable: "d9cb8667172b995c49db7f7da0feb7b8dd9cb5d20224baaff2c84a9e8d512967",
  },
  arm64: {
    architecture: "arm64",
    archive: "66232de60d2052f0093f8908a505fae890442ef8269b9ec6f57b2d3e1c705f70",
    executable: "860627dc68d4c6cb55ebc2a9078ca79adc3a8f5824040d7d3e570c0428d2617f",
  },
};

export function operatorGithubArtifact(dataDir: string) {
  const release = process.arch === "x64" ? releases.x64 : process.arch === "arm64" ? releases.arm64 : null;
  if (process.platform !== "win32" || !release) throw new Error("github_platform_unsupported");
  const directory = path.join(dataDir, "tools", `github-mcp-${version}-${release.architecture}`);
  const executable = path.join(directory, "github-mcp-server.exe");
  const identity = {
    serverId: `operator-github-${version}`,
    command: executable,
    args: ["stdio", "--read-only", "--tools", "get_file_contents"],
    pinnedArtifactPath: executable,
    pinnedArtifactSha256: release.executable,
    readOnlyMode: true,
  };
  return {
    identity,
    async prepare() {
      try {
        if (sha256File(executable) === release.executable) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const url = `https://github.com/github/github-mcp-server/releases/download/v${version}/github-mcp-server_Windows_${release.architecture}.zip`;
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok || !response.body) throw new Error("github_download_failed");
      const stream = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await stream.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 40_000_000) throw new Error("github_archive_too_large");
          chunks.push(value);
        }
      } finally {
        await stream.cancel().catch(() => {});
      }
      const archive = Buffer.concat(chunks);
      const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
      if (sha256(archive) !== release.archive) throw new Error("github_archive_hash_mismatch");
      const binary = runWindowsPowerShell(`
        $ErrorActionPreference = 'Stop'
        Add-Type -AssemblyName System.IO.Compression
        $bytes = New-Object IO.MemoryStream
        [Console]::OpenStandardInput().CopyTo($bytes)
        $bytes.Position = 0
        $zip = New-Object IO.Compression.ZipArchive($bytes)
        $entry = $zip.GetEntry('github-mcp-server.exe')
        if ($null -eq $entry) { throw 'Missing executable' }
        $entry.Open().CopyTo([Console]::OpenStandardOutput())
        $zip.Dispose()
      `, archive, 96_000_000);
      if (sha256(binary) !== release.executable) throw new Error("github_executable_hash_mismatch");
      mkdirSync(directory, { recursive: true });
      atomicOperatorWrite(executable, binary);
    },
  };
}
