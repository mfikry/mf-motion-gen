import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BrowserWindow, WebContentsView, session } from "electron";
import type {
  ApplyDiagnosticFixResult,
  AssetTreeNode,
  CompositionAnalysisReport,
  CompositionSourceMode,
  InspectElementResult,
  PreviewBounds,
  PreviewSessionInfo,
  PreviewTimelineState,
  PreviewViewportState,
  SecurityViolationEvent,
  ViewportScaleMode,
} from "../../shared/previewContracts.js";
import { computeTotalFrames, parseFpsValue } from "../../shared/frameMath.js";
import type { FpsFraction, PreflightResult } from "../../shared/renderContracts.js";
import { applyFixProposalToWorkingCopy, type ServerFixProposalRecord } from "../analysis/codeDiffEngine.js";
import { analyzeComposition } from "../analysis/compositionAnalyzer.js";
import { buildLocalAssetTree } from "../import/projectImporter.js";
import { purgeSessionDirectoryAsync } from "../import/sessionFsUtils.js";
import { setupAssetProtocolHandler } from "../security/assetProtocolHandler.js";
import { registerCentralizedNetworkPolicy } from "../security/networkPolicyManager.js";
import { validateCompositionPreflight } from "../validation/hostPreflightValidator.js";

export interface ManagedPreviewSession {
  sessionId: string;
  stageDir: string;
  entryFile: string;
  entryPath: string;
  entryUrl: string;
  title: string;
  sourceMode: CompositionSourceMode;
  importKind: "html" | "paste" | "folder" | "zip";
  sourceDigestSha256: string | null;
  sourceFileCount: number;
  hashesByRelPath?: Record<string, string>;
  workingCopyModified: boolean;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  fps: FpsFraction | null;
  totalFrames: number | null;
  localAssets: string[];
  assetTree: AssetTreeNode[];
  analysis: CompositionAnalysisReport;
  fixProposals: Map<string, ServerFixProposalRecord>;
  markersSec: number[];
  ownedTempDir: string | null;
  previewSession: Electron.Session;
  view: WebContentsView;
  preflight: PreflightResult;
}

export function parseCompositionMetadata(html: string): {
  width: number | null;
  height: number | null;
  durationSec: number | null;
  fps: FpsFraction | null;
} {
  const positiveAttr = (name: string): number | null => {
    const m = new RegExp(`data-${name}\\s*=\\s*["']?([0-9]+(?:\\.[0-9]+)?)`, "i").exec(html);
    if (!m) return null;
    const val = Number(m[1]);
    return Number.isFinite(val) && val > 0 ? val : null;
  };

  const fpsMatch = /data-fps\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  const rawFps = fpsMatch ? (fpsMatch[1] ?? fpsMatch[2] ?? fpsMatch[3] ?? "") : null;

  return {
    width: positiveAttr("width"),
    height: positiveAttr("height"),
    durationSec: positiveAttr("duration"),
    fps: parseFpsValue(rawFps),
  };
}

export class PreviewContainerManager {
  private hostWindow: BrowserWindow | null = null;
  private activeSession: ManagedPreviewSession | null = null;
  private panelRect: PreviewBounds = { x: 320, y: 88, width: 640, height: 420 };
  private viewportMode: ViewportScaleMode = "fit";
  private readonly onViolation?: (ev: SecurityViolationEvent) => void;
  private beforeSessionPurge?: (sessionId: string) => Promise<void>;

  constructor(onViolation?: (ev: SecurityViolationEvent) => void) {
    this.onViolation = onViolation;
  }

  setBeforeSessionPurgeHandler(handler: (sessionId: string) => Promise<void>): void {
    this.beforeSessionPurge = handler;
  }

  attachHostWindow(win: BrowserWindow): void {
    this.hostWindow = win;
    if (this.activeSession) {
      this.hostWindow.contentView.addChildView(this.activeSession.view);
      this.applyViewportGeometry();
    }
  }

  setBounds(nextBounds: PreviewBounds): void {
    this.panelRect = {
      x: Math.max(0, Math.round(nextBounds.x)),
      y: Math.max(0, Math.round(nextBounds.y)),
      width: Math.max(100, Math.round(nextBounds.width)),
      height: Math.max(100, Math.round(nextBounds.height)),
    };
    this.applyViewportGeometry();
  }

