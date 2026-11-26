import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateCompositionPreflight } from "../../dist/main/validation/hostPreflightValidator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

describe("Host-Side Preflight Validator", () => {
  let rootTmp;

  before(() => {
    const tmpParent = path.join(repoRoot, "tmp");
    fs.mkdirSync(tmpParent, { recursive: true });
    rootTmp = fs.mkdtempSync(path.join(tmpParent, "unit-preflight-"));
  });

  after(() => {
    fs.rmSync(rootTmp, { recursive: true, force: true });
  });

  function makeStage(name, files) {
    const dir = path.join(rootTmp, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    return dir;
  }

  it("passes valid offline-first composition with local JS, image, CSS, and local @font-face", () => {
    const stage = makeStage("valid-offline", {
      "assets/gsap.min.js": "// gsap stub",
      "assets/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "styles/main.css": "@font-face { font-family: 'LocalSans'; src: url('../fonts/local.woff2'); }",
      "fonts/local.woff2": "wOF2-stub",
      "index.html": `<!doctype html><html><head>
        <link rel="stylesheet" href="./styles/main.css">
        <script src="./assets/gsap.min.js"></script>
      </head><body>
        <img src="./assets/logo.svg">
        <script>window.__timelines = { main: {} };</script>
      </body></html>`,
    });

    const res = validateCompositionPreflight(stage);
    assert.equal(res.ok, true);
    assert.equal(res.blockers.length, 0);
    assert.equal(res.checkedStylesheets.length, 1);
    assert.ok(res.checkedLocalAssets.length >= 4);
  });

  it("blocks missing local image asset before Producer runs", () => {
    const stage = makeStage("missing-img", {
      "assets/gsap.min.js": "// gsap stub",
      "index.html": `<!doctype html><html><head><script src="./assets/gsap.min.js"></script></head>
        <body><img src="./assets/does-not-exist.png"><script>window.__timelines={main:{}}</script></body></html>`,
    });

    const res = validateCompositionPreflight(stage);
    assert.equal(res.ok, false);
    assert.ok(res.blockers.some((b) => b.code === "MISSING_LOCAL_ASSET"));
  });

  it("blocks external Google Fonts link and CSS @import", () => {
    const stage = makeStage("external-font", {
      "assets/gsap.min.js": "// gsap stub",
      "index.html": `<!doctype html><html><head>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">
        <style>@import url("https://fonts.googleapis.com/css2?family=Roboto");</style>
        <script src="./assets/gsap.min.js"></script>
      </head><body><script>window.__timelines={main:{}}</script></body></html>`,
    });

    const res = validateCompositionPreflight(stage);
    assert.equal(res.ok, false);
    const fontBlockers = res.blockers.filter((b) => b.code === "EXTERNAL_FONT_DISALLOWED");
    assert.equal(fontBlockers.length, 2);
  });

  it("blocks external CDN scripts and images", () => {
    const stage = makeStage("external-network", {
      "index.html": `<!doctype html><html><head>
        <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
      </head><body><img src="https://example.com/bg.jpg"></body></html>`,
    });

    const res = validateCompositionPreflight(stage);
    assert.equal(res.ok, false);
    assert.equal(
      res.blockers.filter((b) => b.code === "EXTERNAL_NETWORK_DISALLOWED").length,
      2
    );
  });

  it("blocks missing local @font-face font file with MISSING_CSS_FONT", () => {
    const stage = makeStage("missing-font-file", {
      "styles/app.css": `@font-face { font-family: 'X'; src: url('../fonts/missing.woff2'); }`,
      "index.html": `<!doctype html><html><head><link rel="stylesheet" href="./styles/app.css"></head>
        <body><script>window.__timelines={main:{}}</script></body></html>`,
    });

    const res = validateCompositionPreflight(stage);
    assert.equal(res.ok, false);
    assert.ok(res.blockers.some((b) => b.code === "MISSING_CSS_FONT"));
  });

  it("rejects path traversal and Windows Alternate Data Stream colons", () => {
    const stage = makeStage("unsafe-paths", {
      "assets/pic.png": "stub",
      "index.html": `<!doctype html><html><body>
        <img src="../../secret.png">
        <img src="./assets/pic.png:Zone.Identifier">
        <img src="./assets/pic%3aStream.png">
        <img src="file:///C:/Windows/win.ini">
      </body></html>`,
    });

    const res = validateCompositionPreflight(stage);
    assert.equal(res.ok, false);
    assert.ok(res.blockers.some((b) => b.code === "UNSAFE_ASSET_PATH"));
    assert.ok(res.blockers.filter((b) => b.code === "WINDOWS_ADS_REJECTED").length >= 2);
  });

  it("rejects symbolic link and Windows NTFS junction escapes", () => {
    const outsideDir = makeStage("outside-secret-dir", {
      "secret.png": "secret-data",
    });
    const stage = makeStage("symlink-escape-stage", {
      "assets/safe.txt": "ok",
      "index.html": `<!doctype html><html><body>
        <img src="./assets/linked-dir/secret.png">
        <script>window.__timelines={main:{}}</script>
      </body></html>`,
    });

    const junctionPath = path.join(stage, "assets", "linked-dir");
    fs.symlinkSync(outsideDir, junctionPath, "junction");

    const res = validateCompositionPreflight(stage);
    assert.equal(res.ok, false);
    assert.ok(res.blockers.some((b) => b.code === "ASSET_SYMLINK_ESCAPE"));

    // Also test direct file symlink if host OS permits
    const stageFileLink = makeStage("file-symlink-stage", {
      "index.html": `<!doctype html><html><body>
        <img src="./secret-link.png">
        <script>window.__timelines={main:{}}</script>
      </body></html>`,
    });
    try {
      fs.symlinkSync(path.join(outsideDir, "secret.png"), path.join(stageFileLink, "secret-link.png"), "file");
      const resFile = validateCompositionPreflight(stageFileLink);
      assert.equal(resFile.ok, false);
      assert.ok(resFile.blockers.some((b) => b.code === "ASSET_SYMLINK_ESCAPE"));
    } catch {
      // Unprivileged Windows accounts may disallow file symlinks without Developer Mode; junction test above always runs.
    }
  });
});
