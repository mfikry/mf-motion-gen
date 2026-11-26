import fs from "node:fs";
import type {
  ActiveRenderTelemetrySnapshot,
  FpsFraction,
  RenderFormat,
  RenderJobRequest,
  RenderJobResult,
  RenderProgressEvent,
  RenderQueueItemSnapshot,
  RenderQueueSnapshot,
} from "../../shared/renderContracts.js";
import type { RenderLogStore } from "../logging/renderLogStore.js";
import type { CoordinatedRenderHooks, CoordinatedRenderOutcome } from "./renderCoordinator.js";

/**
 * Default maximum number of pending + active render jobs allowed in the queue simultaneously.
 * Chosen to prevent unbounded memory/disk commitments from queued export requests.
 */
export const DEFAULT_MAX_RENDER_QUEUE_CAPACITY = 16;
export const MAX_ALLOWED_RENDER_QUEUE_CAPACITY = 100;
const MAX_QUEUE_HISTORY_ITEMS = 50;

export class RenderQueueError extends Error {
  readonly code:
    | "RENDER_QUEUE_FULL"
    | "SESSION_INVALIDATED"
    | "STALE_SESSION_PATH"
    | "DUPLICATE_JOB_ID";

  constructor(
    code:
      | "RENDER_QUEUE_FULL"
      | "SESSION_INVALIDATED"
      | "STALE_SESSION_PATH"
      | "DUPLICATE_JOB_ID",
    message: string
  ) {
    super(message);
    this.name = "RenderQueueError";
    this.code = code;
  }
}

export interface RenderQueueRunner {
  render(
    request: RenderJobRequest,
    onProgressOrHooks?: ((event: RenderProgressEvent) => void) | CoordinatedRenderHooks
  ): Promise<CoordinatedRenderOutcome>;
  cancel(jobId: string, reason?: string): boolean;
}

export interface RenderQueueManagerOptions {
  runner: RenderQueueRunner;
  logStore?: RenderLogStore;
  maxQueueCapacity?: number;
  isSessionValid?: (sessionId: string, boundStageDir: string) => boolean;
  onQueueChanged?: (snapshot: RenderQueueSnapshot) => void;
  onJobCompleted?: (item: RenderQueueItemSnapshot, result: RenderJobResult) => void;
}

export interface EnqueueRenderJobInput {
  sessionId: string;
  title: string;
  request: RenderJobRequest;
  onProgress?: (event: RenderProgressEvent) => void;
}

interface InternalQueueEntry {
  snapshot: RenderQueueItemSnapshot;
  request: RenderJobRequest;
  onProgress?: (event: RenderProgressEvent) => void;
  resolveCompletion: (result: RenderJobResult) => void;
  completionPromise: Promise<RenderJobResult>;
}

/**
 * Sequential FIFO render queue executing at most ONE active render worker at any time.
 * Binds each queued job to its originating session & canonical working copy directory,
 * supports independent cancellation of queued vs active jobs, and invalidates/cancels
 * session-bound jobs before temporary working copy purge.
 */
export class RenderQueueManager {
  readonly maxQueueCapacity: number;
  private readonly runner: RenderQueueRunner;
  private readonly logStore?: RenderLogStore;
  private readonly isSessionValid?: (sessionId: string, boundStageDir: string) => boolean;
  private readonly onQueueChanged?: (snapshot: RenderQueueSnapshot) => void;
  private readonly onJobCompleted?: (item: RenderQueueItemSnapshot, result: RenderJobResult) => void;

  private readonly pendingQueue: InternalQueueEntry[] = [];
  private readonly history: RenderQueueItemSnapshot[] = [];
  private readonly invalidatedSessions = new Set<string>();

  private activeEntry: InternalQueueEntry | null = null;
  private activeStage: string | null = null;
  private activeFramesRendered: number | null = null;
  private activeTotalFrames: number | null = null;
  private activeExecutionPromise: Promise<void> | null = null;
  private pumpLoopPromise: Promise<void> | null = null;
  private concurrentWorkers = 0;
  private peakConcurrentWorkers = 0;
  private snapshotVersion = 0;

