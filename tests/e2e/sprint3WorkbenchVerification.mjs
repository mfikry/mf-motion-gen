import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerStudioIpcHandlers } from "../../dist/main/ipc/studioIpcHandler.js";
import { PreviewContainerManager } from "../../dist/main/preview/previewContainerManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const workRoot = path.join(repoRoot, "tmp", "sprint3-e2e");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ffprobeJson(filePath) {
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
    { encoding: "utf8" }
  );
  if (res.status !== 0) throw new Error(`ffprobe failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function writeRationalComposition(stageDir, { withMarkers = false, durationSec = 2 } = {}) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, "assets"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "poc", "hyperframes-spike", "assets", "gsap.min.js"),
    path.join(stageDir, "assets", "gsap.min.js")
  );
  fs.writeFileSync(
    path.join(stageDir, "assets", "dot.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#38bdf8"/></svg>`
  );

  const markerBlock = withMarkers ? `tl.addLabel("mid", 1.0);` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    html, body { margin: 0; width: 1280px; height: 720px; background: transparent; overflow: hidden; }
    #stage { position: relative; width: 1280px; height: 720px; background: rgba(10, 18, 36, 0.85); }
    #mover { position: absolute; left: 40px; top: 300px; width: 120px; height: 120px; background: #22d3ee; }
  </style>
  <script src="./assets/gsap.min.js"></script>
</head>
<body>
  <div id="stage" data-composition-id="main" data-start="0" data-duration="${durationSec}" data-width="1280" data-height="720" data-fps="30000/1001">
    <img src="./assets/dot.svg" style="position:absolute;top:40px;left:40px;width:40px;height:40px;" />
    <div id="mover"></div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.to("#mover", { x: 600, duration: ${durationSec}, ease: "none" }, 0);
    ${markerBlock}
    window.__timelines["main"] = tl;
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(stageDir, "index.html"), html, "utf8");
}

