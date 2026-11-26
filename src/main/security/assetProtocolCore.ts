import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export const PREVIEW_ASSET_MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json; charset=utf-8",
};

/**
 * Validates raw URL string BEFORE new URL() so Chromium/WHATWG normalization
 * cannot silently collapse /../, %2e%2e, backslashes, or Windows ADS colons.
 */
export function validateRawAssetUrl(rawUrlString: string): string[] | null {
  if (!rawUrlString || rawUrlString.includes("\0") || rawUrlString.includes("\\")) {
    return null;
  }

  const match = /^mf-asset:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/i.exec(rawUrlString);
  if (!match) return null;

  const rawAuthority = match[1];
  const rawPath = match[2] ?? "/";

  if (rawAuthority.includes("@") || rawAuthority.includes(":")) {
    return null;
  }

  if (/%(2e|2f|5c|25|00|3a)/i.test(rawPath)) {
    return null;
  }

  if (rawPath.includes("//") || rawPath.includes(":")) {
    return null;
  }

  let decodedRawPath: string;
  try {
    decodedRawPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }

  if (
    !decodedRawPath.startsWith("/") ||
    decodedRawPath.includes("\0") ||
    decodedRawPath.includes("\\") ||
    decodedRawPath.includes("//") ||
    decodedRawPath.includes(":")
  ) {
    return null;
  }

  const segments = decodedRawPath.slice(1).split("/");
  if (
    segments.some(
      (seg) =>
        seg === "" ||
        seg === "." ||
        seg === ".." ||
        seg.includes(":") ||
        /[. ]$/.test(seg)
    )
  ) {
    return null;
  }

  return segments;
}

export type ByteRangeParseResult =
  | { kind: "full" }
  | { kind: "unsatisfiable" }
  | { kind: "partial"; start: number; end: number };

export function parseByteRange(rangeHeader: string | null, totalSize: number): ByteRangeParseResult {
  if (!rangeHeader) return { kind: "full" };

  const trimmed = rangeHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bytes=")) return { kind: "full" };

  const rangeSpec = trimmed.slice(6).trim();
  if (!rangeSpec || rangeSpec === "-" || rangeSpec.includes(",")) {
    return { kind: "full" };
  }

  const parts = /^(\d*)-(\d*)$/.exec(rangeSpec);
  if (!parts) return { kind: "full" };

  const startStr = parts[1];
  const endStr = parts[2];
  if (!startStr && !endStr) return { kind: "full" };

  if (totalSize === 0) return { kind: "unsatisfiable" };

  if (!startStr && endStr) {
    const suffixLength = Number(endStr);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 0) return { kind: "full" };
    if (suffixLength === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, totalSize - suffixLength);
    return { kind: "partial", start, end: totalSize - 1 };
  }

  const start = Number(startStr);
  if (!Number.isSafeInteger(start) || start < 0) return { kind: "full" };
  if (start >= totalSize) return { kind: "unsatisfiable" };

  if (!endStr) {
    return { kind: "partial", start, end: totalSize - 1 };
  }

  const rawEnd = Number(endStr);
  if (!Number.isSafeInteger(rawEnd) || rawEnd < 0) return { kind: "full" };
  if (rawEnd < start) return { kind: "full" };

  const clampedEnd = Math.min(rawEnd, totalSize - 1);
  return { kind: "partial", start, end: clampedEnd };
}

/**
 * Checks every intermediate segment from canonicalRoot down to targetPath for symlinks /
 * Windows NTFS junctions before resolving realpathSync().
 */
export function resolveSafeContainedPathSync(
  canonicalRoot: string,
  segments: string[]
): { ok: true; canonicalFilePath: string } | { ok: false; status: 403 | 404; reason: string } {
  let cursor = canonicalRoot;
  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(cursor);
    } catch {
      return { ok: false, status: 404, reason: "File Not Found" };
    }
    if (lstat.isSymbolicLink()) {
      return { ok: false, status: 403, reason: "Access Denied: Symbolic Links and Junctions Prohibited" };
    }
  }

  let canonicalFilePath: string;
  try {
    canonicalFilePath = fs.realpathSync(cursor);
  } catch {
    return { ok: false, status: 404, reason: "File Not Found" };
  }

  const rel = path.relative(canonicalRoot, canonicalFilePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, status: 403, reason: "Access Denied: Containment Breach" };
  }

  return { ok: true, canonicalFilePath };
}

