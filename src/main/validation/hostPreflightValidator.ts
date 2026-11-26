import fs from "node:fs";
import path from "node:path";
import type {
  PreflightFinding,
  PreflightOptions,
  PreflightResult,
} from "../../shared/renderContracts.js";

const FONT_EXT_RE = /\.(woff2?|ttf|otf|eot)$/i;
const EXTERNAL_URL_RE = /^(?:https?:)?\/\//i;
const FONT_HOST_RE = /fonts\.(?:googleapis|gstatic)\.com|use\.typekit\.net|fonts\.cdnfonts\.com/i;
const SKIP_SCHEME_RE = /^(?:data:|blob:|about:|javascript:|mailto:|tel:|#)/i;

function stripCommentsFromHtml(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function stripCommentsFromCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function cleanRefPath(rawRef: string): string {
  const noQuery = rawRef.split(/[?#]/, 1)[0] ?? "";
  return noQuery.trim();
}

function containsUnsafeColonOrAds(rawSegment: string): boolean {
  if (rawSegment.includes("\0")) return true;
  if (rawSegment.includes(":")) return true;
  if (/%3a/i.test(rawSegment)) return true;
  return false;
}

function resolveContainedFile(
  realStageDir: string,
  baseDir: string,
  rawRef: string
): { ok: true; resolvedPath: string } | { ok: false; finding: PreflightFinding } {
  const cleaned = cleanRefPath(rawRef);
  if (!cleaned) {
    return {
      ok: false,
      finding: {
        code: "UNSAFE_ASSET_PATH",
        severity: "error",
        message: `Empty local asset reference "${rawRef}"`,
        reference: rawRef,
      },
    };
  }

  if (/^file:/i.test(rawRef)) {
    return {
      ok: false,
      finding: {
        code: "UNSAFE_ASSET_PATH",
        severity: "error",
        message: `Direct file:// URI is forbidden: "${rawRef}"`,
        reference: rawRef,
      },
    };
  }

  if (containsUnsafeColonOrAds(cleaned)) {
    return {
      ok: false,
      finding: {
        code: "WINDOWS_ADS_REJECTED",
        severity: "error",
        message: `Colon / Windows Alternate Data Stream pattern rejected in path: "${rawRef}"`,
        reference: rawRef,
      },
    };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(cleaned);
  } catch {
    decoded = cleaned;
  }

  if (containsUnsafeColonOrAds(decoded)) {
    return {
      ok: false,
      finding: {
        code: "WINDOWS_ADS_REJECTED",
        severity: "error",
        message: `Encoded colon / ADS pattern rejected in path: "${rawRef}"`,
        reference: rawRef,
      },
    };
  }

  if (path.isAbsolute(decoded) || /^[\\/]/.test(decoded)) {
    return {
      ok: false,
      finding: {
        code: "UNSAFE_ASSET_PATH",
        severity: "error",
        message: `Root-absolute asset paths are disallowed (must be project-relative): "${rawRef}"`,
        reference: rawRef,
      },
    };
  }

  const candidate = path.resolve(baseDir, decoded);
  const relFromStage = path.relative(realStageDir, candidate);
  if (relFromStage.startsWith("..") || path.isAbsolute(relFromStage)) {
    return {
      ok: false,
      finding: {
        code: "UNSAFE_ASSET_PATH",
        severity: "error",
        message: `Path traversal outside composition root rejected: "${rawRef}"`,
        reference: rawRef,
        resolvedPath: candidate,
      },
    };
  }

  // Check intermediate directory segments + leaf for symlinks or Windows junctions
  const relSegments = relFromStage.split(path.sep).filter(Boolean);
  let walk = realStageDir;
  for (const seg of relSegments) {
    walk = path.join(walk, seg);
    if (!fs.existsSync(walk)) {
      return {
        ok: false,
        finding: {
          code: FONT_EXT_RE.test(cleaned) ? "MISSING_CSS_FONT" : "MISSING_LOCAL_ASSET",
          severity: "error",
          message: `Missing local asset on disk: "${rawRef}"`,
          reference: rawRef,
          resolvedPath: candidate,
        },
      };
    }
    try {
      if (fs.lstatSync(walk).isSymbolicLink()) {
        return {
          ok: false,
          finding: {
            code: "ASSET_SYMLINK_ESCAPE",
            severity: "error",
            message: `Symbolic link or NTFS junction prohibited in asset path: "${rawRef}"`,
            reference: rawRef,
            resolvedPath: walk,
          },
        };
      }
    } catch {
      return {
        ok: false,
        finding: {
          code: "MISSING_LOCAL_ASSET",
          severity: "error",
          message: `Unreadable asset path segment: "${rawRef}"`,
          reference: rawRef,
          resolvedPath: walk,
        },
      };
    }
  }

  if (!fs.existsSync(candidate)) {
    return {
      ok: false,
      finding: {
        code: FONT_EXT_RE.test(cleaned) ? "MISSING_CSS_FONT" : "MISSING_LOCAL_ASSET",
        severity: "error",
        message: `Missing local asset on disk: "${rawRef}"`,
        reference: rawRef,
        resolvedPath: candidate,
      },
    };
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(candidate);
  } catch {
    return {
      ok: false,
      finding: {
        code: "MISSING_LOCAL_ASSET",
        severity: "error",
        message: `Unreadable local asset: "${rawRef}"`,
        reference: rawRef,
        resolvedPath: candidate,
      },
    };
  }

  const relReal = path.relative(realStageDir, realTarget);
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
    return {
      ok: false,
      finding: {
        code: "ASSET_SYMLINK_ESCAPE",
        severity: "error",
        message: `Symlink resolves outside stage root: "${rawRef}"`,
        reference: rawRef,
        resolvedPath: realTarget,
      },
    };
  }

  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) {
    return {
      ok: false,
      finding: {
        code: "MISSING_LOCAL_ASSET",
        severity: "error",
        message: `Asset path does not point to a regular file: "${rawRef}"`,
        reference: rawRef,
        resolvedPath: realTarget,
      },
    };
  }

  return { ok: true, resolvedPath: realTarget };
}

interface ExtractedRef {
  raw: string;
  isFontContext: boolean;
  isStylesheet: boolean;
}

function extractCssRefs(cssText: string): ExtractedRef[] {
  const stripped = stripCommentsFromCss(cssText);
  const refs: ExtractedRef[] = [];

  // Track @font-face blocks to distinguish font vs image url() failures accurately
  const fontFaceRanges: Array<{ start: number; end: number }> = [];
  const ffRegex = /@font-face\s*\{[\s\S]*?\}/gi;
  let ffMatch: RegExpExecArray | null;
  while ((ffMatch = ffRegex.exec(stripped)) !== null) {
    fontFaceRanges.push({ start: ffMatch.index, end: ffMatch.index + ffMatch[0].length });
  }
  const inFontFace = (idx: number): boolean =>
    fontFaceRanges.some((r) => idx >= r.start && idx <= r.end);

  const importRe = /@import\s+(?:url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])\s*[^;]*;/gi;
  let m: RegExpExecArray | null;
  const cssWithoutImports = stripped.replace(importRe, (_full, u1, u2) => {
    const val = String(u1 || u2 || "").trim();
    if (val) {
      refs.push({
        raw: val,
        isFontContext: FONT_HOST_RE.test(val) || FONT_EXT_RE.test(val),
        isStylesheet: true,
      });
    }
    return "";
  });

  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/gi;
  while ((m = urlRe.exec(cssWithoutImports)) !== null) {
    const val = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (val) {
      refs.push({
        raw: val,
        isFontContext: inFontFace(m.index) || FONT_HOST_RE.test(val) || FONT_EXT_RE.test(val),
        isStylesheet: false,
      });
    }
  }

  return refs;
}

function extractHtmlRefs(htmlText: string): { refs: ExtractedRef[]; styleBlocks: string[] } {
  const stripped = stripCommentsFromHtml(htmlText);
  const refs: ExtractedRef[] = [];
  const styleBlocks: string[] = [];

  const tagAttrRe =
    /<(script|img|video|audio|source|track|link|embed|object)\b([^>]*)>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagAttrRe.exec(stripped)) !== null) {
    const tagName = tagMatch[1].toLowerCase();
    const attrs = tagMatch[2];
    const isStylesheet =
      tagName === "link" && /\brel\s*=\s*["'][^"']*stylesheet/i.test(attrs);
    const isFontTag =
      tagName === "link" &&
      (/\bas\s*=\s*["']font["']/i.test(attrs) || FONT_HOST_RE.test(attrs));

    const attrRe = /\b(src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(attrs)) !== null) {
      const val = (attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "").trim();
      if (!val) continue;
      refs.push({
        raw: val,
        isFontContext: isFontTag || FONT_HOST_RE.test(val) || FONT_EXT_RE.test(val),
        isStylesheet,
      });
    }
  }

  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = styleRe.exec(stripped)) !== null) {
    if (styleMatch[1]) styleBlocks.push(styleMatch[1]);
  }

  return { refs, styleBlocks };
}

