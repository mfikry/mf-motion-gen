import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Inspect file sizes and byte differences
const p1 = "poc/hyperframes-spike/tests/output-determinism/frame10_first.png";
const p2 = "poc/hyperframes-spike/tests/output-determinism/frame10_repeat_backward.png";

const b1 = fs.readFileSync(p1);
const b2 = fs.readFileSync(p2);

console.log("Size 1:", b1.length, "Size 2:", b2.length);

let diffBytes = 0;
const minLen = Math.min(b1.length, b2.length);
for (let i = 0; i < minLen; i++) {
  if (b1[i] !== b2[i]) diffBytes++;
}
diffBytes += Math.abs(b1.length - b2.length);
console.log("Byte difference count:", diffBytes);
