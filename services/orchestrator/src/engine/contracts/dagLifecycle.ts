// The `DagLifecycleReadModel` seam (autonomy-engine.md §2c): the per-spec
// LIFECYCLE PROJECTION the DagWalker reasons over for SPECULATIVE EXECUTION. The
// Phase-1 walker only knew three scheduling buckets (pending / in-flight / done —
// `DagSpecPhase`). Speculation keys off a richer lifecycle the spec moves through
// as its run progresses:
//
//   building → pr_open → ci_green → audited{open-finding max severity} →
//   review{auto|simulated|human, verdict} → merged
//
// These states are NOT a new column. They are DERIVED (projected) from the
// SOURCE-OF-TRUTH rows already written under RLS — the spec's status + the
// terminal lifecycle events of its latest run (github.pr.created, ci.passed,
// auditor.verdict, review.approved / review.changes_requested / review.auto_approved,
// merge.completed). DAG state is the source of truth (§1.7): the projection reads
// fresh each tick, never caches. This module carries the PURE projection core
// (`projectSpecLifecycle`) so the derivation is conformance-tested with no DB,
// plus the read-model seam (the pg impl lives in `engine/dag/lifecycle.ts`).
//
// The threshold semantics that CONSUME this projection (conservative / moderate /
// aggressive) live in the planner (`engine/contracts/dagWalker.ts`,
// `specCrossedThreshold`) — this module only answers "what lifecycle state is this
// spec in, and what is its open-finding max severity + review verdict."

// ---- Lifecycle states -----------------------------------------------------

/**
 * The lifecycle state a spec occupies, ordered as a monotonic ladder the run
 * climbs. Each state IMPLIES every earlier one has been reached (a spec that is
 * `ci_green` necessarily opened a PR). The ladder order is what the speculation
 * threshold compares against (`lifecycleRank`).
 *
 *   - `pending`   — no run has started: the spec is a not-yet-scheduled candidate.
 *   - `building`  — a run is in flight but has not yet opened a PR.
 *   - `pr_open`   — the run opened a draft PR (the aggressive threshold's bar).
 *   - `ci_green`  — CI passed on the PR head (a prerequisite for the moderate bar).
 *   - `audited`   — the in-loop auditor reached a verdict (the moderate bar, when
 *                   no open P0/P1 finding remains — see `openFindingMaxSeverity`).
 *   - `review`    — the PR is awaiting / has a review verdict (auto/simulated/human).
 *   - `merged`    — the run merged to the real base branch (the conservative bar).
 *   - `blocked`   — the run terminally halted/cancelled: NOT a satisfied ancestor
 *                   at ANY threshold (a dependent cannot speculate on a dead run).
 */
export type SpecLifecycleState =
  | "pending"
  | "building"
  | "pr_open"
  | "ci_green"
  | "audited"
  | "review"
  | "merged"
  | "blocked";

/**
 * The severity of the most severe OPEN finding on the spec's audited run. The
 * moderate threshold (§2c) admits an ancestor with only P2/P3 findings but holds
 * one with an open P0/P1. `none` means audited-clean. `unaudited` means the
 * auditor has not yet reached a verdict, so severity is unknown — which the
 * moderate predicate treats as NOT-ready (audits gate: "technically complete but
 * pending automated audits is NOT ready").
 *
 * Derivation from the in-loop auditor verdict (the only per-run finding signal
 * Tanren records today, `auditor.verdict`):
 *   - `recommendedAction: "halt"`         → an irrecoverable blocker → `P0`.
 *   - `recommendedAction: "loop_to_planner"` (or `passed: false`) → a blocking
 *                                            finding that must be reworked → `P1`.
 *   - `passed: true` with `outstandingBehaviorIds` non-empty → non-blocking
 *                                            polish (the spec passed) → `P2`.
 *   - `passed: true`, no outstanding ids   → audited-clean → `none`.
 */
