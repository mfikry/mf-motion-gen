import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PRORES_60 = path.resolve('poc/hyperframes-spike/previews/round2/frame_prores_060.png');
const PURE_60 = path.resolve('poc/hyperframes-spike/previews/round2/pure_seek_060.png');

const pRaw = spawnSync('ffmpeg', ['-i', PURE_60, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });
const rRaw = spawnSync('ffmpeg', ['-i', PRORES_60, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });

const bufA = pRaw.stdout;
const bufB = rRaw.stdout;
const W = 1920;

console.log('Puppeteer Seek patch around (983, 427):');
for (let y = 424; y <= 430; y++) {
  let row = `y=${y}: `;
  for (let x = 980; x <= 986; x++) {
    const idx = (y * W + x) * 3;
    const isWhite = bufA[idx] > 200 && bufA[idx+1] > 200 && bufA[idx+2] > 200;
    row += isWhite ? '[W]' : '[.]';
  }
  console.log(row);
}

console.log('\nProRes Video patch around (983, 427):');
for (let y = 424; y <= 430; y++) {
  let row = `y=${y}: `;
  for (let x = 980; x <= 986; x++) {
    const idx = (y * W + x) * 3;
    const isWhite = bufB[idx] > 200 && bufB[idx+1] > 200 && bufB[idx+2] > 200;
    row += isWhite ? '[W]' : '[.]';
  }
  console.log(row);
}
