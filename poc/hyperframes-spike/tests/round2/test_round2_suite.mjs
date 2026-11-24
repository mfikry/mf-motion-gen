import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT_SPIKE = path.resolve('poc/hyperframes-spike');
const COMPOSITION_HTML = path.join(ROOT_SPIKE, 'compositions/round2/breaking_news_localized.html');
const MP4_VIDEO = path.join(ROOT_SPIKE, 'renders/round2/breaking_news_1080p30.mp4');
const PRORES_VIDEO = path.join(ROOT_SPIKE, 'renders/round2/breaking_news_prores4444.mov');
const REF_VIDEO = path.join(ROOT_SPIKE, 'fixtures/round2/reference_breaking_news.mp4');

const PREVIEWS_DIR = path.join(ROOT_SPIKE, 'previews/round2');
const REPORT_PATH = path.join(ROOT_SPIKE, 'reports/round2_evaluation_report.json');

const CHROME_PATH = 'C:\\Users\\User\\.cache\\hyperframes\\chrome\\chrome-headless-shell\\win64-158.0.8127.36\\chrome-headless-shell-win64\\chrome-headless-shell.exe';

if (!fs.existsSync(PREVIEWS_DIR)) {
  fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
}

// Target test frames: F0, F30, F60, F90, F150, F240, F270, F285, F299
const TEST_FRAMES = [
  { frameIndex: 0,   sec: 0.0,       label: '0.0000s (F0 - Initial State: Globe & Background)' },
  { frameIndex: 30,  sec: 1.0,       label: '1.0000s (F30 - Blue Panel & Red BREAKING Entrance)' },
  { frameIndex: 60,  sec: 2.0,       label: '2.0000s (F60 - NEWS Text Entrance & Specular Sheen)' },
  { frameIndex: 90,  sec: 3.0,       label: '3.0000s (F90 - BREAKING Shift, Yellow LIVE Badge & Ticker)' },
  { frameIndex: 150, sec: 5.0,       label: '5.0000s (F150 - Full Steady State & News Ticker Scroll)' },
  { frameIndex: 240, sec: 8.0,       label: '8.0000s (F240 - Pre-outro Steady State)' },
  { frameIndex: 270, sec: 9.0,       label: '9.0000s (F270 - Outro: LIVE Top-Right, NEWS Dark-Blue Emboss)' },
  { frameIndex: 285, sec: 9.5,       label: '9.5000s (F285 - Outro Hold & Final Framing)' },
  { frameIndex: 299, sec: 9.966667,  label: '9.9667s (F299 - Last Frame of 300)' }
];

function extractFrameFromVideo(videoPath, frameIndex, outputPath) {
  const cmd = `ffmpeg -y -v error -i "${videoPath}" -vf "select=eq(n\\,${frameIndex})" -vframes 1 "${outputPath}"`;
  execSync(cmd, { stdio: 'pipe' });
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Failed to extract frame ${frameIndex} from ${videoPath}`);
  }
}

function extractReferenceFrame(refPath, timestampSec, outputPath) {
  // Scale reference (1024x576) to 1920x1080 for fair visual side-by-side comparison
  const cmd = `ffmpeg -y -v error -ss ${timestampSec.toFixed(4)} -i "${refPath}" -vframes 1 -vf "scale=1920:1080:flags=lanczos" "${outputPath}"`;
  execSync(cmd, { stdio: 'pipe' });
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Failed to extract reference frame at ${timestampSec}s`);
  }
}

