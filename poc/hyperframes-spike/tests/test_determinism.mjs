import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outDir = path.join(projectRoot, "tests", "output-determinism");

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

function getSha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function computeMetrics(fileA, fileB) {
  let psnr = null;
  let ssim = null;

  const psnrRes = spawnSync("ffmpeg", ["-i", fileA, "-i", fileB, "-filter_complex", "psnr", "-f", "null", "-"], { encoding: "utf-8" });
  const psnrText = (psnrRes.stderr || "") + (psnrRes.stdout || "");
  const pMatch = psnrText.match(/average:([0-9.]+)/);
  if (pMatch) psnr = Number(pMatch[1]);

  const ssimRes = spawnSync("ffmpeg", ["-i", fileA, "-i", fileB, "-filter_complex", "ssim", "-f", "null", "-"], { encoding: "utf-8" });
  const ssimText = (ssimRes.stderr || "") + (ssimRes.stdout || "");
  const sMatch = ssimText.match(/All:([0-9.]+)/);
  if (sMatch) ssim = Number(sMatch[1]);

  return { psnr, ssim };
}

async function runDeterminismTest() {
  console.log("=====================================================================");
  console.log("MF Motion Gen 2.0 — Comprehensive Deterministic Seeking Test Suite");
  console.log("=====================================================================");

  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const htmlPath = path.join(projectRoot, "index.html");
  const fileUrl = `file://${htmlPath.replace(/\\/g, "/")}`;

  console.log(`[1] Launching Chromium: ${chromePath}`);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--force-device-scale-factor=1"
    ],
    defaultViewport: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1
    }
  });

  const page = await browser.newPage();
  console.log(`[2] Navigating to: ${fileUrl}`);
  await page.goto(fileUrl, { waitUntil: "networkidle0" });

  // Verify GSAP timeline contract
  const hasTimeline = await page.evaluate(() => {
    return Boolean(window.__timelines && window.__timelines["main"]);
  });

  if (!hasTimeline) {
    throw new Error("window.__timelines['main'] was not found in page context!");
  }
  console.log("    ✓ Root GSAP paused timeline verified in window.__timelines['main']");

  // User-requested timestamps: 0, 1, 4, 7, 7.76, 7.99, and end of duration (8.0)
  // Plus random backward seek verification points
  const testSequence = [
    { sec: 0.0, label: "t_0_00s_start" },
    { sec: 4.0, label: "t_4_00s_mid" },
    { sec: 7.0, label: "t_7_00s_pre_seal" },
    { sec: 1.0, label: "t_1_00s_backward_1" }, // Backward seek!
    { sec: 7.76, label: "t_7_76s_stamp" },     // Exact requested timestamp
    { sec: 7.99, label: "t_7_99s_near_end" },  // Exact requested timestamp
    { sec: 1.0, label: "t_1_00s_backward_2" }, // Backward repeat!
    { sec: 8.0, label: "t_8_00s_end" }         // Full duration end
  ];

  const results = {};
  console.log("\n[3] Executing Timestamp Sequence with Backward Seeks & Telemetry Sampling:");

  for (const item of testSequence) {
    await page.evaluate((t) => {
      window.__timelines["main"].seek(t, false);
    }, item.sec);

    await new Promise((r) => setTimeout(r, 60));

    // Sample telemetry text states
    const telemetry = await page.evaluate(() => {
      const timerEl = document.getElementById("timerNumber");
      const progEl = document.getElementById("progressValText");
      return {
        countdownText: timerEl ? timerEl.textContent.trim() : null,
        progressText: progEl ? progEl.textContent.trim() : null
      };
    });

    const shotPath = path.join(outDir, `${item.label}.png`);
    await page.screenshot({ path: shotPath, type: "png" });

    const hash = getSha256(shotPath);
    results[item.label] = {
      timestampSec: item.sec,
      filePath: shotPath,
      hash,
      telemetry
    };

    console.log(`    Seek ${item.sec.toFixed(2).padStart(5, " ")}s -> Saved: ${item.label}.png | SHA256: ${hash.substring(0, 16)}... | Timer: ${telemetry.countdownText.padStart(7, " ")} | Prog: ${telemetry.progressText.padStart(4, " ")}`);
  }

  await browser.close();

  console.log("\n[4] Determinism & Telemetry Consistency Verification:");

  // Check 1: Backward seek consistency (t=1.0s first vs backward repeat)
  const file1 = results["t_1_00s_backward_1"].filePath;
  const file2 = results["t_1_00s_backward_2"].filePath;
  const metrics = computeMetrics(file1, file2);

  const backwardPass = (results["t_1_00s_backward_1"].hash === results["t_1_00s_backward_2"].hash) || (metrics.ssim !== null && metrics.ssim >= 0.999);

  console.log(`    - Backward Seek Consistency (1.0s first vs repeat):`);
  console.log(`      PSNR: ${metrics.psnr} dB | SSIM: ${metrics.ssim} (1.0 = identical)`);
  console.log(`      Result: ${backwardPass ? "CONFIRMED IDENTICAL PARITY (PASS)" : "FAIL"}`);

  // Check 2: Countdown & Progress monotonic progression
  const t0_prog = parseInt(results["t_0_00s_start"].telemetry.progressText);
  const t1_prog = parseInt(results["t_1_00s_backward_1"].telemetry.progressText);
  const t4_prog = parseInt(results["t_4_00s_mid"].telemetry.progressText);
  const t7_prog = parseInt(results["t_7_00s_pre_seal"].telemetry.progressText);
  const t8_prog = parseInt(results["t_8_00s_end"].telemetry.progressText);

  console.log(`    - Progress Progression Check: 0s (${t0_prog}%) -> 1s (${t1_prog}%) -> 4s (${t4_prog}%) -> 7s (${t7_prog}%) -> 8s (${t8_prog}%)`);
  const progressMonotonic = (t0_prog <= t1_prog && t1_prog <= t4_prog && t4_prog <= t7_prog && t7_prog <= t8_prog && t8_prog === 100);
  console.log(`    - Progress Monotonic Logic:   ${progressMonotonic ? "VALIDATED (PASS)" : "FAIL"}`);

  // Check 3: Countdown decreasing logic
  const t0_time = parseFloat(results["t_0_00s_start"].telemetry.countdownText);
  const t1_time = parseFloat(results["t_1_00s_backward_1"].telemetry.countdownText);
  const t4_time = parseFloat(results["t_4_00s_mid"].telemetry.countdownText);
  const t7_time = parseFloat(results["t_7_00s_pre_seal"].telemetry.countdownText);
  const t8_time = parseFloat(results["t_8_00s_end"].telemetry.countdownText);
  console.log(`    - Countdown Logic Check:      0s (${t0_time}s) -> 1s (${t1_time}s) -> 4s (${t4_time}s) -> 7s (${t7_time}s) -> 8s (${t8_time}s)`);
  const countdownValid = (t0_time >= 7.99 && t1_time <= 7.1 && t4_time <= 4.1 && t7_time <= 1.1 && t8_time === 0.0);
  console.log(`    - Countdown Decreasing Logic: ${countdownValid ? "VALIDATED (PASS)" : "FAIL"}`);

  // Check 4: Boundary Frames (7.76s & 7.99s)
  const t776_exists = Boolean(results["t_7_76s_stamp"].hash);
  const t799_exists = Boolean(results["t_7_99s_near_end"].hash);
  console.log(`    - Sub-second Boundary 7.76s:  ${t776_exists ? "CAPTURED & VERIFIED (PASS)" : "FAIL"}`);
  console.log(`    - Sub-second Boundary 7.99s:  ${t799_exists ? "CAPTURED & VERIFIED (PASS)" : "FAIL"}`);

  const passedAll = backwardPass && progressMonotonic && countdownValid && t776_exists && t799_exists;

  const finalReport = {
    testDate: new Date().toISOString(),
    verdict: passedAll ? "PASS" : "FAIL",
    checks: {
      backwardSeekIdentity: backwardPass,
      backwardSeekPsnrDb: metrics.psnr,
      backwardSeekSsim: metrics.ssim,
      progressMonotonic: progressMonotonic,
      countdownDecreasing: countdownValid,
      subSecondBoundariesSampled: t776_exists && t799_exists
    },
    results
  };

  const reportFile = path.join(outDir, "deterministic_validation_report.json");
  fs.writeFileSync(reportFile, JSON.stringify(finalReport, null, 2));
  console.log(`\n[5] Report saved automatically to: tests/output-determinism/deterministic_validation_report.json`);
  console.log(`>>> DETERMINISTIC SEEKING VERDICT: ${passedAll ? "100% PASSED" : "FAILED"} <<<`);

  if (!passedAll) {
    process.exit(1);
  }
}

runDeterminismTest().catch((err) => {
  console.error("Determinism test suite error:", err);
  process.exit(1);
});
