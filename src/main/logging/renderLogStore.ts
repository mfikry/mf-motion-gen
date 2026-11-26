import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  FpsFraction,
  PreflightResult,
  RenderFormat,
  RenderJobLogSummary,
  RenderLifecycleEventName,
  RenderLogEntry,
  RenderLogLevel,
  RenderQueueItemStatus,
  RenderThroughputMetrics,
} from "../../shared/renderContracts.js";
import {
  sanitizeExportFileToken,
  sanitizeLogString,
  sanitizeLogValue,
} from "./logSanitizer.js";

/**
 * Explicit bounded memory & retention limits for structured render logs.
 * NOTE: When a job exceeds DEFAULT_MAX_LOG_ENTRIES_PER_JOB, older low-priority progress
 * entries are evicted first (`truncated: true`) while preserving failure, cancellation,
 * watchdog, and final summary events.
 */
export const DEFAULT_MAX_LOG_ENTRIES_PER_JOB = 200;
export const DEFAULT_MAX_RETAINED_JOB_LOGS = 50;
export const DEFAULT_MAX_STDERR_CHARS = 4000;

const CRITICAL_EVENTS = new Set<RenderLifecycleEventName>([
  "job_created",
  "job_enqueued",
  "job_started",
  "job_completed",
  "job_failed",
  "job_cancelled",
  "job_rejected_preflight",
  "job_rejected_session",
  "queue_shutdown",
  "cancellation_requested",
  "watchdog_timeout",
  "process_tree_cleanup",
  "worker_exit",
  "worker_stderr",
  "final_render_summary",
]);

export interface ThroughputCalculationInput {
  isActive: boolean;
  startedAtMs: number | null;
  nowMs?: number;
  framesRendered: number | null;
  totalFrames: number | null;
  stage: string | null;
  captureStageStartedAtMs?: number | null;
  captureFramesRendered?: number | null;
  encodeStageStartedAtMs?: number | null;
  encodeFramesDone?: number | null;
}

/**
 * Computes actual measured throughput (FPS) and ETA strictly from observed frames and elapsed time.
 * Returns null (displayed as "N/A") whenever frame progress, total frames, or elapsed duration is insufficient,
 * or when job is no longer actively running. Never extrapolates from stage percentage alone.
 */
export function computeRenderThroughputAndEta(input: ThroughputCalculationInput): RenderThroughputMetrics {
  const nowMs = input.nowMs ?? Date.now();
  const elapsedMs =
    input.startedAtMs !== null && Number.isFinite(input.startedAtMs) && nowMs >= input.startedAtMs
      ? nowMs - input.startedAtMs
      : null;

  const frames =
    typeof input.framesRendered === "number" && Number.isFinite(input.framesRendered) && input.framesRendered >= 0
      ? input.framesRendered
      : null;
  const total =
    typeof input.totalFrames === "number" && Number.isFinite(input.totalFrames) && input.totalFrames > 0
      ? input.totalFrames
      : null;

  const elapsedSec = elapsedMs !== null ? elapsedMs / 1000 : null;
  const throughputFps =
    frames !== null && frames > 0 && elapsedSec !== null && elapsedSec >= 0.25
      ? Number((frames / elapsedSec).toFixed(2))
      : null;

  const capElapsedSec =
    input.captureStageStartedAtMs !== undefined &&
    input.captureStageStartedAtMs !== null &&
    nowMs >= input.captureStageStartedAtMs
      ? (nowMs - input.captureStageStartedAtMs) / 1000
      : null;
  const capFrames =
    typeof input.captureFramesRendered === "number" &&
    Number.isFinite(input.captureFramesRendered) &&
    input.captureFramesRendered > 0
      ? input.captureFramesRendered
      : null;
  const captureFps =
    capFrames !== null && capElapsedSec !== null && capElapsedSec >= 0.25
      ? Number((capFrames / capElapsedSec).toFixed(2))
      : null;

  const encElapsedSec =
    input.encodeStageStartedAtMs !== undefined &&
    input.encodeStageStartedAtMs !== null &&
    nowMs >= input.encodeStageStartedAtMs
      ? (nowMs - input.encodeStageStartedAtMs) / 1000
      : null;
  const encFrames =
    typeof input.encodeFramesDone === "number" &&
    Number.isFinite(input.encodeFramesDone) &&
    input.encodeFramesDone > 0
      ? input.encodeFramesDone
      : null;
  const encodeFps =
    encFrames !== null && encElapsedSec !== null && encElapsedSec >= 0.25
      ? Number((encFrames / encElapsedSec).toFixed(2))
      : null;

  let etaSeconds: number | null = null;
  let isEstimateValid = false;
  let unavailableReason: string | null = null;

  if (!input.isActive) {
    unavailableReason = "Render job is not active";
  } else if (total === null) {
    unavailableReason = "Total frame count unknown";
  } else if (frames === null || frames <= 0) {
    unavailableReason = "Insufficient frame progress for throughput/ETA";
  } else if (frames >= total) {
    etaSeconds = 0;
    isEstimateValid = true;
  } else if (throughputFps === null || throughputFps <= 0) {
    unavailableReason = "Elapsed measurement window too short";
  } else {
    etaSeconds = Number(((total - frames) / throughputFps).toFixed(1));
    isEstimateValid = true;
  }

  return {
    throughputFps,
    captureFps,
    encodeFps,
    etaSeconds,
    framesRendered: frames,
    totalFrames: total,
    elapsedMs,
    isEstimateValid,
    unavailableReason,
  };
}

