/**
 * Port of reference/raft-daemon/src/runtimeErrorDiagnostics.ts — the parts the
 * outbox needs: text scrubbing, error classification, and the 16-hex
 * fingerprint that lets a consumer dedupe failures by cause rather than text.
 *
 * Fingerprint algorithm is identical to the daemon's so fingerprints are
 * comparable across implementations.
 */
import { createHash } from "node:crypto";

export const MAX_RUNTIME_ERROR_MESSAGE_EXCERPT_CHARS = 4096;
export const MAX_VISIBLE_CRASH_DETAIL_CHARS = 512;

export type RuntimeErrorClass =
  | "InputTooLargeError"
  | "RateLimitError"
  | "AuthError"
  | "LauncherError"
  | "NotFoundError"
  | "ModelConfigError"
  | "TimeoutError"
  | "ProviderConnectionError"
  | "ProviderStreamError"
  | "ProviderServerError"
  | "ProviderApiError"
  | "OperationAbortedError"
  | "BillingError"
  | "RuntimeError";

export type RuntimeErrorReason =
  | "input_too_large"
  | "rate_limited"
  | "auth_failed"
  | "launcher_error"
  | "not_found"
  | "model_config_error"
  | "provider_timeout"
  | "provider_connection_error"
  | "provider_stream_error"
  | "provider_server_error"
  | "provider_api_error"
  | "operation_aborted"
  | "billing_exhausted"
  | "unclassified_runtime_error";

export type RuntimeErrorAction = "none" | "relogin" | "top_up" | "change_model";

const RUNTIME_AUTH_ACTION_REQUIRED_PATTERNS: RegExp[] = [
  /access token could not be refreshed/i,
  /\btoken_(?:revoked|invalidated)\b/i,
  /refresh token was already used/i,
  /access token.*invalidated/i,
  /authentication token has been invalidated/i,
  /logged out or signed in to another account/i,
  /not logged in/i,
  /not signed in/i,
  /login required/i,
  /log in first/i,
  /please log in/i,
  /authentication failed/i,
  /auth(?:entication)? failed/i,
  /authentication timed out/i,
  /missing (?:api )?token/i,
  /no (?:api )?token/i,
  /missing credentials/i,
  /credentials? not found/i,
  /invalid api key/i,
  /api key (?:is )?not set/i,
];

const RUNTIME_BILLING_EXHAUSTED_PATTERNS: RegExp[] = [
  /\bpayment required\b/i,
  /\b(?:usage|credit|account)\s+balance\b[^.]*\b(?:exhausted|depleted|insufficient|too low)\b/i,
  /\binsufficient\s+(?:balance|credits?|funds)\b/i,
  /\b(?:out of|run out of|no remaining)\s+credits?\b/i,
];

const RUNTIME_PLAN_ACCESS_PATTERNS: RegExp[] = [
  /\b(?:subscription|plan|tier)\b[^.\n]{0,80}\b(?:does not|doesn't|do not|don't|not)\b[^.\n]{0,40}\b(?:include|allow|support|grant)\b[^.\n]{0,40}\b(?:access|model)\b/i,
  /\b(?:model|access)\b[^.\n]{0,80}\b(?:not|isn't|is not)\b[^.\n]{0,20}\b(?:included|available|enabled|allowed)\b[^.\n]{0,40}\b(?:subscription|plan|tier)\b/i,
];

const RUNTIME_TRANSIENT_LIMIT_MARKERS: RegExp[] = [
  /\brate.?limit/i,
  /\btoo many requests\b/i,
  /\bconcurrenc(?:y|ies)\b/i,
  /\bretry(?:ing)?\b/i,
  /\btry again\b/i,
  /\blater\b/i,
  /\bresets?\b/i,
  /\bper (?:second|minute|hour|day)\b/i,
  /\b[RT]PM\b/,
  /\bat the moment\b/i,
  /\bright now\b/i,
  /\bat capacity\b/i,
];

const SECRET_ASSIGNMENT_KEY_PATTERN = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s;,]+)/gi;
const GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN = /\b(?:password|passwd|secret|token)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s;,]+)/gi;
const GITHUB_TOKEN_FAMILY_PATTERN = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}\b/g;

function redactUrlQuery(value: string): string {
  try {
    const url = new URL(value);
    if (url.search) url.search = "?[REDACTED_QUERY]";
    if (url.username) url.username = "[REDACTED_USER]";
    if (url.password) url.password = "[REDACTED_PASSWORD]";
    return url.toString();
  } catch {
    return value.replace(/\?.*$/, "?[REDACTED_QUERY]");
  }
}

