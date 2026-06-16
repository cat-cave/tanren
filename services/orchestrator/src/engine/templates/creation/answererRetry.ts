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
// operation terminally. It RETRIES (bounded + exponential backoff). Only a
// PERSISTENT failure across the bounded retries fails LOUD (the caller's
// `TemplateRequiredError` halt stays for a genuine unrecoverable failure). No
// infinite retry; no whole-operation wall-clock deadline (the per-call timeout is
// the hang bound, not a terminal verdict).
//
// PROVIDER-NEUTRAL by construction: the classification matches the answerer
// abstraction's transient surface (the answerer's "timed out"/transient-transport
// wording + a transient HTTP status), never a codex-specific internal. A PERSISTENT
// failure (a usage-limit / window-exhausted error, an auth/permission error) is NOT
// retried — those do not self-heal in seconds.

import { recoverableRetryDelayMs } from "../../merge/retrySchedule.js";

/** Bounded attempt count for a pre-build creation answerer call (1 try + 3 retries). */
export const DEFAULT_ANSWERER_MAX_ATTEMPTS = 4;

export interface AnswererRetryOptions {
  /** Total attempts before a persistent failure surfaces loud. Defaults to 4. */
  maxAttempts?: number;
  /** Injectable backoff sleep (tests pass a no-op so the bounded retries run instantly). */
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
 * Run a pre-build creation answerer call with bounded, backed-off retry on a
 * TRANSIENT failure. Re-throws the LAST error once the attempt budget is spent (the
 * caller's fail-closed halt records it) and re-throws a PERSISTENT failure
 * immediately (no point burning retries on a non-self-healing error).
 */
export async function withAnswererRetry<T>(run: () => Promise<T>, options: AnswererRetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_ANSWERER_MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  const backoffMs = options.backoffMs ?? recoverableRetryDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      // A persistent (non-self-healing) failure fails loud immediately; a transient
      // failure on the LAST attempt has spent the bounded budget — surface it loud.
      if (!isTransientAnswererError(error) || attempt >= maxAttempts) {
        throw error;
      }
      // Back off (exponential, bounded) before the next attempt.
      await sleep(backoffMs(attempt));
    }
  }
  // Unreachable: the loop always returns or throws on the final attempt. The throw
  // keeps the function total without a literal-throw (maxAttempts is >= 1).
  throw new Error("withAnswererRetry: exhausted attempts without returning or throwing");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