export type OpenFindingSeverity = "none" | "P3" | "P2" | "P1" | "P0" | "unaudited";

/** The review channel + verdict, when the spec reached the review state. */
export type ReviewChannel = "auto" | "simulated" | "human";
export type ReviewVerdict = "pending" | "approved" | "changes_requested";

export interface SpecReviewState {
  channel: ReviewChannel;
  verdict: ReviewVerdict;
}

/** The full projected lifecycle of one spec, as the walker reasons over it. */
export interface SpecLifecycle {
  specId: string;
  state: SpecLifecycleState;
  /** The most-severe OPEN finding on the audited run (drives the moderate bar). */
  openFindingMaxSeverity: OpenFindingSeverity;
  /** The review channel + verdict, present once the spec reached `review`. */
  review?: SpecReviewState;
}

// ---- Lifecycle rank (the ladder order the threshold compares) -------------

const LIFECYCLE_RANK: Record<SpecLifecycleState, number> = {
  pending: 0,
  building: 1,
  pr_open: 2,
  ci_green: 3,
  audited: 4,
  review: 5,
  merged: 6,
  // `blocked` is off the ladder: it must never satisfy a threshold, so it ranks
  // below everything reachable. A dependent on a blocked ancestor is held.
  blocked: -1,
};

/** Sortable rank of a lifecycle state on the ladder (higher = further along). */
export function lifecycleRank(state: SpecLifecycleState): number {
  return LIFECYCLE_RANK[state];
}

const SEVERITY_RANK: Record<OpenFindingSeverity, number> = {
  none: 0,
  P3: 1,
  P2: 2,
  // `unaudited` ranks ABOVE P2 (between P2 and P1): the moderate bar requires
  // audited-with-no-open-P0/P1, and an unaudited ancestor is "pending automated
  // audits" → NOT ready (it is treated as at-least-blocking for the moderate gate).
  unaudited: 3,
  P1: 4,
  P0: 5,
};

/** Sortable rank of a finding severity (higher = more severe / more blocking). */
export function severityRank(severity: OpenFindingSeverity): number {
  return SEVERITY_RANK[severity];
}

/**
 * True when the open-finding severity is a HARD blocker for the moderate
 * threshold — an open P0 or P1, OR an unaudited run (audits gate). P2/P3/none are
 * non-blocking polish the moderate bar admits.
 */
export function isBlockingForModerate(severity: OpenFindingSeverity): boolean {
  return severityRank(severity) >= severityRank("unaudited");
}

// ---- The projection input (the raw rows, neutral of the DB) ----------------

/**
 * The raw signals the projection derives a spec's lifecycle from — exactly what
 * the pg read model SELECTs, expressed neutrally so the pure core is DB-free. All
 * fields describe the spec's LATEST run (the one whose lifecycle is live); a spec
 * with no run is `pending`.
 */
export interface SpecLifecycleSignals {
  specId: string;
  /** The persisted spec status (the `merged` / `halted` / `cancelled` authority). */
  specStatus: string;
  /** Whether the latest run exists at all (false ⇒ no run started ⇒ pending). */
  hasRun: boolean;
  /** The latest run's status (queued/running/halted/…); undefined when no run. */
  runStatus?: string;
  /** The lifecycle events observed on the latest run (presence = reached). */
  prOpened: boolean;
  ciPassed: boolean;
  /** The auditor verdict on the latest run, when one was reached. */
  auditVerdict?: {
    passed: boolean;
    recommendedAction: "pass" | "loop_to_planner" | "halt";
    outstandingCount: number;
  };
  /** The review channel + verdict observed on the latest run, when any. */
  review?: SpecReviewState;
}

