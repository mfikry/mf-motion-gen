import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  applyReadOnlyAttributeSync,
  computeManifestDigestSha256,
  purgeSessionDirectorySync,
} from "./sessionFsUtils.js";

export const MAX_ZIP_ENTRIES = 1000;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MB
export const MAX_ZIP_COMPRESSION_RATIO = 100; // 100:1

export type ZipSecurityCode =
  | "ZIP_INVALID_ARCHIVE"
  | "ZIP_UNSUPPORTED_ZIP64"
  | "ZIP_ENCRYPTED_FORBIDDEN"
  | "ZIP_UNSUPPORTED_METHOD"
  | "ZIP_MAX_ENTRIES_EXCEEDED"
  | "ZIP_MAX_UNCOMPRESSED_SIZE_EXCEEDED"
  | "ZIP_COMPRESSION_RATIO_EXCEEDED"
  | "ZIP_SYMLINK_FORBIDDEN"
  | "ZIP_HARDLINK_FORBIDDEN"
  | "ZIP_DRIVE_OR_ADS_FORBIDDEN"
  | "ZIP_ABSOLUTE_PATH_FORBIDDEN"
  | "ZIP_ENCODED_TRAVERSAL_FORBIDDEN"
  | "ZIP_PATH_TRAVERSAL_FORBIDDEN"
  | "ZIP_WINDOWS_TRAILING_DOT_SPACE_FORBIDDEN"
  | "ZIP_WINDOWS_RESERVED_NAME"
  | "ZIP_DUPLICATE_CASE_INSENSITIVE_PATH"
  | "ZIP_CRC_MISMATCH";

export class ZipSecurityError extends Error {
  readonly code: ZipSecurityCode;

  constructor(code: ZipSecurityCode, message: string) {
    super(message);
    this.name = "ZipSecurityError";
    this.code = code;
  }
}

export interface SecureZipLimits {
  maxEntries?: number;
  maxUncompressedBytes?: number;
  maxCompressionRatio?: number;
}

export interface SecureZipExtractResult {
  zipSha256: string;
  targetDir: string;
  entryCount: number;
  fileCount: number;
  totalUncompressedBytes: number;
  fileSha256ByRelPath: Record<string, string>;
  manifestDigestSha256: string;
}

interface ParsedCdEntry {
  relPath: string;
  segments: string[];
  isDirectory: boolean;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const WINDOWS_RESERVED_NAME_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, buf: Buffer): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function validateAndNormalizeZipEntryPath(rawName: string): {
  isDirectory: boolean;
  relPath: string;
  segments: string[];
} {
  if (!rawName || rawName.includes("\0")) {
    throw new ZipSecurityError("ZIP_PATH_TRAVERSAL_FORBIDDEN", `Empty or NUL-byte ZIP entry path`);
  }

  if (/%(2e|2f|5c|25|00|3a)/i.test(rawName)) {
    throw new ZipSecurityError(
      "ZIP_ENCODED_TRAVERSAL_FORBIDDEN",
      `Percent-encoded path trick rejected in ZIP entry: "${rawName}"`
    );
  }

  // Reject Windows UNC paths, drive prefixes, and any colon (NTFS ADS / drive letter)
  if (rawName.startsWith("\\\\") || rawName.startsWith("//") || /^[a-zA-Z]:/.test(rawName) || rawName.includes(":")) {
    throw new ZipSecurityError(
      "ZIP_DRIVE_OR_ADS_FORBIDDEN",
      `Drive letter, UNC path, or colon rejected in ZIP entry: "${rawName}"`
    );
  }

  if (rawName.startsWith("/") || rawName.startsWith("\\")) {
    throw new ZipSecurityError(
      "ZIP_ABSOLUTE_PATH_FORBIDDEN",
      `Root-absolute ZIP entry path rejected: "${rawName}"`
    );
  }

  const slashNormalized = rawName.replace(/\\/g, "/");
  const isDirectory = slashNormalized.endsWith("/");
  const trimmed = isDirectory ? slashNormalized.slice(0, -1) : slashNormalized;

  if (!trimmed) {
    throw new ZipSecurityError("ZIP_PATH_TRAVERSAL_FORBIDDEN", `Invalid root-only ZIP entry path: "${rawName}"`);
  }

  if (trimmed.includes("//")) {
    throw new ZipSecurityError("ZIP_PATH_TRAVERSAL_FORBIDDEN", `Empty path segment rejected in ZIP entry: "${rawName}"`);
  }

  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      throw new ZipSecurityError(
        "ZIP_PATH_TRAVERSAL_FORBIDDEN",
        `Dot-segment traversal rejected in ZIP entry: "${rawName}"`
      );
    }
    if (/[. ]$/.test(seg)) {
      throw new ZipSecurityError(
        "ZIP_WINDOWS_TRAILING_DOT_SPACE_FORBIDDEN",
        `Windows trailing dot or space rejected in ZIP entry segment: "${rawName}"`
      );
    }
    if (WINDOWS_RESERVED_NAME_RE.test(seg)) {
      throw new ZipSecurityError(
        "ZIP_WINDOWS_RESERVED_NAME",
        `Windows reserved DOS device name rejected in ZIP entry: "${rawName}"`
      );
    }
  }

  return { isDirectory, relPath: segments.join("/"), segments };
}

