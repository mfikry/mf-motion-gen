import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { frameToTimeSec } from "../../shared/frameMath.js";
import type { FpsFraction } from "../../shared/renderContracts.js";

export interface PngHeaderInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

export interface ParitySamplePoint {
  label: "first" | "middle" | "last";
  frameIndex: number;
  timeSec: number;
}

export interface ParitySamplePlan {
  actualFrameCount: number;
  fps: FpsFraction;
  samples: {
    first: ParitySamplePoint;
    middle: ParitySamplePoint;
    last: ParitySamplePoint;
  };
  backwardSeekSequence: Array<{
    step: "middle_initial" | "first" | "last" | "middle_repeat";
    frameIndex: number;
    timeSec: number;
  }>;
}

export interface VideoStreamMetadata {
  filePath: string;
  codecName: string;
  codecLongName: string | null;
  profile: string | null;
  width: number;
  height: number;
  pixFmt: string | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  colorRange: string | null;
  rFrameRate: string;
  avgFrameRate: string;
  containerNbFrames: number | null;
  actualFrameCount: number;
  durationSec: number | null;
  bitRate: number | null;
  fileSizeBytes: number;
}

export interface ImageNormalizationRecord {
  normalized: boolean;
  algorithm: string;
  rawDimension: { width: number; height: number };
  outputDimension: { width: number; height: number };
}

export interface RgbDifferenceMetrics {
  width: number;
  height: number;
  totalPixels: number;
  maePerChannel: number;
  rmsePerChannel: number;
  maxChannelDiff: number;
  pctExactZero: number;
  pctWithinTol2: number;
  pctWithinTol5: number;
  pctWithinTol15: number;
}

export interface FfmpegVisualMetrics {
  comparisonFormat: "rgb24";
  ssimAll: number;
  psnrDb: number | null;
  psnrInfinite: boolean;
}

export interface FrameHashEntry {
  index: number;
  hash: string;
  byteSize: number;
}

export type DeterminismClassification =
  | "BIT_IDENTICAL_FRAMES"
  | "VISUAL_EQUIVALENT"
  | "NON_DETERMINISTIC";

export interface RepeatDeterminismSummary {
  classification: DeterminismClassification;
  frameCountRunA: number;
  frameCountRunB: number;
  comparedFrames: number;
  matchingHashFrames: number;
  differingFrameIndices: number[];
  notes: string;
}

export interface AlphaRegionSpec {
  label: string;
  expectedKind: "transparent" | "opaque" | "semi";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AlphaRegionStats extends AlphaRegionSpec {
  pixelCount: number;
  minAlpha: number;
  maxAlpha: number;
  meanAlpha: number;
  passed: boolean;
}

export interface AlphaIntegrityReport {
  width: number;
  height: number;
  globalMinAlpha: number;
  globalMaxAlpha: number;
  regions: AlphaRegionStats[];
  passed: boolean;
}

export const REFERENCE_PARITY_THRESHOLD_PROFILE_ID = "mf-v2-reference-1280x720-sdr-v1" as const;

export const REFERENCE_THRESHOLD_SCOPE_NOTE =
  "Applies strictly to Sprint 6 reference composition (1280x720, 30/1 FPS, SDR rgb24, WebContentsView.capturePage() vs FFmpeg decoded frames 0/30/59). Does NOT imply universal SSIM across arbitrary user HTML or 1080p/4K outputs.";

export interface ParityApprovedThreshold {
  thresholdProfileId: string;
  scopeNote: string;
  minSsim: number;
  minPsnrDb: number;
  maxMaePerChannel: number;
  maxPixelToleranceBand: 2 | 5;
  minPctWithinTolerance: number;
}

export const APPROVED_REFERENCE_THRESHOLDS_1280X720_SDR: {
  readonly MP4_H264: ParityApprovedThreshold;
  readonly MOV_PRORES_4444: ParityApprovedThreshold;
} = {
  MP4_H264: {
    thresholdProfileId: REFERENCE_PARITY_THRESHOLD_PROFILE_ID,
    scopeNote: REFERENCE_THRESHOLD_SCOPE_NOTE,
    minSsim: 0.985,
    minPsnrDb: 36,
    maxMaePerChannel: 2.0,
    maxPixelToleranceBand: 5,
    minPctWithinTolerance: 98,
  },
  MOV_PRORES_4444: {
    thresholdProfileId: REFERENCE_PARITY_THRESHOLD_PROFILE_ID,
    scopeNote: REFERENCE_THRESHOLD_SCOPE_NOTE,
    minSsim: 0.995,
    minPsnrDb: 40,
    maxMaePerChannel: 0.5,
    maxPixelToleranceBand: 2,
    minPctWithinTolerance: 99,
  },
};

export interface ParitySampleEvaluationInput {
  label?: string;
  frameIndex?: number;
  ssimAll: number;
  psnrDb: number | null;
  psnrInfinite?: boolean;
  maePerChannel: number;
  pctWithinTol2: number;
  pctWithinTol5: number;
}

export interface ParitySampleGateFailure {
  label: string;
  frameIndex: number | null;
  reasons: string[];
}

export interface ParityGateEvaluation {
  thresholdProfileId: string | null;
  status: ParityGateStatus;
  evaluatedSampleCount: number;
  failedSamples: ParitySampleGateFailure[];
  reason: string;
}

export type ParityGateStatus = "PASS" | "FAIL" | "PENDING_REVIEW";

/**
 * 4K (3840x2160 @ 30/60) benchmark runs strictly on explicit opt-in via MF_RUN_4K_BENCHMARK=1.
 */
export function isFourKBenchmarkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MF_RUN_4K_BENCHMARK === "1";
}

