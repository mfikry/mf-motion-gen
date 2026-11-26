import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import {
  IPC_CHANNELS,
  type ApplyDiagnosticFixResult,
  type ChooseExportPathPayload,
  type ChooseExportPathResult,
  type CompositionAnalysisReport,
  type DiagnosticCodeDiffPreview,
  type ImportProjectPromptResult,
  type InspectElementResult,
  type LoadPastedHtmlPayload,
  type PreviewBounds,
  type PreviewSeekPayload,
  type PreviewViewportPayload,
  type RuntimeInfoSnapshot,
  type SessionIdPayload,
  type SessionRenderRequestPayload,
  type ViewportScaleMode,
} from "../../shared/previewContracts.js";
import {
  PINNED_RUNTIME,
  type ExportRenderLogResult,
  type PreflightResult,
  type RenderJobLogSummary,
  type RenderJobRequest,
  type RenderQueueSnapshot,
  type RuntimeTelemetrySnapshot,
} from "../../shared/renderContracts.js";
import { discoverHtmlCandidates, stageIsolatedFolderCopy } from "../import/projectImporter.js";
import { extractZipSecurely } from "../import/secureZipExtractor.js";
import { purgeSessionDirectoryAsync } from "../import/sessionFsUtils.js";
import {
  exportRenderLogWithSaveDialog,
  RenderLogStore,
  validateRenderJobId,
} from "../logging/renderLogStore.js";
import { PreviewContainerManager } from "../preview/previewContainerManager.js";
import { RenderCoordinator } from "../render/renderCoordinator.js";
import { RenderQueueManager } from "../render/renderQueueManager.js";
import { RuntimeTelemetryService } from "../telemetry/runtimeTelemetryService.js";

const MAX_PASTE_HTML_BYTES = 2 * 1024 * 1024;
const ALLOWED_FORMATS = new Set(["mp4", "mov"]);
const ALLOWED_QUALITIES = new Set(["draft", "standard", "high"]);
const ALLOWED_VIEWPORT_MODES = new Set<ViewportScaleMode>(["fit", "50", "100", "200"]);

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