  constructor(options: RenderQueueManagerOptions) {
    const cap = options.maxQueueCapacity ?? DEFAULT_MAX_RENDER_QUEUE_CAPACITY;
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_ALLOWED_RENDER_QUEUE_CAPACITY) {
      throw new Error(
        `Invalid maxQueueCapacity "${cap}": must be an integer between 1 and ${MAX_ALLOWED_RENDER_QUEUE_CAPACITY}`
      );
    }
    this.maxQueueCapacity = cap;
    this.runner = options.runner;
    this.logStore = options.logStore;
    this.isSessionValid = options.isSessionValid;
    this.onQueueChanged = options.onQueueChanged;
    this.onJobCompleted = options.onJobCompleted;
  }

  getActiveRenderTelemetry(): ActiveRenderTelemetrySnapshot | null {
    if (!this.activeEntry) return null;
    const jobId = this.activeEntry.snapshot.jobId;
    const metrics = this.logStore?.getActiveThroughput(
      jobId,
      this.activeFramesRendered,
      this.activeTotalFrames
    );
    const elapsedMs =
      metrics?.elapsedMs ??
      (this.activeEntry.snapshot.startedAtMs !== null
        ? Math.max(0, Date.now() - this.activeEntry.snapshot.startedAtMs)
        : null);
    return {
      jobId,
      stage: this.activeStage,
      framesRendered: this.activeFramesRendered,
      totalFrames: this.activeTotalFrames,
      elapsedMs,
      throughputFps: metrics?.throughputFps ?? null,
      captureFps: metrics?.captureFps ?? null,
      encodeFps: metrics?.encodeFps ?? null,
      etaSeconds: metrics?.etaSeconds ?? null,
    };
  }

  getMaxObservedConcurrency(): number {
    return this.peakConcurrentWorkers;
  }

  getActiveCount(): number {
    return this.activeEntry ? 1 : 0;
  }

  getQueuedCount(): number {
    return this.pendingQueue.length;
  }

  getSnapshot(): RenderQueueSnapshot {
    const items: RenderQueueItemSnapshot[] = [
      ...this.history.map((h) => ({ ...h })),
      ...(this.activeEntry ? [{ ...this.activeEntry.snapshot }] : []),
      ...this.pendingQueue.map((p) => ({ ...p.snapshot })),
    ];
    const counts = {
      queued: this.pendingQueue.length,
      rendering: this.activeEntry ? 1 : 0,
      complete: 0,
      cancelled: 0,
      failed: 0,
    };
    for (const item of this.history) {
      if (item.status === "complete") counts.complete += 1;
      else if (item.status === "cancelled") counts.cancelled += 1;
      else if (item.status === "failed") counts.failed += 1;
    }
    return {
      version: this.snapshotVersion,
      maxCapacity: this.maxQueueCapacity,
      activeCount: counts.rendering,
      queuedCount: counts.queued,
      counts,
      items,
    };
  }

  private emitQueueSnapshot(): void {
    this.snapshotVersion += 1;
    this.onQueueChanged?.(this.getSnapshot());
  }

  private pushHistory(item: RenderQueueItemSnapshot): void {
    this.history.push({ ...item });
    while (this.history.length > MAX_QUEUE_HISTORY_ITEMS) {
      this.history.shift();
    }
  }

  private verifyBoundSessionAndPath(sessionId: string, expectedRealStageDir: string): string | null {
    if (this.invalidatedSessions.has(sessionId)) {
      return `Session "${sessionId}" has already been closed or invalidated`;
    }
    if (!fs.existsSync(expectedRealStageDir)) {
      return `Working copy directory for session "${sessionId}" no longer exists`;
    }
    let currentReal: string;
    try {
      const lstat = fs.lstatSync(expectedRealStageDir);
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
        return `Working copy directory for session "${sessionId}" is not a valid non-symlink directory`;
      }
      currentReal = fs.realpathSync(expectedRealStageDir);
    } catch {
      return `Unable to verify working copy path for session "${sessionId}"`;
    }
    if (currentReal !== expectedRealStageDir) {
      return `Working copy path changed unexpectedly for session "${sessionId}"`;
    }
    if (this.isSessionValid && !this.isSessionValid(sessionId, expectedRealStageDir)) {
      return `Session "${sessionId}" is no longer active or bound to expected working copy`;
    }
    return null;
  }

  enqueue(input: EnqueueRenderJobInput): {
    item: RenderQueueItemSnapshot;
    completion: Promise<RenderJobResult>;
  } {
    if (!input.sessionId) {
      throw new RenderQueueError("SESSION_INVALIDATED", "Render job must be bound to a valid sessionId");
    }
    if (this.invalidatedSessions.has(input.sessionId)) {
      throw new RenderQueueError(
        "SESSION_INVALIDATED",
        `Cannot enqueue job: session "${input.sessionId}" has already been closed or invalidated`
      );
    }

    const activeAndPending = (this.activeEntry ? 1 : 0) + this.pendingQueue.length;
    if (activeAndPending >= this.maxQueueCapacity) {
      throw new RenderQueueError(
        "RENDER_QUEUE_FULL",
        `Render queue is full (${activeAndPending}/${this.maxQueueCapacity} pending/active jobs)`
      );
    }

    const jobId = input.request.jobId;
    if (
      this.activeEntry?.snapshot.jobId === jobId ||
      this.pendingQueue.some((e) => e.snapshot.jobId === jobId)
    ) {
      throw new RenderQueueError("DUPLICATE_JOB_ID", `Job "${jobId}" is already present in queue`);
    }

    let boundStageDir: string;
    try {
      const lstat = fs.lstatSync(input.request.stageDir);
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
        throw new Error("Non-directory or symlink stageDir");
      }
      boundStageDir = fs.realpathSync(input.request.stageDir);
    } catch {
      throw new RenderQueueError(
        "STALE_SESSION_PATH",
        `Cannot enqueue job: invalid or missing session working copy "${input.request.stageDir}"`
      );
    }

    const bindError = this.verifyBoundSessionAndPath(input.sessionId, boundStageDir);
    if (bindError) {
      throw new RenderQueueError("STALE_SESSION_PATH", bindError);
    }

    let resolveCompletion!: (res: RenderJobResult) => void;
    const completionPromise = new Promise<RenderJobResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const format: RenderFormat = input.request.format ?? "mp4";
    const fps: FpsFraction = input.request.fps ?? { num: 30, den: 1 };

    const snapshot: RenderQueueItemSnapshot = {
      jobId,
      sessionId: input.sessionId,
      title: input.title,
      format,
      fps,
      outputPath: input.request.outputPath,
      boundStageDir,
      status: "queued",
      enqueuedAtMs: Date.now(),
      startedAtMs: null,
      finishedAtMs: null,
    };

    const frozenRequest: RenderJobRequest = {
      ...input.request,
      stageDir: boundStageDir,
    };

    const entry: InternalQueueEntry = {
      snapshot,
      request: frozenRequest,
      onProgress: input.onProgress,
      resolveCompletion,
      completionPromise,
    };

    this.logStore?.ensureJob({
      jobId,
      sessionId: input.sessionId,
      title: input.title,
      format,
      fps,
    });
    this.logStore?.appendEvent(jobId, {
      level: "info",
      event: "job_created",
      message: `Render job created (format=${format}, fps=${fps.num}/${fps.den}, quality=${input.request.quality ?? "standard"})`,
      metadata: {
        format,
        fps: `${fps.num}/${fps.den}`,
        quality: input.request.quality ?? "standard",
      },
    });
    this.logStore?.appendEvent(jobId, {
      level: "info",
      event: "job_enqueued",
      message: `Job queued at position ${this.pendingQueue.length + 1} (active=${this.activeEntry ? 1 : 0})`,
    });

    this.pendingQueue.push(entry);
    this.emitQueueSnapshot();
    this.ensurePumpStarted();

    return {
      item: { ...snapshot },
      completion: completionPromise,
    };
  }

  private ensurePumpStarted(): void {
    if (this.pumpLoopPromise) return;
    this.pumpLoopPromise = this.pump().finally(() => {
      this.pumpLoopPromise = null;
      if (this.pendingQueue.length > 0 && !this.activeEntry) {
        this.ensurePumpStarted();
      }
    });
  }

  private settleEntry(
    entry: InternalQueueEntry,
    status: "complete" | "cancelled" | "failed",
    result: RenderJobResult,
    cancelReason?: string
  ): void {
    entry.snapshot.status = status;
    entry.snapshot.finishedAtMs = Date.now();
    entry.snapshot.cancelReason = cancelReason;
    entry.snapshot.errorMessage = result.errorMessage;
    entry.snapshot.result = result;
    this.logStore?.updateStatus(entry.snapshot.jobId, status);
    this.pushHistory(entry.snapshot);
    this.onJobCompleted?.({ ...entry.snapshot }, result);
    entry.resolveCompletion(result);
  }

  private async pump(): Promise<void> {
    while (this.pendingQueue.length > 0) {
      const next = this.pendingQueue.shift()!;

      const staleReason = this.verifyBoundSessionAndPath(
        next.snapshot.sessionId,
        next.snapshot.boundStageDir
      );
      if (staleReason) {
        const result: RenderJobResult = {
          jobId: next.snapshot.jobId,
          status: "cancelled",
          outcome: "cancelled",
          outputPath: next.request.outputPath,
          wallMs: 0,
          framesRendered: null,
          totalFrames: null,
          warnings: [],
          errorName: "SessionInvalidatedError",
          errorReason: "session_invalidated",
          errorMessage: staleReason,
        };
        this.logStore?.appendEvent(next.snapshot.jobId, {
          level: "warning",
          event: "job_rejected_session",
          message: staleReason,
        });
        this.logStore?.appendEvent(next.snapshot.jobId, {
          level: "warning",
          event: "final_render_summary",
          message: `Job aborted before start due to invalid/stale session`,
          metadata: { status: "cancelled", reason: "session_invalidated" },
        });
        this.settleEntry(next, "cancelled", result, "session_invalidated");
        this.emitQueueSnapshot();
        continue;
      }

      if (this.concurrentWorkers !== 0) {
        throw new Error("Queue concurrency invariant violated: worker already running");
      }

      next.snapshot.status = "rendering";
      next.snapshot.startedAtMs = Date.now();
      this.activeEntry = next;
      this.activeStage = "starting";
      this.activeFramesRendered = null;
      this.activeTotalFrames = null;
      this.logStore?.updateStatus(next.snapshot.jobId, "rendering");
      this.logStore?.appendEvent(next.snapshot.jobId, {
        level: "info",
        event: "job_started",
        stage: "starting",
        message: `Execution started for job "${next.snapshot.jobId}"`,
      });
      this.emitQueueSnapshot();

      const runOne = async (): Promise<void> => {
        this.concurrentWorkers += 1;
        this.peakConcurrentWorkers = Math.max(this.peakConcurrentWorkers, this.concurrentWorkers);
        try {
          const hooks: CoordinatedRenderHooks = {
            onPreflight: (preflight) => {
              this.logStore?.recordPreflight(next.snapshot.jobId, preflight);
            },
            onDiagnostic: (signal) => {
              this.logStore?.appendEvent(signal.jobId, signal);
            },
            onProgress: (ev) => {
              this.activeStage = ev.stageCode || ev.currentStage || this.activeStage;
              this.activeFramesRendered = ev.framesRendered;
              if (ev.totalFrames !== null) this.activeTotalFrames = ev.totalFrames;
              this.logStore?.recordStageAndProgress({
                jobId: ev.jobId,
                stageCode: ev.stageCode,
                currentStage: ev.currentStage,
                framesRendered: ev.framesRendered,
                totalFrames: ev.totalFrames,
                stageDone: ev.stageDone,
                stageTotal: ev.stageTotal,
                timestampMs: ev.timestampMs,
              });
              next.onProgress?.(ev);
            },
          };

          const outcome = await this.runner.render(
            next.request,
            this.logStore ? hooks : next.onProgress
          );
          const exec = outcome.execution;
          const res = exec.result;
          const finalStatus =
            res.status === "complete"
              ? "complete"
              : res.status === "cancelled"
                ? "cancelled"
                : "failed";
          const cancelReason =
            finalStatus === "cancelled" ? (next.snapshot.cancelReason ?? res.errorReason ?? "cancelled") : null;

          this.logStore?.recordWorkerDiagnostics({
            jobId: next.snapshot.jobId,
            workerPid: exec.workerPid ?? null,
            workerExitCode: exec.workerExitCode ?? null,
            stderrTail: exec.stderrTail ?? null,
            ffmpegStderrTail: exec.ffmpegStderrTail ?? null,
            failureReason: finalStatus === "failed" ? (res.errorMessage ?? res.errorName ?? "Render failed") : null,
            cancellationReason: cancelReason,
            watchdogReason: exec.watchdogReason ?? null,
            cleanupActionCount: exec.cleanupActions?.length ?? 0,
            survivingOrphans: exec.survivingOrphans ?? null,
            wallMs: res.wallMs,
            framesRendered: res.framesRendered,
            totalFrames: res.totalFrames,
          });

          const endEvent =
            finalStatus === "complete"
              ? "job_completed"
              : finalStatus === "cancelled"
                ? "job_cancelled"
                : "job_failed";
          this.logStore?.appendEvent(next.snapshot.jobId, {
            level: finalStatus === "complete" ? "info" : finalStatus === "cancelled" ? "warning" : "error",
            event: endEvent,
            stage: this.activeStage,
            message:
              finalStatus === "complete"
                ? `Render completed cleanly (${res.framesRendered ?? "?"} frames in ${res.wallMs}ms)`
                : res.errorMessage ?? `Render ended with status "${finalStatus}"`,
            metadata: {
              status: finalStatus,
              outcome: res.outcome,
              errorName: res.errorName ?? null,
              errorReason: res.errorReason ?? null,
              warningCount: res.warnings.length,
            },
          });
          this.logStore?.appendEvent(next.snapshot.jobId, {
            level: finalStatus === "failed" ? "error" : "info",
            event: "final_render_summary",
            stage: this.activeStage,
            message: `Final summary: status=${finalStatus}, frames=${res.framesRendered ?? "N/A"}/${res.totalFrames ?? "N/A"}, wallMs=${res.wallMs}`,
            metadata: {
              status: finalStatus,
              wallMs: res.wallMs,
              framesRendered: res.framesRendered,
              totalFrames: res.totalFrames,
              workerPid: exec.workerPid ?? null,
              survivingOrphans: exec.survivingOrphans ?? null,
            },
          });

          this.settleEntry(next, finalStatus, res, cancelReason ?? undefined);
        } catch (err: unknown) {
          const e = err instanceof Error ? err : new Error(String(err));
          const isCancelled = e.name === "RenderCancelledError";
          const wallMs = next.snapshot.startedAtMs ? Date.now() - next.snapshot.startedAtMs : 0;
          const res: RenderJobResult = {
            jobId: next.snapshot.jobId,
            status: isCancelled ? "cancelled" : "failed",
            outcome: isCancelled ? "cancelled" : "failed",
            outputPath: next.request.outputPath,
            wallMs,
            framesRendered: null,
            totalFrames: null,
            warnings: [],
            errorName: e.name,
            errorReason: isCancelled ? next.snapshot.cancelReason ?? "aborted" : undefined,
            errorMessage: e.message,
          };

          this.logStore?.recordWorkerDiagnostics({
            jobId: next.snapshot.jobId,
            workerPid: null,
            workerExitCode: null,
            stderrTail: null,
            ffmpegStderrTail: null,
            failureReason: isCancelled ? null : `${e.name}: ${e.message}`,
            cancellationReason: isCancelled ? (next.snapshot.cancelReason ?? "aborted") : null,
            watchdogReason: null,
            cleanupActionCount: 0,
            survivingOrphans: null,
            wallMs,
            framesRendered: null,
            totalFrames: null,
          });
          this.logStore?.appendEvent(next.snapshot.jobId, {
            level: isCancelled ? "warning" : "error",
            event: isCancelled ? "job_cancelled" : "job_failed",
            stage: this.activeStage,
            message: e.message,
            metadata: { errorName: e.name },
          });
          this.logStore?.appendEvent(next.snapshot.jobId, {
            level: isCancelled ? "warning" : "error",
            event: "final_render_summary",
            stage: this.activeStage,
            message: `Final summary: status=${res.status}, error=${e.name}`,
          });

          this.settleEntry(next, isCancelled ? "cancelled" : "failed", res, next.snapshot.cancelReason);
        } finally {
          this.concurrentWorkers = Math.max(0, this.concurrentWorkers - 1);
          this.activeEntry = null;
          this.activeStage = null;
          this.activeFramesRendered = null;
          this.activeTotalFrames = null;
          this.activeExecutionPromise = null;
          this.emitQueueSnapshot();
        }
      };

      this.activeExecutionPromise = runOne();
      await this.activeExecutionPromise;
    }
  }

  /**
   * Cancels either a queued job (immediately without disturbing the active worker)
   * or the active rendering job (triggering RenderCoordinator cancellation + process cleanup).
   */
  cancel(jobId: string, reason = "user_cancelled"): { cancelled: boolean; wasActive: boolean } {
    const queuedIdx = this.pendingQueue.findIndex((e) => e.snapshot.jobId === jobId);
    if (queuedIdx !== -1) {
      const [removed] = this.pendingQueue.splice(queuedIdx, 1);
      const res: RenderJobResult = {
        jobId,
        status: "cancelled",
        outcome: "cancelled",
        outputPath: removed.request.outputPath,
        wallMs: 0,
        framesRendered: null,
        totalFrames: null,
        warnings: [],
        errorName: "RenderCancelledError",
        errorReason: reason,
        errorMessage: `Queued render job cancelled (${reason})`,
      };
      this.logStore?.appendEvent(jobId, {
        level: "warning",
        event: "cancellation_requested",
        message: `Queued job cancellation requested (${reason})`,
      });
      this.logStore?.recordWorkerDiagnostics({
        jobId,
        workerPid: null,
        workerExitCode: null,
        stderrTail: null,
        ffmpegStderrTail: null,
        failureReason: null,
        cancellationReason: reason,
        watchdogReason: null,
        cleanupActionCount: 0,
        survivingOrphans: null,
        wallMs: 0,
        framesRendered: null,
        totalFrames: null,
      });
      this.logStore?.appendEvent(jobId, {
        level: "warning",
        event: "job_cancelled",
        message: `Queued render job cancelled (${reason})`,
      });
      this.logStore?.appendEvent(jobId, {
        level: "info",
        event: "final_render_summary",
        message: `Final summary: status=cancelled (never started, reason=${reason})`,
      });
      this.settleEntry(removed, "cancelled", res, reason);
      this.emitQueueSnapshot();
      return { cancelled: true, wasActive: false };
    }

    if (this.activeEntry && this.activeEntry.snapshot.jobId === jobId) {
      this.activeEntry.snapshot.cancelReason = reason;
      this.logStore?.appendEvent(jobId, {
        level: "warning",
        event: "cancellation_requested",
        stage: this.activeStage,
        message: `Active render cancellation requested (${reason})`,
      });
      const sent = this.runner.cancel(jobId, reason);
      return { cancelled: sent, wasActive: true };
    }

    return { cancelled: false, wasActive: false };
  }

  clearFinished(): number {
    const count = this.history.length;
    this.history.length = 0;
    if (count > 0) {
      this.emitQueueSnapshot();
    }
    return count;
  }

  /**
   * Invalidates a session BEFORE its isolated temporary working copy is purged:
   * - permanently blocks new enqueues for sessionId;
   * - immediately cancels all queued jobs bound to sessionId;
   * - cancels the active rendering job if it belongs to sessionId and awaits full worker teardown.
   */
  async invalidateSession(sessionId: string, reason = "session_closed"): Promise<void> {
    this.invalidatedSessions.add(sessionId);

    for (let i = this.pendingQueue.length - 1; i >= 0; i -= 1) {
      const entry = this.pendingQueue[i];
      if (entry.snapshot.sessionId === sessionId) {
        this.pendingQueue.splice(i, 1);
        const res: RenderJobResult = {
          jobId: entry.snapshot.jobId,
          status: "cancelled",
          outcome: "cancelled",
          outputPath: entry.request.outputPath,
          wallMs: 0,
          framesRendered: null,
          totalFrames: null,
          warnings: [],
          errorName: "SessionInvalidatedError",
          errorReason: reason,
          errorMessage: `Cancelled queued job because session "${sessionId}" was closed or replaced`,
        };
        this.logStore?.appendEvent(entry.snapshot.jobId, {
          level: "warning",
          event: "job_rejected_session",
          message: res.errorMessage ?? reason,
        });
        this.logStore?.recordWorkerDiagnostics({
          jobId: entry.snapshot.jobId,
          workerPid: null,
          workerExitCode: null,
          stderrTail: null,
          ffmpegStderrTail: null,
          failureReason: null,
          cancellationReason: reason,
          watchdogReason: null,
          cleanupActionCount: 0,
          survivingOrphans: null,
          wallMs: 0,
          framesRendered: null,
          totalFrames: null,
        });
        this.logStore?.appendEvent(entry.snapshot.jobId, {
          level: "warning",
          event: "final_render_summary",
          message: `Final summary: status=cancelled (session invalidated: ${reason})`,
        });
        this.settleEntry(entry, "cancelled", res, reason);
      }
    }

    if (this.activeEntry && this.activeEntry.snapshot.sessionId === sessionId) {
      this.activeEntry.snapshot.cancelReason = reason;
      this.logStore?.appendEvent(this.activeEntry.snapshot.jobId, {
        level: "warning",
        event: "cancellation_requested",
        stage: this.activeStage,
        message: `Cancelling active job due to session closure (${reason})`,
      });
      this.runner.cancel(this.activeEntry.snapshot.jobId, reason);
      if (this.activeExecutionPromise) {
        await this.activeExecutionPromise.catch(() => {});
      }
    }

    this.emitQueueSnapshot();
  }

  async shutdown(): Promise<void> {
    for (let i = this.pendingQueue.length - 1; i >= 0; i -= 1) {
      const entry = this.pendingQueue.splice(i, 1)[0];
      this.invalidatedSessions.add(entry.snapshot.sessionId);
      const res: RenderJobResult = {
        jobId: entry.snapshot.jobId,
        status: "cancelled",
        outcome: "cancelled",
        outputPath: entry.request.outputPath,
        wallMs: 0,
        framesRendered: null,
        totalFrames: null,
        warnings: [],
        errorName: "RenderCancelledError",
        errorReason: "queue_shutdown",
        errorMessage: "Cancelled on render queue shutdown",
      };
      this.logStore?.appendEvent(entry.snapshot.jobId, {
        level: "warning",
        event: "queue_shutdown",
        message: "Queued render job cancelled due to queue shutdown",
      });
      this.logStore?.appendEvent(entry.snapshot.jobId, {
        level: "info",
        event: "final_render_summary",
        message: "Final summary: status=cancelled (queue shutdown)",
      });
      this.settleEntry(entry, "cancelled", res, "queue_shutdown");
    }

    if (this.activeEntry) {
      this.invalidatedSessions.add(this.activeEntry.snapshot.sessionId);
      this.logStore?.appendEvent(this.activeEntry.snapshot.jobId, {
        level: "warning",
        event: "queue_shutdown",
        stage: this.activeStage,
        message: "Active render job cancelled due to queue shutdown",
      });
      this.runner.cancel(this.activeEntry.snapshot.jobId, "queue_shutdown");
      if (this.activeExecutionPromise) {
        await this.activeExecutionPromise.catch(() => {});
      }
    }
  }
}
