import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import puppeteer from 'puppeteer-core';

const ROOT_DIR = path.resolve('poc/hyperframes-spike');
const SRC_PATH = path.join(ROOT_DIR, 'fixtures/round2/ai_studio_code_round2.html');
const REF_PATH = path.join(ROOT_DIR, 'fixtures/round2/reference_breaking_news.mp4');
const DST_PATH = path.join(ROOT_DIR, 'compositions/round2/breaking_news_localized.html');
const LOCAL_GSAP = path.join(ROOT_DIR, 'assets/gsap.min.js');
const REPORT_PATH = path.join(ROOT_DIR, 'reports/round2_static_validation.json');

const CHROME_PATH = 'C:\\Users\\User\\.cache\\hyperframes\\chrome\\chrome-headless-shell\\win64-158.0.8127.36\\chrome-headless-shell-win64\\chrome-headless-shell.exe';

console.log('=== STEP 1: VERIFY SOURCE PRESERVATION & HASHING ===');
const srcBuffer = fs.readFileSync(SRC_PATH);
const srcHash = crypto.createHash('sha256').update(srcBuffer).digest('hex');
console.log('Source HTML Path:   ', SRC_PATH);
console.log('Source HTML SHA-256:', srcHash);
console.log('Source HTML Size:   ', srcBuffer.length, 'bytes');

const refBuffer = fs.readFileSync(REF_PATH);
const refHash = crypto.createHash('sha256').update(refBuffer).digest('hex');
console.log('Reference MP4 Path:   ', REF_PATH);
console.log('Reference MP4 SHA-256:', refHash);
console.log('Reference MP4 Size:   ', refBuffer.length, 'bytes');

