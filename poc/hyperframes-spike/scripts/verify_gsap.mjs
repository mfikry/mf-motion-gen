import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

console.log('=== GSAP VERSION VERIFICATION ===');

// 1. Check assets/gsap.min.js
const assetContent = fs.readFileSync('poc/hyperframes-spike/assets/gsap.min.js', 'utf-8');
const vMatch = assetContent.match(/version\s*=\s*"([^"]+)"/);
const bannerMatch = assetContent.slice(0, 100);
console.log('1. assets/gsap.min.js:');
console.log('   Banner:', bannerMatch);
console.log('   Version property:', vMatch ? vMatch[1] : 'Not found');

// 2. Check package.json
const pkg = JSON.parse(fs.readFileSync('poc/hyperframes-spike/package.json', 'utf-8'));
console.log('2. package.json dependencies.gsap:', pkg.dependencies?.gsap);

// 3. Check package-lock.json
const lock = JSON.parse(fs.readFileSync('poc/hyperframes-spike/package-lock.json', 'utf-8'));
const lockEntry = lock.packages?.['node_modules/gsap'];
console.log('3. package-lock.json node_modules/gsap version:', lockEntry?.version);

// 4. Check node_modules/gsap/package.json
const nmPath = 'poc/hyperframes-spike/node_modules/gsap/package.json';
if (fs.existsSync(nmPath)) {
  const nmPkg = JSON.parse(fs.readFileSync(nmPath, 'utf-8'));
  console.log('4. node_modules/gsap/package.json version:', nmPkg.version);
}

// 5. Check actual runtime in Chromium when loading breaking_news_localized.html
const CHROME = 'C:\\Users\\User\\.cache\\hyperframes\\chrome\\chrome-headless-shell\\win64-158.0.8127.36\\chrome-headless-shell-win64\\chrome-headless-shell.exe';
const HTML_LOCAL = 'file:///' + path.resolve('poc/hyperframes-spike/compositions/round2/breaking_news_localized.html').replace(/\\/g, '/');

try {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.goto(HTML_LOCAL, { waitUntil: 'networkidle0' });
  const runtimeVersion = await page.evaluate(() => window.gsap?.version || 'No gsap in window');
  console.log('5. Runtime window.gsap.version in breaking_news_localized.html:', runtimeVersion);
  await browser.close();
} catch (e) {
  console.log('5. Error probing runtime:', e.message);
}
