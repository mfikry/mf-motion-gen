import puppeteer from 'puppeteer-core';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Users\\User\\.cache\\hyperframes\\chrome\\chrome-headless-shell\\win64-158.0.8127.36\\chrome-headless-shell-win64\\chrome-headless-shell.exe';
const HTML = 'file:///' + path.resolve('poc/hyperframes-spike/compositions/round2/breaking_news_localized.html').replace(/\\/g, '/');

async function check() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(HTML, { waitUntil: 'networkidle0' });

  for (const f of [0, 30, 60, 90, 150, 240, 270, 285, 299]) {
    const sec = f === 299 ? 9.966667 : f / 30.0;
    await page.evaluate((t) => { window.__timelines['main'].seek(t); }, sec);
    const pureSeekPath = path.resolve(`poc/hyperframes-spike/previews/round2/pure_seek_${String(f).padStart(3, '0')}.png`);
    await page.screenshot({ path: pureSeekPath });

    const proresPath = path.resolve(`poc/hyperframes-spike/previews/round2/frame_prores_${String(f).padStart(3, '0')}.png`);
    const fwdPrevPath = path.resolve(`poc/hyperframes-spike/previews/round2/preview_fwd_frame_${String(f).padStart(3, '0')}.png`);

    const ssimProres = spawnSync('ffmpeg', ['-i', pureSeekPath, '-i', proresPath, '-filter_complex', 'ssim', '-f', 'null', '-'], { encoding: 'utf-8' });
    const ssimFwd = spawnSync('ffmpeg', ['-i', pureSeekPath, '-i', fwdPrevPath, '-filter_complex', 'ssim', '-f', 'null', '-'], { encoding: 'utf-8' });

    const matchProres = (ssimProres.stderr || '').match(/All:([0-9.]+)/)?.[1];
    const matchFwd = (ssimFwd.stderr || '').match(/All:([0-9.]+)/)?.[1];

    console.log(`F${String(f).padStart(3, '0')} (${sec.toFixed(2)}s): Pure vs ProRes = ${matchProres} | Pure vs FwdPrev = ${matchFwd}`);
  }

  await browser.close();
}
check();
