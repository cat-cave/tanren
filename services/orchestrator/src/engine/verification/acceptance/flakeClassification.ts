// rv-17 — REAL flake classification, computed from the recorded acceptance verdicts (never
// guessed). A behavior is FLAKY only when its recorded verdicts for the SAME behavior_revision
// against the SAME context/artifact show OBSERVED non-determinism: at least one DECISIVE `passed`
// AND at least one DECISIVE product failure (`failed_product` / `failed_visual`) — identical
// inputs yielding both a pass and a real product fail. That conflict IS the evidence.
//
// FAIL-CLOSED (the anti-cosplay floor):
//   • Only DECISIVE outcomes count. An `inconclusive_*` (infra/external) or a
//     `failed_verification_contract` (coverage) is NOT evidence of non-determinism — it is a
//     fail-closed state and stays out of the classification entirely.
//   • No decisive observation at all ⇒ `insufficient_observation` — NOT flaky, and NOT laundered
//     into `stable`+passed by default. An inconclusive stays inconclusive.
//   • A single decisive outcome, or all-consistent decisive outcomes, is NOT flaky (`stable` for
//     all-passed, `consistent_failure` for all-failed).
//
// The classification gates QUARANTINE eligibility (behaviorQuarantineGovernance.ts): ONLY a
// `flaky` classification can justify a quarantine (enforced again at the DB CHECK). It never
// mutates a verdict's own gate outcome.

import type { BehaviorVerdictOutcome } from "../../contracts/runtimeVerificationAdapters.js";

export type FlakeClassification = "flaky" | "consistent_failure" | "stable" | "insufficient_observation";

/** One recorded verdict observation the classifier reasons over. */
export interface VerdictObservation {
  readonly verdictId: string;
  readonly outcome: BehaviorVerdictOutcome;
}

export interface FlakeClassificationResult {
  readonly classification: FlakeClassification;
  /** The conflicting recorded verdicts (ids + outcomes) that evidence a `flaky` verdict. */
  readonly evidence: readonly VerdictObservation[];
  /** Total DECISIVE observations considered (inconclusive/contract excluded). */
  readonly decisiveCount: number;
}

/** A DECISIVE pass — the only healthy signal (mirrors rv-16 classifyProbe). */
function isDecisivePass(outcome: BehaviorVerdictOutcome): boolean {
  return outcome === "passed";
}

/** A DECISIVE product failure — a genuine product regression, not an infra/coverage fail. */
function isDecisiveFail(outcome: BehaviorVerdictOutcome): boolean {
  return outcome === "failed_product" || outcome === "failed_visual";
}

/**
 * Classify a behavior's recorded verdicts (already scoped to ONE behavior_revision + context +
 * artifact by the caller) as flaky / consistent_failure / stable / insufficient_observation.
 * Flaky requires a REAL decisive pass↔fail conflict; the returned evidence carries the exact
 * conflicting verdict ids so the quarantine record can cite them.
 */
export function classifyFlake(observations: readonly VerdictObservation[]): FlakeClassificationResult {
  const passes = observations.filter((o) => isDecisivePass(o.outcome));
  const fails = observations.filter((o) => isDecisiveFail(o.outcome));
  const decisiveCount = passes.length + fails.length;

  if (passes.length > 0 && fails.length > 0) {
    // Real observed non-determinism: cite one conflicting pass + one conflicting fail as evidence.
    return { classification: "flaky", evidence: [passes[0]!, fails[0]!], decisiveCount };
  }
  if (decisiveCount === 0) {
    // No decisive observation — fail closed. Never laundered into stable+passed.
    return { classification: "insufficient_observation", evidence: [], decisiveCount };
  }
  if (fails.length > 0) {
    return { classification: "consistent_failure", evidence: fails, decisiveCount };
  }
  return { classification: "stable", evidence: passes, decisiveCount };
}
