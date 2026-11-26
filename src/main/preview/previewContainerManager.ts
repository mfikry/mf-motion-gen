import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BrowserWindow, WebContentsView, session } from "electron";
import type {
  PreviewBounds,
  PreviewSessionInfo,
  PreviewTimelineState,
  SecurityViolationEvent,
} from "../../shared/previewContracts.js";
import type { PreflightResult } from "../../shared/renderContracts.js";
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
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  ownedTempDir: string | null;
  previewSession: Electron.Session;
  view: WebContentsView;
  preflight: PreflightResult;
}

function parseBasicCompositionMetadata(html: string): {
  width: number;
  height: number;
  durationSec: number;
  fps: number;
} {
  const numAttr = (name: string, fallback: number): number => {
    const m = new RegExp(`data-${name}\\s*=\\s*["']?([0-9]+(?:\\.[0-9]+)?)`, "i").exec(html);
    if (!m) return fallback;
    const val = Number(m[1]);
    return Number.isFinite(val) && val > 0 ? val : fallback;
  };
  return {
    width: numAttr("width", 1920),
    height: numAttr("height", 1080),
    durationSec: numAttr("duration", 5),
    fps: numAttr("fps", 30),
  };
}

export class PreviewContainerManager {
  private hostWindow: BrowserWindow | null = null;
  private activeSession: ManagedPreviewSession | null = null;
  private bounds: PreviewBounds = { x: 340, y: 72, width: 860, height: 484 };
  private readonly onViolation?: (ev: SecurityViolationEvent) => void;

  constructor(onViolation?: (ev: SecurityViolationEvent) => void) {
    this.onViolation = onViolation;
  }

  attachHostWindow(win: BrowserWindow): void {
    this.hostWindow = win;
    if (this.activeSession) {
      this.hostWindow.contentView.addChildView(this.activeSession.view);
      this.activeSession.view.setBounds(this.bounds);
    }
  }

  setBounds(nextBounds: PreviewBounds): void {
    this.bounds = {
      x: Math.max(0, Math.round(nextBounds.x)),
      y: Math.max(0, Math.round(nextBounds.y)),
      width: Math.max(100, Math.round(nextBounds.width)),
      height: Math.max(100, Math.round(nextBounds.height)),
    };
    if (this.activeSession) {
      this.activeSession.view.setBounds(this.bounds);
    }
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

  /**
   * Single authorized navigation gatekeeper for Main Process programmatic loads
   * (will-navigate does NOT intercept loadURL()).
   */
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
      // Ignore if navigationHistory unavailable in older electron stubs
    }
  }

  async openVerifiedDirectory(
    rawStageDir: string,
    options: { entryFile?: string; title?: string; ownedTempDir?: string | null } = {}
  ): Promise<{ ok: true; session: PreviewSessionInfo } | { ok: false; preflight: PreflightResult }> {
    const entryFile = options.entryFile ?? "index.html";
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

    // Block all popups / new windows
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

    // Block all non-entry navigations
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
    const meta = parseBasicCompositionMetadata(entryHtml);

    const managed: ManagedPreviewSession = {
      sessionId,
      stageDir: preflight.stageDir,
      entryFile,
      entryPath: allowedEntryPath,
      entryUrl,
      title: options.title ?? path.basename(preflight.stageDir),
      width: meta.width,
      height: meta.height,
      durationSec: meta.durationSec,
      fps: meta.fps,
      ownedTempDir: options.ownedTempDir ?? null,
      previewSession,
      view,
      preflight,
    };

    this.activeSession = managed;
    if (this.hostWindow) {
      this.hostWindow.contentView.addChildView(view);
      view.setBounds(this.bounds);
    }

    await this.loadAuthorizedPreviewEntry(view, entryUrl);

    return {
      ok: true,
      session: {
        sessionId: managed.sessionId,
        origin,
        entryUrl: managed.entryUrl,
        entryFile: managed.entryFile,
        title: managed.title,
        width: managed.width,
        height: managed.height,
        durationSec: managed.durationSec,
        fps: managed.fps,
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
    return s.view.webContents.executeJavaScript(`(() => {
      const t = ${safeTime};
      if (window.__hf && typeof window.__hf.seek === "function") {
        window.__hf.seek(t);
        const dur = typeof window.__hf.duration === "number" ? window.__hf.duration : ${s.durationSec};
        return { ready: true, hasTimeline: true, durationSec: dur, currentTimeSec: t, seekSupported: true };
      }
      const tl = window.__timelines && window.__timelines.main;
      if (tl && typeof tl.seek === "function") {
        if (typeof tl.pause === "function") tl.pause();
        tl.seek(t, true);
        const dur = typeof tl.duration === "function" ? tl.duration() : ${s.durationSec};
        return { ready: true, hasTimeline: true, durationSec: dur, currentTimeSec: t, seekSupported: true };
      }
      return {
        ready: true,
        hasTimeline: false,
        durationSec: ${s.durationSec},
        currentTimeSec: t,
        seekSupported: false,
        warning: "No window.__hf or window.__timelines.main seek contract found"
      };
    })()`);
  }

  async getTimelineState(sessionId: string): Promise<PreviewTimelineState> {
    const s = this.getSession(sessionId);
    if (!s) {
      throw new Error(`No active preview session "${sessionId}"`);
    }
    return s.view.webContents.executeJavaScript(`(() => {
      if (window.__hf && typeof window.__hf.seek === "function") {
        const dur = typeof window.__hf.duration === "number" ? window.__hf.duration : ${s.durationSec};
        return { ready: true, hasTimeline: true, durationSec: dur, currentTimeSec: 0, seekSupported: true };
      }
      const tl = window.__timelines && window.__timelines.main;
      if (tl && typeof tl.seek === "function") {
        const dur = typeof tl.duration === "function" ? tl.duration() : ${s.durationSec};
        const cur = typeof tl.time === "function" ? tl.time() : 0;
        return { ready: true, hasTimeline: true, durationSec: dur, currentTimeSec: cur, seekSupported: true };
      }
      return { ready: true, hasTimeline: false, durationSec: ${s.durationSec}, currentTimeSec: 0, seekSupported: false };
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