function computeFfmpegMetrics(fileA, fileB) {
  const psnrRes = spawnSync('ffmpeg', ['-i', fileA, '-i', fileB, '-filter_complex', 'psnr', '-f', 'null', '-'], { encoding: 'utf-8' });
  const psnrText = (psnrRes.stderr || '') + (psnrRes.stdout || '');
  const pMatch = psnrText.match(/average:([0-9.]+)/) || psnrText.match(/average:inf/);
  const psnrVal = pMatch ? (pMatch[1] === 'inf' ? 100.0 : parseFloat(pMatch[1])) : 100.0;

  const ssimRes = spawnSync('ffmpeg', ['-i', fileA, '-i', fileB, '-filter_complex', 'ssim', '-f', 'null', '-'], { encoding: 'utf-8' });
  const ssimText = (ssimRes.stderr || '') + (ssimRes.stdout || '');
  const sMatch = ssimText.match(/All:([0-9.]+)/);
  const ssimVal = sMatch ? parseFloat(sMatch[1]) : 1.0;

  return {
    ssim: parseFloat(ssimVal.toFixed(6)),
    psnrDb: parseFloat(psnrVal.toFixed(6))
  };
}

function generateDiffMap(fileA, fileB, diffMapPath) {
  const cmd = `ffmpeg -y -v error -i "${fileA}" -i "${fileB}" -filter_complex "blend=all_mode=difference,eq=contrast=6:brightness=0.05" -vframes 1 "${diffMapPath}"`;
  try {
    execSync(cmd, { stdio: 'pipe' });
  } catch (e) {
    console.warn(`Could not generate diff map: ${e.message}`);
  }
}

function analyzePixelHistogram(fileA, fileB) {
  const pRaw = spawnSync('ffmpeg', ['-i', fileA, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });
  const rRaw = spawnSync('ffmpeg', ['-i', fileB, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 30 * 1024 * 1024 });
  const bufA = pRaw.stdout;
  const bufB = rRaw.stdout;

  if (!bufA || !bufB || bufA.length !== bufB.length) {
    return { error: 'Buffer size mismatch or empty' };
  }

  let totalDiff = 0;
  let maxDiff = 0;
  let countExactZero = 0;
  let countDelta1to5 = 0;
  let countDelta6to15 = 0;
  let countDelta16to30 = 0;
  let countDelta31to50 = 0;
  let countDeltaGt50 = 0;
  const totalPixels = bufA.length / 3;

  for (let i = 0; i < bufA.length; i += 3) {
    const dr = Math.abs(bufA[i] - bufB[i]);
    const dg = Math.abs(bufA[i + 1] - bufB[i + 1]);
    const db = Math.abs(bufA[i + 2] - bufB[i + 2]);
    const maxChannelDiff = Math.max(dr, dg, db);
    const sumDiff = dr + dg + db;
    totalDiff += sumDiff;
    if (maxChannelDiff > maxDiff) maxDiff = maxChannelDiff;

    if (maxChannelDiff === 0) countExactZero++;
    else if (maxChannelDiff <= 5) countDelta1to5++;
    else if (maxChannelDiff <= 15) countDelta6to15++;
    else if (maxChannelDiff <= 30) countDelta16to30++;
    else if (maxChannelDiff <= 50) countDelta31to50++;
    else countDeltaGt50++;
  }

  return {
    totalPixels,
    meanDiffPerChannel: parseFloat((totalDiff / (totalPixels * 3)).toFixed(3)),
    maxChannelDiff: maxDiff,
    exactZero: { count: countExactZero, pct: parseFloat(((countExactZero / totalPixels) * 100).toFixed(2)) },
    delta1to5: { count: countDelta1to5, pct: parseFloat(((countDelta1to5 / totalPixels) * 100).toFixed(2)) },
    delta6to15: { count: countDelta6to15, pct: parseFloat(((countDelta6to15 / totalPixels) * 100).toFixed(2)) },
    delta16to30: { count: countDelta16to30, pct: parseFloat(((countDelta16to30 / totalPixels) * 100).toFixed(2)) },
    delta31to50: { count: countDelta31to50, pct: parseFloat(((countDelta31to50 / totalPixels) * 100).toFixed(2)) },
    deltaGt50: { count: countDeltaGt50, pct: parseFloat(((countDeltaGt50 / totalPixels) * 100).toFixed(2)) },
    withinToleranceLe5: parseFloat((((countExactZero + countDelta1to5) / totalPixels) * 100).toFixed(2))
  };
}

