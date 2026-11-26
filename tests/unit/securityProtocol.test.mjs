import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateAssetProtocolRequest,
  parseByteRange,
  validateRawAssetUrl,
} from "../../dist/main/security/assetProtocolCore.js";
import { evaluateNetworkRequestPolicy } from "../../dist/main/security/networkPolicyManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

describe("mf-asset:// Protocol & Network Security Policy", () => {
  const sessionId = "session-1111-2222";
  const expectedOrigin = `mf-asset://${sessionId}`;
  let stageDir;
  let outsideDir;

  before(() => {
    const tmpParent = path.join(repoRoot, "tmp");
    fs.mkdirSync(tmpParent, { recursive: true });
    const tmpBase = fs.mkdtempSync(path.join(tmpParent, "unit-sec-proto-"));
    stageDir = path.join(tmpBase, "stage");
    outsideDir = path.join(tmpBase, "outside");
    fs.mkdirSync(path.join(stageDir, "assets"), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    fs.writeFileSync(path.join(stageDir, "index.html"), "<html><body>OK</body></html>");
    fs.writeFileSync(path.join(stageDir, "assets", "logo.svg"), "<svg/>");
    fs.writeFileSync(path.join(stageDir, "assets", "range.mp4"), Buffer.alloc(1000, 65));
    fs.writeFileSync(path.join(stageDir, "assets", "blocked.bin"), "BIN");
    fs.writeFileSync(path.join(outsideDir, "secret.png"), "SECRET");
    fs.symlinkSync(outsideDir, path.join(stageDir, "assets", "junction-dir"), "junction");
  });

  after(() => {
    try {
      fs.unlinkSync(path.join(stageDir, "assets", "junction-dir"));
    } catch {
      // Ignore
    }
    fs.rmSync(path.dirname(stageDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("blocks raw URL traversal, encoded dot segments, authority spoofing, and Windows ADS", () => {
    const invalidUrls = [
      `mf-asset://${sessionId}/assets/../index.html`,
      `mf-asset://${sessionId}/%2e%2e/index.html`,
      `mf-asset://${sessionId}/assets/%2e/logo.svg`,
      `mf-asset://${sessionId}/assets/%2flogo.svg`,
      `mf-asset://${sessionId}/%252e%252e/secret.txt`,
      `mf-asset://${sessionId}/index.html::$DATA`,
      `mf-asset://${sessionId}/assets/logo.svg:Zone.Identifier`,
      `mf-asset://${sessionId}/assets/logo.svg%3astream`,
      `mf-asset://evil@${sessionId}/index.html`,
      `mf-asset://${sessionId}:8080/index.html`,
      `mf-asset://${sessionId}/assets\\logo.svg`,
    ];

    for (const u of invalidUrls) {
      assert.equal(validateRawAssetUrl(u), null, `Expected null for unsafe URL: ${u}`);
    }

    assert.deepEqual(validateRawAssetUrl(`mf-asset://${sessionId}/index.html`), ["index.html"]);
    assert.deepEqual(validateRawAssetUrl(`mf-asset://${sessionId}/assets/logo.svg`), ["assets", "logo.svg"]);
  });

  it("enforces method allowlist, initiatorOrigin checks, CSP separation, and junction blocking", async () => {
    const postRes = await evaluateAssetProtocolRequest(
      { method: "POST", url: `${expectedOrigin}/index.html`, initiatorOrigin: undefined },
      sessionId,
      stageDir,
      "/index.html"
    );
    assert.equal(postRes.status, 405);

    // Browser-initiated mainFrame entry HTML (initiatorOrigin === undefined) -> 200 + strict CSP
    const entryRes = await evaluateAssetProtocolRequest(
      { method: "GET", url: `${expectedOrigin}/index.html`, initiatorOrigin: undefined },
      sessionId,
      stageDir,
      "/index.html"
    );
    assert.equal(entryRes.status, 200);
    const csp = entryRes.headers.get("Content-Security-Policy");
    assert.ok(csp && csp.includes("connect-src 'none'") && csp.includes(expectedOrigin));
    await entryRes.arrayBuffer();

    // Browser-initiated non-entry load -> 403
    const nonEntryRes = await evaluateAssetProtocolRequest(
      { method: "GET", url: `${expectedOrigin}/assets/logo.svg`, initiatorOrigin: undefined },
      sessionId,
      stageDir,
      "/index.html"
    );
    assert.equal(nonEntryRes.status, 403);

    // Opaque ("null", null) and empty ("") initiator origins must be rejected
    for (const badOrigin of [null, "null", "", "mf-asset://other-session", "https://evil.com"]) {
      const r = await evaluateAssetProtocolRequest(
        { method: "GET", url: `${expectedOrigin}/index.html`, initiatorOrigin: badOrigin },
        sessionId,
        stageDir,
        "/index.html"
      );
      assert.equal(r.status, 403, `Expected 403 for initiatorOrigin=${String(badOrigin)}`);
    }

    // Valid subresource fetch from exact origin -> 200 without HTML CSP header
    const subRes = await evaluateAssetProtocolRequest(
      { method: "GET", url: `${expectedOrigin}/assets/logo.svg`, initiatorOrigin: expectedOrigin },
      sessionId,
      stageDir,
      "/index.html"
    );
    assert.equal(subRes.status, 200);
    assert.equal(subRes.headers.get("Content-Security-Policy"), null);
    assert.equal(subRes.headers.get("X-Content-Type-Options"), "nosniff");
    await subRes.arrayBuffer();

    // Disallowed extension -> 415 Unsupported Media Type
    const badMimeRes = await evaluateAssetProtocolRequest(
      { method: "GET", url: `${expectedOrigin}/assets/blocked.bin`, initiatorOrigin: expectedOrigin },
      sessionId,
      stageDir,
      "/index.html"
    );
    assert.equal(badMimeRes.status, 415);

    // Windows NTFS junction escape -> 403
    const juncRes = await evaluateAssetProtocolRequest(
      {
        method: "GET",
        url: `${expectedOrigin}/assets/junction-dir/secret.png`,
        initiatorOrigin: expectedOrigin,
      },
      sessionId,
      stageDir,
      "/index.html"
    );
    assert.equal(juncRes.status, 403);
  });

  it("implements RFC-compliant Byte Range parsing and handler status codes", async () => {
    assert.deepEqual(parseByteRange("bytes=0-499", 1000), { kind: "partial", start: 0, end: 499 });
    assert.deepEqual(parseByteRange("bytes=500-", 1000), { kind: "partial", start: 500, end: 999 });
    assert.deepEqual(parseByteRange("bytes=-500", 1000), { kind: "partial", start: 500, end: 999 });
    assert.deepEqual(parseByteRange("bytes=0-999999", 1000), { kind: "partial", start: 0, end: 999 });
    assert.deepEqual(parseByteRange("bytes=-0", 1000), { kind: "unsatisfiable" });
    assert.deepEqual(parseByteRange("bytes=-", 1000), { kind: "full" });
    assert.deepEqual(parseByteRange("bytes=0-99,200-299", 1000), { kind: "full" });
    assert.deepEqual(parseByteRange("bytes=0-999999999999999999999", 1000), { kind: "full" });

    const r206 = await evaluateAssetProtocolRequest(
      {
        method: "GET",
        url: `${expectedOrigin}/assets/range.mp4`,
        initiatorOrigin: expectedOrigin,
        rangeHeader: "bytes=0-499",
      },
      sessionId,
      stageDir,
      "/index.html"
    );
    assert.equal(r206.status, 206);
    assert.equal(r206.headers.get("Content-Range"), "bytes 0-499/1000");
    assert.equal((await r206.arrayBuffer()).byteLength, 500);

    const r416 = await evaluateAssetProtocolRequest(
      {
        method: "GET",
        url: `${expectedOrigin}/assets/range.mp4`,
        initiatorOrigin: expectedOrigin,
        rangeHeader: "bytes=-0",
      },
      sessionId,
      stageDir,
      "/index.html"
    );
    assert.equal(r416.status, 416);
  });

  it("enforces centralized webRequest policy across all forbidden schemes and frames", () => {
    assert.equal(evaluateNetworkRequestPolicy(`${expectedOrigin}/index.html`, "mainFrame", sessionId, "/index.html").allow, true);
    assert.equal(evaluateNetworkRequestPolicy(`${expectedOrigin}/assets/logo.svg`, "mainFrame", sessionId, "/index.html").allow, false);
    assert.equal(evaluateNetworkRequestPolicy(`${expectedOrigin}/index.html`, "subFrame", sessionId, "/index.html").allow, false);
    assert.equal(evaluateNetworkRequestPolicy(`${expectedOrigin}/assets/logo.svg`, "image", sessionId, "/index.html").allow, true);
    assert.equal(evaluateNetworkRequestPolicy("data:image/png;base64,AAAA", "image", sessionId, "/index.html").allow, true);
    assert.equal(evaluateNetworkRequestPolicy("blob:mf-asset://id/1", "script", sessionId, "/index.html").allow, true);

    for (const bad of [
      "https://example.com/script.js",
      "http://localhost:8080/api",
      "ws://localhost:9000",
      "wss://example.com/socket",
      "ftp://example.com/file.bin",
      "file:///C:/Windows/win.ini",
      "mf-asset://other-session/index.html",
    ]) {
      assert.equal(
        evaluateNetworkRequestPolicy(bad, "xhr", sessionId, "/index.html").allow,
        false,
        `Expected block for ${bad}`
      );
    }
  });
});
