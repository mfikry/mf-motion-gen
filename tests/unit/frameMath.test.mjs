import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampFrameIndex,
  computeTotalFrames,
  formatFpsLabel,
  formatTimecode,
  frameToTimeSec,
  parseFpsValue,
  snapFrameToMarkers,
  timeSecToFrame,
} from "../../dist/shared/frameMath.js";

describe("Rational FPS & Integer Frame Math", () => {
  it("parses integer, decimal, and rational FPS fractions or returns null without guessing", () => {
    assert.deepEqual(parseFpsValue("30000/1001"), { num: 30000, den: 1001 });
    assert.deepEqual(parseFpsValue("60"), { num: 60, den: 1 });
    assert.deepEqual(parseFpsValue("29.97"), { num: 29970, den: 1000 });
    assert.equal(parseFpsValue(null), null);
    assert.equal(parseFpsValue(""), null);
    assert.equal(parseFpsValue("abc"), null);
    assert.equal(parseFpsValue("0/1"), null);
  });

  it("computes totalFrames and clamps strictly within [0, N-1]", () => {
    const ntsc = { num: 30000, den: 1001 };
    assert.equal(computeTotalFrames(2, ntsc), 60);
    assert.equal(computeTotalFrames(null, ntsc), null);
    assert.equal(computeTotalFrames(2, null), null);

    assert.equal(clampFrameIndex(-5, 60), 0);
    assert.equal(clampFrameIndex(0, 60), 0);
    assert.equal(clampFrameIndex(59, 60), 59);
    assert.equal(clampFrameIndex(120, 60), 59);
    assert.equal(clampFrameIndex(5, 1), 0);
  });

  it("converts between integer frame indices and rational seconds accurately", () => {
    const ntsc = { num: 30000, den: 1001 };
    const t30 = frameToTimeSec(30, ntsc, 60);
    assert.ok(Math.abs(t30 - 1.001) < 1e-9);
    assert.equal(timeSecToFrame(t30, ntsc, 60), 30);

    assert.equal(formatTimecode(45, { num: 30, den: 1 }), "00:00:01:15");
    assert.equal(formatFpsLabel(ntsc), "30000/1001 (29.970 fps)");
    assert.equal(formatFpsLabel(null), "Unknown");
  });

  it("snaps only when real timeline markers exist", () => {
    const fps = { num: 30, den: 1 };
    const noMarkers = snapFrameToMarkers(29, [], fps, 90, 2);
    assert.equal(noMarkers.snapped, false);
    assert.equal(noMarkers.frame, 29);

    const withMarkers = snapFrameToMarkers(29, [1.0, 2.5], fps, 90, 2);
    assert.equal(withMarkers.snapped, true);
    assert.equal(withMarkers.frame, 30);
    assert.equal(withMarkers.markerSec, 1.0);
  });
});
