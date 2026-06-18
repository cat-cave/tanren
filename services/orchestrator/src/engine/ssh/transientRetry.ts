// Transient-network retry for SSH connects (the host-key discovery + allocate path).
//
// THE BUG (apex v35, live): a template-build's `deploy` spec failed its base-shift
// rebase with `static runner host key discovery failed: read ECONNRESET`. The static
// runner regenerates host keys per restart, so the orchestrator opens a raw SSH
// connection to DISCOVER the host-key fingerprint on every allocate (TOFU). A momentary
// network blip — an `ECONNRESET` mid-handshake while the runner is briefly unavailable —
// failed it OUTRIGHT (no retry), which failed the whole allocate → failed the base-shift
// rebase → (with no spacing on the percolation re-drive) burned the consecutive-same-
// failure cap and FALSELY escalated the spec to `persistent_failure`.
//
// BINDING principle: a RANDOM/TRANSIENT failure (esp. infra/network) must NEVER be
// tolerated as terminal. This helper treats the transient network errno set as RETRIABLE
// and re-drives the connect with short exponential backoff before surfacing. A genuine
// non-transient failure (auth, a bad/unparseable fingerprint) is NEVER retried — it
// fails loud immediately. Exhausting the retries also fails loud, carrying the real
// underlying cause (no silent fallback).

/**
 * The transient network errno set: a momentary connection blip that self-heals on an
 * immediate retry. Deliberately CONSERVATIVE — only connection-level resets, refusals,
 * timeouts, and unreachable-route blips, never an application or auth error:
 *   - ECONNRESET   — the peer reset the connection (the live repro: "read ECONNRESET");
 *   - ECONNREFUSED — the runner was momentarily not listening (mid-restart);
 *   - ETIMEDOUT    — the connect/handshake timed out at the socket layer;
 *   - EPIPE        — the socket closed under a pending write;
 *   - EHOSTUNREACH — a transient unreachable-route blip to the runner host;
 *   - ENETUNREACH  — a transient unreachable-network blip.
 * Matched by errno code OR by the substring in the error message (ssh2 surfaces the
 * socket error as e.g. "read ECONNRESET" in the message, not always a `.code`).
 */
const TRANSIENT_NETWORK_CODES: readonly string[] = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
];

// The CONNECT-ESTABLISHMENT transport-failure wording that is ALSO a transient blip but
// carries no errno code/substring: the ssh2 substrate surfaces a handshake that never
// came up as `ssh_failed` with "SSH connection failed to establish within <N>ms" (the
// connect-establishment timeout firing while the runner is momentarily saturated — it
// recovers seconds later; apex v37). The `ssh_failed` failure-kind keyword (serialized
// into the answerer error as `failure={"kind":"ssh_failed",...}`) and the generic
// connection reset/refused/closed wording are likewise transport-establishment blips.
// CONSERVATIVE by construction: this matches transport-ESTABLISHMENT failures only — it
// deliberately does NOT match a host-key fingerprint mismatch (a real security/config
// failure that never self-heals), which is handled as non-transient below.
const TRANSIENT_TRANSPORT_PATTERN =
  /ssh_failed|ssh connection failed to establish|connection (?:reset|refused|closed)|socket hang up|connection lost before handshake/u;

// A host-key fingerprint MISMATCH / verification failure is a GENUINE, non-self-healing
// failure (a real config or security problem) even though it surfaces as an `ssh_failed`. It
// must NEVER be retried as a transient blip — recognized by the specific FAILURE phrasing so
// it short-circuits the transport-blip match. (Deliberately NOT a bare "host key" substring:
// the benign TOFU "host key discovery" path also contains it and IS a transient connect.)
const NON_TRANSIENT_SSH_PATTERN = /host key fingerprint mismatch|host key verification failed/u;

/**
 * True iff `error` is a transient network/transport blip that should be retried — a
 * connection-level reset/refusal/timeout/unreachable errno, OR a transport-ESTABLISHMENT
 * failure (an `ssh_failed` whose connect handshake never came up: "SSH connection failed to
 * establish …", a reset/refused/closed connection). A host-key fingerprint mismatch is
 * explicitly EXCLUDED — it is a genuine config/security failure that never self-heals.
 */
export function isTransientSshConnectError(error: unknown): boolean {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined;
  if (code !== undefined && TRANSIENT_NETWORK_CODES.includes(code)) {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // A host-key mismatch is NOT a transient blip even though it rides an `ssh_failed`.
  if (NON_TRANSIENT_SSH_PATTERN.test(message)) {
    return false;
  }
  if (TRANSIENT_NETWORK_CODES.some((c) => message.includes(c.toLowerCase()))) {
    return true;
  }
  return TRANSIENT_TRANSPORT_PATTERN.test(message);
}

/**
 * Bounded exponential backoff for a transient SSH connect retry: ~250ms → 500ms → 1s → 2s.
 * Indexed by `attempt - 1` (1-based), clamped to the final element. A genuine outage hits
 * the attempt ceiling and surfaces loud — it never hot-loops and never gives up silently.
 */
export const SSH_TRANSIENT_BACKOFF_MS: readonly number[] = [250, 500, 1_000, 2_000];

/** Default number of transient-retry ATTEMPTS (the first try + retries) before surfacing. */
export const DEFAULT_SSH_TRANSIENT_ATTEMPTS = 4;

function backoffForAttempt(attempt: number): number {
  const index = Math.min(Math.max(attempt - 1, 0), SSH_TRANSIENT_BACKOFF_MS.length - 1);
  return SSH_TRANSIENT_BACKOFF_MS.at(index) ?? SSH_TRANSIENT_BACKOFF_MS.at(-1) ?? 2_000;
}

export interface SshTransientRetryOptions {
  /** Total attempts (first try + retries). Defaults to {@link DEFAULT_SSH_TRANSIENT_ATTEMPTS}. */
  attempts?: number;
  /** Override the sleep (tests inject a no-wait sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Observe each retry decision (tests assert the retry happened; prod can log). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Run `operation`, retrying ONLY transient network errors (see {@link isTransientSshConnectError})
 * with bounded exponential backoff. A non-transient error (auth, bad fingerprint, an
 * application failure) is re-thrown IMMEDIATELY — never retried. After the attempt ceiling
 * the LAST transient error is re-thrown loud (its real cause preserved); the helper never
 * degrades to a default and never loops unboundedly.
 */
export async function withSshTransientRetry<T>(
  operation: () => Promise<T>,
  options: SshTransientRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_SSH_TRANSIENT_ATTEMPTS);
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      // A non-transient error is a GENUINE failure (auth, bad fingerprint, exhausted
      // upstream) — fail loud immediately, never retry it as if it were a blip.
      if (!isTransientSshConnectError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt >= attempts) {
        // Exhausted the bounded retries on a persistent transient — surface LOUD with
        // the real underlying cause (no silent fallback, no swallow).
        throw error;
      }
      const delayMs = backoffForAttempt(attempt);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  // Unreachable (the loop either returns or throws), but keeps the type honest.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
