import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../shared/previewContracts.js";
import { PINNED_RUNTIME } from "../shared/renderContracts.js";
import { PreviewContainerManager } from "./preview/previewContainerManager.js";
import { registerStudioIpcHandlers } from "./ipc/studioIpcHandler.js";
import { RenderCoordinator } from "./render/renderCoordinator.js";
import { registerCustomSchemes } from "./security/assetProtocolHandler.js";

export { RenderCoordinator, RenderPreflightError } from "./render/renderCoordinator.js";
export { RenderWorkerHost } from "./render/renderWorkerHost.js";
export { PreviewContainerManager } from "./preview/previewContainerManager.js";
export { validateCompositionPreflight } from "./validation/hostPreflightValidator.js";

// Synchronously register custom protocol scheme privileges BEFORE app 'ready'
registerCustomSchemes();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

export async function createStudioWindow(
  previewManager: PreviewContainerManager,
  coordinator: RenderCoordinator
): Promise<BrowserWindow> {
  const studioHtmlPath = path.join(repoRoot, "src", "renderer", "index.html");
  const studioOrigin = pathToFileURL(studioHtmlPath).href;
  const preloadPath = path.join(__dirname, "..", "preload", "studioPreload.cjs");

  const win = new BrowserWindow({
    width: 1280,
    height: 780,
    backgroundColor: "#0b0f19",
    show: process.env.MF_HEADLESS_WINDOW !== "1",
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  previewManager.attachHostWindow(win);
  registerStudioIpcHandlers(win, studioOrigin, previewManager, coordinator);

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== studioOrigin) {
      event.preventDefault();
    }
  });

  await win.loadFile(studioHtmlPath);
  return win;
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const smokeScriptEnv = process.env.MF_E2E_SCRIPT;
  if (smokeScriptEnv) {
    const mod = await import(pathToFileURL(path.resolve(smokeScriptEnv)).href);
    if (typeof mod.runElectronVerification !== "function") {
      throw new Error(`E2E script ${smokeScriptEnv} must export runElectronVerification()`);
    }
    const exitCode: number = await mod.runElectronVerification({
      app,
      BrowserWindow,
      RenderCoordinator,
      PreviewContainerManager,
      registerStudioIpcHandlers,
      PINNED_RUNTIME,
    });
    app.exit(exitCode);
    return;
  }

  const smokeJsonPath = process.env.MF_SMOKE_REQUEST_JSON;
  if (smokeJsonPath && fs.existsSync(smokeJsonPath)) {
    const req = JSON.parse(fs.readFileSync(smokeJsonPath, "utf8"));
    const coordinator = new RenderCoordinator();
    try {
      const outcome = await coordinator.render(req);
      console.log(JSON.stringify(outcome, null, 2));
      await coordinator.shutdown();
      app.exit(outcome.execution.result.status === "complete" ? 0 : 1);
    } catch (err) {
      console.error(err);
      await coordinator.shutdown();
      app.exit(1);
    }
    return;
  }

  const coordinator = new RenderCoordinator();
  let mainWindow: BrowserWindow | null = null;
  const previewManager = new PreviewContainerManager((violation) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.eventSecurityViolation, violation);
    }
  });

  mainWindow = await createStudioWindow(previewManager, coordinator);
  mainWindow.on("closed", () => {
    mainWindow = null;
    void Promise.all([previewManager.disposeActiveSession(), coordinator.shutdown()]).finally(() => {
      app.quit();
    });
  });
}

app.on("window-all-closed", () => {
  // Handled by mainWindow closed or explicit app.exit in E2E runner
});

void bootstrap().catch((err) => {
  console.error("MF Motion Gen Main bootstrap failed:", err);
  app.exit(1);
});
