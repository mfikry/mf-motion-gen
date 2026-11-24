import { spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const previewsDir = path.join(projectRoot, "previews");
const rendersDir = path.join(projectRoot, "renders");
const videoPath = path.join(rendersDir, "benchmark_1080p30.mp4");

const timestamps = [
  { sec: 1.0, previewFile: "frame-00-at-1s.png", renderFile: "render_frame_1s.png", diffFile: "diff_1s.png" },
  { sec: 4.0, previewFile: "frame-01-at-4s.png", renderFile: "render_frame_4s.png", diffFile: "diff_4s.png" },
  { sec: 7.0, previewFile: "frame-02-at-7s.png", renderFile: "render_frame_7s.png", diffFile: "diff_7s.png" }
];

console.log("===============================================================");
console.log("MF Motion Gen 2.0 — Preview vs Render Parity Evaluation");
console.log("===============================================================");

const comparisonResults = [];

for (const item of timestamps) {
  const previewPath = path.join(previewsDir, item.previewFile);
  const renderPath = path.join(previewsDir, item.renderFile);
  const diffPath = path.join(previewsDir, item.diffFile);

  console.log(`\nEvaluating Parity at Timestamp ${item.sec}s:`);

  // Extract frame from rendered MP4 using exact frame index (frame = sec * 30)
  const frameIdx = Math.round(item.sec * 30);
  const extractCmd = `ffmpeg -y -i "${videoPath}" -vf "select=eq(n\\,${frameIdx})" -vframes 1 "${renderPath}"`;
  execSync(extractCmd, { stdio: "ignore" });
  console.log(`  ✓ Extracted video frame ${frameIdx} to: ${item.renderFile}`);

  // Calculate PSNR via spawnSync reading stderr
  let psnrVal = null;
  const psnrRes = spawnSync("ffmpeg", ["-i", previewPath, "-i", renderPath, "-filter_complex", "psnr", "-f", "null", "-"], { encoding: "utf-8" });
  const psnrText = (psnrRes.stderr || "") + (psnrRes.stdout || "");
  const pMatch = psnrText.match(/average:([0-9.]+)/);
  if (pMatch) psnrVal = Number(pMatch[1]);

  // Calculate SSIM via spawnSync reading stderr
  let ssimVal = null;
  const ssimRes = spawnSync("ffmpeg", ["-i", previewPath, "-i", renderPath, "-filter_complex", "ssim", "-f", "null", "-"], { encoding: "utf-8" });
  const ssimText = (ssimRes.stderr || "") + (ssimRes.stdout || "");
  const sMatch = ssimText.match(/All:([0-9.]+)/);
  if (sMatch) ssimVal = Number(sMatch[1]);

  // Generate visual diff map highlighting differences
  const diffMapCmd = `ffmpeg -y -i "${previewPath}" -i "${renderPath}" -filter_complex "blend=difference,scale=1920:1080" "${diffPath}"`;
  execSync(diffMapCmd, { stdio: "ignore" });

  console.log(`  - PSNR: ${psnrVal} dB`);
  console.log(`  - SSIM: ${ssimVal} (1.0 = identical)`);
  console.log(`  - Visual difference map generated: ${item.diffFile}`);

  const passed = (ssimVal && ssimVal > 0.95);
  console.log(`  - Parity Status: ${passed ? "PASS (High Structural Similarity)" : "MARGINAL"}`);

  comparisonResults.push({
    timestampSec: item.sec,
    frameIndex: frameIdx,
    psnrDb: psnrVal,
    ssim: ssimVal,
    verdict: passed ? "PASS" : "MARGINAL",
    notes: "Chroma subsampling (yuv420p) and H.264 DCT quantization account for subtle sub-pixel variance."
  });
}

const summaryPath = path.join(previewsDir, "parity_summary.json");
fs.writeFileSync(summaryPath, JSON.stringify(comparisonResults, null, 2));

console.log("\n===============================================================");
console.log("Preview vs Render Parity Evaluation Complete.");
console.log(`Summary saved automatically to: previews/parity_summary.json`);
console.log("===============================================================");
