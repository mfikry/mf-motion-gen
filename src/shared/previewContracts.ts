import type { PreflightResult, RenderFormat, RenderQuality } from "./renderContracts.js";

export const PREVIEW_SCHEME = "mf-asset" as const;

export const IPC_CHANNELS = {
  openCompositionDialog: "studio:openCompositionDialog",
  loadPastedHtml: "studio:loadPastedHtml",
  closeSession: "studio:closeSession",
  previewSeek: "studio:previewSeek",
  previewSetBounds: "studio:previewSetBounds",
  previewGetTimelineInfo: "studio:previewGetTimelineInfo",
  startSessionRender: "studio:startSessionRender",
  cancelSessionRender: "studio:cancelSessionRender",
  eventPreviewStatus: "studio:eventPreviewStatus",
  eventSecurityViolation: "studio:eventSecurityViolation",
  eventRenderProgress: "studio:eventRenderProgress",
  eventRenderComplete: "studio:eventRenderComplete",
} as const;

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewSessionInfo {
  sessionId: string;
  origin: string;
  entryUrl: string;
  entryFile: string;
  title: string;
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  preflight: PreflightResult;
}

export interface PreviewTimelineState {
  ready: boolean;
  hasTimeline: boolean;
  durationSec: number;
  currentTimeSec: number;
  seekSupported: boolean;
  warning?: string;
}

export interface SecurityViolationEvent {
  sessionId: string;
  source: "webRequest" | "protocol" | "navigation" | "popup";
  url: string;
  resourceType?: string;
  reason: string;
  timestampMs: number;
}

export interface SessionRenderRequestPayload {
  sessionId: string;
  format: RenderFormat;
  quality: RenderQuality;
  workers?: number;
}

export interface LoadPastedHtmlPayload {
  html: string;
  title?: string;
}

export interface PreviewSeekPayload {
  sessionId: string;
  timeSec: number;
}

export interface SessionIdPayload {
  sessionId: string;
}