/**
 * Host-side static preflight validator executed BEFORE launching Worker/Chromium.
 * Enforces offline-first assets/fonts, path containment, Windows ADS rejection,
 * and catches missing local files before Producer enters Chromium capture.
 */
export function validateCompositionPreflight(
  stageDir: string,
  options: PreflightOptions = {}
): PreflightResult {
  const t0 = Date.now();
  const entryFile = options.entryFile ?? "index.html";
  const blockers: PreflightFinding[] = [];
  const warnings: PreflightFinding[] = [];
  const checkedLocalAssets = new Set<string>();
  const checkedStylesheets = new Set<string>();
  const externalReferences = new Set<string>();

  if (!stageDir || !fs.existsSync(stageDir)) {
    blockers.push({
      code: "STAGE_DIR_INVALID",
      severity: "error",
      message: `Stage directory does not exist: "${stageDir}"`,
      resolvedPath: stageDir,
    });
    return {
      ok: false,
      stageDir,
      entryPath: null,
      blockers,
      warnings,
      checkedLocalAssets: [],
      checkedStylesheets: [],
      externalReferences: [],
      elapsedMs: Date.now() - t0,
    };
  }

  const realStageDir = fs.realpathSync(stageDir);
  if (!fs.statSync(realStageDir).isDirectory()) {
    blockers.push({
      code: "STAGE_DIR_INVALID",
      severity: "error",
      message: `Stage path is not a directory: "${realStageDir}"`,
      resolvedPath: realStageDir,
    });
    return {
      ok: false,
      stageDir: realStageDir,
      entryPath: null,
      blockers,
      warnings,
      checkedLocalAssets: [],
      checkedStylesheets: [],
      externalReferences: [],
      elapsedMs: Date.now() - t0,
    };
  }

  const entryCheck = resolveContainedFile(realStageDir, realStageDir, entryFile);
  if (!entryCheck.ok) {
    const code =
      entryCheck.finding.code === "MISSING_LOCAL_ASSET"
        ? "ENTRY_FILE_MISSING"
        : entryCheck.finding.code === "WINDOWS_ADS_REJECTED"
          ? "WINDOWS_ADS_REJECTED"
          : "ENTRY_FILE_UNSAFE";
    blockers.push({ ...entryCheck.finding, code });
    return {
      ok: false,
      stageDir: realStageDir,
      entryPath: null,
      blockers,
      warnings,
      checkedLocalAssets: [],
      checkedStylesheets: [],
      externalReferences: [],
      elapsedMs: Date.now() - t0,
    };
  }

  const entryPath = entryCheck.resolvedPath;
  const entryHtml = fs.readFileSync(entryPath, "utf8");
  const { refs, styleBlocks } = extractHtmlRefs(entryHtml);

  const visitedCssFiles = new Set<string>();

  function processRef(ref: ExtractedRef, baseDir: string): void {
    const raw = ref.raw;
    if (!raw || SKIP_SCHEME_RE.test(raw)) return;

    if (EXTERNAL_URL_RE.test(raw)) {
      externalReferences.add(raw);
      if (ref.isFontContext || FONT_HOST_RE.test(raw) || FONT_EXT_RE.test(raw)) {
        blockers.push({
          code: "EXTERNAL_FONT_DISALLOWED",
          severity: "error",
          message: `External font URL violates offline-first contract: "${raw}"`,
          reference: raw,
        });
      } else {
        blockers.push({
          code: "EXTERNAL_NETWORK_DISALLOWED",
          severity: "error",
          message: `External network asset URL violates offline-first contract: "${raw}"`,
          reference: raw,
        });
      }
      return;
    }

    const res = resolveContainedFile(realStageDir, baseDir, raw);
    if (!res.ok) {
      blockers.push(res.finding);
      return;
    }

    checkedLocalAssets.add(res.resolvedPath);
    if (ref.isStylesheet && !visitedCssFiles.has(res.resolvedPath)) {
      visitedCssFiles.add(res.resolvedPath);
      checkedStylesheets.add(res.resolvedPath);
      const cssContent = fs.readFileSync(res.resolvedPath, "utf8");
      const cssDir = path.dirname(res.resolvedPath);
      for (const nested of extractCssRefs(cssContent)) {
        processRef(nested, cssDir);
      }
    }
  }

  const entryDir = path.dirname(entryPath);
  for (const r of refs) {
    processRef(r, entryDir);
  }
  for (const styleCss of styleBlocks) {
    for (const cssRef of extractCssRefs(styleCss)) {
      processRef(cssRef, entryDir);
    }
  }

  // Heuristic check for runtime network calls and timeline contract visibility
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/.test(entryHtml)) {
    const targetList = options.rejectDynamicNetworkHints ? blockers : warnings;
    targetList.push({
      code: "DYNAMIC_NETWORK_API_WARNING",
      severity: options.rejectDynamicNetworkHints ? "error" : "warning",
      message:
        "Detected dynamic network API identifier (fetch/XMLHttpRequest/WebSocket/EventSource); offline render blocks external network requests.",
    });
  }

  const hasSeekContractHint =
    /window\.__timelines|window\.__hf|window\.timeline|renderFrame\s*\(/.test(entryHtml);
  if (!hasSeekContractHint) {
    warnings.push({
      code: "TIMELINE_CONTRACT_MISSING",
      severity: "warning",
      message:
        "No obvious window.__timelines, window.__hf, or renderFrame registration found in entry HTML.",
    });
  }

  return {
    ok: blockers.length === 0,
    stageDir: realStageDir,
    entryPath,
    blockers,
    warnings,
    checkedLocalAssets: Array.from(checkedLocalAssets),
    checkedStylesheets: Array.from(checkedStylesheets),
    externalReferences: Array.from(externalReferences),
    elapsedMs: Date.now() - t0,
  };
}
