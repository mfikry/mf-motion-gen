import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { screen } from "electron";
import { RenderLogStore } from "../../dist/main/logging/renderLogStore.js";
import { PreviewContainerManager } from "../../dist/main/preview/previewContainerManager.js";
import { RenderQueueManager } from "../../dist/main/render/renderQueueManager.js";
import { RenderWorkerHost } from "../../dist/main/render/renderWorkerHost.js";
import { queryMediaAndWorkerProcesses } from "../../dist/main/render/windowsProcessTree.js";
import { aggregateRuntimeTelemetry } from "../../dist/main/telemetry/runtimeTelemetryService.js";
import {
  APPROVED_REFERENCE_THRESHOLDS_1280X720_SDR,
  REFERENCE_PARITY_THRESHOLD_PROFILE_ID,
  analyzeAlphaPlaneBuffer,
  classifyRepeatRenderDeterminism,
  computeBufferSha256,
  computeFfmpegSsimAndPsnr,
  computeParitySamplePlan,
  computeRgbFrameDifference,
  computeVideoFrameHashes,
  decodeVideoFrameToPng,
  evaluateParityGateDetails,
  extractPngAlphaPlane,
  extractRawRgbBuffer,
  isFourKBenchmarkEnabled,
  normalizePngToResolution,
  probeVideoDetailed,
  resolvePngHeader,
} from "../../dist/main/verification/visualParity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const workRoot = path.join(repoRoot, "tmp", "sprint6d-e2e");
const artifactsDir = path.join(workRoot, "artifacts");
const rendersDir = path.join(workRoot, "renders");
const reportPath = path.join(workRoot, "workstream_d_parity_benchmark_report.json");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getRepoGitMetadata() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return {
    head: head.status === 0 ? head.stdout.trim() : "unknown",
    branch: branch.status === 0 ? branch.stdout.trim() : "unknown",
  };
}

function resolveLocalFontPath() {
  const candidates = [
    path.join(
      repoRoot,
      "poc",
      "hyperframes-spike",
      "node_modules",
      "hyperframes",
      "dist",
      "skills",
      "hyperframes",
      "assets",
      "frame-presets",
      "code-editorial",
      "fonts",
      "Inter-700.woff2"
    ),
    path.join(process.env.WINDIR || "C:\\Windows", "Fonts", "arial.ttf"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return {
        sourcePath: c,
        fileName: path.basename(c),
        format: c.endsWith(".woff2") ? "woff2" : "truetype",
      };
    }
  }
  throw new Error(`No deterministic local font found. Checked: ${candidates.join(", ")}`);
}

function writeDeterministicParityComposition(stageDir, { width, height, durationSec, fpsText, title }) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(stageDir, "fonts"), { recursive: true });

  fs.copyFileSync(
    path.join(repoRoot, "poc", "hyperframes-spike", "assets", "gsap.min.js"),
    path.join(stageDir, "assets", "gsap.min.js")
  );
  const font = resolveLocalFontPath();
  fs.copyFileSync(font.sourcePath, path.join(stageDir, "fonts", font.fileName));

  fs.writeFileSync(
    path.join(stageDir, "assets", "vector-badge.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140">
      <rect x="6" y="6" width="128" height="128" rx="22" fill="#0f172a" stroke="#38bdf8" stroke-width="6"/>
      <polygon points="70,26 108,104 32,104" fill="#22d3ee"/>
      <circle cx="70" cy="78" r="14" fill="#0b1324"/>
    </svg>`
  );

  const scaleX = width / 1280;
  const scaleY = height / 720;
  const pad = Math.round(64 * scaleX);
  const titleSize = Math.round(52 * scaleY);
  const barW = Math.round(240 * scaleX);
  const barH = Math.round(72 * scaleY);
  const travelX = Math.round(760 * scaleX);
  const calloutY = Math.round(470 * scaleY);

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @font-face {
      font-family: 'LocalTestSans';
      src: url('./fonts/${font.fileName}') format('${font.format}');
      font-weight: 700;
      font-style: normal;
      font-display: block;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; animation: none !important; transition: none !important; }
    html, body {
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      background: #0b1324;
      font-family: 'LocalTestSans', sans-serif;
    }
    #stage {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      background: linear-gradient(135deg, #0b1324 0%, #152544 55%, #0e1a33 100%);
      color: #f8fafc;
    }
    #panel {
      position: absolute;
      left: ${pad}px;
      top: ${pad}px;
      right: ${pad}px;
      bottom: ${pad}px;
      border: 2px solid #2b4570;
      border-radius: 18px;
      background: rgba(12, 22, 42, 0.88);
    }
    #title {
      position: absolute;
      left: ${Math.round(96 * scaleX)}px;
      top: ${Math.round(92 * scaleY)}px;
      font-size: ${titleSize}px;
      line-height: 1.1;
      letter-spacing: -0.01em;
      color: #e2e8f0;
      transform: rotate(-1.5deg);
    }
    #badgeImg {
      position: absolute;
      right: ${Math.round(110 * scaleX)}px;
      top: ${Math.round(96 * scaleY)}px;
      width: ${Math.round(140 * scaleX)}px;
      height: ${Math.round(140 * scaleX)}px;
    }
    #heroBar {
      position: absolute;
      left: ${Math.round(110 * scaleX)}px;
      top: ${Math.round(310 * scaleY)}px;
      width: ${barW}px;
      height: ${barH}px;
      border-radius: 14px;
      background: #38bdf8;
    }
    #midCallout {
      position: absolute;
      left: ${Math.round(110 * scaleX)}px;
      top: ${calloutY}px;
      padding: ${Math.round(16 * scaleY)}px ${Math.round(28 * scaleX)}px;
      border-radius: 12px;
      background: #f59e0b;
      color: #09111f;
      font-size: ${Math.round(28 * scaleY)}px;
      font-weight: 700;
      opacity: 0;
      visibility: hidden;
    }
  </style>
  <script src="./assets/gsap.min.js"></script>
</head>
<body>
  <div id="stage" data-composition-id="main" data-start="0" data-duration="${durationSec}" data-width="${width}" data-height="${height}" data-fps="${fpsText}">
    <div id="panel">
      <div id="title">${title}</div>
      <img id="badgeImg" src="./assets/vector-badge.svg" alt="badge" />
      <div id="heroBar"></div>
      <div id="midCallout">MIDPOINT VISIBLE</div>
    </div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.to("#heroBar", { x: ${travelX}, rotation: 90, duration: ${durationSec}, ease: "none" }, 0);
    tl.to("#badgeImg", { scale: 1.15, rotation: 45, duration: ${durationSec}, ease: "none" }, 0);
    tl.set("#midCallout", { autoAlpha: 1 }, ${(durationSec * 0.25).toFixed(4)});
    tl.set("#midCallout", { autoAlpha: 0 }, ${(durationSec * 0.75).toFixed(4)});
    window.__timelines["main"] = tl;
  </script>
</body>
</html>`;

  fs.writeFileSync(path.join(stageDir, "index.html"), html, "utf8");
}

function writeAlphaTestComposition(stageDir, { durationSec = 1, fpsText = "30" } = {}) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, "assets"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "poc", "hyperframes-spike", "assets", "gsap.min.js"),
    path.join(stageDir, "assets", "gsap.min.js")
  );

  // Strict pixel coordinates matching alpha region assertions (1280x720)
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; animation: none !important; transition: none !important; }
    html, body, #stage {
      width: 1280px;
      height: 720px;
      overflow: hidden;
      background: transparent !important;
      position: relative;
    }
    #opaqueBox {
      position: absolute;
      left: 420px;
      top: 80px;
      width: 360px;
      height: 220px;
      background: #00d2ff;
    }
    #semiBox {
      position: absolute;
      left: 420px;
      top: 340px;
      width: 360px;
      height: 220px;
      background: rgba(255, 64, 129, 0.5);
    }
    #alphaMover {
      position: absolute;
      left: 120px;
      top: 600px;
      width: 180px;
      height: 60px;
      background: #22c55e;
    }
  </style>
  <script src="./assets/gsap.min.js"></script>
