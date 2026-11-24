import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const srcPath = path.resolve(__dirname, "..", "compositions", "ai_studio_code.html");
const destPath = path.resolve(__dirname, "..", "compositions", "ai_studio_lifetime_fixed.html");

let html = fs.readFileSync(srcPath, "utf-8");

// 1. Localize GSAP CDN to local bundle
html = html.replace(
  'https://cdn.jsdelivr.net/npm/gsap@3.15.1/dist/gsap.min.js',
  '../assets/gsap.min.js'
);

// 2. Correct static elements lifetimes based on audit table
// #bg-grid: start=0, dur=1.2 -> dur=8
html = html.replace(
  '<rect id="bg-grid" class="clip" data-start="0" data-duration="1.2"',
  '<rect id="bg-grid" class="clip" data-start="0" data-duration="8"'
);

// #perimeter-frame: start=0.05, dur=0.9 -> dur=7.95
html = html.replace(
  '<g id="perimeter-frame" class="clip" data-start="0.05" data-duration="0.9">',
  '<g id="perimeter-frame" class="clip" data-start="0.05" data-duration="7.95">'
);

// #outer-border: start=0.05, dur=0.85 -> dur=7.95
html = html.replace(
  '<rect id="outer-border" class="clip" data-start="0.05" data-duration="0.85"',
  '<rect id="outer-border" class="clip" data-start="0.05" data-duration="7.95"'
);

// Corner brackets: start=0.1, dur=0.6 -> dur=7.9
html = html.replace(
  '<path id="corner-tl" class="clip" data-start="0.1" data-duration="0.6"',
  '<path id="corner-tl" class="clip" data-start="0.1" data-duration="7.9"'
);
html = html.replace(
  '<path id="corner-tr" class="clip" data-start="0.1" data-duration="0.6"',
  '<path id="corner-tr" class="clip" data-start="0.1" data-duration="7.9"'
);
html = html.replace(
  '<path id="corner-bl" class="clip" data-start="0.1" data-duration="0.6"',
  '<path id="corner-bl" class="clip" data-start="0.1" data-duration="7.9"'
);
html = html.replace(
  '<path id="corner-br" class="clip" data-start="0.1" data-duration="0.6"',
  '<path id="corner-br" class="clip" data-start="0.1" data-duration="7.9"'
);

// Axes: start=0.2, dur=0.7 -> dur=7.8
html = html.replace(
  '<line id="axis-left" class="clip" data-start="0.2" data-duration="0.7"',
  '<line id="axis-left" class="clip" data-start="0.2" data-duration="7.8"'
);
html = html.replace(
  '<line id="axis-right" class="clip" data-start="0.2" data-duration="0.7"',
  '<line id="axis-right" class="clip" data-start="0.2" data-duration="7.8"'
);
html = html.replace(
  '<line id="axis-top" class="clip" data-start="0.2" data-duration="0.7"',
  '<line id="axis-top" class="clip" data-start="0.2" data-duration="7.8"'
);
html = html.replace(
  '<line id="axis-bottom" class="clip" data-start="0.2" data-duration="0.7"',
  '<line id="axis-bottom" class="clip" data-start="0.2" data-duration="7.8"'
);

// #core-sync-ring-group: start=0.4, dur=6.6 -> dur=7.6
html = html.replace(
  '<g id="core-sync-ring-group" class="clip" data-start="0.4" data-duration="6.6">',
  '<g id="core-sync-ring-group" class="clip" data-start="0.4" data-duration="7.6">'
);

// #core-sync-arc: start=2.4, dur=3.85 -> dur=5.6
html = html.replace(
  'data-start="2.4"\n            data-duration="3.85"',
  'data-start="2.4"\n            data-duration="5.6"'
);

// #title-block: start=0.25, dur=0.75 -> dur=7.75
html = html.replace(
  '<div id="title-block" class="clip" data-start="0.25" data-duration="0.75">',
  '<div id="title-block" class="clip" data-start="0.25" data-duration="7.75">'
);

// #sync-bar-fill: start=2.4, dur=3.85 -> dur=5.6
html = html.replace(
  '<div id="sync-bar-fill" class="clip" data-start="2.4" data-duration="3.85">',
  '<div id="sync-bar-fill" class="clip" data-start="2.4" data-duration="5.6">'
);

// 3. Correct dynamically created JS conduits
// Line 907: "data-duration": c.dur -> "data-duration": (8 - c.start).toFixed(2)
html = html.replace(
  '"data-start": c.start,\n          "data-duration": c.dur,',
  '"data-start": c.start,\n          "data-duration": (8 - c.start).toFixed(2),'
);

fs.writeFileSync(destPath, html, "utf-8");
console.log(`Saved lifetime-fixed HTML candidate to: ${destPath}`);
