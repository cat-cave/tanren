// The `ChangePercolation` seam (autonomy-engine.md §2c "Change-percolation — NOT
// discard"). This is the DIFFERENTIATOR: when an ANCESTOR A changes AFTER its
// dependents B, C started speculatively (a reviewer pushes new commits to A, a new
// P0/P1 finding lands, A is changes-requested, a P2/P3 patch applies), the walker
// must NOT throw away B's and C's work. It treats A's change as a DELTA to
// PERCOLATE down the chain: rebuild B's speculative integration with A's NEW state
// (reusing the P2c-1 SpeculativeIntegrator), re-base + re-gate B (reusing the
// P2a/P2b re-gate), and on a conflict/semantic-break invoke the P2b intent-
// preserving resolver in UPSTREAM-CHANGE mode (apply A's intentional change INTO B
// while keeping B's work intact). Then percolate B's resulting delta into C the
// same way. It is a CHAIN RE-INTEGRATION, not a rollback.
//
// This module carries the SEAMS the coordinator composes (the integrated-SHA read
// model · the percolation operation · the chain event emitter) PLUS the PURE
// decision core (`decidePercolation`) so the detect/sever/promptness logic is
// conformance-tested with no DB, runner, or model. The pg/runner wirings live in
// `engine/dag/percolation.ts`; the upstream-change mode of the resolver reuses the
// P2b `decideConflictResolution` core + `ResolvedTreeReGate` + `ReplanRouter`.
//
// The three INVARIANTS this seam enforces (what the verifier hammers):
//   - NEVER DISCARD — a percolation that cannot reconcile routes the dependent
//     back to the planner WITH the upstream change as context (the P2b replan
//     path); it never drops the work.
//   - NEVER MERGE UNVERIFIED — a percolated dependent only becomes mergeable after
//     a CLEAN re-gate against its new base; the P2c-1 merge-hold still governs the
//     actual merge.
//   - TERMINATES — percolation keys off the integrated-SHA DIVERGENCE, so a no-op
//     change (same SHA) never re-triggers (no infinite re-percolation loop).

import type { OpenFindingSeverity, ReviewVerdict } from "./dagLifecycle.js";

// ---- The ancestor-change signal (what the detect step reads) ---------------

/**
 * The promptness an ancestor change demands (§2c "severity gates promptness"):
 *
 *   - `immediate` — an open P0/P1 finding OR a changes-requested verdict on the
 *     ancestor: the chain MUST absorb the change before any merge, so the
 *     percolation runs NOW (rebuild → re-base → re-gate).
 *   - `lazy`      — a non-blocking P2/P3 change: batched into the dependent's next
 *     rebase rather than a prompt re-integration (nothing is silently merged on
 *     stale work, but nothing is needlessly re-gated either).
 *   - `none`      — no actionable change: either the ancestor head SHA still
 *     matches the integrated SHA (a NO-OP — the termination key) or the ancestor's
 *     state is audited-clean with the same SHA. The dependent is left untouched.
 */
export type PercolationPromptness = "immediate" | "lazy" | "none";

/** The concrete blocking reason that made a percolation `immediate` (for the event). */
export type ImmediateSeverity = "P0" | "P1" | "changes_requested";
/** The non-blocking reason that made a percolation `lazy` (for the deferred event). */
export type LazySeverity = "P2" | "P3";

/**
 * One ancestor's CURRENT state vs. what a dependent's speculative run integrated
 * against — the input the pure decision reasons over per ancestor.
 */
export interface AncestorChangeSignal {
  ancestorSpecId: string;
  /** The ancestor head SHA the dependent INTEGRATED against (the recorded base). */
  integratedSha: string;
  /** The ancestor's CURRENT head SHA (read fresh from the forge each detect). */
  currentSha: string;
  /** The ancestor's current open-finding max severity (the audited verdict). */
  openFindingMaxSeverity: OpenFindingSeverity;
  /** The ancestor's current review verdict, when it reached review. */
  reviewVerdict?: ReviewVerdict;
}