  setViewport(panelRect: PreviewBounds, mode: ViewportScaleMode): PreviewViewportState {
    this.panelRect = {
      x: Math.max(0, Math.round(panelRect.x)),
      y: Math.max(0, Math.round(panelRect.y)),
      width: Math.max(100, Math.round(panelRect.width)),
      height: Math.max(100, Math.round(panelRect.height)),
    };
    this.viewportMode = mode;
    return this.applyViewportGeometry();
  }

  private applyViewportGeometry(): PreviewViewportState {
    const s = this.activeSession;
    const compW = s?.width ?? this.panelRect.width;
    const compH = s?.height ?? this.panelRect.height;

    let rawScale: number;
    if (this.viewportMode === "50") rawScale = 0.5;
    else if (this.viewportMode === "100") rawScale = 1.0;
    else if (this.viewportMode === "200") rawScale = 2.0;
    else {
      rawScale = Math.min(this.panelRect.width / compW, this.panelRect.height / compH);
    }

    const scaleFactor = Math.max(0.1, Math.min(3.0, Number(rawScale.toFixed(4))));
    const desiredW = Math.round(compW * scaleFactor);
    const desiredH = Math.round(compH * scaleFactor);

    const boundedW = Math.max(80, Math.min(this.panelRect.width, desiredW));
    const boundedH = Math.max(80, Math.min(this.panelRect.height, desiredH));
    const x = this.panelRect.x + Math.floor((this.panelRect.width - boundedW) / 2);
    const y = this.panelRect.y + Math.floor((this.panelRect.height - boundedH) / 2);

    const bounds: PreviewBounds = { x, y, width: boundedW, height: boundedH };
    if (s) {
      s.view.setBounds(bounds);
      try {
        // Clamp Electron zoom factor within Chromium supported range [0.25..3.0]
        s.view.webContents.setZoomFactor(Math.max(0.25, Math.min(3.0, scaleFactor)));
      } catch {
        // Ignore if webContents not ready
      }
    }
    return { scaleFactor, bounds };
  }

  getSession(sessionId: string): ManagedPreviewSession | null {
    if (!this.activeSession || this.activeSession.sessionId !== sessionId) {
      return null;
    }
    return this.activeSession;
  }

  getActiveSession(): ManagedPreviewSession | null {
    return this.activeSession;
  }

  private async loadAuthorizedPreviewEntry(
    view: WebContentsView,
    expectedEntryUrl: string
  ): Promise<void> {
    if (view.webContents.getURL() !== expectedEntryUrl) {
      await view.webContents.loadURL(expectedEntryUrl);
    }
    try {
      view.webContents.navigationHistory.clear();
    } catch {
      // Ignore if navigationHistory unavailable
    }
  }

  private toSessionInfo(managed: ManagedPreviewSession): PreviewSessionInfo {
    return {
      sessionId: managed.sessionId,
      origin: `mf-asset://${managed.sessionId}`,
      entryUrl: managed.entryUrl,
      entryFile: managed.entryFile,
      title: managed.title,
      sourceMode: managed.sourceMode,
      importKind: managed.importKind,
      sourceDigestSha256: managed.sourceDigestSha256,
      sourceFileCount: managed.sourceFileCount,
      workingCopyModified: managed.workingCopyModified,
      width: managed.width,
      height: managed.height,
      durationSec: managed.durationSec,
      fps: managed.fps,
      totalFrames: managed.totalFrames,
      localAssets: managed.localAssets,
      assetTree: managed.assetTree,
      analysis: managed.analysis,
      markersSec: managed.markersSec,
      preflight: managed.preflight,
    };
  }

