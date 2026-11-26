import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVED_REFERENCE_THRESHOLDS_1280X720_SDR,
  REFERENCE_PARITY_THRESHOLD_PROFILE_ID,
  analyzeAlphaPlaneBuffer,
  classifyRepeatRenderDeterminism,
  computeParitySamplePlan,
  computeRgbFrameDifference,
  evaluateParityGateDetails,
  evaluateParityGateStatus,
  isFourKBenchmarkEnabled,
  resolvePngHeader,
} from "../../dist/main/verification/visualParity.js";

function buildMinimalPngHeader(width, height, bitDepth = 8, colorType = 2) {
  const buf = Buffer.alloc(29);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.writeUInt8(bitDepth, 24);
  buf.writeUInt8(colorType, 25);
  return buf;
}

describe("Workstream D — Visual Parity Math, Alpha Regions, Determinism & Gate Policy", () => {
  it("1-4: computes first (0), middle (floor(N/2)), last (N-1), and backward-seek timestamps using rational FPS", () => {
    const plan60 = computeParitySamplePlan(60, { num: 30, den: 1 });
    assert.equal(plan60.samples.first.frameIndex, 0);
    assert.equal(plan60.samples.first.timeSec, 0);
    assert.equal(plan60.samples.middle.frameIndex, 30);
    assert.equal(plan60.samples.middle.timeSec, 1);
    assert.equal(plan60.samples.last.frameIndex, 59);
    assert.equal(plan60.samples.last.timeSec, 59 / 30);

    // Odd frame count: middle must be Math.floor(N/2) and last N-1 under NTSC 30000/1001
    const planNtsc = computeParitySamplePlan(61, { num: 30000, den: 1001 });
    assert.equal(planNtsc.samples.first.frameIndex, 0);
    assert.equal(planNtsc.samples.middle.frameIndex, 30);
    assert.equal(planNtsc.samples.last.frameIndex, 60);
    assert.ok(Math.abs(planNtsc.samples.last.timeSec - (60 * 1001) / 30000) < 1e-12);

    assert.deepEqual(
      planNtsc.backwardSeekSequence.map((s) => [s.step, s.frameIndex]),
      [
        ["middle_initial", 30],
        ["first", 0],
        ["last", 60],
        ["middle_repeat", 30],
      ]
    );
  });

  it("5: parses PNG IHDR dimensions accurately and rejects non-PNG buffers", () => {
    const hdr = resolvePngHeader(buildMinimalPngHeader(1280, 720, 8, 6));
    assert.deepEqual(hdr, { width: 1280, height: 720, bitDepth: 8, colorType: 6 });
    assert.throws(() => resolvePngHeader(Buffer.from("not-a-png")), /Invalid PNG/);
  });

  it("6 & 11: computes RGB MAE/RMSE/tolerance stats and separates bit-identical vs visual-equivalent vs non-deterministic", () => {
    const w = 4;
    const h = 4;
    const a = Buffer.alloc(w * h * 3, 100);
    const bIdentical = Buffer.from(a);
    const identicalMetrics = computeRgbFrameDifference(a, bIdentical, w, h);
    assert.equal(identicalMetrics.maePerChannel, 0);
    assert.equal(identicalMetrics.maxChannelDiff, 0);
    assert.equal(identicalMetrics.pctExactZero, 100);

    const bSlightlyChanged = Buffer.from(a);
    bSlightlyChanged[0] = 102; // 1 channel differs by 2
    const diffMetrics = computeRgbFrameDifference(a, bSlightlyChanged, w, h);
    assert.equal(diffMetrics.maxChannelDiff, 2);
    assert.equal(diffMetrics.pctWithinTol2, 100);
    assert.ok(diffMetrics.maePerChannel > 0);

    const hA = [
      { index: 0, hash: "a".repeat(64), byteSize: 100 },
      { index: 1, hash: "b".repeat(64), byteSize: 100 },
    ];
    const hB = [
      { index: 0, hash: "a".repeat(64), byteSize: 100 },
      { index: 1, hash: "b".repeat(64), byteSize: 100 },
    ];
    assert.equal(
      classifyRepeatRenderDeterminism({ hashesA: hA, hashesB: hB }).classification,
      "BIT_IDENTICAL_FRAMES"
    );

    const hDiff = [
      { index: 0, hash: "a".repeat(64), byteSize: 100 },
      { index: 1, hash: "c".repeat(64), byteSize: 100 },
    ];
    assert.equal(
      classifyRepeatRenderDeterminism({
        hashesA: hA,
        hashesB: hDiff,
        sampleVisualMetrics: [{ ssimAll: 0.9999, maePerChannel: 0.1 }],
      }).classification,
      "VISUAL_EQUIVALENT"
    );
    assert.equal(
      classifyRepeatRenderDeterminism({
        hashesA: hA,
        hashesB: hDiff,
        sampleVisualMetrics: [{ ssimAll: 0.91, maePerChannel: 8.5 }],
      }).classification,
      "NON_DETERMINISTIC"
    );
  });

  it("12: verifies alpha channel regions separately (transparent stays 0, opaque stays 255, semi stays intermediate)", () => {
    const w = 10;
    const h = 10;
    const alpha = Buffer.alloc(w * h, 0);
    // Top-right 4x4 region opaque = 255
    for (let y = 0; y < 4; y++) {
      for (let x = 6; x < 10; x++) {
        alpha[y * w + x] = 255;
      }
    }
    // Bottom-right 4x4 region semi = 128
    for (let y = 6; y < 10; y++) {
      for (let x = 6; x < 10; x++) {
        alpha[y * w + x] = 128;
      }
    }

    const regions = [
      { label: "bg_transparent", expectedKind: "transparent", x: 0, y: 0, width: 4, height: 4 },
      { label: "fg_opaque", expectedKind: "opaque", x: 6, y: 0, width: 4, height: 4 },
      { label: "fg_semi", expectedKind: "semi", x: 6, y: 6, width: 4, height: 4 },
    ];
    const okReport = analyzeAlphaPlaneBuffer(alpha, w, h, regions);
    assert.equal(okReport.passed, true);
    assert.equal(okReport.globalMinAlpha, 0);
    assert.equal(okReport.globalMaxAlpha, 255);

    // Corrupt alpha: make transparent box non-zero -> must fail
    const brokenTransparent = Buffer.from(alpha);
    brokenTransparent[0] = 1;
    assert.equal(analyzeAlphaPlaneBuffer(brokenTransparent, w, h, regions).passed, false);

    // Corrupt alpha: opaque box < 255 -> must fail
    const brokenOpaque = Buffer.from(alpha);
    brokenOpaque[0 * w + 6] = 254;
    assert.equal(analyzeAlphaPlaneBuffer(brokenOpaque, w, h, regions).passed, false);

    // Corrupt alpha: 50% semi box outside 127..129 -> must fail
    const brokenSemi = Buffer.from(alpha);
    brokenSemi[6 * w + 6] = 126;
    assert.equal(analyzeAlphaPlaneBuffer(brokenSemi, w, h, regions).passed, false);
  });

  it("Rule: enforces per-frame PM thresholds (PASS/FAIL/PENDING_REVIEW) and opt-in 4K flag", () => {
    const mp4Thresh = APPROVED_REFERENCE_THRESHOLDS_1280X720_SDR.MP4_H264;
    const movThresh = APPROVED_REFERENCE_THRESHOLDS_1280X720_SDR.MOV_PRORES_4444;
    assert.equal(mp4Thresh.thresholdProfileId, REFERENCE_PARITY_THRESHOLD_PROFILE_ID);
    assert.equal(movThresh.thresholdProfileId, REFERENCE_PARITY_THRESHOLD_PROFILE_ID);

    const mp4PassSamples = [
      { label: "first", frameIndex: 0, ssimAll: 0.992, psnrDb: 41.1, maePerChannel: 1.33, pctWithinTol2: 86.9, pctWithinTol5: 99.2 },
      { label: "middle", frameIndex: 30, ssimAll: 0.988, psnrDb: 38.7, maePerChannel: 1.45, pctWithinTol2: 84.9, pctWithinTol5: 98.3 },
      { label: "last", frameIndex: 59, ssimAll: 0.991, psnrDb: 41.6, maePerChannel: 1.35, pctWithinTol2: 86.1, pctWithinTol5: 98.8 },
    ];

    // Missing threshold or empty/incomplete samples => PENDING_REVIEW
    assert.equal(evaluateParityGateStatus(mp4PassSamples, null), "PENDING_REVIEW");
    assert.equal(evaluateParityGateStatus([], mp4Thresh), "PENDING_REVIEW");
    assert.equal(
      evaluateParityGateStatus([{ ...mp4PassSamples[0], psnrDb: NaN }], mp4Thresh),
      "PENDING_REVIEW"
    );

    // All frames satisfy every criterion => PASS
    const passDetails = evaluateParityGateDetails(mp4PassSamples, mp4Thresh);
    assert.equal(passDetails.status, "PASS");
    assert.equal(passDetails.thresholdProfileId, "mf-v2-reference-1280x720-sdr-v1");

    // Aggregate average looks great, but one single frame violates pctWithinTol5 (<98) => FAIL
    const singleFrameFailSamples = [
      { label: "first", frameIndex: 0, ssimAll: 0.999, psnrDb: 48, maePerChannel: 0.2, pctWithinTol2: 99.5, pctWithinTol5: 99.9 },
      { label: "middle", frameIndex: 30, ssimAll: 0.99, psnrDb: 38, maePerChannel: 1.5, pctWithinTol2: 80, pctWithinTol5: 97.4 },
      { label: "last", frameIndex: 59, ssimAll: 0.999, psnrDb: 48, maePerChannel: 0.2, pctWithinTol2: 99.5, pctWithinTol5: 99.9 },
    ];
    const failDetails = evaluateParityGateDetails(singleFrameFailSamples, mp4Thresh);
    assert.equal(failDetails.status, "FAIL");
    assert.equal(failDetails.failedSamples.length, 1);
    assert.equal(failDetails.failedSamples[0].frameIndex, 30);

    // ProRes failure when MAE > 0.5 or pctWithinTol2 < 99 on a single sample
    assert.equal(
      evaluateParityGateStatus(
        [{ label: "first", frameIndex: 0, ssimAll: 0.998, psnrDb: 44, maePerChannel: 0.4, pctWithinTol2: 98.9, pctWithinTol5: 99.8 }],
        movThresh
      ),
      "FAIL"
    );

    assert.equal(isFourKBenchmarkEnabled({}), false);
    assert.equal(isFourKBenchmarkEnabled({ MF_RUN_4K_BENCHMARK: "0" }), false);
    assert.equal(isFourKBenchmarkEnabled({ MF_RUN_4K_BENCHMARK: "1" }), true);
  });
});
