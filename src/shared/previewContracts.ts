import type {
  FpsFraction,
  PINNED_RUNTIME,
  PreflightResult,
  RenderFormat,
  RenderQuality,
} from "./renderContracts.js";

export const PREVIEW_SCHEME = "mf-asset" as const;

export const IPC_CHANNELS = {
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
  eventPreviewStatus: "studio:eventPreviewStatus",
  eventSecurityViolation: "studio:eventSecurityViolation",
  eventRenderProgress: "studio:eventRenderProgress",
  eventRenderComplete: "studio:eventRenderComplete",
  eventQueueUpdated: "studio:eventQueueUpdated",
  eventRuntimeTelemetry: "studio:eventRuntimeTelemetry",
  eventRenderLogUpdated: "studio:eventRenderLogUpdated",
} as const;

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ViewportScaleMode = "fit" | "50" | "100" | "200";

export interface PreviewViewportPayload {
  sessionId: string | null;
  mode: ViewportScaleMode;
  panelRect: PreviewBounds;
}

export interface PreviewViewportState {
  scaleFactor: number;
  bounds: PreviewBounds;
}

export type CompositionSourceMode = "original_file" | "working_copy";

export type AssetValidationState =
  | "entry"
  | "verified"
  | "missing"
  | "blocked"
  | "unsupported"
  | "unused";

export interface AssetTreeNode {
  name: string;
  relativePath: string;
  kind: "directory" | "file";
  extension?: string;
  mimeType?: string | null;
  sizeBytes?: number;
  validationStatus?: AssetValidationState;
  diagnosticMessage?: string;
  sha256?: string;
  children?: AssetTreeNode[];
}

export type DiagnosticCategory =
  | "PERSISTENT"
  | "TRANSIENT"
  | "TIMELINE_CONTROLLED"
  | "MEDIA"
  | "WARNING_AMBIGUOUS";

export type DiagnosticConfidence = "high" | "medium" | "low";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DiagnosticSourceLocation {
  file: string;
  line: number;
  column?: number;
  snippet?: string;
}

export interface DiagnosticCodeDiffPreview {
  proposalId: string;
  title: string;
  targetFile: string;
  expectedBeforeSha256: string;
  beforeSnippet: string;
  afterSnippet: string;
  diffText: string;
}

export interface CompositionDiagnostic {
  id: string;
  ruleId: string;
  category: DiagnosticCategory;
  elementIdentifier: string;
  inspectSelector: string | null;
  sourceLocation: DiagnosticSourceLocation | null;
  reason: string;
  confidence: DiagnosticConfidence;
  severity: DiagnosticSeverity;
  evidence: string[];
  canAutoFix: boolean;
  noAutoFixReason: string | null;
  fixCandidateAvailable: boolean;
}

export interface CompositionAnalysisSummary {
  total: number;
  countsByCategory: Record<DiagnosticCategory, number>;
  blockerCount: number;
  warningCount: number;
  autoFixableCount: number;
}

export interface CompositionAnalysisReport {
  analyzedAtIso: string;
  entryFile: string;
  analyzedFiles: string[];
  timelineContract: {
    hasMainTimeline: boolean;
    timelineKeys: string[];
    pausedLikely: boolean | null;
    hasCallbacks: boolean;
    hasLateRegistration: boolean;
    hasIifeTimeline: boolean;
    hasCachedReference: boolean;
    hasDynamicExpressions: boolean;
  };
  summary: CompositionAnalysisSummary;
  diagnostics: CompositionDiagnostic[];
}

export interface InspectElementResult {
  found: boolean;
  selector: string;
  tagName?: string;
  rect?: { x: number; y: number; width: number; height: number };
  computedDisplay?: string;
  computedOpacity?: string;
}

export interface ApplyDiagnosticFixResult {
  ok: boolean;
  error?: string;
  modifiedFile?: string;
  session?: PreviewSessionInfo;
  preflight?: PreflightResult;
}

export interface ImportProjectPromptResult {
  canceled: boolean;
  needsEntrySelection?: boolean;
  pendingImportId?: string;
  candidates?: string[];
  suggestedEntry?: string;
  ok?: boolean;
  session?: PreviewSessionInfo;
  preflight?: PreflightResult;
  assetTree?: AssetTreeNode[];
  analysis?: CompositionAnalysisReport;
  error?: string;
}

export interface RuntimeInfoSnapshot {
  pinnedRuntime: typeof PINNED_RUNTIME;
  electronVersion: string | null;
  nodeVersion: string;
  supportedFormats: readonly RenderFormat[];
  crfSupportedFormats: readonly RenderFormat[];
  proresValidatedProfile: "4444";
}

export interface PreviewSessionInfo {
  sessionId: string;
  origin: string;
  entryUrl: string;
  entryFile: string;
  title: string;
  sourceMode: CompositionSourceMode;
  importKind?: "html" | "paste" | "folder" | "zip";
  sourceDigestSha256?: string | null;
  sourceFileCount?: number;
  workingCopyModified?: boolean;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  fps: FpsFraction | null;
  totalFrames: number | null;
  localAssets: string[];
  assetTree: AssetTreeNode[];
  analysis?: CompositionAnalysisReport;
  markersSec: number[];
  preflight: PreflightResult;
}

export interface PreviewTimelineState {
  ready: boolean;
  hasTimeline: boolean;
  durationSec: number | null;
  currentTimeSec: number;
  seekSupported: boolean;
  markersSec: number[];
  warning?: string;
}

export interface SecurityViolationEvent {
  sessionId: string;
  source: "webRequest" | "protocol" | "navigation" | "popup";
  url: string;
  resourceType?: string;
  reason: string;
  timestampMs: number;
}

export interface ChooseExportPathPayload {
  sessionId: string;
  format: RenderFormat;
}

export interface ChooseExportPathResult {
  canceled: boolean;
  exportTicketId?: string;
  displayFileName?: string;
}

export interface SessionRenderRequestPayload {
  sessionId: string;
  format: RenderFormat;
  quality: RenderQuality;
  fps?: FpsFraction;
  crf?: number;
  exportTicketId?: string;
  workers?: number;
}

export interface LoadPastedHtmlPayload {
  html: string;
  title?: string;
}

export interface PreviewSeekPayload {
  sessionId: string;
  timeSec: number;
}

export interface SessionIdPayload {
  sessionId: string;
}
