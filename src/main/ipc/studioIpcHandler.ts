import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, dialog, ipcMain } from "electron";
import {
  IPC_CHANNELS,
  type LoadPastedHtmlPayload,
  type PreviewBounds,
  type PreviewSeekPayload,
  type SessionIdPayload,
  type SessionRenderRequestPayload,
} from "../../shared/previewContracts.js";
import type { PreflightResult, RenderJobRequest } from "../../shared/renderContracts.js";
import { PreviewContainerManager } from "../preview/previewContainerManager.js";
import { RenderCoordinator } from "../render/renderCoordinator.js";

const MAX_PASTE_HTML_BYTES = 2 * 1024 * 1024;
const ALLOWED_FORMATS = new Set(["mp4", "mov", "webm"]);
const ALLOWED_QUALITIES = new Set(["draft", "standard", "high"]);

function assertAuthorizedStudioSender(
  event: Electron.IpcMainInvokeEvent,
  studioWebContents: Electron.WebContents,
  studioOrigin: string
): void {
  if (event.sender !== studioWebContents) {
    throw new Error("IPC sender is not the authorized Studio UI WebContents");
  }
  const frameUrl = event.senderFrame?.url || "";
  if (!frameUrl.startsWith(studioOrigin)) {
    throw new Error(`Unauthorized IPC senderFrame origin: "${frameUrl}"`);
  }
}

function assertNonEmptyString(val: unknown, name: string): string {
  if (typeof val !== "string" || val.trim().length === 0) {
    throw new Error(`Invalid IPC string field "${name}"`);
  }
  return val;
}

function validatePreviewBounds(raw: unknown): PreviewBounds {
  if (!raw || typeof raw !== "object") throw new Error("Invalid preview bounds payload");
  const b = raw as Record<string, unknown>;
  const nums = [b.x, b.y, b.width, b.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("Preview bounds must be finite numbers");
  }
  return {
    x: b.x as number,
    y: b.y as number,
    width: b.width as number,
    height: b.height as number,
  };
}

function validateSeekPayload(raw: unknown): PreviewSeekPayload {
  if (!raw || typeof raw !== "object") throw new Error("Invalid seek payload");
  const p = raw as Record<string, unknown>;
  const sessionId = assertNonEmptyString(p.sessionId, "sessionId");
  if (typeof p.timeSec !== "number" || !Number.isFinite(p.timeSec) || p.timeSec < 0) {
    throw new Error("Invalid timeSec in seek payload");
  }
  return { sessionId, timeSec: p.timeSec };
}

function validateLoadPastedHtml(raw: unknown): LoadPastedHtmlPayload {
  if (!raw || typeof raw !== "object") throw new Error("Invalid pasted HTML payload");
  const p = raw as Record<string, unknown>;
  const html = assertNonEmptyString(p.html, "html");
  if (Buffer.byteLength(html, "utf8") > MAX_PASTE_HTML_BYTES) {
    throw new Error("Pasted HTML exceeds 2 MB safety cap");
  }
  const title = typeof p.title === "string" && p.title.trim() ? p.title.trim().slice(0, 80) : undefined;
  return { html, title };
}

function validateSessionRenderPayload(raw: unknown): SessionRenderRequestPayload {
  if (!raw || typeof raw !== "object") throw new Error("Invalid render payload");
  const p = raw as Record<string, unknown>;
  const sessionId = assertNonEmptyString(p.sessionId, "sessionId");
  const format = assertNonEmptyString(p.format, "format");
  const quality = assertNonEmptyString(p.quality, "quality");
  if (!ALLOWED_FORMATS.has(format)) throw new Error(`Unsupported render format: "${format}"`);
  if (!ALLOWED_QUALITIES.has(quality)) throw new Error(`Unsupported render quality: "${quality}"`);
  return {
    sessionId,
    format: format as SessionRenderRequestPayload["format"],
    quality: quality as SessionRenderRequestPayload["quality"],
    workers: typeof p.workers === "number" && Number.isInteger(p.workers) && p.workers >= 1 ? p.workers : undefined,
  };
}

export interface StudioIpcController {
  createPastedHtmlSession(
    html: string,
    title?: string
  ): Promise<Awaited<ReturnType<PreviewContainerManager["openVerifiedDirectory"]>>>;
  dispose(): Promise<void>;
}

/**
 * Registers typed Studio UI <-> Main Process IPC channels with strict senderFrame
 * validation and Main-owned session paths (never accepting arbitrary paths over IPC).
 */