/** The per-ancestor decision the coordinator acts on. */
export interface PercolationDecision {
  ancestorSpecId: string;
  promptness: PercolationPromptness;
  fromSha: string;
  toSha: string;
  /** Present when `immediate`: the blocking reason that forced prompt percolation. */
  immediateSeverity?: ImmediateSeverity;
  /** Present when `lazy`: the non-blocking severity batched into the next rebase. */
  lazySeverity?: LazySeverity;
}

/**
 * The PURE per-ancestor percolation decision (no DB, no I/O, no clock) — the §2c
 * detect + severity→promptness gate, and the TERMINATION key. This is the behavior
 * the conformance suite pins.
 *
 * Rules, in order:
 *   1. SHA UNCHANGED + no changes-requested ⇒ `none`. The integrated SHA still
 *      matches the ancestor head, so there is NOTHING to percolate — the key that
 *      makes a no-op re-trigger terminate (no infinite re-percolation loop). A
 *      changes-requested verdict with an UNCHANGED sha is still actionable (the
 *      reviewer's request must be absorbed even before the author pushes), so it is
 *      NOT short-circuited here — it falls through to the immediate gate.
 *   2. A blocking change ⇒ `immediate`: an open P0/P1 finding OR a
 *      changes-requested verdict. The chain must absorb it before merging.
 *   3. A non-blocking divergence (sha changed, only P2/P3/none findings, no
 *      changes-requested) ⇒ `lazy`: batched into the next rebase. `none`/`P3`
 *      report `P3`; `P2` reports `P2` (the more-actionable label).
 *
 * A `blocked`-ancestor severity (`unaudited` is treated as non-blocking-divergent
 * here: an ancestor that regressed to unaudited but advanced its SHA is a real
 * change to fold in lazily; the moderate THRESHOLD — handled by the walker, not
 * here — separately decides whether the dependent should even still speculate).
 */
export function decidePercolation(signal: AncestorChangeSignal): PercolationDecision {
  const base = { ancestorSpecId: signal.ancestorSpecId, fromSha: signal.integratedSha, toSha: signal.currentSha };
  const shaChanged = signal.currentSha !== signal.integratedSha;
  const changesRequested = signal.reviewVerdict === "changes_requested";

  // (1) Termination key: nothing diverged and no outstanding review request ⇒ no-op.
  if (!shaChanged && !changesRequested) {
    return { ...base, promptness: "none" };
  }

  // (2) Blocking ⇒ immediate. changes-requested wins the label (it is the most
  //     actionable upstream signal); else an open P0/P1.
  if (changesRequested) {
    return { ...base, promptness: "immediate", immediateSeverity: "changes_requested" };
  }
  if (signal.openFindingMaxSeverity === "P0") {
    return { ...base, promptness: "immediate", immediateSeverity: "P0" };
  }
  if (signal.openFindingMaxSeverity === "P1") {
    return { ...base, promptness: "immediate", immediateSeverity: "P1" };
  }

  // (3) A real divergence with only non-blocking findings ⇒ lazy. (Reached only
  //     when shaChanged is true — the !shaChanged + !changesRequested case
  //     short-circuited at (1).)
  return { ...base, promptness: "lazy", lazySeverity: signal.openFindingMaxSeverity === "P2" ? "P2" : "P3" };
}

// ---- The integrated-SHA read model (detect ancestor change) ----------------

/** A dependent speculative run + the per-ancestor SHAs it integrated against. */
export interface SpeculativeDependent {
  specId: string;
  runId: string;
  /** The dynamic base (integration branch) the dependent's PR is built on. */
  speculativeBase: string;
  /** The ancestor head SHAs this run integrated against, keyed by ancestor spec id. */
  integratedAncestorShas: Record<string, string>;
}

