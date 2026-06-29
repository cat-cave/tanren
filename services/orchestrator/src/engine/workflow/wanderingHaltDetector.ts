// THE WANDERING-HALT DETECTOR (apex v67 finding #122 — the second convergence signal).
//
// THE PROBLEM the existing fixed-point detector misses: the convergence detector
// (`convergenceDetector.ts`, PR #710 canonicalization) keys on the FAILURE SIGNATURE
// (failureCode + stage + canonicalized work). When successive re-drives produce DIFFERENT
// failure signatures, `consecutiveSameFailure` stays at 1 — it never reaches the threshold,
// and the spec re-drives indefinitely against the budget ceiling.
//
// apex v67 caught the canonical instance: the in_flight scaffold spec re-drove with
// `failureCode=workspace stage=workspace` → `failureCode=internal stage=agent` → still
// re-driving when the operator halted v67. The fixed-point judge NEVER fires (each failure
// differs), AND no deliverable progress is being made (no PR opened, no spec merged). This
// is the "wandering halt": not converged, not progressing — bounded by nothing but the
// $50 budget.
//
// THE RULE this detector adds — distinct from (and SECONDARY to) the fixed-point detector:
// count CONSECUTIVE re-drives at the trailing edge of the spec's history that made ZERO
// deliverable progress. A re-drive made DELIVERABLE PROGRESS iff it strictly advanced one
// of:
//   (a) reached a NEW max STAGE that prior re-drives had not reached (bootstrap →
//       credentials → workspace → agent → merge → deploy → run / finalize),
//   (b) opened a PR on the forge for the spec (`github.pr.created`),
//   (c) merged the PR (`merge.completed`).
// Without one of these, the re-drive is wandering. Once the trailing no-progress streak
// reaches the threshold, escalate to `dag.spec.needs_attention` with
// `source: "wandering_halt"` (distinct from `"strand"` so an operator can tell the two
// patterns apart — a strand is the same failure repeating; a wandering halt is many
// different failures with no forward motion).
//
// THIS IS AN UPPER BOUND, NOT A REPLACEMENT for the fixed-point detector. The fixed-point
// judge still drives the primary convergence path (the SAME-failure case, escalated with
// `source: "strand"`). The wandering-halt detector catches the changing-failure-no-progress
// trap the fixed-point judge structurally cannot see. The threshold is intentionally LOOSE
// (default 5) so a spec with genuine forward motion across a varied failure surface is
// never spuriously caught — only one that genuinely cannot make any deliverable progress.

/**
 * Default re-drive threshold above which a wandering halt fires — the trailing run of
 * no-progress re-drives required to escalate. Intentionally loose (5) so a spec that
 * varies its failure surface but is genuinely advancing the pipeline / opening a PR is
 * never caught; only one with zero forward motion across five re-drives is.
 */
export const DEFAULT_WANDERING_HALT_THRESHOLD = 5;

/**
 * The closed STAGE vocabulary (mirrors `RunFailureStage` in `runFailureClassifier.ts`)
 * ordered by pipeline position. The detector compares ranks: a re-drive that fails at a
 * LATER stage than every prior re-drive made deliverable progress (the spec got further
 * through the pipeline before failing). An unknown stage label falls back to rank 0 (the
 * detector treats it as no advancement; safer than ranking it above a known stage).
 */
const STAGE_ORDER: ReadonlyArray<string> = [
  "bootstrap",
  "credentials",
  "workspace",
  "agent",
  "merge",
  "deploy",
  "run",
  "finalize",
];

function stageRank(stage: string): number {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx === -1 ? 0 : idx;
}

/**
 * The history element this detector reasons over — one prior re-drive's diagnostic facts
 * + the cumulative spec-level progress markers AT OR BEFORE that re-drive. The caller
 * assembles this list (oldest → newest, the current/candidate re-drive INCLUDED at the
 * tail) from the durable event log.
 */
