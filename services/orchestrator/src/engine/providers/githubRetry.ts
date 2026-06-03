// GitHub HTTP retry/backoff classification — the rate-limit (P3-0028) + transient-5xx
// (GitHub-5xx resilience) helpers, extracted from github.ts so the client stays under
// its line cap and the classification lives in ONE focused, testable place. Pure
// functions + constants only; no I/O.

/** P3-0028 rate-limit backoff bounds: never wait less than this, never more. */
export const MIN_RATE_LIMIT_BACKOFF_MS = 1_000;
export const MAX_RATE_LIMIT_BACKOFF_MS = 60_000;
/** Default number of times the client re-tries a rate-limited request before surfacing it. */
export const DEFAULT_RATE_LIMIT_RETRIES = 2;

/**
 * GitHub-5xx resilience: the SAFE transient HTTP-status set. A GitHub slow window
 * returns these on an otherwise-fine request and they self-heal on an immediate
 * retry. Deliberately CONSERVATIVE — only the gateway/upstream-timeout codes:
 *   - 502 Bad Gateway / 503 Service Unavailable / 504 Gateway Timeout (the live
 *     repro: a 504 on a `/git/refs` force-update),
 *   - 408 Request Timeout.
 * A plain 500 is NOT included (it is too often a real, non-self-healing error);
 * 4xx client errors are NEVER retried (a 401/403/429 have their OWN dedicated
 * paths). Shared by the HTTP client, the ref-reset classifier, and tests.
 */
export function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || status === 408;
}

/** Default number of transient-5xx/network retries before the raw failure surfaces. */
export const DEFAULT_TRANSIENT_RETRIES = 3;
/** Exponential backoff (ms) between transient retries: 500ms → 1s → 2s. */
export const TRANSIENT_BACKOFF_MS = [500, 1_000, 2_000];

export type HeaderGetter = (name: string) => string | null;

export function headerGetter(headers: Headers | undefined): HeaderGetter {
  return (name) => (headers === undefined ? null : headers.get(name));
}

/**
 * P3-0028: compute how long to wait before retrying a rate-limited GitHub
 * response, or `undefined` if the response is not rate-limited. Honors
 * `Retry-After` (delta seconds) first, then a `403/429` with
 * `X-RateLimit-Remaining: 0` + `X-RateLimit-Reset` (epoch seconds). The wait is
 * clamped to [MIN, MAX] so a bogus header can't stall the worker indefinitely.
 */
export function rateLimitBackoffMs(status: number, getHeader: HeaderGetter, nowMs: number): number | undefined {
  if (status !== 403 && status !== 429) {
    return undefined;
  }
  const retryAfter = getHeader("retry-after");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return clampBackoff(seconds * 1_000);
    }
  }
  const remaining = getHeader("x-ratelimit-remaining");
  const reset = getHeader("x-ratelimit-reset");
  if (remaining === "0" && reset !== null && reset.trim() !== "") {
    const resetEpoch = Number(reset);
    if (Number.isFinite(resetEpoch)) {
      return clampBackoff(resetEpoch * 1_000 - nowMs);
    }
  }
  return undefined;
}

function clampBackoff(ms: number): number {
  return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(MIN_RATE_LIMIT_BACKOFF_MS, Math.ceil(ms)));
}