export function buildPreviewEntryCsp(expectedOrigin: string): string {
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${expectedOrigin}`,
    `style-src 'unsafe-inline' ${expectedOrigin}`,
    `img-src data: blob: ${expectedOrigin}`,
    `font-src data: ${expectedOrigin}`,
    `media-src ${expectedOrigin}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export interface AssetRequestEvaluationInput {
  method: string;
  url: string;
  initiatorOrigin?: string | null;
  rangeHeader?: string | null;
}

export async function evaluateAssetProtocolRequest(
  req: AssetRequestEvaluationInput,
  activeSessionId: string,
  canonicalSessionRoot: string,
  expectedEntryPath: string
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const segments = validateRawAssetUrl(req.url);
  if (!segments) {
    return new Response("Access Denied: Raw Path Traversal or Invalid Format", { status: 403 });
  }

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return new Response("Access Denied: Malformed URL", { status: 403 });
  }

  const expectedOrigin = `mf-asset://${activeSessionId}`;
  if (
    url.protocol !== "mf-asset:" ||
    url.hostname !== activeSessionId ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return new Response("Access Denied: Invalid Session Origin", { status: 403 });
  }

  const normalizedLogicalPath = "/" + segments.join("/");
  if (req.initiatorOrigin === undefined) {
    if (normalizedLogicalPath !== expectedEntryPath) {
      return new Response("Access Denied: Browser-Started Non-Entry Request Prohibited", {
        status: 403,
      });
    }
  } else {
    if (
      req.initiatorOrigin === null ||
      req.initiatorOrigin === "null" ||
      req.initiatorOrigin === "" ||
      req.initiatorOrigin !== expectedOrigin
    ) {
      return new Response("Access Denied: Invalid, Empty, or Opaque Initiator Origin", {
        status: 403,
      });
    }
  }

  const contained = resolveSafeContainedPathSync(canonicalSessionRoot, segments);
  if (!contained.ok) {
    return new Response(contained.reason, { status: contained.status });
  }

  const ext = path.extname(contained.canonicalFilePath).toLowerCase();
  const mimeType = PREVIEW_ASSET_MIME_MAP[ext];
  if (!mimeType) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  const fileHandle = await fsPromises.open(contained.canonicalFilePath, "r");
  let fileStats: fs.Stats;
  try {
    fileStats = await fileHandle.stat();
    if (!fileStats.isFile()) {
      await fileHandle.close();
      return new Response("Access Denied: Not a Regular File", { status: 403 });
    }
  } catch (err) {
    await fileHandle.close();
    throw err;
  }

  const totalSize = fileStats.size;
  const isEntryDocument =
    normalizedLogicalPath === expectedEntryPath && (ext === ".html" || ext === ".htm");

  const baseHeaders: Record<string, string> = {
    "Content-Type": mimeType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };

  if (isEntryDocument) {
    baseHeaders["Content-Security-Policy"] = buildPreviewEntryCsp(expectedOrigin);
  }

  if (req.method === "HEAD") {
    await fileHandle.close();
    return new Response(null, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(totalSize) },
    });
  }

  const rangeResult = parseByteRange(req.rangeHeader ?? null, totalSize);
  if (rangeResult.kind === "unsatisfiable") {
    await fileHandle.close();
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${totalSize}` },
    });
  }

  if (totalSize === 0) {
    await fileHandle.close();
    return new Response(new Uint8Array(0), {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": "0" },
    });
  }

  const start = rangeResult.kind === "partial" ? rangeResult.start : 0;
  const end = rangeResult.kind === "partial" ? rangeResult.end : totalSize - 1;
  const status = rangeResult.kind === "partial" ? 206 : 200;

  if (rangeResult.kind === "partial") {
    baseHeaders["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
  }
  baseHeaders["Content-Length"] = String(end - start + 1);

  const nodeStream = fileHandle.createReadStream({ start, end, autoClose: true });
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return new Response(webStream, { status, headers: baseHeaders });
}
