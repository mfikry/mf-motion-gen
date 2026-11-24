import fs from 'fs';
import crypto from 'crypto';

const files = [
  'poc/hyperframes-spike/compositions/ai_studio_code.html',
  'poc/hyperframes-spike/compositions/ai_studio_lifetime_fixed.html',
  'poc/hyperframes-spike/compositions/clip_audit_table.json',
  'poc/hyperframes-spike/renders/gemini_lifetime_fixed_prores4444.mov',
  'poc/hyperframes-spike/renders/gemini_lifetime_fixed_1080p30.mp4',
  'poc/hyperframes-spike/renders/visual_fidelity_parity_report.json',
  'poc/hyperframes-spike/tests/test_visual_fidelity_and_parity.mjs',
  'poc/hyperframes-spike/tests/test_security_isolation.mjs',
  'poc/hyperframes-spike/tests/security_sandbox/security_report.json'
];

console.log('=== CHECKSUMS (SHA-256) ===');
for (const f of files) {
  if (fs.existsSync(f)) {
    const data = fs.readFileSync(f);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const sizeMb = (data.length / (1024 * 1024)).toFixed(2);
    console.log(`${f} | ${hash} | ${data.length} bytes (${sizeMb} MB)`);
  } else {
    console.log(`${f} | NOT FOUND`);
  }
}

const rep = JSON.parse(fs.readFileSync('poc/hyperframes-spike/renders/visual_fidelity_parity_report.json', 'utf8'));
console.log('\n=== EXACT MEANS ACROSS 7 SAMPLE FRAMES ===');
const fResults = rep.frameResults;
let sumRenSsim = 0, sumRenPsnr = 0;
let sumEncSsim = 0, sumEncPsnr = 0;
let sumE2eSsim = 0, sumE2ePsnr = 0;

for (const r of fResults) {
  sumRenSsim += r.rendererVariance.ssim;
  sumRenPsnr += r.rendererVariance.psnrDb;
  sumEncSsim += r.encoderVariance.ssim;
  sumEncPsnr += r.encoderVariance.psnrDb;
  sumE2eSsim += r.endToEndVariance.ssim;
  sumE2ePsnr += r.endToEndVariance.psnrDb;
}

const n = fResults.length;
console.log('Sample count:', n);
console.log('Renderer Variance (Preview vs ProRes): SSIM =', (sumRenSsim / n).toFixed(4), `(${sumRenSsim / n})`, 'PSNR =', (sumRenPsnr / n).toFixed(2), 'dB', `(${sumRenPsnr / n})`);
console.log('Encoder Variance  (ProRes vs MP4):    SSIM =', (sumEncSsim / n).toFixed(4), `(${sumEncSsim / n})`, 'PSNR =', (sumEncPsnr / n).toFixed(2), 'dB', `(${sumEncPsnr / n})`);
console.log('End-to-End        (Preview vs MP4):   SSIM =', (sumE2eSsim / n).toFixed(4), `(${sumE2eSsim / n})`, 'PSNR =', (sumE2ePsnr / n).toFixed(2), 'dB', `(${sumE2ePsnr / n})`);
console.log('\nJSON summary field:');
console.log(JSON.stringify(rep.summary, null, 2));
