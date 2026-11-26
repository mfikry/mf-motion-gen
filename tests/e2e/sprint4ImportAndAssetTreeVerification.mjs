import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerStudioIpcHandlers } from "../../dist/main/ipc/studioIpcHandler.js";
import { computeFileSha256Sync, purgeSessionDirectorySync } from "../../dist/main/import/sessionFsUtils.js";
import { ZipSecurityError } from "../../dist/main/import/secureZipExtractor.js";
import { PreviewContainerManager } from "../../dist/main/preview/previewContainerManager.js";
import { buildSyntheticZip } from "../helpers/zipTestHelper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const workRoot = path.join(repoRoot, "tmp", "sprint4-e2e");

// Minimal valid 1x1 rgba PNG bytes
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

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

function buildSampleProjectFiles() {
  const gsapCode = fs.readFileSync(
    path.join(repoRoot, "poc", "hyperframes-spike", "assets", "gsap.min.js"),
    "utf8"
  );
  const pngBuf = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#38bdf8"/></svg>`;
  const fontStub = Buffer.from("wOF2-demo-local-font-placeholder");
  const cssStr = `@font-face { font-family: 'LocalDemo'; src: url('../fonts/demo.woff2') format('woff2'); }
html, body { margin: 0; width: 640px; height: 360px; background: #0a1428; overflow: hidden; font-family: 'LocalDemo', sans-serif; }
#box { position: absolute; left: 40px; top: 140px; width: 80px; height: 80px; background: #22d3ee; }`;
  const mainHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <link rel="stylesheet" href="./styles/main.css" />
  <script src="./assets/gsap.min.js"></script>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="640" data-height="360" data-fps="30">
    <img id="svgImg" src="./assets/logo.svg" style="position:absolute;top:20px;left:20px;width:64px;height:64px;" />
    <img id="pngImg" src="./assets/pixel.png" style="position:absolute;top:20px;left:100px;width:32px;height:32px;" />
    <div id="box"></div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.to("#box", { x: 400, duration: 1, ease: "none" }, 0);
    window.__timelines["main"] = tl;
  </script>
</body>
</html>`;
  const altHtml = `<!doctype html><html><body><div>Alternate scene</div></body></html>`;

  return {
    "index.html": mainHtml,
    "scenes/alt.html": altHtml,
    "styles/main.css": cssStr,
    "assets/gsap.min.js": gsapCode,
    "assets/logo.svg": svgStr,
    "assets/pixel.png": pngBuf,
    "fonts/demo.woff2": fontStub,
    "notes/readme.txt": "unsupported extension note",
  };
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

  // 1. Folder Import (multi-HTML selection, asset loading via mf-asset://, Asset Tree, Export MP4, Original SHA-256 unchanged, Cleanup)
  let folderWorkingDir = null;
  {
    const srcProjectDir = path.join(workRoot, "user-folder-project");
    const files = buildSampleProjectFiles();
    const origHashes = {};
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(srcProjectDir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      origHashes[rel] = computeFileSha256Sync(target);
    }

    const promptRes = await ipcCtrl.importProjectFromFolder(srcProjectDir);
    assert.equal(promptRes.needsEntrySelection, true);
    assert.deepEqual(promptRes.candidates, ["index.html", "scenes/alt.html"]);

    const confirmed = await ipcCtrl.confirmPendingImport(promptRes.pendingImportId, "index.html");
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.session.sourceMode, "working_copy");
    assert.equal(confirmed.session.importKind, "folder");

    const activeSession = previewManager.getActiveSession();
    folderWorkingDir = activeSession.stageDir;
    assert.notEqual(path.resolve(folderWorkingDir), path.resolve(srcProjectDir));

    // Verify all assets loaded via mf-asset:// inside sandboxed preview
    await sleep(400);
    const domCheck = await activeSession.view.webContents.executeJavaScript(`({
      origin: window.origin,
      svgOk: document.getElementById("svgImg")?.naturalWidth === 64,
      pngOk: document.getElementById("pngImg")?.naturalWidth === 1,
      hasGsap: typeof window.gsap === "object",
      bgColor: getComputedStyle(document.body).backgroundColor
    })`);
    assert.equal(domCheck.origin, confirmed.session.origin);
    assert.equal(domCheck.svgOk, true);
    assert.equal(domCheck.pngOk, true);
    assert.equal(domCheck.hasGsap, true);
    assert.equal(domCheck.bgColor, "rgb(10, 20, 40)");

    // Verify Asset Tree structure statuses (entry, verified, unsupported, unused)
    const assetsDirNode = confirmed.session.assetTree.find((n) => n.name === "assets");
    const notesDirNode = confirmed.session.assetTree.find((n) => n.name === "notes");
    assert.ok(assetsDirNode && notesDirNode);
    assert.equal(assetsDirNode.children.find((c) => c.name === "logo.svg").validationStatus, "verified");
    assert.equal(assetsDirNode.children.find((c) => c.name === "pixel.png").validationStatus, "verified");
    assert.equal(notesDirNode.children.find((c) => c.name === "readme.txt").validationStatus, "unsupported");

    // Verify Studio UI renders Asset Tree and refreshes cleanly
    await studioWin.webContents.executeJavaScript(`
      window.mfStudio.refreshAssetTree(${JSON.stringify(confirmed.session.sessionId)}).then(r => r.assetTree.length)
    `);

    // Render MP4 directly from folder-imported working copy
    const renderOut = await studioWin.webContents.executeJavaScript(`
      window.mfStudio.startSessionRender({
        sessionId: ${JSON.stringify(confirmed.session.sessionId)},
        format: "mp4",
        quality: "draft",
        fps: { num: 30, den: 1 }
      })
    `);
    assert.equal(renderOut.status, "complete");
    const probe = ffprobeJson(renderOut.outputPath);
    const vs = (probe.streams || []).find((s) => s.codec_type === "video") || {};
    assert.equal(vs.codec_name, "h264");
    assert.equal(Number(vs.nb_frames), 30);

    // Verify original user folder files are bit-for-bit untouched
    for (const [rel, expectedSha] of Object.entries(origHashes)) {
      const actualSha = computeFileSha256Sync(path.join(srcProjectDir, ...rel.split("/")));
      assert.equal(actualSha, expectedSha, `Original file mutated: ${rel}`);
    }

    report.tests.folderImportPreviewExportAndShaIntegrity = {
      passed: true,
      candidates: promptRes.candidates,
      domCheck,
      exportFrames: Number(vs.nb_frames),
      originalShaUnchangedCount: Object.keys(origHashes).length,
    };
  }

  // 2. Valid Nested ZIP Import -> Preview Assets -> Export MP4 -> Cleanup removes temp dir
  let zipWorkingDir = null;
  {
    const zipPath = path.join(workRoot, "nested-project.zip");
    const files = buildSampleProjectFiles();
    const zipEntries = Object.entries(files).map(([name, data]) => ({
      name,
      data: Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"),
      method: 8,
    }));
    buildSyntheticZip(zipPath, zipEntries);

    const promptZip = await ipcCtrl.importProjectFromZip(zipPath);
    assert.equal(promptZip.needsEntrySelection, true);
    const confirmedZip = await ipcCtrl.confirmPendingImport(promptZip.pendingImportId, "index.html");
    assert.equal(confirmedZip.ok, true);
    assert.equal(confirmedZip.session.importKind, "zip");

    const activeSession = previewManager.getActiveSession();
    zipWorkingDir = activeSession.stageDir;

    // Closing previous folder session must have already deleted folderWorkingDir
    assert.equal(fs.existsSync(folderWorkingDir), false, "Previous folder working copy must be purged on new import");

    await sleep(400);
    const zipDom = await activeSession.view.webContents.executeJavaScript(`({
      pngOk: document.getElementById("pngImg")?.naturalWidth === 1,
      svgOk: document.getElementById("svgImg")?.naturalWidth === 64,
      hasGsap: typeof window.gsap === "object"
    })`);
    assert.equal(zipDom.pngOk, true);
    assert.equal(zipDom.svgOk, true);
    assert.equal(zipDom.hasGsap, true);

    const zipRender = await studioWin.webContents.executeJavaScript(`
      window.mfStudio.startSessionRender({
        sessionId: ${JSON.stringify(confirmedZip.session.sessionId)},
        format: "mp4",
        quality: "draft",
        fps: { num: 30, den: 1 }
      })
    `);
    assert.equal(zipRender.status, "complete");

    // Verify closing session deletes read-only ZIP working copy
    await previewManager.disposeActiveSession();
    assert.equal(fs.existsSync(zipWorkingDir), false, "ZIP working copy must be purged on session close");

    report.tests.zipImportPreviewExportAndCleanup = {
      passed: true,
      zipDom,
      zipExportStatus: zipRender.status,
      folderWorkingCopyPurged: !fs.existsSync(folderWorkingDir),
      zipWorkingCopyPurged: !fs.existsSync(zipWorkingDir),
    };
  }

  // 3. Adversarial Malicious ZIP Rejection Checks via Studio Import Coordinator
  {
    const cases = [
      { name: "traversal", entries: [{ name: "../../evil.html", data: "x" }], expectedCode: "ZIP_PATH_TRAVERSAL_FORBIDDEN" },
      { name: "symlink", entries: [{ name: "evil.html", data: "x", externalFileAttr: (0o120777 << 16) >>> 0 }], expectedCode: "ZIP_SYMLINK_FORBIDDEN" },
      { name: "drive", entries: [{ name: "C:\\evil.html", data: "x" }], expectedCode: "ZIP_DRIVE_OR_ADS_FORBIDDEN" },
      { name: "dupCase", entries: [{ name: "Index.html", data: "a" }, { name: "index.html", data: "b" }], expectedCode: "ZIP_DUPLICATE_CASE_INSENSITIVE_PATH" },
      { name: "zipBomb", entries: [{ name: "index.html", data: Buffer.alloc(200 * 1024, 0), method: 8 }], expectedCode: "ZIP_COMPRESSION_RATIO_EXCEEDED" },
    ];

    const rejectedCodes = {};
    for (const c of cases) {
      const zPath = path.join(workRoot, `evil-${c.name}.zip`);
      buildSyntheticZip(zPath, c.entries);
      await assert.rejects(
        () => ipcCtrl.importProjectFromZip(zPath),
        (err) => err instanceof ZipSecurityError && err.code === c.expectedCode
      );
      rejectedCodes[c.name] = c.expectedCode;
    }

    report.tests.maliciousZipRejections = { passed: true, rejectedCodes };
  }

  assert.equal(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join("; ")}`);
  assert.equal(unhandledRejections.length, 0, `Unexpected rejections: ${unhandledRejections.join("; ")}`);

  await ipcCtrl.dispose();
  await coordinator.shutdown();
  studioWin.destroy();

  const outPath = path.join(workRoot, "sprint4_verification_report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("=== SPRINT 4 IMPORT & ASSET TREE E2E PASSED ===");
  console.log(JSON.stringify(report, null, 2));
  return 0;
}