interface InternalJobLogRecord {
  summary: RenderJobLogSummary;
  startedAtMs: number | null;
  lastLoggedStage: string | null;
  lastProgressLogFrame: number;
  lastStderrHash: string | null;
  captureStageStartedAtMs: number | null;
  captureFramesRendered: number | null;
  encodeStageStartedAtMs: number | null;
  encodeFramesDone: number | null;
}

export interface RenderLogStoreOptions {
  maxEntriesPerJob?: number;
  maxRetainedJobs?: number;
  maxStderrChars?: number;
  onLogUpdated?: (jobId: string, entry: RenderLogEntry) => void;
}

/**
 * Main-process bounded ring-buffer store for structured per-job render diagnostics.
 * Automatically sanitizes strings/metadata on ingest and export.
 */
export class RenderLogStore {
  readonly maxEntriesPerJob: number;
  readonly maxRetainedJobs: number;
  readonly maxStderrChars: number;
  private readonly onLogUpdated?: (jobId: string, entry: RenderLogEntry) => void;

  private readonly jobs = new Map<string, InternalJobLogRecord>();
  private readonly insertionOrder: string[] = [];

  constructor(options: RenderLogStoreOptions = {}) {
    this.maxEntriesPerJob = Math.max(10, options.maxEntriesPerJob ?? DEFAULT_MAX_LOG_ENTRIES_PER_JOB);
    this.maxRetainedJobs = Math.max(2, options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOB_LOGS);
    this.maxStderrChars = Math.max(256, options.maxStderrChars ?? DEFAULT_MAX_STDERR_CHARS);
    this.onLogUpdated = options.onLogUpdated;
  }

  getRetainedJobCount(): number {
    return this.jobs.size;
  }

