import fs from "node:fs";
import path from "node:path";
import type {
  CompositionAnalysisReport,
  CompositionDiagnostic,
  DiagnosticCategory,
  DiagnosticConfidence,
  DiagnosticSeverity,
  DiagnosticSourceLocation,
} from "../../shared/previewContracts.js";
import type { PreflightResult } from "../../shared/renderContracts.js";
import { computeBufferSha256 } from "../import/sessionFsUtils.js";
import { validateCompositionPreflight } from "../validation/hostPreflightValidator.js";
import { buildUnifiedSnippetDiff, type ServerFixProposalRecord } from "./codeDiffEngine.js";
import { scanJsStatic, type JsStaticScanResult, type ScannedTimelineCall } from "./jsStaticScanner.js";

interface ParsedHtmlElement {
  tagName: string;
  id: string | null;
  classList: string[];
  selector: string;
  src: string | null;
  line: number;
  column: number;
  rawTag: string;
  isMedia: boolean;
  isClip: boolean;
  isTransientHint: boolean;
  isCompositionRoot: boolean;
  dataStart: number | null;
  dataDuration: number | null;
  dataEnd: number | null;
}

interface ParsedInlineScript {
  startLine: number;
  openTagEndOffset: number;
  closeTagStartOffset: number;
  code: string;
}

export interface InternalAnalysisOutput {
  report: CompositionAnalysisReport;
  proposalsByDiagnosticId: Map<string, ServerFixProposalRecord>;
}

const SKIP_HTML_TAGS = new Set([
  "html",
  "head",
  "meta",
  "link",
  "title",
  "style",
  "script",
  "body",
  "br",
  "hr",
]);

function stripHtmlCommentsPreserveLines(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, (comment) =>
    comment.replace(/[^\n]/g, " ")
  );
}

function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}

function getAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").trim();
}

function parseNumericAttr(attrs: string, name: string): number | null {
  const raw = getAttr(attrs, name);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseHtmlDocumentForAnalysis(htmlText: string): {
  elements: ParsedHtmlElement[];
  inlineScripts: ParsedInlineScript[];
  externalScriptSrcs: Array<{ src: string; line: number }>;
  styleBlocks: Array<{ css: string; startLine: number }>;
  linkedCssHrefs: string[];
  rootDurationSec: number | null;
} {
  const masked = stripHtmlCommentsPreserveLines(htmlText);
  const elements: ParsedHtmlElement[] = [];
  const inlineScripts: ParsedInlineScript[] = [];
  const externalScriptSrcs: Array<{ src: string; line: number }> = [];
  const styleBlocks: Array<{ css: string; startLine: number }> = [];
  const linkedCssHrefs: string[] = [];
  let rootDurationSec: number | null = null;

  // Mask script/style body offsets so HTML tag regex doesn't parse HTML-like strings inside JS
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let sm: RegExpExecArray | null;
  const bodyRangesToSkip: Array<{ start: number; end: number }> = [];
  while ((sm = scriptRe.exec(masked)) !== null) {
    const attrs = sm[1] ?? "";
    const code = sm[2] ?? "";
    const openEnd = sm.index + `<script${attrs}>`.length;
    const closeStart = openEnd + code.length;
    bodyRangesToSkip.push({ start: openEnd, end: closeStart });

    const pos = offsetToLineCol(htmlText, sm.index);
    const srcAttr = getAttr(attrs, "src");
    if (srcAttr) {
      externalScriptSrcs.push({ src: srcAttr, line: pos.line });
    } else if (code.trim().length > 0) {
      inlineScripts.push({
        startLine: offsetToLineCol(htmlText, openEnd).line,
        openTagEndOffset: openEnd,
        closeTagStartOffset: closeStart,
        code,
      });
    }
  }

  const styleRe = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  let stm: RegExpExecArray | null;
  while ((stm = styleRe.exec(masked)) !== null) {
    const attrs = stm[1] ?? "";
    const css = stm[2] ?? "";
    const openEnd = stm.index + `<style${attrs}>`.length;
    bodyRangesToSkip.push({ start: openEnd, end: openEnd + css.length });
    styleBlocks.push({
      css,
      startLine: offsetToLineCol(htmlText, openEnd).line,
    });
  }

  const inSkippedBody = (idx: number): boolean =>
    bodyRangesToSkip.some((r) => idx >= r.start && idx < r.end);

  const linkRe = /<link\b([^>]*)>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(masked)) !== null) {
    if (inSkippedBody(lm.index)) continue;
    const attrs = lm[1] ?? "";
    const rel = getAttr(attrs, "rel") ?? "";
    const href = getAttr(attrs, "href");
    if (href && /stylesheet/i.test(rel)) {
      linkedCssHrefs.push(href);
    }
  }

  const tagCounts = new Map<string, number>();
  const openTagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let tm: RegExpExecArray | null;
  while ((tm = openTagRe.exec(masked)) !== null) {
    if (inSkippedBody(tm.index)) continue;
    const tagName = tm[1].toLowerCase();
    const attrs = tm[2] ?? "";
    const pos = offsetToLineCol(htmlText, tm.index);

    const hasCompId = /\bdata-composition-id\b/i.test(attrs);
    if (hasCompId && rootDurationSec === null) {
      rootDurationSec = parseNumericAttr(attrs, "data-duration");
    }

    if (SKIP_HTML_TAGS.has(tagName)) continue;

    const id = getAttr(attrs, "id");
    const classRaw = getAttr(attrs, "class") ?? "";
    const classList = classRaw.split(/\s+/).filter(Boolean);
    const src = getAttr(attrs, "src");
    const isMedia = tagName === "video" || tagName === "audio" || tagName === "source";
    const isClip = classList.includes("clip") || /\bdata-clip\b/i.test(attrs);
    const isTransientHint =
      /\bdata-transient\b/i.test(attrs) ||
      /^transient$/i.test(getAttr(attrs, "data-effect") ?? "");
    const dataStart = parseNumericAttr(attrs, "data-start");
    const dataDuration = parseNumericAttr(attrs, "data-duration");
    const dataEnd = parseNumericAttr(attrs, "data-end");

    const count = (tagCounts.get(tagName) ?? 0) + 1;
    tagCounts.set(tagName, count);

    let selector: string;
    if (id) {
      selector = `#${id}`;
    } else if (classList.length > 0) {
      selector = `.${classList.join(".")}`;
    } else if (isMedia && src) {
      selector = `${tagName}[src="${src}"]`;
    } else {
      selector = `${tagName}:nth-of-type(${count})`;
    }

    elements.push({
      tagName,
      id,
      classList,
      selector,
      src,
      line: pos.line,
      column: pos.column,
      rawTag: tm[0].slice(0, 140),
      isMedia,
      isClip,
      isTransientHint,
      isCompositionRoot: hasCompId,
      dataStart,
      dataDuration,
      dataEnd,
    });
  }

  return {
    elements,
    inlineScripts,
    externalScriptSrcs,
    styleBlocks,
    linkedCssHrefs,
    rootDurationSec,
  };
}

