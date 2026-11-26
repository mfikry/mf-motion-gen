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
  eventPreviewStatus: "studio:eventPreviewStatus",
  eventSecurityViolation: "studio:eventSecurityViolation",
  eventRenderProgress: "studio:eventRenderProgress",
  eventRenderComplete: "studio:eventRenderComplete",
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
  width: number | null;
  height: number | null;
  durationSec: number | null;
  fps: FpsFraction | null;
  totalFrames: number | null;
  localAssets: string[];
  assetTree: AssetTreeNode[];
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
