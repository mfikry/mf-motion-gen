import {
  clampFrameIndex,
  computeTotalFrames,
  formatFpsLabel,
  formatTimecode,
  frameToTimeSec,
  parseFpsValue,
  snapFrameToMarkers,
} from "../shared/frameMath.js";
import {
  formatTelemetryMetric,
  type ExportRenderLogResult,
  type FpsFraction,
  type RenderJobLogSummary,
  type RenderJobResult,
  type RenderLogEntry,
  type RenderProgressEvent,
  type RenderQueueItemSnapshot,
  type RenderQueueSnapshot,
  type RuntimeTelemetrySnapshot,
} from "../shared/renderContracts.js";
import type {
  ApplyDiagnosticFixResult,
  AssetTreeNode,
  ChooseExportPathResult,
  CompositionAnalysisReport,
  CompositionDiagnostic,
  DiagnosticCategory,
  DiagnosticCodeDiffPreview,
  ImportProjectPromptResult,
  InspectElementResult,
  PreviewSessionInfo,
  PreviewViewportState,
  RuntimeInfoSnapshot,
  ViewportScaleMode,
} from "../shared/previewContracts.js";

interface StudioBridge {
  getRuntimeInfo(): Promise<RuntimeInfoSnapshot>;
  openCompositionDialog(): Promise<{ canceled: boolean; ok?: boolean; session?: PreviewSessionInfo; preflight?: any; assetTree?: AssetTreeNode[]; analysis?: CompositionAnalysisReport }>;
  openFolderDialog(): Promise<ImportProjectPromptResult>;
  openZipDialog(): Promise<ImportProjectPromptResult>;
  confirmImportEntry(pendingImportId: string, entryFile: string): Promise<ImportProjectPromptResult>;
  cancelPendingImport(pendingImportId: string): Promise<{ ok: boolean }>;
  refreshAssetTree(sessionId: string): Promise<{ preflight: any; assetTree: AssetTreeNode[]; localAssets: string[]; analysis: CompositionAnalysisReport }>;
  runStaticAnalysis(sessionId: string): Promise<CompositionAnalysisReport>;
  inspectDiagnosticElement(sessionId: string, selector: string): Promise<InspectElementResult>;
  clearInspectOverlay(sessionId: string): Promise<{ ok: boolean }>;
  previewDiagnosticDiff(sessionId: string, diagnosticId: string): Promise<DiagnosticCodeDiffPreview>;
  confirmApplyDiagnosticFix(sessionId: string, proposalId: string): Promise<ApplyDiagnosticFixResult>;
  cancelDiagnosticDiff(sessionId: string): Promise<{ ok: boolean }>;
  loadPastedHtml(html: string, title?: string): Promise<{ ok: boolean; session?: PreviewSessionInfo; preflight?: any; analysis?: CompositionAnalysisReport }>;
  closeSession(sessionId: string): Promise<{ ok: boolean }>;
  setPreviewViewport(payload: {
    sessionId: string | null;
    mode: ViewportScaleMode;
    panelRect: { x: number; y: number; width: number; height: number };
  }): Promise<PreviewViewportState>;
  seekPreview(sessionId: string, timeSec: number): Promise<{
    durationSec: number | null;
    currentTimeSec: number;
    seekSupported: boolean;
    markersSec: number[];
    warning?: string;
  }>;
  getTimelineInfo(sessionId: string): Promise<{
    durationSec: number | null;
    currentTimeSec: number;
    seekSupported: boolean;
    markersSec: number[];
  }>;
  chooseExportPath(payload: { sessionId: string; format: "mp4" | "mov" }): Promise<ChooseExportPathResult>;
  startSessionRender(payload: {
    sessionId: string;
    format: "mp4" | "mov";
    quality: "draft" | "standard" | "high";
    fps?: FpsFraction;
    crf?: number;
    exportTicketId?: string;
  }): Promise<RenderJobResult>;
  cancelSessionRender(jobId: string): Promise<{ cancelled: boolean }>;
  getRenderQueueSnapshot(): Promise<RenderQueueSnapshot>;
  enqueueRenderJob(payload: {
    sessionId: string;
    format: "mp4" | "mov";
    quality: "draft" | "standard" | "high";
    fps?: FpsFraction;
    crf?: number;
    exportTicketId?: string;
    workers?: number;
  }): Promise<RenderQueueItemSnapshot>;
  cancelQueueItem(jobId: string): Promise<{ cancelled: boolean; wasActive: boolean }>;
  clearFinishedQueueItems(): Promise<{ cleared: number }>;
  getRenderJobLog(jobId: string): Promise<RenderJobLogSummary>;
  exportRenderJobLog(jobId: string): Promise<ExportRenderLogResult>;
  getRuntimeTelemetry(): Promise<RuntimeTelemetrySnapshot>;
  openOutputLocation(jobId: string): Promise<{ opened: boolean; reason?: string }>;
  onSecurityViolation(cb: (ev: any) => void): () => void;
  onRenderProgress(cb: (ev: RenderProgressEvent) => void): () => void;
  onRenderComplete(cb: (ev: RenderJobResult) => void): () => void;
  onQueueUpdated(cb: (snapshot: RenderQueueSnapshot) => void): () => void;
  onRuntimeTelemetry(cb: (snapshot: RuntimeTelemetrySnapshot) => void): () => void;
  onRenderLogUpdated(cb: (payload: { jobId: string; entry: RenderLogEntry }) => void): () => void;
}

declare global {
  interface Window {
    mfStudio: StudioBridge;
  }
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// TopBar
const chipCompositionState = el("chipCompositionState");
const chipSourceMode = el("chipSourceMode");
const btnOpenHtml = el<HTMLButtonElement>("btnOpenHtml");
const btnImportFolder = el<HTMLButtonElement>("btnImportFolder");
const btnImportZip = el<HTMLButtonElement>("btnImportZip");
const btnTogglePaste = el<HTMLButtonElement>("btnTogglePaste");
const btnCloseSession = el<HTMLButtonElement>("btnCloseSession");

// LeftPanel
const pasteDrawer = el("pasteDrawer");
const txtPasteHtml = el<HTMLTextAreaElement>("txtPasteHtml");
const btnLoadPaste = el<HTMLButtonElement>("btnLoadPaste");
const entryPickerDrawer = el("entryPickerDrawer");
const selEntryCandidate = el<HTMLSelectElement>("selEntryCandidate");
const btnConfirmEntryPick = el<HTMLButtonElement>("btnConfirmEntryPick");
const btnCancelEntryPick = el<HTMLButtonElement>("btnCancelEntryPick");
const inspName = el("inspName");
const inspSourceMode = el("inspSourceMode");
const inspDigest = el("inspDigest");
const inspOrigin = el("inspOrigin");
const inspDims = el("inspDims");
const inspFps = el("inspFps");
const inspDuration = el("inspDuration");
const inspFrames = el("inspFrames");
const inspAssetCount = el("inspAssetCount");
const btnRefreshAssets = el<HTMLButtonElement>("btnRefreshAssets");
const inspPreflightStatus = el("inspPreflightStatus");
const listAssets = el("listAssets");
const listPreflightIssues = el("listPreflightIssues");
const inspDiagTotal = el("inspDiagTotal");
const btnRunAnalysis = el<HTMLButtonElement>("btnRunAnalysis");
const diagFilterButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-diag-cat]"));
const cntCatALL = el("cntCatALL");
const cntCatPERSISTENT = el("cntCatPERSISTENT");
const cntCatTRANSIENT = el("cntCatTRANSIENT");
const cntCatTIMELINE_CONTROLLED = el("cntCatTIMELINE_CONTROLLED");
const cntCatMEDIA = el("cntCatMEDIA");
const cntCatWARNING_AMBIGUOUS = el("cntCatWARNING_AMBIGUOUS");
const listDiagnostics = el("listDiagnostics");
const diagDetailBox = el("diagDetailBox");
const diagDetailTarget = el("diagDetailTarget");
const diagDetailLoc = el("diagDetailLoc");
const diagDetailConf = el("diagDetailConf");
const diagDetailReason = el("diagDetailReason");
const diagDetailEvidence = el("diagDetailEvidence");
const diagDetailNoFixNote = el("diagDetailNoFixNote");
const diagInspectTelemetry = el("diagInspectTelemetry");
const btnInspectDiagTarget = el<HTMLButtonElement>("btnInspectDiagTarget");
const btnPreviewDiagDiff = el<HTMLButtonElement>("btnPreviewDiagDiff");
const codeDiffDrawer = el("codeDiffDrawer");
const lblDiffTargetFile = el("lblDiffTargetFile");
const lblDiffTitle = el("lblDiffTitle");
const lblDiffHashNote = el("lblDiffHashNote");
const diffLinesView = el("diffLinesView");
const lblDiffApplyStatus = el("lblDiffApplyStatus");
const btnCancelDiff = el<HTMLButtonElement>("btnCancelDiff");
const btnConfirmApplyDiff = el<HTMLButtonElement>("btnConfirmApplyDiff");

