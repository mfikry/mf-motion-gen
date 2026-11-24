import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const PRORES_60 = path.resolve('poc/hyperframes-spike/previews/round2/frame_prores_060.png');
const PURE_60 = path.resolve('poc/hyperframes-spike/previews/round2/pure_seek_060.png');

// Get raw RGB buffers
const pRaw = spawnSync('ffmpeg', ['-i', PURE_60, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });
const rRaw = spawnSync('ffmpeg', ['-i', PRORES_60, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });

const bufA = pRaw.stdout;
const bufB = rRaw.stdout;

const W = 1920;
const H = 1080;

// Find bounding boxes of differences with delta > 20
let minX = W, maxX = 0, minY = H, maxY = 0;
let diffCount = 0;

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const idx = (y * W + x) * 3;
    const dr = Math.abs(bufA[idx] - bufB[idx]);
    const dg = Math.abs(bufA[idx + 1] - bufB[idx + 1]);
    const db = Math.abs(bufA[idx + 2] - bufB[idx + 2]);
    const maxDiff = Math.max(dr, dg, db);
    if (maxDiff > 20) {
      diffCount++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

console.log(`Frame 60 diff:`);
console.log(`Pixels with max channel diff > 20: ${diffCount} / ${W * H} (${((diffCount / (W * H)) * 100).toFixed(2)}%)`);
console.log(`Bounding box: x: [${minX}, ${maxX}], y: [${minY}, ${maxY}]`);

// Also check Frame 150
const PRORES_150 = path.resolve('poc/hyperframes-spike/previews/round2/frame_prores_150.png');
const PURE_150 = path.resolve('poc/hyperframes-spike/previews/round2/pure_seek_150.png');

const pRaw150 = spawnSync('ffmpeg', ['-i', PURE_150, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });
const rRaw150 = spawnSync('ffmpeg', ['-i', PRORES_150, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });
const bA150 = pRaw150.stdout;
const bB150 = rRaw150.stdout;

let minX150 = W, maxX150 = 0, minY150 = H, maxY150 = 0;
let diffCount150 = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const idx = (y * W + x) * 3;
    const dr = Math.abs(bA150[idx] - bB150[idx]);
    const dg = Math.abs(bA150[idx + 1] - bB150[idx + 1]);
    const db = Math.abs(bA150[idx + 2] - bB150[idx + 2]);
    const maxDiff = Math.max(dr, dg, db);
    if (maxDiff > 20) {
      diffCount150++;
      if (x < minX150) minX150 = x;
      if (x > maxX150) maxX150 = x;
      if (y < minY150) minY150 = y;
      if (y > maxY150) maxY150 = y;
    }
  }
}
console.log(`\nFrame 150 diff:`);
console.log(`Pixels with max channel diff > 20: ${diffCount150} / ${W * H} (${((diffCount150 / (W * H)) * 100).toFixed(2)}%)`);
console.log(`Bounding box: x: [${minX150}, ${maxX150}], y: [${minY150}, ${maxY150}]`);