  async openVerifiedDirectory(
    rawStageDir: string,
    options: {
      entryFile?: string;
      title?: string;
      sourceMode?: CompositionSourceMode;
      importKind?: "html" | "paste" | "folder" | "zip";
      sourceDigestSha256?: string | null;
      sourceFileCount?: number;
      hashesByRelPath?: Record<string, string>;
      ownedTempDir?: string | null;
    } = {}
  ): Promise<
    | { ok: true; session: PreviewSessionInfo }
    | { ok: false; preflight: PreflightResult; assetTree?: AssetTreeNode[]; analysis?: CompositionAnalysisReport }
  > {
    const entryFile = options.entryFile ?? "index.html";
    const sourceMode: CompositionSourceMode =
      options.sourceMode ?? (options.ownedTempDir ? "working_copy" : "original_file");
    const preflight = validateCompositionPreflight(rawStageDir, { entryFile });
    if (!preflight.ok || !preflight.entryPath) {
      let failedTree: AssetTreeNode[] | undefined;
      let failedAnalysis: CompositionAnalysisReport | undefined;
      if (fs.existsSync(rawStageDir)) {
        try {
          failedTree = buildLocalAssetTree(rawStageDir, entryFile, preflight, options.hashesByRelPath);
        } catch {
          failedTree = undefined;
        }
        try {
          failedAnalysis = analyzeComposition(rawStageDir, { entryFile, preflight }).report;
        } catch {
          failedAnalysis = undefined;
        }
      }
      if (options.ownedTempDir) {
        await purgeSessionDirectoryAsync(options.ownedTempDir).catch(() => {});
      }
      return { ok: false, preflight, assetTree: failedTree, analysis: failedAnalysis };
    }

    await this.disposeActiveSession();

    const sessionId = crypto.randomUUID();
    const partitionName = `preview-${sessionId}`;
    const previewSession = session.fromPartition(partitionName, { cache: false });

    const entrySegments = entryFile.replace(/\\/g, "/").split("/").filter(Boolean);
    const allowedEntryPath = "/" + entrySegments.join("/");
    const origin = `mf-asset://${sessionId}`;
    const entryUrl = `${origin}${allowedEntryPath}`;

    setupAssetProtocolHandler(previewSession, sessionId, preflight.stageDir, entrySegments);
    registerCentralizedNetworkPolicy(previewSession, sessionId, allowedEntryPath, (ev) => {
      this.onViolation?.(ev);
    });

    const view = new WebContentsView({
      webPreferences: {
        session: previewSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        javascript: true,
        navigateOnDragDrop: false,
      },
    });

    const wc = view.webContents;

    wc.setWindowOpenHandler(({ url }) => {
      this.onViolation?.({
        sessionId,
        source: "popup",
        url,
        reason: "blocked_window_open",
        timestampMs: Date.now(),
      });
      return { action: "deny" };
    });

    wc.on("will-navigate", (event, targetUrl) => {
      if (targetUrl !== entryUrl) {
        event.preventDefault();
        this.onViolation?.({
          sessionId,
          source: "navigation",
          url: targetUrl,
          reason: "blocked_will_navigate",
          timestampMs: Date.now(),
        });
      }
    });

    wc.on("will-redirect", (event, targetUrl) => {
      if (targetUrl !== entryUrl) {
        event.preventDefault();
        this.onViolation?.({
          sessionId,
          source: "navigation",
          url: targetUrl,
          reason: "blocked_will_redirect",
          timestampMs: Date.now(),
        });
      }
    });

    const entryHtml = fs.readFileSync(preflight.entryPath, "utf8");
    const meta = parseCompositionMetadata(entryHtml);
    const localAssets = preflight.checkedLocalAssets.map((absPath) =>
      path.relative(preflight.stageDir, absPath).replace(/\\/g, "/")
    );
    const assetTree = buildLocalAssetTree(
      preflight.stageDir,
      entryFile,
      preflight,
      options.hashesByRelPath
    );
    const analyzed = analyzeComposition(preflight.stageDir, {
      entryFile,
      sessionId,
      preflight,
    });

    const managed: ManagedPreviewSession = {
      sessionId,
      stageDir: preflight.stageDir,
      entryFile,
      entryPath: allowedEntryPath,
      entryUrl,
      title: options.title ?? path.basename(preflight.stageDir),
      sourceMode,
      importKind: options.importKind ?? (sourceMode === "original_file" ? "html" : "paste"),
      sourceDigestSha256: options.sourceDigestSha256 ?? null,
      sourceFileCount: options.sourceFileCount ?? localAssets.length + 1,
      hashesByRelPath: options.hashesByRelPath,
      workingCopyModified: false,
      width: meta.width,
      height: meta.height,
      durationSec: meta.durationSec,
      fps: meta.fps,
      totalFrames: computeTotalFrames(meta.durationSec, meta.fps),
      localAssets,
      assetTree,
      analysis: analyzed.report,
      fixProposals: analyzed.proposalsByDiagnosticId,
      markersSec: [],
      ownedTempDir: options.ownedTempDir ?? null,
      previewSession,
      view,
      preflight,
    };

    this.activeSession = managed;
    if (this.hostWindow) {
      this.hostWindow.contentView.addChildView(view);
    }

    await this.loadAuthorizedPreviewEntry(view, entryUrl);
    this.applyViewportGeometry();

    // Enrich duration and markers from live runtime timeline if declared dynamically, without fabricating absent fields.
    try {
      const liveState = await this.getTimelineState(managed.sessionId);
      if (
        managed.durationSec === null &&
        typeof liveState.durationSec === "number" &&
        Number.isFinite(liveState.durationSec) &&
        liveState.durationSec > 0
      ) {
        managed.durationSec = liveState.durationSec;
        managed.totalFrames = computeTotalFrames(managed.durationSec, managed.fps);
      }
      managed.markersSec = liveState.markersSec ?? [];
    } catch {
      // Keep parsed metadata if script evaluation is unavailable
    }

    return {
      ok: true,
      session: this.toSessionInfo(managed),
    };
  }