// CenterPanel
const scaleButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-scale]"));
const lblViewportScale = el("lblViewportScale");
const lblSeekContract = el("lblSeekContract");
const viewportStage = el("viewportStage");
const viewportEmptyNote = el("viewportEmptyNote");
const btnFirstFrame = el<HTMLButtonElement>("btnFirstFrame");
const btnPrevFrame = el<HTMLButtonElement>("btnPrevFrame");
const btnPlayPause = el<HTMLButtonElement>("btnPlayPause");
const btnNextFrame = el<HTMLButtonElement>("btnNextFrame");
const btnLastFrame = el<HTMLButtonElement>("btnLastFrame");
const btnLoopToggle = el<HTMLButtonElement>("btnLoopToggle");
const btnSnapToggle = el<HTMLButtonElement>("btnSnapToggle");
const lblTimecode = el("lblTimecode");
const lblFrameCounter = el("lblFrameCounter");
const lblTimeSec = el("lblTimeSec");
const rngFrameScrubber = el<HTMLInputElement>("rngFrameScrubber");

// RightPanel
const selFormat = el<HTMLSelectElement>("selFormat");
const selQuality = el<HTMLSelectElement>("selQuality");
const selExportFps = el<HTMLSelectElement>("selExportFps");
const crfGroup = el("crfGroup");
const inpCrf = el<HTMLInputElement>("inpCrf");
const proresInfoBox = el("proresInfoBox");
const btnChooseOutput = el<HTMLButtonElement>("btnChooseOutput");
const lblExportDest = el("lblExportDest");
const lblExportValidation = el("lblExportValidation");
const btnRender = el<HTMLButtonElement>("btnRender");
const btnAddToQueue = el<HTMLButtonElement>("btnAddToQueue");
const btnCancelRender = el<HTMLButtonElement>("btnCancelRender");
const lblRenderStage = el("lblRenderStage");
const lblRenderFrames = el("lblRenderFrames");
const lblRenderElapsed = el("lblRenderElapsed");
const lblRenderThroughput = el("lblRenderThroughput");
const progressFill = el("progressFill");
const lblRenderOutcome = el("lblRenderOutcome");
const btnOpenOutput = el<HTMLButtonElement>("btnOpenOutput");
const lblQueueSummaryBadge = el("lblQueueSummaryBadge");
const btnClearCompleted = el<HTMLButtonElement>("btnClearCompleted");
const lblQueueCountsLine = el("lblQueueCountsLine");
const listRenderQueue = el("listRenderQueue");
const lblLogSelectedJob = el("lblLogSelectedJob");
const btnExportJobLog = el<HTMLButtonElement>("btnExportJobLog");
const lblLogMetaLine = el("lblLogMetaLine");
const lblLogTruncationWarn = el("lblLogTruncationWarn");
const listRenderLogs = el("listRenderLogs");
const lblLogExportStatus = el("lblLogExportStatus");
const lblViolationCountBadge = el("lblViolationCountBadge");
const securityLog = el("securityLog");

// StatusBar
const lblRuntimeVersions = el("lblRuntimeVersions");
const lblStatusTelemetry = el("lblStatusTelemetry");

interface WorkbenchState {
  session: PreviewSessionInfo | null;
  viewportMode: ViewportScaleMode;
  currentFrame: number;
  effectiveFps: FpsFraction;
  totalFrames: number;
  seekSupported: boolean;
  playing: boolean;
  loopEnabled: boolean;
  snapEnabled: boolean;
  exportTicketId: string | undefined;
  activeJobId: string | null;
  completedJobId: string | null;
  renderStartedAtMs: number | null;
  renderSubmitInFlight: boolean;
  violationCount: number;
  analysis: CompositionAnalysisReport | null;
  activeDiagFilter: "ALL" | DiagnosticCategory;
  selectedDiagId: string | null;
  pendingDiff: DiagnosticCodeDiffPreview | null;
  queueSnapshot: RenderQueueSnapshot | null;
  lastQueueVersion: number;
  telemetry: RuntimeTelemetrySnapshot | null;
  lastTelemetrySampledAtMs: number;
  selectedLogJobId: string | null;
  selectedJobLog: RenderJobLogSummary | null;
  activeProgressByJobId: Record<string, { stage: string; framesRendered: number | null; totalFrames: number | null; progress: number }>;
  isDisposed: boolean;
}

const state: WorkbenchState = {
  session: null,
  viewportMode: "fit",
  currentFrame: 0,
  effectiveFps: { num: 30, den: 1 },
  totalFrames: 0,
  seekSupported: false,
  playing: false,
  loopEnabled: true,
  snapEnabled: false,
  exportTicketId: undefined,
  activeJobId: null,
  completedJobId: null,
  renderStartedAtMs: null,
  renderSubmitInFlight: false,
  violationCount: 0,
  analysis: null,
  activeDiagFilter: "ALL",
  selectedDiagId: null,
  pendingDiff: null,
  queueSnapshot: null,
  lastQueueVersion: -1,
  telemetry: null,
  lastTelemetrySampledAtMs: -1,
  selectedLogJobId: null,
  selectedJobLog: null,
  activeProgressByJobId: {},
  isDisposed: false,
};

let rafHandle: number | null = null;
let fallbackTimerHandle: number | null = null;
let lastFrameTimestampMs = 0;
let playAccumulatorSec = 0;
let seekInFlight = false;
let pendingSeekFrame: number | null = null;

function formatUnknown(val: string | number | null | undefined, suffix = ""): { text: string; isUnknown: boolean } {
  if (val === null || val === undefined || val === "") {
    return { text: "Unknown", isUnknown: true };
  }
  return { text: `${val}${suffix}`, isUnknown: false };
}

function setFieldValue(target: HTMLElement, text: string, isUnknown = false): void {
  target.textContent = text;
  target.className = isUnknown ? "kv-val unknown" : "kv-val";
}

function syncViewportToMain(): void {
  const rect = viewportStage.getBoundingClientRect();
  void window.mfStudio
    .setPreviewViewport({
      sessionId: state.session?.sessionId ?? null,
      mode: state.viewportMode,
      panelRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    })
    .then((vp) => {
      lblViewportScale.textContent = state.session
        ? `${state.viewportMode === "fit" ? "Fit" : state.viewportMode + "%"} (${Math.round(vp.scaleFactor * 100)}%)`
        : "-";
    })
    .catch(() => {
      // Window closing/initializing
    });
}

function stopPlayback(): void {
  state.playing = false;
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  if (fallbackTimerHandle !== null) {
    window.clearTimeout(fallbackTimerHandle);
    fallbackTimerHandle = null;
  }
  btnPlayPause.textContent = "Play";
}

function renderTimeReadout(): void {
  const maxFrameIdx = Math.max(0, state.totalFrames - 1);
  const clamped = clampFrameIndex(state.currentFrame, Math.max(1, state.totalFrames));
  const timeSec = frameToTimeSec(clamped, state.effectiveFps, Math.max(1, state.totalFrames));
  rngFrameScrubber.max = String(maxFrameIdx);
  rngFrameScrubber.value = String(clamped);
  lblTimecode.textContent = formatTimecode(clamped, state.effectiveFps);
  lblFrameCounter.textContent =
    state.totalFrames > 0 ? `Frame ${clamped} / ${maxFrameIdx} (${state.totalFrames}f)` : "Frame 0 / 0";
  lblTimeSec.textContent = `${timeSec.toFixed(3)}s`;
}

async function flushSeekFrame(frameIndex: number): Promise<void> {
  if (!state.session) return;
  const maxTotal = Math.max(1, state.totalFrames);
  const clamped = clampFrameIndex(frameIndex, maxTotal);
  state.currentFrame = clamped;
  renderTimeReadout();

  if (seekInFlight) {
    pendingSeekFrame = clamped;
    return;
  }

  seekInFlight = true;
  try {
    let nextTarget: number | null = clamped;
    while (nextTarget !== null && state.session) {
      pendingSeekFrame = null;
      const tSec = frameToTimeSec(nextTarget, state.effectiveFps, maxTotal);
      const res = await window.mfStudio.seekPreview(state.session.sessionId, tSec);
      state.seekSupported = res.seekSupported;
      lblSeekContract.textContent = res.seekSupported ? "Seek Ready" : "No Seek Contract";
      lblSeekContract.className = res.seekSupported ? "text-ok" : "text-warn";
      nextTarget = pendingSeekFrame;
    }
  } finally {
    seekInFlight = false;
  }
}

function stepToFrame(rawFrame: number, allowSnap = false): void {
  if (!state.session || state.totalFrames <= 0) return;
  let target = clampFrameIndex(rawFrame, state.totalFrames);
  if (allowSnap && state.snapEnabled && state.session.markersSec.length > 0) {
    const snapped = snapFrameToMarkers(target, state.session.markersSec, state.effectiveFps, state.totalFrames);
    target = snapped.frame;
  }
  void flushSeekFrame(target);
}

