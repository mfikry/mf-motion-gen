export const PINNED_RUNTIME = {
  hyperframesEngineVersion: "0.9.93",
  hyperframesProducerVersion: "0.9.93",
  electronVersion: "45.4.1",
  chromeHeadlessShellVersion: "158.0.8127.36",
} as const;

export const ALPHA_REFERENCE_LIMITATION_NOTE =
  "Alpha verification is strictly bounded to parity against Chromium's 8-bit PNG source (bitDepth=8); 10/12-bit MOV precision beyond 8-bit source fidelity is not claimed.";

export type RenderFormat = "mp4" | "mov";
export type RenderQuality = "draft" | "standard" | "high";
export type RenderStrictness = "strict" | "best-effort";

export interface FpsFraction {
  num: number;
  den: number;
}

export type PreflightSeverity = "error" | "warning";

export type PreflightCode =
  | "STAGE_DIR_INVALID"
  | "ENTRY_FILE_UNSAFE"
  | "ENTRY_FILE_MISSING"
  | "UNSAFE_ASSET_PATH"
  | "WINDOWS_ADS_REJECTED"
  | "ASSET_SYMLINK_ESCAPE"
  | "MISSING_LOCAL_ASSET"
  | "MISSING_CSS_FONT"
  | "EXTERNAL_FONT_DISALLOWED"
  | "EXTERNAL_NETWORK_DISALLOWED"
  | "TIMELINE_CONTRACT_MISSING"
  | "DYNAMIC_NETWORK_API_WARNING";

export interface PreflightFinding {
  code: PreflightCode;
  severity: PreflightSeverity;
  message: string;
  reference?: string;
  resolvedPath?: string;
}

export interface PreflightOptions {
  /** Entry HTML relative to stageDir. Defaults to "index.html". */
  entryFile?: string;
  /** Treat dynamic JS network patterns (fetch/XHR/WebSocket) as warnings (default) or errors. */
  rejectDynamicNetworkHints?: boolean;
}

export interface PreflightResult {
  ok: boolean;
  stageDir: string;
  entryPath: string | null;
  blockers: PreflightFinding[];
  warnings: PreflightFinding[];
  checkedLocalAssets: string[];
  checkedStylesheets: string[];
  externalReferences: string[];
  elapsedMs: number;
}

export interface RenderJobRequest {
  jobId: string;
  stageDir: string;
  entryFile?: string;
  outputPath: string;
  format?: RenderFormat;
  quality?: RenderQuality;
  fps?: FpsFraction;
  crf?: number;
  workers?: number;
  maxRenderMs?: number;
  strictness?: RenderStrictness;
  chromePath?: string;
  proresProfile?: "4444" | "422" | "hq" | "lt" | "proxy";
}

export interface RenderProgressEvent {
  jobId: string;
  stageCode: string | null;
  stageDone: number | null;
  stageTotal: number | null;
  framesRendered: number;
  totalFrames: number | null;
  progress: number;
  currentStage: string;
  timestampMs: number;
}

export interface RenderJobWarning {
  code: string;
  message: string;
  stage?: string;
}

export interface RenderJobResult {
  jobId: string;
  status: "complete" | "cancelled" | "failed";
  outcome: "completed" | "completed_with_warnings" | "cancelled" | "failed";
  outputPath: string;
  wallMs: number;
  framesRendered: number | null;
  totalFrames: number | null;
  warnings: RenderJobWarning[];
  errorName?: string;
  errorReason?: string;
  errorMessage?: string;
  classifiedFailureKind?: string;
  isFatalFailure?: boolean;
  alphaLimitationNote?: string;
}

export type MainToWorkerMessage =
  | { type: "ping"; seq: number; sentAtMs: number }
  | { type: "startRender"; request: RenderJobRequest }
  | { type: "cancelRender"; jobId: string; reason?: string };

export type WorkerToMainMessage =
  | {
      type: "ready";
      pid: number;
      nodeVersion: string;
      electronVersion: string | null;
      pinnedRuntime: typeof PINNED_RUNTIME;
    }
  | { type: "pong"; seq: number; pid: number; receivedAtMs: number }
  | { type: "progress"; event: RenderProgressEvent }
  | { type: "childProcessTracked"; jobId: string; childPid: number; command?: string }
  | { type: "complete"; result: RenderJobResult }
  | { type: "failed"; result: RenderJobResult }
  | { type: "workerInternalError"; message: string; stack?: string };
