// pollUntilTerminal — the PROGRESS-BASED verify-poll primitive shared by every
// DeployAdapter (feedback_no_timeouts_progress_based, BINDING). There is NO `maxPolls`,
// NO attempt cap, NO wall-clock deadline. A deploy is polled UNBOUNDED while the provider
// state is ADVANCING (BUILDING → QUEUED → STARTING → …); it succeeds on a READY terminal
// and FAILS LOUD on a provider-reported ERROR terminal. A slow-but-progressing deploy is
// never declared failed on a count — the loop escalates ONLY when the provider state is a
// PROVEN fixed point (the SAME non-terminal state stuck, byte-identical, with no
// advancement), surfaced via `retryUntilConverged`'s intelligent non-convergence detection
// as a real stuck-deploy with evidence (the stuck state + the poll count so far).
//
// This collapses the five adapters' near-identical `while (pollCount < maxPolls)` loops
// onto ONE primitive: each adapter maps its provider read onto a {@link TerminalPoll} and
// hands a `readState` closure + a description; the smoke-check / surface-resolution tail
// stays adapter-specific.

import { retryUntilConverged, type AttemptSignature } from "../workflow/retryUntilConverged.js";
import { fixedPointRuleJudgment } from "../workflow/convergenceDetector.js";

/** The terminal classification of ONE provider status poll. */
export interface TerminalPoll {
  /** The provider's reported state string (e.g. "BUILDING" | "READY" | "started" | "ERROR"). */
  state: string;
  /** The state is a live/ready terminal — the poll loop SUCCEEDS. */
  ready: boolean;
  /** The state is a FAILURE terminal — the poll loop FAILS LOUD immediately. */
  failed: boolean;
}

/** The successful outcome of polling to a READY terminal: the terminal poll + the poll count. */
export interface TerminalOutcome<TPoll extends TerminalPoll> {
  /** The provider read that reported the READY terminal. */
  poll: TPoll;
  /** How many status polls it took to reach the terminal (observability, not a gate). */
  pollCount: number;
}

/** The inputs one deploy poll-to-terminal loop runs over. */
export interface PollUntilTerminalInput<TPoll extends TerminalPoll> {
  /** Issue ONE provider status poll, returning the classified terminal read. */
  readState: () => Promise<TPoll>;
  /**
   * Build the LOUD error thrown when the provider reports a FAILURE terminal — the
   * adapter supplies its typed/worded error (the failed state is passed back).
   */
  onFailureTerminal: (state: string) => Error;
  /**
   * Build the LOUD error thrown when the deploy is a PROVEN stuck fixed point (the SAME
   * non-terminal state with no advancement, detected by `retryUntilConverged`). The
   * adapter supplies its worded error (the stuck state + poll count are passed back as
   * evidence). This is the intelligent non-convergence escalation — NOT a count.
   */
  onStuck: (stuckState: string, pollCount: number) => Error;
  /**
   * Milliseconds to wait between polls — the legitimate poll CADENCE, fed straight into
   * `retryUntilConverged`'s `backoff` (a paced spacing, never a budget that ends the loop).
   * Tests pass `0` for an instant loop with no real timers.
   */
  intervalMs: number;
}

/**
 * Poll the provider until it reaches a READY terminal — UNBOUNDED while the state advances.
 *   - a READY terminal → return `{ poll, pollCount }` (the loop succeeded).
 *   - a FAILURE terminal → throw `onFailureTerminal(state)` LOUD (fail-closed).
 *   - a PROVEN stuck non-terminal state (the same state, no advancement — a fixed point the
 *     convergence detector confirms) → throw `onStuck(state, pollCount)` LOUD with evidence.
 *
 * A non-terminal state that keeps ADVANCING (QUEUED → BUILDING → …) is PROGRESS, so the loop
 * continues forever — a slow-but-progressing deploy is never declared failed on a count.
 */
export async function pollUntilTerminal<TPoll extends TerminalPoll>(
  input: PollUntilTerminalInput<TPoll>,
): Promise<TerminalOutcome<TPoll>> {
  let pollCount = 0;
  // The convergence loop drives the polling: each `attempt` is one provider poll. A FAILURE
  // terminal throws straight out of `attempt` (fail-closed, before any convergence verdict);
  // a READY terminal is `done`; a non-terminal state is "not done", with its signature keyed
  // on the provider state so an advancing state reads as PROGRESS and a stuck-identical state
  // reads as a fixed point. There is no count anywhere — the loop is unbounded.
  const outcome = await retryUntilConverged<TPoll>({
    attempt: async (_history): Promise<{ result: TPoll; signature: AttemptSignature; done: boolean }> => {
      pollCount += 1;
      const poll = await input.readState();
      if (poll.failed) {
        // A provider-reported FAILURE terminal is a LOUD hard failure (never "failed after N
        // polls") — thrown out of the loop entirely, no convergence assessment needed.
        throw input.onFailureTerminal(poll.state);
      }
      return {
        result: poll,
        // The non-terminal provider state IS the convergence signature: a CHANGED state
        // (QUEUED → BUILDING → …) is advancement (progress → keep polling), the SAME state
        // recurring is what the detector reasons over. We deliberately OMIT `workSignature`:
        // a coarse provider state legitimately REPEATS across polls while the build genuinely
        // advances (the provider reports "BUILDING" for many polls), so a single immediate
        // repeat must NOT be treated as a proven dead-end. Only a sustained recurrence with no
        // new state (the cycle detector — an actually non-advancing deploy) is the fixed point.
        signature: { failureSignature: poll.state },
        done: poll.ready,
      };
    },
    // No agent to consult at a deploy fixed point: the rigorous rule stands in — escalate ONLY
    // at a PROVEN identical-state recurrence, with a human-actionable stuck-deploy diagnosis.
    judge: (history) =>
      fixedPointRuleJudgment(history, () => {
        const stuckState = history.at(-1)?.failureSignature ?? "unknown";
        return `deploy stuck in non-terminal state '${stuckState}' with no advancement after ${String(pollCount)} polls`;
      }),
    // The poll cadence — a paced interval between polls, NOT a budget. It never terminates
    // the loop; `retryUntilConverged` spaces each poll by it (a real timer; `0` in tests).
    backoff: () => input.intervalMs,
  });

  if (outcome.kind === "escalate") {
    // A PROVEN stuck deploy — the provider state never advanced. LOUD, with evidence.
    throw input.onStuck(outcome.result.state, pollCount);
  }
  return { poll: outcome.result, pollCount };
}