export function resolvePngHeader(pngBuffer: Buffer): PngHeaderInfo {
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (pngBuffer.length < 29 || !pngBuffer.subarray(0, 8).equals(pngSig)) {
    throw new Error("Invalid PNG header signature");
  }
  const chunkType = pngBuffer.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") {
    throw new Error(`Expected IHDR chunk first in PNG, found "${chunkType}"`);
  }
  return {
    width: pngBuffer.readUInt32BE(16),
    height: pngBuffer.readUInt32BE(20),
    bitDepth: pngBuffer.readUInt8(24),
    colorType: pngBuffer.readUInt8(25),
  };
}

/**
 * Builds deterministic sample points strictly from actual ffprobe-verified frame count N:
 * - first = 0
 * - middle = Math.floor(N / 2)
 * - last = N - 1
 * Using identical rational FPS timestamps for both Preview and Export.
 */
export function computeParitySamplePlan(
  actualFrameCount: number,
  fps: FpsFraction
): ParitySamplePlan {
  if (!Number.isInteger(actualFrameCount) || actualFrameCount < 1) {
    throw new Error(`Invalid actualFrameCount: ${actualFrameCount}`);
  }
  if (!fps || !Number.isFinite(fps.num) || !Number.isFinite(fps.den) || fps.num <= 0 || fps.den <= 0) {
    throw new Error(`Invalid rational FPS fraction: ${JSON.stringify(fps)}`);
  }

  const firstIdx = 0;
  const middleIdx = Math.floor(actualFrameCount / 2);
  const lastIdx = actualFrameCount - 1;

  const first: ParitySamplePoint = {
    label: "first",
    frameIndex: firstIdx,
    timeSec: frameToTimeSec(firstIdx, fps, actualFrameCount),
  };
  const middle: ParitySamplePoint = {
    label: "middle",
    frameIndex: middleIdx,
    timeSec: frameToTimeSec(middleIdx, fps, actualFrameCount),
  };
  const last: ParitySamplePoint = {
    label: "last",
    frameIndex: lastIdx,
    timeSec: frameToTimeSec(lastIdx, fps, actualFrameCount),
  };

  return {
    actualFrameCount,
    fps,
    samples: { first, middle, last },
    backwardSeekSequence: [
      { step: "middle_initial", frameIndex: middle.frameIndex, timeSec: middle.timeSec },
      { step: "first", frameIndex: first.frameIndex, timeSec: first.timeSec },
      { step: "last", frameIndex: last.frameIndex, timeSec: last.timeSec },
      { step: "middle_repeat", frameIndex: middle.frameIndex, timeSec: middle.timeSec },
    ],
  };
}

