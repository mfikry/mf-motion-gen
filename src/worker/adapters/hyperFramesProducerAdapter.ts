import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyCaptureFailure,
  isFatalCaptureFailure,
  onTrackedChildProcess,
  resolveConfig,
  resolveHeadlessShellPath,
} from "@hyperframes/engine";
import {
  createRenderJob,
  executeRenderJob,
  RenderCancelledError,
  RenderQualityError,
} from "@hyperframes/producer";
import {
  ALPHA_REFERENCE_LIMITATION_NOTE,
  PINNED_RUNTIME,
  type RenderJobRequest,
  type RenderJobResult,
  type RenderProgressEvent,
} from "../../shared/renderContracts.js";

export interface ProducerRenderCallbacks {
  assertWorkerJobActive: (jobId: string) => void;
  onProgress: (event: RenderProgressEvent) => void;
  onChildProcessTracked?: (pid: number, command?: string) => void;
}

export interface IMotionProducerAdapter {
  readonly pinnedEngineVersion: string;
  readonly pinnedProducerVersion: string;
  render(
    request: RenderJobRequest,
    abortSignal: AbortSignal,
    callbacks: ProducerRenderCallbacks
  ): Promise<RenderJobResult>;
}

/**
 * Resolves the pinned chrome-headless-shell@158.0.8127.36 binary path,
 * preferring an explicit path, MF_CHROME_PATH, the pinned HyperFrames cache location,
 * and finally @hyperframes/engine's own discovery helper.
 */
