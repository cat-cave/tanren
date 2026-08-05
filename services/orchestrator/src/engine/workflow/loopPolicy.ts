// PURE policy helpers for the spec-loop redesign (docs/roadmap/spec-loop-redesign.md):
// the deterministic routing the loop applies OVER the triage + convergence answerers'
// output. Kept pure (no I/O) so the routing is reproducible + conformance-testable
// without a DB, and so the loop module stays under the 500-line architecture cap.

import { type AuditPostureConfig } from "../config/shared.js";
import { type Finding, type FindingSeverity, severityRank } from "../contracts/findings.js";
import type {
  BlockingRootCauseProgress,
  ConvergenceAssessment,
  ConvergenceEscalation,
  TriageWorkItem,
} from "../answerers/schemas/index.js";
import { type AttemptSignature, assessStructuralProgress } from "./convergenceDetector.js";

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
 * from the agent's `kind` hint + the item severity + the project `auditPosture`:
 *   - The agent's `kind: spec` hint (a CROSS-SCOPE work item the triage judged belongs
 *     in a new DAG spec) is honored FIRST, regardless of severity — even a P0. This is
 *     the apex v79/v80 loop closure: without it, every out-of-scope P0 the auditor
 *     surfaces is silently re-forced back into this spec by the "P0 → task" rule,
 *     rotating findings across iterations and preventing convergence. The triage agent
 *     has more scope context than the deterministic policy; when it EXPLICITLY declares
 *     an item cross-scope, we defer to that judgment.
 *   - IN-SCOPE (`kind: task`) items then follow severity: P0 ALWAYS routes to a task
 *     in THIS spec (build-breaking / irrecoverable), P1 blocking routes to a task, and
 *     P1–P3 mild items follow `p2p3Handling` (velocity vs. fix-if-idle).
 * The split is total: every item resolves to exactly one route.
 */
export function routeTriageItems(items: ReadonlyArray<TriageWorkItem>, posture: AuditPostureConfig): RoutedWorkItem[] {
  return items.map((item) => ({ item, route: routeOne(item, posture) }));
}

function atOrAbove(severity: FindingSeverity, threshold: FindingSeverity): boolean {
  return severityRank(severity) <= severityRank(threshold);
}