function inspectCentralDirectoryExtraFields(extraBuf: Buffer, versionMadeBy: number): void {
  // Scan ZIP extra subfields for Info-ZIP hardlink or Unix symlink hints
  let offset = 0;
  while (offset + 4 <= extraBuf.length) {
    const headerId = extraBuf.readUInt16LE(offset);
    const dataSize = extraBuf.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + dataSize > extraBuf.length) break;
    // PKWARE / Info-ZIP hardlink/Unix link markers: 0x000d with link metadata or custom hardlink tags
    // Reject ASi symlink flag if present in 0x756e (ASi Unix) mode
    if (headerId === 0x756e && dataSize >= 6) {
      const mode = extraBuf.readUInt16LE(offset + 4);
      const fmt = mode & 0o170000;
      if (fmt === 0o120000) {
        throw new ZipSecurityError("ZIP_SYMLINK_FORBIDDEN", "ASi Unix symlink rejected in ZIP archive");
      }
    }
    offset += dataSize;
  }
  void versionMadeBy;
}

function findEocdOffset(tailBuf: Buffer): number {
  // Search backwards for End of Central Directory signature 0x06054b50
  for (let i = tailBuf.length - 22; i >= 0; i--) {
    if (tailBuf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = tailBuf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === tailBuf.length) {
        return i;
      }
    }
  }
  return -1;
}

async function readRange(fh: fsPromises.FileHandle, start: number, length: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await fh.read(buf, total, length - total, start + total);
    if (bytesRead === 0) {
      throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", "Unexpected EOF reading ZIP structure");
    }
    total += bytesRead;
  }
  return buf;
}