export function probeVideoDetailed(filePath: string): VideoStreamMetadata {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Video output file not found for ffprobe: "${filePath}"`);
  }
  const res = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,codec_long_name,profile,width,height,pix_fmt,color_space,color_transfer,color_primaries,color_range,r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames,duration,bit_rate",
      "-show_entries",
      "format=format_name,duration,size,bit_rate",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
  );

  if (res.status !== 0) {
    throw new Error(`ffprobe failed on "${filePath}": ${res.stderr}`);
  }
  const parsed = JSON.parse(res.stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new Error(`No video stream found in "${filePath}"`);
  }

  const nbRead = Number(stream.nb_read_frames);
  const nbContainer = stream.nb_frames !== undefined ? Number(stream.nb_frames) : null;
  const actualFrameCount = Number.isFinite(nbRead) && nbRead > 0 ? nbRead : (nbContainer ?? 0);
  const stat = fs.statSync(filePath);

  const durRaw = stream.duration ?? parsed.format?.duration;
  const durationSec = durRaw !== undefined && Number.isFinite(Number(durRaw)) ? Number(durRaw) : null;
  const bitRateRaw = stream.bit_rate ?? parsed.format?.bit_rate;
  const bitRate = bitRateRaw !== undefined && Number.isFinite(Number(bitRateRaw)) ? Number(bitRateRaw) : null;

  return {
    filePath,
    codecName: String(stream.codec_name ?? "unknown"),
    codecLongName: typeof stream.codec_long_name === "string" ? stream.codec_long_name : null,
    profile: typeof stream.profile === "string" ? stream.profile : null,
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    pixFmt: typeof stream.pix_fmt === "string" ? stream.pix_fmt : null,
    colorSpace: typeof stream.color_space === "string" ? stream.color_space : null,
    colorTransfer: typeof stream.color_transfer === "string" ? stream.color_transfer : null,
    colorPrimaries: typeof stream.color_primaries === "string" ? stream.color_primaries : null,
    colorRange: typeof stream.color_range === "string" ? stream.color_range : null,
    rFrameRate: String(stream.r_frame_rate ?? "unknown"),
    avgFrameRate: String(stream.avg_frame_rate ?? "unknown"),
    containerNbFrames: nbContainer !== null && Number.isFinite(nbContainer) ? nbContainer : null,
    actualFrameCount,
    durationSec,
    bitRate,
    fileSizeBytes: stat.size,
  };
}

export function decodeVideoFrameToPng(
  videoPath: string,
  frameIndex: number,
  outPngPath: string,
  pixFmt: "rgb24" | "rgba" = "rgb24"
): PngHeaderInfo {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new Error(`Invalid decode frameIndex: ${frameIndex}`);
  }
  fs.mkdirSync(path.dirname(outPngPath), { recursive: true });
  const res = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      videoPath,
      "-vf",
      `select=eq(n\\,${frameIndex})`,
      "-vsync",
      "vfr",
      "-frames:v",
      "1",
      "-pix_fmt",
      pixFmt,
      outPngPath,
    ],
    { encoding: "utf8" }
  );

  if (res.status !== 0 || !fs.existsSync(outPngPath)) {
    throw new Error(`FFmpeg frame decode failed at frame ${frameIndex} on "${videoPath}": ${res.stderr}`);
  }

  return resolvePngHeader(fs.readFileSync(outPngPath));
}

export function normalizePngToResolution(
  inPngPath: string,
  outPngPath: string,
  targetWidth: number,
  targetHeight: number
): ImageNormalizationRecord {
  const rawHeader = resolvePngHeader(fs.readFileSync(inPngPath));
  fs.mkdirSync(path.dirname(outPngPath), { recursive: true });

  if (rawHeader.width === targetWidth && rawHeader.height === targetHeight && rawHeader.colorType === 2) {
    if (path.resolve(inPngPath) !== path.resolve(outPngPath)) {
      fs.copyFileSync(inPngPath, outPngPath);
    }
    return {
      normalized: false,
      algorithm: "none (exact 1:1 RGB pixel match)",
      rawDimension: { width: rawHeader.width, height: rawHeader.height },
      outputDimension: { width: targetWidth, height: targetHeight },
    };
  }

  const needsScale = rawHeader.width !== targetWidth || rawHeader.height !== targetHeight;
  const vf = needsScale
    ? `scale=${targetWidth}:${targetHeight}:flags=lanczos,format=rgb24`
    : "format=rgb24";

  const res = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", inPngPath, "-vf", vf, "-frames:v", "1", "-pix_fmt", "rgb24", outPngPath],
    { encoding: "utf8" }
  );

  if (res.status !== 0 || !fs.existsSync(outPngPath)) {
    throw new Error(`Image normalization failed on "${inPngPath}": ${res.stderr}`);
  }

  const outHeader = resolvePngHeader(fs.readFileSync(outPngPath));
  return {
    normalized: true,
    algorithm: needsScale
      ? `ffmpeg -vf "scale=${targetWidth}:${targetHeight}:flags=lanczos,format=rgb24"`
      : `ffmpeg -vf "format=rgb24" (alpha/channel strip to 8-bit RGB; no spatial scaling)`,
    rawDimension: { width: rawHeader.width, height: rawHeader.height },
    outputDimension: { width: outHeader.width, height: outHeader.height },
  };
}

export function extractRawRgbBuffer(pngPath: string): {
  width: number;
  height: number;
  data: Buffer;
} {
  const header = resolvePngHeader(fs.readFileSync(pngPath));
  const res = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", pngPath, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    throw new Error(`FFmpeg raw RGB extraction failed on "${pngPath}": ${res.stderr?.toString()}`);
  }
  const expectedLen = header.width * header.height * 3;
  if (res.stdout.length !== expectedLen) {
    throw new Error(
      `Raw RGB length mismatch for "${pngPath}": expected ${expectedLen} bytes (${header.width}x${header.height}x3), got ${res.stdout.length}`
    );
  }
  return { width: header.width, height: header.height, data: res.stdout };
}

export function computeRgbFrameDifference(
  bufA: Buffer,
  bufB: Buffer,
  width: number,
  height: number
): RgbDifferenceMetrics {
  const totalPixels = width * height;
  const expectedBytes = totalPixels * 3;
  if (bufA.length !== expectedBytes || bufB.length !== expectedBytes) {
    throw new Error(
      `RGB buffer size mismatch: expected ${expectedBytes} bytes, got A=${bufA.length}, B=${bufB.length}`
    );
  }

  let sumAbs = 0;
  let sumSq = 0;
  let maxChannelDiff = 0;
  let exactZero = 0;
  let tol2 = 0;
  let tol5 = 0;
  let tol15 = 0;

  for (let i = 0; i < expectedBytes; i += 3) {
    const dr = Math.abs(bufA[i] - bufB[i]);
    const dg = Math.abs(bufA[i + 1] - bufB[i + 1]);
    const db = Math.abs(bufA[i + 2] - bufB[i + 2]);
    const chMax = Math.max(dr, dg, db);
    sumAbs += dr + dg + db;
    sumSq += dr * dr + dg * dg + db * db;
    if (chMax > maxChannelDiff) maxChannelDiff = chMax;

    if (chMax === 0) exactZero++;
    if (chMax <= 2) tol2++;
    if (chMax <= 5) tol5++;
    if (chMax <= 15) tol15++;
  }

  const denom = totalPixels * 3;
  return {
    width,
    height,
    totalPixels,
    maePerChannel: Number((sumAbs / denom).toFixed(4)),
    rmsePerChannel: Number(Math.sqrt(sumSq / denom).toFixed(4)),
    maxChannelDiff,
    pctExactZero: Number(((exactZero / totalPixels) * 100).toFixed(3)),
    pctWithinTol2: Number(((tol2 / totalPixels) * 100).toFixed(3)),
    pctWithinTol5: Number(((tol5 / totalPixels) * 100).toFixed(3)),
    pctWithinTol15: Number(((tol15 / totalPixels) * 100).toFixed(3)),
  };
}

export function computeFfmpegSsimAndPsnr(
  refPngPath: string,
  testPngPath: string
): FfmpegVisualMetrics {
  const filterGraph = "[0:v]format=rgb24[ref];[1:v]format=rgb24[tst]";
  const ssimRes = spawnSync(
    "ffmpeg",
    ["-i", testPngPath, "-i", refPngPath, "-filter_complex", `${filterGraph};[ref][tst]ssim`, "-f", "null", "-"],
    { encoding: "utf8" }
  );
  if (ssimRes.status !== 0) {
    throw new Error(`FFmpeg SSIM failed (${refPngPath} vs ${testPngPath}): ${ssimRes.stderr}`);
  }
  const ssimOutput = `${ssimRes.stderr ?? ""}\n${ssimRes.stdout ?? ""}`;
  const ssimMatch = /All:([0-9.]+)/.exec(ssimOutput);
  if (!ssimMatch) {
    throw new Error(`Unable to parse FFmpeg SSIM output: ${ssimOutput}`);
  }

  const psnrRes = spawnSync(
    "ffmpeg",
    ["-i", testPngPath, "-i", refPngPath, "-filter_complex", `${filterGraph};[ref][tst]psnr`, "-f", "null", "-"],
    { encoding: "utf8" }
  );
  if (psnrRes.status !== 0) {
    throw new Error(`FFmpeg PSNR failed (${refPngPath} vs ${testPngPath}): ${psnrRes.stderr}`);
  }
  const psnrOutput = `${psnrRes.stderr ?? ""}\n${psnrRes.stdout ?? ""}`;
  const psnrMatch = /average:(inf|[0-9.]+)/i.exec(psnrOutput);
  if (!psnrMatch) {
    throw new Error(`Unable to parse FFmpeg PSNR output: ${psnrOutput}`);
  }
  const isInf = psnrMatch[1].toLowerCase() === "inf";

  return {
    comparisonFormat: "rgb24",
    ssimAll: Number(Number(ssimMatch[1]).toFixed(6)),
    psnrDb: isInf ? null : Number(Number(psnrMatch[1]).toFixed(4)),
    psnrInfinite: isInf,
  };
}

export function computeBufferSha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function computeVideoFrameHashes(videoPath: string): FrameHashEntry[] {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found for frame hashing: "${videoPath}"`);
  }
  const res = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", videoPath, "-f", "framehash", "-hash", "sha256", "-"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    throw new Error(`FFmpeg framehash failed on "${videoPath}": ${res.stderr}`);
  }
  const entries: FrameHashEntry[] = [];
  const lines = (res.stdout || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 6) continue;
    const hash = parts[parts.length - 1];
    const byteSize = Number(parts[parts.length - 2]);
    if (/^[a-f0-9]{64}$/i.test(hash)) {
      entries.push({
        index: entries.length,
        hash: hash.toLowerCase(),
        byteSize: Number.isFinite(byteSize) ? byteSize : 0,
      });
    }
  }
  if (entries.length === 0) {
    throw new Error(`FFmpeg framehash produced 0 entries on "${videoPath}"`);
  }
  return entries;
}