function selectorMatchesElement(selector: string | null, el: ParsedHtmlElement): boolean {
  if (!selector) return false;
  const s = selector.trim();
  if (!s) return false;
  if (el.id && (s === `#${el.id}` || s.endsWith(`#${el.id}`) || s.includes(`#${el.id}.`) || s.includes(`#${el.id} `))) {
    return true;
  }
  for (const cls of el.classList) {
    if (s === `.${cls}` || s.includes(`.${cls}`)) {
      return true;
    }
  }
  if (s.toLowerCase() === el.tagName && !el.id && el.classList.length === 0) {
    return true;
  }
  if (el.src && s.includes(el.src)) {
    return true;
  }
  return false;
}

function isTransientTimelinePattern(el: ParsedHtmlElement, calls: ScannedTimelineCall[], rootDurationSec: number | null): boolean {
  if (el.isTransientHint) return true;
  if (el.isClip && el.dataDuration !== null && el.dataDuration > 0 && rootDurationSec !== null && el.dataDuration < rootDurationSec) {
    return true;
  }
  if (calls.length >= 2) {
    const hasOpacityFadeOut = calls.some((c) => /\b(?:opacity|autoAlpha)\s*:\s*0\b/.test(c.varsSnippet));
    const hasOpacityShow = calls.some((c) => /\b(?:opacity|autoAlpha)\s*:\s*1\b/.test(c.varsSnippet));
    if (hasOpacityFadeOut && hasOpacityShow) return true;
  }
  return false;
}

function findSnippetLine(text: string, needle: string): number {
  if (!needle) return 1;
  const idx = text.indexOf(needle);
  if (idx === -1) return 1;
  return offsetToLineCol(text, idx).line;
}

