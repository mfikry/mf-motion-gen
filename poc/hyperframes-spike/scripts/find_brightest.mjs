import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PRORES_60 = path.resolve('poc/hyperframes-spike/previews/round2/frame_prores_060.png');
const PURE_60 = path.resolve('poc/hyperframes-spike/previews/round2/pure_seek_060.png');

const pRaw = spawnSync('ffmpeg', ['-i', PURE_60, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });
const rRaw = spawnSync('ffmpeg', ['-i', PRORES_60, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });

const bufA = pRaw.stdout;
const bufB = rRaw.stdout;

const W = 1920;

function findBrightest(buf, name) {
  let maxVal = 0;
  let bestX = 0, bestY = 0;
  for (let y = 300; y < 600; y++) {
    for (let x = 700; x < 1200; x++) {
      const idx = (y * W + x) * 3;
      const v = buf[idx] + buf[idx+1] + buf[idx+2];
      if (v > maxVal) {
        maxVal = v;
        bestX = x;
        bestY = y;
      }
    }
  }
  console.log(`${name} brightest in orbit area: (${bestX}, ${bestY}) with RGB(${buf[(bestY*W+bestX)*3]}, ${buf[(bestY*W+bestX)*3+1]}, ${buf[(bestY*W+bestX)*3+2]})`);
}

findBrightest(bufA, 'Puppeteer Seek');
findBrightest(bufB, 'ProRes Video');
