import fs from "node:fs";
import path from "node:path";
import type {
  DiagnosticCodeDiffPreview,
} from "../../shared/previewContracts.js";
import { computeBufferSha256 } from "../import/sessionFsUtils.js";

export interface ServerFixProposalRecord {
  proposalId: string;
  sessionId: string;
  diagnosticId: string;
  title: string;
  targetFile: string;
  expectedBeforeSha256: string;
  beforeContent: string;
  afterContent: string;
  preview: DiagnosticCodeDiffPreview;
}

/**
 * Computes a clean line-by-line unified diff snippet showing context, removed (-),
 * and added (+) lines without relying on external diff binaries.
 */
export function buildUnifiedSnippetDiff(
  relFile: string,
  beforeText: string,
  afterText: string
): { beforeSnippet: string; afterSnippet: string; diffText: string } {
  const beforeLines = beforeText.split(/\r?\n/);
  const afterLines = afterText.split(/\r?\n/);

  let firstDiff = 0;
  while (
    firstDiff < beforeLines.length &&
    firstDiff < afterLines.length &&
    beforeLines[firstDiff] === afterLines[firstDiff]
  ) {
    firstDiff += 1;
  }

  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (
    beforeEnd >= firstDiff &&
    afterEnd >= firstDiff &&
    beforeLines[beforeEnd] === afterLines[afterEnd]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const ctxStart = Math.max(0, firstDiff - 2);
  const ctxBeforeEnd = Math.min(beforeLines.length - 1, beforeEnd + 2);
  const ctxAfterEnd = Math.min(afterLines.length - 1, afterEnd + 2);

  const beforeSlice = beforeLines.slice(ctxStart, ctxBeforeEnd + 1);
  const afterSlice = afterLines.slice(ctxStart, ctxAfterEnd + 1);

  const header = `--- a/${relFile}\n+++ b/${relFile}\n@@ -${ctxStart + 1},${beforeSlice.length} +${ctxStart + 1},${afterSlice.length} @@`;
  const diffRows: string[] = [header];

  for (let i = ctxStart; i < firstDiff; i += 1) {
    diffRows.push(`  ${beforeLines[i]}`);
  }
  for (let i = firstDiff; i <= beforeEnd; i += 1) {
    diffRows.push(`- ${beforeLines[i]}`);
  }
  for (let i = firstDiff; i <= afterEnd; i += 1) {
    diffRows.push(`+ ${afterLines[i]}`);
  }
  for (let i = beforeEnd + 1; i <= ctxBeforeEnd; i += 1) {
    diffRows.push(`  ${beforeLines[i]}`);
  }

  const formatNumbered = (lines: string[], startNum: number): string =>
    lines.map((line, idx) => `${String(startNum + idx).padStart(4, " ")} | ${line}`).join("\n");

  return {
    beforeSnippet: formatNumbered(beforeSlice, ctxStart + 1),
    afterSnippet: formatNumbered(afterSlice, ctxStart + 1),
    diffText: diffRows.join("\n"),
  };
}

/**
 * Applies a server-owned fix proposal strictly inside an isolated working copy directory,
 * refusing any original-file session, path traversal, symlink escape, or stale SHA-256 mismatch.
 * Temporarily clears Windows read-only attribute only for the verified working-copy file.
 */
export function applyFixProposalToWorkingCopy(options: {
  stageDir: string;
  sourceMode: "original_file" | "working_copy";
  ownedTempDir: string | null;
  proposal: ServerFixProposalRecord;
}): { modifiedFile: string; newSha256: string } {
  if (options.sourceMode !== "working_copy" || !options.ownedTempDir) {
    throw new Error("Refused to modify composition: fixes may only be applied to an isolated working copy");
  }

  const realRoot = fs.realpathSync(options.stageDir);
  const candidate = path.resolve(realRoot, ...options.proposal.targetFile.split("/"));
  const relFromRoot = path.relative(realRoot, candidate);
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    throw new Error(`Target file "${options.proposal.targetFile}" escapes working copy boundary`);
  }

  if (!fs.existsSync(candidate)) {
    throw new Error(`Target working-copy file no longer exists: "${options.proposal.targetFile}"`);
  }

  const lstat = fs.lstatSync(candidate);
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    throw new Error(`Refused non-regular or symbolic link target: "${options.proposal.targetFile}"`);
  }

  const realTarget = fs.realpathSync(candidate);
  const relReal = path.relative(realRoot, realTarget);
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
    throw new Error(`Target realpath escapes working copy boundary: "${options.proposal.targetFile}"`);
  }

  const currentBuf = fs.readFileSync(realTarget);
  const currentSha = computeBufferSha256(currentBuf);
  if (currentSha !== options.proposal.expectedBeforeSha256) {
    throw new Error("Working-copy file changed since diff was generated; re-analyze before applying");
  }

  const prevMode = fs.statSync(realTarget).mode;
  const wasReadOnly = (prevMode & 0o222) === 0;
  try {
    if (wasReadOnly) {
      fs.chmodSync(realTarget, 0o666);
    }
    fs.writeFileSync(realTarget, options.proposal.afterContent, "utf8");
  } finally {
    if (wasReadOnly) {
      try {
        fs.chmodSync(realTarget, 0o444);
      } catch {
        // Best-effort restore
      }
    }
  }

  return {
    modifiedFile: options.proposal.targetFile,
    newSha256: computeBufferSha256(Buffer.from(options.proposal.afterContent, "utf8")),
  };
}