function resolveFileSafelyInStage(realStageDir: string, baseDir: string, relRef: string): string | null {
  const cleaned = relRef.split(/[?#]/, 1)[0]?.trim() ?? "";
  if (!cleaned || /^(?:https?:)?\/\//i.test(cleaned) || cleaned.includes(":")) return null;
  const candidate = path.resolve(baseDir, cleaned);
  const rel = path.relative(realStageDir, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(candidate)) return null;
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) return null;
    const real = fs.realpathSync(candidate);
    const relReal = path.relative(realStageDir, real);
    if (relReal.startsWith("..") || path.isAbsolute(relReal)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Performs pure static composition & GSAP authoring analysis inside the Main Process.
 * Never executes imported JavaScript. Guarantees NO-AUTO-FIX for callbacks,
 * dynamic expressions, late registrations, IIFE timelines, cached raw references,
 * ambiguous timeline keys, and invalid/overflowing .clip boundaries.
 */
export function analyzeComposition(
  stageDir: string,
  options: {
    entryFile?: string;
    sessionId?: string;
    preflight?: PreflightResult;
  } = {}
): InternalAnalysisOutput {
  const entryFile = (options.entryFile ?? "index.html").replace(/\\/g, "/");
  const preflight =
    options.preflight ?? validateCompositionPreflight(stageDir, { entryFile });
  const realStageDir = preflight.stageDir;
  const entryPath = preflight.entryPath ?? path.resolve(realStageDir, ...entryFile.split("/"));

  const fileTextCache = new Map<string, string>();
  const analyzedFiles: string[] = [];

  if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
    throw new Error(`Entry HTML not found for analysis: "${entryFile}"`);
  }

  const entryHtml = fs.readFileSync(entryPath, "utf8");
  fileTextCache.set(entryFile, entryHtml);
  analyzedFiles.push(entryFile);

  const parsedHtml = parseHtmlDocumentForAnalysis(entryHtml);
  const jsScans: JsStaticScanResult[] = [];

  for (const inlineScript of parsedHtml.inlineScripts) {
    jsScans.push(scanJsStatic(entryFile, inlineScript.code, inlineScript.startLine - 1));
  }

  const entryDir = path.dirname(entryPath);
  for (const extScript of parsedHtml.externalScriptSrcs) {
    const resolved = resolveFileSafelyInStage(realStageDir, entryDir, extScript.src);
    if (!resolved) continue;
    const relPosix = path.relative(realStageDir, resolved).replace(/\\/g, "/");
    const content = fs.readFileSync(resolved, "utf8");
    fileTextCache.set(relPosix, content);
    analyzedFiles.push(relPosix);
    jsScans.push(scanJsStatic(relPosix, content, 0));
  }

  const cssChunks: Array<{ file: string; css: string; startLine: number }> = parsedHtml.styleBlocks.map((b) => ({
    file: entryFile,
    css: b.css,
    startLine: b.startLine,
  }));
  for (const href of parsedHtml.linkedCssHrefs) {
    const resolved = resolveFileSafelyInStage(realStageDir, entryDir, href);
    if (!resolved) continue;
    const relPosix = path.relative(realStageDir, resolved).replace(/\\/g, "/");
    const css = fs.readFileSync(resolved, "utf8");
    analyzedFiles.push(relPosix);
    cssChunks.push({ file: relPosix, css, startLine: 1 });
  }

  const allCreations = jsScans.flatMap((s) => s.timelineCreations);
  const allRegistrations = jsScans.flatMap((s) => s.timelineRegistrations);
  const allCalls = jsScans.flatMap((s) => s.timelineCalls);
  const allCachedRefs = jsScans.flatMap((s) => s.cachedReferences);
  const allDynamicPatterns = jsScans.flatMap((s) => s.dynamicPatterns);

  const timelineKeys = Array.from(
    new Set(
      allRegistrations.map((r) => (r.isDynamicKey ? "<dynamic>" : r.key ?? "<unknown>"))
    )
  );
  const hasMainTimeline = timelineKeys.includes("main");
  const hasCallbacks =
    allCalls.some((c) => c.hasCallback) || allCreations.some((c) => c.hasCallbacks);
  const hasLateRegistration =
    allCreations.some((c) => c.insideLateContext) ||
    allRegistrations.some((r) => r.insideLateContext);
  const hasIifeTimeline =
    allCreations.some((c) => c.insideIife) || allRegistrations.some((r) => r.insideIife);
  const hasCachedReference = allCachedRefs.length > 0;
  const hasDynamicExpressions =
    allDynamicPatterns.length > 0 ||
    allCalls.some((c) => c.targetIsDynamic || c.hasDynamicVars) ||
    allCreations.some((c) => c.hasDynamicOptions) ||
    allRegistrations.some((r) => r.isDynamicKey);
  const isAmbiguousTimelineKey =
    allRegistrations.some((r) => r.isDynamicKey) ||
    timelineKeys.some((k) => k !== "main") ||
    timelineKeys.length > 1 ||
    allCreations.length > 1;

  const pausedValues = allCreations.map((c) => c.pausedOption);
  const pausedLikely =
    pausedValues.length === 0
      ? null
      : pausedValues.every((v) => v === true)
        ? true
        : pausedValues.some((v) => v === false || v === null)
          ? false
          : null;

  const diagnostics: CompositionDiagnostic[] = [];
  const proposalsByDiagnosticId = new Map<string, ServerFixProposalRecord>();
  let diagCounter = 0;
  const nextId = (prefix: string): string => {
    diagCounter += 1;
    return `${prefix}-${diagCounter}`;
  };

  const addDiagnostic = (
    item: Omit<CompositionDiagnostic, "id" | "fixCandidateAvailable">,
    proposal?: ServerFixProposalRecord
  ): void => {
    const id = nextId(item.ruleId.toLowerCase());
    if (proposal) {
      const bound: ServerFixProposalRecord = { ...proposal, diagnosticId: id };
      proposalsByDiagnosticId.set(id, bound);
    }
    diagnostics.push({
      ...item,
      id,
      fixCandidateAvailable: Boolean(proposal && item.canAutoFix),
    });
  };

  const globalHazardsPresent =
    hasCallbacks ||
    hasLateRegistration ||
    hasIifeTimeline ||
    hasCachedReference ||
    hasDynamicExpressions ||
    isAmbiguousTimelineKey;

  // --- 1. Preflight external / missing / unsafe asset warnings (WARNING_AMBIGUOUS, NO-AUTO-FIX) ---
  for (const blocker of preflight.blockers) {
    const ref = blocker.reference ?? "";
    const line = ref ? findSnippetLine(entryHtml, ref) : 1;
    addDiagnostic({
      ruleId: blocker.code,
      category: "WARNING_AMBIGUOUS",
      elementIdentifier: ref || blocker.code,
      inspectSelector: ref ? `[src="${ref}"], [href="${ref}"]` : null,
      sourceLocation: {
        file: entryFile,
        line,
        snippet: entryHtml.split(/\r?\n/)[line - 1]?.trim().slice(0, 160),
      },
      reason: blocker.message,
      confidence: "high",
      severity: blocker.severity === "warning" ? "warning" : "error",
      evidence: [
        `Preflight rule: ${blocker.code}`,
        ref ? `Reference: ${ref}` : "Entry composition check",
      ],
      canAutoFix: false,
      noAutoFixReason:
        "NO-AUTO-FIX: External or missing asset references require manual local asset resolution.",
    });
  }

  // --- 2. GSAP Authoring Hazard Checks (Always NO-AUTO-FIX under WARNING_AMBIGUOUS) ---
  for (const call of allCalls) {
    if (call.hasCallback) {
      addDiagnostic({
        ruleId: "GSAP_CALLBACK_DEPENDENCY",
        category: "WARNING_AMBIGUOUS",
        elementIdentifier: call.targetSelector ?? `${call.calleeVar}.${call.method}()`,
        inspectSelector: call.targetSelector,
        sourceLocation: { file: call.file, line: call.line, column: call.column, snippet: call.snippet },
        reason: `GSAP lifecycle callback (${call.callbackNames.join(", ")}) may perform non-idempotent side effects across seeks.`,
        confidence: "high",
        severity: "warning",
        evidence: [`Callback hook(s): ${call.callbackNames.join(", ")}`, `Call: ${call.snippet}`],
        canAutoFix: false,
        noAutoFixReason:
          "NO-AUTO-FIX: Callback logic cannot be rewritten deterministically by static analysis.",
      });
    }
    if (call.targetIsDynamic || call.hasDynamicVars) {
      addDiagnostic({
        ruleId: "UNSUPPORTED_DYNAMIC_EXPRESSION",
        category: "WARNING_AMBIGUOUS",
        elementIdentifier: call.targetSelector ?? call.targetArg ?? `${call.calleeVar}.${call.method}()`,
        inspectSelector: call.targetSelector,
        sourceLocation: { file: call.file, line: call.line, column: call.column, snippet: call.snippet },
        reason: "GSAP call uses a dynamic target variable or computed/functional tween expression.",
        confidence: "medium",
        severity: "warning",
        evidence: [`Dynamic expression in ${call.method}(): ${call.snippet}`],
        canAutoFix: false,
        noAutoFixReason:
          "NO-AUTO-FIX: Dynamic JS expressions cannot be evaluated or rewritten safely without execution.",
      });
    }
  }

  for (const creation of allCreations) {
    if (creation.hasCallbacks) {
      addDiagnostic({
        ruleId: "GSAP_TIMELINE_CALLBACK_OPTIONS",
        category: "WARNING_AMBIGUOUS",
        elementIdentifier: creation.varName ?? "gsap.timeline()",
        inspectSelector: null,
        sourceLocation: { file: creation.file, line: creation.line, column: creation.column, snippet: creation.snippet },
        reason: `Timeline options include callback(s) (${creation.callbackNames.join(", ")}) which may break idempotent frame seek.`,
        confidence: "high",
        severity: "warning",
        evidence: [`Options: ${creation.optionsRaw || "(none)"}`],
        canAutoFix: false,
        noAutoFixReason:
          "NO-AUTO-FIX: Non-idempotent timeline callbacks forbid automatic refactoring.",
      });
    }
    if (creation.insideLateContext) {
      addDiagnostic({
        ruleId: "LATE_TIMELINE_REGISTRATION",
        category: "WARNING_AMBIGUOUS",
        elementIdentifier: creation.varName ?? "gsap.timeline()",
        inspectSelector: null,
        sourceLocation: { file: creation.file, line: creation.line, column: creation.column, snippet: creation.snippet },
        reason: `Timeline constructed inside deferred/async hook (${creation.lateContextReason}); initial seek readiness is not deterministic.`,
        confidence: "high",
        severity: "warning",
        evidence: [`Deferred context: ${creation.lateContextReason}`, `Line: ${creation.snippet}`],
        canAutoFix: false,
        noAutoFixReason:
          "NO-AUTO-FIX: Deferred or async timeline registration requires manual authoring restructuring.",
      });
    }
    if (creation.insideIife) {
      addDiagnostic({
        ruleId: "HIDDEN_IIFE_TIMELINE",
        category: "WARNING_AMBIGUOUS",
        elementIdentifier: creation.varName ?? "(IIFE gsap.timeline)",
        inspectSelector: null,
        sourceLocation: { file: creation.file, line: creation.line, column: creation.column, snippet: creation.snippet },
        reason: "GSAP timeline is encapsulated inside an IIFE closure, reducing deterministic inspection guarantees.",
        confidence: "medium",
        severity: "warning",
        evidence: [`IIFE-scoped timeline creation at ${creation.file}:${creation.line}`],
        canAutoFix: false,
        noAutoFixReason:
          "NO-AUTO-FIX: Timeline hidden inside an IIFE closure must not be automatically rewritten.",
      });
    }
  }

  for (const reg of allRegistrations) {
    if (reg.insideLateContext) {
      addDiagnostic({
        ruleId: "LATE_TIMELINE_REGISTRATION",
        category: "WARNING_AMBIGUOUS",
        elementIdentifier: reg.key ? `window.__timelines.${reg.key}` : "window.__timelines[...]",
        inspectSelector: null,
        sourceLocation: { file: reg.file, line: reg.line, snippet: reg.snippet },
        reason: `window.__timelines registration runs inside deferred hook (${reg.lateContextReason}).`,
        confidence: "high",
        severity: "warning",
        evidence: [`Late hook: ${reg.lateContextReason}`, reg.snippet],
        canAutoFix: false,
        noAutoFixReason:
          "NO-AUTO-FIX: Late timeline registration cannot be auto-hoisted safely.",
      });
    }
    if (reg.isDynamicKey || (reg.key && reg.key !== "main")) {
      addDiagnostic({
        ruleId: "AMBIGUOUS_TIMELINE_KEY",
        category: "WARNING_AMBIGUOUS",
        elementIdentifier: reg.isDynamicKey ? "window.__timelines[<dynamic>]" : `window.__timelines.${reg.key}`,
        inspectSelector: null,
        sourceLocation: { file: reg.file, line: reg.line, snippet: reg.snippet },
        reason: reg.isDynamicKey
          ? "Computed bracket key on window.__timelines makes the main seek contract unresolvable statically."
          : `Timeline registered under "${reg.key}" instead of canonical "main" key (ambiguous when seeking).`,
        confidence: "medium",
        severity: "warning",
        evidence: [`Registration: ${reg.snippet}`],
        canAutoFix: false,
        noAutoFixReason:
          "NO-AUTO-FIX: Ambiguous or non-standard window.__timelines key requires author selection.",
      });
    }
  }

  if (allRegistrations.length > 1 && timelineKeys.includes("main")) {
    const second = allRegistrations[1];
    addDiagnostic({
      ruleId: "MULTIPLE_TIMELINE_REGISTRATIONS",
      category: "WARNING_AMBIGUOUS",
      elementIdentifier: `window.__timelines (${timelineKeys.join(", ")})`,
      inspectSelector: null,
      sourceLocation: { file: second.file, line: second.line, snippet: second.snippet },
      reason: `Multiple timeline registrations detected (${timelineKeys.join(", ")}); deterministic single-master timeline order is ambiguous.`,
      confidence: "medium",
      severity: "warning",
      evidence: timelineKeys.map((k) => `Key: ${k}`),
      canAutoFix: false,
      noAutoFixReason: "NO-AUTO-FIX: Multiple timeline keys cannot be merged automatically.",
    });
  }

  for (const ref of allCachedRefs) {
    addDiagnostic({
      ruleId: "CACHED_RAW_REFERENCE_PRE_PROXY",
      category: "WARNING_AMBIGUOUS",
      elementIdentifier: ref.varName,
      inspectSelector: null,
      sourceLocation: { file: ref.file, line: ref.line, snippet: ref.snippet },
      reason:
        ref.kind === "timeline_or_gsap_ref"
          ? `Cached raw reference "${ref.varName}" to timeline/GSAP store pre-interception can bypass runtime seek wrappers.`
          : `Cached raw DOM element reference "${ref.varName}" hides literal selectors from deterministic analysis.`,
      confidence: "medium",
      severity: "warning",
      evidence: [`Reference declaration: ${ref.snippet}`],
      canAutoFix: false,
      noAutoFixReason:
        "NO-AUTO-FIX: Cached DOM/timeline alias references cannot be automatically refactored safely.",
    });
  }

  for (const dyn of allDynamicPatterns) {
    addDiagnostic({
      ruleId: "UNSUPPORTED_DYNAMIC_EXPRESSION",
      category: "WARNING_AMBIGUOUS",
      elementIdentifier: dyn.kind,
      inspectSelector: null,
      sourceLocation: { file: dyn.file, line: dyn.line, snippet: dyn.snippet },
      reason: dyn.detail,
      confidence: "medium",
      severity: "warning",
      evidence: [`Detected pattern: ${dyn.snippet}`],
      canAutoFix: false,
      noAutoFixReason:
        "NO-AUTO-FIX: Dynamic or non-deterministic constructs are forbidden from automatic code rewrite.",
    });
  }

  // --- 3. CSS @keyframes / transition notice (potential conflict with GSAP deterministic seek) ---
  for (const chunk of cssChunks) {
    const kfMatch = /@keyframes\s+([a-zA-Z0-9_-]+)/.exec(chunk.css);
    if (kfMatch) {
      addDiagnostic({
        ruleId: "CSS_KEYFRAMES_TIMING_NOTICE",
        category: "WARNING_AMBIGUOUS",
        elementIdentifier: `@keyframes ${kfMatch[1]}`,
        inspectSelector: null,
        sourceLocation: { file: chunk.file, line: chunk.startLine, snippet: kfMatch[0] },
        reason: `CSS @keyframes "${kfMatch[1]}" advances via wall-clock CSS animations rather than paused GSAP seek timeline.`,
        confidence: "medium",
        severity: "warning",
        evidence: [`Found ${kfMatch[0]} in ${chunk.file}`],
        canAutoFix: false,
        noAutoFixReason:
          "NO-AUTO-FIX: Converting CSS keyframe rules into GSAP tweens requires manual review.",
      });
    }
  }

  // --- 4. Multiple .clip Boundary Condition Analysis ---
  const clipElements = parsedHtml.elements.filter((e) => e.isClip);
  const boundedClips: Array<{ el: ParsedHtmlElement; start: number; end: number }> = [];
  for (const clip of clipElements) {
    const start = clip.dataStart;
    const dur = clip.dataDuration;
    if (start === null || dur === null) {
      addDiagnostic({
        ruleId: "CLIP_MISSING_BOUNDARY_ATTRS",
        category: "WARNING_AMBIGUOUS",
        elementIdentifier: clip.selector,
        inspectSelector: clip.selector,
        sourceLocation: { file: entryFile, line: clip.line, column: clip.column, snippet: clip.rawTag },
        reason: `.clip element "${clip.selector}" is missing explicit data-start or data-duration boundary metadata.`,
        confidence: "high",
        severity: "warning",
        evidence: [`Tag: ${clip.rawTag}`],
        canAutoFix: false,
        noAutoFixReason:
          "NO-AUTO-FIX: Missing .clip time bounds require explicit timing from the author.",
      });
      continue;
    }

    if (start < 0 || dur <= 0) {
      addDiagnostic({
        ruleId: "CLIP_INVALID_BOUNDARY",
        category: "WARNING_AMBIGUOUS",
        elementIdentifier: clip.selector,
        inspectSelector: clip.selector,
        sourceLocation: { file: entryFile, line: clip.line, column: clip.column, snippet: clip.rawTag },
        reason: `.clip element "${clip.selector}" has invalid timing bounds (start=${start}s, duration=${dur}s).`,
        confidence: "high",
        severity: "warning",
        evidence: [`data-start="${start}"`, `data-duration="${dur}"`],
        canAutoFix: false,
        noAutoFixReason: "NO-AUTO-FIX: Invalid negative/zero clip duration cannot be auto-corrected safely.",
      });
      continue;
    }

    const end = start + dur;
    boundedClips.push({ el: clip, start, end });

    if (parsedHtml.rootDurationSec !== null && end > parsedHtml.rootDurationSec + 1e-6) {
      addDiagnostic({
        ruleId: "CLIP_BOUNDARY_OVERFLOW",
        category: "WARNING_AMBIGUOUS",
        elementIdentifier: clip.selector,
        inspectSelector: clip.selector,
        sourceLocation: { file: entryFile, line: clip.line, column: clip.column, snippet: clip.rawTag },
        reason: `.clip window [${start}s..${end}s] exceeds parent composition data-duration (${parsedHtml.rootDurationSec}s).`,
        confidence: "high",
        severity: "warning",
        evidence: [
          `Clip end: ${end}s > composition duration ${parsedHtml.rootDurationSec}s`,
          `Tag: ${clip.rawTag}`,
        ],
        canAutoFix: false,
        noAutoFixReason:
          "NO-AUTO-FIX: Blind duration extension is forbidden; review clip timing vs composition duration.",
      });
    }
  }

  for (let i = 0; i < boundedClips.length; i += 1) {
    for (let j = i + 1; j < boundedClips.length; j += 1) {
      const a = boundedClips[i];
      const b = boundedClips[j];
      const overlap = a.start < b.end - 1e-6 && b.start < a.end - 1e-6;
      if (overlap) {
        addDiagnostic({
          ruleId: "MULTIPLE_CLIP_OVERLAP",
          category: "WARNING_AMBIGUOUS",
          elementIdentifier: `${a.el.selector} ↔ ${b.el.selector}`,
          inspectSelector: a.el.selector,
          sourceLocation: { file: entryFile, line: b.el.line, column: b.el.column, snippet: b.el.rawTag },
          reason: `Overlapping .clip time windows: ${a.el.selector} [${a.start}s..${a.end}s] overlaps ${b.el.selector} [${b.start}s..${b.end}s].`,
          confidence: "medium",
          severity: "warning",
          evidence: [
            `${a.el.selector}: ${a.start}s..${a.end}s`,
            `${b.el.selector}: ${b.start}s..${b.end}s`,
          ],
          canAutoFix: false,
          noAutoFixReason:
            "NO-AUTO-FIX: Overlapping .clip boundaries may be intentional compositing or a timing mistake.",
        });
      }
    }
  }

  // --- 5. High-Confidence Auto-Fixable Candidate (STRICTLY ONLY when unambiguous & deterministic) ---
  // Candidate A: Unambiguous single top-level gsap.timeline(...) assigned to window.__timelines.main WITHOUT `paused: true`.
  const singleUnpausedDeterministic =
    !globalHazardsPresent &&
    allCreations.length === 1 &&
    allRegistrations.length === 1 &&
    hasMainTimeline &&
    allCreations[0].pausedOption !== true;

  if (singleUnpausedDeterministic) {
    const cr = allCreations[0];
    const targetFileContent = fileTextCache.get(cr.file);
    let fixProposal: ServerFixProposalRecord | undefined;
    if (targetFileContent) {
      let afterContent: string | null = null;
      if (/gsap\.timeline\s*\(\s*\)/.test(targetFileContent)) {
        afterContent = targetFileContent.replace(
          /gsap\.timeline\s*\(\s*\)/,
          "gsap.timeline({ paused: true })"
        );
      } else if (/gsap\.timeline\s*\(\s*\{([^}]*)\}\s*\)/.test(targetFileContent)) {
        afterContent = targetFileContent.replace(
          /gsap\.timeline\s*\(\s*\{([^}]*)\}\s*\)/,
          (_full, inner: string) => {
            if (/\bpaused\s*:\s*false\b/.test(inner)) {
              return `gsap.timeline({${inner.replace(/\bpaused\s*:\s*false\b/, "paused: true")}})`;
            }
            const cleanInner = inner.trim();
            return cleanInner
              ? `gsap.timeline({ paused: true, ${cleanInner} })`
              : "gsap.timeline({ paused: true })";
          }
        );
      }

      if (afterContent && afterContent !== targetFileContent) {
        const diff = buildUnifiedSnippetDiff(cr.file, targetFileContent, afterContent);
        const beforeSha = computeBufferSha256(Buffer.from(targetFileContent, "utf8"));
        const proposalId = `fix_${cr.file.replace(/[^a-zA-Z0-9]/g, "_")}_${cr.line}`;
        fixProposal = {
          proposalId,
          sessionId: options.sessionId ?? "",
          diagnosticId: "",
          title: "Set { paused: true } on deterministic GSAP timeline",
          targetFile: cr.file,
          expectedBeforeSha256: beforeSha,
          beforeContent: targetFileContent,
          afterContent,
          preview: {
            proposalId,
            title: "Set { paused: true } on deterministic GSAP timeline",
            targetFile: cr.file,
            expectedBeforeSha256: beforeSha,
            ...diff,
          },
        };
      }
    }

    const firstAnimatedEl = parsedHtml.elements.find((e) =>
      allCalls.some((c) => selectorMatchesElement(c.targetSelector, e))
    );

    addDiagnostic(
      {
        ruleId: "GSAP_TIMELINE_NOT_PAUSED",
        category: "TIMELINE_CONTROLLED",
        elementIdentifier: firstAnimatedEl?.selector ?? (cr.varName ?? "window.__timelines.main"),
        inspectSelector: firstAnimatedEl?.selector ?? null,
        sourceLocation: { file: cr.file, line: cr.line, column: cr.column, snippet: cr.snippet },
        reason: "Deterministic GSAP main timeline lacks { paused: true }; unpaused auto-play drifts from absolute frame seek.",
        confidence: "high",
        severity: "warning",
        evidence: [
          `Timeline creation: ${cr.snippet}`,
          `Registered contract: window.__timelines.main`,
          "Zero callbacks, zero dynamic expressions, zero deferred hooks",
        ],
        canAutoFix: Boolean(fixProposal),
        noAutoFixReason: fixProposal ? null : "Could not construct unambiguous text diff",
      },
      fixProposal
    );
  } else if (globalHazardsPresent && allCreations.some((c) => c.pausedOption !== true)) {
    const cr = allCreations.find((c) => c.pausedOption !== true)!;
    addDiagnostic({
      ruleId: "GSAP_TIMELINE_NOT_PAUSED_AMBIGUOUS",
      category: "WARNING_AMBIGUOUS",
      elementIdentifier: cr.varName ?? "gsap.timeline()",
      inspectSelector: null,
      sourceLocation: { file: cr.file, line: cr.line, column: cr.column, snippet: cr.snippet },
      reason: "GSAP timeline lacks { paused: true }, and authoring ambiguities (callbacks, dynamic code, or IIFE/late/key hazards) are present.",
      confidence: "medium",
      severity: "warning",
      evidence: [`Timeline creation: ${cr.snippet}`],
      canAutoFix: false,
      noAutoFixReason:
        "NO-AUTO-FIX: Unpaused timeline cannot be auto-fixed while callbacks, dynamic expressions, or ambiguous timeline patterns exist.",
    });
  }

  // --- 6. Per-Element Classification: PERSISTENT, TRANSIENT, TIMELINE_CONTROLLED, MEDIA ---
  const mediaCheckedSet = new Set(
    preflight.checkedLocalAssets.map((abs) => path.relative(realStageDir, abs).replace(/\\/g, "/"))
  );

  for (const el of parsedHtml.elements) {
    if (el.isCompositionRoot) continue;

    // 6a. MEDIA (<video>, <audio>, <source>)
    if (el.isMedia) {
      const normalizedSrc = el.src ? el.src.replace(/^\.\//, "") : null;
      const isExternal = el.src ? /^(?:https?:)?\/\//i.test(el.src) : false;
      const isVerifiedLocal = normalizedSrc
        ? mediaCheckedSet.has(normalizedSrc) ||
          Array.from(mediaCheckedSet).some((p) => p.endsWith(`/${normalizedSrc}`) || p === normalizedSrc)
        : false;

      const sourceLoc: DiagnosticSourceLocation = {
        file: entryFile,
        line: el.line,
        column: el.column,
        snippet: el.rawTag,
      };

      addDiagnostic({
        ruleId: "MEDIA_ELEMENT",
        category: "MEDIA",
        elementIdentifier: el.selector,
        inspectSelector: el.selector,
        sourceLocation: sourceLoc,
        reason: isExternal
          ? `Media element <${el.tagName}> references blocked external URL "${el.src}".`
          : isVerifiedLocal
            ? `Verified local <${el.tagName}> media asset (${el.src}).`
            : `Local <${el.tagName}> media element (${el.src ?? "inline/nested source"}).`,
        confidence: isExternal || isVerifiedLocal ? "high" : "medium",
        severity: isExternal ? "error" : "info",
        evidence: [
          `Tag: <${el.tagName}>`,
          `Source: ${el.src ?? "(nested/none)"}`,
          isVerifiedLocal ? "Verified local asset in preflight" : "Unverified or nested media source",
        ],
        canAutoFix: false,
        noAutoFixReason: "Media element requires no automatic rewrite.",
      });
      continue;
    }

    const matchingCalls = allCalls.filter((c) => selectorMatchesElement(c.targetSelector, el));
    const sourceLoc: DiagnosticSourceLocation = {
      file: entryFile,
      line: el.line,
      column: el.column,
      snippet: el.rawTag,
    };

    // 6b. TRANSIENT (explicit transient effects or fade-in->fade-out / bounded sub-window clips)
    if (isTransientTimelinePattern(el, matchingCalls, parsedHtml.rootDurationSec)) {
      const evidence: string[] = [`HTML element ${el.selector} at ${entryFile}:${el.line}`];
      if (el.isTransientHint) evidence.push("Explicit transient marker attribute");
      if (el.isClip && el.dataDuration !== null) {
        evidence.push(`Bounded .clip window [${el.dataStart ?? 0}s..${(el.dataStart ?? 0) + el.dataDuration}s]`);
      }
      for (const c of matchingCalls) {
        evidence.push(`GSAP ${c.calleeVar}.${c.method}(${c.targetSelector ?? ""}) at ${c.file}:${c.line}`);
      }

      addDiagnostic({
        ruleId: "TRANSIENT_ELEMENT",
        category: "TRANSIENT",
        elementIdentifier: el.selector,
        inspectSelector: el.selector,
        sourceLocation: sourceLoc,
        reason: "Element exhibits bounded transient visibility/effect behavior within the composition timeline.",
        confidence: globalHazardsPresent ? "medium" : "high",
        severity: "info",
        evidence,
        canAutoFix: false,
        noAutoFixReason: "Intended transient effect — no fix required.",
      });
      continue;
    }

    // 6c. TIMELINE_CONTROLLED (statically targeted by GSAP calls or bounded timeline .clip)
    if (matchingCalls.length > 0 || el.isClip) {
      const hasStaticDeterministicChain =
        !globalHazardsPresent && hasMainTimeline && pausedLikely !== false;
      const confidence: DiagnosticConfidence = hasStaticDeterministicChain
        ? "high"
        : matchingCalls.some((c) => c.hasCallback || c.hasDynamicVars)
          ? "low"
          : "medium";
      const evidence: string[] = [];
      for (const c of matchingCalls) {
        evidence.push(`GSAP ${c.calleeVar}.${c.method}("${c.targetSelector}", ...) @ ${c.file}:${c.line}`);
      }
      if (el.isClip) {
        evidence.push(`.clip start=${el.dataStart ?? "?"}s duration=${el.dataDuration ?? "?"}s`);
      }
      if (hasMainTimeline && !globalHazardsPresent) {
        evidence.push("Bound deterministically to window.__timelines.main");
      } else if (globalHazardsPresent) {
        evidence.push("Timeline authoring hazards present (confidence reduced conservatively)");
      }

      addDiagnostic({
        ruleId: "TIMELINE_CONTROLLED_ELEMENT",
        category: "TIMELINE_CONTROLLED",
        elementIdentifier: el.selector,
        inspectSelector: el.selector,
        sourceLocation: sourceLoc,
        reason:
          confidence === "high"
            ? "Element is deterministically controlled by static GSAP timeline calls registered on window.__timelines.main."
            : "Element appears controlled by timeline calls, but authoring ambiguities reduce static determinism confidence.",
        confidence,
        severity: "info",
        evidence,
        canAutoFix: false,
        noAutoFixReason:
          confidence === "high"
            ? "Deterministic timeline-controlled element requires no change."
            : "NO-AUTO-FIX: Authoring ambiguities prevent automatic transformation.",
      });
      continue;
    }

    // 6d. PERSISTENT (static DOM element with no GSAP tweens / no transient hooks)
    const hasUncertainDynamicScope = hasDynamicExpressions || hasCachedReference || hasIifeTimeline;
    const persistentConfidence: DiagnosticConfidence = hasUncertainDynamicScope ? "medium" : "high";
    addDiagnostic({
      ruleId: "PERSISTENT_ELEMENT",
      category: "PERSISTENT",
      elementIdentifier: el.selector,
      inspectSelector: el.selector,
      sourceLocation: sourceLoc,
      reason: hasUncertainDynamicScope
        ? "No static GSAP tween targets this element; classified conservatively as PERSISTENT (medium confidence due to dynamic/cached selectors in script)."
        : "Element remains static throughout the composition with no static GSAP animations or transient visibility rules.",
      confidence: persistentConfidence,
      severity: "info",
      evidence: [
        `Static DOM element <${el.tagName}> at ${entryFile}:${el.line}`,
        allCalls.length === 0
          ? "Zero GSAP calls detected"
          : `Zero static selectors matched (${allCalls.length} GSAP call(s) checked)`,
      ],
      canAutoFix: false,
      noAutoFixReason: "Persistent static element requires no auto-fix.",
    });
  }

  const countsByCategory: Record<DiagnosticCategory, number> = {
    PERSISTENT: 0,
    TRANSIENT: 0,
    TIMELINE_CONTROLLED: 0,
    MEDIA: 0,
    WARNING_AMBIGUOUS: 0,
  };
  let blockerCount = 0;
  let warningCount = 0;
  let autoFixableCount = 0;

  for (const d of diagnostics) {
    countsByCategory[d.category] += 1;
    if (d.severity === "error") blockerCount += 1;
    if (d.severity === "warning") warningCount += 1;
    if (d.canAutoFix) autoFixableCount += 1;
  }

  return {
    report: {
      analyzedAtIso: new Date().toISOString(),
      entryFile,
      analyzedFiles: Array.from(new Set(analyzedFiles)),
      timelineContract: {
        hasMainTimeline,
        timelineKeys,
        pausedLikely,
        hasCallbacks,
        hasLateRegistration,
        hasIifeTimeline,
        hasCachedReference,
        hasDynamicExpressions,
      },
      summary: {
        total: diagnostics.length,
        countsByCategory,
        blockerCount,
        warningCount,
        autoFixableCount,
      },
      diagnostics,
    },
    proposalsByDiagnosticId,
  };
}