  refreshSessionAssets(sessionId: string): {
    preflight: PreflightResult;
    assetTree: AssetTreeNode[];
    localAssets: string[];
    analysis: CompositionAnalysisReport;
  } {
    const s = this.getSession(sessionId);
    if (!s) {
      throw new Error(`No active preview session "${sessionId}"`);
    }
    const preflight = validateCompositionPreflight(s.stageDir, { entryFile: s.entryFile });
    const assetTree = buildLocalAssetTree(s.stageDir, s.entryFile, preflight, s.hashesByRelPath);
    const localAssets = preflight.checkedLocalAssets.map((absPath) =>
      path.relative(preflight.stageDir, absPath).replace(/\\/g, "/")
    );
    const analyzed = analyzeComposition(s.stageDir, {
      entryFile: s.entryFile,
      sessionId: s.sessionId,
      preflight,
    });
    s.preflight = preflight;
    s.assetTree = assetTree;
    s.localAssets = localAssets;
    s.analysis = analyzed.report;
    s.fixProposals = analyzed.proposalsByDiagnosticId;
    return { preflight, assetTree, localAssets, analysis: analyzed.report };
  }

  runStaticAnalysis(sessionId: string): CompositionAnalysisReport {
    const s = this.getSession(sessionId);
    if (!s) {
      throw new Error(`No active preview session "${sessionId}"`);
    }
    const preflight = validateCompositionPreflight(s.stageDir, { entryFile: s.entryFile });
    const analyzed = analyzeComposition(s.stageDir, {
      entryFile: s.entryFile,
      sessionId: s.sessionId,
      preflight,
    });
    s.preflight = preflight;
    s.analysis = analyzed.report;
    s.fixProposals = analyzed.proposalsByDiagnosticId;
    return analyzed.report;
  }

  previewDiagnosticDiff(sessionId: string, diagnosticId: string) {
    const s = this.getSession(sessionId);
    if (!s) {
      throw new Error(`No active preview session "${sessionId}"`);
    }
    const diag = s.analysis.diagnostics.find((d) => d.id === diagnosticId);
    if (!diag) {
      throw new Error(`Diagnostic "${diagnosticId}" not found in session`);
    }
    if (!diag.canAutoFix) {
      throw new Error(diag.noAutoFixReason || "NO-AUTO-FIX: Diagnostic is not eligible for automated diff");
    }
    const proposal = s.fixProposals.get(diagnosticId);
    if (!proposal) {
      throw new Error(`No fix proposal generated for diagnostic "${diagnosticId}"`);
    }
    if (s.sourceMode !== "working_copy" || !s.ownedTempDir) {
      throw new Error("Code diff fixes can only be applied to an isolated working copy");
    }
    return proposal.preview;
  }

