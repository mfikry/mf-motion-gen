import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";

export function computeBufferSha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function computeFileSha256Sync(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

export function computeManifestDigestSha256(entries: ReadonlyArray<[string, string]>): string {
  const hash = crypto.createHash("sha256");
  const sorted = [...entries].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [relPath, fileHash] of sorted) {
    hash.update(`${relPath}:${fileHash}\n`);
  }
  return hash.digest("hex");
}

/**
 * Applies the read-only file attribute (0o444 / Windows FILE_ATTRIBUTE_READONLY) across an
 * isolated working copy directory after import verification completes.
 *
 * NOTE: On Windows, 0o444 sets the DOS read-only attribute rather than a strict current-user
 * OS ACL; this is best-effort protection against accidental modification, not a security
 * boundary. Zero filesystem/Node access in the untrusted Preview Renderer remains the
 * primary security boundary.
 */
export function applyReadOnlyAttributeSync(rootDir: string): void {
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        fs.chmodSync(full, 0o444);
      }
    }
  };
  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }
}

function makeWritableRecursiveSync(dir: string): void {
  if (!fs.existsSync(dir)) return;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(dir);
    } catch {
      // Ignore
    }
    return;
  }
  if (stat.isDirectory()) {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      // Best-effort on Windows
    }
    for (const name of fs.readdirSync(dir)) {
      makeWritableRecursiveSync(path.join(dir, name));
    }
  } else {
    try {
      fs.chmodSync(dir, 0o666);
    } catch {
      // Ignore
    }
  }
}

export function purgeSessionDirectorySync(tempDir: string): void {
  if (!tempDir || !fs.existsSync(tempDir)) return;
  makeWritableRecursiveSync(tempDir);
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export async function purgeSessionDirectoryAsync(tempDir: string): Promise<void> {
  if (!tempDir || !fs.existsSync(tempDir)) return;
  makeWritableRecursiveSync(tempDir);
  await fsPromises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
