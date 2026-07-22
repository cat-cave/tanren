// retryUntilConverged — the PROGRESS-BASED replacement for attempt / poll / retry CAPS
// (feedback_no_timeouts_progress_based, BINDING). The doctrine: there is NO `K`, NO
// `MAX_*_ATTEMPTS`, NO `maxPolls`, NO wall-clock deadline ANYWHERE. A loop continues
// UNBOUNDED while it is making PROGRESS, and escalates to a human ONLY when it is
// INTELLIGENTLY detected to be at a genuine fixed point — exactly the convergence-agent
// model already distilled in `convergenceDetector.ts`. This primitive is the thin,
// reusable loop that wraps that detector so every capped retry/poll site can migrate
// onto it (migration is done by LATER PRs — this PR only provides + tests the primitive).
//
// The shape every caller maps onto:
//   - `attempt(priorHistory)` runs ONE try, returning its `result`, the distilled
//     `signature` (failure identity / produced-work identity / remaining magnitude — the
//     `AttemptSignature` the detector reasons over), and `done` (the try SUCCEEDED — the
//     loop returns immediately with no convergence check needed).
//   - `judge` renders the intelligent escalation verdict — consulted ONLY at a suspected
//     fixed point (so the expensive assessment runs rarely, never on a progressing loop).
//     When the caller has no agent to ask (a durable DB-driven re-drive), it passes the
//     rigorous `fixedPointRuleJudgment` stand-in.
//   - `backoff(history)` is the SPACING between tries (a poll interval / backoff delay),
//     NOT a cap and NOT a budget — it never terminates the loop, only paces it.
//
// The loop is a literal `for (;;)` — no maximum, no deadline. It returns `{ done, result }`
// when an attempt succeeds, or `{ escalate, reason }` when the convergence detector proves a
// genuine fixed point. Advancement / slowness / many-tries NEVER escalate.

import { type AttemptSignature, decideConvergence, type EscalationJudgment } from "./convergenceDetector.js";

export type { AttemptSignature, EscalationJudgment };

// The outcome of ONE attempt, mapped onto the convergence detector's inputs.
export interface AttemptOutcome<TResult> {
  // The attempt's product (whatever the caller needs back on success).
  result: TResult;
  // The distilled convergence signature (failure identity / work identity / magnitude).
  // The loop appends this to the history the detector + judge reason over.
  signature: AttemptSignature;
  // Did this attempt SUCCEED? `true` → the loop returns `{ done: true, result }` at once
  // (no convergence assessment — success needs no fixed-point check). `false` → the loop
  // consults the detector and either continues (progress) or escalates (proven fixed point).
  done: boolean;
}

// The terminal outcome of the whole loop.
export type ConvergenceOutcome<TResult> =
  | { kind: "done"; result: TResult }
  | { kind: "escalate"; reason: string; result: TResult };

/**
 * The decision reached for ONE iteration of the loop, surfaced to the optional
 * `onAttempt` observability hook. Fires ONCE per iteration after the attempt
 * completes AND (on a non-done attempt) after the convergence decision is made:
 *   - `done`     — this attempt SUCCEEDED; the loop returns `{ kind: "done" }`.
 *   - `progress` — the loop CONTINUES (structural progress, or the judge said keep going).
 *                  The next attempt runs after the optional backoff spacing.
 *   - `escalate` — a PROVEN fixed point; the loop returns `{ kind: "escalate" }`.
 */
export type AttemptDecision = "done" | "progress" | "escalate";

/**
 * The per-iteration observability payload fed to the optional `onAttempt` callback.
 * A caller (writer stall recovery, plan/checker/auditor stage recovery, deploy verify,
 * deploy poll-to-terminal, …) hooks this to emit its own `*.retrying` structured log
 * or metric — the primitive itself remains silent so backward compatibility with
 * existing callers is unchanged. All fields describe the attempt just observed.
 */
export interface AttemptInfo {
  /** 1-indexed attempt number (`1` on the first attempt; the count of attempts so far, this one included). */
  attempt: number;
  /**
   * The distilled attempt signature that was appended to the history — the caller's
   * failure identity / work identity / remaining magnitude, whatever it distilled. A
   * demonstration caller keys its `*.retrying` event's `reason` off `failureSignature`.
   */
  signature: AttemptSignature;
  /** Whether this attempt succeeded (`decision === "done"`). Convenience mirror of the decision. */
  done: boolean;
  /** The loop's decision for THIS iteration — see {@link AttemptDecision}. */
  decision: AttemptDecision;
}

