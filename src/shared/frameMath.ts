import type { FpsFraction } from "./renderContracts.js";

/**
 * Parses explicit FPS specs such as "30", "30000/1001", or decimal "29.97".
 * Returns null if the input is missing or invalid (never invents a default).
 */
export function parseFpsValue(raw: string | number | FpsFraction | null | undefined): FpsFraction | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === "object") {
    if (
      typeof raw.num === "number" &&
      typeof raw.den === "number" &&
      Number.isFinite(raw.num) &&
      Number.isFinite(raw.den) &&
      raw.num > 0 &&
      raw.den > 0
    ) {
      return { num: Math.round(raw.num), den: Math.round(raw.den) };
    }
    return null;
  }

  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    if (Number.isInteger(raw)) return { num: raw, den: 1 };
    const scaled = Math.round(raw * 1000);
    return { num: scaled, den: 1000 };
  }

  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fracMatch = /^(\d+)\s*\/\s*(\d+)$/.exec(trimmed);
  if (fracMatch) {
    const num = Number(fracMatch[1]);
    const den = Number(fracMatch[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
      return { num, den };
    }
    return null;
  }

  const numVal = Number(trimmed);
  if (!Number.isFinite(numVal) || numVal <= 0) return null;
  if (Number.isInteger(numVal)) return { num: numVal, den: 1 };
  return { num: Math.round(numVal * 1000), den: 1000 };
}

export function fpsToNumber(fps: FpsFraction): number {
  return fps.num / fps.den;
}

export function formatFpsLabel(fps: FpsFraction | null): string {
  if (!fps) return "Unknown";
  if (fps.den === 1) return `${fps.num} fps`;
  return `${fps.num}/${fps.den} (${(fps.num / fps.den).toFixed(3)} fps)`;
}

export function computeTotalFrames(durationSec: number | null, fps: FpsFraction | null): number | null {
  if (durationSec === null || fps === null) return null;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const total = Math.round((durationSec * fps.num) / fps.den);
  return Math.max(1, total);
}

export function clampFrameIndex(frameIndex: number, totalFrames: number): number {
  if (!Number.isFinite(totalFrames) || totalFrames <= 1) return 0;
  const maxFrame = Math.floor(totalFrames) - 1;
  const floored = Number.isFinite(frameIndex) ? Math.round(frameIndex) : 0;
  return Math.max(0, Math.min(maxFrame, floored));
}

export function frameToTimeSec(frameIndex: number, fps: FpsFraction, totalFrames?: number | null): number {
  const safeFrame =
    totalFrames !== null && totalFrames !== undefined
      ? clampFrameIndex(frameIndex, totalFrames)
      : Math.max(0, Math.round(frameIndex));
  return (safeFrame * fps.den) / fps.num;
}

export function timeSecToFrame(
  timeSec: number,
  fps: FpsFraction,
  totalFrames?: number | null
): number {
  if (!Number.isFinite(timeSec) || timeSec <= 0) return 0;
  const rawFrame = Math.round((timeSec * fps.num) / fps.den);
  if (totalFrames !== null && totalFrames !== undefined) {
    return clampFrameIndex(rawFrame, totalFrames);
  }
  return Math.max(0, rawFrame);
}

export function formatTimecode(frameIndex: number, fps: FpsFraction): string {
  const safeFrame = Math.max(0, Math.round(frameIndex));
  const nominalFps = Math.max(1, Math.round(fps.num / fps.den));
  const totalSeconds = Math.floor(safeFrame / nominalFps);
  const framePart = safeFrame % nominalFps;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(framePart)}`;
}

/**
 * Snaps an integer frame index to the nearest available timeline marker/keyframe
 * ONLY when real markers exist. Returns the input frame unchanged if markersSec is empty.
 */
export function snapFrameToMarkers(
  frameIndex: number,
  markersSec: readonly number[],
  fps: FpsFraction,
  totalFrames: number,
  thresholdFrames = 2
): { frame: number; snapped: boolean; markerSec: number | null } {
  const clamped = clampFrameIndex(frameIndex, totalFrames);
  if (!markersSec || markersSec.length === 0) {
    return { frame: clamped, snapped: false, markerSec: null };
  }

  let bestFrame = clamped;
  let bestDist = Infinity;
  let bestMarker: number | null = null;

  for (const mSec of markersSec) {
    if (!Number.isFinite(mSec) || mSec < 0) continue;
    const mFrame = timeSecToFrame(mSec, fps, totalFrames);
    const dist = Math.abs(mFrame - clamped);
    if (dist <= thresholdFrames && dist < bestDist) {
      bestDist = dist;
      bestFrame = mFrame;
      bestMarker = mSec;
    }
  }

  return {
    frame: bestFrame,
    snapped: bestMarker !== null,
    markerSec: bestMarker,
  };
}
