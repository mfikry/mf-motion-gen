import type { SecurityViolationEvent } from "../../shared/previewContracts.js";

export type NetworkPolicyViolationHandler = (violation: SecurityViolationEvent) => void;

export interface NetworkEvaluationResult {
  allow: boolean;
  reason: string;
}

/**
 * Pure request policy evaluator shared between Electron session.webRequest.onBeforeRequest
 * and automated unit/security verification suites.
 */
export function evaluateNetworkRequestPolicy(
  rawUrl: string,
  resourceType: string,
  activeSessionId: string,
  allowedEntryPath: string
): NetworkEvaluationResult {
  try {
    const parsed = new URL(rawUrl);
    const isValidCustomSession =
      parsed.protocol === "mf-asset:" &&
      parsed.hostname === activeSessionId &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "";

    if (resourceType === "mainFrame") {
      const isExactEntry =
        isValidCustomSession &&
        parsed.pathname === allowedEntryPath &&
        parsed.search === "";
      if (isExactEntry) {
        return { allow: true, reason: "allowed_entry_mainFrame" };
      }
      return { allow: false, reason: "blocked_non_entry_mainFrame" };
    }

    if (resourceType === "subFrame") {
      return { allow: false, reason: "blocked_subFrame" };
    }

    if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
      return { allow: true, reason: "allowed_inline_data_or_blob" };
    }

    if (isValidCustomSession) {
      return { allow: true, reason: "allowed_session_subresource" };
    }

    return {
      allow: false,
      reason: `blocked_external_or_forbidden_scheme:${parsed.protocol}`,
    };
  } catch {
    return { allow: false, reason: "blocked_malformed_url" };
  }
}

/**
 * Registers the single authoritative webRequest.onBeforeRequest listener on the
 * dedicated ephemeral preview session. Blocks http/https/ws/wss/file/ftp and cross-session
 * mf-asset:// access—including requests initiated dynamically from JavaScript.
 */
export function registerCentralizedNetworkPolicy(
  previewSession: Electron.Session,
  activeSessionId: string,
  allowedEntryPath: string,
  onViolation?: NetworkPolicyViolationHandler
): void {
  previewSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>", "ws://*/*", "wss://*/*", "file://*/*", "ftp://*/*"] },
    (details, callback) => {
      const verdict = evaluateNetworkRequestPolicy(
        details.url,
        details.resourceType,
        activeSessionId,
        allowedEntryPath
      );
      if (verdict.allow) {
        callback({ cancel: false });
        return;
      }

      onViolation?.({
        sessionId: activeSessionId,
        source: "webRequest",
        url: details.url,
        resourceType: details.resourceType,
        reason: verdict.reason,
        timestampMs: Date.now(),
      });
      callback({ cancel: true });
    }
  );
}
