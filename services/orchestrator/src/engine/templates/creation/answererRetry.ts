// Transient-tolerant retry for the PRE-BUILD template-creation answerer calls
// (research → author). These run as SYNCHRONOUS structured-answerer calls BEFORE
// the build DAG exists, so the unified-finalize re-drive (#582) and the per-spec
// retry do NOT cover them — a transient codex hiccup here would otherwise be
// TERMINAL (one `Codex Answerer timed out for schema tanren.template_research.v1`
// fast-failed a whole derive at 3.5 min, even though local codex was healthy and a
// retry usually succeeds — codex latency is variable, observed 168-282s this run).
//
// BINDING (no_silent_fallbacks + transient-not-tolerated): a TRANSIENT failure — a
// per-call timeout (the hang-detector firing on a slow-but-working call), a 5xx /
// network blip, or a transient codex/transport error — must NEVER fail the whole
// operation terminally. It RETRIES (UNBOUNDED + exponential backoff). A PERSISTENT
// failure (a usage-limit / window-exhausted error, an auth/permission error) is NOT
// retried — those do not self-heal in seconds — and fails LOUD at once.
//
// TIMEOUT-ERADICATION (feedback_no_timeouts_progress_based, BINDING): there is NO
// fixed attempt COUNT. A transient failure retries UNBOUNDED while it is making
// PROGRESS — the transient signal keeps CHANGING (a timeout, then a 503, then a
// reset = forward motion; the call is hitting different wobbles, not stuck). It
// surfaces LOUD only on intelligent NON-CONVERGENCE: the SAME transient signal
// recurring at the SATURATED backoff with no new information (a proven fixed point —
// a sustained outage), via the shared `convergenceDetector`. This is the SAME
// pattern as the GitHub HTTP transient retry (`providers/githubRetry.ts`).
//
// PROVIDER-NEUTRAL by construction: the classification matches the answerer
// abstraction's transient surface (the answerer's "timed out"/transient-transport
// wording + a transient HTTP status), never a codex-specific internal.

import { assessStructuralProgress, type AttemptSignature } from "../../workflow/convergenceDetector.js";
import { recoverableRetryDelayMs, RECOVERABLE_RETRY_DELAYS_MS } from "../../merge/retrySchedule.js";

export interface AnswererRetryOptions {
  /** Injectable backoff sleep (tests pass a no-op so the retries run instantly). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable backoff curve (1-based attempt → delay ms). Defaults to the recoverable curve. */
  backoffMs?: (attempt: number) => number;
}

/**
 * Classify whether a thrown answerer error is TRANSIENT (retry) or PERSISTENT
 * (fail loud). Transient = a per-call timeout, a transient transport/5xx, or a
 * generic network/connection blip. Persistent (NOT retried) = a usage-limit /
 * window-exhausted condition (does not self-heal in seconds) or any error the
 * patterns below do not recognize (default to NOT retrying so a genuine,
 * non-self-healing failure fails loud rather than burning the bounded retries).
 */
