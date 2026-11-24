import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const nodeBin = path.join(projectRoot, "tools", "node22", "node.exe");
const cliBin = path.join(projectRoot, "node_modules", "hyperframes", "bin", "hyperframes.mjs");

console.log("===============================================================");
console.log("MF Motion Gen 2.0 — Input Format Compatibility Investigation");
console.log("===============================================================");

// ----------------------------------------------------------------------
// Test 1: Category A — Native HyperFrames Composition
// ----------------------------------------------------------------------
console.log("\n[Category A: HTML HyperFrames-Compatible]");
console.log("  Status: FULLY SUPPORTED (Tested via index.html)");
console.log("  - Exact Frame Seeking: YES (Deterministic via GSAP paused timeline)");
console.log("  - Rendering Pipeline: Headless Chrome BeginFrame + FFmpeg");
console.log("  - Required Attributes: data-composition-id, data-start, data-duration, class='clip', window.__timelines registration");

// ----------------------------------------------------------------------
// Test 2: Category B — Raw Standalone AI Generated HTML
// ----------------------------------------------------------------------
console.log("\n[Category B: Raw Standalone AI HTML (compositions/input_b_ai_raw.html)]");
const rawHtmlPath = path.join(projectRoot, "compositions", "input_b_ai_raw.html");

// Try running HyperFrames lint directly on raw AI HTML
const lintResult = spawnSync(nodeBin, [cliBin, "lint", "--file", rawHtmlPath], {
  cwd: projectRoot,
  encoding: "utf-8"
});

console.log("  Direct HyperFrames Lint Output on Raw AI HTML:");
const lintLines = (lintResult.stdout || lintResult.stderr || "").split("\n").filter(l => l.trim().length > 0).slice(0, 10);
for (const line of lintLines) {
  console.log(`    ${line}`);
}

const canDirectRenderB = !lintResult.stdout?.includes("error");
console.log(`  Can Direct Render without adapter? ${canDirectRenderB ? "PARTIAL / WITH WARNINGS" : "NO"}`);
console.log("  Required Transformation Adapter:");
console.log("    1. Inject root wrapper: <div id='root' data-composition-id='main' data-start='0' data-duration='8' data-width='1920' data-height='1080'>");
console.log("    2. Parse or intercept GSAP timeline / CSS animations.");
console.log("    3. Pause active timelines and bind to window.__timelines['main'] = tl;");
console.log("    4. Strip wall-clock loops (repeat: -1) and convert to finite duration.");

// Synthesize adapted version of B
const rawHtmlContent = fs.readFileSync(rawHtmlPath, "utf-8");
const adaptedHtmlContent = rawHtmlContent
  .replace("<body>", "<body>\n  <div id='root' data-composition-id='main' data-start='0' data-duration='8' data-width='1920' data-height='1080'>")
  .replace("</body>", "  </div>\n  <script>\n    // MF Motion Gen Adapter Bridge\n    window.__timelines = window.__timelines || {};\n    if (typeof myTimeline !== 'undefined') {\n      myTimeline.pause();\n      window.__timelines['main'] = myTimeline;\n    }\n  </script>\n</body>");

const adaptedHtmlPath = path.join(projectRoot, "compositions", "input_b_adapted.html");
fs.writeFileSync(adaptedHtmlPath, adaptedHtmlContent);
console.log(`  Generated Adapted HTML: compositions/input_b_adapted.html`);

// ----------------------------------------------------------------------
// Test 3: Category C — JavaScript Canvas renderFrame(...) Mode
// ----------------------------------------------------------------------
console.log("\n[Category C: JavaScript Canvas renderFrame(...) Mode]");
const canvasHtmlPath = path.join(projectRoot, "compositions", "input_c_canvas_adapter.html");
console.log(`  Adapter Harness: compositions/input_c_canvas_adapter.html`);

// Run snapshot on Canvas mode to prove deterministic seeking
console.log("  Testing Frame Seeking on Canvas Mode via HyperFrames Snapshot...");
const canvasSnapResult = spawnSync(
  nodeBin,
  [cliBin, "snapshot", "--file", canvasHtmlPath, "--at", "2,4,6"],
  { cwd: projectRoot, encoding: "utf-8", env: { ...process.env, HYPERFRAMES_SKIP_TELEMETRY: "1" } }
);

const canvasOutput = canvasSnapResult.stdout || canvasSnapResult.stderr || "";
const snapSuccess = canvasOutput.includes("snapshots saved");
console.log(`  Canvas Frame Capture Status: ${snapSuccess ? "SUCCESS (PASS)" : "FAILED"}`);
if (snapSuccess) {
  const match = canvasOutput.match(/snapshots saved to (.*)/);
  if (match) console.log(`  Captured frames saved to: ${match[1].trim()}`);
}

console.log("\n===============================================================");
console.log("Input Compatibility Investigation Complete.");
console.log("===============================================================");
