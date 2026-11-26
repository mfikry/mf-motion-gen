export interface ScannedTimelineCall {
  file: string;
  line: number;
  column: number;
  calleeVar: string;
  method: "to" | "from" | "fromTo" | "set" | "call" | "eventCallback";
  targetArg: string | null;
  targetSelector: string | null;
  targetIsDynamic: boolean;
  varsSnippet: string;
  hasCallback: boolean;
  callbackNames: string[];
  hasDynamicVars: boolean;
  hasVisibilityChange: boolean;
  explicitDurationSec: number | null;
  snippet: string;
}

export interface ScannedTimelineCreation {
  file: string;
  line: number;
  column: number;
  varName: string | null;
  optionsRaw: string;
  pausedOption: boolean | null;
  hasCallbacks: boolean;
  callbackNames: string[];
  hasDynamicOptions: boolean;
  insideFunctionOrIife: boolean;
  insideIife: boolean;
  insideLateContext: boolean;
  lateContextReason: string | null;
  snippet: string;
}

export interface ScannedTimelineRegistration {
  file: string;
  line: number;
  key: string | null;
  isDynamicKey: boolean;
  assignedExpr: string;
  insideLateContext: boolean;
  lateContextReason: string | null;
  insideIife: boolean;
  snippet: string;
}

export interface ScannedCachedReference {
  file: string;
  line: number;
  varName: string;
  kind: "dom_ref" | "timeline_or_gsap_ref";
  snippet: string;
}

export interface ScannedDynamicPattern {
  file: string;
  line: number;
  kind:
    | "eval_or_function"
    | "nondeterministic_runtime"
    | "unsupported_ticker_or_scroll"
    | "external_network_call"
    | "dynamic_selector_or_expression";
  detail: string;
  snippet: string;
}

export interface JsStaticScanResult {
  file: string;
  skippedAsVendorLibrary: boolean;
  timelineCreations: ScannedTimelineCreation[];
  timelineRegistrations: ScannedTimelineRegistration[];
  timelineCalls: ScannedTimelineCall[];
  cachedReferences: ScannedCachedReference[];
  dynamicPatterns: ScannedDynamicPattern[];
}

const CALLBACK_PROP_RE = /\b(onStart|onUpdate|onComplete|onRepeat|onReverseComplete)\s*:/g;
const LATE_HOOK_RE =
  /\b(?:setTimeout|setInterval|requestAnimationFrame|addEventListener|Promise|fetch|import)\b|\basync\s+function\b|\basync\s*\([^)]*\)\s*=>|\.then\s*\(/;

/**
 * Identifies minified third-party library bundles (e.g. gsap.min.js) so we do not
 * falsely classify GSAP's internal runtime code as user authoring bugs.
 */
export function isLikelyVendorBundle(relPath: string, code: string): boolean {
  const base = relPath.split("/").pop()?.toLowerCase() ?? "";
  if (
    /^gsap(?:\.min)?\.js$/i.test(base) ||
    /^(?:scrolltrigger|motionpathplugin|drawsvgplugin|splittext|flip)(?:\.min)?\.js$/i.test(base) ||
    /^anime(?:\.min)?\.js$/i.test(base) ||
    /^lottie(?:_light|_svg)?(?:\.min)?\.js$/i.test(base)
  ) {
    return true;
  }
  if (/\/\*\!?\s*GSAP\s+\d/i.test(code.slice(0, 600)) || /GreenSock/i.test(code.slice(0, 800))) {
    return true;
  }
  return false;
}

/**
 * Masks string/comment contents with spaces (keeping exact character offsets & newlines)
 * so structural regex checks never trigger on comments or string literals while preserving line numbers.
 */
function stripJsCommentsPreserveLines(code: string): string {
  const chars = code.split("");
  let i = 0;
  let state: "normal" | "sq" | "dq" | "bt" | "line_comment" | "block_comment" = "normal";
  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1] ?? "";
    if (state === "line_comment") {
      if (ch === "\n") {
        state = "normal";
      } else {
        chars[i] = " ";
      }
      i += 1;
      continue;
    }
    if (state === "block_comment") {
      if (ch === "*" && next === "/") {
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
        state = "normal";
      } else {
        if (ch !== "\n") chars[i] = " ";
        i += 1;
      }
      continue;
    }
    if (state === "sq" || state === "dq" || state === "bt") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if ((state === "sq" && ch === "'") || (state === "dq" && ch === '"') || (state === "bt" && ch === "`")) {
        state = "normal";
      }
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      state = "line_comment";
      continue;
    }
    if (ch === "/" && next === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      state = "block_comment";
      continue;
    }
    if (ch === "'") state = "sq";
    else if (ch === '"') state = "dq";
    else if (ch === "`") state = "bt";
    i += 1;
  }
  return chars.join("");
}

