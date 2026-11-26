import fs from "node:fs";
import path from "node:path";
import type { AssetTreeNode, AssetValidationState } from "../../shared/previewContracts.js";
import type { PreflightResult } from "../../shared/renderContracts.js";
import { PREVIEW_ASSET_MIME_MAP } from "../security/assetProtocolCore.js";
import {
  applyReadOnlyAttributeSync,
  computeFileSha256Sync,
  computeManifestDigestSha256,
  purgeSessionDirectorySync,
} from "./sessionFsUtils.js";

export const MAX_PROJECT_FILES = 1000;
export const MAX_PROJECT_BYTES = 500 * 1024 * 1024; // 500 MB

export class ProjectImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectImportError";
    this.code = code;
  }
}

export interface StagedProjectCopyResult {
  workingDir: string;
  importKind: "folder" | "zip";
  htmlCandidates: string[];
  fileCount: number;
  totalBytes: number;
  sourceSha256ByRelPath: Record<string, string>;
  manifestDigestSha256: string;
}

const RESERVED_WIN_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

function assertSafeRelativeSegments(segments: string[], originalRel: string): void {
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || seg.includes(":") || /[. ]$/.test(seg)) {
      throw new ProjectImportError(
        "IMPORT_UNSAFE_PATH",
        `Unsafe relative path segment rejected during import: "${originalRel}"`
      );
    }
    if (RESERVED_WIN_RE.test(seg)) {
      throw new ProjectImportError(
        "IMPORT_WINDOWS_RESERVED_NAME",
        `Reserved Windows filename rejected: "${originalRel}"`
      );
    }
  }
}

export function discoverHtmlCandidates(rootDir: string): string[] {
  const candidates: string[] = [];
  const walk = (dir: string, prefixParts: string[]): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const relParts = [...prefixParts, ent.name];
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, relParts);
      } else if (ent.isFile() && /\.(?:html|htm)$/i.test(ent.name)) {
        candidates.push(relParts.join("/"));
      }
    }
  };
  walk(rootDir, []);

  // Prefer root-level index.html / index.htm first
  candidates.sort((a, b) => {
    const aIsRootIndex = /^index\.html?$/i.test(a) ? 0 : a.includes("/") ? 2 : 1;
    const bIsRootIndex = /^index\.html?$/i.test(b) ? 0 : b.includes("/") ? 2 : 1;
    if (aIsRootIndex !== bIsRootIndex) return aIsRootIndex - bIsRootIndex;
    return a.localeCompare(b);
  });
  return candidates;
}

/**
 * Copies a user-selected folder into an isolated working copy with best-effort read-only
 * file attributes (0o444; not an OS security ACL) without touching or writing anything into
 * the original source directory. Computes source SHA-256 hashes, enforces symlink/junction
 * rejection, case-insensitive uniqueness, and size/file limits. Zero-filesystem-access in
 * the untrusted Preview Renderer remains the primary security boundary.
 */
export function stageIsolatedFolderCopy(
  sourceFolderDir: string,
  targetWorkingDir: string
): StagedProjectCopyResult {
  if (!sourceFolderDir || !fs.existsSync(sourceFolderDir)) {
    throw new ProjectImportError("IMPORT_SOURCE_MISSING", `Selected folder does not exist: "${sourceFolderDir}"`);
  }

  const rootLstat = fs.lstatSync(sourceFolderDir);
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
    throw new ProjectImportError("IMPORT_SYMLINK_FORBIDDEN", "Root import folder cannot be a symlink or non-directory");
  }
  const canonicalSourceRoot = fs.realpathSync(sourceFolderDir);

  let fileCount = 0;
  let totalBytes = 0;
  const seenLower = new Set<string>();
  const sourceSha256ByRelPath: Record<string, string> = {};

  fs.mkdirSync(targetWorkingDir, { recursive: true });
  const canonicalTarget = fs.realpathSync(targetWorkingDir);

  try {
    const walkAndCopy = (currentSourceDir: string, relParts: string[]): void => {
      const entries = fs.readdirSync(currentSourceDir, { withFileTypes: true });
      for (const ent of entries) {
        const nextParts = [...relParts, ent.name];
        const relPosix = nextParts.join("/");
        assertSafeRelativeSegments(nextParts, relPosix);

        const lowerRel = relPosix.toLowerCase();
        if (seenLower.has(lowerRel)) {
          throw new ProjectImportError(
            "IMPORT_DUPLICATE_CASE_INSENSITIVE",
            `Duplicate case-insensitive path rejected: "${relPosix}"`
          );
        }
        seenLower.add(lowerRel);

        const srcPath = path.join(currentSourceDir, ent.name);
        const lstat = fs.lstatSync(srcPath);
        if (lstat.isSymbolicLink()) {
          throw new ProjectImportError(
            "IMPORT_SYMLINK_FORBIDDEN",
            `Symbolic links and NTFS junctions are prohibited in imported project: "${relPosix}"`
          );
        }

        const realPath = fs.realpathSync(srcPath);
        const relFromSource = path.relative(canonicalSourceRoot, realPath);
        if (!relFromSource || relFromSource.startsWith("..") || path.isAbsolute(relFromSource)) {
          throw new ProjectImportError(
            "IMPORT_CONTAINMENT_BREACH",
            `Source entry resolves outside selected folder: "${relPosix}"`
          );
        }

        const destPath = path.join(canonicalTarget, ...nextParts);

        if (lstat.isDirectory()) {
          fs.mkdirSync(destPath, { recursive: true });
          walkAndCopy(srcPath, nextParts);
        } else if (lstat.isFile()) {
          fileCount += 1;
          if (fileCount > MAX_PROJECT_FILES) {
            throw new ProjectImportError(
              "IMPORT_MAX_FILES_EXCEEDED",
              `Project exceeds maximum limit of ${MAX_PROJECT_FILES} files`
            );
          }
          totalBytes += lstat.size;
          if (totalBytes > MAX_PROJECT_BYTES) {
            throw new ProjectImportError(
              "IMPORT_MAX_BYTES_EXCEEDED",
              `Project exceeds maximum uncompressed size of ${MAX_PROJECT_BYTES} bytes`
            );
          }

          const srcSha = computeFileSha256Sync(srcPath);
          fs.copyFileSync(srcPath, destPath);
          const dstSha = computeFileSha256Sync(destPath);
          if (srcSha !== dstSha) {
            throw new ProjectImportError(
              "IMPORT_COPY_INTEGRITY_MISMATCH",
              `Integrity check failed after staging "${relPosix}"`
            );
          }
          sourceSha256ByRelPath[relPosix] = srcSha;
        }
      }
    };

    walkAndCopy(canonicalSourceRoot, []);
    const htmlCandidates = discoverHtmlCandidates(canonicalTarget);
    if (htmlCandidates.length === 0) {
      throw new ProjectImportError("IMPORT_NO_HTML_ENTRY", "No .html or .htm entry file found in selected folder");
    }

    applyReadOnlyAttributeSync(canonicalTarget);
    const manifestDigestSha256 = computeManifestDigestSha256(Object.entries(sourceSha256ByRelPath));

    return {
      workingDir: canonicalTarget,
      importKind: "folder",
      htmlCandidates,
      fileCount,
      totalBytes,
      sourceSha256ByRelPath,
      manifestDigestSha256,
    };
  } catch (err) {
    purgeSessionDirectorySync(canonicalTarget);
    throw err;
  }
}