export async function runElectronVerification({ BrowserWindow, RenderCoordinator, PINNED_RUNTIME }) {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });

  const consoleErrors = [];
  const unhandledRejections = [];
  process.on("unhandledRejection", (reason) => {
    unhandledRejections.push(String(reason));
  });

  const violations = [];
  const previewManager = new PreviewContainerManager((ev) => violations.push(ev));
  const coordinator = new RenderCoordinator();

  const studioHtmlPath = path.join(repoRoot, "src", "renderer", "index.html");
  const studioOrigin = pathToFileURL(studioHtmlPath).href;
  const preloadPath = path.join(repoRoot, "dist", "preload", "studioPreload.cjs");

  const studioWin = new BrowserWindow({
    width: 1360,
    height: 820,
    show: false,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
    },
  });

  studioWin.webContents.on("console-message", (details) => {
    if (details.level >= 3) {
      consoleErrors.push(details.message);
    }
  });
  studioWin.webContents.on("render-process-gone", (_ev, details) => {
    consoleErrors.push(`render-process-gone: ${details.reason}`);
  });

  previewManager.attachHostWindow(studioWin);
  const ipcCtrl = registerStudioIpcHandlers(studioWin, studioOrigin, previewManager, coordinator);
  await studioWin.loadFile(studioHtmlPath);
  await sleep(300);

  const report = {
    pinnedRuntime: PINNED_RUNTIME,
    timestamp: new Date().toISOString(),
    tests: {},
  };

  // S3.1: 5 Panels + Live Runtime Version Readout
  {
    const layoutInfo = await studioWin.webContents.executeJavaScript(`(() => {
      const ids = ["topBar", "leftPanel", "centerPanel", "rightPanel", "statusBar"];
      const rects = Object.fromEntries(ids.map((id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return [id, { w: Math.round(r.width), h: Math.round(r.height) }];
      }));
      return {
        rects,
        runtimeText: document.getElementById("lblRuntimeVersions").textContent
      };
    })()`);

    for (const id of ["topBar", "leftPanel", "centerPanel", "rightPanel", "statusBar"]) {
      assert.ok(layoutInfo.rects[id].w > 0 && layoutInfo.rects[id].h > 0, `Panel ${id} must render`);
    }
    assert.ok(layoutInfo.runtimeText.includes(PINNED_RUNTIME.hyperframesEngineVersion));
    assert.ok(layoutInfo.runtimeText.includes(PINNED_RUNTIME.hyperframesProducerVersion));
    report.tests.workbenchFivePanelsAndRuntime = { passed: true, ...layoutInfo };
  }

  // S3.2: Missing Metadata must display "Unknown" (never assumed values) via Paste HTML
  {
    const minimalHtml = `<!doctype html><html><body><div>No metadata</div></body></html>`;
    await studioWin.webContents.executeJavaScript(`(() => {
      document.getElementById("btnTogglePaste").click();
      document.getElementById("txtPasteHtml").value = ${JSON.stringify(minimalHtml)};
      document.getElementById("btnLoadPaste").click();
    })()`);
    await sleep(450);

    const insp = await studioWin.webContents.executeJavaScript(`({
      source: document.getElementById("inspSourceMode").textContent,
      dims: document.getElementById("inspDims").textContent,
      fps: document.getElementById("inspFps").textContent,
      duration: document.getElementById("inspDuration").textContent,
      frames: document.getElementById("inspFrames").textContent,
      snapDisabled: document.getElementById("btnSnapToggle").disabled,
      renderDisabled: document.getElementById("btnRender").disabled,
      exportFpsValue: document.getElementById("selExportFps").value,
      exportValMsg: document.getElementById("lblExportValidation").textContent,
      sessionId: window.__mfWorkbenchUi.getState().sessionId
    })`);
    assert.equal(insp.source, "Working Copy");
    assert.equal(insp.dims, "Unknown");
    assert.equal(insp.fps, "Unknown");
    assert.equal(insp.duration, "Unknown");
    assert.equal(insp.frames, "Unknown");
    assert.equal(insp.snapDisabled, true);
    assert.equal(insp.renderDisabled, true, "Export must be blocked before user picks FPS");
    assert.equal(insp.exportFpsValue, "");
    assert.ok(insp.exportValMsg.includes("Export FPS"));

    // Also prove Main IPC rejects starting render without explicit FPS when source FPS is Unknown
    const ipcReject = await studioWin.webContents.executeJavaScript(`(async () => {
      try {
        await window.mfStudio.startSessionRender({ sessionId: ${JSON.stringify(insp.sessionId)}, format: "mp4", quality: "draft" });
        return { rejected: false };
      } catch (err) {
        return { rejected: true, message: err && err.message ? err.message : String(err) };
      }
    })()`);
    assert.equal(ipcReject.rejected, true);
    assert.ok(ipcReject.message.includes("Export FPS is required"));

    // Test missing-FPS HTML with explicit 30 FPS and explicit 30000/1001 exports
    const noFpsCompHtml = `<!doctype html><html><head><style>
      html,body{margin:0;width:640px;height:360px;background:#08101f;overflow:hidden}
      #bx{position:absolute;left:20px;top:120px;width:60px;height:60px;background:#38bdf8}
      </style></head><body>
      <div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="640" data-height="360">
        <div id="bx"></div>
      </div>
      <script>window.__timelines = { main: { duration: () => 2, seek: (t) => { document.getElementById("bx").style.transform = "translateX(" + (t * 100) + "px)"; } } };</script>
      </body></html>`;

    await studioWin.webContents.executeJavaScript(`(() => {
      document.getElementById("txtPasteHtml").value = ${JSON.stringify(noFpsCompHtml)};
      document.getElementById("btnLoadPaste").click();
    })()`);
    await sleep(450);

    // 1. Verify Inspector keeps Unknown & Export still blocked before selection
    const beforePick = await studioWin.webContents.executeJavaScript(`({
      inspFps: document.getElementById("inspFps").textContent,
      renderDisabled: document.getElementById("btnRender").disabled
    })`);
    assert.equal(beforePick.inspFps, "Unknown");
    assert.equal(beforePick.renderDisabled, true);

    async function renderAndProbeWithExportFps(fpsOptionVal) {
      await studioWin.webContents.executeJavaScript(`(() => {
        const sel = document.getElementById("selExportFps");
        sel.value = ${JSON.stringify(fpsOptionVal)};
        sel.dispatchEvent(new Event("change"));
      })()`);
      const enabledNow = await studioWin.webContents.executeJavaScript(`!document.getElementById("btnRender").disabled`);
      assert.equal(enabledNow, true);

      await studioWin.webContents.executeJavaScript(`(() => {
        document.getElementById("selFormat").value = "mp4";
        document.getElementById("selFormat").dispatchEvent(new Event("change"));
        document.getElementById("selQuality").value = "draft";
        document.getElementById("inpCrf").value = "";
        document.getElementById("btnRender").click();
      })()`);

      let doneJobId = null;
      for (let i = 0; i < 60; i++) {
        await sleep(300);
        const st = await studioWin.webContents.executeJavaScript(`({
          stage: document.getElementById("lblRenderStage").textContent,
          outcome: document.getElementById("lblRenderOutcome").textContent,
          completedJobId: window.__mfWorkbenchUi.getState().completedJobId
        })`);
        if (st.completedJobId) {
          doneJobId = st.completedJobId;
          break;
        }
        if (st.stage === "Failed" || st.stage === "Error") {
          throw new Error(`Export failed for ${fpsOptionVal}: ${st.outcome}`);
        }
      }
      assert.ok(doneJobId, `Expected job completion for ${fpsOptionVal}`);
      const outPath = ipcCtrl.getCompletedOutputPath(doneJobId);
      const p = ffprobeJson(outPath);
      const vs = (p.streams || []).find((s) => s.codec_type === "video") || {};
      return { rFrameRate: vs.r_frame_rate, avgFrameRate: vs.avg_frame_rate, nbFrames: Number(vs.nb_frames) };
    }

    // 2. Select 30 FPS -> output really 30/1 (60 frames for 2s)
    const probe30 = await renderAndProbeWithExportFps("30/1");
    assert.equal(probe30.rFrameRate, "30/1");
    assert.equal(probe30.nbFrames, 60);

    // 3. Select 30000/1001 -> output really uses rational 30000/1001
    const probeNtsc = await renderAndProbeWithExportFps("30000/1001");
    assert.equal(probeNtsc.rFrameRate, "30000/1001");

    report.tests.unknownMetadataAndExplicitExportFps = {
      passed: true,
      insp,
      ipcRejectWithoutFps: ipcReject,
      explicit30Output: probe30,
      explicit30000_1001Output: probeNtsc,
    };
  }

  // S3.2 + S3.3: Load Rational FPS (30000/1001) Composition -> Transport, Keyboard Shortcuts, Resize & Viewport Scale
  const stageDir = path.join(workRoot, "s3-rational-comp");
  writeRationalComposition(stageDir, { withMarkers: false, durationSec: 2 });
  const loaded = await previewManager.openVerifiedDirectory(stageDir, {
    title: "Rational NTSCTest",
    sourceMode: "original_file",
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session.sourceMode, "original_file");
  assert.ok(loaded.session.localAssets.includes("assets/dot.svg"));
  assert.ok(loaded.session.localAssets.includes("assets/gsap.min.js"));
  await previewManager.disposeActiveSession();

  const rationalPastedHtml = fs.readFileSync(path.join(stageDir, "index.html"), "utf8");
  // Wait: index.html references ./assets/gsap.min.js and ./assets/dot.svg, so stage them into working dir or load via Main helper?
  // Better: expose a tiny test-only helper OR copy stage assets into the pasted working dir? Even better: stageDir is Main-verified—
  // for real E2E testing of Original File in Studio UI without native OS modal blocking headless CI, verify Original File Inspector via previewManager
  // AND test full interactive UI controls via an inline-GSAP + data-fps="30000/1001" composition pasted via btnLoadPaste!
  const gsapCode = fs.readFileSync(path.join(stageDir, "assets", "gsap.min.js"), "utf8");
  const uiCompHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    html, body { margin: 0; width: 1280px; height: 720px; background: #0b1426; overflow: hidden; }
    #mover { position: absolute; left: 40px; top: 300px; width: 120px; height: 120px; background: #38bdf8; }
  </style>
  <script>${gsapCode}</script>
</head>
<body>
  <div id="stage" data-composition-id="main" data-start="0" data-duration="2" data-width="1280" data-height="720" data-fps="30000/1001">
    <div id="mover"></div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.to("#mover", { x: 600, duration: 2, ease: "none" }, 0);
    window.__timelines["main"] = tl;
  </script>
</body>
</html>`;

  await studioWin.webContents.executeJavaScript(`(() => {
    document.getElementById("txtPasteHtml").value = ${JSON.stringify(uiCompHtml)};
    document.getElementById("btnLoadPaste").click();
  })()`);
  await sleep(600);

  // Verify Inspector + Snap Disabled (no markers)
  {
    const insp = await studioWin.webContents.executeJavaScript(`({
      dims: document.getElementById("inspDims").textContent,
      fps: document.getElementById("inspFps").textContent,
      frames: document.getElementById("inspFrames").textContent,
      exportFpsValue: document.getElementById("selExportFps").value,
      exportFpsLabel: document.getElementById("selExportFps").selectedOptions[0]?.textContent || "",
      snapText: document.getElementById("btnSnapToggle").textContent,
      snapDisabled: document.getElementById("btnSnapToggle").disabled,
      state: window.__mfWorkbenchUi.getState()
    })`);
    assert.equal(insp.dims, "1280 x 720");
    assert.equal(insp.fps, "30000/1001 (29.970 fps)");
    assert.equal(insp.frames, "60");
    assert.equal(insp.exportFpsValue, "source");
    assert.ok(insp.exportFpsLabel.includes("Source FPS (30000/1001"));
    assert.equal(insp.snapDisabled, true);
    assert.equal(insp.state.totalFrames, 60);

    // Step Next Frame (button + ArrowRight), End, Home, Clamp beyond bounds
    await studioWin.webContents.executeJavaScript(`document.getElementById("btnPrevFrame").click()`); // clamps at 0
    await sleep(120);
    assert.equal(await studioWin.webContents.executeJavaScript(`window.__mfWorkbenchUi.getState().currentFrame`), 0);

    await studioWin.webContents.executeJavaScript(`document.getElementById("btnNextFrame").click()`); // -> 1
    await sleep(120);
    assert.equal(await studioWin.webContents.executeJavaScript(`window.__mfWorkbenchUi.getState().currentFrame`), 1);

    // Keyboard End -> frame 59
    await studioWin.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent("keydown", { code: "End" }))`);
    await sleep(200);
    assert.equal(await studioWin.webContents.executeJavaScript(`window.__mfWorkbenchUi.getState().currentFrame`), 59);

    const activeView = previewManager.getActiveSession().view;
    const transformAtEnd = await activeView.webContents.executeJavaScript(
      `getComputedStyle(document.getElementById("mover")).transform`
    );
    assert.ok(transformAtEnd && transformAtEnd !== "none");

    // Keyboard Home -> frame 0, Space -> play -> wait -> pause
    await studioWin.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent("keydown", { code: "Home" }))`);
    await sleep(200);
    assert.equal(await studioWin.webContents.executeJavaScript(`window.__mfWorkbenchUi.getState().currentFrame`), 0);

    await studioWin.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }))`);
    await sleep(250);
    await studioWin.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }))`);
    await sleep(100);
    const playedFrame = await studioWin.webContents.executeJavaScript(`window.__mfWorkbenchUi.getState().currentFrame`);
    assert.ok(playedFrame >= 1, `Expected Space play to advance frame, got ${playedFrame}`);

    // Viewport Scale Fit -> 100% -> 200% + Window Resize containment check
    await studioWin.webContents.executeJavaScript(`document.querySelector('[data-scale="100"]').click()`);
    await sleep(150);
    await studioWin.webContents.executeJavaScript(`document.querySelector('[data-scale="fit"]').click()`);
    studioWin.setSize(1180, 740);
    await sleep(250);
    const boundsAfterResize = activeView.getBounds();
    const stageRect = await studioWin.webContents.executeJavaScript(`(() => {
      const r = document.getElementById("viewportStage").getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
    assert.ok(boundsAfterResize.x >= Math.floor(stageRect.x));
    assert.ok(boundsAfterResize.y >= Math.floor(stageRect.y));
    assert.ok(boundsAfterResize.width <= Math.ceil(stageRect.w));
    assert.ok(boundsAfterResize.height <= Math.ceil(stageRect.h));

    report.tests.transportRationalFpsAndResize = {
      passed: true,
      fpsLabel: insp.fps,
      totalFrames: insp.state.totalFrames,
      transformAtFrame59: transformAtEnd,
      boundsAfterResize,
    };
  }

  // S3.4 + S3.5: Export Inspector Validation + H.264 MP4 + ProRes 4444 MOV + Open Output verification
  {
    // Switch MP4 -> verify CRF shown, invalid CRF blocked locally without worker call
    await studioWin.webContents.executeJavaScript(`(() => {
      const sel = document.getElementById("selFormat");
      sel.value = "mp4";
      sel.dispatchEvent(new Event("change"));
      document.getElementById("inpCrf").value = "99";
      document.getElementById("btnRender").click();
    })()`);
    await sleep(100);
    const valErr = await studioWin.webContents.executeJavaScript(`document.getElementById("lblExportValidation").textContent`);
    assert.ok(valErr.includes("0 and 51"));

    // Valid Draft MP4 (CRF 22) export through full Workbench UI
    await studioWin.webContents.executeJavaScript(`(() => {
      document.getElementById("selQuality").value = "draft";
      document.getElementById("inpCrf").value = "22";
      document.getElementById("btnRender").click();
    })()`);

    // Wait for completion via UI state
    let mp4JobId = null;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const st = await studioWin.webContents.executeJavaScript(`({
        stage: document.getElementById("lblRenderStage").textContent,
        outcome: document.getElementById("lblRenderOutcome").textContent,
        completedJobId: window.__mfWorkbenchUi.getState().completedJobId
      })`);
      if (st.completedJobId) {
        mp4JobId = st.completedJobId;
        break;
      }
      if (st.stage === "Failed" || st.stage === "Error") {
        throw new Error(`MP4 render failed: ${st.outcome}`);
      }
    }
    assert.ok(mp4JobId, "MP4 render should complete via UI");
    const mp4Path = ipcCtrl.getCompletedOutputPath(mp4JobId);
    assert.ok(mp4Path && fs.existsSync(mp4Path));
    const mp4Probe = ffprobeJson(mp4Path);
    const mp4Stream = (mp4Probe.streams || []).find((s) => s.codec_type === "video") || {};
    assert.equal(mp4Stream.codec_name, "h264");
    assert.equal(mp4Stream.r_frame_rate, "30000/1001");
    assert.equal(Number(mp4Stream.nb_frames), 60);

    // Switch MOV -> verify CRF hidden/disabled, ProRes info box shown, and render ProRes 4444 MOV
    const movUiState = await studioWin.webContents.executeJavaScript(`(() => {
      const sel = document.getElementById("selFormat");
      sel.value = "mov";
      sel.dispatchEvent(new Event("change"));
      return {
        crfHidden: document.getElementById("crfGroup").classList.contains("hidden"),
        crfDisabled: document.getElementById("inpCrf").disabled,
        proresShown: !document.getElementById("proresInfoBox").classList.contains("hidden")
      };
    })()`);
    assert.equal(movUiState.crfHidden, true);
    assert.equal(movUiState.crfDisabled, true);
    assert.equal(movUiState.proresShown, true);

    await studioWin.webContents.executeJavaScript(`document.getElementById("btnRender").click()`);
    let movJobId = null;
    for (let i = 0; i < 90; i++) {
      await sleep(300);
      const st = await studioWin.webContents.executeJavaScript(`({
        stage: document.getElementById("lblRenderStage").textContent,
        outcome: document.getElementById("lblRenderOutcome").textContent,
        completedJobId: window.__mfWorkbenchUi.getState().completedJobId
      })`);
      if (st.completedJobId) {
        movJobId = st.completedJobId;
        break;
      }
      if (st.stage === "Failed" || st.stage === "Error") {
        throw new Error(`MOV render failed: ${st.outcome}`);
      }
    }
    assert.ok(movJobId, "MOV ProRes 4444 render should complete via UI");
    const movPath = ipcCtrl.getCompletedOutputPath(movJobId);
    assert.ok(movPath && fs.existsSync(movPath));
    const movProbe = ffprobeJson(movPath);
    const movStream = (movProbe.streams || []).find((s) => s.codec_type === "video") || {};
    assert.equal(movStream.codec_name, "prores");
    assert.equal(movStream.pix_fmt, "yuva444p12le");
    assert.equal(movStream.r_frame_rate, "30000/1001");

    const openBtnEnabled = await studioWin.webContents.executeJavaScript(`!document.getElementById("btnOpenOutput").disabled`);
    assert.equal(openBtnEnabled, true);

    report.tests.exportInspectorAndFormats = {
      passed: true,
      mp4: { codec: mp4Stream.codec_name, rFrameRate: mp4Stream.r_frame_rate, frames: Number(mp4Stream.nb_frames) },
      mov: { codec: movStream.codec_name, pixFmt: movStream.pix_fmt, rFrameRate: movStream.r_frame_rate, frames: Number(movStream.nb_frames) },
      openOutputButtonEnabled: openBtnEnabled,
    };
  }

  assert.equal(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join("; ")}`);
  assert.equal(unhandledRejections.length, 0, `Unexpected unhandled rejections: ${unhandledRejections.join("; ")}`);

  await ipcCtrl.dispose();
  await coordinator.shutdown();
  studioWin.destroy();

  const reportOut = path.join(workRoot, "sprint3_verification_report.json");
  fs.writeFileSync(reportOut, JSON.stringify(report, null, 2));
  console.log("=== SPRINT 3 WORKBENCH E2E PASSED ===");
  console.log(JSON.stringify(report, null, 2));
  return 0;
}