export function resolvePinnedChromePath(overridePath?: string): string {
  const candidates: string[] = [];
  if (overridePath) candidates.push(overridePath);
  if (process.env.MF_CHROME_PATH) candidates.push(process.env.MF_CHROME_PATH);

  const pinnedCachePath = path.join(
    os.homedir(),
    ".cache",
    "hyperframes",
    "chrome",
    "chrome-headless-shell",
    `win64-${PINNED_RUNTIME.chromeHeadlessShellVersion}`,
    "chrome-headless-shell-win64",
    "chrome-headless-shell.exe"
  );
  candidates.push(pinnedCachePath);

  const engineDetected = resolveHeadlessShellPath();
  if (engineDetected) candidates.push(engineDetected);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Pinned chrome-headless-shell@${PINNED_RUNTIME.chromeHeadlessShellVersion} not found. Checked: ${candidates.join(", ")}`
  );
}

const EXPORT_RUNTIME_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none';" />`;

function prepareExportIsolatedStage(sourceStageDir: string, entryFile: string, jobId: string): {
  isolatedStageDir: string;
  cleanup: () => void;
} {
  const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const isolatedStageDir = path.join(os.tmpdir(), "mf-motion-gen", "export-stage", `${safeId}_${Date.now()}`);
  fs.cpSync(sourceStageDir, isolatedStageDir, { recursive: true, dereference: false });

  const entryPath = path.join(isolatedStageDir, entryFile);
  if (fs.existsSync(entryPath)) {
    let html = fs.readFileSync(entryPath, "utf8");
    if (!/http-equiv=["']Content-Security-Policy["']/i.test(html)) {
      if (/<head\b[^>]*>/i.test(html)) {
        html = html.replace(/<head\b([^>]*)>/i, `<head$1>\n  ${EXPORT_RUNTIME_CSP_META}`);
      } else {
        html = `${EXPORT_RUNTIME_CSP_META}\n${html}`;
      }
      fs.writeFileSync(entryPath, html, "utf8");
    }
  }

  return {
    isolatedStageDir,
    cleanup: () => {
      try {
        fs.rmSync(isolatedStageDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    },
  };
}

/**
 * Internal adapter isolating @hyperframes/engine & @hyperframes/producer (pinned 0.9.93)
 * behind MF Motion Gen's own contract. Worker-active assertions remain internal to
 * the worker wrapper and are NEVER passed as an extra argument to executeRenderJob().
 */
export class HyperFramesProducerAdapter implements IMotionProducerAdapter {
  readonly pinnedEngineVersion = PINNED_RUNTIME.hyperframesEngineVersion;
  readonly pinnedProducerVersion = PINNED_RUNTIME.hyperframesProducerVersion;

  async render(
    request: RenderJobRequest,
    abortSignal: AbortSignal,
    callbacks: ProducerRenderCallbacks
  ): Promise<RenderJobResult> {
    const startedAt = Date.now();
    const chromePath = resolvePinnedChromePath(request.chromePath);
    const entryFile = request.entryFile ?? "index.html";
    const stagedExport = prepareExportIsolatedStage(request.stageDir, entryFile, request.jobId);

    const engineConfig = resolveConfig({
      chromePath,
      useDrawElement: false,
      enableBrowserPool: false,
    });

    const format = request.format ?? "mp4";
    const resolvedCrf =
      format === "mp4" && typeof request.crf === "number" && Number.isInteger(request.crf)
        ? request.crf
        : undefined;
    const resolvedProresProfile =
      format === "mov" ? (request.proresProfile ?? "4444") : undefined;

    const job = createRenderJob({
      fps: request.fps ?? { num: 30, den: 1 },
      quality: request.quality ?? "standard",
      format,
      crf: resolvedCrf,
      workers: request.workers,
      maxRenderMs: request.maxRenderMs,
      strictness: request.strictness ?? "strict",
      entryFile,
      proresProfile: resolvedProresProfile,
      producerConfig: engineConfig,
    });

    const unsubscribeTracker = onTrackedChildProcess((child) => {
      if (typeof child?.pid === "number") {
        const cmd = Array.isArray(child.spawnargs) ? child.spawnargs.join(" ") : undefined;
        callbacks.onChildProcessTracked?.(child.pid, cmd);
      }
    });

    try {
      callbacks.assertWorkerJobActive(request.jobId);

      // Exact documented 5-argument public Producer contract: abortSignal is 5th and final argument.
      const completedJob = await executeRenderJob(
        job,
        stagedExport.isolatedStageDir,
        request.outputPath,
        (updatedJob, message) => {
          callbacks.assertWorkerJobActive(request.jobId);
          callbacks.onProgress({
            jobId: request.jobId,
            stageCode: updatedJob?.stageProgress?.code ?? null,
            stageDone: updatedJob?.stageProgress?.done ?? null,
            stageTotal: updatedJob?.stageProgress?.total ?? null,
            framesRendered: updatedJob?.framesRendered ?? 0,
            totalFrames: updatedJob?.totalFrames ?? null,
            progress: updatedJob?.progress ?? 0,
            currentStage: updatedJob?.currentStage || message || "",
            timestampMs: Date.now(),
          });
        },
        abortSignal
      );

      const finalJob = completedJob ?? job;
      const outcome = finalJob.outcome ?? "completed";
      const result: RenderJobResult = {
        jobId: request.jobId,
        status: "complete",
        outcome: outcome === "completed_with_warnings" ? "completed_with_warnings" : "completed",
        outputPath: request.outputPath,
        wallMs: Date.now() - startedAt,
        framesRendered: finalJob.framesRendered ?? null,
        totalFrames: finalJob.totalFrames ?? null,
        warnings: (finalJob.warnings ?? []).map((w) => ({
          code: w.code,
          message: w.message,
          stage: w.stage,
        })),
      };
      if (request.format === "mov") {
        result.alphaLimitationNote = ALPHA_REFERENCE_LIMITATION_NOTE;
      }
      return result;
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      const isCancelled =
        e instanceof RenderCancelledError ||
        e.name === "RenderCancelledError" ||
        abortSignal.aborted;

      const classified = classifyCaptureFailure(err);
      const isFatal = isFatalCaptureFailure(classified);
      const reason =
        e instanceof RenderCancelledError ? e.reason : isCancelled ? "aborted" : undefined;

      return {
        jobId: request.jobId,
        status: isCancelled ? "cancelled" : "failed",
        outcome: isCancelled ? "cancelled" : "failed",
        outputPath: request.outputPath,
        wallMs: Date.now() - startedAt,
        framesRendered: job.framesRendered ?? null,
        totalFrames: job.totalFrames ?? null,
        warnings: (job.warnings ?? []).map((w) => ({
          code: w.code,
          message: w.message,
          stage: w.stage,
        })),
        errorName: e instanceof RenderQualityError ? "RenderQualityError" : e.name,
        errorReason: reason,
        errorMessage: e.message,
        classifiedFailureKind: classified.kind,
        isFatalFailure: isFatal,
      };
    } finally {
      unsubscribeTracker();
      stagedExport.cleanup();
    }
  }
}
