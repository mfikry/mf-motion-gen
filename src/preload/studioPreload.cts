const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = {
  getRuntimeInfo: "studio:getRuntimeInfo",
  openCompositionDialog: "studio:openCompositionDialog",
  openFolderDialog: "studio:openFolderDialog",
  openZipDialog: "studio:openZipDialog",
  confirmImportEntry: "studio:confirmImportEntry",
  cancelPendingImport: "studio:cancelPendingImport",
  refreshAssetTree: "studio:refreshAssetTree",
  loadPastedHtml: "studio:loadPastedHtml",
  closeSession: "studio:closeSession",
  previewSeek: "studio:previewSeek",
  previewSetBounds: "studio:previewSetBounds",
  previewSetViewport: "studio:previewSetViewport",
  previewGetTimelineInfo: "studio:previewGetTimelineInfo",
  chooseExportPath: "studio:chooseExportPath",
  startSessionRender: "studio:startSessionRender",
  cancelSessionRender: "studio:cancelSessionRender",
  openOutputLocation: "studio:openOutputLocation",
  eventSecurityViolation: "studio:eventSecurityViolation",
  eventRenderProgress: "studio:eventRenderProgress",
  eventRenderComplete: "studio:eventRenderComplete",
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
  openOutputLocation: (jobId: string) =>
    ipcRenderer.invoke(CHANNELS.openOutputLocation, { jobId }),
  onSecurityViolation: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventSecurityViolation, cb),
  onRenderProgress: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventRenderProgress, cb),
  onRenderComplete: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventRenderComplete, cb),
});