</head>
<body>
  <div id="stage" data-composition-id="main" data-start="0" data-duration="${durationSec}" data-width="1280" data-height="720" data-fps="${fpsText}">
    <div id="opaqueBox"></div>
    <div id="semiBox"></div>
    <div id="alphaMover"></div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.to("#alphaMover", { x: 800, duration: ${durationSec}, ease: "none" }, 0);
    window.__timelines["main"] = tl;
  </script>
</body>
</html>`;

  fs.writeFileSync(path.join(stageDir, "index.html"), html, "utf8");
}

async function captureDeterministicPreviewPng(previewManager, session, timeSec, outPath) {
  await previewManager.seekPreview(session.sessionId, timeSec);
  await session.view.webContents.executeJavaScript(
    `document.fonts.ready.then(() => { void document.body.offsetHeight; return new Promise((resolve) => { let done = false; const finish = () => { if (!done) { done = true; resolve(true); } }; setTimeout(finish, 80); requestAnimationFrame(() => requestAnimationFrame(finish)); }); })`
  );
  await sleep(40);
  const nativeImg = await session.view.webContents.capturePage();
  const pngBuf = nativeImg.toPNG();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, pngBuf);
  return {
    pngPath: outPath,
    rawHeader: resolvePngHeader(pngBuf),
    dipSize: nativeImg.getSize(),
  };
}

function summarizeSampleMetrics(samples) {
  const ssims = samples.map((s) => s.ffmpeg.ssimAll);
  const maes = samples.map((s) => s.rgbDiff.maePerChannel);
  const rmses = samples.map((s) => s.rgbDiff.rmsePerChannel);
  const maxDiffs = samples.map((s) => s.rgbDiff.maxChannelDiff);
  const psnrs = samples.map((s) => s.ffmpeg.psnrDb).filter((v) => typeof v === "number" && Number.isFinite(v));

    const mean = (arr) => Number((arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length)).toFixed(6));
  return {
    sampleCount: samples.length,
    minSsim: Math.min(...ssims),
    meanSsim: mean(ssims),
    minPsnrDb: psnrs.length > 0 ? Math.min(...psnrs) : null,
    anyPsnrInfinite: samples.some((s) => s.ffmpeg.psnrInfinite),
    meanMaePerChannel: Number(mean(maes).toFixed(4)),
    maxMaePerChannel: Math.max(...maes),
    meanRmsePerChannel: Number(mean(rmses).toFixed(4)),
    worstMaxChannelDiff: Math.max(...maxDiffs),
  };
}

function findStageThroughputFromLog(logSummary, actualFrameCount, wallMs) {
  const overallFps = wallMs > 0 ? Number((actualFrameCount / (wallMs / 1000)).toFixed(2)) : null;
  if (!logSummary || !Array.isArray(logSummary.stageHistory) || logSummary.stageHistory.length === 0) {
    return {
      captureThroughputFps: null,
      encodeThroughputFps: null,
      overallThroughputFps: overallFps,
      stageTimingsMs: {},
    };
  }

  const history = logSummary.stageHistory;
  const stageDurationsMs = {};
  for (let i = 0; i < history.length; i++) {
    const cur = history[i];
    const nextElapsed = i + 1 < history.length ? history[i + 1].elapsedMs : wallMs;
    const dur = Math.max(1, nextElapsed - cur.elapsedMs);
    stageDurationsMs[cur.stage] = (stageDurationsMs[cur.stage] ?? 0) + dur;
  }

  const captureMs = stageDurationsMs.capture ?? null;
  const encodeMs = stageDurationsMs.encode ?? null;
  return {
    captureThroughputFps:
      captureMs && captureMs > 0 ? Number((actualFrameCount / (captureMs / 1000)).toFixed(2)) : null,
    encodeThroughputFps:
      encodeMs && encodeMs > 0 ? Number((actualFrameCount / (encodeMs / 1000)).toFixed(2)) : null,
    overallThroughputFps: overallFps,
    stageTimingsMs: stageDurationsMs,
  };
}

export async function runElectronVerification({ app, BrowserWindow, RenderCoordinator, PINNED_RUNTIME }) {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.mkdirSync(rendersDir, { recursive: true });

  const consoleErrors = [];
  const unhandledRejections = [];
  process.on("unhandledRejection", (reason) => unhandledRejections.push(String(reason)));

  const baselineProcs = queryMediaAndWorkerProcesses().map((p) => p.ProcessId);
  const gitMeta = getRepoGitMetadata();
  const displayScaleFactor = screen.getPrimaryDisplay().scaleFactor;

  const parityStageDir = path.join(workRoot, "stage-parity-720p");
  writeDeterministicParityComposition(parityStageDir, {
    width: 1280,
    height: 720,
    durationSec: 2,
    fpsText: "30",
    title: "MF MOTION PARITY 720P",
  });

  const alphaStageDir = path.join(workRoot, "stage-alpha-720p");
  writeAlphaTestComposition(alphaStageDir, { durationSec: 1, fpsText: "30" });

  const bench1080Dir = path.join(workRoot, "stage-bench-1080p30");
  writeDeterministicParityComposition(bench1080Dir, {
    width: 1920,
    height: 1080,
    durationSec: 3,
    fpsText: "30",
    title: "MF BENCHMARK 1080P30",
  });

  const logStore = new RenderLogStore();
  const workerHost = new RenderWorkerHost({ workerReadyTimeoutMs: 30_000 });
  const coordinator = new RenderCoordinator(workerHost);
  const previewManager = new PreviewContainerManager();
  const queueManager = new RenderQueueManager({
    runner: coordinator,
    logStore,
  });

  // Host BrowserWindow sized 1280x720 content area for 1:1 Preview capture
  const hostWin = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#0b1324",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
    },
  });
  hostWin.webContents.on("console-message", (details) => {
    if (details.level >= 3) consoleErrors.push(details.message);
  });
  await hostWin.loadURL("about:blank");
  previewManager.attachHostWindow(hostWin);
  previewManager.setViewport({ x: 0, y: 0, width: 1280, height: 720 }, "100");

  // --- 1. Isolated Preview Session + Backward Seek & Capture Geometry ---
  const openRes = await previewManager.openVerifiedDirectory(parityStageDir, {
    entryFile: "index.html",
    title: "Workstream D 720p Parity",
    sourceMode: "original_file",
  });
  assert.equal(openRes.ok, true, "Parity composition must pass preflight cleanly");

  const session = previewManager.getActiveSession();
  assert.ok(session, "Active isolated Preview session must exist");
  if (typeof session.view.webContents.setBackgroundThrottling === "function") {
    session.view.webContents.setBackgroundThrottling(false);
  }
  previewManager.setViewport({ x: 0, y: 0, width: 1280, height: 720 }, "100");
  await session.view.webContents.executeJavaScript(
    `new Promise((resolve) => { let done = false; const finish = () => { if (!done) { done = true; resolve(true); } }; setTimeout(finish, 80); requestAnimationFrame(() => requestAnimationFrame(finish)); })`
  );
  await sleep(100);
  console.log("[WD] Isolated preview session ready; capturing backward-seek frames...");

  const previewEnv = await session.view.webContents.executeJavaScript(`(() => {
    return document.fonts.ready.then(() => ({
      origin: location.origin,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      fontsLoadedCount: document.fonts.size,
      typeofRequire: typeof require,
      typeofProcess: typeof process,
      typeofMfStudio: typeof window.mfStudio
    }));
  })()`);
  const viewBounds = session.view.getBounds();
  const zoomFactor = session.view.webContents.getZoomFactor();
  assert.equal(previewEnv.origin, `mf-asset://${session.sessionId}`);
  assert.equal(
    previewEnv.innerWidth,
    1280,
    `Expected innerWidth=1280; got ${previewEnv.innerWidth}, bounds=${JSON.stringify(viewBounds)}, zoom=${zoomFactor}, displayScale=${displayScaleFactor}`
  );
  assert.equal(
    previewEnv.innerHeight,
    720,
    `Expected innerHeight=720; got ${previewEnv.innerHeight}, bounds=${JSON.stringify(viewBounds)}, zoom=${zoomFactor}`
  );
  assert.equal(previewEnv.typeofRequire, "undefined");
  assert.equal(previewEnv.typeofProcess, "undefined");
  assert.equal(previewEnv.typeofMfStudio, "undefined");

  const fps30 = { num: 30, den: 1 };
  const initialSamplePlan = computeParitySamplePlan(60, fps30);
  const backwardCaptures = {};

  for (const stepSpec of initialSamplePlan.backwardSeekSequence) {
    const rawPath = path.join(artifactsDir, `preview_raw_${stepSpec.step}_f${stepSpec.frameIndex}.png`);
    const normPath = path.join(artifactsDir, `preview_norm_${stepSpec.step}_f${stepSpec.frameIndex}.png`);
    const cap = await captureDeterministicPreviewPng(previewManager, session, stepSpec.timeSec, rawPath);
    const norm = normalizePngToResolution(rawPath, normPath, 1280, 720);
    const rawRgb = extractRawRgbBuffer(normPath);
    backwardCaptures[stepSpec.step] = {
      frameIndex: stepSpec.frameIndex,
      timeSec: stepSpec.timeSec,
      rawPath,
      normPath,
      rawHeader: cap.rawHeader,
      dipSize: cap.dipSize,
      normalization: norm,
      rgbSha256: computeBufferSha256(rawRgb.data),
    };
  }

  // Backward-seek determinism assertion: middle_initial === middle_repeat
  const midRgbA = extractRawRgbBuffer(backwardCaptures.middle_initial.normPath);
  const midRgbB = extractRawRgbBuffer(backwardCaptures.middle_repeat.normPath);
  const backwardDiff = computeRgbFrameDifference(midRgbA.data, midRgbB.data, 1280, 720);
  const backwardFfmpeg = computeFfmpegSsimAndPsnr(
    backwardCaptures.middle_initial.normPath,
    backwardCaptures.middle_repeat.normPath
  );
  const backwardBitIdentical =
    backwardCaptures.middle_initial.rgbSha256 === backwardCaptures.middle_repeat.rgbSha256;
  const backwardVisualDeterministic =
    Number.isFinite(backwardFfmpeg.ssimAll) &&
    backwardFfmpeg.ssimAll >= 0.9999 &&
    backwardDiff.maePerChannel <= 0.001 &&
    backwardDiff.maxChannelDiff <= 2 &&
    backwardDiff.pctWithinTol2 === 100;
  const backwardSeekClassification = backwardBitIdentical
    ? "BIT_IDENTICAL"
    : backwardVisualDeterministic
      ? "VISUAL_EQUIVALENT_NO_STATE_DRIFT"
      : "DRIFT_DETECTED";
  assert.equal(
    backwardVisualDeterministic,
    true,
    `Backward Preview seek failed determinism bounds: SSIM=${backwardFfmpeg.ssimAll}, MAE=${backwardDiff.maePerChannel}, maxDiff=${backwardDiff.maxChannelDiff}, pctWithinTol2=${backwardDiff.pctWithinTol2}`
  );
  assert.notEqual(
    backwardCaptures.first.rgbSha256,
    backwardCaptures.middle_initial.rgbSha256,
    "First and middle Preview captures must differ visually"
  );
  assert.notEqual(
    backwardCaptures.middle_initial.rgbSha256,
    backwardCaptures.last.rgbSha256,
    "Middle and last Preview captures must differ visually"
  );
  console.log(
    `[WD] Backward seek verified (${backwardSeekClassification}, SSIM=${backwardFfmpeg.ssimAll}, MAE=${backwardDiff.maePerChannel}); rendering MP4 Run A/B & MOV Run A/B...`
  );

  // Also check transient callout visibility across frames in Preview (hidden at f0, visible at f30, hidden at f59)
  await previewManager.seekPreview(session.sessionId, initialSamplePlan.samples.first.timeSec);
  const visFirst = await session.view.webContents.executeJavaScript(
    `getComputedStyle(document.getElementById("midCallout")).opacity`
  );
  await previewManager.seekPreview(session.sessionId, initialSamplePlan.samples.middle.timeSec);
  const visMid = await session.view.webContents.executeJavaScript(
    `getComputedStyle(document.getElementById("midCallout")).opacity`
  );
  await previewManager.seekPreview(session.sessionId, initialSamplePlan.samples.last.timeSec);
  const visLast = await session.view.webContents.executeJavaScript(
    `getComputedStyle(document.getElementById("midCallout")).opacity`
  );
  assert.equal(visFirst, "0", "Transient element must be hidden on first frame");
  assert.equal(visMid, "1", "Transient element must be visible on middle frame");
  assert.equal(visLast, "0", "Transient element must be hidden on last frame");

  // --- 2. Render MP4 H.264 (Run A + Run B) & ProRes 4444 MOV (Run A + Run B) ---
  async function enqueueAndAwaitRender({ jobId, stageDir, sessionId, title, format, fps, outputPath, onTickTelemetry }) {
    const telemetrySamples = [];
    let timer = null;
    if (onTickTelemetry) {
      telemetrySamples.push(
        aggregateRuntimeTelemetry({
          metrics: app.getAppMetrics(),
          pollIntervalMs: 250,
          queue: { activeCount: 1, queuedCount: 0, activeJobId: jobId },
          activeRender: null,
        })
      );
      timer = setInterval(() => {
        telemetrySamples.push(
          aggregateRuntimeTelemetry({
            metrics: app.getAppMetrics(),
            pollIntervalMs: 250,
            queue: { activeCount: 1, queuedCount: 0, activeJobId: jobId },
            activeRender: null,
          })
        );
      }, 250);
    }

    const { completion } = queueManager.enqueue({
      sessionId,
      title,
      request: {
        jobId,
        stageDir,
        outputPath,
        format,
        quality: "standard",
        fps,
        strictness: "strict",
        proresProfile: format === "mov" ? "4444" : undefined,
      },
    });
    const res = await completion;
    if (timer) clearInterval(timer);
    if (onTickTelemetry) {
      telemetrySamples.push(
        aggregateRuntimeTelemetry({
          metrics: app.getAppMetrics(),
          pollIntervalMs: 250,
          queue: { activeCount: 0, queuedCount: 0, activeJobId: null },
          activeRender: null,
        })
      );
    }
    return { res, logSummary: logStore.getJobLog(jobId), telemetrySamples };
  }

  const mp4PathA = path.join(rendersDir, "parity_720p30_runA.mp4");
  const mp4PathB = path.join(rendersDir, "parity_720p30_runB.mp4");
  const movPathA = path.join(rendersDir, "parity_720p30_prores4444_runA.mov");
  const movPathB = path.join(rendersDir, "parity_720p30_prores4444_runB.mov");

  const mp4RunA = await enqueueAndAwaitRender({
    jobId: "wd_mp4_runA",
    stageDir: parityStageDir,
    sessionId: "wd-parity-session",
    title: "WD Parity MP4 Run A",
    format: "mp4",
    fps: fps30,
    outputPath: mp4PathA,
  });
  assert.equal(mp4RunA.res.status, "complete", `MP4 Run A failed: ${mp4RunA.res.errorMessage}`);

  const mp4RunB = await enqueueAndAwaitRender({
    jobId: "wd_mp4_runB",
    stageDir: parityStageDir,
    sessionId: "wd-parity-session",
    title: "WD Parity MP4 Run B",
    format: "mp4",
    fps: fps30,
    outputPath: mp4PathB,
  });
  assert.equal(mp4RunB.res.status, "complete", `MP4 Run B failed: ${mp4RunB.res.errorMessage}`);

  const movRunA = await enqueueAndAwaitRender({
    jobId: "wd_mov_runA",
    stageDir: parityStageDir,
    sessionId: "wd-parity-session",
    title: "WD Parity MOV Run A",
    format: "mov",
    fps: fps30,
    outputPath: movPathA,
  });
  assert.equal(movRunA.res.status, "complete", `MOV Run A failed: ${movRunA.res.errorMessage}`);

  const movRunB = await enqueueAndAwaitRender({
    jobId: "wd_mov_runB",
    stageDir: parityStageDir,
    sessionId: "wd-parity-session",
    title: "WD Parity MOV Run B",
    format: "mov",
    fps: fps30,
    outputPath: movPathB,
  });
  assert.equal(movRunB.res.status, "complete", `MOV Run B failed: ${movRunB.res.errorMessage}`);

  // --- 3. Compare Preview vs Export per Codec Separately ---
  function evaluateCodecParity(codecLabel, videoPath, prefix) {
    const probe = probeVideoDetailed(videoPath);
    assert.equal(probe.width, 1280, `${codecLabel} width mismatch`);
    assert.equal(probe.height, 720, `${codecLabel} height mismatch`);
    assert.equal(probe.actualFrameCount, 60, `${codecLabel} actual frame count mismatch`);
    assert.equal(probe.rFrameRate, "30/1", `${codecLabel} rFrameRate mismatch`);

    const plan = computeParitySamplePlan(probe.actualFrameCount, fps30);
    const previewSampleMap = {
      first: backwardCaptures.first,
      middle: backwardCaptures.middle_initial,
      last: backwardCaptures.last,
    };

    const samples = [];
    for (const pt of [plan.samples.first, plan.samples.middle, plan.samples.last]) {
      const exportPng = path.join(artifactsDir, `${prefix}_export_${pt.label}_f${pt.frameIndex}.png`);
      const decodeHeader = decodeVideoFrameToPng(videoPath, pt.frameIndex, exportPng, "rgb24");
      assert.equal(decodeHeader.width, 1280);
      assert.equal(decodeHeader.height, 720);

      const prevRef = previewSampleMap[pt.label];
      const ffmpegMetrics = computeFfmpegSsimAndPsnr(prevRef.normPath, exportPng);
      const bufPrev = extractRawRgbBuffer(prevRef.normPath);
      const bufExp = extractRawRgbBuffer(exportPng);
      const rgbDiff = computeRgbFrameDifference(bufPrev.data, bufExp.data, 1280, 720);

      assert.ok(Number.isFinite(ffmpegMetrics.ssimAll), `${codecLabel} SSIM must be finite`);
      assert.ok(Number.isFinite(rgbDiff.maePerChannel), `${codecLabel} MAE must be finite`);

      samples.push({
        label: pt.label,
        frameIndex: pt.frameIndex,
        timeSec: pt.timeSec,
        previewRawPngPath: prevRef.rawPath,
        previewNormalizedPngPath: prevRef.normPath,
        previewRawDimension: { width: prevRef.rawHeader.width, height: prevRef.rawHeader.height },
        previewNormalization: prevRef.normalization,
        exportDecodedPngPath: exportPng,
        exportDecodedDimension: { width: decodeHeader.width, height: decodeHeader.height },
        ffmpeg: ffmpegMetrics,
        rgbDiff,
      });
    }

    const summary = summarizeSampleMetrics(samples);
    const codecThreshold =
      codecLabel === "MP4_H264"
        ? APPROVED_REFERENCE_THRESHOLDS_1280X720_SDR.MP4_H264
        : APPROVED_REFERENCE_THRESHOLDS_1280X720_SDR.MOV_PRORES_4444;

    const gateEval = evaluateParityGateDetails(
      samples.map((s) => ({
        label: s.label,
        frameIndex: s.frameIndex,
        ssimAll: s.ffmpeg.ssimAll,
        psnrDb: s.ffmpeg.psnrDb,
        psnrInfinite: s.ffmpeg.psnrInfinite,
        maePerChannel: s.rgbDiff.maePerChannel,
        pctWithinTol2: s.rgbDiff.pctWithinTol2,
        pctWithinTol5: s.rgbDiff.pctWithinTol5,
      })),
      codecThreshold
    );

    assert.equal(
      gateEval.status,
      "PASS",
      `${codecLabel} failed parity gate (${codecThreshold.thresholdProfileId}): ${JSON.stringify(gateEval)}`
    );

    return {
      codecLabel,
      thresholdProfileId: codecThreshold.thresholdProfileId,
      streamMetadata: probe,
      encoderConfiguration: {
        engine: `HyperFrames ${PINNED_RUNTIME.hyperframesEngineVersion} / Producer ${PINNED_RUNTIME.hyperframesProducerVersion}`,
        format: codecLabel === "MP4_H264" ? "mp4" : "mov",
        qualityPreset: "standard",
        fps: fps30,
        proresProfile: codecLabel === "MOV_PRORES_4444" ? "4444" : null,
      },
      decoderConfiguration: {
        tool: "ffmpeg",
        frameSelectionFilter: "select=eq(n,<idx>) -vsync vfr -pix_fmt rgb24",
        comparisonPixelFormat: "rgb24",
      },
      samples,
      summary,
      parityGateStatus: gateEval.status,
      parityGateEvaluation: gateEval,
      thresholdBasis: {
        source: "pm_approved_reference_threshold",
        thresholdProfileId: codecThreshold.thresholdProfileId,
        threshold: codecThreshold,
      },
    };
  }

  const mp4ParityReport = evaluateCodecParity("MP4_H264", mp4PathA, "mp4");
  const movParityReport = evaluateCodecParity("MOV_PRORES_4444", movPathA, "mov");

  // --- 4. Repeat-Render Determinism (MP4 A vs B & MOV A vs B) ---
  function evaluateRepeatDeterminism(label, pathA, pathB, prefix) {
    const hashesA = computeVideoFrameHashes(pathA);
    const hashesB = computeVideoFrameHashes(pathB);
    assert.equal(hashesA.length, 60, `${label} Run A decoded frame hashes must equal 60`);
    assert.equal(hashesB.length, 60, `${label} Run B decoded frame hashes must equal 60`);

    const probeA = probeVideoDetailed(pathA);
    const plan = computeParitySamplePlan(probeA.actualFrameCount, fps30);
    const samplePairs = [];

    for (const pt of [plan.samples.first, plan.samples.middle, plan.samples.last]) {
      const pngA = path.join(artifactsDir, `${prefix}_detA_${pt.label}_f${pt.frameIndex}.png`);
      const pngB = path.join(artifactsDir, `${prefix}_detB_${pt.label}_f${pt.frameIndex}.png`);
      decodeVideoFrameToPng(pathA, pt.frameIndex, pngA, "rgb24");
      decodeVideoFrameToPng(pathB, pt.frameIndex, pngB, "rgb24");
      const ffmpegMetrics = computeFfmpegSsimAndPsnr(pngA, pngB);
      const rawA = extractRawRgbBuffer(pngA);
      const rawB = extractRawRgbBuffer(pngB);
      const rgbDiff = computeRgbFrameDifference(rawA.data, rawB.data, 1280, 720);
      samplePairs.push({
        label: pt.label,
        frameIndex: pt.frameIndex,
        timeSec: pt.timeSec,
        hashA: hashesA[pt.frameIndex].hash,
        hashB: hashesB[pt.frameIndex].hash,
        hashEqual: hashesA[pt.frameIndex].hash === hashesB[pt.frameIndex].hash,
        ffmpeg: ffmpegMetrics,
        rgbDiff,
      });
    }

    const summary = classifyRepeatRenderDeterminism({
      hashesA,
      hashesB,
      sampleVisualMetrics: samplePairs.map((s) => ({
        ssimAll: s.ffmpeg.ssimAll,
        maePerChannel: s.rgbDiff.maePerChannel,
      })),
    });

    assert.notEqual(
      summary.classification,
      "NON_DETERMINISTIC",
      `${label} repeat render must not be NON_DETERMINISTIC: ${summary.notes}`
    );

    return {
      label,
      ...summary,
      samplePairs,
    };
  }

  const mp4Determinism = evaluateRepeatDeterminism("MP4_H264", mp4PathA, mp4PathB, "mp4");
  const movDeterminism = evaluateRepeatDeterminism("MOV_PRORES_4444", movPathA, movPathB, "mov");

  // --- 5. Dedicated ProRes 4444 Alpha Channel Integrity ---
  const alphaMovPath = path.join(rendersDir, "alpha_prores4444_720p30.mov");
  const alphaRun = await enqueueAndAwaitRender({
    jobId: "wd_alpha_prores",
    stageDir: alphaStageDir,
    sessionId: "wd-alpha-session",
    title: "WD Alpha ProRes 4444",
    format: "mov",
    fps: fps30,
    outputPath: alphaMovPath,
  });
  assert.equal(alphaRun.res.status, "complete", `Alpha MOV render failed: ${alphaRun.res.errorMessage}`);

  const alphaProbe = probeVideoDetailed(alphaMovPath);
  assert.equal(alphaProbe.actualFrameCount, 30);
  assert.match(alphaProbe.pixFmt || "", /^yuva444p/, "ProRes 4444 alpha render must have yuva444p* pix_fmt");

  const alphaPlan = computeParitySamplePlan(alphaProbe.actualFrameCount, fps30);
  const alphaRegions = [
    { label: "top_left_transparent", expectedKind: "transparent", x: 20, y: 20, width: 320, height: 200 },
    { label: "opaque_cyan_box", expectedKind: "opaque", x: 440, y: 100, width: 320, height: 180 },
    { label: "semi_pink_box", expectedKind: "semi", x: 440, y: 360, width: 320, height: 180 },
  ];

  const alphaFrameReports = [];
  for (const pt of [alphaPlan.samples.first, alphaPlan.samples.middle, alphaPlan.samples.last]) {
    const rgbaPng = path.join(artifactsDir, `alpha_rgba_${pt.label}_f${pt.frameIndex}.png`);
    const alphaVisualPng = path.join(artifactsDir, `alpha_plane_${pt.label}_f${pt.frameIndex}.png`);
    const hdr = decodeVideoFrameToPng(alphaMovPath, pt.frameIndex, rgbaPng, "rgba");
    assert.equal(hdr.colorType, 6, "Decoded RGBA PNG must retain alpha channel (colorType=6)");

    // Save extracted grayscale alpha image for PM inspection
    spawnSync("ffmpeg", ["-y", "-v", "error", "-i", rgbaPng, "-vf", "alphaextract", "-pix_fmt", "gray", alphaVisualPng]);

    const { width, height, alphaPlane } = extractPngAlphaPlane(rgbaPng);
    const stats = analyzeAlphaPlaneBuffer(alphaPlane, width, height, alphaRegions);
    assert.equal(stats.passed, true, `Alpha integrity failed at frame ${pt.frameIndex}: ${JSON.stringify(stats)}`);
    alphaFrameReports.push({
      label: pt.label,
      frameIndex: pt.frameIndex,
      timeSec: pt.timeSec,
      rgbaPngPath: rgbaPng,
      alphaVisualPngPath: alphaVisualPng,
      stats,
    });
  }

  // --- 6. Mandatory 1080p30 Benchmark ---
  const bench1080Path = path.join(rendersDir, "benchmark_1080p30.mp4");
  const bench1080Run = await enqueueAndAwaitRender({
    jobId: "wd_bench_1080p30",
    stageDir: bench1080Dir,
    sessionId: "wd-bench-1080p30",
    title: "WD Benchmark 1080p30",
    format: "mp4",
    fps: fps30,
    outputPath: bench1080Path,
    onTickTelemetry: true,
  });
  assert.equal(bench1080Run.res.status, "complete", `1080p30 benchmark failed: ${bench1080Run.res.errorMessage}`);

  const bench1080Probe = probeVideoDetailed(bench1080Path);
  assert.equal(bench1080Probe.width, 1920);
  assert.equal(bench1080Probe.height, 1080);
  assert.equal(bench1080Probe.actualFrameCount, 90);
  assert.equal(bench1080Probe.rFrameRate, "30/1");

  const memSamples = bench1080Run.telemetrySamples
    .map((s) => s.totalWorkingSetMB)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  const throughput1080 = findStageThroughputFromLog(bench1080Run.logSummary, 90, bench1080Run.res.wallMs);

  const benchmark1080p30 = {
    resolution: "1920x1080",
    fps: "30/1",
    durationSec: 3,
    expectedFrames: 90,
    actualFrames: bench1080Probe.actualFrameCount,
    quality: "standard",
    wallClockRenderMs: bench1080Run.res.wallMs,
    captureThroughputFps: throughput1080.captureThroughputFps,
    encodeThroughputFps: throughput1080.encodeThroughputFps,
    overallThroughputFps: throughput1080.overallThroughputFps,
    stageTimingsMs: throughput1080.stageTimingsMs,
    electronMemoryMB: {
      sampleCount: memSamples.length,
      initialWorkingSetMB: memSamples[0] ?? null,
      averageWorkingSetMB:
        memSamples.length > 0 ? Number((memSamples.reduce((a, b) => a + b, 0) / memSamples.length).toFixed(2)) : null,
      peakWorkingSetMB: memSamples.length > 0 ? Math.max(...memSamples) : null,
    },
    peakExternalWorkerMemoryMB: null,
    externalWorkerMemoryNote: "N/A — app.getAppMetrics() covers Electron processes only, excluding chrome-headless-shell.exe & ffmpeg.exe.",
    outputFile: {
      path: bench1080Path,
      sizeBytes: bench1080Probe.fileSizeBytes,
      codec: bench1080Probe.codecName,
      pixFmt: bench1080Probe.pixFmt,
      rFrameRate: bench1080Probe.rFrameRate,
      avgFrameRate: bench1080Probe.avgFrameRate,
    },
  };

  // --- 7. Optional 4K Benchmark (Strictly opt-in via MF_RUN_4K_BENCHMARK=1) ---
  let benchmark4KReport;
  if (!isFourKBenchmarkEnabled()) {
    benchmark4KReport = {
      enabled: false,
      status: "SKIPPED_BY_DEFAULT",
      reason: "Optional 4K30/4K60 benchmarks require MF_RUN_4K_BENCHMARK=1.",
    };
  } else {
    const fourKCases = [];
    for (const cfg of [
      { id: "4k30", width: 3840, height: 2160, fps: { num: 30, den: 1 }, fpsText: "30", durationSec: 1, expectedFrames: 30 },
      { id: "4k60", width: 3840, height: 2160, fps: { num: 60, den: 1 }, fpsText: "60", durationSec: 1, expectedFrames: 60 },
    ]) {
      const stageDir4k = path.join(workRoot, `stage-bench-${cfg.id}`);
      const out4k = path.join(rendersDir, `benchmark_${cfg.id}.mp4`);
      writeDeterministicParityComposition(stageDir4k, {
        width: cfg.width,
        height: cfg.height,
        durationSec: cfg.durationSec,
        fpsText: cfg.fpsText,
        title: `MF BENCHMARK ${cfg.id.toUpperCase()}`,
      });
      const run4k = await enqueueAndAwaitRender({
        jobId: `wd_bench_${cfg.id}`,
        stageDir: stageDir4k,
        sessionId: `wd-bench-${cfg.id}`,
        title: `WD Benchmark ${cfg.id}`,
        format: "mp4",
        fps: cfg.fps,
        outputPath: out4k,
        onTickTelemetry: true,
      });
      assert.equal(run4k.res.status, "complete", `4K benchmark ${cfg.id} failed: ${run4k.res.errorMessage}`);
      const probe4k = probeVideoDetailed(out4k);
      assert.equal(probe4k.width, 3840);
      assert.equal(probe4k.height, 2160);
      assert.equal(probe4k.actualFrameCount, cfg.expectedFrames);
      const t4k = findStageThroughputFromLog(run4k.logSummary, cfg.expectedFrames, run4k.res.wallMs);
      const m4k = run4k.telemetrySamples.map((s) => s.totalWorkingSetMB).filter((v) => typeof v === "number");
      fourKCases.push({
        profile: cfg.id,
        resolution: "3840x2160",
        fps: `${cfg.fps.num}/${cfg.fps.den}`,
        expectedFrames: cfg.expectedFrames,
        actualFrames: probe4k.actualFrameCount,
        wallClockRenderMs: run4k.res.wallMs,
        captureThroughputFps: t4k.captureThroughputFps,
        encodeThroughputFps: t4k.encodeThroughputFps,
        overallThroughputFps: t4k.overallThroughputFps,
        peakElectronWorkingSetMB: m4k.length > 0 ? Math.max(...m4k) : null,
        peakExternalWorkerMemoryMB: null,
        fileSizeBytes: probe4k.fileSizeBytes,
      });
    }
    benchmark4KReport = {
      enabled: true,
      status: "COMPLETED",
      profiles: fourKCases,
    };
  }

  // Cleanup preview + worker + check residual processes
  await previewManager.disposeActiveSession();
  await queueManager.shutdown();
  await coordinator.shutdown();
  hostWin.destroy();

  await sleep(300);
  const residualAfter = queryMediaAndWorkerProcesses().filter((p) => {
    if (baselineProcs.includes(p.ProcessId)) return false;
    const cmd = (p.CommandLine || "").toLowerCase();
    return (
      p.Name === "chrome-headless-shell.exe" ||
      p.Name === "ffmpeg.exe" ||
      cmd.includes("mf-motion-gen") ||
      cmd.includes("sprint6d-e2e") ||
      p.ParentProcessId === process.pid
    );
  });
  assert.equal(
    residualAfter.length,
    0,
    `Leaked media/worker processes after Workstream D E2E: ${JSON.stringify(residualAfter)}`
  );
  assert.equal(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join(" | ")}`);
  assert.equal(unhandledRejections.length, 0, `Unhandled rejections: ${unhandledRejections.join(" | ")}`);

  const finalReport = {
    schemaVersion: "workstream-d-v1",
    thresholdProfileId: REFERENCE_PARITY_THRESHOLD_PROFILE_ID,
    timestamp: new Date().toISOString(),
    repository: gitMeta,
    pinnedRuntime: PINNED_RUNTIME,
    environment: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      primaryDisplayScaleFactor: displayScaleFactor,
      previewDomViewport: {
        innerWidth: previewEnv.innerWidth,
        innerHeight: previewEnv.innerHeight,
        devicePixelRatio: previewEnv.devicePixelRatio,
        fontsLoadedCount: previewEnv.fontsLoadedCount,
      },
      previewSecurityVerified: {
        origin: previewEnv.origin,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        typeofRequire: previewEnv.typeofRequire,
        typeofProcess: previewEnv.typeofProcess,
        typeofMfStudio: previewEnv.typeofMfStudio,
      },
    },
    backwardSeekVerification: {
      sequence: ["middle_initial", "first", "last", "middle_repeat"],
      middleInitialSha256: backwardCaptures.middle_initial.rgbSha256,
      middleRepeatSha256: backwardCaptures.middle_repeat.rgbSha256,
      bitIdenticalRepeatCapture: backwardBitIdentical,
      classification: backwardSeekClassification,
      ffmpegMetrics: backwardFfmpeg,
      rgbDiff: backwardDiff,
      transientDomOpacityChecks: {
        firstFrameOpacity: visFirst,
        middleFrameOpacity: visMid,
        lastFrameOpacity: visLast,
      },
    },
    mp4Parity: mp4ParityReport,
    prores4444Parity: movParityReport,
    alphaVerification: {
      passed: alphaFrameReports.every((r) => r.stats.passed),
      streamPixFmt: alphaProbe.pixFmt,
      actualFrameCount: alphaProbe.actualFrameCount,
      limitationNote:
        "Preview-vs-Export alpha channel parity is NOT claimed because Electron capturePage() composites over the host window background. Alpha integrity is verified directly by decoding ProRes 4444 frames in rgba and inspecting alphaextract planes.",
      frames: alphaFrameReports,
    },
    repeatDeterminism: {
      mp4H264: mp4Determinism,
      prores4444Mov: movDeterminism,
    },
    benchmark1080p30,
    benchmark4K: benchmark4KReport,
    artifactsDirectory: artifactsDir,
    rendersDirectory: rendersDir,
    residualProcesses: residualAfter.length,
    knownLimitations: [
      "Calibrated threshold profile mf-v2-reference-1280x720-sdr-v1 applies strictly to Sprint 6 reference fixture (1280x720, 30/1 FPS, SDR rgb24, samples 0/30/59); it does not imply identical SSIM on arbitrary user HTML or 1080p/4K outputs.",
      "Preview capture via Electron WebContentsView.capturePage() is 8-bit SDR RGB and does not expose independent alpha transparency; ProRes 4444 alpha is verified independently on decoded export frames.",
      "app.getAppMetrics() measures Electron browser/renderer/utility/GPU working set only; external chrome-headless-shell.exe and ffmpeg.exe RAM remain reported as N/A.",
      "Host Chromium capturePage() rasterization pipeline uses Electron 45 (in-window GPU/compositor) while Producer export uses chrome-headless-shell@158, which can introduce minor subpixel font/gradient rasterization differences.",
    ],
  };

  fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2), "utf8");

  console.log("=== SPRINT 6 WORKSTREAM D PARITY & BENCHMARK E2E PASSED ===");
  console.log(
    JSON.stringify(
      {
        reportPath,
        thresholdProfileId: REFERENCE_PARITY_THRESHOLD_PROFILE_ID,
        mp4Gate: mp4ParityReport.parityGateStatus,
        mp4Summary: mp4ParityReport.summary,
        proresGate: movParityReport.parityGateStatus,
        proresSummary: movParityReport.summary,
        alphaPassed: finalReport.alphaVerification.passed,
        backwardSeekClassification,
        backwardSeekBitIdentical: backwardBitIdentical,
        mp4Determinism: mp4Determinism.classification,
        movDeterminism: movDeterminism.classification,
        benchmark1080p30: {
          wallClockRenderMs: benchmark1080p30.wallClockRenderMs,
          actualFrames: benchmark1080p30.actualFrames,
          captureThroughputFps: benchmark1080p30.captureThroughputFps,
          encodeThroughputFps: benchmark1080p30.encodeThroughputFps,
          overallThroughputFps: benchmark1080p30.overallThroughputFps,
          peakElectronMB: benchmark1080p30.electronMemoryMB.peakWorkingSetMB,
        },
        benchmark4KStatus: benchmark4KReport.status,
        residualProcesses: residualAfter.length,
      },
      null,
      2
    )
  );
  return 0;
}
