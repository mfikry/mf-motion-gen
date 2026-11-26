const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = {
  openCompositionDialog: "studio:openCompositionDialog",
  loadPastedHtml: "studio:loadPastedHtml",
  closeSession: "studio:closeSession",
  previewSeek: "studio:previewSeek",
  previewSetBounds: "studio:previewSetBounds",
  previewGetTimelineInfo: "studio:previewGetTimelineInfo",
  startSessionRender: "studio:startSessionRender",
  cancelSessionRender: "studio:cancelSessionRender",
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
  openCompositionDialog: () => ipcRenderer.invoke(CHANNELS.openCompositionDialog),
  loadPastedHtml: (html: string, title?: string) =>
    ipcRenderer.invoke(CHANNELS.loadPastedHtml, { html, title }),
  closeSession: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.closeSession, { sessionId }),
  setPreviewBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke(CHANNELS.previewSetBounds, bounds),
  seekPreview: (sessionId: string, timeSec: number) =>
    ipcRenderer.invoke(CHANNELS.previewSeek, { sessionId, timeSec }),
  getTimelineInfo: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.previewGetTimelineInfo, { sessionId }),
  startSessionRender: (payload: {
    sessionId: string;
    format: "mp4" | "mov" | "webm";
    quality: "draft" | "standard" | "high";
    workers?: number;
  }) => ipcRenderer.invoke(CHANNELS.startSessionRender, payload),
  cancelSessionRender: (jobId: string) =>
    ipcRenderer.invoke(CHANNELS.cancelSessionRender, { jobId }),
  onSecurityViolation: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventSecurityViolation, cb),
  onRenderProgress: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventRenderProgress, cb),
  onRenderComplete: (cb: (ev: unknown) => void) =>
    subscribe(CHANNELS.eventRenderComplete, cb),
});