export interface WanderingAttempt {
  /** The classified failure code of THIS re-drive (diagnostic only — used to surface the
   * distinct-failure-codes list on the escalation event so an operator can tell at a
   * glance that the spec wandered across many failure classes vs. repeated one). */
  failureCode: string;
  /** The run STAGE the failure is attributed to. The detector's primary progress axis:
   * a re-drive at a later stage than every prior re-drive made deliverable progress. */
  stage: string;
  /** Whether `github.pr.created` was emitted for the spec AT OR BEFORE this re-drive's
   * terminal time. Monotonic (once true, true for every later attempt). */
  prCreatedSoFar: boolean;
  /** Whether `merge.completed` was emitted for the spec AT OR BEFORE this re-drive's
   * terminal time. Monotonic. (A spec whose PR merged before this re-drive would not
   * normally still be re-driving — guard the axis anyway.) */
  mergeCompletedSoFar: boolean;
}

export interface WanderingHaltOptions {
  /** Override the default no-progress streak threshold (the loose upper bound — 5 by
   * default). Floored at 2 (a single re-drive cannot wander; one prior must exist to
   * compare against). */
  threshold?: number;
}

export type WanderingHaltVerdict =
  | { wandering: false }
  | {
      wandering: true;
      /** The trailing run of no-progress re-drives that crossed the threshold. */
      noProgressStreak: number;
      /** Total re-drives in the assessed history (the current attempt included). */
      totalRedrives: number;
      /** The distinct failure codes seen across the wandering history — the diagnostic
       * that distinguishes a wandering halt from a strand at a glance (a strand has ONE
       * code; a wandering halt has MANY). */
      distinctFailureCodes: string[];
    };

/**
 * Assess whether the spec is in a WANDERING halt. PURE — no I/O, no clock. The `history`
 * is oldest → newest, the candidate (current) re-drive INCLUDED at the tail. Walks the
 * history once tracking the max stage reached + the monotonic PR/merge markers, marks
 * each attempt as `advanced` iff it strictly extended ANY progress axis over the prior
 * state, then checks whether the trailing window of `threshold` attempts contains NO
 * advancement. The FIRST attempt does NOT count as advancement (there is no prior to
 * compare against — it establishes the baseline only); a fresh spec's very first
 * re-drive is structurally no-progress until the spec has another re-drive to compare to.
 *
 * Threshold semantics: `threshold = N` ⇒ wandering fires once N consecutive trailing
 * attempts (including the candidate) all failed to advance the state. With default 5,
 * the 5th re-drive is the first one that can fire (and only if none of attempts 1..5
 * extended the max stage, opened a PR, or merged).
 *
 * Cross-check with the SAME-failure case: the fixed-point detector fires FIRST (at the
 * 2nd or 3rd same-code repeat), so a same-failure spec never reaches this detector's
 * threshold — the disposition core consults this only AFTER the fixed-point check
 * returns "progress" (a different failure than last time).
 */
export function assessWanderingHalt(
  history: ReadonlyArray<WanderingAttempt>,
  options: WanderingHaltOptions = {},
): WanderingHaltVerdict {
  const threshold = Math.max(2, options.threshold ?? DEFAULT_WANDERING_HALT_THRESHOLD);
  if (history.length < threshold) return { wandering: false };
  let maxStageRank = -1;
  let priorPrCreated = false;
  let priorMergeCompleted = false;
  const advancedPerAttempt: boolean[] = [];
  for (let i = 0; i < history.length; i += 1) {
    const attempt = history[i];
    if (attempt === undefined) continue;
    const rank = stageRank(attempt.stage);
    // The FIRST attempt establishes the baseline (no prior to compare against — it
    // cannot have "advanced" over anything). Every later attempt is judged against the
    // cumulative state going into it.
    const advanced =
      i > 0 &&
      (rank > maxStageRank ||
        (attempt.prCreatedSoFar && !priorPrCreated) ||
        (attempt.mergeCompletedSoFar && !priorMergeCompleted));
    advancedPerAttempt.push(advanced);
    if (rank > maxStageRank) maxStageRank = rank;
    if (attempt.prCreatedSoFar) priorPrCreated = true;
    if (attempt.mergeCompletedSoFar) priorMergeCompleted = true;
  }
  // Trailing window of `threshold` attempts: wandering iff NONE of them advanced.
  const windowStart = advancedPerAttempt.length - threshold;
  for (let i = windowStart; i < advancedPerAttempt.length; i += 1) {
    if (advancedPerAttempt[i] === true) return { wandering: false };
  }
  const distinct = Array.from(new Set(history.map((a) => a.failureCode)));
  return {
    wandering: true,
    noProgressStreak: threshold,
    totalRedrives: history.length,
    distinctFailureCodes: distinct,
  };
}