function scheduleNextPlaybackTick(): void {
  if (!state.playing) return;
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  if (fallbackTimerHandle !== null) {
    window.clearTimeout(fallbackTimerHandle);
    fallbackTimerHandle = null;
  }

  const runTick = () => {
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (fallbackTimerHandle !== null) {
      window.clearTimeout(fallbackTimerHandle);
      fallbackTimerHandle = null;
    }
    tickPlayback(performance.now());
  };

  rafHandle = requestAnimationFrame(runTick);
  // Backup timer guarantees progress if compositor throttles rAF while minimized/headless
  fallbackTimerHandle = window.setTimeout(runTick, 32);
}

function tickPlayback(nowMs: number): void {
  if (!state.playing || !state.session || state.totalFrames <= 0) return;

  const dtSec = Math.max(0, (nowMs - lastFrameTimestampMs) / 1000);
  lastFrameTimestampMs = nowMs;
  const frameDurSec = state.effectiveFps.den / state.effectiveFps.num;
  playAccumulatorSec += dtSec;

  if (playAccumulatorSec >= frameDurSec) {
    const stepCount = Math.floor(playAccumulatorSec / frameDurSec);
    playAccumulatorSec -= stepCount * frameDurSec;
    const nextRaw = state.currentFrame + stepCount;
    if (nextRaw >= state.totalFrames) {
      if (state.loopEnabled) {
        stepToFrame(nextRaw % state.totalFrames);
      } else {
        stepToFrame(state.totalFrames - 1);
        stopPlayback();
        return;
      }
    } else {
      stepToFrame(nextRaw);
    }
  }

  scheduleNextPlaybackTick();
}

function togglePlayback(): void {
  if (!state.session || state.totalFrames <= 1) return;
  if (state.playing) {
    stopPlayback();
    return;
  }
  if (state.currentFrame >= state.totalFrames - 1) {
    stepToFrame(0);
  }
  state.playing = true;
  lastFrameTimestampMs = performance.now();
  playAccumulatorSec = 0;
  btnPlayPause.textContent = "Pause";
  scheduleNextPlaybackTick();
}

const STANDARD_EXPORT_FPS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "30/1", label: "30 FPS" },
  { value: "30000/1001", label: "29.97 FPS (30000/1001)" },
  { value: "60/1", label: "60 FPS" },
  { value: "60000/1001", label: "59.94 FPS (60000/1001)" },
];

function populateExportFpsSelector(sourceFps: FpsFraction | null): void {
  selExportFps.innerHTML = "";
  if (!state.session) {
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "-- Select Export FPS --";
    selExportFps.appendChild(emptyOpt);
    selExportFps.disabled = true;
    return;
  }

  const headOpt = document.createElement("option");
  if (sourceFps !== null) {
    headOpt.value = "source";
    headOpt.textContent = `Source FPS (${formatFpsLabel(sourceFps)})`;
  } else {
    headOpt.value = "";
    headOpt.textContent = "-- Select Export FPS (Required) --";
  }
  headOpt.selected = true;
  selExportFps.appendChild(headOpt);

  for (const preset of STANDARD_EXPORT_FPS_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = preset.value;
    opt.textContent = preset.label;
    selExportFps.appendChild(opt);
  }
  selExportFps.disabled = false;
}

function resolveSelectedExportFps(): FpsFraction | null {
  if (!state.session) return null;
  if (selExportFps.value === "source") {
    return state.session.fps;
  }
  if (!selExportFps.value) {
    return null;
  }
  return parseFpsValue(selExportFps.value);
}

function syncExportReadyState(): void {
  if (!state.session) {
    btnRender.disabled = true;
    btnAddToQueue.disabled = true;
    return;
  }
  const resolved = resolveSelectedExportFps();
  const activeOrPending = Boolean(
    state.renderSubmitInFlight ||
      (state.queueSnapshot && (state.queueSnapshot.activeCount > 0 || state.queueSnapshot.queuedCount > 0))
  );
  if (!resolved) {
    btnRender.disabled = true;
    btnAddToQueue.disabled = true;
    lblExportValidation.textContent = "Select Export FPS before rendering (source FPS is Unknown).";
  } else {
    btnRender.disabled = activeOrPending;
    btnAddToQueue.disabled = false;
    if (lblExportValidation.textContent.includes("Select Export FPS")) {
      lblExportValidation.textContent = "";
    }
  }
}

