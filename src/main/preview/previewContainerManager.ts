import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BrowserWindow, WebContentsView, session } from "electron";
import type {
  CompositionSourceMode,
  PreviewBounds,
  PreviewSessionInfo,
  PreviewTimelineState,
  PreviewViewportState,
  SecurityViolationEvent,
  ViewportScaleMode,
} from "../../shared/previewContracts.js";
import { computeTotalFrames, parseFpsValue } from "../../shared/frameMath.js";
import type { FpsFraction, PreflightResult } from "../../shared/renderContracts.js";
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
  width: number | null;
  height: number | null;
  durationSec: number | null;
  fps: FpsFraction | null;
  totalFrames: number | null;
  localAssets: string[];
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

  constructor(onViolation?: (ev: SecurityViolationEvent) => void) {
    this.onViolation = onViolation;
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

  async openVerifiedDirectory(
    rawStageDir: string,
    options: {
      entryFile?: string;
      title?: string;
      sourceMode?: CompositionSourceMode;
      ownedTempDir?: string | null;
    } = {}
  ): Promise<{ ok: true; session: PreviewSessionInfo } | { ok: false; preflight: PreflightResult }> {
    const entryFile = options.entryFile ?? "index.html";
    const sourceMode: CompositionSourceMode =
      options.sourceMode ?? (options.ownedTempDir ? "working_copy" : "original_file");
    const preflight = validateCompositionPreflight(rawStageDir, { entryFile });
    if (!preflight.ok || !preflight.entryPath) {
      if (options.ownedTempDir) {
        await fsPromises.rm(options.ownedTempDir, { recursive: true, force: true }).catch(() => {});
      }
      return { ok: false, preflight };
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

    const managed: ManagedPreviewSession = {
      sessionId,
      stageDir: preflight.stageDir,
      entryFile,
      entryPath: allowedEntryPath,
      entryUrl,
      title: options.title ?? path.basename(preflight.stageDir),
      sourceMode,
      width: meta.width,
      height: meta.height,
      durationSec: meta.durationSec,
      fps: meta.fps,
      totalFrames: computeTotalFrames(meta.durationSec, meta.fps),
      localAssets,
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
      session: {
        sessionId: managed.sessionId,
        origin,
        entryUrl: managed.entryUrl,
        entryFile: managed.entryFile,
        title: managed.title,
        sourceMode: managed.sourceMode,
        width: managed.width,
        height: managed.height,
        durationSec: managed.durationSec,
        fps: managed.fps,
        totalFrames: managed.totalFrames,
        localAssets: managed.localAssets,
        markersSec: managed.markersSec,
        preflight: managed.preflight,
      },
    };
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
      await fsPromises.rm(current.ownedTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
