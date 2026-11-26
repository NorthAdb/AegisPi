import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export const STAGE2_CONSOLE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'";

export function readStaticDistFile(
  distDir: string,
  relPath: string,
): { ok: true; body: Buffer; contentType: string } | { ok: false } {
  const absRoot = path.resolve(distDir);
  const cleaned = relPath.replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("..") || cleaned.includes("\0")) {
    return { ok: false };
  }
  const fullPath = path.resolve(absRoot, cleaned);
  const relCheck = path.relative(absRoot, fullPath);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    return { ok: false };
  }
  if (!existsSync(fullPath)) {
    return { ok: false };
  }
  try {
    const st = statSync(fullPath);
    if (!st.isFile()) return { ok: false };
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    return { ok: true, body: readFileSync(fullPath), contentType };
  } catch {
    return { ok: false };
  }
}
