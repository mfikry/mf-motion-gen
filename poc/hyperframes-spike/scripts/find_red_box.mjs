import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PRORES_60 = path.resolve('poc/hyperframes-spike/previews/round2/frame_prores_060.png');
const PURE_60 = path.resolve('poc/hyperframes-spike/previews/round2/pure_seek_060.png');

const pRaw = spawnSync('ffmpeg', ['-i', PURE_60, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });
const rRaw = spawnSync('ffmpeg', ['-i', PRORES_60, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });

const bufA = pRaw.stdout;
const bufB = rRaw.stdout;
const W = 1920;

function findRedBox(buf, name) {
  let minX = W, maxX = 0, minY = 1080, maxY = 0;
  for (let y = 300; y < 800; y++) {
    for (let x = 100; x < 1500; x++) {
      const idx = (y * W + x) * 3;
      const r = buf[idx];
      const g = buf[idx+1];
      const b = buf[idx+2];
      // Red box: r > 150, g < 30, b < 30
      if (r > 150 && g < 30 && b < 30) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  console.log(`${name} Red Box Bounding Box: x:[${minX}, ${maxX}] (w=${maxX-minX}), y:[${minY}, ${maxY}] (h=${maxY-minY})`);
}

findRedBox(bufA, 'Puppeteer Seek');
findRedBox(bufB, 'ProRes Video');
