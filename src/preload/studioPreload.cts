const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = {
  getRuntimeInfo: "studio:getRuntimeInfo",
  openCompositionDialog: "studio:openCompositionDialog",
  openFolderDialog: "studio:openFolderDialog",
  openZipDialog: "studio:openZipDialog",
  confirmImportEntry: "studio:confirmImportEntry",
  cancelPendingImport: "studio:cancelPendingImport",
  refreshAssetTree: "studio:refreshAssetTree",
  runStaticAnalysis: "studio:runStaticAnalysis",
  inspectElement: "studio:inspectElement",
  clearInspectOverlay: "studio:clearInspectOverlay",
  previewDiagnosticDiff: "studio:previewDiagnosticDiff",
  confirmApplyDiagnosticFix: "studio:confirmApplyDiagnosticFix",
  cancelDiagnosticDiff: "studio:cancelDiagnosticDiff",
  loadPastedHtml: "studio:loadPastedHtml",
  closeSession: "studio:closeSession",
  previewSeek: "studio:previewSeek",
  previewSetBounds: "studio:previewSetBounds",
  previewSetViewport: "studio:previewSetViewport",
  previewGetTimelineInfo: "studio:previewGetTimelineInfo",
  chooseExportPath: "studio:chooseExportPath",
  startSessionRender: "studio:startSessionRender",
  cancelSessionRender: "studio:cancelSessionRender",
  getRenderQueueSnapshot: "studio:getRenderQueueSnapshot",
  enqueueRenderJob: "studio:enqueueRenderJob",
  cancelQueueItem: "studio:cancelQueueItem",
  clearFinishedQueueItems: "studio:clearFinishedQueueItems",
  getRenderJobLog: "studio:getRenderJobLog",
  exportRenderJobLog: "studio:exportRenderJobLog",
  getRuntimeTelemetry: "studio:getRuntimeTelemetry",
  openOutputLocation: "studio:openOutputLocation",
  eventSecurityViolation: "studio:eventSecurityViolation",
  eventRenderProgress: "studio:eventRenderProgress",
  eventRenderComplete: "studio:eventRenderComplete",
  eventQueueUpdated: "studio:eventQueueUpdated",
  eventRuntimeTelemetry: "studio:eventRuntimeTelemetry",
  eventRenderLogUpdated: "studio:eventRenderLogUpdated",
};

function subscribe(channel: string, listener: (payload: unknown) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("mfStudio", {
  getRuntimeInfo: () => ipcRenderer.invoke(CHANNELS.getRuntimeInfo),
  openCompositionDialog: () => ipcRenderer.invoke(CHANNELS.openCompositionDialog),
  openFolderDialog: () => ipcRenderer.invoke(CHANNELS.openFolderDialog),
  openZipDialog: () => ipcRenderer.invoke(CHANNELS.openZipDialog),
  confirmImportEntry: (pendingImportId: string, entryFile: string) =>
    ipcRenderer.invoke(CHANNELS.confirmImportEntry, { pendingImportId, entryFile }),
  cancelPendingImport: (pendingImportId: string) =>
    ipcRenderer.invoke(CHANNELS.cancelPendingImport, { pendingImportId }),
  refreshAssetTree: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.refreshAssetTree, { sessionId }),
  runStaticAnalysis: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.runStaticAnalysis, { sessionId }),
  inspectDiagnosticElement: (sessionId: string, selector: string) =>
    ipcRenderer.invoke(CHANNELS.inspectElement, { sessionId, selector }),
  clearInspectOverlay: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.clearInspectOverlay, { sessionId }),
  previewDiagnosticDiff: (sessionId: string, diagnosticId: string) =>
    ipcRenderer.invoke(CHANNELS.previewDiagnosticDiff, { sessionId, diagnosticId }),
  confirmApplyDiagnosticFix: (sessionId: string, proposalId: string) =>
    ipcRenderer.invoke(CHANNELS.confirmApplyDiagnosticFix, { sessionId, proposalId }),
  cancelDiagnosticDiff: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.cancelDiagnosticDiff, { sessionId }),
  loadPastedHtml: (html: string, title?: string) =>
    ipcRenderer.invoke(CHANNELS.loadPastedHtml, { html, title }),
  closeSession: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.closeSession, { sessionId }),
  setPreviewBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke(CHANNELS.previewSetBounds, bounds),
  setPreviewViewport: (payload: {
    sessionId: string | null;
    mode: "fit" | "50" | "100" | "200";
    panelRect: { x: number; y: number; width: number; height: number };
  }) => ipcRenderer.invoke(CHANNELS.previewSetViewport, payload),
  seekPreview: (sessionId: string, timeSec: number) =>
    ipcRenderer.invoke(CHANNELS.previewSeek, { sessionId, timeSec }),
  getTimelineInfo: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.previewGetTimelineInfo, { sessionId }),
  chooseExportPath: (payload: { sessionId: string; format: "mp4" | "mov" }) =>
    ipcRenderer.invoke(CHANNELS.chooseExportPath, payload),
  startSessionRender: (payload: {
    sessionId: string;
    format: "mp4" | "mov";
    quality: "draft" | "standard" | "high";
    fps?: { num: number; den: number };
    crf?: number;
    exportTicketId?: string;
    workers?: number;
  }) => ipcRenderer.invoke(CHANNELS.startSessionRender, payload),
  cancelSessionRender: (jobId: string) =>
    ipcRenderer.invoke(CHANNELS.cancelSessionRender, { jobId }),
  getRenderQueueSnapshot: () =>
    ipcRenderer.invoke(CHANNELS.getRenderQueueSnapshot),
  enqueueRenderJob: (payload: {
    sessionId: string;
    format: "mp4" | "mov";
    quality: "draft" | "standard" | "high";
    fps?: { num: number; den: number };
    crf?: number;
    exportTicketId?: string;
    workers?: number;
  }) => ipcRenderer.invoke(CHANNELS.enqueueRenderJob, payload),
  cancelQueueItem: (jobId: string) =>
    ipcRenderer.invoke(CHANNELS.cancelQueueItem, { jobId }),
  clearFinishedQueueItems: () =>
    ipcRenderer.invoke(CHANNELS.clearFinishedQueueItems),
  getRenderJobLog: (jobId: string) =>
    ipcRenderer.invoke(CHANNELS.getRenderJobLog, { jobId }),
  exportRenderJobLog: (jobId: string) =>
    ipcRenderer.invoke(CHANNELS.exportRenderJobLog, { jobId }),
  getRuntimeTelemetry: () =>
    ipcRenderer.invoke(CHANNELS.getRuntimeTelemetry),
  openOutputLocation: (jobId: string) =>
    ipcRenderer.invoke(CHANNELS.openOutputLocation, { jobId }),
  onSecurityViolation: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventSecurityViolation, cb),
  onRenderProgress: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventRenderProgress, cb),
  onRenderComplete: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventRenderComplete, cb),
  onQueueUpdated: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventQueueUpdated, cb),
  onRuntimeTelemetry: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventRuntimeTelemetry, cb),
  onRenderLogUpdated: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventRenderLogUpdated, cb),
});
