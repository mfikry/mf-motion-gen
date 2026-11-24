import fs from "node:fs";
import path from "node:path";
import { spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const previewsDir = path.join(projectRoot, "previews");
const rendersDir = path.join(projectRoot, "renders");

const movPath = path.join(rendersDir, "gemini_lifetime_fixed_prores4444.mov");
const mp4Path = path.join(rendersDir, "gemini_lifetime_fixed_1080p30.mp4");

const testFrames = [0, 30, 120, 186, 210, 233, 239];

function computeMetrics(fileA, fileB) {
  const psnrRes = spawnSync("ffmpeg", ["-i", fileA, "-i", fileB, "-filter_complex", "psnr", "-f", "null", "-"], { encoding: "utf-8" });
  const psnrMatch = (psnrRes.stderr || "").match(/average:([0-9.]+)/);

  const ssimRes = spawnSync("ffmpeg", ["-i", fileA, "-i", fileB, "-filter_complex", "ssim", "-f", "null", "-"], { encoding: "utf-8" });
  const ssimMatch = (ssimRes.stderr || "").match(/All:([0-9.]+)/);

  return {
    psnr: psnrMatch ? Number(psnrMatch[1]) : null,
    ssim: ssimMatch ? Number(ssimMatch[1]) : null
  };
}

console.log("=========================================================================");
console.log("MF Motion Gen 2.0 — Isolated Renderer vs Encoder Parity Analysis");
console.log("=========================================================================\n");

const results = [];

for (const fIdx of testFrames) {
  const previewPath = path.join(previewsDir, `fixed_preview_methodB_frame_${String(fIdx).padStart(3, "0")}.png`);
  const proresPath = path.join(previewsDir, `frame_prores_${String(fIdx).padStart(3, "0")}.png`);
  const mp4PathOut = path.join(previewsDir, `frame_mp4_${String(fIdx).padStart(3, "0")}.png`);
  const diffRendererPath = path.join(previewsDir, `diff_renderer_frame_${String(fIdx).padStart(3, "0")}.png`);
  const diffEncoderPath = path.join(previewsDir, `diff_encoder_frame_${String(fIdx).padStart(3, "0")}.png`);

  // Extract from ProRes 4444 MOV with rgb24
  const extractMov = spawnSync("ffmpeg", ["-y", "-i", movPath, "-vf", `select=eq(n\\,${fIdx})`, "-vsync", "0", "-pix_fmt", "rgb24", "-vframes", "1", proresPath]);
  if (extractMov.status !== 0) throw new Error(`Extracting MOV failed on frame ${fIdx}: ${extractMov.stderr}`);

  // Extract from MP4 H.264 with rgb24
  const extractMp4 = spawnSync("ffmpeg", ["-y", "-i", mp4Path, "-vf", `select=eq(n\\,${fIdx})`, "-vsync", "0", "-pix_fmt", "rgb24", "-vframes", "1", mp4PathOut]);
  if (extractMp4.status !== 0) throw new Error(`Extracting MP4 failed on frame ${fIdx}: ${extractMp4.stderr}`);

  // 1. Comparison 1: Renderer Difference (Preview Frame vs HyperFrames ProRes 4444 Capture)
  const rendererMetrics = computeMetrics(previewPath, proresPath);

  // 2. Comparison 2: Encoder Difference (HyperFrames ProRes 4444 vs H.264 MP4)
  const encoderMetrics = computeMetrics(proresPath, mp4PathOut);

  // 3. Comparison 3: End-to-End Difference (Preview Frame vs H.264 MP4)
  const e2eMetrics = computeMetrics(previewPath, mp4PathOut);

  // Generate visual diff maps
  spawnSync("ffmpeg", ["-y", "-i", previewPath, "-i", proresPath, "-filter_complex", "blend=difference,scale=1920:1080", diffRendererPath]);
  spawnSync("ffmpeg", ["-y", "-i", proresPath, "-i", mp4PathOut, "-filter_complex", "blend=difference,scale=1920:1080", diffEncoderPath]);

  console.log(`Frame ${String(fIdx).padStart(3, "0")} (${(fIdx / 30).toFixed(4)}s):`);
  console.log(`  [A] RENDERER VARIANCE (Preview vs ProRes): SSIM = ${rendererMetrics.ssim}, PSNR = ${rendererMetrics.psnr} dB`);
  console.log(`  [B] ENCODER VARIANCE  (ProRes vs MP4):    SSIM = ${encoderMetrics.ssim}, PSNR = ${encoderMetrics.psnr} dB`);
  console.log(`  [C] END-TO-END VARIANCE (Preview vs MP4):  SSIM = ${e2eMetrics.ssim}, PSNR = ${e2eMetrics.psnr} dB\n`);

  results.push({
    frameIndex: fIdx,
    timestampSec: fIdx / 30,
    rendererVariance: rendererMetrics,
    encoderVariance: encoderMetrics,
    endToEndVariance: e2eMetrics,
    previewFile: path.basename(previewPath),
    proresFrameFile: path.basename(proresPath),
    mp4FrameFile: path.basename(mp4PathOut),
    diffRendererFile: path.basename(diffRendererPath),
    diffEncoderFile: path.basename(diffEncoderPath)
  });
}

const outputPath = path.join(rendersDir, "renderer_vs_encoder_parity_analysis.json");
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
console.log(`Analysis complete. Report saved to: ${outputPath}`);
