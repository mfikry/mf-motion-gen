import type { BrowserWindow, ProcessMetric } from "electron";
import type {
  ActiveRenderTelemetrySnapshot,
  ProcessMetricTelemetryItem,
  RuntimeTelemetrySnapshot,
} from "../../shared/renderContracts.js";

export const DEFAULT_TELEMETRY_POLL_INTERVAL_MS = 1500;
export const MIN_TELEMETRY_POLL_INTERVAL_MS = 250;
export const MAX_TELEMETRY_POLL_INTERVAL_MS = 60_000;

export interface ProcessMetricLike {
  pid?: number;
  creationTime?: number;
  type?: string;
  name?: string;
  serviceName?: string;
  memory?: {
    workingSetSize?: number;
    peakWorkingSetSize?: number;
    privateBytes?: number;
  };
  cpu?: {
    percentCPUUsage?: number;
  };
}

export interface TelemetryAggregationInput {
  metrics: ReadonlyArray<ProcessMetricLike | ProcessMetric> | null | undefined;
  pollIntervalMs: number;
  queue: {
    activeCount: number;
    queuedCount: number;
    activeJobId: string | null;
  };
  activeRender: ActiveRenderTelemetrySnapshot | null;
  previousPeakTotalWorkingSetMB?: number | null;
  sampledAtMs?: number;
}

function kbToMbOrNull(kb: unknown): number | null {
  if (typeof kb !== "number" || !Number.isFinite(kb) || kb < 0) {
    return null;
  }
  return Number((kb / 1024).toFixed(2));
}

/**
 * Aggregates Electron `app.getAppMetrics()` safely without double-counting processes
 * (deduplicates by `pid:creationTime`) and preserves `null` (rendered as "N/A") whenever
 * any metric field is omitted or non-finite on the host platform.
 */
export function aggregateRuntimeTelemetry(input: TelemetryAggregationInput): RuntimeTelemetrySnapshot {
  const nowMs = input.sampledAtMs ?? Date.now();
  const rawMetrics = Array.isArray(input.metrics) ? input.metrics : [];

  const seenKeys = new Set<string>();
  const processes: ProcessMetricTelemetryItem[] = [];
  const includedTypesSet = new Set<string>();

  let totalWorkingSetKB = 0;
  let hasAnyMemorySample = false;

  rawMetrics.forEach((m, idx) => {
    if (!m || typeof m !== "object") return;

    const pid = typeof m.pid === "number" && Number.isFinite(m.pid) ? m.pid : null;
    const creationTime =
      typeof m.creationTime === "number" && Number.isFinite(m.creationTime) ? m.creationTime : null;

    if (pid !== null) {
      const dedupeKey = creationTime !== null ? `${pid}:${creationTime}` : `pid:${pid}`;
      if (seenKeys.has(dedupeKey)) {
        return; // Prevent double counting duplicate metric rows
      }
      seenKeys.add(dedupeKey);
    } else {
      const anonKey = `anon:${idx}`;
      if (seenKeys.has(anonKey)) return;
      seenKeys.add(anonKey);
    }

    const type = typeof m.type === "string" && m.type.trim() ? m.type : "Unknown";
    const name =
      typeof m.serviceName === "string" && m.serviceName.trim()
        ? m.serviceName
        : typeof m.name === "string" && m.name.trim()
          ? m.name
          : null;

    const rawWs = m.memory?.workingSetSize;
    const workingSetMB = kbToMbOrNull(rawWs);
    const peakWorkingSetMB = kbToMbOrNull(m.memory?.peakWorkingSetSize);
    const privateBytesMB = kbToMbOrNull(m.memory?.privateBytes);
    const cpuPercent =
      typeof m.cpu?.percentCPUUsage === "number" &&
      Number.isFinite(m.cpu.percentCPUUsage) &&
      m.cpu.percentCPUUsage >= 0
        ? Number(m.cpu.percentCPUUsage.toFixed(1))
        : null;

    if (workingSetMB !== null && typeof rawWs === "number") {
      hasAnyMemorySample = true;
      totalWorkingSetKB += rawWs;
      includedTypesSet.add(type);
    }

    processes.push({
      pid,
      creationTime,
      type,
      name,
      workingSetMB,
      peakWorkingSetMB,
      privateBytesMB,
      cpuPercent,
    });
  });

  const totalWorkingSetMB = hasAnyMemorySample
    ? Number((totalWorkingSetKB / 1024).toFixed(2))
    : null;

  let peakWorkingSetMB: number | null =
    typeof input.previousPeakTotalWorkingSetMB === "number" &&
    Number.isFinite(input.previousPeakTotalWorkingSetMB)
      ? input.previousPeakTotalWorkingSetMB
      : null;

  if (totalWorkingSetMB !== null) {
    peakWorkingSetMB =
      peakWorkingSetMB === null
        ? totalWorkingSetMB
        : Math.max(peakWorkingSetMB, totalWorkingSetMB);
  }

  return {
    sampledAtIso: new Date(nowMs).toISOString(),
    sampledAtMs: nowMs,
    pollIntervalMs: input.pollIntervalMs,
    memoryStatus: totalWorkingSetMB !== null ? "available" : "N/A",
    totalWorkingSetMB,
    peakWorkingSetMB,
    processCount: processes.length,
    includedProcessTypes: Array.from(includedTypesSet),
    aggregationMethod:
      "Sum of unique Electron app.getAppMetrics() memory.workingSetSize (KiB->MiB) deduplicated by (pid, creationTime)",
    externalProcessesNote:
      "External child processes (chrome-headless-shell.exe, ffmpeg.exe) run outside Electron getAppMetrics() and are tracked via child PID tree.",
    processes,
    queue: { ...input.queue },
    activeRender: input.activeRender ? { ...input.activeRender } : null,
  };
}

