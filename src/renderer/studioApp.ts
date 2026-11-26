import {
  clampFrameIndex,
  computeTotalFrames,
  formatFpsLabel,
  formatTimecode,
  frameToTimeSec,
  parseFpsValue,
  snapFrameToMarkers,
} from "../shared/frameMath.js";
import type { FpsFraction } from "../shared/renderContracts.js";
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
  }): Promise<any>;
  cancelSessionRender(jobId: string): Promise<{ cancelled: boolean }>;
  openOutputLocation(jobId: string): Promise<{ opened: boolean; reason?: string }>;
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
const btnCancelRender = el<HTMLButtonElement>("btnCancelRender");
const lblRenderStage = el("lblRenderStage");
const lblRenderFrames = el("lblRenderFrames");
const lblRenderElapsed = el("lblRenderElapsed");
const progressFill = el("progressFill");
const lblRenderOutcome = el("lblRenderOutcome");
const btnOpenOutput = el<HTMLButtonElement>("btnOpenOutput");
const lblViolationCountBadge = el("lblViolationCountBadge");
const securityLog = el("securityLog");

// StatusBar
const lblRuntimeVersions = el("lblRuntimeVersions");

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
  violationCount: number;
  analysis: CompositionAnalysisReport | null;
  activeDiagFilter: "ALL" | DiagnosticCategory;
  selectedDiagId: string | null;
  pendingDiff: DiagnosticCodeDiffPreview | null;
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
  violationCount: 0,
  analysis: null,
  activeDiagFilter: "ALL",
  selectedDiagId: null,
  pendingDiff: null,
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
    return;
  }
  const resolved = resolveSelectedExportFps();
  if (!resolved) {
    btnRender.disabled = true;
    lblExportValidation.textContent = "Select Export FPS before rendering (source FPS is Unknown).";
  } else {
    btnRender.disabled = false;
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

btnRender.addEventListener("click", async () => {
  if (!state.session) return;
  lblExportValidation.textContent = "";

  const exportFps = resolveSelectedExportFps();
  if (!exportFps) {
    lblExportValidation.textContent = "Select Export FPS before rendering (source FPS is Unknown).";
    return;
  }

  const format = selFormat.value as "mp4" | "mov";
  const quality = selQuality.value as "draft" | "standard" | "high";
  let crf: number | undefined;

  if (format === "mp4" && inpCrf.value.trim() !== "") {
    const parsedCrf = Number(inpCrf.value.trim());
    if (!Number.isInteger(parsedCrf) || parsedCrf < 0 || parsedCrf > 51) {
      lblExportValidation.textContent = "CRF must be an integer between 0 and 51.";
      return;
    }
    crf = parsedCrf;
  }

  state.completedJobId = null;
  state.renderStartedAtMs = Date.now();
  btnRender.disabled = true;
  btnCancelRender.disabled = false;
  btnOpenOutput.disabled = true;
  progressFill.style.width = "0%";
  lblRenderStage.textContent = "Starting worker...";
  lblRenderFrames.textContent = "-";
  lblRenderElapsed.textContent = "0.0s";
  lblRenderOutcome.textContent = "Rendering...";
  lblRenderOutcome.className = "mono";

  try {
    const res = await window.mfStudio.startSessionRender({
      sessionId: state.session.sessionId,
      format,
      quality,
      fps: exportFps,
      crf,
      exportTicketId: state.exportTicketId,
    });
    state.activeJobId = null;
    state.exportTicketId = undefined;
    btnRender.disabled = false;
    btnCancelRender.disabled = true;
    lblRenderElapsed.textContent = `${(res.wallMs / 1000).toFixed(2)}s`;

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
  } catch (err: unknown) {
    state.activeJobId = null;
    btnRender.disabled = false;
    btnCancelRender.disabled = true;
    lblRenderStage.textContent = "Error";
    lblRenderOutcome.textContent = err instanceof Error ? err.message : String(err);
    lblRenderOutcome.className = "mono text-err";
  }
});

btnCancelRender.addEventListener("click", async () => {
  if (!state.activeJobId) return;
  await window.mfStudio.cancelSessionRender(state.activeJobId);
});

btnOpenOutput.addEventListener("click", async () => {
  if (!state.completedJobId) return;
  await window.mfStudio.openOutputLocation(state.completedJobId);
});

window.mfStudio.onRenderProgress((ev: any) => {
  if (ev?.jobId) state.activeJobId = ev.jobId;
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
});

window.mfStudio.onSecurityViolation((ev: any) => {
  state.violationCount += 1;
  lblViolationCountBadge.textContent = String(state.violationCount);
  if (state.violationCount === 1) {
    securityLog.innerHTML = "";
  }
  const row = document.createElement("div");
  row.className = "text-err";
  row.textContent = `[${ev?.source ?? "security"}] ${ev?.reason ?? "blocked"}: ${ev?.url ?? ""}`;
  securityLog.prepend(row);
});

new ResizeObserver(() => syncViewportToMain()).observe(viewportStage);
window.addEventListener("resize", syncViewportToMain);
updateExportInspectorVisibility();

void window.mfStudio.getRuntimeInfo().then((info) => {
  const p = info.pinnedRuntime;
  lblRuntimeVersions.textContent = `Engine ${p.hyperframesEngineVersion} · Producer ${p.hyperframesProducerVersion} · Electron ${info.electronVersion ?? p.electronVersion} · Chrome ${p.chromeHeadlessShellVersion}`;
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
  }),
};
