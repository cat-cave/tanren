// PURE policy helpers for the spec-loop redesign (docs/roadmap/spec-loop-redesign.md):
// the deterministic routing the loop applies OVER the triage + convergence answerers'
// output. Kept pure (no I/O) so the routing is reproducible + conformance-testable
// without a DB, and so the loop module stays under the 500-line architecture cap.

import { type AuditPostureConfig } from "../config/shared.js";
import { type Finding, type FindingSeverity, severityRank } from "../contracts/findings.js";
import type { BlockingRootCauseProgress, ConvergenceAssessment, TriageWorkItem } from "../answerers/schemas/index.js";

// A triaged item's resolved ROUTE — the deterministic decision the loop makes over
// the agent's `kind` HINT + the item severity + the project posture:
//   - `task` — appended to THIS spec's task list (re-enter the writer loop).
//   - `spec` — emitted as a NEW DAG spec via the spec-creating contract.
export type TriageRoute = "task" | "spec";

export interface RoutedWorkItem {
  item: TriageWorkItem;
  route: TriageRoute;
}

/**
 * Route each triaged work item to a task-here or a new-DAG-spec, deterministically,
 * from the item severity + the agent's `kind` hint + the project `auditPosture`:
 *   - P0 (at-or-above the always-block bar) ALWAYS routes to a task in THIS spec —
 *     a build-breaking / irrecoverable defect is never deferred to a new spec.
 *   - P1–P3: honor the agent's `kind` hint, BUT under a `route-to-dag` posture a
 *     below-`blockReviewAt` item routes to a new spec (velocity: never block on it
 *     here); under `fix-if-idle` a `spec`-hinted item that is at-or-above
 *     `blockReviewAt` is pulled back to a task (it blocks, so fix it in-spec).
 * The split is total: every item resolves to exactly one route.
 */
export function routeTriageItems(items: ReadonlyArray<TriageWorkItem>, posture: AuditPostureConfig): RoutedWorkItem[] {
  return items.map((item) => ({ item, route: routeOne(item, posture) }));
}

function atOrAbove(severity: FindingSeverity, threshold: FindingSeverity): boolean {
  return severityRank(severity) <= severityRank(threshold);
}

function routeOne(item: TriageWorkItem, posture: AuditPostureConfig): TriageRoute {
  // P0 is never deferrable — always a task in this spec.
  if (item.severity === "P0") {
    return "task";
  }
  const blocks = atOrAbove(item.severity, posture.blockReviewAt);
  if (blocks) {
    // A blocking (≥ threshold) item is fixed in-spec regardless of the agent hint.
    return "task";
  }
  // Below the block threshold: velocity posture routes to a new DAG spec; otherwise
  // honor the agent's home hint.
  if (posture.p2p3Handling === "route-to-dag") {
    return "spec";
  }
  return item.kind === "spec" ? "spec" : "task";
}

// The terminal outcome of the triage routing step:
//   - `passed`     — NO item routed to a task (every finding became a new spec, or
//                    there were no actionable items): the spec PASSES (triage→passed).
//   - `kept`       — at least one item routed to a task: re-enter the writer loop with
//                    those tasks, after the CONVERGENCE check.
export interface TriageRoutingResult {
  tasksHere: RoutedWorkItem[];
  newSpecs: RoutedWorkItem[];
  outcome: "passed" | "kept";
}

export function summarizeTriageRouting(routed: ReadonlyArray<RoutedWorkItem>): TriageRoutingResult {
  const tasksHere = routed.filter((r) => r.route === "task");
  const newSpecs = routed.filter((r) => r.route === "spec");
  return { tasksHere, newSpecs, outcome: tasksHere.length === 0 ? "passed" : "kept" };
}

// The CONVERGENCE policy decision the loop acts on, derived from the answerer's
// assessment + the consecutive-stall counter:
//   - `continue` — keep iterating the loop (progress).
//   - `pass`     — velocity-defer: allow the spec to pass (mild leftovers as specs).
//   - `halt`     — N consecutive stalls reached → HALT `convergence_stalled`.
export type ConvergenceDecision = "continue" | "pass" | "halt";