export function classifyRepeatRenderDeterminism(params: {
  hashesA: FrameHashEntry[];
  hashesB: FrameHashEntry[];
  sampleVisualMetrics?: Array<{ ssimAll: number; maePerChannel: number }>;
  visualEquivalenceMinSsim?: number;
  visualEquivalenceMaxMae?: number;
}): RepeatDeterminismSummary {
  const {
    hashesA,
    hashesB,
    sampleVisualMetrics = [],
    visualEquivalenceMinSsim = 0.999,
    visualEquivalenceMaxMae = 1.0,
  } = params;

  if (hashesA.length !== hashesB.length) {
    return {
      classification: "NON_DETERMINISTIC",
      frameCountRunA: hashesA.length,
      frameCountRunB: hashesB.length,
      comparedFrames: Math.min(hashesA.length, hashesB.length),
      matchingHashFrames: 0,
      differingFrameIndices: [],
      notes: `Frame count mismatch between repeat renders (${hashesA.length} vs ${hashesB.length})`,
    };
  }

  let matchingHashFrames = 0;
  const differingFrameIndices: number[] = [];
  for (let i = 0; i < hashesA.length; i++) {
    if (hashesA[i].hash === hashesB[i].hash) {
      matchingHashFrames++;
    } else {
      differingFrameIndices.push(i);
    }
  }

  if (differingFrameIndices.length === 0) {
    return {
      classification: "BIT_IDENTICAL_FRAMES",
      frameCountRunA: hashesA.length,
      frameCountRunB: hashesB.length,
      comparedFrames: hashesA.length,
      matchingHashFrames,
      differingFrameIndices: [],
      notes: `All ${hashesA.length} decoded frames matched bit-for-bit by SHA-256`,
    };
  }

  const hasVisualCheck = sampleVisualMetrics.length > 0;
  const visuallyEquivalent =
    hasVisualCheck &&
    sampleVisualMetrics.every(
      (m) => m.ssimAll >= visualEquivalenceMinSsim && m.maePerChannel <= visualEquivalenceMaxMae
    );

  return {
    classification: visuallyEquivalent ? "VISUAL_EQUIVALENT" : "NON_DETERMINISTIC",
    frameCountRunA: hashesA.length,
    frameCountRunB: hashesB.length,
    comparedFrames: hashesA.length,
    matchingHashFrames,
    differingFrameIndices,
    notes: visuallyEquivalent
      ? `${differingFrameIndices.length}/${hashesA.length} frames had non-identical hashes, within visual equivalence threshold (SSIM>=${visualEquivalenceMinSsim}, MAE<=${visualEquivalenceMaxMae})`
      : `${differingFrameIndices.length}/${hashesA.length} frames diverged across repeat renders`,
  };
}