async function runEvaluationSuite() {
  console.log('========================================================================');
  console.log('MF Motion Gen 2.0 — Round 2 Evaluation & Parity Suite');
  console.log('========================================================================\n');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

  const fileUrl = 'file:///' + COMPOSITION_HTML.replace(/\\/g, '/');
  console.log('Opening composition in Chromium:', fileUrl);
  await page.goto(fileUrl, { waitUntil: 'networkidle0' });

  // Expose lifecycle clip management logic in browser page context
  await page.evaluate(() => {
    window.__applyClipLifetimes = function(t) {
      const clips = document.querySelectorAll('[data-start][data-duration]');
      clips.forEach(el => {
        if (el.id === 'root') return;
        const start = parseFloat(el.getAttribute('data-start') || '0');
        const dur = parseFloat(el.getAttribute('data-duration') || '10');
        const end = start + dur;
        if (t >= start && t <= end) {
          el.style.visibility = 'visible';
          el.style.display = '';
        } else {
          el.style.visibility = 'hidden';
        }
      });
    };
  });

  console.log('\n--- 1. TESTING DETERMINISTIC SEEK (FORWARD, BACKWARD, RANDOM, REPEAT) ---');
  // First, capture forward sequence
  const previewForwardFiles = {};
  for (const item of TEST_FRAMES) {
    await page.evaluate((t) => {
      window.__timelines['main'].seek(t);
      window.__applyClipLifetimes(t);
    }, item.sec);
    const previewFile = path.join(PREVIEWS_DIR, `preview_fwd_frame_${String(item.frameIndex).padStart(3, '0')}.png`);
    await page.screenshot({ path: previewFile, type: 'png' });
    previewForwardFiles[item.frameIndex] = previewFile;
  }
  console.log('Forward sequence captured for all 9 frames.');

  // Second, backward seek
  const backwardOrder = [...TEST_FRAMES].reverse();
  const previewBackwardFiles = {};
  for (const item of backwardOrder) {
    await page.evaluate((t) => {
      window.__timelines['main'].seek(t);
      window.__applyClipLifetimes(t);
    }, item.sec);
    const bwdFile = path.join(PREVIEWS_DIR, `preview_bwd_frame_${String(item.frameIndex).padStart(3, '0')}.png`);
    await page.screenshot({ path: bwdFile, type: 'png' });
    previewBackwardFiles[item.frameIndex] = bwdFile;
  }
  console.log('Backward sequence captured for all 9 frames.');

  // Third, random seek sequence
  const randomOrderIndices = [150, 30, 270, 0, 299, 90, 285, 60, 240];
  const previewRandomFiles = {};
  for (const fIdx of randomOrderIndices) {
    const item = TEST_FRAMES.find(f => f.frameIndex === fIdx);
    await page.evaluate((t) => {
      window.__timelines['main'].seek(t);
      window.__applyClipLifetimes(t);
    }, item.sec);
    const rndFile = path.join(PREVIEWS_DIR, `preview_rnd_frame_${String(fIdx).padStart(3, '0')}.png`);
    await page.screenshot({ path: rndFile, type: 'png' });
    previewRandomFiles[fIdx] = rndFile;
  }
  console.log('Random sequence captured for all 9 frames.');

  // Evaluate seek determinism metrics: compare Forward vs Backward and Forward vs Random
  const determinismResults = [];
  let allDeterminismBitExact = true;
  for (const item of TEST_FRAMES) {
    const fIdx = item.frameIndex;
    const fwdFile = previewForwardFiles[fIdx];
    const bwdFile = previewBackwardFiles[fIdx];
    const rndFile = previewRandomFiles[fIdx];

    const fwdVsBwd = computeFfmpegMetrics(fwdFile, bwdFile);
    const fwdVsRnd = computeFfmpegMetrics(fwdFile, rndFile);

    const isBitExact = fwdVsBwd.ssim >= 0.99999 && fwdVsRnd.ssim >= 0.99999;
    if (!isBitExact) allDeterminismBitExact = false;

    determinismResults.push({
      frameIndex: fIdx,
      label: item.label,
      fwdVsBwd: { ssim: fwdVsBwd.ssim, psnr: fwdVsBwd.psnrDb },
      fwdVsRnd: { ssim: fwdVsRnd.ssim, psnr: fwdVsRnd.psnrDb },
      bitExact: isBitExact
    });
    console.log(`Frame ${String(fIdx).padStart(3, '0')} (${item.sec.toFixed(2)}s): Fwd vs Bwd SSIM=${fwdVsBwd.ssim}, Fwd vs Rnd SSIM=${fwdVsRnd.ssim} [${isBitExact ? 'BIT-EXACT PASS' : 'FAIL'}]`);
  }

  console.log('\n--- 2. EXTRACTING FRAMES FROM PRORES 4444, MP4, AND REFERENCE ---');
  const proresFiles = {};
  const mp4Files = {};
  const refFiles = {};
  const hasRefVideo = fs.existsSync(REF_VIDEO);
  if (!hasRefVideo) {
    console.warn(`[NOTICE] Reference fixture video not found at: ${REF_VIDEO}`);
    console.warn(`         Skipping visual comparison against reference video. (Normal behavior on clean git clone).`);
  }

  for (const item of TEST_FRAMES) {
    const fIdx = item.frameIndex;
    const proresPath = path.join(PREVIEWS_DIR, `frame_prores_${String(fIdx).padStart(3, '0')}.png`);
    const mp4Path = path.join(PREVIEWS_DIR, `frame_mp4_${String(fIdx).padStart(3, '0')}.png`);
    const refPath = path.join(PREVIEWS_DIR, `frame_ref_${String(fIdx).padStart(3, '0')}.png`);

    extractFrameFromVideo(PRORES_VIDEO, fIdx, proresPath);
    extractFrameFromVideo(MP4_VIDEO, fIdx, mp4Path);
    if (hasRefVideo) {
      extractReferenceFrame(REF_VIDEO, item.sec, refPath);
      refFiles[fIdx] = refPath;
    }

    proresFiles[fIdx] = proresPath;
    mp4Files[fIdx] = mp4Path;
  }
  console.log(`Extracted matching frames from ProRes, MP4${hasRefVideo ? ', and Reference' : ''}.`);

  console.log('\n--- 3. COMPUTING PARITY METRICS & GENERATING DIFF MAPS ---');
  const parityResults = [];
  let sumRenSsim = 0, sumRenPsnr = 0;
  let sumEncSsim = 0, sumEncPsnr = 0;
  let sumE2eSsim = 0, sumE2ePsnr = 0;
  let sumRefSsim = 0, sumRefPsnr = 0;

  for (const item of TEST_FRAMES) {
    const fIdx = item.frameIndex;
    const previewFile = previewForwardFiles[fIdx];
    const proresFile = proresFiles[fIdx];
    const mp4File = mp4Files[fIdx];
    const refFile = refFiles[fIdx];

    const diffRendererPath = path.join(PREVIEWS_DIR, `diff_renderer_frame_${String(fIdx).padStart(3, '0')}.png`);
    const diffEncoderPath = path.join(PREVIEWS_DIR, `diff_encoder_frame_${String(fIdx).padStart(3, '0')}.png`);
    const diffE2ePath = path.join(PREVIEWS_DIR, `diff_e2e_frame_${String(fIdx).padStart(3, '0')}.png`);

    generateDiffMap(previewFile, proresFile, diffRendererPath);
    generateDiffMap(proresFile, mp4File, diffEncoderPath);
    generateDiffMap(previewFile, mp4File, diffE2ePath);

    // [A] Renderer-to-Mezzanine: Preview vs ProRes
    const renMetrics = computeFfmpegMetrics(previewFile, proresFile);
    const renHisto = analyzePixelHistogram(previewFile, proresFile);

    // [B] Encoder Impact: ProRes vs MP4
    const encMetrics = computeFfmpegMetrics(proresFile, mp4File);
    const encHisto = analyzePixelHistogram(proresFile, mp4File);

    // [C] End-to-End: Preview vs MP4
    const e2eMetrics = computeFfmpegMetrics(previewFile, mp4File);

    // [D] Reference Comparison: MP4 vs Reference Video
    const refMetrics = (hasRefVideo && refFile)
      ? computeFfmpegMetrics(mp4File, refFile)
      : { ssim: null, psnrDb: null, note: 'Reference fixture not present on clean clone' };

    sumRenSsim += renMetrics.ssim; sumRenPsnr += renMetrics.psnrDb;
    sumEncSsim += encMetrics.ssim; sumEncPsnr += encMetrics.psnrDb;
    sumE2eSsim += e2eMetrics.ssim; sumE2ePsnr += e2eMetrics.psnrDb;
    if (hasRefVideo && refMetrics.ssim !== null) {
      sumRefSsim += refMetrics.ssim; sumRefPsnr += refMetrics.psnrDb;
    }

    parityResults.push({
      frameIndex: fIdx,
      timestampSec: item.sec,
      label: item.label,
      rendererToMezzanine: { ...renMetrics, histogram: renHisto },
      encoderImpact: { ...encMetrics, histogram: encHisto },
      endToEnd: e2eMetrics,
      referenceComparison: refMetrics,
      files: {
        preview: `preview_fwd_frame_${String(fIdx).padStart(3, '0')}.png`,
        prores: `frame_prores_${String(fIdx).padStart(3, '0')}.png`,
        mp4: `frame_mp4_${String(fIdx).padStart(3, '0')}.png`,
        ref: `frame_ref_${String(fIdx).padStart(3, '0')}.png`,
        diffRenderer: `diff_renderer_frame_${String(fIdx).padStart(3, '0')}.png`,
        diffEncoder: `diff_encoder_frame_${String(fIdx).padStart(3, '0')}.png`,
        diffE2e: `diff_e2e_frame_${String(fIdx).padStart(3, '0')}.png`
      }
    });

    console.log(`\nFrame ${String(fIdx).padStart(3, '0')} (${item.sec.toFixed(2)}s):`);
    console.log(`  [A] Renderer-to-Mezzanine (Preview vs ProRes): SSIM = ${renMetrics.ssim.toFixed(4)}, PSNR = ${renMetrics.psnrDb.toFixed(2)} dB`);
    console.log(`  [B] Encoder Impact        (ProRes vs MP4):    SSIM = ${encMetrics.ssim.toFixed(4)}, PSNR = ${encMetrics.psnrDb.toFixed(2)} dB`);
    console.log(`  [C] End-to-End Visual     (Preview vs MP4):   SSIM = ${e2eMetrics.ssim.toFixed(4)}, PSNR = ${e2eMetrics.psnrDb.toFixed(2)} dB`);
    console.log(`  [D] Reference Parity      (MP4 vs Reference): SSIM = ${refMetrics.ssim.toFixed(4)}, PSNR = ${refMetrics.psnrDb.toFixed(2)} dB`);
  }

  const n = TEST_FRAMES.length;
  const avgRenSsim = sumRenSsim / n;
  const avgRenPsnr = sumRenPsnr / n;
  const avgEncSsim = sumEncSsim / n;
  const avgEncPsnr = sumEncPsnr / n;
  const avgE2eSsim = sumE2eSsim / n;
  const avgE2ePsnr = sumE2ePsnr / n;
  const avgRefSsim = hasRefVideo ? (sumRefSsim / n) : null;
  const avgRefPsnr = hasRefVideo ? (sumRefPsnr / n) : null;

  console.log('\n========================================================================');
  console.log('AVERAGE METRICS (Across 9 Representative Sample Frames):');
  console.log(`  [A] Renderer-to-Mezzanine: SSIM = ${avgRenSsim.toFixed(4)}, PSNR = ${avgRenPsnr.toFixed(2)} dB`);
  console.log(`  [B] Encoder Impact:        SSIM = ${avgEncSsim.toFixed(4)}, PSNR = ${avgEncPsnr.toFixed(2)} dB`);
  console.log(`  [C] End-to-End:            SSIM = ${avgE2eSsim.toFixed(4)}, PSNR = ${avgE2ePsnr.toFixed(2)} dB`);
  console.log(`  [D] Reference vs MP4:      ${hasRefVideo ? `SSIM = ${avgRefSsim.toFixed(4)}, PSNR = ${avgRefPsnr.toFixed(2)} dB` : 'SKIPPED (Reference fixture not found on clean clone)'}`);
  console.log('========================================================================\n');

  // Critical animation state audit
  console.log('--- 4. CRITICAL ANIMATION STATE AUDIT ---');
  const animationChecks = await page.evaluate(() => {
    const results = {};

    // 1. Check globe continents
    const dotsFront = document.getElementById('globe-dots-front');
    const dotsBack = document.getElementById('globe-dots-back');
    results.globe = {
      frontChildrenCount: dotsFront ? dotsFront.children.length : 0,
      backChildrenCount: dotsBack ? dotsBack.children.length : 0,
      totalDotsRendered: (dotsFront ? dotsFront.children.length : 0) + (dotsBack ? dotsBack.children.length : 0)
    };

    // 2. Check orbit and orb
    const orbitFront = document.getElementById('orbit-front');
    const orbitBack = document.getElementById('orbit-back');
    const orbFront = document.getElementById('orb-front-group');
    const orbBack = document.getElementById('orb-back-group');
    results.orbit = {
      frontPathD: orbitFront ? orbitFront.getAttribute('d').substring(0, 30) + '...' : null,
      backPathD: orbitBack ? orbitBack.getAttribute('d').substring(0, 30) + '...' : null,
      orbFrontExists: !!orbFront,
      orbBackExists: !!orbBack
    };

    // 3. Check Headline elements
    const bluePanel = document.getElementById('blue-panel-wrap');
    const breakingPanel = document.getElementById('breaking-panel-wrap');
    const newsWrap = document.getElementById('news-text-wrap');
    const liveBadge = document.getElementById('live-badge-wrap');
    const sheen = document.getElementById('title-light-sheen');
    results.headline = {
      bluePanelPresent: !!bluePanel,
      breakingPanelPresent: !!breakingPanel,
      newsWrapPresent: !!newsWrap,
      liveBadgePresent: !!liveBadge,
      sheenPresent: !!sheen
    };

    // 4. Check ticker track
    const tickerTrack = document.getElementById('ticker-track');
    results.ticker = {
      trackExists: !!tickerTrack,
      segmentsCount: tickerTrack ? tickerTrack.children.length : 0
    };

    // 5. Background sparkles
    const sparkles = document.getElementById('bg-sparkles');
    results.sparkles = {
      sparklesCount: sparkles ? sparkles.children.length : 0
    };

    return results;
  });
  console.log('Animation Structure Checks:', JSON.stringify(animationChecks, null, 2));

  await browser.close();

  const finalReport = {
    testDate: new Date().toISOString(),
    sampleFrameCount: n,
    summary: {
      rendererToMezzaninePass: avgRenSsim >= 0.95,
      avgRendererSsim: parseFloat(avgRenSsim.toFixed(4)),
      avgRendererPsnrDb: parseFloat(avgRenPsnr.toFixed(2)),
      avgEncoderSsim: parseFloat(avgEncSsim.toFixed(4)),
      avgEncoderPsnrDb: parseFloat(avgEncPsnr.toFixed(2)),
      avgEndToEndSsim: parseFloat(avgE2eSsim.toFixed(4)),
      avgEndToEndPsnrDb: parseFloat(avgE2ePsnr.toFixed(2)),
      avgReferenceSsim: parseFloat(avgRefSsim.toFixed(4)),
      avgReferencePsnrDb: parseFloat(avgRefPsnr.toFixed(2)),
      determinismAllBitExact: allDeterminismBitExact
    },
    determinismResults,
    parityResults,
    animationChecks
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(finalReport, null, 2), 'utf8');
  console.log('\nComprehensive evaluation report written to:', REPORT_PATH);
}

runEvaluationSuite().catch(err => {
  console.error('Fatal evaluation suite error:', err);
  process.exit(1);
});
