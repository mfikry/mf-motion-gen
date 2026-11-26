import path from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannelMain, utilityProcess } from "electron";
import type {
  MainToWorkerMessage,
  RenderJobRequest,
  RenderJobResult,
  RenderLifecycleEventName,
  RenderLogLevel,
  RenderProgressEvent,
  RenderStageHistoryEntry,
  WorkerToMainMessage,
} from "../../shared/renderContracts.js";
import {
  findSurvivingMediaProcesses,
  queryMediaAndWorkerProcesses,
  terminateWindowsProcessTree,
  type KillActionRecord,
} from "./windowsProcessTree.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER_ENTRY = path.resolve(__dirname, "..", "..", "worker", "renderWorker.js");

export interface RenderWorkerHostOptions {
  workerEntryPath?: string;
  workerReadyTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  hangTimeoutMs?: number;
  cancelGraceTimeoutMs?: number;
}

export interface WorkerDiagnosticSignal {
  jobId: string;
  level: RenderLogLevel;
  event: RenderLifecycleEventName;
  stage?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerRenderExecution {
  result: RenderJobResult;
  workerPid: number | null;
  trackedChildPids: number[];
  cleanupActions: KillActionRecord[];
  survivingOrphans: number;
  stderrTail: string | null;
  ffmpegStderrTail: string | null;
  workerExitCode: number | null;
  watchdogReason: string | null;
  stageHistory: RenderStageHistoryEntry[];
}

interface PendingJobState {
  request: RenderJobRequest;
  baselinePids: Set<number>;
  trackedChildPids: Set<number>;
  stagePattern: string;
  startedAt: number;
  lastHeartbeatAt: number;
  onProgress?: (event: RenderProgressEvent) => void;
  onDiagnostic?: (signal: WorkerDiagnosticSignal) => void;
  jobStderrTail: string;
  workerExitCode: number | null;
  watchdogReason: string | null;
  stageHistory: RenderStageHistoryEntry[];
  lastStage: string | null;
  cleanupActions: KillActionRecord[];
  settled: boolean;
  cancelTimer: NodeJS.Timeout | null;
  resolve: (value: WorkerRenderExecution) => void;
}

function extractFfmpegStderrTail(stderrTail: string, errorMessage?: string): string | null {
  const combined = [stderrTail, errorMessage ?? ""].filter(Boolean).join("\n");
  if (!combined.trim()) return null;
  const matched = combined
    .split(/\r?\n/)
    .filter((line) => /\b(?:ffmpeg|libx264|prores|avfilter|encoder|muxer)\b|pipe:0/i.test(line));
  if (matched.length === 0) return null;
  return matched.join("\n").slice(-4000);
}

export class RenderWorkerHost {
  private readonly workerEntryPath: string;
  private readonly workerReadyTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly hangTimeoutMs: number;
  private readonly cancelGraceTimeoutMs: number;

  private child: Electron.UtilityProcess | null = null;
  private port: Electron.MessagePortMain | null = null;
  private workerPid: number | null = null;
  private workerSpawnedInfo: {
    nodeVersion: string;
    electronVersion: string | null;
  } | null = null;
  private stderrTail = "";
  private activeJob: PendingJobState | null = null;
  private preparingJob: { jobId: string; cancelReason: string | null } | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pingSeq = 0;
  private intentionalTerminate = false;

  constructor(options: RenderWorkerHostOptions = {}) {
    this.workerEntryPath = options.workerEntryPath ?? DEFAULT_WORKER_ENTRY;
    this.workerReadyTimeoutMs = options.workerReadyTimeoutMs ?? 15_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 2_000;
    this.hangTimeoutMs = options.hangTimeoutMs ?? 10_000;
    this.cancelGraceTimeoutMs = options.cancelGraceTimeoutMs ?? 4_500;
  }

  get pid(): number | null {
    return this.workerPid;
  }

  get runtimeInfo(): { nodeVersion: string; electronVersion: string | null } | null {
    return this.workerSpawnedInfo;
  }

