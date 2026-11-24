import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const rendersDir = path.join(projectRoot, "renders");
const previewsDir = path.join(projectRoot, "previews");
const nodeBin = path.join(projectRoot, "tools", "node22", "node.exe");
const cliBin = path.join(projectRoot, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
const compositionPath = path.join(projectRoot, "compositions", "transparent_alpha_test.html");
const movPath = path.join(rendersDir, "verified_prores4444.mov");

console.log("===============================================================");
console.log("MF Motion Gen 2.0 — ProRes 4444 Alpha Transparency Validation");
console.log("===============================================================");

// 1. Render Transparent MOV
console.log("\n[1] Rendering Transparent Composition to ProRes 4444 MOV...");
const renderStart = Date.now();
const renderResult = spawnSync(
  nodeBin,
  [cliBin, "render", "-c", "compositions/transparent_alpha_test.html", "--format", "mov", "--fps", "30", "-o", movPath],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, HYPERFRAMES_SKIP_TELEMETRY: "1" }
  }
);

const elapsedSec = ((Date.now() - renderStart) / 1000).toFixed(2);
console.log(`\nRender finished in ${elapsedSec}s (Exit code: ${renderResult.status})`);

if (!fs.existsSync(movPath)) {
  console.error("FATAL: MOV file was not generated:", movPath);
  process.exit(1);
}

// 2. FFprobe Stream Inspection
console.log("\n[2] Inspecting MOV Streams via FFprobe...");
const probeStdout = execSync(`ffprobe -v quiet -print_format json -show_streams -show_format "${movPath}"`).toString();
const probeData = JSON.parse(probeStdout);
const videoStream = probeData.streams.find((s) => s.codec_type === "video");

console.log(`    Codec:       ${videoStream.codec_name}`);
console.log(`    Profile:     ${videoStream.profile}`);
console.log(`    PixelFormat: ${videoStream.pix_fmt}`);
console.log(`    Resolution:  ${videoStream.width}x${videoStream.height}`);
console.log(`    Duration:    ${probeData.format.duration}s`);
console.log(`    FileSize:    ${(probeData.format.size / (1024 * 1024)).toFixed(2)} MB`);

// 3. Extract Alpha Channel to Grayscale PNG via FFmpeg alphaextract filter
console.log("\n[3] Extracting Alpha Channel Frames with FFmpeg alphaextract...");
const timestamps = [1.0, 2.5];
const analysisResults = [];

for (const t of timestamps) {
  const frameIdx = Math.round(t * 30);
  const colorFramePng = path.join(previewsDir, `transparent_color_${t}s.png`);
  const alphaFramePng = path.join(previewsDir, `transparent_alpha_${t}s.png`);
  const rawAlphaGray = path.join(previewsDir, `raw_alpha_${t}s.gray`);

  // Extract color frame (RGBA with transparent background rendered as PNG)
  execSync(`ffmpeg -y -ss ${t} -i "${movPath}" -vframes 1 "${colorFramePng}"`, { stdio: "ignore" });

  // Extract pure alpha channel as visible grayscale PNG (white = opaque, black = transparent)
  execSync(`ffmpeg -y -ss ${t} -i "${movPath}" -vframes 1 -vf "alphaextract" "${alphaFramePng}"`, { stdio: "ignore" });

  // Extract raw 8-bit luma bytes to inspect every single pixel value programmatically
  execSync(`ffmpeg -y -ss ${t} -i "${movPath}" -vframes 1 -vf "alphaextract" -pix_fmt gray -f rawvideo "${rawAlphaGray}"`, { stdio: "ignore" });

  // Analyze raw byte histogram (1920 x 1080 = 2,073,600 pixels)
  const rawBytes = fs.readFileSync(rawAlphaGray);
  const totalPixels = rawBytes.length;

  let countTransparent = 0; // value == 0
  let countSemi = 0;        // 0 < value < 255
  let countOpaque = 0;      // value == 255
  const sampleValues = new Set();

  for (let i = 0; i < totalPixels; i++) {
    const val = rawBytes[i];
    if (val === 0) {
      countTransparent++;
    } else if (val === 255) {
      countOpaque++;
    } else {
      countSemi++;
      if (sampleValues.size < 10) sampleValues.add(val);
    }
  }

  // Clean temporary raw gray dump
  fs.unlinkSync(rawAlphaGray);

  const pctTrans = ((countTransparent / totalPixels) * 100).toFixed(2);
  const pctSemi = ((countSemi / totalPixels) * 100).toFixed(2);
  const pctOpaque = ((countOpaque / totalPixels) * 100).toFixed(2);

  console.log(`\n  Timestamp ${t}s (Frame ${frameIdx}):`);
  console.log(`    Total Pixels Analyzed:       ${totalPixels.toLocaleString()}`);
  console.log(`    100% Transparent (Alpha = 0):   ${countTransparent.toLocaleString()} (${pctTrans}%)`);
  console.log(`    Semi-Transparent (0 < A < 255): ${countSemi.toLocaleString()} (${pctSemi}%)`);
  console.log(`    100% Opaque (Alpha = 255):      ${countOpaque.toLocaleString()} (${pctOpaque}%)`);
  console.log(`    Sample Intermediate Alphas:  [${Array.from(sampleValues).join(", ")}]`);

  const hasTrans = countTransparent > 50000;
  const hasSemi = countSemi > 5000;
  const hasOpaque = countOpaque > 50000;
  const passed = hasTrans && hasSemi && hasOpaque;

  console.log(`    Verification Verdict:        ${passed ? "CONFIRMED VALID ALPHA (PASS)" : "FAILED"}`);

  analysisResults.push({
    timestampSec: t,
    frameIndex: frameIdx,
    totalPixels,
    transparentPixels: countTransparent,
    transparentPercent: Number(pctTrans),
    semiTransparentPixels: countSemi,
    semiTransparentPercent: Number(pctSemi),
    opaquePixels: countOpaque,
    opaquePercent: Number(pctOpaque),
    sampleIntermediateAlphas: Array.from(sampleValues),
    passed
  });
}

const summaryPath = path.join(rendersDir, "prores_alpha_analysis.json");
fs.writeFileSync(summaryPath, JSON.stringify({
  video: {
    codec: videoStream.codec_name,
    profile: videoStream.profile,
    pixFmt: videoStream.pix_fmt,
    width: videoStream.width,
    height: videoStream.height
  },
  tests: analysisResults
}, null, 2));

console.log("\n===============================================================");
console.log(`Analysis complete. Report saved to: ${summaryPath}`);
console.log("===============================================================");