  ensureJob(params: {
    jobId: string;
    sessionId: string | null;
    title: string;
    format: RenderFormat;
    fps: FpsFraction;
  }): void {
    if (this.jobs.has(params.jobId)) return;

    while (this.jobs.size >= this.maxRetainedJobs && this.insertionOrder.length > 0) {
      // Evict oldest terminal job first; if none terminal, evict oldest
      const evictIdx = this.insertionOrder.findIndex((id) => {
        const rec = this.jobs.get(id);
        return rec && rec.summary.status !== "rendering" && rec.summary.status !== "queued";
      });
      const idx = evictIdx !== -1 ? evictIdx : 0;
      const [evictedId] = this.insertionOrder.splice(idx, 1);
      if (evictedId) this.jobs.delete(evictedId);
    }

    const nowIso = new Date().toISOString();
    const record: InternalJobLogRecord = {
      summary: {
        jobId: params.jobId,
        sessionId: params.sessionId,
        title: sanitizeLogString(params.title, 200),
        status: "queued",
        format: params.format,
        fps: { ...params.fps },
        createdAt: nowIso,
        startedAt: null,
        finishedAt: null,
        preflightSummary: null,
        stageHistory: [],
        workerPid: null,
        workerExitCode: null,
        workerStderrStatus: "unavailable",
        workerStderr: null,
        ffmpegStderrStatus: "unavailable",
        ffmpegStderr: null,
        failureReason: null,
        cancellationReason: null,
        watchdogReason: null,
        cleanupActionCount: 0,
        survivingOrphans: null,
        finalMetrics: {
          wallMs: null,
          framesRendered: null,
          totalFrames: null,
          throughputFps: null,
          captureFps: null,
          encodeFps: null,
        },
        truncated: false,
        droppedEntryCount: 0,
        maxEntriesPerJob: this.maxEntriesPerJob,
        entries: [],
      },
      startedAtMs: null,
      lastLoggedStage: null,
      lastProgressLogFrame: -1,
      lastStderrHash: null,
      captureStageStartedAtMs: null,
      captureFramesRendered: null,
      encodeStageStartedAtMs: null,
      encodeFramesDone: null,
    };

    this.jobs.set(params.jobId, record);
    this.insertionOrder.push(params.jobId);
  }

  private pushEntry(
    rec: InternalJobLogRecord,
    params: {
      level: RenderLogLevel;
      event: RenderLifecycleEventName;
      stage?: string | null;
      message: string;
      metadata?: Record<string, unknown>;
      timestampMs?: number;
    }
  ): RenderLogEntry {
    const tsMs = params.timestampMs ?? Date.now();
    const entry: RenderLogEntry = {
      timestamp: new Date(tsMs).toISOString(),
      timestampMs: tsMs,
      jobId: rec.summary.jobId,
      sessionId: rec.summary.sessionId,
      level: params.level,
      event: params.event,
      stage: params.stage ?? null,
      message: sanitizeLogString(params.message),
      metadata: params.metadata
        ? (sanitizeLogValue(params.metadata) as Record<string, unknown>)
        : undefined,
    };

    const entries = rec.summary.entries;
    if (entries.length >= this.maxEntriesPerJob) {
      // Evict oldest non-critical entry first to retain diagnostic errors/cancels/summaries
      const evictIdx = entries.findIndex(
        (e) => e.level !== "error" && e.level !== "warning" && !CRITICAL_EVENTS.has(e.event)
      );
      entries.splice(evictIdx !== -1 ? evictIdx : 0, 1);
      rec.summary.truncated = true;
      rec.summary.droppedEntryCount += 1;
    }

    entries.push(entry);
    this.onLogUpdated?.(rec.summary.jobId, { ...entry });
    return entry;
  }

  appendEvent(
    jobId: string,
    params: {
      level: RenderLogLevel;
      event: RenderLifecycleEventName;
      stage?: string | null;
      message: string;
      metadata?: Record<string, unknown>;
      timestampMs?: number;
    }
  ): RenderLogEntry | null {
    const rec = this.jobs.get(jobId);
    if (!rec) return null;
    return this.pushEntry(rec, params);
  }

  updateStatus(jobId: string, status: RenderQueueItemStatus): void {
    const rec = this.jobs.get(jobId);
    if (!rec) return;
    rec.summary.status = status;
    const nowMs = Date.now();
    if (status === "rendering" && rec.startedAtMs === null) {
      rec.startedAtMs = nowMs;
      rec.summary.startedAt = new Date(nowMs).toISOString();
    } else if (status === "complete" || status === "cancelled" || status === "failed") {
      rec.summary.finishedAt = new Date(nowMs).toISOString();
    }
  }

  recordPreflight(jobId: string, preflight: PreflightResult): void {
    const rec = this.jobs.get(jobId);
    if (!rec) return;
    rec.summary.preflightSummary = {
      ok: preflight.ok,
      blockerCodes: preflight.blockers.map((b) => b.code),
      warningCodes: preflight.warnings.map((w) => w.code),
      checkedAssetCount: preflight.checkedLocalAssets.length,
      elapsedMs: typeof preflight.elapsedMs === "number" ? preflight.elapsedMs : null,
    };
    this.pushEntry(rec, {
      level: preflight.ok ? "info" : "error",
      event: preflight.ok ? "preflight_validation" : "job_rejected_preflight",
      stage: "preflight",
      message: preflight.ok
        ? `Preflight validation passed (${preflight.checkedLocalAssets.length} local assets, ${preflight.warnings.length} warnings)`
        : `Preflight rejected composition: ${preflight.blockers.map((b) => b.code).join(", ")}`,
      metadata: rec.summary.preflightSummary,
    });
  }