export function analyzeAlphaPlaneBuffer(
  alphaPlane: Buffer,
  width: number,
  height: number,
  regions: AlphaRegionSpec[]
): AlphaIntegrityReport {
  if (alphaPlane.length !== width * height) {
    throw new Error(
      `Alpha plane buffer size mismatch: expected ${width * height} bytes, got ${alphaPlane.length}`
    );
  }

  let globalMinAlpha = 255;
  let globalMaxAlpha = 0;
  for (let i = 0; i < alphaPlane.length; i++) {
    const a = alphaPlane[i];
    if (a < globalMinAlpha) globalMinAlpha = a;
    if (a > globalMaxAlpha) globalMaxAlpha = a;
  }

  const regionStats: AlphaRegionStats[] = [];
  for (const r of regions) {
    const xStart = Math.max(0, Math.min(width - 1, Math.round(r.x)));
    const yStart = Math.max(0, Math.min(height - 1, Math.round(r.y)));
    const xEnd = Math.max(xStart + 1, Math.min(width, Math.round(r.x + r.width)));
    const yEnd = Math.max(yStart + 1, Math.min(height, Math.round(r.y + r.height)));

    let minA = 255;
    let maxA = 0;
    let sumA = 0;
    let count = 0;

    for (let y = yStart; y < yEnd; y++) {
      const rowOffset = y * width;
      for (let x = xStart; x < xEnd; x++) {
        const val = alphaPlane[rowOffset + x];
        if (val < minA) minA = val;
        if (val > maxA) maxA = val;
        sumA += val;
        count++;
      }
    }

    const meanA = Number((sumA / Math.max(1, count)).toFixed(2));
    let passed = false;
    if (r.expectedKind === "transparent") {
      passed = minA === 0 && maxA === 0;
    } else if (r.expectedKind === "opaque") {
      passed = minA === 255 && maxA === 255;
    } else {
      passed = minA >= 127 && maxA <= 129;
    }

    regionStats.push({
      ...r,
      pixelCount: count,
      minAlpha: minA,
      maxAlpha: maxA,
      meanAlpha: meanA,
      passed,
    });
  }

  return {
    width,
    height,
    globalMinAlpha,
    globalMaxAlpha,
    regions: regionStats,
    passed: regionStats.every((rs) => rs.passed),
  };
}