export interface ConvergenceState {
  // The number of CONSECUTIVE BLOCKING-unchanged stalls observed so far (NOT a retry
  // counter). The v24 cause-not-symptom fix: this tracks the BLOCKING root cause, not
  // "did anything change". A blocking `retired`/`reduced` (the blocker made forward
  // motion) RESETS it to 0; a blocking `unchanged`/`regressed` increments it — EVEN IF
  // peripheral non-blocking findings changed this loop. When there is NO blocking
  // finding (`none`), the answerer's overall `assessment` drives the reset/increment.
  consecutiveStalls: number;
}

// The VELOCITY-DEFER policy the loop applies OVER a `velocity_defer` assessment —
// lifted out of `applyConvergencePolicy` so a project can TUNE the "defer mild
// leftovers as specs + allow the merge" middle-ground (spec-loop-redesign.md
// §convergence (c)) rather than it being hard-coded. Mirrors the `velocityDefer*`
// fields on `ConvergencePolicyConfig`. A `velocity_defer` is HONORED (→ `pass`)
// only when:
//   - `enabled` is true, AND
//   - the WORST kept-leftover severity is at-or-below `maxSeverity` (mild enough),
//     AND
//   - `consecutiveStalls` SO FAR is at-or-above `afterStalls` (ground for N rounds
//     first).
// When any gate fails the answerer's defer is REFUSED: the loop keeps iterating
// (`continue`) instead of passing — fail-closed (never merge too-severe leftovers
// just because the answerer wanted to defer).
export interface VelocityDeferPolicy {
  enabled: boolean;
  maxSeverity: FindingSeverity;
  afterStalls: number;
}

// True iff the blocking root cause is STUCK this loop — the same merge-gating finding
// recurs materially `unchanged`, or `regressed` to worse. This is the v24 stall signal:
// it is driven by the BLOCKING root cause, NOT by whether peripheral findings moved.
function blockingIsStuck(progress: BlockingRootCauseProgress): boolean {
  return progress === "unchanged" || progress === "regressed";
}

/**
 * Apply the convergence policy. PURE. Returns the next state + the loop decision.
 *
 * The v24 CAUSE-NOT-SYMPTOM fix: the consecutive-stall counter tracks the BLOCKING
 * root cause (`blockingProgress`), NOT the overall "did anything change" assessment.
 * When a blocking (merge-gating) finding exists this loop, its progress is the SOLE
 * driver of the stall counter — peripheral non-blocking churn can no longer mask a
 * stuck blocker:
 *   - blocking `unchanged`/`regressed` → increment the stall counter (a stall vote),
 *     `halt` once it reaches `maxConsecutiveStalls`, else `continue`. This holds EVEN
 *     IF the answerer's overall `assessment` was `progress`/`velocity_defer` because
 *     unrelated findings moved (the exact v24 churn).
 *   - blocking `retired`/`reduced` → genuine forward motion on the blocker → RESET the
 *     stall counter; then honor the answerer's overall assessment for the decision
 *     (`velocity_defer` may `pass`, otherwise `continue`).
 *
 * When there is NO blocking finding this loop (`blockingProgress === "none"`), the
 * answerer's overall `assessment` drives the counter (the original behavior, used for
 * loopbacks with only non-blocking leftovers):
 *   - `progress`       → reset the stall counter, `continue`.
 *   - `velocity_defer` → reset the stall counter; `pass` if the velocity policy HONORS
 *                        it (enabled · leftovers ≤ maxSeverity · stalls ≥ afterStalls),
 *                        else `continue` (the defer is refused — keep iterating).
 *   - `stalled`        → increment the stall counter; `halt` at `maxConsecutiveStalls`.
 *
 * `maxConsecutiveStalls` is the SOLE halt bound — there is NO retry cap / timeout.
 *
 * `worstLeftoverSeverity` is the worst severity among the findings KEPT in-spec on
 * this loopback (undefined ⇒ no kept findings, so the leftover-severity gate is
 * vacuously satisfied). It is only consulted for a `velocity_defer`.
 */