function routeOne(item: TriageWorkItem, posture: AuditPostureConfig): TriageRoute {
  // apex v79/v80 loop closure: a `kind: spec` hint is HONORED FIRST, before the
  // severity gates. The triage agent has richer scope context than the deterministic
  // routing policy — when it declares a work item cross-scope, we defer to that
  // judgment, even for a P0. The old inverted rule ("P0 → task ALWAYS") re-forced
  // every out-of-scope P0 back into this spec, silently defeating v79's OUT-OF-SCOPE
  // routing and rotating findings without convergence.
  if (item.kind === "spec") {
    return "spec";
  }
  // IN-SCOPE items: P0 is never deferrable — always a task in this spec.
  if (item.severity === "P0") {
    return "task";
  }
  const blocks = atOrAbove(item.severity, posture.blockReviewAt);
  if (blocks) {
    // A blocking (≥ threshold) item is fixed in-spec.
    return "task";
  }
  // Below the block threshold: velocity posture routes to a new DAG spec; otherwise
  // stays as a task-here (the in-scope hint says fix-if-idle in this spec).
  if (posture.p2p3Handling === "route-to-dag") {
    return "spec";
  }
  return "task";
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
// assessment + the intelligent escalation verdict:
//   - `continue` — keep iterating the loop (progress, or the agent said keep_going).
//   - `pass`     — velocity-defer: allow the spec to pass (mild leftovers as specs).
//   - `halt`     — the agent's INTELLIGENT escalation verdict says a human must act →
//                  HALT `convergence_stalled`. NOT a count (no `maxConsecutiveStalls`).
export type ConvergenceDecision = "continue" | "pass" | "halt";

export interface ConvergenceState {
  // The number of CONSECUTIVE BLOCKING-unchanged stalls observed so far — an OBSERVABLE
  // diagnostic (NOT a bound; the loop is UNBOUNDED while the agent says keep_going). A
  // blocking `retired`/`reduced` (forward motion) RESETS it to 0; a blocking
  // `unchanged`/`regressed` increments it. Surfaced on the timeline so a slow-but-converging
  // loop is visible, but the HALT decision is the agent's escalation verdict, not this count.
  consecutiveStalls: number;
  // The per-loop BLOCKING root-cause history (oldest→newest), one `AttemptSignature` per
  // convergence check: `failureSignature` = the answerer's stable `blockingRootCauseId`,
  // `magnitude` = the loop's total kept P-score (so a shrinking trajectory reads as progress).
  // This is what the deterministic oscillation backstop (`effectiveBlockingProgress`) runs the
  // shared cycle detector over to catch a proven A→B→A→B oscillation the answerer narrated as
  // progress. NOT a counter — it is the state-trajectory the structural cycle detection reasons
  // over (a single A→B→A revisit is still treated as exploration, not yet a cycle).
  blockingHistory: ReadonlyArray<AttemptSignature>;
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

// True iff the loop's latest blocking signature actually NAMES a cause. A halt must be
// attributable — "whose bug is this?" is unanswerable when the blocker was never identified —
// so an unnamed blocker ("") never trips the floor, however structurally stuck it looks.
function namesABlockingCause(history: ReadonlyArray<AttemptSignature>): boolean {
  const latest = history.at(-1);
  return latest !== undefined && latest.failureSignature !== "";
}

// True iff the blocking root cause is STUCK this loop — the same merge-gating finding
// recurs materially `unchanged`, or `regressed` to worse. This is the v24 stall signal:
// it is driven by the BLOCKING root cause, NOT by whether peripheral findings moved.
function blockingIsStuck(progress: BlockingRootCauseProgress): boolean {
  return progress === "unchanged" || progress === "regressed";
}

/**
 * The DETERMINISTIC oscillation backstop (v40 scaffold finding) — does THIS loop's blocking
 * root cause RETURN to a state the loop was already blocked on, with no net forward motion?
 *
 * The answerer is told to assign stable ids + flag a return as a stall, but the answerer's
 * judgment is non-deterministic: on v40 it kept reading "old P1 retired + a NEW P1 appeared"
 * as PROGRESS, never noticing the NEW P1 was a RETURN to an earlier blocker (an A→B→A→B
 * oscillation). This backstop closes that gap structurally — independent of the answerer's
 * narration — by routing the blocking-root-cause-id HISTORY through THE shared
 * `assessStructuralProgress` cycle detector (the same one the writer inner loop uses): each
 * loop's blocking id is a failure signature, the total kept P-score its magnitude (so a
 * genuinely shrinking trajectory is never flagged). A structural `fixed_point` means the
 * blocker has cycled back with no net P-score reduction since — a true oscillation, NOT
 * progress. It is NOT a count: a monotone 1000→1 trajectory never trips it (every recurrence
 * net-shrinks), and a loop exploring NEW blockers stays progress.
 *
 * `history` is oldest→newest INCLUDING this loop's signature as the last element.
 */
export function blockingRootCauseOscillates(history: ReadonlyArray<AttemptSignature>): boolean {
  return assessStructuralProgress(history) === "fixed_point";
}

/**
 * The blocking-root-cause progress the policy ACTS on — the answerer's reported progress,
 * OVERRIDDEN to `regressed` (a stall) when the deterministic oscillation backstop fires (the
 * blocking root cause cycled back to a prior unresolved state). A non-oscillating loop keeps
 * the answerer's reported progress untouched. This makes a proven A→B→A→B oscillation a stall
 * even when the answerer (mis)read the individual step as `retired`.
 */
export function effectiveBlockingProgress(
  reported: BlockingRootCauseProgress,
  history: ReadonlyArray<AttemptSignature>,
): BlockingRootCauseProgress {
  return blockingRootCauseOscillates(history) ? "regressed" : reported;
}

/**
 * Apply the convergence policy. PURE. Returns the next state + the loop decision.
 *
 * INTELLIGENT NON-CONVERGENCE DETECTION (apex v35) — there is NO `maxConsecutiveStalls`
 * count. The loop is UNBOUNDED while it is PROGRESSING, and halts ONLY when the answerer's
 * intelligent escalation verdict (`escalation`) says a human must act:
 *
 *   - ESCALATE ALWAYS HALTS (Codex critic #17): the answerer's `escalate` verdict is the
 *     SEMANTIC signal the prompt binds — "human input would genuinely CHANGE the outcome"
 *     (ambiguous requirement, missing resource/credential, product/architecture decision,
 *     exhausted dead-end). It takes PRECEDENCE over any progress signal: peripheral progress
 *     on OTHER fronts does NOT unblock the reason for escalating (a missing credential is
 *     still missing even if the writer retired a different P1). The prompt itself instructs
 *     the answerer that "Slow / hard / many-attempts are NEVER reasons to escalate", so an
 *     `escalate` verdict paired with progress is a POSITIVE signal that the answerer
 *     identified a legitimate human-decision — never the v24 trajectory case (1000→1 errors),
 *     because that prompt path returns `keep_going`.
 *   - PROGRESS (blocking `retired`/`reduced`, or overall `assessment === "progress"`) with
 *     `keep_going`: `continue` and RESET the stall diagnostic to 0.
 *   - velocity_defer with `keep_going`: honor it (→ `pass`) when the policy allows, else
 *     `continue`.
 *   - SUSPECTED STALL (blocking `unchanged`/`regressed`, or overall `stalled` with no
 *     blocker) with `keep_going`: `continue` (slow/hard/a-new-approach — keep iterating,
 *     UNBOUNDED). The `consecutiveStalls` diagnostic increments for OBSERVABILITY only — it
 *     never forces a halt.
 *
 * `worstLeftoverSeverity` is the worst severity among the findings KEPT in-spec on this
 * loopback (undefined ⇒ no kept findings); it is only consulted for a `velocity_defer`.
 *
 * `loopBlocking` is THIS loop's blocking root cause for the deterministic oscillation backstop:
 * its stable id (the answerer's `blockingRootCauseId`, "" when no blocker) + the loop's total
 * kept P-score. It is appended to `state.blockingHistory`, and a structural CYCLE in that
 * history (a proven A→B→A→B oscillation with no net P-score reduction) OVERRIDES the answerer's reported
 * `blockingProgress` to `regressed` — catching an oscillation the answerer narrated as progress
 * (the v40 scaffold finding). The next state always carries the extended `blockingHistory`.
 */
export interface ConvergencePolicyInput {
  assessment: ConvergenceAssessment;
  blockingProgress: BlockingRootCauseProgress;
  escalation: ConvergenceEscalation;
  state: ConvergenceState;
  velocityPolicy: VelocityDeferPolicy;
  // THIS loop's blocking root cause for the oscillation backstop: its stable id ("" when no
  // blocker) + the loop's total kept P-score (the cycle-detector magnitude).
  loopBlocking: { id: string; pScore: number };
  // The worst severity among the findings KEPT in-spec this loopback (undefined ⇒ none kept);
  // consulted only for a `velocity_defer`.
  worstLeftoverSeverity?: FindingSeverity;
}

export function applyConvergencePolicy(input: ConvergencePolicyInput): {
  state: ConvergenceState;
  decision: ConvergenceDecision;
} {
  const { assessment, blockingProgress, escalation, state, velocityPolicy, loopBlocking, worstLeftoverSeverity } =
    input;
  // Extend the per-loop blocking-root-cause trajectory, then run the shared structural cycle
  // detector over it: a RETURN to a prior blocker with no net P-score reduction overrides the
  // answerer's reported progress to a stall (`regressed`). A non-oscillating loop is untouched.
  const blockingHistory: AttemptSignature[] = [
    ...state.blockingHistory,
    { failureSignature: loopBlocking.id, magnitude: loopBlocking.pScore },
  ];
  const effectiveProgress = effectiveBlockingProgress(blockingProgress, blockingHistory);
  // The SAME structural read, kept as its own fact because the policy now uses it TWICE: to
  // override the answerer's narration (above) AND as the floor under its verdict (below).
  const structuralFixedPoint = blockingRootCauseOscillates(blockingHistory);
  const blockerAdvanced = effectiveProgress === "retired" || effectiveProgress === "reduced";
  // ESCALATE ALWAYS HALTS (Codex critic #17). The answerer's `escalate` verdict is the
  // SEMANTIC signal — "human input would genuinely CHANGE the outcome" per the prompt (an
  // ambiguous requirement, a missing resource/credential, a real product/architecture
  // choice, or a demonstrably exhausted dead-end). It takes PRECEDENCE over any progress
  // signal: peripheral progress on OTHER fronts does NOT unblock the reason for escalating
  // (the missing credential is still missing). Previously, an `assessment === "progress"`
  // or a `retired`/`reduced` blocker returned `continue` UNCONDITIONALLY without consulting
  // the escalation verdict — an answerer that correctly flagged a human-decision was
  // silently ignored the moment any progress showed up. Stall-diagnostic accounting mirrors
  // the non-escalate branches below (reset when the blocker advanced or overall `progress`;
  // else increment) purely for observability — the halt is unconditional.
  if (escalation === "escalate") {
    // Stall accounting mirrors the keep_going branches below: a stuck blocker OR an overall
    // `stalled` with no blocker increments the diagnostic; everything else is real progress
    // and resets it. (The halt itself is unconditional — this is observability.)
    const isStall = blockingIsStuck(effectiveProgress) || (effectiveProgress === "none" && assessment === "stalled");
    const consecutiveStalls = isStall ? state.consecutiveStalls + 1 : 0;
    return { state: { consecutiveStalls, blockingHistory }, decision: "halt" };
  }
  // From here down `escalation === "keep_going"` — the intelligent verdict is "no human
  // action needed". The deterministic policy chooses continue/pass from the assessment.
  //
  // PRIMARY signal: a stuck blocking root cause is a suspected stall regardless of the overall
  // assessment — peripheral progress NEVER masks a stuck blocker (the v24 fix), and a structural
  // oscillation NEVER masks as progress (the v40 fix). With `keep_going`, we re-iterate
  // UNBOUNDED; the count is observability only.
  if (blockingIsStuck(effectiveProgress)) {
    const consecutiveStalls = state.consecutiveStalls + 1;
    // THE FLOOR. The answerer said `keep_going`, but the DETERMINISTIC detector has already
    // PROVEN a fixed point over the blocking trajectory — the same named cause recurring across
    // an intervening round with no net P-score reduction and no new state explored since.
    //
    // That proof was already being computed and then THROWN AWAY. It was allowed to override
    // the answerer's NARRATION (`retired` → `regressed`, two lines up) but not its VERDICT, so a
    // proven-stuck loop still fell through to `continue` — unbounded. Observed cost: three
    // rounds on one unchanging cause, 3h42m and ~$1.73, 52 identical writer attempts. A delivery
    // system that can MEASURE that it is stalled and keeps spending is worse than one that
    // cannot, because the information was right here and unused.
    //
    // This is NOT a give-up counter (`no-arbitrary-timeouts`): there is no threshold, no config
    // and no round count. It is the existing structural proof the codebase already trusts,
    // finally allowed to act. A shrinking P-score is never a fixed point, so a slow-but-real
    // grind is untouched — `isCycle` requires no net magnitude decrease.
    //
    // It takes the SAME exit as the answerer's own `escalate`: halt → `convergence_stalled`.
    // The halt NAMES its cause — `blockingRootCauseId` is already on `convergence.assessed`, and
    // a floor-triggered halt is distinguishable from an answerer-triggered one by the pair
    // (`escalation: "keep_going"`, `decision: "halt"`), which only this path emits.
    if (structuralFixedPoint && namesABlockingCause(blockingHistory)) {
      return { state: { consecutiveStalls, blockingHistory }, decision: "halt" };
    }
    return { state: { consecutiveStalls, blockingHistory }, decision: "continue" };
  }
  // The blocking root cause was retired/reduced (forward motion on the blocker), OR
  // there is no blocking finding. Reset on blocker progress, then honor the overall
  // assessment. (`retired`/`reduced` ⇒ never a stall: the blocker advanced.)
  if (blockerAdvanced || assessment === "progress") {
    if (assessment === "velocity_defer") {
      const decision: ConvergenceDecision = honorsVelocityDefer(velocityPolicy, state, worstLeftoverSeverity)
        ? "pass"
        : "continue";
      return { state: { consecutiveStalls: 0, blockingHistory }, decision };
    }
    return { state: { consecutiveStalls: 0, blockingHistory }, decision: "continue" };
  }
  // No blocking finding (`none`) + the overall assessment is the driver.
  if (assessment === "velocity_defer") {
    // A defer RESETS the stall diagnostic (it is not a stall — the remainder is deferred).
    const decision: ConvergenceDecision = honorsVelocityDefer(velocityPolicy, state, worstLeftoverSeverity)
      ? "pass"
      : "continue";
    return { state: { consecutiveStalls: 0, blockingHistory }, decision };
  }
  // overall `stalled` with no blocking finding + `keep_going`: re-iterate UNBOUNDED.
  const consecutiveStalls = state.consecutiveStalls + 1;
  return { state: { consecutiveStalls, blockingHistory }, decision: "continue" };
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