function validateViewportPayload(raw: unknown): PreviewViewportPayload {
  if (!raw || typeof raw !== "object") throw new Error("Invalid viewport payload");
  const p = raw as Record<string, unknown>;
  const mode = assertNonEmptyString(p.mode, "mode") as ViewportScaleMode;
  if (!ALLOWED_VIEWPORT_MODES.has(mode)) {
    throw new Error(`Unsupported viewport scale mode: "${mode}"`);
  }
  const sessionId =
    p.sessionId === null || p.sessionId === undefined
      ? null
      : assertNonEmptyString(p.sessionId, "sessionId");
  return {
    sessionId,
    mode,
    panelRect: validatePreviewBounds(p.panelRect),
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

function validateChooseExportPath(raw: unknown): ChooseExportPathPayload {
  if (!raw || typeof raw !== "object") throw new Error("Invalid export dialog payload");
  const p = raw as Record<string, unknown>;
  const sessionId = assertNonEmptyString(p.sessionId, "sessionId");
  const format = assertNonEmptyString(p.format, "format");
  if (!ALLOWED_FORMATS.has(format)) {
    throw new Error(`Unsupported render format: "${format}"`);
  }
  return {
    sessionId,
    format: format as ChooseExportPathPayload["format"],
  };
}

function validateSessionRenderPayload(raw: unknown): SessionRenderRequestPayload {
  if (!raw || typeof raw !== "object") throw new Error("Invalid render payload");
  const p = raw as Record<string, unknown>;
  const sessionId = assertNonEmptyString(p.sessionId, "sessionId");
  const format = assertNonEmptyString(p.format, "format");
  const quality = assertNonEmptyString(p.quality, "quality");
  if (!ALLOWED_FORMATS.has(format)) throw new Error(`Unsupported render format: "${format}"`);
  if (!ALLOWED_QUALITIES.has(quality)) throw new Error(`Unsupported render quality: "${quality}"`);

  let crf: number | undefined;
  if (p.crf !== undefined && p.crf !== null) {
    if (format !== "mp4") {
      throw new Error("CRF is only supported for H.264 MP4 exports");
    }
    if (typeof p.crf !== "number" || !Number.isInteger(p.crf) || p.crf < 0 || p.crf > 51) {
      throw new Error("CRF must be an integer between 0 and 51");
    }
    crf = p.crf;
  }

  const exportTicketId =
    p.exportTicketId !== undefined && p.exportTicketId !== null
      ? assertNonEmptyString(p.exportTicketId, "exportTicketId")
      : undefined;

  let fps: SessionRenderRequestPayload["fps"];
  if (p.fps !== undefined && p.fps !== null) {
    if (typeof p.fps !== "object") {
      throw new Error("Invalid Export FPS payload");
    }
    const f = p.fps as Record<string, unknown>;
    if (
      typeof f.num !== "number" ||
      typeof f.den !== "number" ||
      !Number.isInteger(f.num) ||
      !Number.isInteger(f.den) ||
      f.num <= 0 ||
      f.den <= 0 ||
      f.num > 240000 ||
      f.den > 10000
    ) {
      throw new Error("Export FPS fraction must contain positive integers");
    }
    fps = { num: f.num, den: f.den };
  }

  return {
    sessionId,
    format: format as SessionRenderRequestPayload["format"],
    quality: quality as SessionRenderRequestPayload["quality"],
    fps,
    crf,
    exportTicketId,
    workers:
      typeof p.workers === "number" && Number.isInteger(p.workers) && p.workers >= 1
        ? p.workers
        : undefined,
  };
}

export interface StudioIpcController {
  createPastedHtmlSession(
    html: string,
    title?: string
  ): Promise<Awaited<ReturnType<PreviewContainerManager["openVerifiedDirectory"]>>>;
  importProjectFromFolder(folderDir: string): Promise<ImportProjectPromptResult>;
  importProjectFromZip(zipFilePath: string): Promise<ImportProjectPromptResult>;
  confirmPendingImport(pendingImportId: string, entryFile: string): Promise<ImportProjectPromptResult>;
  getCompletedOutputPath(jobId: string): string | null;
  dispose(): Promise<void>;
}

interface PendingImportEntry {
  workingDir: string;
  importKind: "folder" | "zip";
  title: string;
  candidates: string[];
  manifestDigestSha256: string;
  fileCount: number;
  hashesByRelPath: Record<string, string>;
}

interface ExportTicket {
  sessionId: string;
  format: "mp4" | "mov";
  outputPath: string;
}

/**
 * Registers typed Studio UI <-> Main Process IPC channels with strict senderFrame
 * validation and Main-owned session & output paths (never accepting arbitrary paths over IPC).
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

  const exportTickets = new Map<string, ExportTicket>();
  const completedOutputs = new Map<string, string>();
  const pendingImports = new Map<string, PendingImportEntry>();
  let renderJobSeq = 0;

  const logStore = new RenderLogStore({
    onLogUpdated: (jobId, entry) => {
      if (!studioWindow.isDestroyed() && !studioContents.isDestroyed()) {
        studioContents.send(IPC_CHANNELS.eventRenderLogUpdated, { jobId, entry });
      }
    },
  });

  const renderQueue = new RenderQueueManager({
    runner: coordinator,
    logStore,
    isSessionValid: (sid, boundStageDir) => {
      const s = previewManager.getSession(sid);
      if (!s) return false;
      try {
        return fs.realpathSync(s.stageDir) === boundStageDir;
      } catch {
        return false;
      }
    },
    onQueueChanged: (snapshot) => {
      if (!studioWindow.isDestroyed() && !studioContents.isDestroyed()) {
        studioContents.send(IPC_CHANNELS.eventQueueUpdated, snapshot);
      }
    },
    onJobCompleted: (_item, result) => {
      if (result.status === "complete") {
        completedOutputs.set(result.jobId, result.outputPath);
      }
      if (!studioWindow.isDestroyed() && !studioContents.isDestroyed()) {
        studioContents.send(IPC_CHANNELS.eventRenderComplete, result);
      }
    },
  });

  const telemetryService = new RuntimeTelemetryService({
    getAppMetrics: () => app.getAppMetrics(),
    getQueueAndRenderState: () => {
      const snap = renderQueue.getSnapshot();
      const activeItem = snap.items.find((i) => i.status === "rendering");
      return {
        queue: {
          activeCount: snap.activeCount,
          queuedCount: snap.queuedCount,
          activeJobId: activeItem?.jobId ?? null,
        },
        activeRender: renderQueue.getActiveRenderTelemetry(),
      };
    },
  });
  telemetryService.attachWindow(studioWindow, IPC_CHANNELS.eventRuntimeTelemetry);
  telemetryService.start();

  previewManager.setBeforeSessionPurgeHandler((sessionId) =>
    renderQueue.invalidateSession(sessionId, "session_closed_or_replaced")
  );

  async function finalizePendingImport(
    pending: PendingImportEntry,
    selectedEntry: string
  ): Promise<ImportProjectPromptResult> {
    if (!pending.candidates.includes(selectedEntry)) {
      await purgeSessionDirectoryAsync(pending.workingDir).catch(() => {});
      throw new Error(`Invalid HTML entry candidate selected: "${selectedEntry}"`);
    }

    const res = await previewManager.openVerifiedDirectory(pending.workingDir, {
      entryFile: selectedEntry,
      title: `${pending.title} (${selectedEntry})`,
      sourceMode: "working_copy",
      importKind: pending.importKind,
      sourceDigestSha256: pending.manifestDigestSha256,
      sourceFileCount: pending.fileCount,
      hashesByRelPath: pending.hashesByRelPath,
      ownedTempDir: pending.workingDir,
    });

    if (res.ok) {
      return { canceled: false, ok: true, session: res.session };
    }
    return {
      canceled: false,
      ok: false,
      preflight: res.preflight,
      assetTree: res.assetTree,
      analysis: res.analysis,
    };
  }

  async function importProjectFromFolder(folderDir: string): Promise<ImportProjectPromptResult> {
    const workingDir = path.join(sessionTempBase, crypto.randomUUID());
    const staged = stageIsolatedFolderCopy(folderDir, workingDir);
    const pending: PendingImportEntry = {
      workingDir: staged.workingDir,
      importKind: "folder",
      title: path.basename(folderDir),
      candidates: staged.htmlCandidates,
      manifestDigestSha256: staged.manifestDigestSha256,
      fileCount: staged.fileCount,
      hashesByRelPath: staged.sourceSha256ByRelPath,
    };

    if (staged.htmlCandidates.length === 1) {
      return finalizePendingImport(pending, staged.htmlCandidates[0]);
    }

    const pendingImportId = crypto.randomUUID();
    pendingImports.set(pendingImportId, pending);
    return {
      canceled: false,
      needsEntrySelection: true,
      pendingImportId,
      candidates: staged.htmlCandidates,
      suggestedEntry: staged.htmlCandidates[0],
    };
  }

  async function importProjectFromZip(zipFilePath: string): Promise<ImportProjectPromptResult> {
    const workingDir = path.join(sessionTempBase, crypto.randomUUID());
    const extracted = await extractZipSecurely(zipFilePath, workingDir);
    const candidates = discoverHtmlCandidates(extracted.targetDir);
    if (candidates.length === 0) {
      await purgeSessionDirectoryAsync(extracted.targetDir).catch(() => {});
      throw new Error("No .html or .htm entry composition found inside ZIP archive");
    }

    const pending: PendingImportEntry = {
      workingDir: extracted.targetDir,
      importKind: "zip",
      title: path.basename(zipFilePath),
      candidates,
      manifestDigestSha256: extracted.manifestDigestSha256,
      fileCount: extracted.fileCount,
      hashesByRelPath: extracted.fileSha256ByRelPath,
    };

    if (candidates.length === 1) {
      return finalizePendingImport(pending, candidates[0]);
    }

    const pendingImportId = crypto.randomUUID();
    pendingImports.set(pendingImportId, pending);
    return {
      canceled: false,
      needsEntrySelection: true,
      pendingImportId,
      candidates,
      suggestedEntry: candidates[0],
    };
  }

  async function confirmPendingImport(
    pendingImportId: string,
    entryFile: string
  ): Promise<ImportProjectPromptResult> {
    const pending = pendingImports.get(pendingImportId);
    if (!pending) {
      throw new Error(`Pending import "${pendingImportId}" not found or expired`);
    }
    pendingImports.delete(pendingImportId);
    return finalizePendingImport(pending, entryFile);
  }

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
      sourceMode: "working_copy",
      importKind: "paste",
      ownedTempDir: tempDir,
    });
  }

  ipcMain.handle(IPC_CHANNELS.getRuntimeInfo, async (event): Promise<RuntimeInfoSnapshot> => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    return {
      pinnedRuntime: PINNED_RUNTIME,
      electronVersion: process.versions.electron ?? null,
      nodeVersion: process.version,
      supportedFormats: ["mp4", "mov"],
      crfSupportedFormats: ["mp4"],
      proresValidatedProfile: "4444",
    };
  });

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
      sourceMode: "original_file",
      importKind: "html",
    });
    return { canceled: false as const, ...res };
  });

  ipcMain.handle(IPC_CHANNELS.openFolderDialog, async (event): Promise<ImportProjectPromptResult> => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const picked = await dialog.showOpenDialog(studioWindow, {
      title: "Select Composition Project Folder",
      properties: ["openDirectory"],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true };
    }
    try {
      return await importProjectFromFolder(picked.filePaths[0]);
    } catch (err: unknown) {
      return {
        canceled: false,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.openZipDialog, async (event): Promise<ImportProjectPromptResult> => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const picked = await dialog.showOpenDialog(studioWindow, {
      title: "Import Project ZIP Archive",
      properties: ["openFile"],
      filters: [{ name: "ZIP Project Archives (*.zip)", extensions: ["zip"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true };
    }
    try {
      return await importProjectFromZip(picked.filePaths[0]);
    } catch (err: unknown) {
      return {
        canceled: false,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.confirmImportEntry, async (event, payload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid confirmImportEntry payload");
    }
    const p = payload as Record<string, unknown>;
    const pendingImportId = assertNonEmptyString(p.pendingImportId, "pendingImportId");
    const entryFile = assertNonEmptyString(p.entryFile, "entryFile");
    return confirmPendingImport(pendingImportId, entryFile);
  });

  ipcMain.handle(IPC_CHANNELS.cancelPendingImport, async (event, payload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    if (!payload || typeof payload !== "object") return { ok: true };
    const p = payload as Record<string, unknown>;
    if (typeof p.pendingImportId === "string") {
      const pending = pendingImports.get(p.pendingImportId);
      if (pending) {
        pendingImports.delete(p.pendingImportId);
        await purgeSessionDirectoryAsync(pending.workingDir).catch(() => {});
      }
    }
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.refreshAssetTree, async (event, payload: SessionIdPayload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const sessionId = assertNonEmptyString(payload?.sessionId, "sessionId");
    return previewManager.refreshSessionAssets(sessionId);
  });

  ipcMain.handle(
    IPC_CHANNELS.runStaticAnalysis,
    async (event, payload: SessionIdPayload): Promise<CompositionAnalysisReport> => {
      assertAuthorizedStudioSender(event, studioContents, studioOrigin);
      const sessionId = assertNonEmptyString(payload?.sessionId, "sessionId");
      return previewManager.runStaticAnalysis(sessionId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.inspectElement,
    async (
      event,
      payload: { sessionId?: string; selector?: string }
    ): Promise<InspectElementResult> => {
      assertAuthorizedStudioSender(event, studioContents, studioOrigin);
      const sessionId = assertNonEmptyString(payload?.sessionId, "sessionId");
      const selector = assertNonEmptyString(payload?.selector, "selector");
      return previewManager.inspectElement(sessionId, selector);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.clearInspectOverlay,
    async (event, payload: SessionIdPayload): Promise<{ ok: boolean }> => {
      assertAuthorizedStudioSender(event, studioContents, studioOrigin);
      const sessionId = assertNonEmptyString(payload?.sessionId, "sessionId");
      return previewManager.clearInspectOverlay(sessionId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.previewDiagnosticDiff,
    async (
      event,
      payload: { sessionId?: string; diagnosticId?: string }
    ): Promise<DiagnosticCodeDiffPreview> => {
      assertAuthorizedStudioSender(event, studioContents, studioOrigin);
      const sessionId = assertNonEmptyString(payload?.sessionId, "sessionId");
      const diagnosticId = assertNonEmptyString(payload?.diagnosticId, "diagnosticId");
      return previewManager.previewDiagnosticDiff(sessionId, diagnosticId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.confirmApplyDiagnosticFix,
    async (
      event,
      payload: { sessionId?: string; proposalId?: string }
    ): Promise<ApplyDiagnosticFixResult> => {
      assertAuthorizedStudioSender(event, studioContents, studioOrigin);
      const sessionId = assertNonEmptyString(payload?.sessionId, "sessionId");
      const proposalId = assertNonEmptyString(payload?.proposalId, "proposalId");
      return previewManager.confirmApplyDiagnosticFix(sessionId, proposalId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.cancelDiagnosticDiff,
    async (event, payload: SessionIdPayload): Promise<{ ok: boolean }> => {
      assertAuthorizedStudioSender(event, studioContents, studioOrigin);
      if (payload?.sessionId) {
        await previewManager.clearInspectOverlay(payload.sessionId);
      }
      return { ok: true };
    }
  );

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

  ipcMain.handle(IPC_CHANNELS.previewSetViewport, async (event, payload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const valid = validateViewportPayload(payload);
    return previewManager.setViewport(valid.panelRect, valid.mode);
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

  ipcMain.handle(
    IPC_CHANNELS.chooseExportPath,
    async (event, payload): Promise<ChooseExportPathResult> => {
      assertAuthorizedStudioSender(event, studioContents, studioOrigin);
      const valid = validateChooseExportPath(payload);
      const session = previewManager.getSession(valid.sessionId);
      if (!session) {
        throw new Error(`Session "${valid.sessionId}" is not active`);
      }

      const ext = valid.format === "mov" ? "mov" : "mp4";
      const baseTitle = path.parse(session.title).name.replace(/[^a-zA-Z0-9_-]/g, "_") || "render";
      const defaultPath = path.join(renderOutputBase, `${baseTitle}.${ext}`);

      const picked = await dialog.showSaveDialog(studioWindow, {
        title: valid.format === "mov" ? "Export ProRes 4444 MOV" : "Export H.264 MP4",
        defaultPath,
        filters: [
          valid.format === "mov"
            ? { name: "QuickTime ProRes 4444 (*.mov)", extensions: ["mov"] }
            : { name: "MPEG-4 H.264 (*.mp4)", extensions: ["mp4"] },
        ],
      });

      if (picked.canceled || !picked.filePath) {
        return { canceled: true };
      }

      const exportTicketId = crypto.randomUUID();
      exportTickets.set(exportTicketId, {
        sessionId: valid.sessionId,
        format: valid.format,
        outputPath: picked.filePath,
      });

      return {
        canceled: false,
        exportTicketId,
        displayFileName: path.basename(picked.filePath),
      };
    }
  );

  function enqueueValidatedSessionRender(payload: unknown) {
    const valid = validateSessionRenderPayload(payload);
    const session = previewManager.getSession(valid.sessionId);
    if (!session) {
      throw new Error(`Session "${valid.sessionId}" is not active`);
    }

    const resolvedFps = valid.fps ?? session.fps;
    if (!resolvedFps) {
      throw new Error("Export FPS is required when composition source FPS is Unknown");
    }

    renderJobSeq += 1;
    const jobId = `render_${session.sessionId.slice(0, 8)}_${Date.now()}_${renderJobSeq}`;
    const ext = valid.format === "mov" ? "mov" : "mp4";
    let outputPath = path.join(renderOutputBase, `${jobId}.${ext}`);

    if (valid.exportTicketId) {
      const ticket = exportTickets.get(valid.exportTicketId);
      if (!ticket || ticket.sessionId !== valid.sessionId || ticket.format !== valid.format) {
        throw new Error("Invalid or expired export destination ticket");
      }
      exportTickets.delete(valid.exportTicketId);
      outputPath = ticket.outputPath;
    }

    const req: RenderJobRequest = {
      jobId,
      stageDir: session.stageDir,
      entryFile: session.entryFile,
      outputPath,
      format: valid.format,
      quality: valid.quality,
      crf: valid.format === "mp4" ? valid.crf : undefined,
      proresProfile: valid.format === "mov" ? "4444" : undefined,
      fps: resolvedFps,
      workers: valid.workers,
      strictness: "strict",
    };

    return renderQueue.enqueue({
      sessionId: session.sessionId,
      title: session.title,
      request: req,
      onProgress: (progressEvent) => {
        if (!studioWindow.isDestroyed() && !studioContents.isDestroyed()) {
          studioContents.send(IPC_CHANNELS.eventRenderProgress, progressEvent);
        }
      },
    });
  }

  ipcMain.handle(IPC_CHANNELS.startSessionRender, async (event, payload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const { completion } = enqueueValidatedSessionRender(payload);
    return completion;
  });

  ipcMain.handle(IPC_CHANNELS.enqueueRenderJob, async (event, payload) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const { item } = enqueueValidatedSessionRender(payload);
    return item;
  });

  ipcMain.handle(
    IPC_CHANNELS.getRenderQueueSnapshot,
    async (event): Promise<RenderQueueSnapshot> => {
      assertAuthorizedStudioSender(event, studioContents, studioOrigin);
      return renderQueue.getSnapshot();
    }
  );

  ipcMain.handle(IPC_CHANNELS.cancelQueueItem, async (event, payload: { jobId?: string }) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const jobId = validateRenderJobId(payload?.jobId);
    return renderQueue.cancel(jobId, "studio_ui_cancelled");
  });

  ipcMain.handle(IPC_CHANNELS.clearFinishedQueueItems, async (event) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    return { cleared: renderQueue.clearFinished() };
  });

  ipcMain.handle(
    IPC_CHANNELS.getRenderJobLog,
    async (event, payload: { jobId?: string }): Promise<RenderJobLogSummary> => {
      assertAuthorizedStudioSender(event, studioContents, studioOrigin);
      const jobId = validateRenderJobId(payload?.jobId);
      const summary = logStore.getJobLog(jobId);
      if (!summary) {
        throw new Error(`No render log available for job "${jobId}"`);
      }
      return summary;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.exportRenderJobLog,
    async (event, payload: { jobId?: string }): Promise<ExportRenderLogResult> => {
      assertAuthorizedStudioSender(event, studioContents, studioOrigin);
      return exportRenderLogWithSaveDialog({
        logStore,
        rawJobId: payload?.jobId,
        defaultDir: renderOutputBase,
        showSaveDialog: (opts) => dialog.showSaveDialog(studioWindow, opts),
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.getRuntimeTelemetry,
    async (event): Promise<RuntimeTelemetrySnapshot> => {
      assertAuthorizedStudioSender(event, studioContents, studioOrigin);
      return telemetryService.getLatestOrSample();
    }
  );

  ipcMain.handle(IPC_CHANNELS.cancelSessionRender, async (event, payload: { jobId?: string }) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const jobId = validateRenderJobId(payload?.jobId);
    return { cancelled: renderQueue.cancel(jobId, "studio_ui_cancelled").cancelled };
  });

  ipcMain.handle(IPC_CHANNELS.openOutputLocation, async (event, payload: { jobId?: string }) => {
    assertAuthorizedStudioSender(event, studioContents, studioOrigin);
    const jobId = validateRenderJobId(payload?.jobId);
    const outputPath = completedOutputs.get(jobId);
    if (!outputPath || !fs.existsSync(outputPath)) {
      return { opened: false, reason: "Output file unavailable for this jobId" };
    }
    shell.showItemInFolder(outputPath);
    return { opened: true };
  });

  return {
    createPastedHtmlSession,
    importProjectFromFolder,
    importProjectFromZip,
    confirmPendingImport,
    getCompletedOutputPath(jobId: string) {
      return completedOutputs.get(jobId) ?? null;
    },
    async dispose() {
      telemetryService.dispose();
      exportTickets.clear();
      completedOutputs.clear();
      for (const pending of pendingImports.values()) {
        await purgeSessionDirectoryAsync(pending.workingDir).catch(() => {});
      }
      pendingImports.clear();
      for (const ch of Object.values(IPC_CHANNELS)) {
        try {
          ipcMain.removeHandler(ch);
        } catch {
          // Event channels have no handle
        }
      }
      await previewManager.disposeActiveSession();
      await renderQueue.shutdown();
    },
  };
}

export function formatPreflightBlockMessage(preflight: PreflightResult): string {
  return preflight.blockers.map((b) => `[${b.code}] ${b.message}`).join("\n");
}
