// Transient-tolerant retry for SSH connects (the host-key discovery + allocate path).
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
// fails loud immediately.
//
// TIMEOUT-ERADICATION (feedback_no_timeouts_progress_based, BINDING — task #32, critic-arc
// R1 #3 / R2): there is NO fixed attempt COUNT. A transient failure retries UNBOUNDED
// while it is making PROGRESS — the transient signal keeps CHANGING (an ECONNRESET, then
// an ECONNREFUSED, then a connect-establishment blip = forward motion; the connect is
// hitting different wobbles, not stuck). It surfaces LOUD only on intelligent
// NON-CONVERGENCE: the SAME transient signal recurring at the SATURATED backoff with no
// new information (a proven fixed point — a sustained outage), via the shared
// `convergenceDetector`. This mirrors `templates/creation/answererRetry.ts` (and the
// GitHub HTTP transient retry in `providers/githubRetry.ts`).

import { assessStructuralProgress, type AttemptSignature } from "../workflow/convergenceDetector.js";

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
 * Bounded exponential backoff CADENCE for the transient SSH connect retry: ~250ms → 500ms
 * → 1s → 2s. Indexed by `historyLen - 1` (1-based), clamped to the final element. This is
 * SPACING between attempts (cadence, not a deadline / not an attempt cap) — the loop is
 * UNBOUNDED; saturation is what the convergence detector reads to escalate a STUCK signal.
 */
export const SSH_TRANSIENT_BACKOFF_MS: readonly number[] = [250, 500, 1_000, 2_000];

/**
 * The next-attempt backoff for a transient retry, clamped to the saturated final element.
 * `historyLen` is 1-based (1 = first retry's wait, 2 = second, …). Once the curve is
 * saturated every further retry waits the same SPACING — only then does the convergence
 * detector consider a recurring identical signal a proven fixed point.
 */
export function sshTransientBackoffMs(historyLen: number): number {
  const index = Math.min(Math.max(historyLen - 1, 0), SSH_TRANSIENT_BACKOFF_MS.length - 1);
  return SSH_TRANSIENT_BACKOFF_MS.at(index) ?? SSH_TRANSIENT_BACKOFF_MS.at(-1) ?? 2_000;
}

export interface SshTransientRetryOptions {
  /** Override the sleep (tests inject a no-wait sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Observe each retry decision (tests assert the retry happened; prod can log). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // arch-allow: timeout-class — backoff SPACING between retries (cadence, not a deadline).
    setTimeout(resolve, ms);
  });

/**
 * The STABLE identity of a transient SSH-connect failure — the signal the convergence
 * detector reasons over. A CHANGING signature (an ECONNRESET, then an ECONNREFUSED, then
 * a connect-establishment blip) is PROGRESS (the connect is hitting different wobbles,
 * still moving); the IDENTICAL signature recurring at the saturated backoff is a fixed
 * point (a sustained outage). Keyed on the recognized transient CLASS, NOT the raw
 * message (so two ECONNRESETs are the SAME signal, not spuriously different).
 *
 * Mirrors `templates/creation/answererRetry.ts#transientSignature`.
 */
export function sshTransientSignature(error: unknown): string {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined;
  if (code !== undefined && TRANSIENT_NETWORK_CODES.includes(code)) {
    return code.toLowerCase();
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  for (const networkCode of TRANSIENT_NETWORK_CODES) {
    if (message.includes(networkCode.toLowerCase())) {
      return networkCode.toLowerCase();
    }
  }
  if (/ssh_failed|ssh connection failed to establish/u.test(message)) {
    return "ssh-connect";
  }
  if (/connection (?:reset|refused|closed)/u.test(message)) {
    return "connection-reset";
  }
  if (/socket hang up/u.test(message)) {
    return "socket-hang-up";
  }
  if (/connection lost before handshake/u.test(message)) {
    return "handshake-lost";
  }
  return "transport";
}

// Has the transient-retry loop reached a NON-CONVERGENCE fixed point — the SAME
// transient signal recurring with no new information, AND only once the backoff has
// SATURATED (so a still-ramping curve never escalates)? A CHANGING signal (different
// transient class) is progress; an identical signal stuck at the saturated cadence is
// a proven outage. Mirrors `templates/creation/answererRetry.ts#transientFixedPointReached`.
function transientFixedPointReached(signatures: ReadonlyArray<string>): boolean {
  // Until the curve holds its steady-state cadence we are still ramping — legitimate
  // progress-spacing, never an escalation point.
  if (signatures.length <= SSH_TRANSIENT_BACKOFF_MS.length) {
    return false;
  }
  const history: AttemptSignature[] = signatures.map((sig) => ({ failureSignature: sig }));
  return assessStructuralProgress(history) === "fixed_point";
}

/**
 * A loud, terminal classification of a transient SSH-connect signal INTELLIGENTLY
 * detected as non-converging — the SAME transient signal recurring at the SATURATED
 * backoff with no new information (a proven fixed point). NOT an attempt cap: it
 * surfaces only when the convergence detector proves the signal is stuck (a genuine
 * sustained transport outage). Carries the stuck signature so the failure is diagnosable.
 */
export class PersistentSshOutageError extends Error {
  readonly stuckSignature: string;
  readonly retriesObserved: number;

  constructor(input: { stuckSignature: string; retriesObserved: number; cause?: unknown }) {
    super(
      `ssh transient outage: '${input.stuckSignature}' recurred at the saturated backoff with no progress ` +
        `over ${input.retriesObserved} retries — surfacing as a sustained outage, not retrying a fixed point forever`,
    );
    this.name = "PersistentSshOutageError";
    this.stuckSignature = input.stuckSignature;
    this.retriesObserved = input.retriesObserved;
    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
  }
}

/**
 * Run `operation`, retrying ONLY transient network errors (see {@link isTransientSshConnectError})
 * with bounded exponential-backoff SPACING. A non-transient error (auth, bad fingerprint,
 * an application failure) is re-thrown IMMEDIATELY — never retried. The loop is UNBOUNDED
 * while it is making PROGRESS (the transient signal keeps changing); it surfaces LOUD only
 * on intelligent NON-CONVERGENCE — the IDENTICAL transient signal recurring at the
 * SATURATED backoff (a {@link PersistentSshOutageError}, a proven sustained outage). There
 * is NO attempt count.
 */
export async function withSshTransientRetry<T>(
  operation: () => Promise<T>,
  options: SshTransientRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  // The oldest→newest transient signal signatures observed — the convergence history.
  const signatures: string[] = [];
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      // A non-transient error is a GENUINE failure (auth, bad fingerprint, exhausted
      // upstream) — fail loud immediately, never retry it as if it were a blip.
      if (!isTransientSshConnectError(error)) {
        throw error;
      }
      const signature = sshTransientSignature(error);
      signatures.push(signature);
      // Intelligent non-convergence: the IDENTICAL transient signal stuck at the
      // saturated backoff with no new information — a proven outage, surface it loud
      // (never an infinite loop on a dead provider, and never a fixed attempt cap).
      if (transientFixedPointReached(signatures)) {
        throw new PersistentSshOutageError({
          stuckSignature: signature,
          retriesObserved: signatures.length,
          cause: error,
        });
      }
      const delayMs = sshTransientBackoffMs(signatures.length);
      options.onRetry?.({ attempt: signatures.length, delayMs, error });
      await sleep(delayMs);
    }
  }
}