  async confirmApplyDiagnosticFix(sessionId: string, proposalId: string): Promise<ApplyDiagnosticFixResult> {
    const s = this.getSession(sessionId);
    if (!s) {
      throw new Error(`No active preview session "${sessionId}"`);
    }
    const proposal = Array.from(s.fixProposals.values()).find((p) => p.proposalId === proposalId);
    if (!proposal) {
      return { ok: false, error: "Fix proposal expired or not found; re-analyze and retry" };
    }

    const applied = applyFixProposalToWorkingCopy({
      stageDir: s.stageDir,
      sourceMode: s.sourceMode,
      ownedTempDir: s.ownedTempDir,
      proposal,
    });

    s.workingCopyModified = true;

    const preflight = validateCompositionPreflight(s.stageDir, { entryFile: s.entryFile });
    s.preflight = preflight;
    s.assetTree = buildLocalAssetTree(s.stageDir, s.entryFile, preflight, s.hashesByRelPath);
    s.localAssets = preflight.checkedLocalAssets.map((absPath) =>
      path.relative(preflight.stageDir, absPath).replace(/\\/g, "/")
    );

    if (preflight.entryPath && fs.existsSync(preflight.entryPath)) {
      const entryHtml = fs.readFileSync(preflight.entryPath, "utf8");
      const meta = parseCompositionMetadata(entryHtml);
      s.width = meta.width;
      s.height = meta.height;
      s.durationSec = meta.durationSec;
      s.fps = meta.fps;
      s.totalFrames = computeTotalFrames(meta.durationSec, meta.fps);
    }

    const reanalyzed = analyzeComposition(s.stageDir, {
      entryFile: s.entryFile,
      sessionId: s.sessionId,
      preflight,
    });
    s.analysis = reanalyzed.report;
    s.fixProposals = reanalyzed.proposalsByDiagnosticId;

    await s.view.webContents.loadURL(s.entryUrl);
    this.applyViewportGeometry();
    try {
      const liveState = await this.getTimelineState(s.sessionId);
      if (
        s.durationSec === null &&
        typeof liveState.durationSec === "number" &&
        Number.isFinite(liveState.durationSec) &&
        liveState.durationSec > 0
      ) {
        s.durationSec = liveState.durationSec;
        s.totalFrames = computeTotalFrames(s.durationSec, s.fps);
      }
      s.markersSec = liveState.markersSec ?? [];
    } catch {
      // Keep parsed metadata
    }

    return {
      ok: true,
      modifiedFile: applied.modifiedFile,
      session: this.toSessionInfo(s),
    };
  }

  async inspectElement(sessionId: string, selector: string): Promise<InspectElementResult> {
    const s = this.getSession(sessionId);
    if (!s) {
      throw new Error(`No active preview session "${sessionId}"`);
    }
    const cleanSelector = selector.trim();
    if (!cleanSelector || cleanSelector.length > 256) {
      throw new Error("Invalid inspect element selector");
    }

    return s.view.webContents.executeJavaScript(`(() => {
      const selector = ${JSON.stringify(cleanSelector)};
      const existing = document.getElementById("__mf-inspect-overlay");
      if (existing) existing.remove();
      let target = null;
      try {
        target = document.querySelector(selector);
      } catch {
        return { found: false, selector };
      }
      if (!target) {
        return { found: false, selector };
      }
      if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      const r = target.getBoundingClientRect();
      const cs = getComputedStyle(target);
      const overlay = document.createElement("div");
      overlay.id = "__mf-inspect-overlay";
      overlay.style.cssText =
        "position:fixed;pointer-events:none;z-index:2147483647;border:2px dashed #38bdf8;background:rgba(56,189,248,0.14);box-shadow:0 0 0 1px rgba(2,132,199,0.75);box-sizing:border-box;";
      overlay.style.left = Math.max(0, r.left) + "px";
      overlay.style.top = Math.max(0, r.top) + "px";
      overlay.style.width = Math.max(4, r.width) + "px";
      overlay.style.height = Math.max(4, r.height) + "px";

      const tag = document.createElement("div");
      tag.textContent = selector;
      tag.style.cssText =
        "position:absolute;left:-2px;top:-18px;background:#0284c7;color:#fff;font:600 10px/14px Consolas,monospace;padding:1px 5px;border-radius:3px;white-space:nowrap;";
      overlay.appendChild(tag);
      document.body.appendChild(overlay);

      return {
        found: true,
        selector,
        tagName: target.tagName.toLowerCase(),
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
        computedDisplay: cs.display,
        computedOpacity: cs.opacity,
      };
    })()`);
  }

  async clearInspectOverlay(sessionId: string): Promise<{ ok: boolean }> {
    const s = this.getSession(sessionId);
    if (!s) return { ok: true };
    await s.view.webContents
      .executeJavaScript(`(() => { const el = document.getElementById("__mf-inspect-overlay"); if (el) el.remove(); })()`)
      .catch(() => {});
    return { ok: true };
  }