/**
 * Reads, under RLS, the project's IN-FLIGHT SPECULATIVE dependents (runs carrying a
 * `speculative_base` + a non-empty `integrated_ancestor_shas` map) together with
 * each ancestor's CURRENT head SHA + lifecycle severity — exactly the
 * {@link AncestorChangeSignal}s `decidePercolation` consumes. DAG state is the
 * source of truth: read fresh each detect, org-scoped (an off-scope read sees
 * zero rows). It NEVER mutates — detection is read-only.
 */
export interface PercolationReadModel {
  /** The in-flight speculative dependents whose integrated SHAs may have diverged. */
  loadSpeculativeDependents(projectId: string): Promise<SpeculativeDependent[]>;
  /**
   * The CURRENT per-ancestor change signals for one dependent (current head SHA +
   * the ancestor's open-finding max severity + review verdict). Keyed by ancestor
   * spec id so the coordinator zips them against the recorded integrated SHAs.
   */
  loadAncestorSignals(input: { projectId: string; dependent: SpeculativeDependent }): Promise<AncestorChangeSignal[]>;
}

// ---- The percolation operation (chain re-integration, not rollback) --------

/**
 * The outcome of percolating ONE ancestor change into ONE dependent. `absorbed`:
 * the integration was rebuilt against the ancestor's new state, re-based, and the
 * re-gate passed (the dependent's work is preserved + verified). `replanned`: the
 * change could not be reconciled (resolver irreconcilable / re-gate failed) so the
 * dependent was routed back to the planner WITH the change as context — NOT
 * discarded, NOT merged. `held`: the rebuild itself surfaced an ancestor-vs-
 * ancestor conflict (routed to the P2b resolver as in P2c-1) — retried next walk.
 */
export interface PercolationOutcome {
  result: "absorbed" | "replanned" | "held";
  ancestorSpecId: string;
  /** The ancestor SHA now integrated (on `absorbed`) — the new divergence key. */
  newIntegratedSha?: string;
  /** True when the intent-preserving resolver (upstream-change mode) reconciled a break. */
  viaResolver: boolean;
  /** The irreconcilable diagnosis (on `replanned`) / hold detail (on `held`). */
  reason?: string;
}

/**
 * Performs the §2c chain re-integration for ONE (dependent, ancestor-change):
 *   1. Rebuild the dependent's speculative integration against the ancestor's NEW
 *      state (reuse the P2c-1 SpeculativeIntegrator). An A-vs-other-ancestor
 *      conflict ⇒ `held` (routed to P2b, retried next walk).
 *   2. Re-base + re-gate the dependent against the new integration (reuse the
 *      P2a/P2b re-gate). A clean re-gate ⇒ `absorbed` (the dependent's work intact).
 *   3. A conflict/semantic-break ⇒ invoke the P2b resolver in UPSTREAM-CHANGE mode
 *      (apply A's intentional change INTO B keeping B's work), then re-gate again.
 *      A clean re-gate ⇒ `absorbed { viaResolver: true }`; still irreconcilable / a
 *      failed re-gate ⇒ `replanned` (back to the planner with the change as
 *      context — NEVER discarded, NEVER merged unverified).
 * It records the new integrated SHA on the dependent's run on `absorbed`, so a
 * subsequent detect with the same SHA is a no-op (termination).
 */
export interface PercolationOperation {
  percolate(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
  }): Promise<PercolationOutcome>;
}

// ---- The chain event emitter ----------------------------------------------

/** Emits the §2c percolation visibility events (the production impl is org-scoped). */
export interface PercolationEventEmitter {
  emitPercolating(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    fromAncestorSha: string;
    toAncestorSha: string;
    severity: ImmediateSeverity;
  }): Promise<void>;
  emitPercolated(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    integratedAncestorSha: string;
    viaResolver: boolean;
  }): Promise<void>;
  emitPercolationDeferred(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    pendingAncestorSha: string;
    severity: LazySeverity;
  }): Promise<void>;
  emitPercolationReplan(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    ancestorSha: string;
    reason: string;
  }): Promise<void>;
}
