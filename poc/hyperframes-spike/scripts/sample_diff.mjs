import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PRORES_60 = path.resolve('poc/hyperframes-spike/previews/round2/frame_prores_060.png');
const PURE_60 = path.resolve('poc/hyperframes-spike/previews/round2/pure_seek_060.png');

const pRaw = spawnSync('ffmpeg', ['-i', PURE_60, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });
const rRaw = spawnSync('ffmpeg', ['-i', PRORES_60, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });

const bufA = pRaw.stdout;
const bufB = rRaw.stdout;

const W = 1920;

function sample(name, x, y) {
  const idx = (y * W + x) * 3;
  const rgbA = [bufA[idx], bufA[idx+1], bufA[idx+2]];
  const rgbB = [bufB[idx], bufB[idx+1], bufB[idx+2]];
  console.log(`${name} at (${x}, ${y}):`);
  console.log(`  Puppeteer Seek: RGB(${rgbA.join(',')})`);
  console.log(`  ProRes Video:   RGB(${rgbB.join(',')})`);
  console.log(`  Diff:           [${rgbA[0]-rgbB[0]}, ${rgbA[1]-rgbB[1]}, ${rgbA[2]-rgbB[2]}]`);
}

// Background top-left
sample('Background Top-Left', 100, 100);
// Globe center area
sample('Globe Center', 1300, 500);
// BREAKING Box
sample('BREAKING Box', 300, 580);
// NEWS Text
sample('NEWS Text', 400, 700);
// Sparkle / Star field
sample('Sparkle Field', 800, 200);

// Check if globe dots are shifted!
// Let's find highest diff pixel
let maxD = 0, maxX = 0, maxY = 0;
for (let y = 0; y < 1080; y++) {
  for (let x = 0; x < W; x++) {
    const idx = (y * W + x) * 3;
    const d = Math.max(Math.abs(bufA[idx]-bufB[idx]), Math.abs(bufA[idx+1]-bufB[idx+1]), Math.abs(bufA[idx+2]-bufB[idx+2]));
    if (d > maxD) {
      maxD = d;
      maxX = x;
      maxY = y;
    }
  }
}
sample(`Max Diff Pixel (${maxD})`, maxX, maxY);
