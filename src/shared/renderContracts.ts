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

export type RenderQueueItemStatus =
  | "queued"
  | "rendering"
  | "complete"
  | "cancelled"
  | "failed";

export interface RenderQueueItemSnapshot {
  jobId: string;
  sessionId: string;
  title: string;
  format: RenderFormat;
  fps: FpsFraction;
  outputPath: string;
  boundStageDir: string;
  status: RenderQueueItemStatus;
  enqueuedAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  cancelReason?: string;
  errorMessage?: string;
  result?: RenderJobResult;
}

export interface RenderQueueSnapshot {
  version: number;
  maxCapacity: number;
  activeCount: number;
  queuedCount: number;
  counts: {
    queued: number;
    rendering: number;
    complete: number;
    cancelled: number;
    failed: number;
  };
  items: RenderQueueItemSnapshot[];
}

export type RenderLogLevel = "debug" | "info" | "warning" | "error";

export type RenderLifecycleEventName =
  | "job_created"
  | "job_enqueued"
  | "job_started"
  | "job_completed"
  | "job_failed"
  | "job_cancelled"
  | "job_rejected_preflight"
  | "job_rejected_session"
  | "queue_shutdown"
  | "preflight_validation"
  | "worker_spawned"
  | "worker_ready"
  | "stage_transition"
  | "capture_progress"
  | "encoding_progress"
  | "worker_stderr"
  | "worker_exit"
  | "cancellation_requested"
  | "watchdog_timeout"
  | "process_tree_cleanup"
  | "final_render_summary";

export interface RenderLogEntry {
  timestamp: string;
  timestampMs: number;
  jobId: string;
  sessionId: string | null;
  level: RenderLogLevel;
  event: RenderLifecycleEventName;
  stage: string | null;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface RenderThroughputMetrics {
  throughputFps: number | null;
  captureFps: number | null;
  encodeFps: number | null;
  etaSeconds: number | null;
  framesRendered: number | null;
  totalFrames: number | null;
  elapsedMs: number | null;
  isEstimateValid: boolean;
  unavailableReason: string | null;
}

export interface RenderStageHistoryEntry {
  stage: string;
  timestamp: string;
  elapsedMs: number;
}

export interface RenderJobLogSummary {
  jobId: string;
  sessionId: string | null;
  title: string;
  status: RenderQueueItemStatus;
  format: RenderFormat;
  fps: FpsFraction;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  preflightSummary: {
    ok: boolean;
    blockerCodes: string[];
    warningCodes: string[];
    checkedAssetCount: number;
    elapsedMs: number | null;
  } | null;
  stageHistory: RenderStageHistoryEntry[];
  workerPid: number | null;
  workerExitCode: number | null;
  workerStderrStatus: "captured" | "unavailable";
  workerStderr: string | null;
  ffmpegStderrStatus: "captured" | "unavailable";
  ffmpegStderr: string | null;
  failureReason: string | null;
  cancellationReason: string | null;
  watchdogReason: string | null;
  cleanupActionCount: number;
  survivingOrphans: number | null;
  finalMetrics: {
    wallMs: number | null;
    framesRendered: number | null;
    totalFrames: number | null;
    throughputFps: number | null;
    captureFps: number | null;
    encodeFps: number | null;
  };
  truncated: boolean;
  droppedEntryCount: number;
  maxEntriesPerJob: number;
  entries: RenderLogEntry[];
}

export interface ExportRenderLogResult {
  canceled: boolean;
  ok: boolean;
  exportedFileName?: string;
  error?: string;
}

export interface ProcessMetricTelemetryItem {
  pid: number | null;
  creationTime: number | null;
  type: string;
  name: string | null;
  workingSetMB: number | null;
  peakWorkingSetMB: number | null;
  privateBytesMB: number | null;
  cpuPercent: number | null;
}

export interface ActiveRenderTelemetrySnapshot {
  jobId: string;
  stage: string | null;
  framesRendered: number | null;
  totalFrames: number | null;
  elapsedMs: number | null;
  throughputFps: number | null;
  captureFps: number | null;
  encodeFps: number | null;
  etaSeconds: number | null;
}

export interface RuntimeTelemetrySnapshot {
  sampledAtIso: string;
  sampledAtMs: number;
  pollIntervalMs: number;
  memoryStatus: "available" | "N/A";
  totalWorkingSetMB: number | null;
  peakWorkingSetMB: number | null;
  processCount: number;
  includedProcessTypes: string[];
  aggregationMethod: string;
  externalProcessesNote: string;
  processes: ProcessMetricTelemetryItem[];
  queue: {
    activeCount: number;
    queuedCount: number;
    activeJobId: string | null;
  };
  activeRender: ActiveRenderTelemetrySnapshot | null;
}

export function formatTelemetryMetric(val: number | null | undefined, unit = ""): string {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    return "N/A";
  }
  return unit ? `${val}${unit}` : String(val);
}