function updateExportInspectorVisibility(): void {
  const format = selFormat.value as "mp4" | "mov";
  if (format === "mp4") {
    crfGroup.classList.remove("hidden");
    inpCrf.disabled = false;
    proresInfoBox.classList.add("hidden");
  } else {
    crfGroup.classList.add("hidden");
    inpCrf.disabled = true;
    proresInfoBox.classList.remove("hidden");
  }
  // Changing format invalidates any prior Save dialog ticket for another extension
  state.exportTicketId = undefined;
  lblExportDest.textContent = "Default temp folder";
  lblExportValidation.textContent = "";
  syncExportReadyState();
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function renderAssetTreeNodes(container: HTMLElement, nodes: AssetTreeNode[], depth = 0): void {
  for (const node of nodes) {
    const wrap = document.createElement("div");
    wrap.className = "tree-node";

    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = `${4 + depth * 12}px`;
    row.title = node.diagnosticMessage ? `${node.relativePath}\n${node.diagnosticMessage}` : node.relativePath;

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = node.kind === "directory" ? `▸ ${node.name}/` : node.name;

    const meta = document.createElement("span");
    meta.className = "tree-meta";

    if (node.kind === "file") {
      if (node.sizeBytes !== undefined) {
        const sizeSpan = document.createElement("span");
        sizeSpan.style.color = "var(--text-dim)";
        sizeSpan.textContent = `${node.extension ? node.extension.slice(1).toUpperCase() + " " : ""}${formatBytes(node.sizeBytes)}`;
        meta.appendChild(sizeSpan);
      }
      if (node.validationStatus) {
        const pill = document.createElement("span");
        pill.className = `pill pill-${node.validationStatus}`;
        pill.textContent = node.validationStatus;
        meta.appendChild(pill);
      }
    }

    row.appendChild(label);
    row.appendChild(meta);
    wrap.appendChild(row);

    if (node.diagnosticMessage && (node.validationStatus === "missing" || node.validationStatus === "blocked" || node.validationStatus === "unsupported")) {
      const diag = document.createElement("div");
      diag.className = node.validationStatus === "unsupported" ? "text-warn" : "text-err";
      diag.style.paddingLeft = `${10 + depth * 12}px`;
      diag.style.fontSize = "10px";
      diag.textContent = node.diagnosticMessage;
      wrap.appendChild(diag);
    }

    if (node.kind === "directory" && node.children && node.children.length > 0) {
      renderAssetTreeNodes(wrap, node.children, depth + 1);
    }
    container.appendChild(wrap);
  }
}

const CATEGORY_LABELS: Record<DiagnosticCategory, string> = {
  PERSISTENT: "PERSISTENT",
  TRANSIENT: "TRANSIENT",
  TIMELINE_CONTROLLED: "TIMELINE-CONTROLLED",
  MEDIA: "MEDIA",
  WARNING_AMBIGUOUS: "WARNING / AMBIGUOUS",
};

function closeCodeDiffDrawer(): void {
  state.pendingDiff = null;
  codeDiffDrawer.classList.add("hidden");
  diffLinesView.innerHTML = "";
  lblDiffApplyStatus.textContent = "";
}

function renderSelectedDiagnosticDetail(diag: CompositionDiagnostic | null): void {
  if (!diag) {
    diagDetailBox.classList.add("hidden");
    diagInspectTelemetry.textContent = "";
    return;
  }
  diagDetailBox.classList.remove("hidden");
  diagDetailTarget.textContent = diag.elementIdentifier;
  diagDetailLoc.textContent = diag.sourceLocation
    ? `${diag.sourceLocation.file}:${diag.sourceLocation.line}`
    : "Unknown";
  diagDetailConf.textContent = `${diag.confidence.toUpperCase()} · ${diag.severity.toUpperCase()}`;
  diagDetailConf.className = `kv-val conf-${diag.confidence}`;
  diagDetailReason.textContent = diag.reason;

  diagDetailEvidence.innerHTML = "";
  for (const ev of diag.evidence) {
    const row = document.createElement("div");
    row.textContent = `• ${ev}`;
    diagDetailEvidence.appendChild(row);
  }

  if (diag.canAutoFix && diag.fixCandidateAvailable) {
    diagDetailNoFixNote.textContent = "High-confidence deterministic diff ready (Working Copy only).";
    diagDetailNoFixNote.className = "text-ok";
  } else {
    diagDetailNoFixNote.textContent = diag.noAutoFixReason ?? "NO-AUTO-FIX: Manual review only.";
    diagDetailNoFixNote.className = diag.severity === "info" ? "" : "text-warn";
  }

  diagInspectTelemetry.textContent = "";
  const canInspectInLivePreview = Boolean(state.session && diag.inspectSelector);
  btnInspectDiagTarget.disabled = !canInspectInLivePreview;
  btnInspectDiagTarget.title = canInspectInLivePreview
    ? `Highlight ${diag.inspectSelector} inside isolated preview`
    : "Inspect requires active preview session & element selector";

  const canDiff = Boolean(
    state.session &&
      state.session.sourceMode === "working_copy" &&
      diag.canAutoFix &&
      diag.fixCandidateAvailable
  );
  btnPreviewDiagDiff.disabled = !canDiff;
}

function renderAnalysisReport(report: CompositionAnalysisReport | null): void {
  state.analysis = report;
  closeCodeDiffDrawer();

  if (!report) {
    state.selectedDiagId = null;
    inspDiagTotal.textContent = "0";
    cntCatALL.textContent = "0";
    cntCatPERSISTENT.textContent = "0";
    cntCatTRANSIENT.textContent = "0";
    cntCatTIMELINE_CONTROLLED.textContent = "0";
    cntCatMEDIA.textContent = "0";
    cntCatWARNING_AMBIGUOUS.textContent = "0";
    listDiagnostics.innerHTML = "";
    listDiagnostics.textContent = "No analysis run";
    renderSelectedDiagnosticDetail(null);
    return;
  }

  const c = report.summary.countsByCategory;
  inspDiagTotal.textContent = String(report.summary.total);
  cntCatALL.textContent = String(report.summary.total);
  cntCatPERSISTENT.textContent = String(c.PERSISTENT ?? 0);
  cntCatTRANSIENT.textContent = String(c.TRANSIENT ?? 0);
  cntCatTIMELINE_CONTROLLED.textContent = String(c.TIMELINE_CONTROLLED ?? 0);
  cntCatMEDIA.textContent = String(c.MEDIA ?? 0);
  cntCatWARNING_AMBIGUOUS.textContent = String(c.WARNING_AMBIGUOUS ?? 0);

  const visible =
    state.activeDiagFilter === "ALL"
      ? report.diagnostics
      : report.diagnostics.filter((d) => d.category === state.activeDiagFilter);

  if (visible.length > 0 && (!state.selectedDiagId || !visible.some((d) => d.id === state.selectedDiagId))) {
    state.selectedDiagId = visible[0].id;
  } else if (visible.length === 0) {
    state.selectedDiagId = null;
  }

  listDiagnostics.innerHTML = "";
  if (visible.length === 0) {
    listDiagnostics.textContent = `0 items in ${state.activeDiagFilter}`;
    renderSelectedDiagnosticDetail(null);
    return;
  }

  for (const d of visible) {
    const item = document.createElement("div");
    item.className = `diag-item${d.id === state.selectedDiagId ? " selected" : ""}`;
    item.dataset.diagId = d.id;

    const head = document.createElement("div");
    head.className = "diag-head";

    const catPill = document.createElement("span");
    catPill.className = `pill pill-${d.category}`;
    catPill.textContent = CATEGORY_LABELS[d.category];

    const badges = document.createElement("span");
    badges.style.display = "flex";
    badges.style.gap = "4px";
    badges.style.alignItems = "center";

    const confPill = document.createElement("span");
    confPill.className = `conf-badge conf-${d.confidence}`;
    confPill.textContent = d.confidence;
    badges.appendChild(confPill);

    const fixBadge = document.createElement("span");
    fixBadge.className = "conf-badge";
    fixBadge.textContent = d.canAutoFix ? "DIFF READY" : "NO-AUTO-FIX";
    fixBadge.style.color = d.canAutoFix ? "var(--accent)" : "var(--text-dim)";
    badges.appendChild(fixBadge);

    head.appendChild(catPill);
    head.appendChild(badges);

    const title = document.createElement("div");
    title.className = "mono";
    title.style.fontSize = "11px";
    title.textContent = `${d.elementIdentifier}${d.sourceLocation ? ` (${d.sourceLocation.file}:${d.sourceLocation.line})` : ""}`;

    item.appendChild(head);
    item.appendChild(title);

    item.addEventListener("click", () => {
      state.selectedDiagId = d.id;
      for (const elItem of Array.from(listDiagnostics.children)) {
        elItem.classList.toggle("selected", (elItem as HTMLElement).dataset.diagId === d.id);
      }
      renderSelectedDiagnosticDetail(d);
    });

    listDiagnostics.appendChild(item);
  }

  const selected = visible.find((d) => d.id === state.selectedDiagId) ?? null;
  renderSelectedDiagnosticDetail(selected);
}

let pendingImportIdState: string | null = null;

function handleImportPromptResponse(res: ImportProjectPromptResult): void {
  if (res.canceled) return;

  if (res.needsEntrySelection && res.pendingImportId && res.candidates) {
    pendingImportIdState = res.pendingImportId;
    selEntryCandidate.innerHTML = "";
    for (const c of res.candidates) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      if (c === res.suggestedEntry) opt.selected = true;
      selEntryCandidate.appendChild(opt);
    }
    entryPickerDrawer.classList.remove("hidden");
    return;
  }

  entryPickerDrawer.classList.add("hidden");
  pendingImportIdState = null;

  if (res.error) {
    applySessionToUi(null, {
      blockers: [{ code: "IMPORT_FAILED", message: res.error }],
    });
    return;
  }

  applySessionToUi(
    res.ok ? res.session ?? null : null,
    res.ok ? null : res.preflight,
    res.ok ? undefined : res.assetTree,
    res.ok ? undefined : res.analysis
  );
}

