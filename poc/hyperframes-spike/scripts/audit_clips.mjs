import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const filePath = path.resolve(__dirname, "..", "compositions", "ai_studio_code.html");

const html = fs.readFileSync(filePath, "utf-8");

// Parse elements that have class="clip" or class='clip'
// Note: Some elements may span multiple lines
const tagRegex = /<([a-zA-Z0-9]+)\b([^>]*\bclass\s*=\s*["'][^"']*\bclip\b[^"']*["'][^>]*)>/gis;

const matches = [];
let match;

while ((match = tagRegex.exec(html)) !== null) {
  const fullTag = match[0];
  const tagName = match[1];
  const attrs = match[2];

  // Calculate line number
  const prefix = html.substring(0, match.index);
  const lineNumber = prefix.split("\n").length;

  const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
  const startMatch = attrs.match(/\bdata-start\s*=\s*["']([^"']+)["']/i);
  const durMatch = attrs.match(/\bdata-duration\s*=\s*["']([^"']+)["']/i);

  matches.push({
    line: lineNumber,
    tag: tagName,
    id: idMatch ? idMatch[1] : null,
    start: startMatch ? parseFloat(startMatch[1]) : null,
    duration: durMatch ? parseFloat(durMatch[1]) : null,
    rawTag: fullTag.replace(/\s+/g, " ").trim()
  });
}

console.log(`Found ${matches.length} elements with class="clip":\n`);
matches.forEach((m, idx) => {
  const end = (m.start !== null && m.duration !== null) ? (m.start + m.duration).toFixed(2) : "unknown";
  console.log(`[${idx + 1}] Line ${m.line} <${m.tag} id="${m.id}">: start=${m.start}, dur=${m.duration} (visible ${m.start}s -> ${end}s)`);
});

fs.writeFileSync(
  path.resolve(__dirname, "..", "compositions", "clip_audit_raw.json"),
  JSON.stringify(matches, null, 2),
  "utf-8"
);
