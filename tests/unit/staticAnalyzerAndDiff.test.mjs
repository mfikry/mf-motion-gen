import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyFixProposalToWorkingCopy } from "../../dist/main/analysis/codeDiffEngine.js";
import { analyzeComposition } from "../../dist/main/analysis/compositionAnalyzer.js";
import { stageIsolatedFolderCopy } from "../../dist/main/import/projectImporter.js";
import { computeFileSha256Sync, purgeSessionDirectorySync } from "../../dist/main/import/sessionFsUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const tmpRoot = path.join(repoRoot, "tmp", "unit-sprint5-analyzer");

function makeFixture(name, files) {
  const dir = path.join(tmpRoot, name);
  purgeSessionDirectorySync(dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

describe("Sprint 5 Smart Static Analyzer, GSAP Authoring Diagnostics & Scoped Diff", () => {
  before(() => {
    purgeSessionDirectorySync(tmpRoot);
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  after(() => {
    purgeSessionDirectorySync(tmpRoot);
  });

  it("1-4: classifies Persistent, Transient, High-Confidence Timeline-Controlled, and Local Media accurately", () => {
    const dir = makeFixture("fixture-core-categories", {
      "assets/gsap.min.js": "/*! GSAP 3.12 */ function dummy(){ onComplete:0; eval('1'); }",
      "media/intro.mp4": Buffer.from("0000001866747970", "hex"),
      "media/bgm.wav": Buffer.from("RIFF____WAVEfmt ", "utf8"),
      "index.html": `<!doctype html>
<html>
<head><script src="./assets/gsap.min.js"></script></head>
<body>
  <div id="stage" data-composition-id="main" data-duration="4" data-width="1280" data-height="720" data-fps="30">
    <div id="bgLayer">Background</div>
    <div id="flashFx" data-transient="true">Flash</div>
    <div id="heroTitle">Hero</div>
    <video id="introVid" src="./media/intro.mp4"></video>
    <audio id="bgmTrack" src="./media/bgm.wav"></audio>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.to("#heroTitle", { x: 200, duration: 2 }, 0);
    tl.to("#flashFx", { opacity: 1, duration: 0.2 }, 1);
    tl.to("#flashFx", { opacity: 0, duration: 0.2 }, 1.5);
    window.__timelines = window.__timelines || {};
    window.__timelines.main = tl;
  </script>
</body>
</html>`,
    });

    const { report } = analyzeComposition(dir, { entryFile: "index.html" });
    const byTarget = (sel) => report.diagnostics.find((d) => d.elementIdentifier === sel);

    assert.equal(byTarget("#bgLayer")?.category, "PERSISTENT");
    assert.equal(byTarget("#bgLayer")?.confidence, "high");
    assert.equal(byTarget("#flashFx")?.category, "TRANSIENT");
    assert.equal(byTarget("#heroTitle")?.category, "TIMELINE_CONTROLLED");
    assert.equal(byTarget("#heroTitle")?.confidence, "high");
    assert.equal(byTarget("#introVid")?.category, "MEDIA");
    assert.equal(byTarget("#bgmTrack")?.category, "MEDIA");
    assert.equal(report.summary.countsByCategory.WARNING_AMBIGUOUS, 0);
    // Vendor gsap.min.js bundle internals (eval/onComplete) must not trigger false authoring warnings
    assert.equal(report.timelineContract.hasCallbacks, false);
  });

  it("5-11: flags external assets, callbacks, late registration, IIFE, cached raw refs, dynamic expr, and ambiguous keys as NO-AUTO-FIX", () => {
    // 5. External assets
    const extDir = makeFixture("fixture-external", {
      "index.html": `<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" /><script src="https://cdn.example.com/gsap.min.js"></script></head><body><div id="x">Hi</div></body></html>`,
    });
    const extRes = analyzeComposition(extDir, { entryFile: "index.html" });
    assert.ok(extRes.report.diagnostics.some((d) => d.category === "WARNING_AMBIGUOUS" && d.severity === "error" && !d.canAutoFix));

    // 6-11 Combined + isolated adversarial JS authoring hazards (NEVER executed)
    const hazardDir = makeFixture("fixture-hazards", {
      "index.html": `<!doctype html>
<html><body>
  <div id="root" data-composition-id="main" data-duration="3" data-fps="30">
    <div id="box">Box</div>
    <div id="staticNode">Static</div>
  </div>
  <script>
    throw new Error("STATIC_ANALYZER_MUST_NOT_EXECUTE_JS");
    const rawCache = window.__timelines;
    const rawEl = document.querySelector("#box");
    const idx = 1;
    (() => {
      const tlHidden = gsap.timeline();
      tlHidden.to(rawEl, { x: () => Math.random() * 100, onComplete: () => console.log("cb") }, 0);
      tlHidden.to(\`#dyn-\${idx}\`, { opacity: 1, duration: 1 }, 0);
      setTimeout(() => {
        window.__timelines = window.__timelines || {};
        window.__timelines.hero = tlHidden;
        window.__timelines[idx] = tlHidden;
      }, 20);
    })();
    eval("1+1");
  </script>
</body></html>`,
    });

    const { report } = analyzeComposition(hazardDir, { entryFile: "index.html" });
    const ruleIds = new Set(report.diagnostics.map((d) => d.ruleId));

    assert.ok(ruleIds.has("GSAP_CALLBACK_DEPENDENCY"));
    assert.ok(ruleIds.has("LATE_TIMELINE_REGISTRATION"));
    assert.ok(ruleIds.has("HIDDEN_IIFE_TIMELINE"));
    assert.ok(ruleIds.has("CACHED_RAW_REFERENCE_PRE_PROXY"));
    assert.ok(ruleIds.has("UNSUPPORTED_DYNAMIC_EXPRESSION"));
    assert.ok(ruleIds.has("AMBIGUOUS_TIMELINE_KEY"));

    // NO-AUTO-FIX: ZERO diagnostics may allow auto-fix when hazards exist
    assert.equal(report.summary.autoFixableCount, 0);
    assert.ok(report.diagnostics.every((d) => d.canAutoFix === false));

    // Unmatched #staticNode must drop from high confidence when dynamic selectors exist
    const staticDiag = report.diagnostics.find((d) => d.elementIdentifier === "#staticNode");
    assert.equal(staticDiag?.category, "PERSISTENT");
    assert.equal(staticDiag?.confidence, "medium");
  });

  it("12: detects multiple .clip boundary conditions (overflow, overlap, missing attrs) and forbids blind duration extension", () => {
    const clipDir = makeFixture("fixture-clips", {
      "index.html": `<!doctype html>
<html><body>
  <div id="comp" data-composition-id="main" data-duration="3" data-fps="30">
    <div id="clipA" class="clip" data-start="0" data-duration="2">Clip A</div>
    <div id="clipB" class="clip" data-start="1.5" data-duration="2.5">Clip B overflows and overlaps</div>
    <div id="clipC" class="clip" data-start="0">Clip C missing duration</div>
  </div>
</body></html>`,
    });

    const { report } = analyzeComposition(clipDir, { entryFile: "index.html" });
    const rules = new Set(report.diagnostics.map((d) => d.ruleId));

    assert.ok(rules.has("CLIP_BOUNDARY_OVERFLOW"));
    assert.ok(rules.has("MULTIPLE_CLIP_OVERLAP"));
    assert.ok(rules.has("CLIP_MISSING_BOUNDARY_ATTRS"));
    assert.equal(report.summary.autoFixableCount, 0);
  });

  it("High-confidence Code Diff applies strictly to isolated working copy, preserves original SHA-256, and updates on re-analyze", () => {
    const srcDir = makeFixture("fixture-src-diff", {
      "index.html": `<!doctype html>
<html><body>
  <div id="comp" data-composition-id="main" data-duration="2" data-width="640" data-height="360" data-fps="30">
    <div id="hero">Hero</div>
  </div>
  <script>
    const tl = gsap.timeline();
    tl.to("#hero", { x: 200, duration: 2 }, 0);
    window.__timelines = window.__timelines || {};
    window.__timelines.main = tl;
  </script>
</body></html>`,
    });

    const origHtmlPath = path.join(srcDir, "index.html");
    const origSha = computeFileSha256Sync(origHtmlPath);

    const staged = stageIsolatedFolderCopy(srcDir, path.join(tmpRoot, "staged-working-copy"));
    const analysis1 = analyzeComposition(staged.workingDir, { entryFile: "index.html", sessionId: "s1" });

    const fixable = analysis1.report.diagnostics.find((d) => d.ruleId === "GSAP_TIMELINE_NOT_PAUSED");
    assert.ok(fixable);
    assert.equal(fixable.canAutoFix, true);
    assert.equal(fixable.confidence, "high");

    const proposal = analysis1.proposalsByDiagnosticId.get(fixable.id);
    assert.ok(proposal);
    assert.match(proposal.preview.diffText, /- .*gsap\.timeline\(\)/);
    assert.match(proposal.preview.diffText, /\+ .*gsap\.timeline\(\{ paused: true \}\)/);

    // Must forbid applying to original_file sessions
    assert.throws(
      () =>
        applyFixProposalToWorkingCopy({
          stageDir: srcDir,
          sourceMode: "original_file",
          ownedTempDir: null,
          proposal,
        }),
      /isolated working copy/
    );

    // Apply to isolated read-only working copy cleanly
    const applied = applyFixProposalToWorkingCopy({
      stageDir: staged.workingDir,
      sourceMode: "working_copy",
      ownedTempDir: staged.workingDir,
      proposal,
    });
    assert.equal(applied.modifiedFile, "index.html");

    // Original file SHA-256 must remain bit-for-bit untouched
    assert.equal(computeFileSha256Sync(origHtmlPath), origSha);

    // Re-analyze confirms high-confidence gap is resolved
    const analysis2 = analyzeComposition(staged.workingDir, { entryFile: "index.html", sessionId: "s1" });
    assert.equal(analysis2.report.summary.autoFixableCount, 0);
    assert.equal(analysis2.report.timelineContract.pausedLikely, true);
  });
});