  recordStageAndProgress(params: {
    jobId: string;
    stageCode: string | null;
    currentStage: string;
    framesRendered: number;
    totalFrames: number | null;
    stageDone: number | null;
    stageTotal: number | null;
    timestampMs: number;
  }): RenderThroughputMetrics | null {
    const rec = this.jobs.get(params.jobId);
    if (!rec) return null;
    const stage = params.stageCode || params.currentStage || null;
    const elapsedSinceStart =
      rec.startedAtMs !== null ? Math.max(0, params.timestampMs - rec.startedAtMs) : 0;

    if (stage && stage !== rec.lastLoggedStage) {
      rec.lastLoggedStage = stage;
      rec.summary.stageHistory.push({
        stage,
        timestamp: new Date(params.timestampMs).toISOString(),
        elapsedMs: elapsedSinceStart,
      });
      if (stage === "capture" && rec.captureStageStartedAtMs === null) {
        rec.captureStageStartedAtMs = params.timestampMs;
      }
      if ((stage === "encode" || stage === "assemble") && rec.encodeStageStartedAtMs === null) {
        rec.encodeStageStartedAtMs = params.timestampMs;
      }
      this.pushEntry(rec, {
        level: "info",
        event: "stage_transition",
        stage,
        message: `Entered render stage "${stage}"`,
        timestampMs: params.timestampMs,
      });
    }

    if (stage === "capture" && params.framesRendered > 0) {
      rec.captureFramesRendered = params.framesRendered;
    } else if (stage === "encode" && typeof params.stageDone === "number" && params.stageDone > 0) {
      rec.encodeFramesDone = params.stageDone;
    }

    // Log meaningful progress checkpoints without flooding ring buffer
    const shouldLogProgress =
      params.framesRendered > 0 &&
      (rec.lastProgressLogFrame === -1 ||
        params.framesRendered - rec.lastProgressLogFrame >= 10 ||
        (params.totalFrames !== null && params.framesRendered === params.totalFrames));

    if (shouldLogProgress) {
      rec.lastProgressLogFrame = params.framesRendered;
      const evName: RenderLifecycleEventName =
        stage === "encode" || stage === "assemble" ? "encoding_progress" : "capture_progress";
      this.pushEntry(rec, {
        level: "debug",
        event: evName,
        stage,
        message:
          params.totalFrames !== null
            ? `Progress (${stage ?? "render"}): ${params.framesRendered}/${params.totalFrames} frames`
            : `Progress (${stage ?? "render"}): ${params.framesRendered} frames`,
        metadata: {
          framesRendered: params.framesRendered,
          totalFrames: params.totalFrames,
          stageDone: params.stageDone,
          stageTotal: params.stageTotal,
        },
        timestampMs: params.timestampMs,
      });
    }

    return computeRenderThroughputAndEta({
      isActive: rec.summary.status === "rendering",
      startedAtMs: rec.startedAtMs,
      nowMs: params.timestampMs,
      framesRendered: params.framesRendered,
      totalFrames: params.totalFrames,
      stage,
      captureStageStartedAtMs: rec.captureStageStartedAtMs,
      captureFramesRendered: rec.captureFramesRendered,
      encodeStageStartedAtMs: rec.encodeStageStartedAtMs,
      encodeFramesDone: rec.encodeFramesDone,
    });
  }

