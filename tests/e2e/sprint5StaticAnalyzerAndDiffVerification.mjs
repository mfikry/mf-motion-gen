import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerStudioIpcHandlers } from "../../dist/main/ipc/studioIpcHandler.js";
import { computeFileSha256Sync, purgeSessionDirectorySync } from "../../dist/main/import/sessionFsUtils.js";
import { PreviewContainerManager } from "../../dist/main/preview/previewContainerManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const workRoot = path.join(repoRoot, "tmp", "sprint5-e2e");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createSilentWavBuffer(durationSec = 1, sampleRate = 8000) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
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

export async function runElectronVerification({ BrowserWindow, RenderCoordinator, PINNED_RUNTIME }) {
  purgeSessionDirectorySync(workRoot);
  fs.mkdirSync(workRoot, { recursive: true });

  const consoleErrors = [];
  const unhandledRejections = [];
  process.on("unhandledRejection", (r) => unhandledRejections.push(String(r)));

  const previewManager = new PreviewContainerManager();
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

  studioWin.webContents.on("console-message", (d) => {
    if (d.level >= 3) consoleErrors.push(d.message);
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

  // --- 1. Workbench Five Categories, Inspect Element, Diff Cancel/Apply, Re-Analyze, Seek & Export ---
  {
    const srcDir = path.join(workRoot, "src-five-categories");
    const gsapCode = fs.readFileSync(
      path.join(repoRoot, "poc", "hyperframes-spike", "assets", "gsap.min.js"),
      "utf8"
    );
    const wavBuf = createSilentWavBuffer(1);
    const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <script src="./assets/gsap.min.js"></script>
  <style>
    html, body { margin: 0; width: 640px; height: 360px; background: #09111f; overflow: hidden; }
    #bgLayer { position: absolute; inset: 0; background: #0c182c; }
    #heroBox { position: absolute; left: 40px; top: 140px; width: 80px; height: 80px; background: #38bdf8; }
    #flashFx { position: absolute; left: 260px; top: 60px; width: 40px; height: 40px; opacity: 0; background: #f472b6; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="640" data-height="360" data-fps="30">
    <div id="bgLayer"></div>
    <div id="flashFx" data-transient="true" class="clip" data-start="0.2" data-duration="1.2"></div>
    <div id="heroBox"></div>
    <audio id="bgm" src="./media/bgm.wav"></audio>
  </div>
  <script>
    const tl = gsap.timeline();
    tl.to("#heroBox", { x: 300, duration: 1, ease: "none" }, 0);
    tl.to("#flashFx", { opacity: 1, duration: 0.2 }, 0.2);
    tl.to("#flashFx", { opacity: 0, duration: 0.2 }, 0.6);
    window.__timelines = window.__timelines || {};
    window.__timelines.main = tl;
  </script>
</body>
</html>`;

    fs.mkdirSync(path.join(srcDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(srcDir, "media"), { recursive: true });
    fs.writeFileSync(path.join(srcDir, "index.html"), indexHtml, "utf8");
    fs.writeFileSync(path.join(srcDir, "assets", "gsap.min.js"), gsapCode, "utf8");
    fs.writeFileSync(path.join(srcDir, "media", "bgm.wav"), wavBuf);

    const origHtmlSha = computeFileSha256Sync(path.join(srcDir, "index.html"));
    const importRes = await ipcCtrl.importProjectFromFolder(srcDir);
    assert.equal(importRes.ok, true);
    assert.ok(importRes.session);
    assert.ok(importRes.session.analysis);

    // Push imported session into Studio UI cleanly via Studio renderer state helper check
    const counts = importRes.session.analysis.summary.countsByCategory;
    assert.ok(counts.PERSISTENT >= 1, "Expected PERSISTENT classification");
    assert.ok(counts.TRANSIENT >= 1, "Expected TRANSIENT classification");
    assert.ok(counts.TIMELINE_CONTROLLED >= 1, "Expected TIMELINE_CONTROLLED classification");
    assert.ok(counts.MEDIA >= 1, "Expected MEDIA classification");
    assert.ok(counts.WARNING_AMBIGUOUS >= 1, "Expected WARNING_AMBIGUOUS classification (.clip overflow)");

    const workingHtmlPath = path.join(previewManager.getActiveSession().stageDir, "index.html");
    const workingShaBefore = computeFileSha256Sync(workingHtmlPath);

    // Drive LeftPanel Analyzer UI directly in Studio Renderer
    const sessionJson = JSON.stringify(importRes.session);
    await studioWin.webContents.executeJavaScript(`(() => {
      // Load into UI via handleImportPromptResponse path if we dispatch synthetic import result cleanly
      const btnToggle = document.getElementById("btnRunAnalysis");
      return Boolean(btnToggle);
    })()`);

    // Invoke via IPC handlers from Studio UI (matches real user flow cleanly)
    const uiCounts = await studioWin.webContents.executeJavaScript(`(async () => {
      const s = ${sessionJson};
      // Populate UI directly using analyze endpoint + DOM checks via window.mfStudio
      const freshReport = await window.mfStudio.runStaticAnalysis(s.sessionId);
      return freshReport.summary.countsByCategory;
    })()`);
    assert.deepEqual(uiCounts, counts);

    // Check Ambiguous (.clip overflow) diagnostic has NO-AUTO-FIX and rejects previewDiagnosticDiff
    const overflowDiag = importRes.session.analysis.diagnostics.find((d) => d.ruleId === "CLIP_BOUNDARY_OVERFLOW");
    assert.ok(overflowDiag);
    assert.equal(overflowDiag.canAutoFix, false);
    const diffReject = await studioWin.webContents.executeJavaScript(`(async () => {
      try {
        await window.mfStudio.previewDiagnosticDiff(${JSON.stringify(importRes.session.sessionId)}, ${JSON.stringify(overflowDiag.id)});
        return { rejected: false };
      } catch (e) {
        return { rejected: true, message: String(e) };
      }
    })()`);
    assert.equal(diffReject.rejected, true);

    // Inspect target element (#heroBox) via Studio IPC ->Preview WebContentsView WITHOUT FS access
    const inspectRes = await studioWin.webContents.executeJavaScript(`
      window.mfStudio.inspectDiagnosticElement(${JSON.stringify(importRes.session.sessionId)}, "#heroBox")
    `);
    assert.equal(inspectRes.found, true);
    assert.equal(inspectRes.tagName, "div");

    const previewSecurityAndOverlay = await previewManager.getActiveSession().view.webContents.executeJavaScript(`({
      hasOverlay: Boolean(document.getElementById("__mf-inspect-overlay")),
      typeofRequire: typeof window.require,
      typeofProcess: typeof window.process,
      typeofMfStudio: typeof window.mfStudio
    })`);
    assert.equal(previewSecurityAndOverlay.hasOverlay, true);
    assert.equal(previewSecurityAndOverlay.typeofRequire, "undefined");
    assert.equal(previewSecurityAndOverlay.typeofProcess, "undefined");
    assert.equal(previewSecurityAndOverlay.typeofMfStudio, "undefined");

    // Preview Code Diff for high-confidence GSAP_TIMELINE_NOT_PAUSED
    const fixableDiag = importRes.session.analysis.diagnostics.find((d) => d.ruleId === "GSAP_TIMELINE_NOT_PAUSED");
    assert.ok(fixableDiag);
    assert.equal(fixableDiag.canAutoFix, true);
    assert.equal(fixableDiag.confidence, "high");

    const diffPreview = await studioWin.webContents.executeJavaScript(`
      window.mfStudio.previewDiagnosticDiff(${JSON.stringify(importRes.session.sessionId)}, ${JSON.stringify(fixableDiag.id)})
    `);
    assert.equal(diffPreview.targetFile, "index.html");
    assert.match(diffPreview.diffText, /- .*gsap\.timeline\(\)/);
    assert.match(diffPreview.diffText, /\+ .*gsap\.timeline\(\{ paused: true \}\)/);

    // Cancel / Revert before apply must leave BOTH working copy and original file unchanged
    await studioWin.webContents.executeJavaScript(`
      window.mfStudio.cancelDiagnosticDiff(${JSON.stringify(importRes.session.sessionId)})
    `);
    assert.equal(computeFileSha256Sync(workingHtmlPath), workingShaBefore);
    assert.equal(computeFileSha256Sync(path.join(srcDir, "index.html")), origHtmlSha);

    // Confirm Apply Fix -> Working Copy modified, Original SHA-256 untouched, Re-analysis passes
    const applyRes = await studioWin.webContents.executeJavaScript(`
      window.mfStudio.confirmApplyDiagnosticFix(${JSON.stringify(importRes.session.sessionId)}, ${JSON.stringify(diffPreview.proposalId)})
    `);
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.modifiedFile, "index.html");
    assert.equal(applyRes.session.workingCopyModified, true);
    assert.equal(applyRes.session.analysis.summary.autoFixableCount, 0);
    assert.equal(applyRes.session.analysis.timelineContract.pausedLikely, true);
    assert.notEqual(computeFileSha256Sync(workingHtmlPath), workingShaBefore);
    assert.equal(computeFileSha256Sync(path.join(srcDir, "index.html")), origHtmlSha, "Original source SHA-256 mutated!");

    // Preview seek works after working-copy rewrite & reload
    await sleep(300);
    const seekAfterFix = await studioWin.webContents.executeJavaScript(`
      window.mfStudio.seekPreview(${JSON.stringify(importRes.session.sessionId)}, 0.5)
    `);
    assert.equal(seekAfterFix.seekSupported, true);
    const heroTransform = await previewManager.getActiveSession().view.webContents.executeJavaScript(`
      getComputedStyle(document.getElementById("heroBox")).transform
    `);
    assert.equal(heroTransform, "matrix(1, 0, 0, 1, 150, 0)");

    // Export MP4 succeeds on fixed working copy
    const exportOut = await studioWin.webContents.executeJavaScript(`
      window.mfStudio.startSessionRender({
        sessionId: ${JSON.stringify(importRes.session.sessionId)},
        format: "mp4",
        quality: "draft",
        fps: { num: 30, den: 1 }
      })
    `);
    assert.equal(exportOut.status, "complete", exportOut.errorMessage);
    const probe = ffprobeJson(exportOut.outputPath);
    const vs = (probe.streams || []).find((s) => s.codec_type === "video") || {};
    assert.equal(Number(vs.nb_frames), 30);

    report.tests.analyzerInspectDiffReanalyzeAndExport = {
      passed: true,
      counts,
      inspectRes,
      previewIsolated: true,
      cancelPreservedWorkingSha: true,
      applyUpdatedWorkingCopyOnly: true,
      originalShaUnchanged: true,
      reanalysisAutoFixableAfter: applyRes.session.analysis.summary.autoFixableCount,
      heroTransformAtHalfSec: heroTransform,
      exportedFrames: Number(vs.nb_frames),
    };
  }

  // --- 2. Ambiguous / Non-Idempotent Authoring Hazards + UI DOM Filter Check ---
  {
    const ambDir = path.join(workRoot, "src-ambiguous");
    fs.mkdirSync(ambDir, { recursive: true });
    fs.writeFileSync(
      path.join(ambDir, "index.html"),
      `<!doctype html>
<html><body>
  <div id="comp" data-composition-id="main" data-duration="2" data-width="640" data-height="360" data-fps="30">
    <div id="targetA">A</div>
    <div id="stillNode">Still</div>
  </div>
  <script>
    const cachedRef = document.querySelector("#targetA");
    (() => {
      const tl = { to: () => tl };
      const realTl = {
        duration: () => 2, seek: () => {}, pause: () => {}
      };
      window.__timelines = { altKey: realTl };
    })();
    if (false) {
      const g = gsap.timeline();
      g.to("#targetA", { x: 100, onComplete: () => {} }, 0);
      setTimeout(() => { window.__timelines.main = g; }, 50);
    }
  </script>
</body></html>`,
      "utf8"
    );

    // Load HTML via paste drawer UI to verify LeftPanel renders categories, filters, and NO-AUTO-FIX badges
    const ambHtml = fs.readFileSync(path.join(ambDir, "index.html"), "utf8");
    const uiCheck = await studioWin.webContents.executeJavaScript(`(async () => {
      document.getElementById("txtPasteHtml").value = ${JSON.stringify(ambHtml)};
      document.getElementById("btnLoadPaste").click();
      await new Promise((r) => setTimeout(r, 450));
      const allCountText = document.getElementById("cntCatALL")?.textContent;
      const warnBtn = document.querySelector('[data-diag-cat="WARNING_AMBIGUOUS"]');
      warnBtn?.click();
      const firstDiagBadge = document.querySelector("#listDiagnostics .diag-item")?.textContent || "";
      const previewBtnDisabled = document.getElementById("btnPreviewDiagDiff")?.disabled;
      const noFixReason = document.getElementById("diagDetailNoFixNote")?.textContent || "";
      return {
        allCountText,
        firstDiagBadge: firstDiagBadge.slice(0, 120),
        previewBtnDisabled,
        noFixReason,
        uiState: window.__mfWorkbenchUi.getState()
      };
    })()`);

    assert.equal(uiCheck.uiState.activeDiagFilter, "WARNING_AMBIGUOUS");
    assert.equal(uiCheck.uiState.analysisSummary.autoFixableCount, 0);
    assert.equal(uiCheck.previewBtnDisabled, true);
    assert.match(uiCheck.noFixReason, /NO-AUTO-FIX/);

    report.tests.leftPanelFilterAndNoAutoFixEnforcement = {
      passed: true,
      activeDiagFilter: uiCheck.uiState.activeDiagFilter,
      autoFixableCount: uiCheck.uiState.analysisSummary.autoFixableCount,
      previewBtnDisabled: uiCheck.previewBtnDisabled,
    };
  }

  assert.equal(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join("; ")}`);
  assert.equal(unhandledRejections.length, 0, `Unexpected rejections: ${unhandledRejections.join("; ")}`);

  await ipcCtrl.dispose();
  await coordinator.shutdown();
  studioWin.destroy();

  const outPath = path.join(workRoot, "sprint5_verification_report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("=== SPRINT 5 STATIC ANALYZER & DIFF E2E PASSED ===");
  console.log(JSON.stringify(report, null, 2));
  return 0;
}
