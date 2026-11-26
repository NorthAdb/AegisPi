import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export interface ValidatedWorkspacePath {
  ok: true;
  normalizedRelPath: string;
  absolutePath: string;
  segments: string[];
}

export interface RejectedWorkspacePath {
  ok: false;
  code: string;
  reason: string;
}

/**
 * Component-by-component authoritative workspace path jail for Windows & POSIX.
 * Rejects absolute paths, traversal (`..`), Alternate Data Streams (`:`), Windows reserved
 * device names, NUL bytes, trailing dots/spaces, symlinks, hardlinks (nlink > 1),
 * reparse points / junctions, and non-regular/non-directory special objects.
 */
export function validateAndResolveWorkspacePath(
  workspaceRoot: string,
  rawRelPath: string,
): ValidatedWorkspacePath | RejectedWorkspacePath {
  if (typeof rawRelPath !== "string" || rawRelPath.trim().length === 0) {
    return { ok: false, code: "empty_path", reason: "Target relative path must be non-empty" };
  }
  if (rawRelPath.includes("\0")) {
    return { ok: false, code: "nul_byte_in_path", reason: "Path contains NUL byte" };
  }
  if (rawRelPath.includes(":")) {
    return { ok: false, code: "windows_ads_or_drive_rejected", reason: `Path contains ':' (drive letter or ADS): ${rawRelPath}` };
  }
  if (rawRelPath.startsWith("/") || rawRelPath.startsWith("\\")) {
    return { ok: false, code: "absolute_path_rejected", reason: `Path must be relative: ${rawRelPath}` };
  }

  const rawSegments = rawRelPath.split(/[/\\]+/);
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (seg.length === 0 || seg === "." || seg === "..") {
      return { ok: false, code: "path_traversal_or_empty_segment", reason: `Illegal path segment '${seg}' in ${rawRelPath}` };
    }
    if (seg.endsWith(".") || seg.endsWith(" ")) {
      return { ok: false, code: "windows_trailing_dot_or_space", reason: `Illegal Windows trailing dot/space in segment '${seg}'` };
    }
    const baseName = seg.split(".")[0]!.toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(baseName)) {
      return { ok: false, code: "windows_device_name_rejected", reason: `Reserved Windows device name rejected: ${seg}` };
    }
    segments.push(seg);
  }

  const resolvedRoot = path.resolve(workspaceRoot);
  const realRoot = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;

  // Walk every existing component from root downward via lstatSync to catch symlinks, junctions/reparse points, hardlinks, and special files
  let currentAbs = realRoot;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    currentAbs = path.join(currentAbs, seg);
    const isLast = i === segments.length - 1;
    if (!existsSync(currentAbs)) {
      // Non-existent intermediate or final component is allowed for creation; verify prefix containment
      const relCheck = path.relative(realRoot, currentAbs);
      if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
        return { ok: false, code: "root_escape", reason: `Path escapes workspace root: ${rawRelPath}` };
      }
      continue;
    }

    const st = lstatSync(currentAbs);
    if (st.isSymbolicLink()) {
      return { ok: false, code: "symlink_rejected", reason: `Symlink rejected at component '${seg}'` };
    }
    const realCurrent = realpathSync(currentAbs);
    // Catch Windows NTFS junctions / mount points / reparse points whose realpath diverges from expected path
    if (realCurrent.toLowerCase() !== currentAbs.toLowerCase()) {
      return {
        ok: false,
        code: "reparse_point_or_junction_rejected",
        reason: `Reparse point or junction detected at '${seg}' (${currentAbs} -> ${realCurrent})`,
      };
    }
    const relFromRoot = path.relative(realRoot, realCurrent);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
      return { ok: false, code: "root_escape", reason: `Resolved path escapes workspace root: ${rawRelPath}` };
    }

    if (!isLast) {
      if (!st.isDirectory()) {
        return { ok: false, code: "parent_not_directory", reason: `Parent component '${seg}' is not a directory` };
      }
    } else {
      if (st.isDirectory()) {
        return { ok: false, code: "target_is_directory", reason: `Target '${rawRelPath}' is an existing directory` };
      }
      if (!st.isFile()) {
        return { ok: false, code: "special_file_rejected", reason: `Target '${rawRelPath}' is not a regular file` };
      }
      if (st.nlink > 1) {
        return { ok: false, code: "hardlink_rejected", reason: `Hardlink rejected on target '${rawRelPath}' (nlink=${st.nlink})` };
      }
    }
  }

  return {
    ok: true,
    normalizedRelPath: segments.join("/"),
    absolutePath: path.join(realRoot, ...segments),
    segments,
  };
}