  recordWorkerDiagnostics(params: {
    jobId: string;
    workerPid: number | null;
    workerExitCode: number | null;
    stderrTail: string | null;
    ffmpegStderrTail: string | null;
    failureReason: string | null;
    cancellationReason: string | null;
    watchdogReason: string | null;
    cleanupActionCount: number;
    survivingOrphans: number | null;
    wallMs: number | null;
    framesRendered: number | null;
    totalFrames: number | null;
  }): void {
    const rec = this.jobs.get(params.jobId);
    if (!rec) return;

    rec.summary.workerPid = params.workerPid;
    rec.summary.workerExitCode = params.workerExitCode;

    if (params.stderrTail && params.stderrTail.trim().length > 0) {
      const sanitizedStderr = sanitizeLogString(params.stderrTail, this.maxStderrChars);
      rec.summary.workerStderrStatus = "captured";
      rec.summary.workerStderr = sanitizedStderr;
      const hash = crypto.createHash("sha256").update(sanitizedStderr).digest("hex");
      if (hash !== rec.lastStderrHash) {
        rec.lastStderrHash = hash;
        this.pushEntry(rec, {
          level: "warning",
          event: "worker_stderr",
          stage: rec.lastLoggedStage,
          message: `Worker stderr captured (${sanitizedStderr.length} chars)`,
          metadata: { stderrTail: sanitizedStderr },
        });
      }
    } else {
      rec.summary.workerStderrStatus = "unavailable";
      rec.summary.workerStderr = null;
    }

    if (params.ffmpegStderrTail && params.ffmpegStderrTail.trim().length > 0) {
      rec.summary.ffmpegStderrStatus = "captured";
      rec.summary.ffmpegStderr = sanitizeLogString(params.ffmpegStderrTail, this.maxStderrChars);
    } else {
      rec.summary.ffmpegStderrStatus = "unavailable";
      rec.summary.ffmpegStderr = null;
    }

    if (params.failureReason) rec.summary.failureReason = sanitizeLogString(params.failureReason);
    if (params.cancellationReason) rec.summary.cancellationReason = sanitizeLogString(params.cancellationReason);
    if (params.watchdogReason) rec.summary.watchdogReason = sanitizeLogString(params.watchdogReason);
    rec.summary.cleanupActionCount = params.cleanupActionCount;
    rec.summary.survivingOrphans = params.survivingOrphans;

    const nowMs = Date.now();
    const computed = computeRenderThroughputAndEta({
      isActive: false,
      startedAtMs:
        params.wallMs !== null && params.wallMs >= 0
          ? nowMs - params.wallMs
          : rec.startedAtMs,
      nowMs,
      framesRendered: params.framesRendered,
      totalFrames: params.totalFrames,
      stage: rec.lastLoggedStage,
      captureStageStartedAtMs: rec.captureStageStartedAtMs,
      captureFramesRendered: rec.captureFramesRendered,
      encodeStageStartedAtMs: rec.encodeStageStartedAtMs,
      encodeFramesDone: rec.encodeFramesDone,
    });

    rec.summary.finalMetrics = {
      wallMs: params.wallMs,
      framesRendered: params.framesRendered,
      totalFrames: params.totalFrames,
      throughputFps: computed.throughputFps,
      captureFps: computed.captureFps,
      encodeFps: computed.encodeFps,
    };

    if (params.workerExitCode !== null) {
      this.pushEntry(rec, {
        level: params.workerExitCode === 0 ? "info" : "error",
        event: "worker_exit",
        stage: rec.lastLoggedStage,
        message: `Worker process exited with code ${params.workerExitCode}`,
        metadata: { workerPid: params.workerPid, workerExitCode: params.workerExitCode },
      });
    }

    if (params.watchdogReason) {
      this.pushEntry(rec, {
        level: "error",
        event: "watchdog_timeout",
        stage: rec.lastLoggedStage,
        message: params.watchdogReason,
      });
    }

    if (params.cleanupActionCount > 0 || (params.survivingOrphans ?? 0) > 0) {
      this.pushEntry(rec, {
        level: (params.survivingOrphans ?? 0) > 0 ? "error" : "info",
        event: "process_tree_cleanup",
        stage: rec.lastLoggedStage,
        message: `Process-tree cleanup executed (${params.cleanupActionCount} actions, ${params.survivingOrphans ?? 0} surviving orphans)`,
      });
    }
  }