/**
 * Builds a hierarchical Local Asset Tree for LeftPanel diagnostics:
 * shows directories/files, size, MIME/ext, entry indicator, verified/unused status,
 * unsupported extensions, and missing/blocked preflight diagnostics.
 */
export function buildLocalAssetTree(
  stageDir: string,
  entryFile: string,
  preflight: PreflightResult,
  hashesByRelPath?: Record<string, string>
): AssetTreeNode[] {
  const realRoot = fs.realpathSync(stageDir);
  const normEntry = entryFile.replace(/\\/g, "/");
  const verifiedSet = new Set(
    preflight.checkedLocalAssets.map((abs) => path.relative(realRoot, abs).replace(/\\/g, "/"))
  );

  const walk = (dir: string, parts: string[]): AssetTreeNode[] => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const nodes: AssetTreeNode[] = [];
    for (const ent of entries) {
      const nextParts = [...parts, ent.name];
      const relPosix = nextParts.join("/");
      const full = path.join(dir, ent.name);

      if (ent.isSymbolicLink()) {
        nodes.push({
          name: ent.name,
          relativePath: relPosix,
          kind: "file",
          validationStatus: "blocked",
          diagnosticMessage: "Symbolic link / junction prohibited",
        });
        continue;
      }

      if (ent.isDirectory()) {
        nodes.push({
          name: ent.name,
          relativePath: relPosix,
          kind: "directory",
          children: walk(full, nextParts),
        });
      } else if (ent.isFile()) {
        const stat = fs.statSync(full);
        const ext = path.extname(ent.name).toLowerCase();
        const mimeType = PREVIEW_ASSET_MIME_MAP[ext] ?? null;

        let validationStatus: AssetValidationState;
        let diagnosticMessage: string | undefined;

        if (relPosix === normEntry) {
          validationStatus = "entry";
        } else if (!mimeType) {
          validationStatus = "unsupported";
          diagnosticMessage = `Unsupported extension "${ext || "(none)"}" rejected by mf-asset://`;
        } else if (verifiedSet.has(relPosix)) {
          validationStatus = "verified";
        } else {
          validationStatus = "unused";
        }

        nodes.push({
          name: ent.name,
          relativePath: relPosix,
          kind: "file",
          extension: ext,
          mimeType,
          sizeBytes: stat.size,
          validationStatus,
          diagnosticMessage,
          sha256: hashesByRelPath?.[relPosix],
        });
      }
    }
    return nodes;
  };

  const treeNodes = walk(realRoot, []);

  // Append synthetic diagnostic items for preflight-missing or blocked references so UI surfaces them cleanly
  for (const blocker of preflight.blockers) {
    const isMissing = blocker.code === "MISSING_LOCAL_ASSET" || blocker.code === "MISSING_CSS_FONT";
    treeNodes.push({
      name: blocker.reference ?? blocker.code,
      relativePath: blocker.reference ?? blocker.code,
      kind: "file",
      validationStatus: isMissing ? "missing" : "blocked",
      diagnosticMessage: `[${blocker.code}] ${blocker.message}`,
    });
  }

  return treeNodes;
}
