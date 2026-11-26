import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ProjectImportError, buildLocalAssetTree, stageIsolatedFolderCopy } from "../../dist/main/import/projectImporter.js";
import { extractZipSecurely, ZipSecurityError } from "../../dist/main/import/secureZipExtractor.js";
import { computeFileSha256Sync, purgeSessionDirectorySync } from "../../dist/main/import/sessionFsUtils.js";
import { validateCompositionPreflight } from "../../dist/main/validation/hostPreflightValidator.js";
import { buildSyntheticZip } from "../helpers/zipTestHelper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

describe("Secure ZIP Extractor, Folder Importer & Asset Tree", () => {
  let rootTmp;

  before(() => {
    const tmpBase = path.join(repoRoot, "tmp");
    fs.mkdirSync(tmpBase, { recursive: true });
    rootTmp = fs.mkdtempSync(path.join(tmpBase, "unit-archive-"));
  });

  after(() => {
    purgeSessionDirectorySync(rootTmp);
  });

  it("extracts valid nested ZIP, verifies SHA-256, sets read-only file attribute, and purges cleanly", async () => {
    const zipPath = path.join(rootTmp, "valid-project.zip");
    const targetDir = path.join(rootTmp, "extract-valid");
    buildSyntheticZip(zipPath, [
      { name: "assets/", data: "", method: 0, externalFileAttr: 0x10 },
      { name: "index.html", data: `<html><head><link rel="stylesheet" href="./styles/app.css"></head><body><img src="./assets/logo.svg"></body></html>` },
      { name: "styles/app.css", data: `@font-face{font-family:Demo;src:url("../fonts/demo.woff2");}` },
      { name: "fonts/demo.woff2", data: "wOF2-dummy-bytes" },
      { name: "assets/logo.svg", data: "<svg/>" },
      { name: "assets/extra.bin", data: "unsupported-ext" },
    ]);

    const res = await extractZipSecurely(zipPath, targetDir);
    assert.equal(res.fileCount, 5);
    assert.ok(fs.existsSync(path.join(targetDir, "styles", "app.css")));

    // Best-effort read-only file attribute verification (no write bits set on extracted file)
    const mode = fs.statSync(path.join(targetDir, "index.html")).mode;
    assert.equal(mode & 0o222, 0, "Extracted working copy must be read-only");

    // Asset tree verification
    const preflight = validateCompositionPreflight(targetDir, { entryFile: "index.html" });
    assert.equal(preflight.ok, true);
    const tree = buildLocalAssetTree(targetDir, "index.html", preflight, res.fileSha256ByRelPath);
    const assetsNode = tree.find((n) => n.name === "assets");
    assert.ok(assetsNode && assetsNode.kind === "directory");
    const svgChild = assetsNode.children.find((c) => c.name === "logo.svg");
    const binChild = assetsNode.children.find((c) => c.name === "extra.bin");
    assert.equal(svgChild.validationStatus, "verified");
    assert.equal(binChild.validationStatus, "unsupported");

    purgeSessionDirectorySync(targetDir);
    assert.equal(fs.existsSync(targetDir), false);
  });

  it("rejects traversal, encoded dot segments, Windows drive/UNC, ADS colon, and trailing dots/spaces", async () => {
    const badNames = [
      { name: "../escape.txt", code: "ZIP_PATH_TRAVERSAL_FORBIDDEN" },
      { name: "assets/../../escape.txt", code: "ZIP_PATH_TRAVERSAL_FORBIDDEN" },
      { name: "assets/%2e%2e/escape.txt", code: "ZIP_ENCODED_TRAVERSAL_FORBIDDEN" },
      { name: "C:\\Windows\\win.ini", code: "ZIP_DRIVE_OR_ADS_FORBIDDEN" },
      { name: "\\\\evil-server\\share\\x.txt", code: "ZIP_DRIVE_OR_ADS_FORBIDDEN" },
      { name: "index.html:Zone.Identifier", code: "ZIP_DRIVE_OR_ADS_FORBIDDEN" },
      { name: "assets/trailing-dot.txt.", code: "ZIP_WINDOWS_TRAILING_DOT_SPACE_FORBIDDEN" },
      { name: "assets/trailing-space.txt ", code: "ZIP_WINDOWS_TRAILING_DOT_SPACE_FORBIDDEN" },
      { name: "CON.html", code: "ZIP_WINDOWS_RESERVED_NAME" },
    ];

    for (let i = 0; i < badNames.length; i++) {
      const zipPath = path.join(rootTmp, `bad-path-${i}.zip`);
      const targetDir = path.join(rootTmp, `extract-bad-path-${i}`);
      buildSyntheticZip(zipPath, [{ name: badNames[i].name, data: "x" }]);
      await assert.rejects(
        () => extractZipSecurely(zipPath, targetDir),
        (err) => err instanceof ZipSecurityError && err.code === badNames[i].code
      );
      assert.equal(fs.existsSync(targetDir), false);
    }
  });

  it("rejects Unix symlinks, Windows reparse points, and special link/device modes", async () => {
    const symlinkAttr = (0o120777 << 16) >>> 0;
    const fifoAttr = (0o010644 << 16) >>> 0;
    const reparseAttr = 0x400;

    for (const [tag, attr, expectedCode] of [
      ["unix-symlink", symlinkAttr, "ZIP_SYMLINK_FORBIDDEN"],
      ["win-reparse", reparseAttr, "ZIP_SYMLINK_FORBIDDEN"],
      ["special-fifo", fifoAttr, "ZIP_HARDLINK_FORBIDDEN"],
    ]) {
      const zipPath = path.join(rootTmp, `bad-${tag}.zip`);
      const targetDir = path.join(rootTmp, `extract-${tag}`);
      buildSyntheticZip(zipPath, [{ name: "link.txt", data: "/etc/passwd", externalFileAttr: attr }]);
      await assert.rejects(
        () => extractZipSecurely(zipPath, targetDir),
        (err) => err instanceof ZipSecurityError && err.code === expectedCode
      );
      assert.equal(fs.existsSync(targetDir), false);
    }
  });

  it("rejects duplicate case-insensitive ZIP paths", async () => {
    const zipPath = path.join(rootTmp, "dup-case.zip");
    const targetDir = path.join(rootTmp, "extract-dup");
    buildSyntheticZip(zipPath, [
      { name: "Assets/Logo.svg", data: "<svg/>" },
      { name: "assets/logo.svg", data: "<svg>evil</svg>" },
    ]);
    await assert.rejects(
      () => extractZipSecurely(zipPath, targetDir),
      (err) => err instanceof ZipSecurityError && err.code === "ZIP_DUPLICATE_CASE_INSENSITIVE_PATH"
    );
    assert.equal(fs.existsSync(targetDir), false);
  });

  it("enforces entry count limit, 100:1 compression ratio, total size limit, and forged-header bomb protection", async () => {
    // 1. Entry count > maxEntries
    const manyZip = path.join(rootTmp, "many-entries.zip");
    const manyEntries = Array.from({ length: 1001 }, (_, i) => ({ name: `f_${i}.txt`, data: "a", method: 0 }));
    buildSyntheticZip(manyZip, manyEntries);
    await assert.rejects(
      () => extractZipSecurely(manyZip, path.join(rootTmp, "ex-many")),
      (err) => err instanceof ZipSecurityError && err.code === "ZIP_MAX_ENTRIES_EXCEEDED"
    );

    // 2. Compression ratio > 100:1 (e.g. 200 KB of zeros compresses to ~210 bytes -> ~950:1)
    const bombBuf = Buffer.alloc(200 * 1024, 0);
    const ratioZip = path.join(rootTmp, "ratio-bomb.zip");
    buildSyntheticZip(ratioZip, [{ name: "bomb.txt", data: bombBuf, method: 8 }]);
    await assert.rejects(
      () => extractZipSecurely(ratioZip, path.join(rootTmp, "ex-ratio")),
      (err) => err instanceof ZipSecurityError && err.code === "ZIP_COMPRESSION_RATIO_EXCEEDED"
    );

    // 3. Forged header claiming small uncompressed size when actual stream exceeds quota mid-inflation
    const forgedZip = path.join(rootTmp, "forged-bomb.zip");
    const exForgedDir = path.join(rootTmp, "ex-forged");
    buildSyntheticZip(forgedZip, [
      { name: "forged.txt", data: bombBuf, method: 8, forgedUncompressedSize: 512 },
    ]);
    await assert.rejects(
      () => extractZipSecurely(forgedZip, exForgedDir),
      (err) => err instanceof ZipSecurityError && err.code === "ZIP_COMPRESSION_RATIO_EXCEEDED"
    );
    assert.equal(fs.existsSync(exForgedDir), false);

    // 4. Max uncompressed total size exceeded (tight limit override for fast unit test)
    const sizeZip = path.join(rootTmp, "size-limit.zip");
    buildSyntheticZip(sizeZip, [{ name: "a.txt", data: Buffer.alloc(4096, 65), method: 0 }]);
    await assert.rejects(
      () => extractZipSecurely(sizeZip, path.join(rootTmp, "ex-size"), { maxUncompressedBytes: 2048 }),
      (err) => err instanceof ZipSecurityError && err.code === "ZIP_MAX_UNCOMPRESSED_SIZE_EXCEEDED"
    );
  });

  it("stages isolated folder copies preserving source SHA-256 and rejecting NTFS junctions", () => {
    const srcFolder = path.join(rootTmp, "src-folder-good");
    fs.mkdirSync(path.join(srcFolder, "assets"), { recursive: true });
    fs.writeFileSync(path.join(srcFolder, "index.html"), `<html><body><img src="./assets/pic.svg"/></body></html>`);
    fs.writeFileSync(path.join(srcFolder, "assets", "pic.svg"), "<svg/>");

    const origHtmlSha = computeFileSha256Sync(path.join(srcFolder, "index.html"));
    const workDir = path.join(rootTmp, "work-folder-good");
    const staged = stageIsolatedFolderCopy(srcFolder, workDir);

    assert.equal(staged.fileCount, 2);
    assert.deepEqual(staged.htmlCandidates, ["index.html"]);
    assert.equal(staged.sourceSha256ByRelPath["index.html"], origHtmlSha);
    assert.equal(computeFileSha256Sync(path.join(srcFolder, "index.html")), origHtmlSha);

    // Reject Windows NTFS junction inside folder
    const outside = path.join(rootTmp, "outside-junc-target");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "leak.txt"), "LEAK");
    const badFolder = path.join(rootTmp, "src-folder-bad");
    fs.mkdirSync(badFolder, { recursive: true });
    fs.writeFileSync(path.join(badFolder, "index.html"), "<html></html>");
    fs.symlinkSync(outside, path.join(badFolder, "junc"), "junction");

    assert.throws(
      () => stageIsolatedFolderCopy(badFolder, path.join(rootTmp, "work-folder-bad")),
      (err) => err instanceof ProjectImportError && err.code === "IMPORT_SYMLINK_FORBIDDEN"
    );
  });
});
