import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RenderPreflightError } from "../../dist/main/render/renderCoordinator.js";
import { RenderWorkerHost } from "../../dist/main/render/renderWorkerHost.js";
import { queryMediaAndWorkerProcesses } from "../../dist/main/render/windowsProcessTree.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const workRoot = path.join(repoRoot, "tmp", "sprint1-e2e");

function ffprobeJson(filePath) {
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
    { encoding: "utf8" }
  );
  if (res.status !== 0) throw new Error(`ffprobe failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function writeOfflineComp(stageDir, { durationSec = 2, includeInvalidAsset = false } = {}) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, "assets"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "poc", "hyperframes-spike", "assets", "gsap.min.js"),
    path.join(stageDir, "assets", "gsap.min.js")
  );
  fs.writeFileSync(
    path.join(stageDir, "assets", "badge.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <rect width="120" height="120" rx="24" fill="#38bdf8"/>
      <circle cx="60" cy="60" r="28" fill="#0f172a"/>
    </svg>`
  );

  const extraBadTags = includeInvalidAsset
    ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=BadFont"/>
       <img src="./assets/missing_file.png"/>`
    : `<img id="badge" src="./assets/badge.svg" style="position:absolute;top:120px;left:120px;width:120px;height:120px;"/>`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #091326; font-family: sans-serif; }
    #root { position: relative; width: 1280px; height: 720px; }
    #bar { position: absolute; left: 120px; top: 340px; width: 220px; height: 64px; background: #22d3ee; border-radius: 12px; }
  </style>
  <script src="./assets/gsap.min.js"></script>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="${durationSec}" data-width="1280" data-height="720" data-fps="30">
    ${extraBadTags}
    <div id="bar"></div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.to("#bar", { x: 820, rotation: 90, duration: ${durationSec}, ease: "none" }, 0);
    window.__timelines["main"] = tl;
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(stageDir, "index.html"), html);
}

export async function runElectronVerification({ RenderCoordinator, PINNED_RUNTIME }) {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });

  const report = {
    pinnedRuntime: PINNED_RUNTIME,
    timestamp: new Date().toISOString(),
    tests: {},
  };

  // 1. E2E Smoke Test: HTML -> Preflight -> RenderWorkerHost -> HyperFramesProducerAdapter -> MP4
  {
    const stageDir = path.join(workRoot, "t1-smoke-stage");
    const outPath = path.join(workRoot, "t1-smoke-out.mp4");
    writeOfflineComp(stageDir, { durationSec: 2 });

    const coordinator = new RenderCoordinator();
    const progressEvents = [];
    const stagesSeen = [];
    const { preflight, execution } = await coordinator.render(
      {
        jobId: "smoke-1",
        stageDir,
        entryFile: "index.html",
        outputPath: outPath,
        format: "mp4",
        quality: "draft",
        fps: { num: 30, den: 1 },
        strictness: "strict",
      },
      (ev) => {
        progressEvents.push(ev);
        if (ev.stageCode && stagesSeen[stagesSeen.length - 1] !== ev.stageCode) {
          stagesSeen.push(ev.stageCode);
        }
      }
    );

    assert.equal(preflight.ok, true);
    assert.equal(execution.result.status, "complete");
    assert.equal(execution.survivingOrphans, 0);
    assert.ok(fs.existsSync(outPath), "MP4 output missing");

    const probe = ffprobeJson(outPath);
    const vStream = (probe.streams || []).find((s) => s.codec_type === "video") || {};
    assert.equal(vStream.codec_name, "h264");
    assert.equal(vStream.width, 1280);
    assert.equal(vStream.height, 720);
    assert.equal(Number(vStream.nb_frames), 60);

    await coordinator.shutdown();
    report.tests.e2eSmokeRender = {
      passed: true,
      preflightMs: preflight.elapsedMs,
      checkedLocalAssets: preflight.checkedLocalAssets.length,
      workerPid: execution.workerPid,
      trackedChildCount: execution.trackedChildPids.length,
      stagesSeen,
      progressCount: progressEvents.length,
      wallMs: execution.result.wallMs,
      ffprobe: {
        codec: vStream.codec_name,
        width: vStream.width,
        height: vStream.height,
        nbFrames: Number(vStream.nb_frames),
        duration: Number(probe.format?.duration || 0),
      },
      survivingOrphans: execution.survivingOrphans,
    };
  }

  // 2. Host-Side Preflight Block Before Worker Spawn
  {
    const badStage = path.join(workRoot, "t2-bad-stage");
    const badOut = path.join(workRoot, "t2-bad-out.mp4");
    writeOfflineComp(badStage, { durationSec: 2, includeInvalidAsset: true });

    const coordinator = new RenderCoordinator();
    let caughtErr = null;
    try {
      await coordinator.render({
        jobId: "preflight-block-1",
        stageDir: badStage,
        outputPath: badOut,
      });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr instanceof RenderPreflightError, "Expected RenderPreflightError");
    assert.equal(coordinator.host.pid, null, "Worker must NOT spawn when preflight blocks");
    assert.equal(fs.existsSync(badOut), false);
    const blockerCodes = caughtErr.preflight.blockers.map((b) => b.code);
    assert.ok(blockerCodes.includes("EXTERNAL_FONT_DISALLOWED"));
    assert.ok(blockerCodes.includes("MISSING_LOCAL_ASSET"));

    report.tests.preflightFailFastBeforeWorker = {
      passed: true,
      workerNeverSpawned: coordinator.host.pid === null,
      preflightMs: caughtErr.preflight.elapsedMs,
      blockerCodes,
    };
  }

  // 3. Streaming Encode Cancellation with workers: 1 (explicitly required by PM)
  {
    const stageDir = path.join(workRoot, "t3-streaming-cancel-stage");
    const outPath = path.join(workRoot, "t3-streaming-cancel.mp4");
    writeOfflineComp(stageDir, { durationSec: 8 }); // 240 frames @ workers=1 triggers streaming encode

    const coordinator = new RenderCoordinator();
    let cancelTriggeredAt = null;
    let triggerStage = null;
    let triggerFrames = null;

    const renderPromise = coordinator.render(
      {
        jobId: "stream-cancel-1",
        stageDir,
        outputPath: outPath,
        format: "mp4",
        quality: "standard",
        workers: 1,
        fps: { num: 30, den: 1 },
      },
      (ev) => {
        if (!cancelTriggeredAt && ev.stageCode === "capture" && ev.framesRendered >= 12) {
          cancelTriggeredAt = Date.now();
          triggerStage = ev.stageCode;
          triggerFrames = ev.framesRendered;
          coordinator.cancel("stream-cancel-1", "pm_streaming_encode_cancel_test");
        }
      }
    );

    const { execution } = await renderPromise;
    assert.ok(cancelTriggeredAt !== null, "Streaming capture trigger did not fire");
    assert.equal(execution.result.status, "cancelled");
    assert.equal(execution.result.errorName, "RenderCancelledError");
    assert.equal(execution.survivingOrphans, 0);
    assert.equal(fs.existsSync(outPath), false, "Cancelled output should not exist");

    // Verify worker remains alive & ready for subsequent job after cooperative cancel
    assert.notEqual(coordinator.host.pid, null);
    await coordinator.shutdown();

    report.tests.streamingEncodeCancelWorkers1 = {
      passed: true,
      workers: 1,
      triggerStage,
      triggerFrames,
      responseAfterCancelMs: Date.now() - cancelTriggeredAt,
      errorName: execution.result.errorName,
      errorReason: execution.result.errorReason,
      trackedChildPids: execution.trackedChildPids,
      survivingOrphans: execution.survivingOrphans,
    };
  }

  // 4a. Forced Worker Crash Mid-Render -> Tree Cleanup -> Recovery Render
  {
    const crashStage = path.join(workRoot, "t4-crash-stage");
    const crashOut = path.join(workRoot, "t4-crash.mp4");
    writeOfflineComp(crashStage, { durationSec: 6 });

    const coordinator = new RenderCoordinator();
    let killedWorkerPid = null;

    const crashPromise = coordinator.render(
      {
        jobId: "crash-test-1",
        stageDir: crashStage,
        outputPath: crashOut,
        format: "mp4",
        quality: "draft",
        workers: 1,
      },
      (ev) => {
        if (killedWorkerPid === null && ev.stageCode === "capture" && ev.framesRendered >= 6) {
          killedWorkerPid = coordinator.host.pid;
          spawnSync("taskkill.exe", ["/PID", String(killedWorkerPid), "/F"], { encoding: "utf8" });
        }
      }
    );

    const crashOutcome = await crashPromise;
    assert.equal(crashOutcome.execution.result.status, "failed");
    assert.equal(crashOutcome.execution.result.errorName, "WorkerCrashedError");
    assert.equal(crashOutcome.execution.survivingOrphans, 0);

    // Recovery render immediately on same coordinator instance
    const recStage = path.join(workRoot, "t4-recovery-stage");
    const recOut = path.join(workRoot, "t4-recovery.mp4");
    writeOfflineComp(recStage, { durationSec: 1 });
    const recOutcome = await coordinator.render({
      jobId: "recovery-1",
      stageDir: recStage,
      outputPath: recOut,
      format: "mp4",
      quality: "draft",
    });

    assert.equal(recOutcome.execution.result.status, "complete");
    assert.equal(recOutcome.execution.survivingOrphans, 0);
    assert.ok(fs.existsSync(recOut));
    const recProbe = ffprobeJson(recOut);
    const recStream = (recProbe.streams || []).find((s) => s.codec_type === "video") || {};
    assert.equal(Number(recStream.nb_frames), 30);

    await coordinator.shutdown();
    report.tests.workerCrashCleanupAndRecovery = {
      passed: true,
      killedWorkerPid,
      crashErrorName: crashOutcome.execution.result.errorName,
      crashCleanupCount: crashOutcome.execution.cleanupActions.length,
      crashSurvivingOrphans: crashOutcome.execution.survivingOrphans,
      recoveryWorkerPid: recOutcome.execution.workerPid,
      recoveryFrames: Number(recStream.nb_frames),
      recoverySurvivingOrphans: recOutcome.execution.survivingOrphans,
    };
  }

  // 4b. Heartbeat Hang Watchdog -> Forced Tree Kill
  {
    const hangStage = path.join(workRoot, "t4b-hang-stage");
    const hangOut = path.join(workRoot, "t4b-hang.mp4");
    writeOfflineComp(hangStage, { durationSec: 1 });

    const hangHost = new RenderWorkerHost({
      workerEntryPath: path.join(repoRoot, "tests", "e2e", "hangWorkerStub.mjs"),
      heartbeatIntervalMs: 400,
      hangTimeoutMs: 1600,
    });

    const execRes = await hangHost.render({
      jobId: "hang-watchdog-1",
      stageDir: hangStage,
      outputPath: hangOut,
    });

    assert.equal(execRes.result.status, "failed");
    assert.equal(execRes.result.errorName, "WorkerWatchdogTimeoutError");
    assert.ok(execRes.cleanupActions.length >= 1);
    assert.equal(execRes.survivingOrphans, 0);

    await hangHost.disposeWorkerTree();
    report.tests.heartbeatHangWatchdog = {
      passed: true,
      errorName: execRes.result.errorName,
      errorMessage: execRes.result.errorMessage,
      cleanupActionsCount: execRes.cleanupActions.length,
      survivingOrphans: execRes.survivingOrphans,
    };
  }

  // Final process sweep sanity check
  const leftover = queryMediaAndWorkerProcesses().filter((p) =>
    (p.Name === "chrome-headless-shell.exe" || p.Name === "ffmpeg.exe") &&
    (p.CommandLine || "").toLowerCase().includes("sprint1-e2e")
  );
  report.finalResidualMediaProcesses = leftover.length;
  assert.equal(leftover.length, 0);

  const reportOut = path.join(workRoot, "sprint1_verification_report.json");
  fs.writeFileSync(reportOut, JSON.stringify(report, null, 2));
  console.log("=== SPRINT 1 E2E VERIFICATION PASSED ===");
  console.log(JSON.stringify(report, null, 2));
  return 0;
}