  async seekPreview(sessionId: string, timeSec: number): Promise<PreviewTimelineState> {
    const s = this.getSession(sessionId);
    if (!s) {
      throw new Error(`No active preview session "${sessionId}"`);
    }
    const safeTime = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0);
    const fallbackDur = s.durationSec === null ? "null" : String(s.durationSec);
    return s.view.webContents.executeJavaScript(`(() => {
      const t = ${safeTime};
      const collectMarkers = (tl) => {
        const out = [];
        if (window.__hf && Array.isArray(window.__hf.markers)) {
          for (const m of window.__hf.markers) {
            if (typeof m === "number" && Number.isFinite(m) && m >= 0) out.push(m);
          }
        }
        if (tl && tl.labels && typeof tl.labels === "object") {
          for (const val of Object.values(tl.labels)) {
            if (typeof val === "number" && Number.isFinite(val) && val >= 0) out.push(val);
          }
        }
        return Array.from(new Set(out)).sort((a, b) => a - b);
      };

      if (window.__hf && typeof window.__hf.seek === "function") {
        window.__hf.seek(t);
        const dur = typeof window.__hf.duration === "number" && window.__hf.duration > 0 ? window.__hf.duration : ${fallbackDur};
        return { ready: true, hasTimeline: true, durationSec: dur, currentTimeSec: t, seekSupported: true, markersSec: collectMarkers(null) };
      }
      const tl = window.__timelines && window.__timelines.main;
      if (tl && typeof tl.seek === "function") {
        if (typeof tl.pause === "function") tl.pause();
        tl.seek(t, true);
        const dur = typeof tl.duration === "function" && tl.duration() > 0 ? tl.duration() : ${fallbackDur};
        return { ready: true, hasTimeline: true, durationSec: dur, currentTimeSec: t, seekSupported: true, markersSec: collectMarkers(tl) };
      }
      return {
        ready: true,
        hasTimeline: false,
        durationSec: ${fallbackDur},
        currentTimeSec: t,
        seekSupported: false,
        markersSec: [],
        warning: "No window.__hf or window.__timelines.main seek contract found"
      };
    })()`);
  }

  async getTimelineState(sessionId: string): Promise<PreviewTimelineState> {
    const s = this.getSession(sessionId);
    if (!s) {
      throw new Error(`No active preview session "${sessionId}"`);
    }
    const fallbackDur = s.durationSec === null ? "null" : String(s.durationSec);
    return s.view.webContents.executeJavaScript(`(() => {
      const collectMarkers = (tl) => {
        const out = [];
        if (window.__hf && Array.isArray(window.__hf.markers)) {
          for (const m of window.__hf.markers) {
            if (typeof m === "number" && Number.isFinite(m) && m >= 0) out.push(m);
          }
        }
        if (tl && tl.labels && typeof tl.labels === "object") {
          for (const val of Object.values(tl.labels)) {
            if (typeof val === "number" && Number.isFinite(val) && val >= 0) out.push(val);
          }
        }
        return Array.from(new Set(out)).sort((a, b) => a - b);
      };

      if (window.__hf && typeof window.__hf.seek === "function") {
        const dur = typeof window.__hf.duration === "number" && window.__hf.duration > 0 ? window.__hf.duration : ${fallbackDur};
        return { ready: true, hasTimeline: true, durationSec: dur, currentTimeSec: 0, seekSupported: true, markersSec: collectMarkers(null) };
      }
      const tl = window.__timelines && window.__timelines.main;
      if (tl && typeof tl.seek === "function") {
        const dur = typeof tl.duration === "function" && tl.duration() > 0 ? tl.duration() : ${fallbackDur};
        const cur = typeof tl.time === "function" ? tl.time() : 0;
        return { ready: true, hasTimeline: true, durationSec: dur, currentTimeSec: cur, seekSupported: true, markersSec: collectMarkers(tl) };
      }
      return { ready: true, hasTimeline: false, durationSec: ${fallbackDur}, currentTimeSec: 0, seekSupported: false, markersSec: [] };
    })()`);
  }

  async disposeActiveSession(): Promise<void> {
    const current = this.activeSession;
    if (!current) return;
    this.activeSession = null;

    if (this.beforeSessionPurge) {
      await this.beforeSessionPurge(current.sessionId).catch(() => {});
    }

    try {
      if (this.hostWindow) {
        this.hostWindow.contentView.removeChildView(current.view);
      }
    } catch {
      // Host window may already be closing
    }

    try {
      current.view.webContents.close();
    } catch {
      // Ignore already-closed webContents
    }

    try {
      await current.previewSession.clearStorageData({
        origin: `mf-asset://${current.sessionId}`,
        storages: ["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers"],
      });
    } catch {
      // Ignore cleanup errors on closing session
    }

    if (current.ownedTempDir) {
      await purgeSessionDirectoryAsync(current.ownedTempDir).catch(() => {});
    }
  }
}
