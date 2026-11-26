import os from "node:os";
import path from "node:path";

export const MAX_SANITIZED_LOG_STRING_CHARS = 4000;

const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; replacer: string | ((...args: string[]) => string) }> = [
  // Authorization / Bearer headers
  { re: /(Authorization\s*:\s*Bearer\s+)[^\s"',;]+/gi, replacer: "$1[REDACTED_TOKEN]" },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, replacer: "Bearer [REDACTED_TOKEN]" },
  // URL embedded credentials https://user:pass@host
  { re: /(https?:\/\/)[^:\s/@]+:[^@\s/@]+@/gi, replacer: "$1[REDACTED_CREDENTIALS]@" },
  // Key-value secrets / tokens / passwords / API keys
  {
    re: /\b([A-Za-z0-9_]*(?:API_KEY|APIKEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SECRET_KEY|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|PASSWD|CREDENTIALS?|TOKEN|SECRET))\b(\s*[:=]\s*["']?)([^\s"',;}\]]+)/gi,
    replacer: (_m: string, k: string, sep: string) => `${k}${sep}[REDACTED]`,
  },
  // JSON-quoted credential fields
  {
    re: /("(?:apiKey|api_key|token|accessToken|refreshToken|secret|clientSecret|password|authorization|cookie|set-cookie)"\s*:\s*)"([^"]+)"/gi,
    replacer: '$1"[REDACTED]"',
  },
  // Known token prefixes (GitHub, OpenAI, Google API keys, JWTs)
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g, replacer: "[REDACTED_GH_TOKEN]" },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacer: "[REDACTED_API_KEY]" },
  { re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replacer: "[REDACTED_GOOGLE_KEY]" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacer: "[REDACTED_JWT]" },
];

function sanitizeAbsolutePaths(text: string): string {
  const home = os.homedir();
  const tmp = os.tmpdir();
  let out = text;

  if (home) {
    const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escapedHome, "gi"), "<USER_HOME>");
  }
  if (tmp) {
    const escapedTmp = tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escapedTmp, "gi"), "<TEMP_DIR>");
  }

  // Mask remaining Windows drive paths (preserving final filename/folder context for debugging)
  out = out.replace(/\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n\s"',]+\\)*([^\\/:*?"<>|\r\n\s"',]+)/g, (_m, leaf: string) => {
    return `<LOCAL_PATH>\\${leaf}`;
  });
  out = out.replace(/\b[A-Za-z]:\/(?:[^/:*?"<>|\r\n\s"',]+\/)*([^/:*?"<>|\r\n\s"',]+)/g, (_m, leaf: string) => {
    return `<LOCAL_PATH>/${leaf}`;
  });
  // Mask UNC paths \\server\share\...
  out = out.replace(/\\\\[A-Za-z0-9._-]+\\[^\s"',;}\]]+/g, (match) => {
    const base = path.win32.basename(match);
    return base ? `<UNC_PATH>\\${base}` : "<UNC_PATH>";
  });
  // Mask POSIX home/var/etc paths while preserving final leaf segment
  out = out.replace(/(?:\/Users\/|\/home\/|\/var\/|\/private\/|\/etc\/)(?:[^\s"',;}\]/]+\/)*([^\s"',;}\]/]+)/g, (_m, leaf: string) => {
    return `<LOCAL_PATH>/${leaf}`;
  });

  return out;
}

/**
 * Redacts credentials, tokens, Authorization headers, environment secrets, and sensitive
 * local OS directory prefixes while preserving actionable diagnostic error details and file leaf names.
 */
export function sanitizeLogString(raw: string, maxLength = MAX_SANITIZED_LOG_STRING_CHARS): string {
  if (!raw) return "";
  let out = String(raw);
  for (const rule of SECRET_PATTERNS) {
    out = out.replace(rule.re, rule.replacer as never);
  }
  out = sanitizeAbsolutePaths(out);
  if (out.length > maxLength) {
    out = `...${out.slice(out.length - (maxLength - 3))}`;
  }
  return out;
}

const SENSITIVE_KEY_RE =
  /(?:token|secret|password|passwd|credential|authorization|cookie|apikey|api_key|privateKey)/i;

export function sanitizeLogValue(val: unknown, depth = 0): unknown {
  if (val === null || val === undefined) return val;
  if (depth > 5) return "[TRUNCATED_DEPTH]";
  if (typeof val === "string") return sanitizeLogString(val);
  if (typeof val === "number" || typeof val === "boolean") return val;
  if (Array.isArray(val)) {
    return val.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (typeof val === "object") {
    const rec: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        rec[k] = "[REDACTED]";
      } else {
        rec[k] = sanitizeLogValue(v, depth + 1);
      }
    }
    return rec;
  }
  return String(val);
}

export function sanitizeExportFileToken(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "render_job";
}