export function extractPngAlphaPlane(rgbaPngPath: string): {
  width: number;
  height: number;
  alphaPlane: Buffer;
} {
  const header = resolvePngHeader(fs.readFileSync(rgbaPngPath));
  if (header.colorType !== 6 && header.colorType !== 4) {
    throw new Error(
      `Decoded PNG "${rgbaPngPath}" has no alpha channel (PNG colorType=${header.colorType}; expected 4 or 6)`
    );
  }
  const res = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", rgbaPngPath, "-vf", "alphaextract", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    throw new Error(`FFmpeg alphaextract failed on "${rgbaPngPath}": ${res.stderr?.toString()}`);
  }
  return {
    width: header.width,
    height: header.height,
    alphaPlane: res.stdout,
  };
}

export function evaluateParityGateDetails(
  samples: ParitySampleEvaluationInput[] | null | undefined,
  approvedThreshold?: ParityApprovedThreshold | null
): ParityGateEvaluation {
  if (!approvedThreshold || !Array.isArray(samples) || samples.length === 0) {
    return {
      thresholdProfileId: approvedThreshold?.thresholdProfileId ?? null,
      status: "PENDING_REVIEW",
      evaluatedSampleCount: Array.isArray(samples) ? samples.length : 0,
      failedSamples: [],
      reason: !approvedThreshold
        ? "No PM-approved parity threshold provided; status remains PENDING_REVIEW."
        : "Measurement samples are missing/empty; cannot decide parity gate.",
    };
  }

  for (const s of samples) {
    const tolVal = approvedThreshold.maxPixelToleranceBand === 2 ? s.pctWithinTol2 : s.pctWithinTol5;
    const hasPsnr = s.psnrInfinite === true || (typeof s.psnrDb === "number" && Number.isFinite(s.psnrDb));
    if (
      !Number.isFinite(s.ssimAll) ||
      !hasPsnr ||
      !Number.isFinite(s.maePerChannel) ||
      !Number.isFinite(tolVal)
    ) {
      return {
        thresholdProfileId: approvedThreshold.thresholdProfileId,
        status: "PENDING_REVIEW",
        evaluatedSampleCount: samples.length,
        failedSamples: [],
        reason: "Incomplete or non-finite measurement input; parity gate cannot be determined.",
      };
    }
  }

  const failedSamples: ParitySampleGateFailure[] = [];
  for (const s of samples) {
    const reasons: string[] = [];
    if (s.ssimAll < approvedThreshold.minSsim) {
      reasons.push(`SSIM ${s.ssimAll} < ${approvedThreshold.minSsim}`);
    }
    if (!s.psnrInfinite && (s.psnrDb === null || s.psnrDb < approvedThreshold.minPsnrDb)) {
      reasons.push(`PSNR ${s.psnrDb} dB < ${approvedThreshold.minPsnrDb} dB`);
    }
    if (s.maePerChannel > approvedThreshold.maxMaePerChannel) {
      reasons.push(`MAE ${s.maePerChannel} > ${approvedThreshold.maxMaePerChannel}`);
    }
    const tolVal = approvedThreshold.maxPixelToleranceBand === 2 ? s.pctWithinTol2 : s.pctWithinTol5;
    if (tolVal < approvedThreshold.minPctWithinTolerance) {
      reasons.push(
        `pctWithinTol${approvedThreshold.maxPixelToleranceBand} ${tolVal}% < ${approvedThreshold.minPctWithinTolerance}%`
      );
    }
    if (reasons.length > 0) {
      failedSamples.push({
        label: s.label ?? "sample",
        frameIndex: typeof s.frameIndex === "number" ? s.frameIndex : null,
        reasons,
      });
    }
  }

  const passed = failedSamples.length === 0;
  return {
    thresholdProfileId: approvedThreshold.thresholdProfileId,
    status: passed ? "PASS" : "FAIL",
    evaluatedSampleCount: samples.length,
    failedSamples,
    reason: passed
      ? `All ${samples.length} sample frames satisfied every threshold criterion under ${approvedThreshold.thresholdProfileId}.`
      : `${failedSamples.length}/${samples.length} sample frame(s) failed threshold criteria under ${approvedThreshold.thresholdProfileId}.`,
  };
}

export function evaluateParityGateStatus(
  samples: ParitySampleEvaluationInput[] | null | undefined,
  approvedThreshold?: ParityApprovedThreshold | null
): ParityGateStatus {
  return evaluateParityGateDetails(samples, approvedThreshold).status;
}