function applySessionToUi(
  session: PreviewSessionInfo | null,
  preflightOverride?: any,
  failedAssetTree?: AssetTreeNode[],
  failedAnalysis?: CompositionAnalysisReport
): void {
  stopPlayback();
  state.session = session;
  state.exportTicketId = undefined;
  lblExportDest.textContent = "Default temp folder";
  lblExportValidation.textContent = "";

  if (!session) {
    viewportEmptyNote.classList.remove("hidden");
    chipCompositionState.textContent = preflightOverride ? "Preflight Rejected" : "No Composition";
    chipCompositionState.className = preflightOverride ? "chip err" : "chip";
    chipSourceMode.textContent = "Source: -";
    btnCloseSession.disabled = true;

    setFieldValue(inspName, "-");
    setFieldValue(inspSourceMode, "-");
    setFieldValue(inspDigest, "-");
    setFieldValue(inspOrigin, "-");
    setFieldValue(inspDims, "-");
    setFieldValue(inspFps, "-");
    setFieldValue(inspDuration, "-");
    setFieldValue(inspFrames, "-");
    inspAssetCount.textContent = "0";
    btnRefreshAssets.disabled = true;
    btnRunAnalysis.disabled = true;
    listAssets.innerHTML = "";
    if (failedAssetTree && failedAssetTree.length > 0) {
      renderAssetTreeNodes(listAssets, failedAssetTree);
    } else {
      listAssets.textContent = "No project loaded";
    }
    renderAnalysisReport(failedAnalysis ?? null);

    if (preflightOverride) {
      inspPreflightStatus.textContent = "Blocked";
      inspPreflightStatus.className = "kv-val text-err";
      listPreflightIssues.innerHTML = "";
      for (const b of preflightOverride.blockers ?? []) {
        const row = document.createElement("div");
        row.className = "text-err";
        row.textContent = `[${b.code}] ${b.message}`;
        listPreflightIssues.appendChild(row);
      }
    } else {
      inspPreflightStatus.textContent = "-";
      inspPreflightStatus.className = "kv-val";
      listPreflightIssues.textContent = "No preflight blockers";
    }

    state.currentFrame = 0;
    state.totalFrames = 0;
    state.seekSupported = false;
    renderTimeReadout();
    for (const b of [
      btnFirstFrame,
      btnPrevFrame,
      btnPlayPause,
      btnNextFrame,
      btnLastFrame,
      btnLoopToggle,
      btnSnapToggle,
      btnChooseOutput,
      btnRender,
      btnAddToQueue,
    ]) {
      b.disabled = true;
    }
    rngFrameScrubber.disabled = true;
    populateExportFpsSelector(null);
    lblSeekContract.textContent = "No Composition";
    lblSeekContract.className = "";
    syncViewportToMain();
    return;
  }

  viewportEmptyNote.classList.add("hidden");
  chipCompositionState.textContent = "Preview Isolated";
  chipCompositionState.className = "chip ok";
  const sourceLabel =
    session.sourceMode === "original_file"
      ? "Original File"
      : session.workingCopyModified
        ? "Working Copy (Modified)"
        : "Working Copy";
  chipSourceMode.textContent = `Source: ${sourceLabel}`;
  btnCloseSession.disabled = false;

  setFieldValue(inspName, session.title);
  setFieldValue(inspSourceMode, sourceLabel);
  if (session.sourceDigestSha256) {
    const modNote = session.workingCopyModified ? " [Orig Preserved]" : "";
    setFieldValue(
      inspDigest,
      `${session.sourceDigestSha256.slice(0, 12)}... (${session.sourceFileCount ?? 0}f)${modNote}`
    );
  } else {
    setFieldValue(inspDigest, session.sourceMode === "original_file" ? "Direct File" : "Session Copy");
  }
  btnRunAnalysis.disabled = false;
  renderAnalysisReport(session.analysis ?? null);
  setFieldValue(inspOrigin, session.origin);

  if (session.width !== null && session.height !== null) {
    setFieldValue(inspDims, `${session.width} x ${session.height}`);
  } else {
    setFieldValue(inspDims, "Unknown", true);
  }

  if (session.fps !== null) {
    setFieldValue(inspFps, formatFpsLabel(session.fps));
  } else {
    setFieldValue(inspFps, "Unknown", true);
  }

  const durInfo = formatUnknown(session.durationSec !== null ? session.durationSec.toFixed(3) : null, "s");
  setFieldValue(inspDuration, durInfo.text, durInfo.isUnknown);

  const frameInfo = formatUnknown(session.totalFrames);
  setFieldValue(inspFrames, frameInfo.text, frameInfo.isUnknown);

  inspAssetCount.textContent = String(session.localAssets.length);
  btnRefreshAssets.disabled = false;
  listAssets.innerHTML = "";
  if (session.assetTree && session.assetTree.length > 0) {
    renderAssetTreeNodes(listAssets, session.assetTree);
  } else if (session.localAssets.length === 0) {
    listAssets.textContent = "No external/local asset dependencies";
  } else {
    for (const rel of session.localAssets) {
      const item = document.createElement("div");
      item.textContent = rel;
      listAssets.appendChild(item);
    }
  }

  inspPreflightStatus.textContent = session.preflight.warnings.length > 0 ? "Verified (Warnings)" : "Verified Offline";
  inspPreflightStatus.className = session.preflight.warnings.length > 0 ? "kv-val text-warn" : "kv-val text-ok";
  listPreflightIssues.innerHTML = "";
  if (session.preflight.warnings.length === 0) {
    listPreflightIssues.textContent = "0 blockers · 0 warnings";
  } else {
    for (const w of session.preflight.warnings) {
      const row = document.createElement("div");
      row.className = "text-warn";
      row.textContent = `[${w.code}] ${w.message}`;
      listPreflightIssues.appendChild(row);
    }
  }

  // Timeline setup: only compute frame bounds when BOTH duration and source FPS are known (no silent 30fps guess)
  state.effectiveFps = session.fps ?? { num: 30, den: 1 };
  const computedTotal =
    session.totalFrames ?? computeTotalFrames(session.durationSec, session.fps) ?? 0;
  state.totalFrames = computedTotal;
  state.currentFrame = 0;

  const hasInteractiveTimeline = state.totalFrames > 0;
  for (const b of [
    btnFirstFrame,
    btnPrevFrame,
    btnPlayPause,
    btnNextFrame,
    btnLastFrame,
    btnLoopToggle,
  ]) {
    b.disabled = !hasInteractiveTimeline;
  }
  rngFrameScrubber.disabled = !hasInteractiveTimeline;

  // Snap stays disabled unless real markers/keyframes are exposed
  if (session.markersSec.length > 0) {
    btnSnapToggle.disabled = false;
    btnSnapToggle.textContent = state.snapEnabled ? `Snap: On (${session.markersSec.length})` : `Snap: Off (${session.markersSec.length})`;
  } else {
    state.snapEnabled = false;
    btnSnapToggle.disabled = true;
    btnSnapToggle.classList.remove("active");
    btnSnapToggle.textContent = "Snap: No Markers";
  }

  btnChooseOutput.disabled = false;
  populateExportFpsSelector(session.fps);
  syncExportReadyState();
  renderTimeReadout();
  syncViewportToMain();

  void window.mfStudio.getTimelineInfo(session.sessionId).then((tl) => {
    state.seekSupported = tl.seekSupported;
    lblSeekContract.textContent = tl.seekSupported ? "Seek Ready" : "No Seek Contract";
    lblSeekContract.className = tl.seekSupported ? "text-ok" : "text-warn";
  });
}

// Event Wiring
btnTogglePaste.addEventListener("click", () => {
  pasteDrawer.classList.toggle("hidden");
});

btnOpenHtml.addEventListener("click", async () => {
  const res = await window.mfStudio.openCompositionDialog();
  if (!res.canceled) {
    applySessionToUi(
      res.ok ? res.session ?? null : null,
      res.ok ? null : res.preflight,
      res.ok ? undefined : res.assetTree,
      res.ok ? undefined : res.analysis
    );
  }
});

btnImportFolder.addEventListener("click", async () => {
  const res = await window.mfStudio.openFolderDialog();
  handleImportPromptResponse(res);
});

btnImportZip.addEventListener("click", async () => {
  const res = await window.mfStudio.openZipDialog();
  handleImportPromptResponse(res);
});

btnConfirmEntryPick.addEventListener("click", async () => {
  if (!pendingImportIdState || !selEntryCandidate.value) return;
  const res = await window.mfStudio.confirmImportEntry(pendingImportIdState, selEntryCandidate.value);
  handleImportPromptResponse(res);
});

btnCancelEntryPick.addEventListener("click", async () => {
  if (pendingImportIdState) {
    await window.mfStudio.cancelPendingImport(pendingImportIdState);
  }
  pendingImportIdState = null;
  entryPickerDrawer.classList.add("hidden");
});

btnRefreshAssets.addEventListener("click", async () => {
  if (!state.session) return;
  const refreshed = await window.mfStudio.refreshAssetTree(state.session.sessionId);
  state.session.preflight = refreshed.preflight;
  state.session.assetTree = refreshed.assetTree;
  state.session.localAssets = refreshed.localAssets;
  state.session.analysis = refreshed.analysis;
  inspAssetCount.textContent = String(refreshed.localAssets.length);
  listAssets.innerHTML = "";
  renderAssetTreeNodes(listAssets, refreshed.assetTree);
  renderAnalysisReport(refreshed.analysis);
});

btnRunAnalysis.addEventListener("click", async () => {
  if (!state.session) return;
  const report = await window.mfStudio.runStaticAnalysis(state.session.sessionId);
  state.session.analysis = report;
  renderAnalysisReport(report);
});

for (const btn of diagFilterButtons) {
  btn.addEventListener("click", () => {
    const cat = (btn.dataset.diagCat ?? "ALL") as "ALL" | DiagnosticCategory;
    state.activeDiagFilter = cat;
    for (const other of diagFilterButtons) {
      other.classList.toggle("active", other === btn);
    }
    renderAnalysisReport(state.analysis);
  });
}

btnInspectDiagTarget.addEventListener("click", async () => {
  if (!state.session || !state.analysis || !state.selectedDiagId) return;
  const diag = state.analysis.diagnostics.find((d) => d.id === state.selectedDiagId);
  if (!diag?.inspectSelector) return;
  const res = await window.mfStudio.inspectDiagnosticElement(state.session.sessionId, diag.inspectSelector);
  if (res.found && res.rect) {
    diagInspectTelemetry.textContent = `Highlighted <${res.tagName}> @ (${res.rect.x}, ${res.rect.y}) ${res.rect.width}x${res.rect.height} · display:${res.computedDisplay} opacity:${res.computedOpacity}`;
    diagInspectTelemetry.className = "mono text-ok";
  } else {
    diagInspectTelemetry.textContent = `Element not found in live DOM: ${res.selector}`;
    diagInspectTelemetry.className = "mono text-warn";
  }
});

btnPreviewDiagDiff.addEventListener("click", async () => {
  if (!state.session || !state.selectedDiagId) return;
  try {
    const diff = await window.mfStudio.previewDiagnosticDiff(state.session.sessionId, state.selectedDiagId);
    state.pendingDiff = diff;
    lblDiffTargetFile.textContent = diff.targetFile;
    lblDiffTitle.textContent = diff.title;
    lblDiffHashNote.textContent = `Working Copy target SHA-256: ${diff.expectedBeforeSha256.slice(0, 12)}... (Original folder untouched)`;
    lblDiffApplyStatus.textContent = "";
    diffLinesView.innerHTML = "";
    for (const line of diff.diffText.split(/\r?\n/)) {
      const lineDiv = document.createElement("div");
      if (line.startsWith("+ ")) lineDiv.className = "diff-line-add";
      else if (line.startsWith("- ")) lineDiv.className = "diff-line-del";
      else if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) lineDiv.className = "diff-line-hdr";
      lineDiv.textContent = line;
      diffLinesView.appendChild(lineDiv);
    }
    btnConfirmApplyDiff.disabled = false;
    codeDiffDrawer.classList.remove("hidden");
  } catch (err: unknown) {
    lblDiffApplyStatus.textContent = err instanceof Error ? err.message : String(err);
    lblDiffApplyStatus.className = "mono text-err";
    codeDiffDrawer.classList.remove("hidden");
    btnConfirmApplyDiff.disabled = true;
  }
});

btnCancelDiff.addEventListener("click", async () => {
  if (state.session) {
    await window.mfStudio.cancelDiagnosticDiff(state.session.sessionId);
  }
  closeCodeDiffDrawer();
});