export function registerStudioIpcHandlers(
  studioWindow: BrowserWindow,
  studioOrigin: string,
  previewManager: PreviewContainerManager,
  coordinator: RenderCoordinator
): StudioIpcController {
  const studioContents = studioWindow.webContents;
  const sessionTempBase = path.join(os.tmpdir(), "mf-motion-gen", "sessions");
  const renderOutputBase = path.join(os.tmpdir(), "mf-motion-gen", "renders");
  fs.mkdirSync(sessionTempBase, { recursive: true });
  fs.mkdirSync(renderOutputBase, { recursive: true });

  async function createPastedHtmlSession(
    html: string,
    title?: string
  ): ReturnType<PreviewContainerManager["openVerifiedDirectory"]> {
    const tempDir = path.join(sessionTempBase, crypto.randomUUID());
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "index.html"), html, "utf8");
    return previewManager.openVerifiedDirectory(tempDir, {
      entryFile: "index.html",
      title: title ?? "Pasted Composition",
      ownedTempDir: tempDir,
    });
  }

  ipcMain.handle(IPC_CHANNELS.openCompositionDialog, async (event) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const picked = await dialog.showOpenDialog(studioWindow, {
      title: "Select Composition HTML",
      properties: ["openFile"],
      filters: [{ name: "HTML Compositions", extensions: ["html", "htm"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true as const };
    }
    const chosenFile = picked.filePaths[0];
    const stageDir = path.dirname(chosenFile);
    const entryFile = path.basename(chosenFile);
    const res = await previewManager.openVerifiedDirectory(stageDir, {
      entryFile,
      title: entryFile,
    });
    return { canceled: false as const, ...res };
  });

  ipcMain.handle(IPC_CHANNELS.loadPastedHtml, async (event, payload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const valid = validateLoadPastedHtml(payload);
    return createPastedHtmlSession(valid.html, valid.title);
  });

  ipcMain.handle(IPC_CHANNELS.closeSession, async (event, payload: SessionIdPayload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    if (!payload || typeof payload.sessionId !== "string") {
      throw new Error("Invalid sessionId");
    }
    if (previewManager.getSession(payload.sessionId)) {
      await previewManager.disposeActiveSession();
    }
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.previewSetBounds, async (event, payload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    previewManager.setBounds(validatePreviewBounds(payload));
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.previewSeek, async (event, payload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const valid = validateSeekPayload(payload);
    return previewManager.seekPreview(valid.sessionId, valid.timeSec);
  });

  ipcMain.handle(IPC_CHANNELS.previewGetTimelineInfo, async (event, payload: SessionIdPayload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    assertNonEmptyString(payload?.sessionId, "sessionId");
    return previewManager.getTimelineState(payload.sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.startSessionRender, async (event, payload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const valid = validateSessionRenderPayload(payload);
    const session = previewManager.getSession(valid.sessionId);
    if (!session) {
      throw new Error(`Session "${valid.sessionId}" is not active`);
    }

    const jobId = `render_${session.sessionId.slice(0, 8)}_${Date.now()}`;
    const ext = valid.format === "mov" ? "mov" : valid.format === "webm" ? "webm" : "mp4";
    const outputPath = path.join(renderOutputBase, `${jobId}.${ext}`);

    const req: RenderJobRequest = {
      jobId,
      stageDir: session.stageDir,
      entryFile: session.entryFile,
      outputPath,
      format: valid.format,
      quality: valid.quality,
      fps: { num: Math.round(session.fps), den: 1 },
      workers: valid.workers,
      strictness: "strict",
    };

    const outcome = await coordinator.render(req, (progressEvent) => {
      if (!studioWindow.isDestroyed()) {
        studioContents.send(IPC_CHANNELS.eventRenderProgress, progressEvent);
      }
    });

    if (!studioWindow.isDestroyed()) {
      studioContents.send(IPC_CHANNELS.eventRenderComplete, outcome.execution.result);
    }
    return outcome.execution.result;
  });

  ipcMain.handle(IPC_CHANNELS.cancelSessionRender, async (event, payload: { jobId?: string }) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const jobId = assertNonEmptyString(payload?.jobId, "jobId");
    return { cancelled: coordinator.cancel(jobId, "studio_ui_cancelled") };
  });

  return {
    createPastedHtmlSession,
    async dispose() {
      for (const ch of Object.values(IPC_CHANNELS)) {
        try {
          ipcMain.removeHandler(ch);
        } catch {
          // Event channels have no handle
        }
      }
      await previewManager.disposeActiveSession();
    },
  };
}

export function formatPreflightBlockMessage(preflight: PreflightResult): string {
  return preflight.blockers.map((b) => `[${b.code}] ${b.message}`).join("\n");
}
