import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dialog } from "electron";
import { registerStudioIpcHandlers } from "../../dist/main/ipc/studioIpcHandler.js";
import { purgeSessionDirectorySync } from "../../dist/main/import/sessionFsUtils.js";
import { PreviewContainerManager } from "../../dist/main/preview/previewContainerManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const workRoot = path.join(repoRoot, "tmp", "sprint6c-e2e");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  await sleep(450);

  const report = {
    pinnedRuntime: PINNED_RUNTIME,
    timestamp: new Date().toISOString(),
    tests: {},
  };

  // --- 1. Initial Queue Snapshot & Initial + Periodic StatusBar Telemetry ---
  const initUi = await studioWin.webContents.executeJavaScript(`({
    state: window.__mfWorkbenchUi.getState(),
    telemetryText: document.getElementById("lblStatusTelemetry")?.textContent || "",
    queueBadge: document.getElementById("lblQueueSummaryBadge")?.textContent || ""
  })`);

  assert.ok(initUi.state.queueSnapshot, "Initial queue snapshot must load when Studio opens");
  assert.equal(initUi.state.queueSnapshot.activeCount, 0);
  assert.equal(initUi.state.queueSnapshot.queuedCount, 0);
  assert.ok(initUi.state.telemetry, "Initial telemetry snapshot must load");
  assert.match(initUi.telemetryText, /Electron RAM:/);
  assert.match(initUi.telemetryText, /Ext Worker RAM: N\/A/);
  assert.match(initUi.telemetryText, /ETA: N\/A/);

  const firstSampleMs = initUi.state.telemetry.sampledAtMs;
  await sleep(1750);
  const laterUi = await studioWin.webContents.executeJavaScript(`window.__mfWorkbenchUi.getState().telemetry`);
  assert.ok(laterUi.sampledAtMs > firstSampleMs, "Periodic polling must advance telemetry sampledAtMs");

  report.tests.initialSnapshotAndPeriodicTelemetry = {
    passed: true,
    initialMemStatus: initUi.state.telemetry.memoryStatus,
    initialTotalMB: initUi.state.telemetry.totalWorkingSetMB,
    firstSampleMs,
    laterSampleMs: laterUi.sampledAtMs,
    telemetryText: initUi.telemetryText,
  };

  // --- 2. Load Composition -> Enqueue Multi-Job -> Cancel Queued & Active -> Clear Completed ---
  const gsapCode = fs.readFileSync(
    path.join(repoRoot, "poc", "hyperframes-spike", "assets", "gsap.min.js"),
    "utf8"
  );
  const sampleHtml = `<!doctype html>
<html><head><style>
  html,body{margin:0;width:640px;height:360px;background:#081226;overflow:hidden}
  #box{position:absolute;left:30px;top:140px;width:60px;height:60px;background:#38bdf8}
</style><script>${gsapCode}</script></head>
<body>
  <div id="stage" data-composition-id="main" data-start="0" data-duration="3" data-width="640" data-height="360" data-fps="30">
    <div id="box"></div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.to("#box", { x: 400, duration: 3, ease: "none" }, 0);
    window.__timelines = { main: tl };
  </script>
</body></html>`;

  await studioWin.webContents.executeJavaScript(`(() => {
    document.getElementById("txtPasteHtml").value = ${JSON.stringify(sampleHtml)};
    document.getElementById("btnLoadPaste").click();
  })()`);
  await sleep(500);

  // Trigger Render Export once (disables btnRender immediately so double-click cannot duplicate), then enqueue 2 queued jobs via + Queue
  await studioWin.webContents.executeJavaScript(`(() => {
    document.getElementById("selQuality").value = "draft";
    document.getElementById("btnRender").click();
    document.getElementById("btnRender").click(); // Must be ignored (disabled) -> zero duplicate job
  })()`);
  await sleep(60);
  await studioWin.webContents.executeJavaScript(`document.getElementById("btnAddToQueue").click()`);
  await sleep(60);
  await studioWin.webContents.executeJavaScript(`document.getElementById("btnAddToQueue").click()`);
  await sleep(150);

  const midQueue = await studioWin.webContents.executeJavaScript(`({
    btnRenderDisabled: document.getElementById("btnRender").disabled,
    queueSnapshot: window.__mfWorkbenchUi.getState().queueSnapshot,
    domItemsCount: document.querySelectorAll("#listRenderQueue .queue-item").length,
    countsLine: document.getElementById("lblQueueCountsLine").textContent
  })`);

  assert.equal(midQueue.btnRenderDisabled, true, "Render button must lock while job is running/queued");
  assert.equal(midQueue.queueSnapshot.items.length, 3, "Must have exactly 3 jobs (no duplicate from double Render click)");
  assert.equal(midQueue.domItemsCount, 3);

  const job1 = midQueue.queueSnapshot.items[0];
  const job2 = midQueue.queueSnapshot.items[1];
  const job3 = midQueue.queueSnapshot.items[2];
  assert.equal(job1.status, "rendering");
  assert.equal(job2.status, "queued");
  assert.equal(job3.status, "queued");

  // Cancel queued Job 3 via its Cancel button in UI -> must NOT stop active Job 1
  await studioWin.webContents.executeJavaScript(`
    document.querySelector('[data-cancel-job-id="${job3.jobId}"]')?.click()
  `);
  await sleep(120);

  const afterQueuedCancel = await studioWin.webContents.executeJavaScript(`window.__mfWorkbenchUi.getState().queueSnapshot`);
  const j3After = afterQueuedCancel.items.find((i) => i.jobId === job3.jobId);
  const j1After = afterQueuedCancel.items.find((i) => i.jobId === job1.jobId);
  assert.equal(j3After.status, "cancelled");
  assert.equal(j1After.status, "rendering", "Cancelling queued job must leave active job rendering");

  // Cancel active Job 1 via Cancel button -> Job 1 becomes cancelled and queue advances to Job 2 -> Job 2 finishes complete
  const clickedJob1Cancel = await studioWin.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('[data-cancel-job-id="${job1.jobId}"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  assert.equal(clickedJob1Cancel, true, "Active Job 1 must expose Cancel button and accept click");

  let finalQueue = null;
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    finalQueue = await studioWin.webContents.executeJavaScript(`window.__mfWorkbenchUi.getState().queueSnapshot`);
    const j2Now = finalQueue.items.find((it) => it.jobId === job2.jobId);
    if (j2Now && j2Now.status === "complete") break;
  }

  const j1Final = finalQueue.items.find((i) => i.jobId === job1.jobId);
  const j2Final = finalQueue.items.find((i) => i.jobId === job2.jobId);
  assert.equal(j1Final.status, "cancelled");
  assert.equal(j2Final.status, "complete");

  // Terminal items must NOT display any Cancel button
  const terminalCancelButtons = await studioWin.webContents.executeJavaScript(`
    document.querySelectorAll("#listRenderQueue [data-cancel-job-id]").length
  `);
  assert.equal(terminalCancelButtons, 0);

  // Select Job 2 in Queue UI -> Log Inspector populates + shows live entries
  await studioWin.webContents.executeJavaScript(`
    document.querySelector('#listRenderQueue .queue-item[data-job-id="${job2.jobId}"]')?.click()
  `);
  await sleep(200);
  const logUiState = await studioWin.webContents.executeJavaScript(`({
    selectedLogJobId: window.__mfWorkbenchUi.getState().selectedLogJobId,
    selectedJobLog: window.__mfWorkbenchUi.getState().selectedJobLog,
    logRowCount: document.querySelectorAll("#listRenderLogs .log-row").length,
    exportDisabled: document.getElementById("btnExportJobLog").disabled
  })`);
  assert.equal(logUiState.selectedLogJobId, job2.jobId);
  assert.ok(logUiState.logRowCount >= 4);
  assert.equal(logUiState.exportDisabled, false);

  // --- 3. Clear Completed & Safe Native Export Log (Canceled vs Saved) ---
  await studioWin.webContents.executeJavaScript(`document.getElementById("btnClearCompleted").click()`);
  await sleep(120);
  const afterClear = await studioWin.webContents.executeJavaScript(`({
    queueCount: document.getElementById("lblQueueCountsLine").textContent,
    itemsLen: window.__mfWorkbenchUi.getState().queueSnapshot.items.length,
    exportStillEnabled: !document.getElementById("btnExportJobLog").disabled
  })`);
  assert.equal(afterClear.itemsLen, 0);
  assert.equal(afterClear.exportStillEnabled, true, "Clearing queue list must keep selected retained log exportable");

  // Mock Electron dialog.showSaveDialog safely for automated headless UI check
  const origShowSaveDialog = dialog.showSaveDialog;
  try {
    const canceledPathProbe = path.join(workRoot, "should-not-exist-log.json");
    dialog.showSaveDialog = async () => ({ canceled: true });
    await studioWin.webContents.executeJavaScript(`document.getElementById("btnExportJobLog").click()`);
    await sleep(150);
    const cancelMsg = await studioWin.webContents.executeJavaScript(`document.getElementById("lblLogExportStatus").textContent`);
    assert.match(cancelMsg, /canceled/i);
    assert.equal(fs.existsSync(canceledPathProbe), false);

    const exportOutPath = path.join(workRoot, "exported-ui-log.json");
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportOutPath });
    await studioWin.webContents.executeJavaScript(`document.getElementById("btnExportJobLog").click()`);
    await sleep(150);
    const okMsg = await studioWin.webContents.executeJavaScript(`document.getElementById("lblLogExportStatus").textContent`);
    assert.match(okMsg, /Exported:/);
    assert.equal(fs.existsSync(exportOutPath), true);
    const exportedJson = JSON.parse(fs.readFileSync(exportOutPath, "utf8"));
    assert.equal(exportedJson.jobLog.jobId, job2.jobId);

    report.tests.logInspectorAndExport = {
      passed: true,
      logRowCount: logUiState.logRowCount,
      cancelMsg,
      okMsg,
      exportedFileExists: true,
    };
  } finally {
    dialog.showSaveDialog = origShowSaveDialog;
  }

  // --- 4. Listener Rebind (No Duplicates) & Clean Dispose Verification ---
  const listenerStats = await studioWin.webContents.executeJavaScript(`(() => {
    const beforeCount = window.__mfWorkbenchUi.getState().activeListenerCount;
    window.__mfWorkbenchUi.rebindListenersForTest();
    const afterRebind = window.__mfWorkbenchUi.getState().activeListenerCount;
    window.__mfWorkbenchUi.disposeListenersForTest();
    const afterDispose = window.__mfWorkbenchUi.getState().activeListenerCount;
    return {
      beforeCount,
      afterRebind,
      afterDispose,
      isDisposed: window.__mfWorkbenchUi.getState().isDisposed
    };
  })()`);
  assert.equal(listenerStats.beforeCount, listenerStats.afterRebind, "Rebinding must not duplicate listeners");
  assert.equal(listenerStats.afterDispose, 0);
  assert.equal(listenerStats.isDisposed, true);

  report.tests.queueLifecycleAndListenerCleanup = {
    passed: true,
    queuedJobCancelledId: job3.jobId,
    activeJobCancelledId: job1.jobId,
    autoAdvancedJobId: job2.jobId,
    terminalCancelButtonsRemaining: terminalCancelButtons,
    listenerStats,
  };

  assert.equal(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join("; ")}`);
  assert.equal(unhandledRejections.length, 0, `Unexpected rejections: ${unhandledRejections.join("; ")}`);

  await ipcCtrl.dispose();
  await coordinator.shutdown();
  studioWin.destroy();

  const outPath = path.join(workRoot, "sprint6_ws_c_report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("=== SPRINT 6 WORKSTREAM C UI VERIFICATION PASSED ===");
  console.log(JSON.stringify(report, null, 2));
  return 0;
}