export function applyConvergencePolicy(
  assessment: ConvergenceAssessment,
  blockingProgress: BlockingRootCauseProgress,
  state: ConvergenceState,
  maxConsecutiveStalls: number,
  velocityPolicy: VelocityDeferPolicy,
  worstLeftoverSeverity?: FindingSeverity,
): { state: ConvergenceState; decision: ConvergenceDecision } {
  // PRIMARY signal: a stuck blocking root cause is a stall regardless of the overall
  // assessment — peripheral progress NEVER resets the counter (the v24 fix).
  if (blockingIsStuck(blockingProgress)) {
    const consecutiveStalls = state.consecutiveStalls + 1;
    const decision: ConvergenceDecision = consecutiveStalls >= maxConsecutiveStalls ? "halt" : "continue";
    return { state: { consecutiveStalls }, decision };
  }
  // The blocking root cause was retired/reduced (forward motion on the blocker), OR
  // there is no blocking finding. Reset on blocker progress, then honor the overall
  // assessment. (`retired`/`reduced` ⇒ never a `stalled` vote: the blocker advanced.)
  const blockerAdvanced = blockingProgress === "retired" || blockingProgress === "reduced";
  if (blockerAdvanced || assessment === "progress") {
    if (assessment === "velocity_defer") {
      const decision: ConvergenceDecision = honorsVelocityDefer(velocityPolicy, state, worstLeftoverSeverity)
        ? "pass"
        : "continue";
      return { state: { consecutiveStalls: 0 }, decision };
    }
    return { state: { consecutiveStalls: 0 }, decision: "continue" };
  }
  // No blocking finding (`none`) + the overall assessment is the driver.
  if (assessment === "velocity_defer") {
    // A defer RESETS the stall counter (it is not a stall — the remainder is deferred).
    const decision: ConvergenceDecision = honorsVelocityDefer(velocityPolicy, state, worstLeftoverSeverity)
      ? "pass"
      : "continue";
    return { state: { consecutiveStalls: 0 }, decision };
  }
  // stalled (no blocking finding, overall read is a stall)
  const consecutiveStalls = state.consecutiveStalls + 1;
  const decision: ConvergenceDecision = consecutiveStalls >= maxConsecutiveStalls ? "halt" : "continue";
  return { state: { consecutiveStalls }, decision };
}

// True iff the velocity policy HONORS a `velocity_defer` for the given state +
// worst-leftover severity. A finding worse than `maxSeverity` (rank below it) or a
// stall count below `afterStalls` refuses the defer.
function honorsVelocityDefer(
  policy: VelocityDeferPolicy,
  state: ConvergenceState,
  worstLeftoverSeverity?: FindingSeverity,
): boolean {
  if (!policy.enabled) {
    return false;
  }
  if (state.consecutiveStalls < policy.afterStalls) {
    return false;
  }
  if (worstLeftoverSeverity !== undefined && !atOrBelow(worstLeftoverSeverity, policy.maxSeverity)) {
    return false;
  }
  return true;
}

// `severity` is no worse than `threshold` (mild enough to defer). severityRank is
// 0=P0 … 3=P3, so "at-or-below in severity" is rank at-or-above the threshold's.
function atOrBelow(severity: FindingSeverity, threshold: FindingSeverity): boolean {
  return severityRank(severity) >= severityRank(threshold);
}

/** The total P-score of a findings list (lower-rank severities weigh more). Used by
 * tests + the convergence narration to evidence "decreasing total P-score". P0=4 …
 * P3=1; absent findings score 0. */
export function totalPScore(findings: ReadonlyArray<Finding>): number {
  return findings.reduce((sum, f) => sum + (4 - severityRank(f.severity)), 0);
}
