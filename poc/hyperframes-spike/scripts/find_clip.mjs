import fs from 'fs';
const text = fs.readFileSync('poc/hyperframes-spike/fixtures/round2/ai_studio_code_round2.html', 'utf8');
const matches = [...text.matchAll(/class=['"][^'"]*clip[^'"]*['"]/g)];
console.log('Matches for clip in class:', matches.map(m => m[0]));
const clipMatches = [...text.matchAll(/clip/gi)];
console.log('Total occurrences of word clip:', clipMatches.length);
for (const m of clipMatches) {
  const start = Math.max(0, m.index - 20);
  const end = Math.min(text.length, m.index + 30);
  console.log('  ...', text.substring(start, end).replace(/\n/g, ' '), '...');
}