/**
 * The PURE lifecycle projection (no DB, no clock): map one spec's raw signals to
 * its derived {@link SpecLifecycle}. This is the behavior the conformance suite
 * pins — the single place the derivation rules live, so the pg read model and any
 * future backend produce identical states.
 *
 * Precedence (highest authority first):
 *   1. The spec's persisted terminal status wins: `merged` ⇒ merged (the run
 *      genuinely reached the real base), `halted`/`cancelled` ⇒ blocked.
 *   2. Else derive from the latest run's lifecycle events, climbing the ladder:
 *      merge.completed ⇒ merged, a review verdict ⇒ review, an audit verdict ⇒
 *      audited, ci.passed ⇒ ci_green, pr.created ⇒ pr_open, a started run ⇒
 *      building, no run ⇒ pending. A terminally-halted run with no merge ⇒ blocked.
 */
export function projectSpecLifecycle(signals: SpecLifecycleSignals): SpecLifecycle {
  const state = deriveState(signals);
  const review = signals.review;
  // `pending` (no run started) has, by definition, never been audited.
  const openFindingMaxSeverity = state === "pending" ? "unaudited" : deriveSeverity(signals);
  return {
    specId: signals.specId,
    state,
    openFindingMaxSeverity,
    ...(review !== undefined && { review }),
  };
}

/** Derive the lifecycle ladder state, persisted-status authority first. */
function deriveState(signals: SpecLifecycleSignals): SpecLifecycleState {
  // (1) Persisted spec status is the terminal authority.
  if (signals.specStatus === "merged" || signals.specStatus === "done") {
    return "merged";
  }
  if (signals.specStatus === "halted" || signals.specStatus === "cancelled") {
    return "blocked";
  }

  // (2) No run yet ⇒ a not-yet-scheduled candidate.
  if (!signals.hasRun) {
    return "pending";
  }

  // A terminally-halted run that never merged blocks dependents (a dependent
  // cannot speculate on a dead ancestor run).
  if (signals.runStatus === "halted" || signals.runStatus === "cancelled" || signals.runStatus === "failed") {
    return "blocked";
  }

  // (3) Climb the ladder from the highest event reached.
  if (signals.review !== undefined) {
    return "review";
  }
  if (signals.auditVerdict !== undefined) {
    return "audited";
  }
  if (signals.ciPassed) {
    return "ci_green";
  }
  if (signals.prOpened) {
    return "pr_open";
  }
  return "building";
}

/** Map the auditor verdict signal to the open-finding max severity (§2c). */
function deriveSeverity(signals: SpecLifecycleSignals): OpenFindingSeverity {
  const verdict = signals.auditVerdict;
  if (verdict === undefined) {
    // No audit verdict yet. If the run has not even reached CI, severity is
    // simply unknown/unaudited; once it IS audited this branch is not taken.
    return "unaudited";
  }
  if (verdict.recommendedAction === "halt") {
    return "P0";
  }
  if (verdict.recommendedAction === "loop_to_planner" || !verdict.passed) {
    return "P1";
  }
  // passed === true here. Outstanding (non-blocking) behaviors ⇒ P2 polish.
  return verdict.outstandingCount > 0 ? "P2" : "none";
}

// ---- The read-model seam ---------------------------------------------------

/**
 * A point-in-time projection of every spec's lifecycle in a project, loaded under
 * RLS. The pg impl org-scopes the read (an off-scope read sees zero rows). Read
 * fresh every walker tick — DAG state is the source of truth, never cached.
 */
export interface DagLifecycleSnapshot {
  projectId: string;
  /** The lifecycle of every spec in the project, keyed by spec id. */
  bySpecId: Map<string, SpecLifecycle>;
}

/**
 * Loads the project's per-spec lifecycle projection under RLS — the speculation
 * input the DagWalker reasons over alongside the `DagSnapshot`. The pg impl lives
 * in `engine/dag/lifecycle.ts`; the conformance suite drives this seam.
 */
export interface DagLifecycleReadModel {
  loadLifecycle(projectId: string): Promise<DagLifecycleSnapshot>;
}
