// in-11 — the PURE reconcile decision core.
//
// Given one probe observation plus the DURABLE prior attempt history (persisted on
// the reconciliation row so it survives a restart), decide the next transition. The
// retry decision is PROGRESS-BASED, never a wall-clock or a bare attempt counter:
// it reuses the one intelligent non-convergence detector (`convergenceDetector`) —
// while the observed state keeps genuinely advancing the saga retries UNBOUNDED, and
// it escalates to `needs_attention` ONLY at a PROVEN fixed point (an identical
// observation repeating with no new information). An unconfirmable observation is a
// distinct fail-closed halt (`state_unknown`), never folded into the progress read.
//
// PURE (no I/O, no clock) so it is fully unit-testable and reproducible.

import {
  assessStructuralProgress,
  fixedPointRuleJudgment,
  type AttemptSignature,
} from "../workflow/convergenceDetector.js";
import type { ReconcileObservation } from "./reconcileProbe.js";

/**
 * The bounded retention of the durable attempt history. It is >= the detector's
 * `CYCLE_WINDOW` (8) so cycle detection has its full look-back — it is a RETENTION
 * bound, NOT an attempt cap: retries stay unbounded while progress is being made.
 */
export const RECONCILE_HISTORY_RETENTION = 16;

/** The saga's next durable transition for one reconciliation. */
export type ReconcileDecision =
  | {
      readonly action: "fixed_point";
      readonly signature: AttemptSignature;
      readonly history: readonly AttemptSignature[];
    }
  | { readonly action: "retry"; readonly signature: AttemptSignature; readonly history: readonly AttemptSignature[] }
  | {
      readonly action: "needs_attention";
      readonly classification: string;
      readonly signature: AttemptSignature;
      readonly history: readonly AttemptSignature[];
    }
  | { readonly action: "state_unknown"; readonly classification: string };

/**
 * Decide the next transition from an observation + the durable prior history.
 *
 *   - `converged`     → `fixed_point` (the reconcile reached its fixed point; advance).
 *   - `progressing`   → structural progress read over the appended history:
 *       * progress (or first) → `retry`, UNBOUNDED (a changed observation = forward motion).
 *       * proven fixed point  → `needs_attention` with the detector's human-actionable
 *                               diagnosis (an identical observation with no new information).
 *   - `unconfirmable` → `state_unknown` — fail-closed halt; NOT appended to the progress
 *                       history (ambiguity is not a convergence data point).
 *   - `failed`        → `needs_attention` (a confirmed, definite terminal failure).
 */
export function decideReconcile(
  observation: ReconcileObservation,
  priorHistory: readonly AttemptSignature[],
): ReconcileDecision {
  if (observation.kind === "unconfirmable") {
    return { action: "state_unknown", classification: observation.classification };
  }
  if (observation.kind === "failed") {
    const signature: AttemptSignature = { failureSignature: `failed:${observation.classification}`, magnitude: 1 };
    return {
      action: "needs_attention",
      classification: observation.classification,
      signature,
      history: appendBounded(priorHistory, signature),
    };
  }
  if (observation.kind === "converged") {
    const signature: AttemptSignature = {
      failureSignature: "converged",
      workSignature: observation.observedStateHash,
      magnitude: 0,
    };
    return { action: "fixed_point", signature, history: appendBounded(priorHistory, signature) };
  }
  // progressing — the only case that consults the progress detector.
  const signature: AttemptSignature = {
    failureSignature: "progressing",
    workSignature: observation.signal,
    ...(observation.magnitude === undefined ? {} : { magnitude: observation.magnitude }),
  };
  const history = appendBounded(priorHistory, signature);
  const structural = assessStructuralProgress(history);
  if (structural !== "fixed_point") {
    // Progress (or the first attempt): retry, unbounded — never escalate.
    return { action: "retry", signature, history };
  }
  // A PROVEN fixed point: an identical observation with no new information. There is
  // no agent to ask at a durable re-drive, so the principled fixed-point rule stands
  // in with a specific, human-actionable diagnosis.
  const judgment = fixedPointRuleJudgment(
    history,
    () =>
      `integration reconcile is at a proven fixed point: the external observation "${observation.signal}" ` +
      `recurred with no new information across ${history.length} attempts — a human must resolve the stalled provider state`,
  );
  const classification =
    judgment.verdict === "escalate" ? judgment.reason : `reconcile_fixed_point:${observation.signal}`;
  return { action: "needs_attention", classification, signature, history };
}

/** Append the latest signature, keeping only the trailing retention window. */
function appendBounded(history: readonly AttemptSignature[], signature: AttemptSignature): readonly AttemptSignature[] {
  const next = [...history, signature];
  return next.length > RECONCILE_HISTORY_RETENTION ? next.slice(next.length - RECONCILE_HISTORY_RETENTION) : next;
}