  getActiveThroughput(jobId: string, currentFrames: number | null, totalFrames: number | null): RenderThroughputMetrics | null {
    const rec = this.jobs.get(jobId);
    if (!rec) return null;
    return computeRenderThroughputAndEta({
      isActive: rec.summary.status === "rendering",
      startedAtMs: rec.startedAtMs,
      framesRendered: currentFrames,
      totalFrames,
      stage: rec.lastLoggedStage,
      captureStageStartedAtMs: rec.captureStageStartedAtMs,
      captureFramesRendered: rec.captureFramesRendered,
      encodeStageStartedAtMs: rec.encodeStageStartedAtMs,
      encodeFramesDone: rec.encodeFramesDone,
    });
  }

  getJobLog(jobId: string): RenderJobLogSummary | null {
    const rec = this.jobs.get(jobId);
    if (!rec) return null;
    const copy = structuredClone(rec.summary);
    return sanitizeLogValue(copy) as RenderJobLogSummary;
  }

  hasJob(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  buildExportPayload(jobId: string): string {
    const summary = this.getJobLog(jobId);
    if (!summary) {
      throw new Error(`No render log available for jobId "${jobId}"`);
    }
    const payload = {
      schemaVersion: "mf-motion-gen-render-log/v1",
      exportedAt: new Date().toISOString(),
      retentionLimits: {
        maxEntriesPerJob: this.maxEntriesPerJob,
        maxRetainedJobs: this.maxRetainedJobs,
        maxStderrChars: this.maxStderrChars,
      },
      jobLog: summary,
    };
    return JSON.stringify(sanitizeLogValue(payload), null, 2);
  }

  suggestExportFilename(jobId: string): string {
    const safeToken = sanitizeExportFileToken(jobId);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `mf-render-log-${safeToken}-${stamp}.json`;
  }
}

/**
 * Writes a sanitized JSON log file atomically via a temporary sibling file + rename,
 * ensuring failed writes leave no corrupt/half-written file at targetPath.
 */
export function writeSanitizedLogFileAtomic(targetPath: string, sanitizedJson: string): void {
  const dir = path.dirname(path.resolve(targetPath));
  fs.mkdirSync(dir, { recursive: true });
  const tmpSibling = path.join(dir, `.tmp-mf-log-${crypto.randomUUID()}.json`);
  try {
    fs.writeFileSync(tmpSibling, sanitizedJson, "utf8");
    fs.renameSync(tmpSibling, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpSibling)) {
        fs.unlinkSync(tmpSibling);
      }
    } catch {
      // Best-effort temp cleanup
    }
    throw err;
  }
}

const VALID_JOB_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function validateRenderJobId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("Invalid IPC field \"jobId\": expected string");
  }
  const trimmed = raw.trim();
  if (!VALID_JOB_ID_RE.test(trimmed)) {
    throw new Error("Invalid IPC field \"jobId\": must contain 1-128 safe identifier characters");
  }
  return trimmed;
}

export async function exportRenderLogWithSaveDialog(options: {
  logStore: RenderLogStore;
  rawJobId: unknown;
  defaultDir: string;
  showSaveDialog: (dialogOptions: {
    title: string;
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ canceled: boolean; filePath?: string }>;
}): Promise<{ canceled: boolean; ok: boolean; exportedFileName?: string; error?: string }> {
  const jobId = validateRenderJobId(options.rawJobId);
  if (!options.logStore.hasJob(jobId)) {
    return { canceled: false, ok: false, error: `No render log available for job "${jobId}"` };
  }

  const defaultPath = path.join(options.defaultDir, options.logStore.suggestExportFilename(jobId));
  const picked = await options.showSaveDialog({
    title: "Export Sanitized Render Diagnostic Log",
    defaultPath,
    filters: [{ name: "JSON Diagnostic Logs (*.json)", extensions: ["json"] }],
  });

  if (picked.canceled || !picked.filePath) {
    return { canceled: true, ok: false };
  }

  try {
    const sanitizedPayload = options.logStore.buildExportPayload(jobId);
    writeSanitizedLogFileAtomic(picked.filePath, sanitizedPayload);
    return {
      canceled: false,
      ok: true,
      exportedFileName: path.basename(picked.filePath),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      canceled: false,
      ok: false,
      error: sanitizeLogString(msg),
    };
  }
}