/** Redact secrets/paths/emails from runtime text before it is persisted or fingerprinted. */
export function scrubRuntimeErrorDiagnosticText(value: string): string {
  let scrubbed = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/\b(?:sk|sk-ant|sk-proj|xox[baprs]?)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(GITHUB_TOKEN_FAMILY_PATTERN, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrlQuery(url))
    .replace(/\/Users\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g, "[REDACTED_PATH]")
    .replace(/\/home\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g, "[REDACTED_PATH]")
    .replace(/[A-Za-z]:\\Users\\[^\s"'<>:]+(?:\\[^\s"'<>:]+)*/g, "[REDACTED_PATH]");
  scrubbed = scrubbed.replace(SECRET_ASSIGNMENT_KEY_PATTERN, (_m, key: string) => {
    return `${String(key).trim()}=[REDACTED_TOKEN]`;
  });
  scrubbed = scrubbed.replace(GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN, (_m, prefix: string) => {
    return `${prefix}[REDACTED_TOKEN]`;
  });
  return scrubbed;
}

/** Same normalization + sha256[..16] as the daemon: comparable fingerprints. */
export function fingerprintRuntimeError(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[0-9a-f]{12,}/g, "<hex>")
    .replace(/\b\d+\b/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function extractHttpStatus(message: string): number | null {
  const match =
    /\b(?:HTTP|status(?:\s+code)?|API\s+Error)[:\s]+([45]\d{2})\b/i.exec(message) ??
    /\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Internal Server Error|Service Unavailable)\b/i.exec(message) ??
    /\b([45]\d{2})\s*:/i.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

export function isRuntimeBillingErrorText(message: string): boolean {
  return RUNTIME_BILLING_EXHAUSTED_PATTERNS.some((p) => p.test(message));
}

export function isRuntimeAuthErrorText(message: string): boolean {
  return RUNTIME_AUTH_ACTION_REQUIRED_PATTERNS.some((p) => p.test(message));
}

export function isRuntimePlanAccessErrorText(message: string): boolean {
  const hasPlanAccess = RUNTIME_PLAN_ACCESS_PATTERNS.some((p) => p.test(message));
  if (!hasPlanAccess) return false;
  return !RUNTIME_TRANSIENT_LIMIT_MARKERS.some((p) => p.test(message));
}

export function isRuntimeInputTooLargeErrorText(message: string): boolean {
  return /input.*too large|context.*too long|context_length_exceeded|maximum context|too many tokens|InputTooLargeError/i.test(
    message,
  );
}

export function classifyRuntimeError(message: string, httpStatus: number | null): RuntimeErrorClass {
  if (isRuntimeInputTooLargeErrorText(message)) return "InputTooLargeError";
  if (isRuntimeBillingErrorText(message)) return "BillingError";
  if (isRuntimePlanAccessErrorText(message)) return "ModelConfigError";
  if (isRuntimeAuthErrorText(message)) return "AuthError";
  if (httpStatus === 401 || httpStatus === 403) return "AuthError";
  if (httpStatus === 404) return "NotFoundError";
  if (httpStatus === 429) return "RateLimitError";
  if (httpStatus !== null && httpStatus >= 500) return "ProviderServerError";
  if (/\babort(?:ed)?\b/i.test(message)) return "OperationAbortedError";
  if (/\btimed?\s*out\b|\btimeout\b|\betimedout\b/i.test(message)) return "TimeoutError";
  if (/\b(?:econnrefused|econnreset|enotfound|eai_again|socket hang up|network error|fetch failed)\b/i.test(message))
    return "ProviderConnectionError";
  if (/\bstream\b[^.]*\b(?:error|failed|reset|closed|broken)\b/i.test(message)) return "ProviderStreamError";
  if (/\bmodel\b[^.]*\b(?:not found|unknown|does not exist|unsupported|invalid)\b/i.test(message))
    return "ModelConfigError";
  if (/\bnot found\b/i.test(message)) return "NotFoundError";
  return "RuntimeError";
}

export function runtimeErrorReasonForClass(errorClass: RuntimeErrorClass): RuntimeErrorReason {
  switch (errorClass) {
    case "InputTooLargeError":
      return "input_too_large";
    case "RateLimitError":
      return "rate_limited";
    case "AuthError":
      return "auth_failed";
    case "LauncherError":
      return "launcher_error";
    case "NotFoundError":
      return "not_found";
    case "ModelConfigError":
      return "model_config_error";
    case "TimeoutError":
      return "provider_timeout";
    case "ProviderConnectionError":
      return "provider_connection_error";
    case "ProviderStreamError":
      return "provider_stream_error";
    case "ProviderServerError":
      return "provider_server_error";
    case "ProviderApiError":
      return "provider_api_error";
    case "OperationAbortedError":
      return "operation_aborted";
    case "BillingError":
      return "billing_exhausted";
    default:
      return "unclassified_runtime_error";
  }
}

/** Whether the failure needs a human action (not a retry) before work can continue. */
export function runtimeErrorActionForClass(errorClass: RuntimeErrorClass): RuntimeErrorAction {
  switch (errorClass) {
    case "AuthError":
      return "relogin";
    case "BillingError":
      return "top_up";
    case "ModelConfigError":
      return "change_model";
    default:
      return "none";
  }
}

export interface RuntimeErrorDiagnostic {
  errorClass: RuntimeErrorClass;
  errorReason: RuntimeErrorReason;
  errorAction: RuntimeErrorAction;
  /** 16-hex, computed on the scrubbed text. */
  fingerprint: string;
  /** Scrubbed excerpt, bounded for user-visible surfaces. */
  excerpt: string;
}

export function buildRuntimeErrorDiagnostic(rawMessage: string): RuntimeErrorDiagnostic {
  const raw = String(rawMessage ?? "");
  const scrubbed = scrubRuntimeErrorDiagnosticText(raw);
  const httpStatus = extractHttpStatus(raw);
  const errorClass = classifyRuntimeError(raw, httpStatus);
  return {
    errorClass,
    errorReason: runtimeErrorReasonForClass(errorClass),
    errorAction: runtimeErrorActionForClass(errorClass),
    fingerprint: fingerprintRuntimeError(scrubbed),
    excerpt:
      scrubbed.length <= MAX_RUNTIME_ERROR_MESSAGE_EXCERPT_CHARS
        ? scrubbed
        : scrubbed.slice(0, MAX_RUNTIME_ERROR_MESSAGE_EXCERPT_CHARS),
  };
}

export function buildBoundedVisibleCrashDetail(raw: string): string {
  const scrubbed = scrubRuntimeErrorDiagnosticText(raw);
  return scrubbed.length <= MAX_VISIBLE_CRASH_DETAIL_CHARS ? scrubbed : scrubbed.slice(0, MAX_VISIBLE_CRASH_DETAIL_CHARS);
}
