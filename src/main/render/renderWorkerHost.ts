import path from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannelMain, utilityProcess } from "electron";
import type {
  MainToWorkerMessage,
  RenderJobRequest,
  RenderJobResult,
  RenderProgressEvent,
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

export interface WorkerRenderExecution {
  result: RenderJobResult;
  workerPid: number | null;
  trackedChildPids: number[];
  cleanupActions: KillActionRecord[];
  survivingOrphans: number;
}

interface PendingJobState {
  request: RenderJobRequest;
  baselinePids: Set<number>;
  trackedChildPids: Set<number>;
  stagePattern: string;
  startedAt: number;
  lastHeartbeatAt: number;
  onProgress?: (event: RenderProgressEvent) => void;
  cleanupActions: KillActionRecord[];
  settled: boolean;
  cancelTimer: NodeJS.Timeout | null;
  resolve: (value: WorkerRenderExecution) => void;
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
    await this.disposeWorkerTree();

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
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
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
      this.stderrTail = (this.stderrTail + `\n[WorkerInternalError] ${msg.message}\n${msg.stack ?? ""}`).slice(-4000);
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

    job.resolve({
      result,
      workerPid: this.workerPid,
      trackedChildPids: Array.from(job.trackedChildPids),
      cleanupActions: job.cleanupActions,
      survivingOrphans: remaining.length,
    });
  }

  async render(
    request: RenderJobRequest,
    onProgress?: (event: RenderProgressEvent) => void
  ): Promise<WorkerRenderExecution> {
    if (this.activeJob) {
      throw new Error(`RenderWorkerHost already executing job "${this.activeJob.request.jobId}"`);
    }

    await this.ensureWorkerReady();
    if (!this.port) {
      throw new Error("Worker MessagePort unavailable after spawn");
    }

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

  async disposeWorkerTree(): Promise<KillActionRecord[]> {
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
}