// The inputs to one unbounded convergence loop.
export interface RetryUntilConvergedInput<TResult> {
  // Run ONE attempt, given the full prior history (oldest→newest, this attempt not yet
  // appended). The history lets an attempt see what it has already tried (e.g. to nudge a
  // re-drive with new context at a fixed point).
  attempt: (priorHistory: ReadonlyArray<AttemptSignature>) => Promise<AttemptOutcome<TResult>>;
  // The intelligent escalation judgment, consulted ONLY at a suspected fixed point. Pass
  // `fixedPointRuleJudgment(history, describeDeadEnd)` when there is no agent to ask.
  judge: (history: ReadonlyArray<AttemptSignature>) => Promise<EscalationJudgment> | EscalationJudgment;
  // SPACING between attempts (a backoff / poll interval), given the history so far. Returns
  // the delay in ms before the NEXT attempt. NOT a cap — returning 0 means "retry at once".
  // This is the ONLY time-shaped knob, and it never terminates the loop. Optional; default 0.
  backoff?: (history: ReadonlyArray<AttemptSignature>) => number;
  /**
   * OPTIONAL per-iteration observability hook (Codex critic #13 — the loop's durable
   * observability gap). Fires ONCE per attempt after the outcome is known, carrying
   * the 1-indexed attempt number, the distilled signature, and the loop's decision
   * (`done`/`progress`/`escalate`). A caller opts in to emit a `*.retrying` structured
   * log line or metric that lets an operator see WHICH retries are happening — critical
   * for the loop-STAGE callers (writer/plan/checker/auditor stall recovery, deploy
   * verify) that visibly stall the DAG during an autonomous run.
   *
   * OPTIONAL by design: existing callers keep working with NO change — the primitive
   * emits nothing itself. Never mutates loop state; a throw or rejection propagates
   * OUT of `retryUntilConverged` (an observability hook should not throw, but the
   * primitive does NOT silently swallow errors — a broken observer is a bug).
   */
  onAttempt?: (info: AttemptInfo) => void | Promise<void>;
}

/**
 * THE primitive. Drives `attempt` in an UNBOUNDED `for (;;)` loop:
 *   - the attempt SUCCEEDED (`done`)       → return `{ kind: "done", result }`.
 *   - the convergence detector says CONTINUE (progress, or the judge said "keep going")
 *                                          → space by `backoff(history)` and loop again.
 *   - the detector ESCALATES (a proven fixed point the judge confirmed) → return
 *                                            `{ kind: "escalate", reason, result }` with the
 *                                            last attempt's result for context.
 *
 * There is NO attempt cap, NO poll cap, NO wall-clock deadline. While the loop makes
 * progress it runs forever; it stops ONLY on success or a genuinely-detected dead end.
 */
export async function retryUntilConverged<TResult>(
  input: RetryUntilConvergedInput<TResult>,
): Promise<ConvergenceOutcome<TResult>> {
  const history: AttemptSignature[] = [];
  // Unbounded: the loop terminates on success or a proven fixed point, NEVER on a count.
  for (;;) {
    const outcome = await input.attempt(history);
    history.push(outcome.signature);
    // The 1-indexed attempt number for this iteration (the count of attempts so far, this
    // one included). Fed to the optional `onAttempt` observability hook so a caller can
    // emit its own `*.retrying` structured log — the primitive itself remains silent.
    const attemptNumber = history.length;
    if (outcome.done) {
      await input.onAttempt?.({
        attempt: attemptNumber,
        signature: outcome.signature,
        done: true,
        decision: "done",
      });
      return { kind: "done", result: outcome.result };
    }
    const decision = await decideConvergence(history, input.judge);
    if (decision.decision === "escalate") {
      await input.onAttempt?.({
        attempt: attemptNumber,
        signature: outcome.signature,
        done: false,
        decision: "escalate",
      });
      return { kind: "escalate", reason: decision.reason, result: outcome.result };
    }
    // CONTINUE, unbounded. Space the next attempt by the backoff (a paced interval, not a
    // budget) and loop again — no count, no deadline.
    await input.onAttempt?.({
      attempt: attemptNumber,
      signature: outcome.signature,
      done: false,
      decision: "progress",
    });
    const delayMs = input.backoff?.(history) ?? 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
}

// Backoff SPACING between attempts (a paced delay — a legitimate cadence, NOT a safety
// budget that kills work). Used only to pace the loop, never to terminate it.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // arch-allow: timeout-class — backoff SPACING between retries (cadence, not a deadline).
    setTimeout(resolve, ms);
  });
}
