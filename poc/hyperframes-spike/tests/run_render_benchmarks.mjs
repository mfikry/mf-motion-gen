import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const rendersDir = path.join(projectRoot, "renders");
const nodeBin = path.join(projectRoot, "tools", "node22", "node.exe");
const cliBin = path.join(projectRoot, "node_modules", "hyperframes", "bin", "hyperframes.mjs");

if (!fs.existsSync(rendersDir)) {
  fs.mkdirSync(rendersDir, { recursive: true });
}

function probeVideo(filePath) {
  try {
    const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`;
    const stdout = execSync(cmd).toString();
    const info = JSON.parse(stdout);
    const videoStream = info.streams.find((s) => s.codec_type === "video");
    return {
      format: info.format.format_name,
      duration: Number(info.format.duration),
      sizeBytes: Number(info.format.size),
      codec: videoStream?.codec_name,
      profile: videoStream?.profile,
      width: videoStream?.width,
      height: videoStream?.height,
      pixFmt: videoStream?.pix_fmt,
      fps: videoStream?.r_frame_rate,
      nbFrames: videoStream?.nb_frames
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function renderTarget(name, args, outPath) {
  console.log(`\n======================================================`);
  console.log(`Rendering: ${name}`);
  console.log(`Command: hyperframes ${args.join(" ")}`);
  console.log(`Output: ${outPath}`);
  console.log(`======================================================`);

  const startTime = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(nodeBin, [cliBin, "render", ...args, "-o", outPath], {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, HYPERFRAMES_SKIP_TELEMETRY: "1" }
    });

    proc.on("close", (code) => {
      const elapsedMs = Date.now() - startTime;
      const elapsedSec = (elapsedMs / 1000).toFixed(2);
      console.log(`\nFinished ${name} in ${elapsedSec}s (Exit code: ${code})`);

      if (fs.existsSync(outPath)) {
        const stats = fs.statSync(outPath);
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
        const probe = probeVideo(outPath);
        console.log(`  File size: ${sizeMb} MB (${stats.size} bytes)`);
        console.log(`  Probe details:`, JSON.stringify(probe, null, 2));
        resolve({
          name,
          exitCode: code,
          elapsedSec: Number(elapsedSec),
          sizeBytes: stats.size,
          sizeMb: Number(sizeMb),
          probe
        });
      } else {
        console.error(`  Output file was not created: ${outPath}`);
        resolve({
          name,
          exitCode: code,
          elapsedSec: Number(elapsedSec),
          error: "Output file not created"
        });
      }
    });
  });
}

async function runAllBenchmarks() {
  const benchmarks = [
    {
      name: "1080p30_MP4",
      args: ["--fps", "30", "--format", "mp4"],
      outPath: path.join(rendersDir, "benchmark_1080p30.mp4")
    },
    {
      name: "4K30_MP4",
      args: ["--fps", "30", "--format", "mp4", "--resolution", "landscape-4k"],
      outPath: path.join(rendersDir, "benchmark_4k30.mp4")
    },
    {
      name: "4K60_MP4",
      args: ["--fps", "60", "--format", "mp4", "--resolution", "landscape-4k"],
      outPath: path.join(rendersDir, "benchmark_4k60.mp4")
    },
    {
      name: "ProRes4444_MOV",
      args: ["--fps", "30", "--format", "mov"],
      outPath: path.join(rendersDir, "benchmark_prores4444.mov")
    }
  ];

  const results = [];

  for (const b of benchmarks) {
    const res = await renderTarget(b.name, b.args, b.outPath);
    results.push(res);
  }

  const reportPath = path.join(rendersDir, "benchmark_summary.json");
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\nAll benchmarks completed. Summary saved to: ${reportPath}`);
}

runAllBenchmarks().catch(console.error);