console.log('\n=== STEP 2: CREATE LOCALIZED WORKING COPY ===');
const srcContent = srcBuffer.toString('utf8');
const cdnRegex = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@[^"]+"><\/script>/;
if (!cdnRegex.test(srcContent)) {
  throw new Error('CDN script tag for GSAP not found in source HTML!');
}

const localizedContent = srcContent.replace(cdnRegex, '<script src="../../assets/gsap.min.js"></script>');
fs.writeFileSync(DST_PATH, localizedContent, 'utf8');

const dstBuffer = fs.readFileSync(DST_PATH);
const dstHash = crypto.createHash('sha256').update(dstBuffer).digest('hex');
console.log('Working Copy Path:   ', DST_PATH);
console.log('Working Copy SHA-256:', dstHash);
console.log('Working Copy Size:   ', dstBuffer.length, 'bytes');

// Double-check source is untouched
const verifySrcHash = crypto.createHash('sha256').update(fs.readFileSync(SRC_PATH)).digest('hex');
if (verifySrcHash !== srcHash) {
  throw new Error('CRITICAL: Source file was modified!');
}
console.log('Source Integrity Verified: 100% UNTOUCHED.');

console.log('\n=== STEP 3: STATIC HTML ATTRIBUTES & LIFETIME AUDIT ===');
const expectedElements = [
  { id: 'bg-backdrop', start: 0, dur: 10, expectedEnd: 10, role: 'persistent-background' },
  { id: 'bg-sparkles', start: 0, dur: 10, expectedEnd: 10, role: 'persistent-sparkles' },
  { id: 'globe-stage', start: 0, dur: 10, expectedEnd: 10, role: 'persistent-globe' },
  { id: 'blue-panel-wrap', start: 0.4, dur: 8.6, expectedEnd: 9.0, role: 'headline-blue-panel' },
  { id: 'breaking-panel-wrap', start: 0.5, dur: 8.5, expectedEnd: 9.0, role: 'headline-breaking-bar' },
  { id: 'news-text-wrap', start: 1.2, dur: 8.8, expectedEnd: 10.0, role: 'headline-news-typography' },
  { id: 'live-badge-wrap', start: 2.2, dur: 7.8, expectedEnd: 10.0, role: 'headline-live-badge' },
  { id: 'title-light-sheen', start: 1.4, dur: 1.2, expectedEnd: 2.6, role: 'transient-specular-sheen' },
  { id: 'ticker-bar-wrap', start: 2.4, dur: 6.4, expectedEnd: 8.8, role: 'bottom-news-ticker' }
];

const auditResults = [];
for (const item of expectedElements) {
  // Regex to find tag with this id
  const regex = new RegExp(`id=["']${item.id}["'][^>]*data-start=["']([^"']+)["'][^>]*data-duration=["']([^"']+)["']`, 'i');
  const match = regex.exec(localizedContent);
  if (match) {
    const actualStart = parseFloat(match[1]);
    const actualDur = parseFloat(match[2]);
    const actualEnd = parseFloat((actualStart + actualDur).toFixed(2));
    const pass = Math.abs(actualStart - item.start) < 0.01 && Math.abs(actualDur - item.dur) < 0.01;
    auditResults.push({
      id: item.id,
      role: item.role,
      expected: { start: item.start, dur: item.dur, end: item.expectedEnd },
      actual: { start: actualStart, dur: actualDur, end: actualEnd },
      pass
    });
    console.log(`Element #${item.id}: start=${actualStart}s, dur=${actualDur}s (ends at ${actualEnd}s) [${pass ? 'PASS' : 'FAIL'}]`);
  } else {
    // Try reverse order of attributes
    const revRegex = new RegExp(`data-start=["']([^"']+)["'][^>]*data-duration=["']([^"']+)["'][^>]*id=["']${item.id}["']`, 'i');
    const revMatch = revRegex.exec(localizedContent);
    if (revMatch) {
      const actualStart = parseFloat(revMatch[1]);
      const actualDur = parseFloat(revMatch[2]);
      const actualEnd = parseFloat((actualStart + actualDur).toFixed(2));
      const pass = Math.abs(actualStart - item.start) < 0.01 && Math.abs(actualDur - item.dur) < 0.01;
      auditResults.push({
        id: item.id,
        role: item.role,
        expected: { start: item.start, dur: item.dur, end: item.expectedEnd },
        actual: { start: actualStart, dur: actualDur, end: actualEnd },
        pass
      });
      console.log(`Element #${item.id}: start=${actualStart}s, dur=${actualDur}s (ends at ${actualEnd}s) [${pass ? 'PASS' : 'FAIL'}]`);
    } else {
      auditResults.push({
        id: item.id,
        role: item.role,
        expected: { start: item.start, dur: item.dur, end: item.expectedEnd },
        actual: null,
        pass: false
      });
      console.log(`Element #${item.id}: NOT FOUND with expected attributes! [FAIL]`);
    }
  }
}

// Check Root attributes
const rootRegex = /id=["']root["'][^>]*data-composition-id=["']([^"']+)["'][^>]*data-start=["']([^"']+)["'][^>]*data-duration=["']([^"']+)["'][^>]*data-width=["']([^"']+)["'][^>]*data-height=["']([^"']+)["'][^>]*data-fps=["']([^"']+)["']/i;
const rootMatch = rootRegex.exec(localizedContent);
let rootValidation = {};
if (rootMatch) {
  rootValidation = {
    compositionId: rootMatch[1],
    start: parseFloat(rootMatch[2]),
    duration: parseFloat(rootMatch[3]),
    width: parseInt(rootMatch[4]),
    height: parseInt(rootMatch[5]),
    fps: parseInt(rootMatch[6]),
    pass: rootMatch[1] === 'main' && parseFloat(rootMatch[3]) === 10 && parseInt(rootMatch[4]) === 1920 && parseInt(rootMatch[5]) === 1080 && parseInt(rootMatch[6]) === 30
  };
  console.log('Root Validation:', rootValidation);
} else {
  console.error('Root attributes not matching expected pattern!');
}

console.log('\n=== STEP 4: BROWSER RUNTIME VALIDATION VIA CHROMIUM HEADLESS ===');
async function runBrowserValidation() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

  const networkRequests = [];
  page.on('request', req => {
    networkRequests.push({ url: req.url(), method: req.method() });
  });

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(msg.text()));
  page.on('pageerror', err => consoleLogs.push('PAGE_ERROR: ' + err.toString()));

  const fileUrl = 'file:///' + DST_PATH.replace(/\\/g, '/');
  console.log('Navigating to:', fileUrl);
  await page.goto(fileUrl, { waitUntil: 'networkidle0' });

  // Evaluate GSAP timeline properties
  const timelineInfo = await page.evaluate(() => {
    const tl = window.__timelines ? window.__timelines['main'] : null;
    if (!tl) {
      return { exists: false };
    }
    return {
      exists: true,
      paused: tl.paused(),
      duration: tl.duration(),
      totalDuration: tl.totalDuration(),
      time: tl.time(),
      progress: tl.progress()
    };
  });
  console.log('GSAP Timeline Info:', timelineInfo);

  // Test seeking to sample timestamps
  const testTimestamps = [0, 1.0, 3.0, 5.0, 8.0, 9.0, 9.9667, 10.0];
  const seekResults = [];
  for (const t of testTimestamps) {
    const res = await page.evaluate((seekTime) => {
      try {
        const tl = window.__timelines['main'];
        tl.seek(seekTime);
        return { time: seekTime, actualTime: tl.time(), success: true };
      } catch (e) {
        return { time: seekTime, error: e.toString(), success: false };
      }
    }, t);
    seekResults.push(res);
  }
  console.log('Seeking verification across sample timestamps:', seekResults);

  await browser.close();

  const report = {
    testDate: new Date().toISOString(),
    sourceFile: {
      path: SRC_PATH,
      sha256: srcHash,
      bytes: srcBuffer.length
    },
    referenceFile: {
      path: REF_PATH,
      sha256: refHash,
      bytes: refBuffer.length
    },
    workingCopy: {
      path: DST_PATH,
      sha256: dstHash,
      bytes: dstBuffer.length,
      gsapLocalized: true
    },
    rootAttributes: rootValidation,
    clipAudit: auditResults,
    runtime: {
      networkRequestsCount: networkRequests.length,
      networkRequests,
      consoleErrors: consoleLogs.filter(l => l.startsWith('PAGE_ERROR')),
      timeline: timelineInfo,
      seekingSampleVerification: seekResults
    }
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log('\nReport written to:', REPORT_PATH);
}

runBrowserValidation().catch(err => {
  console.error('Browser validation failed:', err);
  process.exit(1);
});