btnConfirmApplyDiff.addEventListener("click", async () => {
  if (!state.session || !state.pendingDiff) return;
  btnConfirmApplyDiff.disabled = true;
  lblDiffApplyStatus.textContent = "Applying fix to working copy & re-analyzing...";
  lblDiffApplyStatus.className = "mono";
  const res = await window.mfStudio.confirmApplyDiagnosticFix(
    state.session.sessionId,
    state.pendingDiff.proposalId
  );
  if (res.ok && res.session) {
    closeCodeDiffDrawer();
    applySessionToUi(res.session);
  } else {
    lblDiffApplyStatus.textContent = res.error ?? "Failed to apply working copy fix";
    lblDiffApplyStatus.className = "mono text-err";
    btnConfirmApplyDiff.disabled = false;
  }
});

btnLoadPaste.addEventListener("click", async () => {
  const html = txtPasteHtml.value;
  if (!html.trim()) return;
  const res = await window.mfStudio.loadPastedHtml(html, "Pasted Composition");
  if (res.ok && res.session) {
    pasteDrawer.classList.add("hidden");
  }
  applySessionToUi(
    res.ok ? res.session ?? null : null,
    res.ok ? null : res.preflight,
    undefined,
    res.ok ? undefined : res.analysis
  );
});

btnCloseSession.addEventListener("click", async () => {
  if (!state.session) return;
  await window.mfStudio.closeSession(state.session.sessionId);
  applySessionToUi(null);
});

for (const btn of scaleButtons) {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.scale as ViewportScaleMode;
    state.viewportMode = mode;
    for (const other of scaleButtons) other.classList.toggle("active", other === btn);
    syncViewportToMain();
  });
}

btnFirstFrame.addEventListener("click", () => {
  stopPlayback();
  stepToFrame(0);
});
btnPrevFrame.addEventListener("click", () => {
  stopPlayback();
  stepToFrame(state.currentFrame - 1);
});
btnPlayPause.addEventListener("click", () => togglePlayback());
btnNextFrame.addEventListener("click", () => {
  stopPlayback();
  stepToFrame(state.currentFrame + 1);
});
btnLastFrame.addEventListener("click", () => {
  stopPlayback();
  stepToFrame(state.totalFrames - 1);
});
btnLoopToggle.addEventListener("click", () => {
  state.loopEnabled = !state.loopEnabled;
  btnLoopToggle.classList.toggle("active", state.loopEnabled);
  btnLoopToggle.textContent = state.loopEnabled ? "Loop: On" : "Loop: Off";
});
btnSnapToggle.addEventListener("click", () => {
  if (!state.session || state.session.markersSec.length === 0) return;
  state.snapEnabled = !state.snapEnabled;
  btnSnapToggle.classList.toggle("active", state.snapEnabled);
  btnSnapToggle.textContent = state.snapEnabled
    ? `Snap: On (${state.session.markersSec.length})`
    : `Snap: Off (${state.session.markersSec.length})`;
});

rngFrameScrubber.addEventListener("input", () => {
  stopPlayback();
  stepToFrame(Number(rngFrameScrubber.value), true);
});

window.addEventListener("keydown", (ev) => {
  const activeTag = (document.activeElement?.tagName ?? "").toLowerCase();
  if (activeTag === "textarea" || activeTag === "input" || activeTag === "select") {
    return;
  }
  if (!state.session || state.totalFrames <= 0) return;

  if (ev.code === "Home") {
    ev.preventDefault();
    stopPlayback();
    stepToFrame(0);
  } else if (ev.code === "End") {
    ev.preventDefault();
    stopPlayback();
    stepToFrame(state.totalFrames - 1);
  } else if (ev.code === "ArrowLeft") {
    ev.preventDefault();
    stopPlayback();
    stepToFrame(state.currentFrame - 1);
  } else if (ev.code === "ArrowRight") {
    ev.preventDefault();
    stopPlayback();
    stepToFrame(state.currentFrame + 1);
  } else if (ev.code === "Space") {
    ev.preventDefault();
    togglePlayback();
  }
});

selFormat.addEventListener("change", updateExportInspectorVisibility);
selExportFps.addEventListener("change", syncExportReadyState);

btnChooseOutput.addEventListener("click", async () => {
  if (!state.session) return;
  const format = selFormat.value as "mp4" | "mov";
  const res = await window.mfStudio.chooseExportPath({ sessionId: state.session.sessionId, format });
  if (!res.canceled && res.exportTicketId) {
    state.exportTicketId = res.exportTicketId;
    lblExportDest.textContent = res.displayFileName ?? "Selected output";
  }
});

function collectValidatedExportPayload(): {
  sessionId: string;
  format: "mp4" | "mov";
  quality: "draft" | "standard" | "high";
  fps: FpsFraction;
  crf?: number;
  exportTicketId?: string;
} | null {
  if (!state.session) return null;
  lblExportValidation.textContent = "";

  const exportFps = resolveSelectedExportFps();
  if (!exportFps) {
    lblExportValidation.textContent = "Select Export FPS before rendering (source FPS is Unknown).";
    return null;
  }

  const format = selFormat.value as "mp4" | "mov";
  const quality = selQuality.value as "draft" | "standard" | "high";
  let crf: number | undefined;

  if (format === "mp4" && inpCrf.value.trim() !== "") {
    const parsedCrf = Number(inpCrf.value.trim());
    if (!Number.isInteger(parsedCrf) || parsedCrf < 0 || parsedCrf > 51) {
      lblExportValidation.textContent = "CRF must be an integer between 0 and 51.";
      return null;
    }
    crf = parsedCrf;
  }

  const ticketId = state.exportTicketId;
  state.exportTicketId = undefined;
  lblExportDest.textContent = "Default temp folder";

  return {
    sessionId: state.session.sessionId,
    format,
    quality,
    fps: exportFps,
    crf,
    exportTicketId: ticketId,
  };
}

function getDisplayQueueStatus(status: RenderQueueItemSnapshot["status"]): string {
  return status === "complete" ? "completed" : status;
}

function renderSelectedJobLog(): void {
  const log = state.selectedJobLog;
  if (!log) {
    lblLogSelectedJob.textContent = state.selectedLogJobId ? state.selectedLogJobId.slice(-14) : "None";
    btnExportJobLog.disabled = true;
    lblLogMetaLine.textContent = state.selectedLogJobId
      ? "Render log unavailable for selected job"
      : "Select a queue job to inspect logs";
    lblLogTruncationWarn.classList.add("hidden");
    lblLogTruncationWarn.textContent = "";
    listRenderLogs.innerHTML = "";
    listRenderLogs.textContent = state.selectedLogJobId ? "Log unavailable" : "No render log selected";
    return;
  }

  lblLogSelectedJob.textContent = log.jobId.slice(-14);
  btnExportJobLog.disabled = false;
  const exitText = log.workerExitCode !== null ? `exit=${log.workerExitCode}` : "exit=N/A";
  const wStderrText = `workerStderr=${log.workerStderrStatus}`;
  const ffStderrText = `ffmpegStderr=${log.ffmpegStderrStatus}`;
  lblLogMetaLine.textContent = `${getDisplayQueueStatus(log.status).toUpperCase()} · ${exitText} · ${wStderrText} · ${ffStderrText}`;

  if (log.truncated) {
    lblLogTruncationWarn.textContent = `Log ring buffer truncated (${log.droppedEntryCount} older low-priority entries evicted; max ${log.maxEntriesPerJob}).`;
    lblLogTruncationWarn.classList.remove("hidden");
  } else {
    lblLogTruncationWarn.classList.add("hidden");
    lblLogTruncationWarn.textContent = "";
  }

  listRenderLogs.innerHTML = "";
  if (log.entries.length === 0) {
    listRenderLogs.textContent = "No log entries recorded yet";
    return;
  }

  for (const entry of log.entries) {
    const row = document.createElement("div");
    row.className = `log-row log-level-${entry.level}`;
    const timePart = entry.timestamp.slice(11, 23);
    const stagePart = entry.stage ? `[${entry.stage}] ` : "";
    row.textContent = `${timePart} [${entry.level.toUpperCase()}] ${entry.event} ${stagePart}- ${entry.message}`;
    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      const metaSpan = document.createElement("div");
      metaSpan.style.color = "var(--text-dim)";
      metaSpan.style.paddingLeft = "10px";
      metaSpan.textContent = JSON.stringify(entry.metadata);
      row.appendChild(metaSpan);
    }
    listRenderLogs.appendChild(row);
  }
}

