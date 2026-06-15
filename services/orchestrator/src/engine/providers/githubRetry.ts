// GitHub HTTP retry/backoff classification — the rate-limit + transient-5xx
// (GitHub-5xx resilience) helpers, extracted from github.ts so the client stays under
// its line cap and the classification lives in ONE focused, testable place. Pure
// functions + constants only; no I/O.

/** rate-limit backoff bounds: never wait less than this, never more. */
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
 * Default backoff for a SECONDARY (abuse) rate limit that carries NO machine-readable
 * timing header (`Retry-After`/`X-RateLimit-Reset`) — only a body message. GitHub asks
 * to "wait a few minutes"; we back off the clamp ceiling so the heavy-volume hot-loop
 * that PROVOKED the secondary limit actually pauses long enough to clear (a 1s default
 * would just re-provoke it). Bounded by `MAX_RATE_LIMIT_BACKOFF_MS`.
 */
const SECONDARY_RATE_LIMIT_DEFAULT_BACKOFF_MS = MAX_RATE_LIMIT_BACKOFF_MS;

/**
 * Detect GitHub's SECONDARY / abuse rate-limit body language. A secondary limit (the
 * live apex-v35 403 on the `main` ref read under sustained heavy volume) returns a 403
 * whose body reads "You have exceeded a secondary rate limit…" (or links to the abuse
 * docs) and frequently OMITS `X-RateLimit-Remaining: 0` — so the primary-limit header
 * path misses it. Match the body so this 403 is classified rate-limited (back off +
 * retry) rather than surfacing as a raw `HTTP 403` the engine hot-loops on.
 */
export function isSecondaryRateLimitBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  const message = (body as { message?: unknown; documentation_url?: unknown }).message;
  const docUrl = (body as { documentation_url?: unknown }).documentation_url;
  const haystack = `${typeof message === "string" ? message : ""} ${typeof docUrl === "string" ? docUrl : ""}`;
  return /secondary rate limit|abuse[- ]detection|abuse-rate-limits/iu.test(haystack);
}

/**
 * compute how long to wait before retrying a rate-limited GitHub
 * response, or `undefined` if the response is not rate-limited. Classification, in order:
 *   1. `Retry-After` (delta seconds) on a 403/429 — primary OR secondary limit;
 *   2. a 403/429 with `X-RateLimit-Remaining: 0` + `X-RateLimit-Reset` (epoch seconds)
 *      — an exhausted PRIMARY window;
 *   3. a 403/429 whose BODY matches secondary/abuse rate-limit language but carries
 *      NEITHER header — back off the secondary default (the apex-v35 hot-loop case).
 * The wait is clamped to [MIN, MAX] so a bogus header can't stall the worker indefinitely.
 */
export function rateLimitBackoffMs(
  status: number,
  getHeader: HeaderGetter,
  nowMs: number,
  body?: unknown,
): number | undefined {
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
  // Secondary/abuse limit with no timing header — back off the bounded default.
  if (isSecondaryRateLimitBody(body)) {
    return SECONDARY_RATE_LIMIT_DEFAULT_BACKOFF_MS;
  }
  return undefined;
}

function clampBackoff(ms: number): number {
  return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(MIN_RATE_LIMIT_BACKOFF_MS, Math.ceil(ms)));
}

/**
 * Lift a human-readable `message` from a GitHub error body (or `undefined`). Used to
 * enrich a thrown `HTTP <status>` so a 403 carries its actual cause (e.g. the secondary
 * rate-limit text, a permission message) rather than flattening to a bare status — the
 * apex-v35 diagnosis showed a raw `HTTP 403` is undiagnosable after the fact.
 */
export function githubErrorBodyMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && message.trim() !== "" ? message : undefined;
}

/**
 * Compose the enriched error detail for a non-2xx GitHub response: the body `message`
 * plus the rate-limit headers most useful for diagnosis (`retry-after`,
 * `x-ratelimit-remaining`, `x-ratelimit-reset`) + a `secondary-rate-limit` classification
 * tag. Keeps the raw response visible so a future 403 is diagnosable from the thrown
 * message alone (no flattening to a bare status). Empty when nothing is liftable.
 */
export function buildErrorDetail(status: number, body: unknown, getHeader: HeaderGetter): string {
  const parts: string[] = [];
  const message = githubErrorBodyMessage(body);
  if (message !== undefined) {
    parts.push(`message: ${message}`);
  }
  for (const header of ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"] as const) {
    const value = getHeader(header);
    if (value !== null && value.trim() !== "") {
      parts.push(`${header}: ${value}`);
    }
  }
  if ((status === 403 || status === 429) && isSecondaryRateLimitBody(body)) {
    parts.push("classified: secondary-rate-limit");
  }
  return parts.join(", ");
}

/** Append a `(detail)` suffix to a base error message, or return it unchanged if empty. */
export function appendErrorDetail(base: string, detail: string | undefined): string {
  return detail === undefined || detail === "" ? base : `${base} (${detail})`;
}
