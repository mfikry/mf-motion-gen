import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { purgeSessionDirectorySync } from "../../dist/main/import/sessionFsUtils.js";
import { sanitizeLogString } from "../../dist/main/logging/logSanitizer.js";
import {
  computeRenderThroughputAndEta,
  DEFAULT_MAX_LOG_ENTRIES_PER_JOB,
  DEFAULT_MAX_RETAINED_JOB_LOGS,
  exportRenderLogWithSaveDialog,
  RenderLogStore,
  validateRenderJobId,
} from "../../dist/main/logging/renderLogStore.js";
import { RenderQueueManager } from "../../dist/main/render/renderQueueManager.js";
import {
  aggregateRuntimeTelemetry,
  RuntimeTelemetryService,
} from "../../dist/main/telemetry/runtimeTelemetryService.js";
import { formatTelemetryMetric } from "../../dist/shared/renderContracts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const tmpRoot = path.join(repoRoot, "tmp", "unit-ws-b-logging-telemetry");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeStageDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html><body></body></html>", "utf8");
  return dir;
}

describe("Workstream B — Structured Render Logs, Diagnostics, Sanitization, Export & Telemetry", () => {
  before(() => {
    purgeSessionDirectorySync(tmpRoot);
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  after(() => {
    purgeSessionDirectorySync(tmpRoot);
  });

  it("1-3 & 6: records full structured lifecycle for success, failure, and cancellation including stderr & unavailable state", async () => {
    const stageDir = makeStageDir("stage-lifecycle");
    const logStore = new RenderLogStore();

    const runner = {
      async render(req, hooks) {
        hooks?.onPreflight?.({
          ok: true,
          stageDir,
          entryPath: path.join(stageDir, "index.html"),
          blockers: [],
          warnings: [],
          checkedLocalAssets: [path.join(stageDir, "index.html")],
          checkedStylesheets: [],
          externalReferences: [],
          elapsedMs: 4,
        });
        hooks?.onDiagnostic?.({
          jobId: req.jobId,
          level: "info",
          event: "worker_spawned",
          stage: "worker_init",
          message: "Spawned test worker",
          metadata: { workerPid: 4242 },
        });
        hooks?.onDiagnostic?.({
          jobId: req.jobId,
          level: "info",
          event: "worker_ready",
          stage: "worker_init",
          message: "Worker ready",
        });

        const baseTs = Date.now() - 1000;
        hooks?.onProgress?.({
          jobId: req.jobId,
          stageCode: "capture",
          stageDone: 10,
          stageTotal: 30,
          framesRendered: 10,
          totalFrames: 30,
          progress: 0.33,
          currentStage: "capture",
          timestampMs: baseTs + 400,
        });
        hooks?.onProgress?.({
          jobId: req.jobId,
          stageCode: "encode",
          stageDone: 30,
          stageTotal: 30,
          framesRendered: 30,
          totalFrames: 30,
          progress: 1,
          currentStage: "encode",
          timestampMs: baseTs + 900,
        });

        if (req.jobId === "job-fail") {
          return {
            preflight: { ok: true, blockers: [], warnings: [] },
            execution: {
              result: {
                jobId: req.jobId,
                status: "failed",
                outcome: "failed",
                outputPath: req.outputPath,
                wallMs: 500,
                framesRendered: 10,
                totalFrames: 30,
                warnings: [],
                errorName: "RenderError",
                errorMessage: "ffmpeg libx264 exited with code 1",
              },
              workerPid: 4242,
              trackedChildPids: [5001],
              cleanupActions: [{ pid: 5001, ok: true }],
              survivingOrphans: 0,
              stderrTail: "[worker] stderr error\n[ffmpeg] libx264 failed header",
              ffmpegStderrTail: "[ffmpeg] libx264 failed header",
              workerExitCode: 1,
              watchdogReason: null,
              stageHistory: [],
            },
          };
        }

        if (req.jobId === "job-cancel") {
          return {
            preflight: { ok: true, blockers: [], warnings: [] },
            execution: {
              result: {
                jobId: req.jobId,
                status: "cancelled",
                outcome: "cancelled",
                outputPath: req.outputPath,
                wallMs: 250,
                framesRendered: 5,
                totalFrames: 30,
                warnings: [],
                errorName: "RenderCancelledError",
                errorReason: "studio_ui_cancelled",
                errorMessage: "User aborted render",
              },
              workerPid: 4242,
              trackedChildPids: [5002],
              cleanupActions: [{ pid: 5002, ok: true }],
              survivingOrphans: 0,
              stderrTail: null,
              ffmpegStderrTail: null,
              workerExitCode: null,
              watchdogReason: null,
              stageHistory: [],
            },
          };
        }

        return {
          preflight: { ok: true, blockers: [], warnings: [] },
          execution: {
            result: {
              jobId: req.jobId,
              status: "complete",
              outcome: "completed",
              outputPath: req.outputPath,
              wallMs: 900,
              framesRendered: 30,
              totalFrames: 30,
              warnings: [],
            },
            workerPid: 4242,
            trackedChildPids: [],
            cleanupActions: [],
            survivingOrphans: 0,
            stderrTail: null,
            ffmpegStderrTail: null,
            workerExitCode: null,
            watchdogReason: null,
            stageHistory: [],
          },
        };
      },
      cancel() {
        return true;
      },
    };

    const queue = new RenderQueueManager({ runner, logStore });
    const reqBase = (jobId) => ({
      jobId,
      stageDir,
      entryFile: "index.html",
      outputPath: path.join(tmpRoot, `${jobId}.mp4`),
      format: "mp4",
      quality: "draft",
      fps: { num: 30, den: 1 },
    });

    await queue.enqueue({ sessionId: "sess-1", title: "SuccessComp", request: reqBase("job-ok") }).completion;
    await queue.enqueue({ sessionId: "sess-1", title: "FailComp", request: reqBase("job-fail") }).completion;
    await queue.enqueue({ sessionId: "sess-1", title: "CancelComp", request: reqBase("job-cancel") }).completion;

    const okLog = logStore.getJobLog("job-ok");
    const okEvents = okLog.entries.map((e) => e.event);
    assert.ok(okEvents.includes("job_created"));
    assert.ok(okEvents.includes("job_enqueued"));
    assert.ok(okEvents.includes("job_started"));
    assert.ok(okEvents.includes("preflight_validation"));
    assert.ok(okEvents.includes("worker_spawned"));
    assert.ok(okEvents.includes("worker_ready"));
    assert.ok(okEvents.includes("stage_transition"));
    assert.ok(okEvents.includes("capture_progress"));
    assert.ok(okEvents.includes("encoding_progress"));
    assert.ok(okEvents.includes("job_completed"));
    assert.ok(okEvents.includes("final_render_summary"));
    assert.equal(okLog.workerStderrStatus, "unavailable");
    assert.equal(okLog.ffmpegStderrStatus, "unavailable");

    const failLog = logStore.getJobLog("job-fail");
    assert.equal(failLog.status, "failed");
    assert.equal(failLog.workerStderrStatus, "captured");
    assert.equal(failLog.ffmpegStderrStatus, "captured");
    assert.equal(failLog.workerExitCode, 1);
    assert.match(failLog.workerStderr, /libx264/);
    assert.match(failLog.ffmpegStderr, /libx264/);
    assert.ok(failLog.entries.some((e) => e.event === "job_failed"));
    assert.ok(failLog.entries.some((e) => e.event === "worker_exit"));
    assert.ok(failLog.entries.some((e) => e.event === "process_tree_cleanup"));

    const cancelLog = logStore.getJobLog("job-cancel");
    assert.equal(cancelLog.status, "cancelled");
    assert.equal(cancelLog.cancellationReason, "studio_ui_cancelled");
    assert.ok(cancelLog.entries.some((e) => e.event === "job_cancelled"));
  });

  it("4 & 5: enforces ring buffer capacity with priority preservation and caps retained job count", () => {
    const store = new RenderLogStore({ maxEntriesPerJob: 12, maxRetainedJobs: 3 });
    assert.equal(DEFAULT_MAX_LOG_ENTRIES_PER_JOB, 200);
    assert.equal(DEFAULT_MAX_RETAINED_JOB_LOGS, 50);

    for (let j = 1; j <= 5; j += 1) {
      const id = `job-${j}`;
      store.ensureJob({ jobId: id, sessionId: "s", title: id, format: "mp4", fps: { num: 30, den: 1 } });
      store.updateStatus(id, "rendering");
      for (let k = 0; k < 25; k += 1) {
        store.appendEvent(id, {
          level: "debug",
          event: "capture_progress",
          stage: "capture",
          message: `Frame ${k}`,
        });
      }
      store.appendEvent(id, {
        level: "error",
        event: "watchdog_timeout",
        stage: "capture",
        message: `Watchdog triggered on ${id}`,
      });
      store.updateStatus(id, "failed");
      store.appendEvent(id, {
        level: "error",
        event: "final_render_summary",
        message: `Final summary ${id}`,
      });
    }

    assert.equal(store.getRetainedJobCount(), 3);
    assert.equal(store.hasJob("job-1"), false);
    assert.equal(store.hasJob("job-2"), false);
    assert.equal(store.hasJob("job-5"), true);

    const log5 = store.getJobLog("job-5");
    assert.equal(log5.entries.length, 12);
    assert.equal(log5.truncated, true);
    assert.ok(log5.droppedEntryCount > 0);
    // Critical watchdog and summary events must survive eviction of verbose progress ticks
    assert.ok(log5.entries.some((e) => e.event === "watchdog_timeout"));
    assert.ok(log5.entries.some((e) => e.event === "final_render_summary"));
  });

  it("7 & 8: sanitizes tokens, credentials, secrets, and sensitive local absolute paths cleanly", () => {
    const store = new RenderLogStore();
    store.ensureJob({
      jobId: "job-sec",
      sessionId: "sess-sec",
      title: "Secret Test",
      format: "mp4",
      fps: { num: 30, den: 1 },
    });

    const userHomeSample = path.join(os.homedir(), "PrivateDocs", "client.html");
    const rawMsg =
      `Authorization: Bearer secretJwt123456789 ` +
      `https://admin:SuperPass99@internal.example.com/hook ` +
      `GITHUB_TOKEN=ghp_1234567890abcdefghij API_KEY=sk-abcdefghijklmnop1234 ` +
      `reading ${userHomeSample} and D:\\Confidential\\ClientA\\secret_config.json failed ENOENT`;

    assert.equal(sanitizeLogString(rawMsg).includes("secretJwt123456789"), false);

    store.appendEvent("job-sec", {
      level: "error",
      event: "job_failed",
      message: rawMsg,
      metadata: {
        token: "top-secret-meta-token",
        nested: { apiKey: "AIzaSyDummyKeyValue1234567890", detail: `\\\\fileserver\\private\\asset.png` },
      },
    });

    const jsonText = store.buildExportPayload("job-sec");
    for (const secret of [
      "secretJwt123456789",
      "SuperPass99",
      "ghp_1234567890abcdefghij",
      "sk-abcdefghijklmnop1234",
      "top-secret-meta-token",
      "AIzaSyDummyKeyValue1234567890",
      "D:\\Confidential\\ClientA",
      "\\\\fileserver\\private",
      os.homedir(),
    ]) {
      assert.equal(jsonText.includes(secret), false, `Secret leaked in log: ${secret}`);
    }
    // Preserve actionable technical context
    assert.match(jsonText, /ENOENT/);
    assert.match(jsonText, /secret_config\.json/);
  });

  it("9, 10 & 11: handles log export cancel, write failure atomically, valid export, and IPC input validation", async () => {
    const store = new RenderLogStore();
    store.ensureJob({ jobId: "exp-job-1", sessionId: "s1", title: "Export", format: "mp4", fps: { num: 30, den: 1 } });

    // 11. IPC Job ID validation
    for (const badId of [null, 123, "", "   ", "../evil", "job with spaces", "a".repeat(200), "job;rm"]) {
      assert.throws(() => validateRenderJobId(badId), /Invalid IPC field "jobId"/);
    }
    assert.equal(validateRenderJobId("exp-job-1"), "exp-job-1");

    // Missing job returns clean non-throwing failure
    const missing = await exportRenderLogWithSaveDialog({
      logStore: store,
      rawJobId: "nonexistent_job",
      defaultDir: tmpRoot,
      showSaveDialog: async () => {
        throw new Error("Dialog must not open for missing job");
      },
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.canceled, false);

    // 9. Dialog cancellation creates NO file
    const canceledPath = path.join(tmpRoot, "never-created.json");
    const cancelRes = await exportRenderLogWithSaveDialog({
      logStore: store,
      rawJobId: "exp-job-1",
      defaultDir: tmpRoot,
      showSaveDialog: async () => ({ canceled: true }),
    });
    assert.deepEqual(cancelRes, { canceled: true, ok: false });
    assert.equal(fs.existsSync(canceledPath), false);

    // 10. Export failure on unwritable directory (using target path that is an existing directory) leaves zero temp files
    const failDir = path.join(tmpRoot, "export-fail-target");
    fs.mkdirSync(failDir, { recursive: true });
    const failRes = await exportRenderLogWithSaveDialog({
      logStore: store,
      rawJobId: "exp-job-1",
      defaultDir: tmpRoot,
      showSaveDialog: async () => ({ canceled: false, filePath: failDir }),
    });
    assert.equal(failRes.canceled, false);
    assert.equal(failRes.ok, false);
    assert.ok(failRes.error);
    assert.deepEqual(fs.readdirSync(failDir), [], "No half-written temp file may remain on failure");

    // Valid sanitized atomic export
    const goodPath = path.join(tmpRoot, "good-export.json");
    const goodRes = await exportRenderLogWithSaveDialog({
      logStore: store,
      rawJobId: "exp-job-1",
      defaultDir: tmpRoot,
      showSaveDialog: async () => ({ canceled: false, filePath: goodPath }),
    });
    assert.equal(goodRes.ok, true);
    assert.equal(goodRes.canceled, false);
    assert.equal(goodRes.exportedFileName, "good-export.json");
    const parsed = JSON.parse(fs.readFileSync(goodPath, "utf8"));
    assert.equal(parsed.jobLog.jobId, "exp-job-1");
  });

  it("12 & 13: aggregates Electron metrics without double counting and renders missing fields as N/A", () => {
    const deduped = aggregateRuntimeTelemetry({
      metrics: [
        { pid: 100, creationTime: 1000, type: "Browser", memory: { workingSetSize: 102400, peakWorkingSetSize: 204800 }, cpu: { percentCPUUsage: 2.5 } },
        { pid: 100, creationTime: 1000, type: "Browser", memory: { workingSetSize: 102400 }, cpu: { percentCPUUsage: 2.5 } },
        { pid: 200, creationTime: 2000, type: "Utility", serviceName: "mf-motion-render-worker", memory: { workingSetSize: 51200 } },
      ],
      pollIntervalMs: 1500,
      queue: { activeCount: 1, queuedCount: 0, activeJobId: "j1" },
      activeRender: null,
    });

    assert.equal(deduped.processCount, 2);
    assert.equal(deduped.memoryStatus, "available");
    assert.equal(deduped.totalWorkingSetMB, 150); // (102400 + 51200) / 1024 = 150 MB

    const missingMem = aggregateRuntimeTelemetry({
      metrics: [{ pid: 300, creationTime: 3000, type: "GPU" }],
      pollIntervalMs: 1500,
      queue: { activeCount: 0, queuedCount: 0, activeJobId: null },
      activeRender: null,
    });
    assert.equal(missingMem.memoryStatus, "N/A");
    assert.equal(missingMem.totalWorkingSetMB, null);
    assert.equal(missingMem.processes[0].workingSetMB, null);
    assert.equal(formatTelemetryMetric(missingMem.totalWorkingSetMB, " MB"), "N/A");
  });

  it("14 & 15: calculates real throughput FPS & ETA from frames/elapsed and returns null (N/A) when insufficient or stopped", () => {
    const valid = computeRenderThroughputAndEta({
      isActive: true,
      startedAtMs: 1000,
      nowMs: 3000,
      framesRendered: 30,
      totalFrames: 90,
      stage: "capture",
      captureStageStartedAtMs: 1000,
      captureFramesRendered: 30,
    });
    assert.equal(valid.throughputFps, 15);
    assert.equal(valid.captureFps, 15);
    assert.equal(valid.encodeFps, null);
    assert.equal(valid.etaSeconds, 4);
    assert.equal(valid.isEstimateValid, true);

    // Zero frames or unknown total frames or terminal status -> ETA MUST be null ("N/A")
    assert.equal(
      computeRenderThroughputAndEta({
        isActive: true,
        startedAtMs: 1000,
        nowMs: 3000,
        framesRendered: 0,
        totalFrames: 90,
        stage: "capture",
      }).etaSeconds,
      null
    );
    assert.equal(
      computeRenderThroughputAndEta({
        isActive: true,
        startedAtMs: 1000,
        nowMs: 3000,
        framesRendered: 30,
        totalFrames: null,
        stage: "capture",
      }).etaSeconds,
      null
    );
    assert.equal(
      computeRenderThroughputAndEta({
        isActive: false,
        startedAtMs: 1000,
        nowMs: 3000,
        framesRendered: 30,
        totalFrames: 90,
        stage: "capture",
      }).etaSeconds,
      null
    );
  });

  it("16: cleans up polling timers on close/dispose and prevents duplicate timers/listeners", async () => {
    class MockWebContents extends EventEmitter {
      destroyed = false;
      sent = [];
      isDestroyed() {
        return this.destroyed;
      }
      send(ch, payload) {
        this.sent.push({ ch, payload });
      }
    }
    class MockWindow extends EventEmitter {
      destroyed = false;
      webContents = new MockWebContents();
      isDestroyed() {
        return this.destroyed;
      }
    }

    let sampleCalls = 0;
    const service = new RuntimeTelemetryService({
      pollIntervalMs: 250,
      getAppMetrics: () => {
        sampleCalls += 1;
        return [{ pid: 1, creationTime: 1, type: "Browser", memory: { workingSetSize: 10240 } }];
      },
      getQueueAndRenderState: () => ({
        queue: { activeCount: 0, queuedCount: 0, activeJobId: null },
        activeRender: null,
      }),
    });

    const win1 = new MockWindow();
    const win2 = new MockWindow();
    service.attachWindow(win1, "studio:eventRuntimeTelemetry");
    service.attachWindow(win2, "studio:eventRuntimeTelemetry");
    assert.equal(win1.listenerCount("closed"), 0, "Old window listener must be detached on re-attach");
    assert.equal(win2.listenerCount("closed"), 1);

    service.start();
    service.start(); // Duplicate start must not spawn extra timers
    assert.equal(service.isRunning(), true);

    await sleep(320);
    assert.ok(sampleCalls >= 1 && sampleCalls <= 2, `Expected 1 timer firing, got ${sampleCalls}`);
    assert.ok(win2.webContents.sent.length >= 1);

    // Simulate window closed -> stops timer and removes listeners
    win2.destroyed = true;
    win2.webContents.destroyed = true;
    win2.emit("closed");
    assert.equal(service.isRunning(), false);

    const callsAfterClose = sampleCalls;
    await sleep(320);
    assert.equal(sampleCalls, callsAfterClose, "Polling must stay stopped after window close");

    service.dispose();
  });
});