async function selectLogJob(jobId: string): Promise<void> {
  if (state.isDisposed) return;
  state.selectedLogJobId = jobId;
  lblLogExportStatus.textContent = "";
  renderQueueItemsList();

  try {
    const summary = await window.mfStudio.getRenderJobLog(jobId);
    if (state.isDisposed || state.selectedLogJobId !== jobId) return;
    state.selectedJobLog = summary;
    renderSelectedJobLog();
  } catch (err: unknown) {
    if (state.isDisposed || state.selectedLogJobId !== jobId) return;
    state.selectedJobLog = null;
    renderSelectedJobLog();
    lblLogMetaLine.textContent = `Log unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function renderQueueItemsList(): void {
  const snap = state.queueSnapshot;
  listRenderQueue.innerHTML = "";
  if (!snap || snap.items.length === 0) {
    listRenderQueue.textContent = "No queued render jobs";
    return;
  }

  for (const item of snap.items) {
    const card = document.createElement("div");
    card.className = `queue-item${item.jobId === state.selectedLogJobId ? " selected" : ""}`;
    card.dataset.jobId = item.jobId;

    const topRow = document.createElement("div");
    topRow.className = "queue-row";

    const outName = item.outputPath.split(/[\\/]/).pop() || item.jobId;
    const titleSpan = document.createElement("span");
    titleSpan.className = "mono tree-label";
    titleSpan.title = `${item.jobId}\n${outName}`;
    titleSpan.textContent = `${outName}`;

    const pill = document.createElement("span");
    pill.className = `pill pill-${item.status}`;
    pill.textContent = getDisplayQueueStatus(item.status);

    topRow.appendChild(titleSpan);
    topRow.appendChild(pill);
    card.appendChild(topRow);

    const subRow = document.createElement("div");
    subRow.className = "queue-row";
    subRow.style.fontSize = "10px";
    subRow.style.color = "var(--text-muted)";

    const prog = state.activeProgressByJobId[item.jobId];
    let infoText = `${item.format.toUpperCase()} · ${item.fps.num}/${item.fps.den} fps`;
    if (item.status === "rendering" && prog) {
      if (prog.framesRendered !== null && prog.totalFrames !== null) {
        infoText += ` · ${prog.framesRendered}/${prog.totalFrames}`;
      } else {
        infoText += ` · ${Math.round(prog.progress * 100)}%`;
      }
    } else if (item.status === "failed" && item.errorMessage) {
      infoText += ` · ${item.errorMessage.slice(0, 42)}`;
    } else if (item.status === "cancelled" && item.cancelReason) {
      infoText += ` · ${item.cancelReason}`;
    }

    const infoSpan = document.createElement("span");
    infoSpan.className = "mono tree-label";
    infoSpan.textContent = infoText;
    subRow.appendChild(infoSpan);

    // Terminal items NEVER show an active Cancel button
    if (item.status === "queued" || item.status === "rendering") {
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.className = "danger";
      cancelBtn.style.padding = "1px 6px";
      cancelBtn.style.fontSize = "10px";
      cancelBtn.dataset.cancelJobId = item.jobId;
      cancelBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        cancelBtn.disabled = true;
        void window.mfStudio.cancelQueueItem(item.jobId).catch((err) => {
          lblRenderOutcome.textContent = err instanceof Error ? err.message : String(err);
          lblRenderOutcome.className = "mono text-err";
        });
      });
      subRow.appendChild(cancelBtn);
    }

    card.appendChild(subRow);
    card.addEventListener("click", () => {
      void selectLogJob(item.jobId);
    });
    listRenderQueue.appendChild(card);
  }
}

function applyRenderQueueSnapshot(snapshot: RenderQueueSnapshot): void {
  if (state.isDisposed) return;
  if (typeof snapshot.version === "number" && snapshot.version < state.lastQueueVersion) {
    return; // Reject out-of-order / stale queue snapshot
  }
  state.lastQueueVersion = snapshot.version ?? state.lastQueueVersion;
  state.queueSnapshot = snapshot;

  const c = snapshot.counts;
  lblQueueSummaryBadge.textContent = `Q:${snapshot.queuedCount} R:${snapshot.activeCount}`;
  lblQueueCountsLine.textContent = `Queued: ${c.queued} · Active: ${c.rendering} · Done: ${c.complete} · Failed: ${c.failed} · Cancelled: ${c.cancelled}`;
  btnClearCompleted.disabled = c.complete + c.cancelled + c.failed === 0;

  const activeItem = snapshot.items.find((i) => i.status === "rendering") ?? null;
  if (activeItem) {
    state.activeJobId = activeItem.jobId;
    btnCancelRender.disabled = false;
  } else if (!state.renderSubmitInFlight) {
    state.activeJobId = null;
    btnCancelRender.disabled = true;
  }

  if (snapshot.items.length > 0 && !state.selectedLogJobId) {
    void selectLogJob(snapshot.items[snapshot.items.length - 1].jobId);
  } else {
    renderQueueItemsList();
  }
  syncExportReadyState();
}

function formatThroughputPair(
  ar: RuntimeTelemetrySnapshot["activeRender"]
): { rateText: string; etaText: string } {
  if (!ar) {
    return { rateText: "N/A", etaText: "N/A" };
  }
  const parts: string[] = [];
  if (ar.captureFps !== null) parts.push(`Cap ${ar.captureFps} fps`);
  if (ar.encodeFps !== null) parts.push(`Enc ${ar.encodeFps} fps`);
  if (parts.length === 0) {
    parts.push(ar.throughputFps !== null ? `${ar.throughputFps} fps` : "N/A");
  }
  return {
    rateText: parts.join(" · "),
    etaText: formatTelemetryMetric(ar.etaSeconds, "s"),
  };
}

function applyRuntimeTelemetry(snap: RuntimeTelemetrySnapshot): void {
  if (state.isDisposed) return;
  if (snap.sampledAtMs < state.lastTelemetrySampledAtMs) {
    return; // Ignore older telemetry packet
  }
  state.lastTelemetrySampledAtMs = snap.sampledAtMs;
  state.telemetry = snap;

  const electronMem =
    snap.memoryStatus === "available" && snap.totalWorkingSetMB !== null
      ? `${snap.totalWorkingSetMB} MB (${snap.processCount}p)`
      : "N/A";
  const rate = formatThroughputPair(snap.activeRender);

  lblStatusTelemetry.textContent =
    `Electron RAM: ${electronMem} · Ext Worker RAM: N/A · Render: ${rate.rateText} · ETA: ${rate.etaText} · Queue: ${snap.queue.activeCount}/${snap.queue.queuedCount}`;
  lblRenderThroughput.textContent = `${rate.rateText} · ETA: ${rate.etaText}`;
}

function applyTerminalResultToProgressBox(res: RenderJobResult): void {
  lblRenderElapsed.textContent = `${(res.wallMs / 1000).toFixed(2)}s`;
  lblRenderThroughput.textContent = "N/A · ETA: N/A";

  if (res.status === "complete") {
    state.completedJobId = res.jobId;
    progressFill.style.width = "100%";
    lblRenderStage.textContent = "Completed";
    if (res.framesRendered !== null && res.totalFrames !== null) {
      lblRenderFrames.textContent = `${res.framesRendered} / ${res.totalFrames}`;
    }
    lblRenderOutcome.textContent = `Complete (${res.outcome})`;
    lblRenderOutcome.className = "mono text-ok";
    btnOpenOutput.disabled = false;
  } else if (res.status === "cancelled") {
    lblRenderStage.textContent = "Cancelled";
    lblRenderOutcome.textContent = `Cancelled: ${res.errorReason ?? res.errorName ?? "user"}`;
    lblRenderOutcome.className = "mono text-warn";
  } else {
    lblRenderStage.textContent = "Failed";
    lblRenderOutcome.textContent = `Failed: ${res.errorName ?? "Error"} — ${res.errorMessage ?? ""}`;
    lblRenderOutcome.className = "mono text-err";
  }
}

let enqueueRequestInFlight = false;

btnRender.addEventListener("click", async () => {
  if (state.renderSubmitInFlight || enqueueRequestInFlight) return;
  const payload = collectValidatedExportPayload();
  if (!payload) return;

  state.renderSubmitInFlight = true;
  state.completedJobId = null;
  state.renderStartedAtMs = Date.now();
  btnRender.disabled = true;
  btnCancelRender.disabled = false;
  btnOpenOutput.disabled = true;
  progressFill.style.width = "0%";
  lblRenderStage.textContent = "Starting worker...";
  lblRenderFrames.textContent = "-";
  lblRenderElapsed.textContent = "0.0s";
  lblRenderThroughput.textContent = "N/A · ETA: N/A";
  lblRenderOutcome.textContent = "Rendering...";
  lblRenderOutcome.className = "mono";

  try {
    const res = await window.mfStudio.startSessionRender(payload);
    if (!state.isDisposed) {
      applyTerminalResultToProgressBox(res);
    }
  } catch (err: unknown) {
    if (!state.isDisposed) {
      lblRenderStage.textContent = "Error";
      lblRenderOutcome.textContent = err instanceof Error ? err.message : String(err);
      lblRenderOutcome.className = "mono text-err";
    }
  } finally {
    state.renderSubmitInFlight = false;
    state.activeJobId = null;
    if (!state.isDisposed) {
      syncExportReadyState();
      btnCancelRender.disabled = !(state.queueSnapshot && state.queueSnapshot.activeCount > 0);
    }
  }
});

btnAddToQueue.addEventListener("click", async () => {
  if (enqueueRequestInFlight) return;
  const payload = collectValidatedExportPayload();
  if (!payload) return;

  enqueueRequestInFlight = true;
  btnAddToQueue.disabled = true;
  btnRender.disabled = true;

  try {
    const item = await window.mfStudio.enqueueRenderJob(payload);
    if (!state.isDisposed) {
      void selectLogJob(item.jobId);
      lblExportValidation.textContent = "";
    }
  } catch (err: unknown) {
    if (!state.isDisposed) {
      lblExportValidation.textContent = err instanceof Error ? err.message : String(err);
    }
  } finally {
    enqueueRequestInFlight = false;
    if (!state.isDisposed) {
      syncExportReadyState();
    }
  }
});

btnCancelRender.addEventListener("click", async () => {
  const targetJob = state.activeJobId ?? state.queueSnapshot?.items.find((i) => i.status === "rendering")?.jobId;
  if (!targetJob) return;
  await window.mfStudio.cancelQueueItem(targetJob);
});

btnClearCompleted.addEventListener("click", async () => {
  await window.mfStudio.clearFinishedQueueItems();
});

btnExportJobLog.addEventListener("click", async () => {
  if (!state.selectedLogJobId) return;
  btnExportJobLog.disabled = true;
  lblLogExportStatus.textContent = "Opening save dialog...";
  lblLogExportStatus.className = "mono";
  try {
    const res = await window.mfStudio.exportRenderJobLog(state.selectedLogJobId);
    if (state.isDisposed) return;
    if (res.canceled) {
      lblLogExportStatus.textContent = "Export canceled (no file written)";
      lblLogExportStatus.className = "mono text-warn";
    } else if (res.ok) {
      lblLogExportStatus.textContent = `Exported: ${res.exportedFileName ?? "render-log.json"}`;
      lblLogExportStatus.className = "mono text-ok";
    } else {
      lblLogExportStatus.textContent = `Export failed: ${res.error ?? "unknown error"}`;
      lblLogExportStatus.className = "mono text-err";
    }
  } catch (err: unknown) {
    if (!state.isDisposed) {
      lblLogExportStatus.textContent = `Export error: ${err instanceof Error ? err.message : String(err)}`;
      lblLogExportStatus.className = "mono text-err";
    }
  } finally {
    if (!state.isDisposed) {
      btnExportJobLog.disabled = !state.selectedJobLog;
    }
  }
});

btnOpenOutput.addEventListener("click", async () => {
  if (!state.completedJobId) return;
  await window.mfStudio.openOutputLocation(state.completedJobId);
});

const activeCleanupFns: Array<() => void> = [];

function disposeUiListeners(): void {
  state.isDisposed = true;
  while (activeCleanupFns.length > 0) {
    const fn = activeCleanupFns.pop();
    try {
      fn?.();
    } catch {
      // Best-effort cleanup
    }
  }
}

function bindStudioListeners(): void {
  while (activeCleanupFns.length > 0) {
    const fn = activeCleanupFns.pop();
    try {
      fn?.();
    } catch {
      // Ignore cleanup failures
    }
  }
  state.isDisposed = false;

  activeCleanupFns.push(
    window.mfStudio.onRenderProgress((ev: RenderProgressEvent) => {
      if (state.isDisposed) return;
      if (ev?.jobId) {
        state.activeJobId = ev.jobId;
        state.activeProgressByJobId[ev.jobId] = {
          stage: ev.stageCode ?? ev.currentStage ?? "render",
          framesRendered: typeof ev.framesRendered === "number" ? ev.framesRendered : null,
          totalFrames: typeof ev.totalFrames === "number" && ev.totalFrames > 0 ? ev.totalFrames : null,
          progress: typeof ev.progress === "number" ? ev.progress : 0,
        };
      }
      if (state.renderStartedAtMs === null) {
        state.renderStartedAtMs = Date.now();
      }
      lblRenderStage.textContent = ev?.stageCode ?? ev?.currentStage ?? "render";
      const doneF = typeof ev?.framesRendered === "number" ? ev.framesRendered : null;
      const totalF = typeof ev?.totalFrames === "number" && ev.totalFrames > 0 ? ev.totalFrames : null;
      if (doneF !== null && totalF !== null) {
        const pct = Math.max(0, Math.min(100, Math.round((doneF / totalF) * 100)));
        lblRenderFrames.textContent = `${doneF} / ${totalF} (${pct}%)`;
        progressFill.style.width = `${pct}%`;
      } else if (typeof ev?.progress === "number") {
        const pct = Math.max(0, Math.min(100, Math.round(ev.progress * 100)));
        progressFill.style.width = `${pct}%`;
      }
      if (state.renderStartedAtMs !== null) {
        lblRenderElapsed.textContent = `${((Date.now() - state.renderStartedAtMs) / 1000).toFixed(1)}s`;
      }
      renderQueueItemsList();
    }),
    window.mfStudio.onRenderComplete((res: RenderJobResult) => {
      if (state.isDisposed || !res) return;
      delete state.activeProgressByJobId[res.jobId];
      state.renderStartedAtMs = null;
      applyTerminalResultToProgressBox(res);
      if (res.jobId === state.selectedLogJobId) {
        void selectLogJob(res.jobId);
      }
    }),
    window.mfStudio.onQueueUpdated((snapshot: RenderQueueSnapshot) => {
      applyRenderQueueSnapshot(snapshot);
    }),
    window.mfStudio.onRuntimeTelemetry((snapshot: RuntimeTelemetrySnapshot) => {
      applyRuntimeTelemetry(snapshot);
    }),
    window.mfStudio.onRenderLogUpdated((payload: { jobId: string; entry: RenderLogEntry }) => {
      if (state.isDisposed || !payload || payload.jobId !== state.selectedLogJobId) return;
      if (!state.selectedJobLog) {
        void selectLogJob(payload.jobId);
        return;
      }
      const entries = state.selectedJobLog.entries;
      const last = entries[entries.length - 1];
      if (
        last &&
        last.timestampMs === payload.entry.timestampMs &&
        last.event === payload.entry.event &&
        last.message === payload.entry.message
      ) {
        return;
      }
      if (entries.length >= state.selectedJobLog.maxEntriesPerJob) {
        entries.shift();
        state.selectedJobLog.truncated = true;
        state.selectedJobLog.droppedEntryCount += 1;
      }
      entries.push(payload.entry);
      renderSelectedJobLog();
      if (payload.entry.event === "final_render_summary") {
        void selectLogJob(payload.jobId);
      }
    }),
    window.mfStudio.onSecurityViolation((ev: any) => {
      if (state.isDisposed) return;
      state.violationCount += 1;
      lblViolationCountBadge.textContent = String(state.violationCount);
      if (state.violationCount === 1) {
        securityLog.innerHTML = "";
      }
      const row = document.createElement("div");
      row.className = "text-err";
      row.textContent = `[${ev?.source ?? "security"}] ${ev?.reason ?? "blocked"}: ${ev?.url ?? ""}`;
      securityLog.prepend(row);
    })
  );

  const ro = new ResizeObserver(() => syncViewportToMain());
  ro.observe(viewportStage);
  const onResize = () => syncViewportToMain();
  window.addEventListener("resize", onResize);
  activeCleanupFns.push(
    () => ro.disconnect(),
    () => window.removeEventListener("resize", onResize)
  );
}

bindStudioListeners();
window.addEventListener("beforeunload", disposeUiListeners);
updateExportInspectorVisibility();

void window.mfStudio.getRuntimeInfo().then((info) => {
  if (state.isDisposed) return;
  const p = info.pinnedRuntime;
  lblRuntimeVersions.textContent = `Engine ${p.hyperframesEngineVersion} · Producer ${p.hyperframesProducerVersion} · Electron ${info.electronVersion ?? p.electronVersion} · Chrome ${p.chromeHeadlessShellVersion}`;
});

void window.mfStudio.getRenderQueueSnapshot().then((snap) => {
  applyRenderQueueSnapshot(snap);
});

void window.mfStudio.getRuntimeTelemetry().then((snap) => {
  applyRuntimeTelemetry(snap);
});

// Expose read-only UI test inspection hooks strictly without exposing Node/FS
(window as unknown as Record<string, unknown>).__mfWorkbenchUi = {
  getState: () => ({
    sessionId: state.session?.sessionId ?? null,
    viewportMode: state.viewportMode,
    currentFrame: state.currentFrame,
    totalFrames: state.totalFrames,
    effectiveFps: state.effectiveFps,
    seekSupported: state.seekSupported,
    loopEnabled: state.loopEnabled,
    snapEnabled: state.snapEnabled,
    completedJobId: state.completedJobId,
    analysisSummary: state.analysis?.summary ?? null,
    selectedDiagId: state.selectedDiagId,
    activeDiagFilter: state.activeDiagFilter,
    queueSnapshot: state.queueSnapshot,
    selectedLogJobId: state.selectedLogJobId,
    selectedJobLog: state.selectedJobLog,
    telemetry: state.telemetry,
    activeListenerCount: activeCleanupFns.length,
    isDisposed: state.isDisposed,
  }),
  rebindListenersForTest: () => bindStudioListeners(),
  disposeListenersForTest: () => disposeUiListeners(),
};
