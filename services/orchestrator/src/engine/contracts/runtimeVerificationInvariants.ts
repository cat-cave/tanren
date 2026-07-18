/**
 * SP-5 runtime-verification pass-gate invariants — the app-layer twin of
 * migration 0079's behavior_verdicts CHECKs (#1043 + #1065 F4). Kept in its own
 * module (re-exported from ./runtimeVerification.js) so the harness contract file
 * stays under the per-file class ceiling.
 */
import type { BehaviorVerdictOutcome } from "./runtimeVerificationAdapters.js";

export class InsufficientAssertionCoverageError extends Error {
  public override readonly name = "InsufficientAssertionCoverageError";
  public constructor(message: string) {
    super(message);
  }
}

/**
 * A passed verdict must require at least one assertion and must have executed at
 * least as many as it required — a passed verdict that skipped assertions or
 * demanded none is a false-green. Every recordVerdict impl calls this before
 * persistence so the invariant fails loud rather than reaching the DB CHECK.
 */
export function assertVerdictAssertionCoverage(input: {
  readonly outcome: BehaviorVerdictOutcome;
  readonly requiredAssertionCount: number;
  readonly executedAssertionCount: number;
}): void {
  if (input.outcome !== "passed") return;
  if (input.requiredAssertionCount < 1) {
    throw new InsufficientAssertionCoverageError(
      `passed verdict requires at least one assertion, got required=${input.requiredAssertionCount}`,
    );
  }
  if (input.executedAssertionCount < input.requiredAssertionCount) {
    throw new InsufficientAssertionCoverageError(
      `passed verdict executed ${input.executedAssertionCount} of ${input.requiredAssertionCount} required assertions`,
    );
  }
}