async function inflateEntryWithQuotas(
  fh: fsPromises.FileHandle,
  dataStart: number,
  compressedSize: number,
  compressionMethod: number,
  expectedCrc32: number,
  maxAllowedEntryBytes: number,
  remainingGlobalBudgetBytes: number,
  destPath: string
): Promise<{ actualBytes: number; sha256: string }> {
  const outHandle = await fsPromises.open(destPath, "wx", 0o600);
  const sha = crypto.createHash("sha256");
  let runningCrc = 0;
  let actualBytes = 0;

  try {
    if (compressionMethod === 0) {
      // Stored: stream fixed byte count directly
      let offset = dataStart;
      let remaining = compressedSize;
      const buf = Buffer.allocUnsafe(64 * 1024);
      while (remaining > 0) {
        const toRead = Math.min(buf.length, remaining);
        const { bytesRead } = await fh.read(buf, 0, toRead, offset);
        if (bytesRead === 0) {
          throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", "Truncated stored ZIP entry");
        }
        const slice = buf.subarray(0, bytesRead);
        actualBytes += bytesRead;
        if (actualBytes > maxAllowedEntryBytes || actualBytes > remainingGlobalBudgetBytes) {
          throw new ZipSecurityError(
            "ZIP_MAX_UNCOMPRESSED_SIZE_EXCEEDED",
            "ZIP entry exceeded allowed uncompressed byte quota during extraction"
          );
        }
        runningCrc = updateCrc32(runningCrc, slice);
        sha.update(slice);
        await outHandle.write(slice);
        offset += bytesRead;
        remaining -= bytesRead;
      }
    } else if (compressionMethod === 8) {
      // Deflate: stream compressed chunks incrementally into InflateRaw while enforcing hard output caps mid-stream
      await new Promise<void>((resolve, reject) => {
        const inflater = zlib.createInflateRaw({ maxOutputLength: maxAllowedEntryBytes + 1 });
        let settled = false;
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          inflater.destroy();
          reject(err);
        };

        inflater.on("data", (chunk: Buffer) => {
          actualBytes += chunk.length;
          if (actualBytes > remainingGlobalBudgetBytes) {
            fail(
              new ZipSecurityError(
                "ZIP_MAX_UNCOMPRESSED_SIZE_EXCEEDED",
                `Total decompressed ZIP size exceeded hard limit during stream inflation`
              )
            );
            return;
          }
          if (actualBytes > maxAllowedEntryBytes) {
            fail(
              new ZipSecurityError(
                "ZIP_COMPRESSION_RATIO_EXCEEDED",
                `Actual uncompressed bytes (${actualBytes}) exceeded compression ratio / declared quota (${maxAllowedEntryBytes})`
              )
            );
            return;
          }
          runningCrc = updateCrc32(runningCrc, chunk);
          sha.update(chunk);
          fs.writeSync(outHandle.fd, chunk);
        });

        inflater.on("error", (err) => {
          const msg = err?.message || String(err);
          if (msg.includes("maxOutputLength") || msg.includes("Cannot create a Buffer")) {
            fail(
              new ZipSecurityError(
                "ZIP_COMPRESSION_RATIO_EXCEEDED",
                "ZIP entry inflation aborted mid-stream by output quota guard"
              )
            );
          } else {
            fail(new ZipSecurityError("ZIP_INVALID_ARCHIVE", `Deflate corruption: ${msg}`));
          }
        });

        inflater.on("end", () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });

        void (async () => {
          try {
            let offset = dataStart;
            let remaining = compressedSize;
            const chunkBuf = Buffer.allocUnsafe(64 * 1024);
            while (remaining > 0 && !settled) {
              const toRead = Math.min(chunkBuf.length, remaining);
              const { bytesRead } = await fh.read(chunkBuf, 0, toRead, offset);
              if (bytesRead === 0) {
                fail(new ZipSecurityError("ZIP_INVALID_ARCHIVE", "Truncated deflate ZIP stream"));
                return;
              }
              offset += bytesRead;
              remaining -= bytesRead;
              const copy = Buffer.from(chunkBuf.subarray(0, bytesRead));
              if (!inflater.write(copy) && !settled) {
                await new Promise<void>((r) => inflater.once("drain", r));
              }
            }
            if (!settled) inflater.end();
          } catch (readErr) {
            fail(readErr instanceof Error ? readErr : new Error(String(readErr)));
          }
        })();
      });
    } else {
      throw new ZipSecurityError(
        "ZIP_UNSUPPORTED_METHOD",
        `Unsupported ZIP compression method ${compressionMethod}`
      );
    }

    if (runningCrc !== expectedCrc32) {
      throw new ZipSecurityError(
        "ZIP_CRC_MISMATCH",
        `CRC-32 mismatch for ${path.basename(destPath)} (expected ${expectedCrc32.toString(16)}, got ${runningCrc.toString(16)})`
      );
    }

    return { actualBytes, sha256: sha.digest("hex") };
  } finally {
    await outHandle.close().catch(() => {});
  }
}