export interface RuntimeTelemetryServiceOptions {
  getAppMetrics: () => ReadonlyArray<ProcessMetricLike | ProcessMetric>;
  getQueueAndRenderState: () => {
    queue: { activeCount: number; queuedCount: number; activeJobId: string | null };
    activeRender: ActiveRenderTelemetrySnapshot | null;
  };
  pollIntervalMs?: number;
  onSnapshot?: (snapshot: RuntimeTelemetrySnapshot) => void;
}

/**
 * Periodic Electron Main-Process runtime telemetry collector.
 * Guarantees idempotent single-timer polling, safe destroyed-WebContents checks,
 * and deterministic listener/timer teardown on window close or app shutdown.
 */
export class RuntimeTelemetryService {
  readonly pollIntervalMs: number;
  private readonly getAppMetrics: () => ReadonlyArray<ProcessMetricLike | ProcessMetric>;
  private readonly getQueueAndRenderState: () => {
    queue: { activeCount: number; queuedCount: number; activeJobId: string | null };
    activeRender: ActiveRenderTelemetrySnapshot | null;
  };
  private readonly onSnapshot?: (snapshot: RuntimeTelemetrySnapshot) => void;

  private timer: NodeJS.Timeout | null = null;
  private peakTotalWorkingSetMB: number | null = null;
  private latestSnapshot: RuntimeTelemetrySnapshot | null = null;
  private disposed = false;

  private attachedWindow: BrowserWindow | null = null;
  private boundWindowCloseHandler: (() => void) | null = null;
  private targetEventChannel: string | null = null;

  constructor(options: RuntimeTelemetryServiceOptions) {
    const rawInterval = options.pollIntervalMs ?? DEFAULT_TELEMETRY_POLL_INTERVAL_MS;
    this.pollIntervalMs = Math.max(
      MIN_TELEMETRY_POLL_INTERVAL_MS,
      Math.min(MAX_TELEMETRY_POLL_INTERVAL_MS, Math.round(rawInterval))
    );
    this.getAppMetrics = options.getAppMetrics;
    this.getQueueAndRenderState = options.getQueueAndRenderState;
    this.onSnapshot = options.onSnapshot;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  sampleOnce(): RuntimeTelemetrySnapshot {
    let rawMetrics: ReadonlyArray<ProcessMetricLike | ProcessMetric> = [];
    try {
      rawMetrics = this.getAppMetrics() ?? [];
    } catch {
      rawMetrics = [];
    }

    const qState = this.getQueueAndRenderState();
    const snap = aggregateRuntimeTelemetry({
      metrics: rawMetrics,
      pollIntervalMs: this.pollIntervalMs,
      queue: qState.queue,
      activeRender: qState.activeRender,
      previousPeakTotalWorkingSetMB: this.peakTotalWorkingSetMB,
    });
    this.peakTotalWorkingSetMB = snap.peakWorkingSetMB;
    this.latestSnapshot = snap;

    this.onSnapshot?.(snap);
    if (
      this.attachedWindow &&
      this.targetEventChannel &&
      !this.attachedWindow.isDestroyed() &&
      !this.attachedWindow.webContents.isDestroyed()
    ) {
      this.attachedWindow.webContents.send(this.targetEventChannel, snap);
    }
    return snap;
  }

  getLatestOrSample(): RuntimeTelemetrySnapshot {
    return this.latestSnapshot ?? this.sampleOnce();
  }

  attachWindow(win: BrowserWindow, eventChannel: string): void {
    this.detachWindow();
    if (this.disposed || win.isDestroyed()) return;

    this.attachedWindow = win;
    this.targetEventChannel = eventChannel;
    const onClosed = () => {
      this.stop();
    };
    this.boundWindowCloseHandler = onClosed;
    win.once("closed", onClosed);
  }

  detachWindow(): void {
    if (this.attachedWindow && this.boundWindowCloseHandler && !this.attachedWindow.isDestroyed()) {
      this.attachedWindow.removeListener("closed", this.boundWindowCloseHandler);
    }
    this.attachedWindow = null;
    this.boundWindowCloseHandler = null;
    this.targetEventChannel = null;
  }

  start(): void {
    if (this.disposed) return;
    if (this.timer) return; // Prevent duplicate polling timers
    this.timer = setInterval(() => {
      if (this.disposed) {
        this.stop();
        return;
      }
      this.sampleOnce();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.detachWindow();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}