export function isTransientAnswererError(error: unknown): boolean {
  // A usage-limit / window-exhausted condition is NOT transient — retrying in
  // seconds cannot clear an exhausted subscription window. Recognized by name so we
  // stay provider-neutral (both CodexUsageLimitError + ClaudeUsageLimitError set it).
  const name = errorName(error);
  if (name === "CodexUsageLimitError" || name === "ClaudeUsageLimitError") {
    return false;
  }
  const message = errorMessage(error).toLowerCase();
  if (message === "") {
    return false;
  }
  // A usage/quota/window-exhausted message (belt-and-suspenders alongside the name).
  if (/usage limit|window.*exhaust|quota/u.test(message)) {
    return false;
  }
  // A timeout — the per-call hang-detector firing (the research answerer throws
  // "... timed out for schema ..."). The single most-observed transient.
  if (/timed out|timeout|etimedout/u.test(message)) {
    return true;
  }
  // A transient transport / gateway status (5xx-ish) or a network blip — the answerer
  // ran but the call hit an upstream wobble that self-heals on a re-attempt.
  if (/\b(502|503|504|408|429)\b|bad gateway|service unavailable|gateway timeout/u.test(message)) {
    return true;
  }
  if (
    /econnreset|econnrefused|enetunreach|ehostunreach|epipe|socket hang up|network|connection (reset|refused|closed)/u.test(
      message,
    )
  ) {
    return true;
  }
  return false;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

/**
 * The STABLE identity of a transient answerer failure — the signal the convergence
 * detector reasons over. A CHANGING signature (a timeout, then a 503, then a reset)
 * is PROGRESS (the call is hitting different wobbles, still moving); the IDENTICAL
 * signature recurring at the saturated backoff is a fixed point (a sustained outage).
 * Keyed on the recognized transient class, NOT the raw message (so "timed out at
 * 03:01" and "timed out at 03:02" are the SAME signal, not spuriously different).
 */
export function transientSignature(error: unknown): string {
  const message = errorMessage(error).toLowerCase();
  if (/timed out|timeout|etimedout/u.test(message)) return "timeout";
  const status = /\b(502|503|504|408|429)\b/u.exec(message);
  if (status !== null) return `http-${status[1]}`;
  if (/bad gateway|service unavailable|gateway timeout/u.test(message)) return "gateway";
  return "transport";
}

/**
 * A loud, terminal classification of a transient answerer signal INTELLIGENTLY
 * detected as non-converging — the SAME transient signal recurring at the SATURATED
 * backoff with no new information (a proven fixed point). NOT an attempt cap: it
 * surfaces only when the convergence detector proves the signal is stuck (a genuine
 * sustained provider outage). Carries the stuck signature so the failure is diagnosable.
 */
export class PersistentAnswererOutageError extends Error {
  constructor(
    readonly stuckSignature: string,
    readonly retriesObserved: number,
    cause: unknown,
  ) {
    super(
      `answerer transient outage: '${stuckSignature}' recurred at the saturated backoff with no progress ` +
        `over ${retriesObserved} retries — surfacing as a sustained outage, not retrying a fixed point forever`,
    );
    this.name = "PersistentAnswererOutageError";
    if (cause !== undefined) this.cause = cause;
  }
}

// Has the transient-retry loop reached a NON-CONVERGENCE fixed point — the SAME
// transient signal recurring with no new information, AND only once the backoff has
// SATURATED (so a still-ramping curve never escalates)? A CHANGING signal (different
// transient class) is progress; an identical signal stuck at the saturated cadence is
// a proven outage. Mirrors `providers/githubRetry.ts#transientFixedPointReached`.
function transientFixedPointReached(signatures: ReadonlyArray<string>): boolean {
  // Until the curve holds its steady-state cadence we are still ramping — legitimate
  // progress-spacing, never an escalation point.
  if (signatures.length <= RECOVERABLE_RETRY_DELAYS_MS.length) {
    return false;
  }
  const history: AttemptSignature[] = signatures.map((sig) => ({ failureSignature: sig }));
  return assessStructuralProgress(history) === "fixed_point";
}

/**
 * Run a pre-build creation answerer call with UNBOUNDED, backed-off retry on a
 * TRANSIENT failure. A PERSISTENT failure fails loud immediately (no point retrying a
 * non-self-healing error). A transient failure retries forever while it is making
 * PROGRESS (the transient signal keeps changing); it surfaces LOUD only on
 * intelligent NON-CONVERGENCE — the IDENTICAL transient signal recurring at the
 * SATURATED backoff (a `PersistentAnswererOutageError`, a proven sustained outage).
 */
export async function withAnswererRetry<T>(run: () => Promise<T>, options: AnswererRetryOptions = {}): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const backoffMs = options.backoffMs ?? recoverableRetryDelayMs;
  // The oldest→newest transient signal signatures observed — the convergence history.
  const signatures: string[] = [];
  for (;;) {
    try {
      return await run();
    } catch (error) {
      // A persistent (non-self-healing) failure fails loud immediately.
      if (!isTransientAnswererError(error)) {
        throw error;
      }
      signatures.push(transientSignature(error));
      // Intelligent non-convergence: the IDENTICAL transient signal stuck at the
      // saturated backoff with no new information — a proven outage, surface it loud
      // (never an infinite loop on a dead provider, and never a fixed attempt cap).
      if (transientFixedPointReached(signatures)) {
        throw new PersistentAnswererOutageError(signatures.at(-1)!, signatures.length, error);
      }
      // Back off (exponential, saturating) before the next UNBOUNDED retry.
      await sleep(backoffMs(signatures.length));
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // arch-allow: timeout-class — backoff SPACING between retries (cadence, not a deadline).
    setTimeout(resolve, ms);
  });
}
