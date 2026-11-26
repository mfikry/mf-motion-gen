interface StudioBridge {
  openCompositionDialog(): Promise<{ canceled: boolean; ok?: boolean; session?: any; preflight?: any }>;
  loadPastedHtml(html: string, title?: string): Promise<{ ok: boolean; session?: any; preflight?: any }>;
  closeSession(sessionId: string): Promise<{ ok: boolean }>;
  setPreviewBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean }>;
  seekPreview(sessionId: string, timeSec: number): Promise<{ durationSec: number; currentTimeSec: number; seekSupported: boolean; warning?: string }>;
  getTimelineInfo(sessionId: string): Promise<{ durationSec: number; currentTimeSec: number; seekSupported: boolean }>;
  startSessionRender(payload: { sessionId: string; format: "mp4" | "mov" | "webm"; quality: "draft" | "standard" | "high" }): Promise<any>;
  cancelSessionRender(jobId: string): Promise<{ cancelled: boolean }>;
  onSecurityViolation(cb: (ev: any) => void): () => void;
  onRenderProgress(cb: (ev: any) => void): () => void;
  onRenderComplete(cb: (ev: any) => void): () => void;
}

declare global {
  interface Window {
    mfStudio: StudioBridge;
  }
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const btnOpenHtml = el<HTMLButtonElement>("btnOpenHtml");
const btnLoadPaste = el<HTMLButtonElement>("btnLoadPaste");
const txtPasteHtml = el<HTMLTextAreaElement>("txtPasteHtml");
const btnRender = el<HTMLButtonElement>("btnRender");
const btnCancelRender = el<HTMLButtonElement>("btnCancelRender");
const selFormat = el<HTMLSelectElement>("selFormat");
const selQuality = el<HTMLSelectElement>("selQuality");
const rngTimeline = el<HTMLInputElement>("rngTimeline");
const lblTime = el("lblTime");
const lblSeekMode = el("lblSeekMode");
const lblStatus = el("lblStatus");
const lblOrigin = el("lblOrigin");
const lblSpec = el("lblSpec");
const preflightErrors = el("preflightErrors");
const lblRenderStatus = el("lblRenderStatus");
const securityLog = el("securityLog");
const viewportHost = el("viewportHost");

let activeSessionId: string | null = null;
let activeDurationSec = 0;
let activeJobId: string | null = null;

function syncViewportBounds(): void {
  const rect = viewportHost.getBoundingClientRect();
  void window.mfStudio.setPreviewBounds({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  });
}

function handleLoadResult(res: { ok?: boolean; session?: any; preflight?: any }): void {
  preflightErrors.innerHTML = "";
  if (!res.ok || !res.session) {
    activeSessionId = null;
    btnRender.disabled = true;
    rngTimeline.disabled = true;
    lblStatus.textContent = "Preflight Rejected";
    lblStatus.className = "badge-err";
    lblOrigin.textContent = "-";
    lblSpec.textContent = "-";
    const blockers = res.preflight?.blockers ?? [];
    for (const b of blockers) {
      const div = document.createElement("div");
      div.className = "badge-err mono";
      div.textContent = `[${b.code}] ${b.message}`;
      preflightErrors.appendChild(div);
    }
    return;
  }

  const s = res.session;
  activeSessionId = s.sessionId;
  activeDurationSec = s.durationSec;
  lblStatus.textContent = "Preview Active (Isolated)";
  lblStatus.className = "badge-ok";
  lblOrigin.textContent = s.origin;
  lblSpec.textContent = `${s.width}x${s.height} @ ${s.fps}fps (${s.durationSec}s)`;
  rngTimeline.max = String(s.durationSec);
  rngTimeline.value = "0";
  rngTimeline.disabled = false;
  btnRender.disabled = false;
  lblTime.textContent = `0.00s / ${s.durationSec.toFixed(2)}s`;
  syncViewportBounds();

  void window.mfStudio.getTimelineInfo(s.sessionId).then((info) => {
    lblSeekMode.textContent = info.seekSupported ? "Seek Ready" : "No Seek Hook";
  });
}

btnOpenHtml.addEventListener("click", async () => {
  const res = await window.mfStudio.openCompositionDialog();
  if (!res.canceled) handleLoadResult(res);
});

btnLoadPaste.addEventListener("click", async () => {
  const html = txtPasteHtml.value;
  if (!html.trim()) return;
  const res = await window.mfStudio.loadPastedHtml(html, "Pasted Composition");
  handleLoadResult(res);
});

rngTimeline.addEventListener("input", async () => {
  if (!activeSessionId) return;
  const t = Number(rngTimeline.value);
  const state = await window.mfStudio.seekPreview(activeSessionId, t);
  lblTime.textContent = `${state.currentTimeSec.toFixed(2)}s / ${activeDurationSec.toFixed(2)}s`;
  lblSeekMode.textContent = state.seekSupported ? "Seek Ready" : "No Seek Hook";
});

btnRender.addEventListener("click", async () => {
  if (!activeSessionId) return;
  btnRender.disabled = true;
  btnCancelRender.disabled = false;
  lblRenderStatus.textContent = "Starting export...";
  const res = await window.mfStudio.startSessionRender({
    sessionId: activeSessionId,
    format: selFormat.value as "mp4" | "mov",
    quality: selQuality.value as "draft" | "standard" | "high",
  });
  activeJobId = null;
  btnRender.disabled = false;
  btnCancelRender.disabled = true;
  lblRenderStatus.textContent = `${res.status}: ${res.outputPath}`;
});

btnCancelRender.addEventListener("click", async () => {
  if (!activeJobId) return;
  await window.mfStudio.cancelSessionRender(activeJobId);
});

window.mfStudio.onRenderProgress((ev: any) => {
  if (ev?.jobId) activeJobId = ev.jobId;
  lblRenderStatus.textContent = `${ev.stageCode ?? "render"}: ${ev.framesRendered ?? 0}/${ev.totalFrames ?? "?"} frames`;
});

window.mfStudio.onSecurityViolation((ev: any) => {
  const row = document.createElement("div");
  row.className = "badge-err mono";
  row.textContent = `[${ev.source}] ${ev.reason}: ${ev.url}`;
  securityLog.prepend(row);
});

new ResizeObserver(() => syncViewportBounds()).observe(viewportHost);
window.addEventListener("resize", syncViewportBounds);
export {};
