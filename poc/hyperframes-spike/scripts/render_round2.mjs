import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const ROOT_SPIKE = path.resolve('poc/hyperframes-spike');
const NODE22_DIR = path.join(ROOT_SPIKE, 'tools/node22');
const CLI_CMD = path.join(ROOT_SPIKE, 'node_modules/.bin/hyperframes.cmd');

const COMPOSITION = path.join(ROOT_SPIKE, 'compositions/round2/breaking_news_localized.html');
const MP4_OUT = path.join(ROOT_SPIKE, 'renders/round2/breaking_news_1080p30.mp4');
const PRORES_OUT = path.join(ROOT_SPIKE, 'renders/round2/breaking_news_prores4444.mov');

const env = {
  ...process.env,
  PATH: `${NODE22_DIR};${process.env.PATH}`
};

function runRender(args, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n======================================================`);
    console.log(`[START] ${label}`);
    console.log(`Command: hyperframes ${args.join(' ')}`);
    console.log(`======================================================`);
    const startTime = Date.now();

    const child = spawn(`"${CLI_CMD}"`, args, {
      cwd: ROOT_SPIKE,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true
    });

    child.stdout.on('data', data => {
      process.stdout.write(data);
    });

    child.stderr.on('data', data => {
      process.stderr.write(data);
    });

    child.on('close', code => {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`\n[SUCCESS] ${label} finished in ${elapsedSec}s (Exit code: 0)`);
        resolve({ elapsedSec, code });
      } else {
        console.error(`\n[FAILED] ${label} failed with exit code ${code} after ${elapsedSec}s`);
        reject(new Error(`${label} failed with exit code ${code}`));
      }
    });

    child.on('error', err => {
      reject(err);
    });
  });
}

async function main() {
  console.log('MF Motion Gen 2.0 — HyperFrames Round 2 Rendering Execution');
  console.log('Composition:', COMPOSITION);

  // 1. Render MP4 H.264
  const mp4Args = [
    'render',
    '-c', 'compositions/round2/breaking_news_localized.html',
    '--fps', '30',
    '-o', 'renders/round2/breaking_news_1080p30.mp4'
  ];
  const mp4Result = await runRender(mp4Args, 'Render MP4 1080p30 (H.264)');

  // 2. Render ProRes 4444 High-Quality Mezzanine Master
  const proresArgs = [
    'render',
    '-c', 'compositions/round2/breaking_news_localized.html',
    '--format', 'mov',
    '--fps', '30',
    '-o', 'renders/round2/breaking_news_prores4444.mov'
  ];
  const proresResult = await runRender(proresArgs, 'Render ProRes 4444 Mezzanine (MOV)');

  // Stat outputs
  const mp4Stats = fs.statSync(MP4_OUT);
  const mp4Hash = crypto.createHash('sha256').update(fs.readFileSync(MP4_OUT)).digest('hex');

  const proresStats = fs.statSync(PRORES_OUT);
  const proresHash = crypto.createHash('sha256').update(fs.readFileSync(PRORES_OUT)).digest('hex');

  const summary = {
    date: new Date().toISOString(),
    mp4: {
      path: MP4_OUT,
      bytes: mp4Stats.size,
      sizeMb: (mp4Stats.size / (1024 * 1024)).toFixed(2),
      sha256: mp4Hash,
      renderDurationSec: mp4Result.elapsedSec
    },
    prores: {
      path: PRORES_OUT,
      bytes: proresStats.size,
      sizeMb: (proresStats.size / (1024 * 1024)).toFixed(2),
      sha256: proresHash,
      renderDurationSec: proresResult.elapsedSec
    }
  };

  const summaryPath = path.join(ROOT_SPIKE, 'reports/round2_render_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n======================================================');
  console.log('RENDER SUMMARY');
  console.log('======================================================');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error('Fatal rendering error:', err);
  process.exit(1);
});