/**
 * Parses Central Directory headers BEFORE writing anything to disk, enforces all
 * security boundaries (limits, ratio, traversal, symlinks/hardlinks, Windows paths,
 * case-insensitive duplicates), streams decompression under live byte caps,
 * and applies best-effort read-only file attributes (0o444, not an OS ACL) upon
 * verification. Zero-filesystem-access in the untrusted Preview Renderer remains
 * the primary security boundary.
 */
export async function extractZipSecurely(
  zipFilePath: string,
  targetDir: string,
  limits: SecureZipLimits = {}
): Promise<SecureZipExtractResult> {
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxUncompressedBytes = limits.maxUncompressedBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;
  const maxRatio = limits.maxCompressionRatio ?? MAX_ZIP_COMPRESSION_RATIO;

  if (!fs.existsSync(zipFilePath)) {
    throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", `ZIP file not found: "${zipFilePath}"`);
  }

  const stat = fs.lstatSync(zipFilePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ZipSecurityError("ZIP_SYMLINK_FORBIDDEN", "Source ZIP must be a regular non-symlink file");
  }

  const zipBytes = stat.size;
  if (zipBytes < 22) {
    throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", "File is too small to be a valid ZIP archive");
  }

  const fh = await fsPromises.open(zipFilePath, "r");
  let zipSha256: string;

  try {
    // Hash source archive immutability signature
    {
      const hash = crypto.createHash("sha256");
      const buf = Buffer.allocUnsafe(64 * 1024);
      let pos = 0;
      while (pos < zipBytes) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        hash.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
      zipSha256 = hash.digest("hex");
    }

    const tailSize = Math.min(zipBytes, 65557);
    const tailStart = zipBytes - tailSize;
    const tailBuf = await readRange(fh, tailStart, tailSize);
    const eocdRel = findEocdOffset(tailBuf);
    if (eocdRel < 0) {
      throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", "Missing End of Central Directory record");
    }

    const diskNo = tailBuf.readUInt16LE(eocdRel + 4);
    const cdDiskNo = tailBuf.readUInt16LE(eocdRel + 6);
    const totalEntries = tailBuf.readUInt16LE(eocdRel + 10);
    const cdSize = tailBuf.readUInt32LE(eocdRel + 12);
    const cdOffset = tailBuf.readUInt32LE(eocdRel + 16);

    if (diskNo !== 0 || cdDiskNo !== 0) {
      throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", "Multi-disk ZIP archives are disallowed");
    }
    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipSecurityError("ZIP_UNSUPPORTED_ZIP64", "ZIP64 archives are disallowed");
    }
    if (totalEntries > maxEntries) {
      throw new ZipSecurityError(
        "ZIP_MAX_ENTRIES_EXCEEDED",
        `ZIP archive entry count (${totalEntries}) exceeds limit (${maxEntries})`
      );
    }
    if (cdOffset + cdSize > tailStart + eocdRel) {
      throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", "Corrupt Central Directory bounds");
    }

    const cdBuf = await readRange(fh, cdOffset, cdSize);
    let cursor = 0;
    let declaredTotalBytes = 0;
    const parsedEntries: ParsedCdEntry[] = [];
    const seenLowerFiles = new Set<string>();
    const seenLowerDirs = new Set<string>();

    for (let i = 0; i < totalEntries; i++) {
      if (cursor + 46 > cdBuf.length || cdBuf.readUInt32LE(cursor) !== 0x02014b50) {
        throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", `Invalid Central Directory entry at index ${i}`);
      }

      const versionMadeBy = cdBuf.readUInt16LE(cursor + 4);
      const flags = cdBuf.readUInt16LE(cursor + 8);
      const compressionMethod = cdBuf.readUInt16LE(cursor + 10);
      const crc32 = cdBuf.readUInt32LE(cursor + 16);
      const compressedSize = cdBuf.readUInt32LE(cursor + 20);
      const uncompressedSize = cdBuf.readUInt32LE(cursor + 24);
      const fileNameLen = cdBuf.readUInt16LE(cursor + 28);
      const extraLen = cdBuf.readUInt16LE(cursor + 30);
      const commentLen = cdBuf.readUInt16LE(cursor + 32);
      const externalFileAttr = cdBuf.readUInt32LE(cursor + 38);
      const localHeaderOffset = cdBuf.readUInt32LE(cursor + 42);

      const recordEnd = cursor + 46 + fileNameLen + extraLen + commentLen;
      if (recordEnd > cdBuf.length) {
        throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", `Truncated Central Directory record at index ${i}`);
      }

      if ((flags & 0x01) !== 0) {
        throw new ZipSecurityError("ZIP_ENCRYPTED_FORBIDDEN", "Encrypted ZIP entries are forbidden");
      }

      if (compressionMethod !== 0 && compressionMethod !== 8) {
        throw new ZipSecurityError(
          "ZIP_UNSUPPORTED_METHOD",
          `Unsupported ZIP compression method ${compressionMethod}`
        );
      }

      const rawName = cdBuf.subarray(cursor + 46, cursor + 46 + fileNameLen).toString("utf8");
      const extraBuf = cdBuf.subarray(cursor + 46 + fileNameLen, cursor + 46 + fileNameLen + extraLen);

      // Check Unix file mode bits & Windows reparse point bit
      const unixMode = (externalFileAttr >>> 16) & 0xffff;
      const unixType = unixMode & 0o170000;
      if (unixType === 0o120000) {
        throw new ZipSecurityError("ZIP_SYMLINK_FORBIDDEN", `Symbolic link entry rejected: "${rawName}"`);
      }
      if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
        throw new ZipSecurityError(
          "ZIP_HARDLINK_FORBIDDEN",
          `Special filesystem/link entry mode (${unixType.toString(8)}) rejected: "${rawName}"`
        );
      }
      if ((externalFileAttr & 0x400) !== 0) {
        throw new ZipSecurityError("ZIP_SYMLINK_FORBIDDEN", `Windows reparse-point entry rejected: "${rawName}"`);
      }

      inspectCentralDirectoryExtraFields(extraBuf, versionMadeBy);

      const norm = validateAndNormalizeZipEntryPath(rawName);
      const lowerRel = norm.relPath.toLowerCase();

      if (norm.isDirectory) {
        if (seenLowerFiles.has(lowerRel)) {
          throw new ZipSecurityError(
            "ZIP_DUPLICATE_CASE_INSENSITIVE_PATH",
            `Directory collides case-insensitively with file: "${norm.relPath}"`
          );
        }
        seenLowerDirs.add(lowerRel);
      } else {
        if (seenLowerFiles.has(lowerRel) || seenLowerDirs.has(lowerRel)) {
          throw new ZipSecurityError(
            "ZIP_DUPLICATE_CASE_INSENSITIVE_PATH",
            `Duplicate case-insensitive ZIP entry rejected: "${norm.relPath}"`
          );
        }
        seenLowerFiles.add(lowerRel);
      }

      if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
        throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", `Stored entry size mismatch on "${norm.relPath}"`);
      }

      declaredTotalBytes += uncompressedSize;
      if (declaredTotalBytes > maxUncompressedBytes) {
        throw new ZipSecurityError(
          "ZIP_MAX_UNCOMPRESSED_SIZE_EXCEEDED",
          `Total declared uncompressed size exceeds ${maxUncompressedBytes} bytes`
        );
      }

      if (!norm.isDirectory) {
        if (compressedSize === 0 && uncompressedSize > 0) {
          throw new ZipSecurityError(
            "ZIP_COMPRESSION_RATIO_EXCEEDED",
            `Zero compressed size with non-zero payload rejected: "${norm.relPath}"`
          );
        }
        if (compressedSize > 0 && uncompressedSize / compressedSize > maxRatio) {
          throw new ZipSecurityError(
            "ZIP_COMPRESSION_RATIO_EXCEEDED",
            `Entry "${norm.relPath}" compression ratio exceeds ${maxRatio}:1`
          );
        }
      }

      parsedEntries.push({
        relPath: norm.relPath,
        segments: norm.segments,
        isDirectory: norm.isDirectory,
        compressionMethod,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });

      cursor = recordEnd;
    }

    // Phase 2: All Central Directory checks passed -> extract safely into clean targetDir
    fs.mkdirSync(targetDir, { recursive: true });
    const canonicalTarget = fs.realpathSync(targetDir);

    let runningActualTotalBytes = 0;
    let fileCount = 0;
    const fileSha256ByRelPath: Record<string, string> = {};

    try {
      for (const entry of parsedEntries) {
        const destPath = path.join(canonicalTarget, ...entry.segments);
        const relCheck = path.relative(canonicalTarget, destPath);
        if (!relCheck || relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
          throw new ZipSecurityError("ZIP_PATH_TRAVERSAL_FORBIDDEN", `Resolved path escapes target root: "${entry.relPath}"`);
        }

        if (entry.isDirectory) {
          fs.mkdirSync(destPath, { recursive: true });
          continue;
        }

        const parentDir = path.dirname(destPath);
        fs.mkdirSync(parentDir, { recursive: true });

        if (entry.localHeaderOffset + 30 > cdOffset) {
          throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", `Invalid local header offset on "${entry.relPath}"`);
        }

        const lfh = await readRange(fh, entry.localHeaderOffset, 30);
        if (lfh.readUInt32LE(0) !== 0x04034b50) {
          throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", `Missing local header signature on "${entry.relPath}"`);
        }
        const lfhNameLen = lfh.readUInt16LE(26);
        const lfhExtraLen = lfh.readUInt16LE(28);
        const dataStart = entry.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
        if (dataStart + entry.compressedSize > cdOffset) {
          throw new ZipSecurityError("ZIP_INVALID_ARCHIVE", `Compressed data exceeds archive bounds on "${entry.relPath}"`);
        }

        // Compute runtime cap per entry using ratio limit AND remaining global budget
        const maxEntryByRatio =
          entry.compressedSize === 0 ? 0 : Math.min(maxUncompressedBytes, entry.compressedSize * maxRatio);
        const maxAllowedEntryBytes = Math.min(maxEntryByRatio, entry.uncompressedSize);
        const remainingBudget = maxUncompressedBytes - runningActualTotalBytes;

        const { actualBytes, sha256 } = await inflateEntryWithQuotas(
          fh,
          dataStart,
          entry.compressedSize,
          entry.compressionMethod,
          entry.crc32,
          maxAllowedEntryBytes,
          remainingBudget,
          destPath
        );

        runningActualTotalBytes += actualBytes;
        fileCount += 1;
        fileSha256ByRelPath[entry.relPath] = sha256;
      }

      // Phase 3: Apply best-effort read-only file attribute (not an OS ACL) against accidental writes
      applyReadOnlyAttributeSync(canonicalTarget);

      const manifestDigestSha256 = computeManifestDigestSha256(Object.entries(fileSha256ByRelPath));
      return {
        zipSha256,
        targetDir: canonicalTarget,
        entryCount: parsedEntries.length,
        fileCount,
        totalUncompressedBytes: runningActualTotalBytes,
        fileSha256ByRelPath,
        manifestDigestSha256,
      };
    } catch (err) {
      purgeSessionDirectorySync(canonicalTarget);
      throw err;
    }
  } finally {
    await fh.close().catch(() => {});
  }
}