function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}

function getLineSnippet(source: string, lineNumber: number): string {
  const lines = source.split(/\r?\n/);
  return (lines[lineNumber - 1] ?? "").trim().slice(0, 180);
}

function readBalancedParenContent(source: string, openParenIdx: number): { content: string; endIdx: number } | null {
  if (source[openParenIdx] !== "(") return null;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = openParenIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: source.slice(openParenIdx + 1, i),
          endIdx: i,
        };
      }
    }
  }
  return null;
}

function splitTopLevelArgs(argList: string): string[] {
  const args: string[] = [];
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let quote: "'" | '"' | "`" | null = null;
  let start = 0;

  for (let i = 0; i < argList.length; i += 1) {
    const ch = argList[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depthParen += 1;
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
    else if (ch === "{") depthBrace += 1;
    else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === "[") depthBracket += 1;
    else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === "," && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      args.push(argList.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = argList.slice(start).trim();
  if (tail) args.push(tail);
  return args;
}

function findEnclosingContexts(cleanedCode: string, idx: number): {
  insideFunctionOrIife: boolean;
  insideIife: boolean;
  lateContextReason: string | null;
} {
  // Scan backwards for active unclosed braces and inspect their headers conservatively
  let depth = 0;
  const openBraceIndices: number[] = [];
  let quote: "'" | '"' | "`" | null = null;

  for (let i = 0; i < idx; i += 1) {
    const ch = cleanedCode[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      openBraceIndices.push(i);
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      openBraceIndices.pop();
    }
  }

  let insideFunctionOrIife = false;
  let insideIife = false;
  let lateContextReason: string | null = null;

  for (const bIdx of openBraceIndices) {
    const header = cleanedCode.slice(Math.max(0, bIdx - 180), bIdx);
    const tailAfter = cleanedCode.slice(idx, Math.min(cleanedCode.length, idx + 450));
    if (/\bfunction\b|=>/.test(header)) {
      insideFunctionOrIife = true;
      if (/\(\s*(?:function\b|\([^)]*\)\s*=>|[a-zA-Z_$][\w$]*\s*=>)\s*$/.test(header) || /^\s*\}?\s*\)\s*\(\s*\)/.test(tailAfter) || /\(\s*\(\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/.test(header)) {
        insideIife = true;
      }
    }
    const lateMatch = LATE_HOOK_RE.exec(header);
    if (lateMatch) {
      lateContextReason = lateMatch[0].trim();
    }
  }

  // Also inspect if inside an explicit IIFE wrapper `(function(){ ... })()` or `(() => { ... })()`
  const iifeRe = /\(\s*(?:async\s+)?(?:function\s*[a-zA-Z_$0-9]*\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{/g;
  let im: RegExpExecArray | null;
  while ((im = iifeRe.exec(cleanedCode)) !== null) {
    const braceStart = im.index + im[0].length - 1;
    if (braceStart >= idx) break;
    // Find matching closing brace of this IIFE
    let bDepth = 0;
    let closeBrace = -1;
    let q: "'" | '"' | "`" | null = null;
    for (let k = braceStart; k < cleanedCode.length; k += 1) {
      const c = cleanedCode[k];
      if (q) {
        if (c === "\\") {
          k += 1;
          continue;
        }
        if (c === q) q = null;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        q = c;
        continue;
      }
      if (c === "{") bDepth += 1;
      else if (c === "}") {
        bDepth -= 1;
        if (bDepth === 0) {
          closeBrace = k;
          break;
        }
      }
    }
    if (closeBrace !== -1 && idx < closeBrace) {
      const afterClose = cleanedCode.slice(closeBrace + 1, closeBrace + 24);
      if (/^\s*\)\s*\(/.test(afterClose)) {
        insideIife = true;
        insideFunctionOrIife = true;
      }
    }
  }

  return { insideFunctionOrIife, insideIife, lateContextReason };
}

function extractCallbacksFromText(text: string): string[] {
  const names: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(CALLBACK_PROP_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m[1]) names.push(m[1]);
  }
  return Array.from(new Set(names));
}

function unquoteStringLiteral(expr: string): string | null {
  const trimmed = expr.trim();
  if (/^"[^"\\$]*"$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^'[^'\\$]*'$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^`[^`$\\]*`$/.test(trimmed)) return trimmed.slice(1, -1);
  return null;
}

/**
 * Pure static scanner for GSAP timelines, registrations, cached references,
 * lifecycle callbacks, late registration hooks, IIFEs, and dynamic expressions.
 * NEVER executes any user JS.
 */
export function scanJsStatic(file: string, rawCode: string, lineOffset = 0): JsStaticScanResult {
  if (isLikelyVendorBundle(file, rawCode)) {
    return {
      file,
      skippedAsVendorLibrary: true,
      timelineCreations: [],
      timelineRegistrations: [],
      timelineCalls: [],
      cachedReferences: [],
      dynamicPatterns: [],
    };
  }

  const cleaned = stripJsCommentsPreserveLines(rawCode);
  const timelineCreations: ScannedTimelineCreation[] = [];
  const timelineRegistrations: ScannedTimelineRegistration[] = [];
  const timelineCalls: ScannedTimelineCall[] = [];
  const cachedReferences: ScannedCachedReference[] = [];
  const dynamicPatterns: ScannedDynamicPattern[] = [];

  // 1. Track cached raw DOM/timeline references (e.g. const el = document.querySelector(...), const tls = window.__timelines)
  const domRefMap = new Map<string, { selector: string | null; line: number; isDynamic: boolean }>();
  const domDeclRe =
    /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*document\.(querySelector|getElementById|querySelectorAll)\s*\(/g;
  let dm: RegExpExecArray | null;
  while ((dm = domDeclRe.exec(cleaned)) !== null) {
    const varName = dm[1];
    const fnName = dm[2];
    const parenIdx = dm.index + dm[0].length - 1;
    const balanced = readBalancedParenContent(cleaned, parenIdx);
    const arg = balanced ? balanced.content.trim() : "";
    const lit = unquoteStringLiteral(arg);
    const selector = lit ? (fnName === "getElementById" ? `#${lit}` : lit) : null;
    const pos = offsetToLineCol(rawCode, dm.index);
    const line = pos.line + lineOffset;
    domRefMap.set(varName, { selector, line, isDynamic: !lit });
    cachedReferences.push({
      file,
      line,
      varName,
      kind: "dom_ref",
      snippet: getLineSnippet(rawCode, pos.line),
    });
  }

  const tlRefCacheRe =
    /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:window\.)?(?:__timelines\b(?:\.[a-zA-Z_$][\w$]*)?|gsap\.timeline\b)/g;
  let trm: RegExpExecArray | null;
  while ((trm = tlRefCacheRe.exec(cleaned)) !== null) {
    // Only record non-gsap.timeline(...) calls (i.e. raw reference aliasing like `const tlStore = window.__timelines` or `const t = window.gsap.timeline`)
    const afterMatch = cleaned.slice(trm.index + trm[0].length).trimStart();
    if (!afterMatch.startsWith("(")) {
      const pos = offsetToLineCol(rawCode, trm.index);
      cachedReferences.push({
        file,
        line: pos.line + lineOffset,
        varName: trm[1],
        kind: "timeline_or_gsap_ref",
        snippet: getLineSnippet(rawCode, pos.line),
      });
    }
  }

  // 2. Scan gsap.timeline(...) creations
  const timelineVars = new Set<string>();
  const createRe = /(?:(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*)?gsap\.timeline\s*\(/g;
  let cm: RegExpExecArray | null;
  while ((cm = createRe.exec(cleaned)) !== null) {
    const varName = cm[1] ?? null;
    if (varName) timelineVars.add(varName);
    const openIdx = cm.index + cm[0].length - 1;
    const balanced = readBalancedParenContent(cleaned, openIdx);
    const optionsRaw = balanced ? balanced.content.trim() : "";
    let pausedOption: boolean | null = null;
    if (/\bpaused\s*:\s*true\b/.test(optionsRaw)) pausedOption = true;
    else if (/\bpaused\s*:\s*false\b/.test(optionsRaw)) pausedOption = false;

    const cbNames = extractCallbacksFromText(optionsRaw);
    const hasDynamicOptions = /\$\{|\bMath\.random\b|\bDate\.now\b|\bperformance\.now\b|=>/.test(optionsRaw);
    const ctx = findEnclosingContexts(cleaned, cm.index);
    const pos = offsetToLineCol(rawCode, cm.index);

    timelineCreations.push({
      file,
      line: pos.line + lineOffset,
      column: pos.column,
      varName,
      optionsRaw,
      pausedOption,
      hasCallbacks: cbNames.length > 0,
      callbackNames: cbNames,
      hasDynamicOptions,
      insideFunctionOrIife: ctx.insideFunctionOrIife,
      insideIife: ctx.insideIife,
      insideLateContext: ctx.lateContextReason !== null,
      lateContextReason: ctx.lateContextReason,
      snippet: getLineSnippet(rawCode, pos.line),
    });
  }

  // 3. Scan window.__timelines registrations (static dot, bracket literal, or dynamic bracket)
  const regDotRe = /(?:window|globalThis)\.__timelines\.([a-zA-Z_$][\w$]*)\s*=\s*([^\n;]+)/g;
  let rdm: RegExpExecArray | null;
  while ((rdm = regDotRe.exec(cleaned)) !== null) {
    const pos = offsetToLineCol(rawCode, rdm.index);
    const ctx = findEnclosingContexts(cleaned, rdm.index);
    timelineRegistrations.push({
      file,
      line: pos.line + lineOffset,
      key: rdm[1],
      isDynamicKey: false,
      assignedExpr: rdm[2].trim(),
      insideLateContext: ctx.lateContextReason !== null,
      lateContextReason: ctx.lateContextReason,
      insideIife: ctx.insideIife,
      snippet: getLineSnippet(rawCode, pos.line),
    });
  }

  const regBracketRe = /(?:window|globalThis)\.__timelines\s*\[([^\]]+)\]\s*=\s*([^\n;]+)/g;
  let rbm: RegExpExecArray | null;
  while ((rbm = regBracketRe.exec(cleaned)) !== null) {
    const rawKey = rbm[1].trim();
    const litKey = unquoteStringLiteral(rawKey);
    const pos = offsetToLineCol(rawCode, rbm.index);
    const ctx = findEnclosingContexts(cleaned, rbm.index);
    timelineRegistrations.push({
      file,
      line: pos.line + lineOffset,
      key: litKey,
      isDynamicKey: litKey === null,
      assignedExpr: rbm[2].trim(),
      insideLateContext: ctx.lateContextReason !== null,
      lateContextReason: ctx.lateContextReason,
      insideIife: ctx.insideIife,
      snippet: getLineSnippet(rawCode, pos.line),
    });
  }

  const regObjRe = /(?:window|globalThis)\.__timelines\s*=\s*\{([^}]*)\}/g;
  let rom: RegExpExecArray | null;
  while ((rom = regObjRe.exec(cleaned)) !== null) {
    const body = rom[1].trim();
    if (!body) continue;
    const pos = offsetToLineCol(rawCode, rom.index);
    const ctx = findEnclosingContexts(cleaned, rom.index);
    const keyRe = /([a-zA-Z_$][\w$]*|"[^"]+"|'[^']+')\s*:/g;
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec(body)) !== null) {
      const k = km[1].replace(/^["']|["']$/g, "");
      timelineRegistrations.push({
        file,
        line: pos.line + lineOffset,
        key: k,
        isDynamicKey: false,
        assignedExpr: body.slice(0, 80),
        insideLateContext: ctx.lateContextReason !== null,
        lateContextReason: ctx.lateContextReason,
        insideIife: ctx.insideIife,
        snippet: getLineSnippet(rawCode, pos.line),
      });
    }
  }

  // Detect also aliases like `const __tls = window.__timelines = ...; __tls.main = ...` via ambiguous aliasing
  const targetCallees = new Set<string>(["gsap", ...timelineVars]);
  for (const reg of timelineRegistrations) {
    const identMatch = /^([a-zA-Z_$][\w$]*)/.exec(reg.assignedExpr);
    if (identMatch) targetCallees.add(identMatch[1]);
  }

  // 4. Scan GSAP timeline/tween method calls
  const callRe = /\b([a-zA-Z_$][\w$]*)\.(to|fromTo|from|set|call|eventCallback)\s*\(/g;
  let gm: RegExpExecArray | null;
  while ((gm = callRe.exec(cleaned)) !== null) {
    const calleeVar = gm[1];
    const method = gm[2] as ScannedTimelineCall["method"];
    if (!targetCallees.has(calleeVar)) continue;

    const openIdx = gm.index + gm[0].length - 1;
    const balanced = readBalancedParenContent(cleaned, openIdx);
    if (!balanced) continue;

    const args = splitTopLevelArgs(balanced.content);
    const pos = offsetToLineCol(rawCode, gm.index);

    if (method === "call" || method === "eventCallback") {
      timelineCalls.push({
        file,
        line: pos.line + lineOffset,
        column: pos.column,
        calleeVar,
        method,
        targetArg: null,
        targetSelector: null,
        targetIsDynamic: false,
        varsSnippet: balanced.content.trim().slice(0, 120),
        hasCallback: true,
        callbackNames: [method],
        hasDynamicVars: false,
        hasVisibilityChange: false,
        explicitDurationSec: null,
        snippet: getLineSnippet(rawCode, pos.line),
      });
      continue;
    }

    const targetArg = args[0] ?? "";
    const litTarget = unquoteStringLiteral(targetArg);
    const cachedDom = /^[a-zA-Z_$][\w$]*$/.test(targetArg.trim())
      ? domRefMap.get(targetArg.trim())
      : undefined;
    const targetSelector = litTarget ?? cachedDom?.selector ?? null;
    const targetIsDynamic = litTarget === null;

    const varsSnippet = method === "fromTo" ? args.slice(1).join(", ") : (args[1] ?? "");
    const cbNames = extractCallbacksFromText(varsSnippet);
    const hasDynamicVars =
      /\b(?:Math\.random|Date\.now|performance\.now|eval)\b|\(\s*[^)]*\)\s*=>|function\s*\([^)]*\)|\$\{/.test(
        varsSnippet
      );
    const hasVisibilityChange = /\b(?:opacity|autoAlpha|visibility|display)\s*:/.test(varsSnippet);

    let explicitDurationSec: number | null = null;
    const durMatch = /\bduration\s*:\s*([0-9]+(?:\.[0-9]+)?)\b/.exec(varsSnippet);
    if (durMatch) {
      const parsed = Number(durMatch[1]);
      if (Number.isFinite(parsed) && parsed >= 0) explicitDurationSec = parsed;
    }

    timelineCalls.push({
      file,
      line: pos.line + lineOffset,
      column: pos.column,
      calleeVar,
      method,
      targetArg: targetArg || null,
      targetSelector,
      targetIsDynamic,
      varsSnippet: varsSnippet.slice(0, 140),
      hasCallback: cbNames.length > 0,
      callbackNames: cbNames,
      hasDynamicVars,
      hasVisibilityChange,
      explicitDurationSec,
      snippet: getLineSnippet(rawCode, pos.line),
    });
  }

  // 5. Scan dangerous/dynamic/unsupported runtime expressions
  const dynChecks: Array<{
    re: RegExp;
    kind: ScannedDynamicPattern["kind"];
    detail: string;
  }> = [
    {
      re: /\beval\s*\(|\bnew\s+Function\s*\(/g,
      kind: "eval_or_function",
      detail: "Dynamic code execution (eval / new Function) cannot be safely analyzed or auto-fixed",
    },
    {
      re: /\b(?:Math\.random|Date\.now|performance\.now)\s*\(/g,
      kind: "nondeterministic_runtime",
      detail: "Non-deterministic time/random expression undermines reproducible frame-accurate seek",
    },
    {
      re: /\bScrollTrigger\b|\bgsap\.ticker\.add\s*\(/g,
      kind: "unsupported_ticker_or_scroll",
      detail: "Unsupported ScrollTrigger or gsap.ticker.add pattern outside seek contract",
    },
    {
      re: /\bfetch\s*\(\s*["'`]https?:\/\/|\bnew\s+WebSocket\s*\(/g,
      kind: "external_network_call",
      detail: "External network call violates offline-first security policy",
    },
    {
      re: /\bdocument\.querySelector(?:All)?\s*\(\s*(?:`[^`]*\$\{|[a-zA-Z_$])/g,
      kind: "dynamic_selector_or_expression",
      detail: "Computed DOM selector cannot be mapped deterministically without executing JS",
    },
  ];

  for (const chk of dynChecks) {
    let m: RegExpExecArray | null;
    while ((m = chk.re.exec(cleaned)) !== null) {
      const pos = offsetToLineCol(rawCode, m.index);
      dynamicPatterns.push({
        file,
        line: pos.line + lineOffset,
        kind: chk.kind,
        detail: chk.detail,
        snippet: getLineSnippet(rawCode, pos.line),
      });
    }
  }

  return {
    file,
    skippedAsVendorLibrary: false,
    timelineCreations,
    timelineRegistrations,
    timelineCalls,
    cachedReferences,
    dynamicPatterns,
  };
}