  get lastStderrTail(): string {
    return this.stderrTail;
  }

  async ensureWorkerReady(): Promise<{ pid: number; nodeVersion: string; electronVersion: string | null }> {
    if (this.child && this.port && this.workerPid !== null && this.workerSpawnedInfo) {
      return { pid: this.workerPid, ...this.workerSpawnedInfo };
    }
    return this.spawnWorker();
  }

  private async spawnWorker(): Promise<{ pid: number; nodeVersion: string; electronVersion: string | null }> {
    this.cleanupWorkerProcessTree();

    const { port1, port2 } = new MessageChannelMain();
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_RUN_AS_NODE;

    this.intentionalTerminate = false;
    this.stderrTail = "";
    this.port = port1;

    const child = utilityProcess.fork(this.workerEntryPath, [], {
      stdio: "pipe",
      env: cleanEnv,
      serviceName: "mf-motion-render-worker",
    });
    this.child = child;

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      if (this.activeJob) {
        this.activeJob.jobStderrTail = (this.activeJob.jobStderrTail + text).slice(-4000);
      }
    });
    child.stdout?.on("data", (_chunk: Buffer) => {
      // Captured passively to avoid pipe backpressure in worker stdout
    });

    const pidPromise = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for utilityProcess spawn")), this.workerReadyTimeoutMs);
      child.once("spawn", () => {
        clearTimeout(timer);
        this.workerPid = child.pid ?? null;
        if (this.workerPid === null) {
          reject(new Error("utilityProcess spawned without OS PID"));
        } else {
          resolve(this.workerPid);
        }
      });
    });

    const readyPromise = new Promise<{ pid: number; nodeVersion: string; electronVersion: string | null }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for worker ready (${this.workerReadyTimeoutMs}ms)`)),
          this.workerReadyTimeoutMs
        );

        port1.on("message", (ev) => {
          const msg = ev.data as WorkerToMainMessage;
          if (msg?.type === "ready") {
            clearTimeout(timer);
            this.workerSpawnedInfo = {
              nodeVersion: msg.nodeVersion,
              electronVersion: msg.electronVersion,
            };
            resolve({ pid: msg.pid, ...this.workerSpawnedInfo });
          }
          this.handleWorkerMessage(msg);
        });
        port1.start();
      }
    );

    child.once("exit", (code) => {
      this.handleUnexpectedOrPostExit(code);
    });

    child.postMessage({ type: "init" }, [port2]);
    await pidPromise;
    return readyPromise;
  }

  private handleWorkerMessage(msg: WorkerToMainMessage): void {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "pong") {
      if (this.activeJob) {
        this.activeJob.lastHeartbeatAt = Date.now();
      }
      return;
    }

    if (msg.type === "childProcessTracked") {
      if (this.activeJob && this.activeJob.request.jobId === msg.jobId) {
        this.activeJob.trackedChildPids.add(msg.childPid);
      }
      return;
    }

    if (msg.type === "progress") {
      if (this.activeJob && this.activeJob.request.jobId === msg.event.jobId) {
        this.activeJob.lastHeartbeatAt = Date.now();
        const stage = msg.event.stageCode || msg.event.currentStage || null;
        if (stage && stage !== this.activeJob.lastStage) {
          this.activeJob.lastStage = stage;
          this.activeJob.stageHistory.push({
            stage,
            timestamp: new Date(msg.event.timestampMs).toISOString(),
            elapsedMs: Math.max(0, msg.event.timestampMs - this.activeJob.startedAt),
          });
        }
        this.activeJob.onProgress?.(msg.event);
      }
      return;
    }

    if (msg.type === "complete" || msg.type === "failed") {
      if (this.activeJob && this.activeJob.request.jobId === msg.result.jobId) {
        this.settleActiveJob(msg.result);
      }
      return;
    }

    if (msg.type === "workerInternalError") {
      const errText = `\n[WorkerInternalError] ${msg.message}\n${msg.stack ?? ""}`;
      this.stderrTail = (this.stderrTail + errText).slice(-4000);
      if (this.activeJob) {
        this.activeJob.jobStderrTail = (this.activeJob.jobStderrTail + errText).slice(-4000);
        this.activeJob.onDiagnostic?.({
          jobId: this.activeJob.request.jobId,
          level: "error",
          event: "worker_stderr",
          stage: this.activeJob.lastStage,
          message: `Worker internal error recorded: ${msg.message}`,
        });
      }
    }
  }

  private handleUnexpectedOrPostExit(exitCode: number): void {
    this.stopHeartbeatMonitor();
    const exitedPid = this.workerPid;
    const job = this.activeJob;
    this.child = null;
    this.port = null;
    this.workerPid = null;
    this.workerSpawnedInfo = null;

    if (job && !job.settled) {
      job.workerExitCode = Number.isFinite(exitCode) ? exitCode : null;
      job.onDiagnostic?.({
        jobId: job.request.jobId,
        level: this.intentionalTerminate ? "info" : "error",
        event: "worker_exit",
        stage: job.lastStage,
        message: `Worker process exited (code=${exitCode})`,
        metadata: { workerPid: exitedPid, workerExitCode: exitCode },
      });
      const cleanupActions = terminateWindowsProcessTree(
        exitedPid,
        job.trackedChildPids,
        job.stagePattern
      );
      job.cleanupActions.push(...cleanupActions);
      this.settleActiveJob({
        jobId: job.request.jobId,
        status: this.intentionalTerminate ? "cancelled" : "failed",
        outcome: this.intentionalTerminate ? "cancelled" : "failed",
        outputPath: job.request.outputPath,
        wallMs: Date.now() - job.startedAt,
        framesRendered: null,
        totalFrames: null,
        warnings: [],
        errorName: this.intentionalTerminate ? "WorkerTerminatedError" : "WorkerCrashedError",
        errorMessage: `Render worker exited unexpectedly (code=${exitCode})`,
      });
    }
  }

  private startHeartbeatMonitor(): void {
    this.stopHeartbeatMonitor();
    this.heartbeatTimer = setInterval(() => {
      const job = this.activeJob;
      if (!job || job.settled || !this.port) return;

      const silentMs = Date.now() - job.lastHeartbeatAt;
      if (silentMs > this.hangTimeoutMs) {
        this.forceTerminateForWatchdog(
          job.request.jobId,
          `Worker unresponsive to heartbeat ping for ${silentMs}ms (limit ${this.hangTimeoutMs}ms)`
        );
        return;
      }

      this.pingSeq += 1;
      const pingMsg: MainToWorkerMessage = {
        type: "ping",
        seq: this.pingSeq,
        sentAtMs: Date.now(),
      };
      this.port.postMessage(pingMsg);
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private forceTerminateForWatchdog(jobId: string, reasonMessage: string): void {
    const job = this.activeJob;
    if (!job || job.settled || job.request.jobId !== jobId) return;

    this.intentionalTerminate = true;
    this.stopHeartbeatMonitor();
    job.watchdogReason = reasonMessage;
    job.onDiagnostic?.({
      jobId,
      level: "error",
      event: "watchdog_timeout",
      stage: job.lastStage,
      message: reasonMessage,
    });
    const pid = this.workerPid;
    const cleanupActions = terminateWindowsProcessTree(pid, job.trackedChildPids, job.stagePattern);
    job.cleanupActions.push(...cleanupActions);

    try {
      this.child?.kill();
    } catch {
      // Worker may already be dead from taskkill /T /F
    }
    this.child = null;
    this.port = null;
    this.workerPid = null;
    this.workerSpawnedInfo = null;

    this.settleActiveJob({
      jobId,
      status: "failed",
      outcome: "failed",
      outputPath: job.request.outputPath,
      wallMs: Date.now() - job.startedAt,
      framesRendered: null,
      totalFrames: null,
      warnings: [],
      errorName: "WorkerWatchdogTimeoutError",
      errorMessage: reasonMessage,
    });
  }

  private settleActiveJob(result: RenderJobResult): void {
    const job = this.activeJob;
    if (!job || job.settled) return;

    job.settled = true;
    if (job.cancelTimer) {
      clearTimeout(job.cancelTimer);
      job.cancelTimer = null;
    }
    this.stopHeartbeatMonitor();
    this.activeJob = null;

    const survivors = findSurvivingMediaProcesses(
      job.baselinePids,
      job.trackedChildPids,
      this.workerPid,
      job.stagePattern
    );
    if (survivors.length > 0 && result.status !== "complete") {
      const sweep = terminateWindowsProcessTree(null, survivors.map((s) => s.ProcessId), job.stagePattern);
      job.cleanupActions.push(...sweep);
    }

    const remaining = findSurvivingMediaProcesses(
      job.baselinePids,
      job.trackedChildPids,
      this.workerPid,
      job.stagePattern
    );

    const stderrTail = job.jobStderrTail.trim() ? job.jobStderrTail : null;
    const ffmpegStderrTail = extractFfmpegStderrTail(job.jobStderrTail, result.errorMessage);

    job.resolve({
      result,
      workerPid: this.workerPid,
      trackedChildPids: Array.from(job.trackedChildPids),
      cleanupActions: job.cleanupActions,
      survivingOrphans: remaining.length,
      stderrTail,
      ffmpegStderrTail,
      workerExitCode: job.workerExitCode,
      watchdogReason: job.watchdogReason,
      stageHistory: [...job.stageHistory],
    });
  }

  async render(
    request: RenderJobRequest,
    onProgress?: (event: RenderProgressEvent) => void,
    onDiagnostic?: (signal: WorkerDiagnosticSignal) => void
  ): Promise<WorkerRenderExecution> {
    if (this.activeJob || this.preparingJob) {
      const busyId = this.activeJob?.request.jobId ?? this.preparingJob?.jobId ?? "unknown";
      throw new Error(`RenderWorkerHost already executing job "${busyId}"`);
    }

    const prep = { jobId: request.jobId, cancelReason: null as string | null };
    this.preparingJob = prep;

    let readyInfo: { pid: number; nodeVersion: string; electronVersion: string | null };
    const wasCold = !this.child || !this.port || this.workerPid === null;
    try {
      readyInfo = await this.ensureWorkerReady();
    } catch (err) {
      if (this.preparingJob === prep) {
        this.preparingJob = null;
      }
      if (prep.cancelReason !== null) {
        return {
          result: {
            jobId: request.jobId,
            status: "cancelled",
            outcome: "cancelled",
            outputPath: request.outputPath,
            wallMs: 0,
            framesRendered: null,
            totalFrames: null,
            warnings: [],
            errorName: "RenderCancelledError",
            errorReason: prep.cancelReason,
            errorMessage: `Render cancelled before worker ready (${prep.cancelReason})`,
          },
          workerPid: this.workerPid,
          trackedChildPids: [],
          cleanupActions: [],
          survivingOrphans: 0,
          stderrTail: null,
          ffmpegStderrTail: null,
          workerExitCode: null,
          watchdogReason: null,
          stageHistory: [],
        };
      }
      throw err;
    }

    if (this.preparingJob === prep) {
      this.preparingJob = null;
    }
    if (prep.cancelReason !== null) {
      onDiagnostic?.({
        jobId: request.jobId,
        level: "warning",
        event: "cancellation_requested",
        stage: "worker_init",
        message: `Render cancelled before worker dispatch (${prep.cancelReason})`,
      });
      return {
        result: {
          jobId: request.jobId,
          status: "cancelled",
          outcome: "cancelled",
          outputPath: request.outputPath,
          wallMs: 0,
          framesRendered: null,
          totalFrames: null,
          warnings: [],
          errorName: "RenderCancelledError",
          errorReason: prep.cancelReason,
          errorMessage: `Render cancelled before worker execution (${prep.cancelReason})`,
        },
        workerPid: this.workerPid,
        trackedChildPids: [],
        cleanupActions: [],
        survivingOrphans: 0,
        stderrTail: null,
        ffmpegStderrTail: null,
        workerExitCode: null,
        watchdogReason: null,
        stageHistory: [],
      };
    }

    if (!this.port) {
      throw new Error("Worker MessagePort unavailable after spawn");
    }

    if (wasCold) {
      onDiagnostic?.({
        jobId: request.jobId,
        level: "info",
        event: "worker_spawned",
        stage: "worker_init",
        message: `Spawned isolated RenderWorker (pid=${readyInfo.pid})`,
        metadata: { workerPid: readyInfo.pid, nodeVersion: readyInfo.nodeVersion },
      });
    }
    onDiagnostic?.({
      jobId: request.jobId,
      level: "info",
      event: "worker_ready",
      stage: "worker_init",
      message: `RenderWorker ready (pid=${readyInfo.pid}, reused=${!wasCold})`,
      metadata: { workerPid: readyInfo.pid, reused: !wasCold },
    });

    const baselinePids = new Set<number>(
      queryMediaAndWorkerProcesses().map((p) => p.ProcessId)
    );
    const stagePattern = path.basename(request.stageDir);

    return new Promise<WorkerRenderExecution>((resolve) => {
      const now = Date.now();
      this.activeJob = {
        request,
        baselinePids,
        trackedChildPids: new Set<number>(),
        stagePattern,
        startedAt: now,
        lastHeartbeatAt: now,
        onProgress,
        onDiagnostic,
        jobStderrTail: "",
        workerExitCode: null,
        watchdogReason: null,
        stageHistory: [],
        lastStage: null,
        cleanupActions: [],
        settled: false,
        cancelTimer: null,
        resolve,
      };

      this.startHeartbeatMonitor();
      const startMsg: MainToWorkerMessage = { type: "startRender", request };
      this.port!.postMessage(startMsg);
    });
  }

  cancelJob(jobId: string, reason = "user_cancelled"): boolean {
    if (this.preparingJob && this.preparingJob.jobId === jobId) {
      this.preparingJob.cancelReason = reason;
      return true;
    }

    const job = this.activeJob;
    if (!job || job.settled || job.request.jobId !== jobId || !this.port) {
      return false;
    }

    const cancelMsg: MainToWorkerMessage = { type: "cancelRender", jobId, reason };
    this.port.postMessage(cancelMsg);

    if (!job.cancelTimer) {
      job.cancelTimer = setTimeout(() => {
        if (!job.settled) {
          this.forceTerminateForWatchdog(
            jobId,
            `Cooperative cancellation exceeded grace timeout (${this.cancelGraceTimeoutMs}ms); forced tree termination`
          );
        }
      }, this.cancelGraceTimeoutMs);
    }

    return true;
  }

  private cleanupWorkerProcessTree(): KillActionRecord[] {
    this.intentionalTerminate = true;
    this.stopHeartbeatMonitor();

    const pid = this.workerPid;
    const tracked = this.activeJob ? Array.from(this.activeJob.trackedChildPids) : [];
    const stagePattern = this.activeJob?.stagePattern;

    let actions: KillActionRecord[] = [];
    if (pid !== null || tracked.length > 0) {
      actions = terminateWindowsProcessTree(pid, tracked, stagePattern);
      try {
        this.child?.kill();
      } catch {
        // Ignore if already killed by taskkill
      }
    }

    this.child = null;
    this.port = null;
    this.workerPid = null;
    this.workerSpawnedInfo = null;
    return actions;
  }

  async disposeWorkerTree(): Promise<KillActionRecord[]> {
    if (this.preparingJob && this.preparingJob.cancelReason === null) {
      this.preparingJob.cancelReason = "worker_disposed";
    }
    return this.cleanupWorkerProcessTree();
  }
}
