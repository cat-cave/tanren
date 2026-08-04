// Shared TYPES for the re-drive convergence-facts contract — extracted so the Pg-backed
// reader (`redriveHistoryReader.ts`) and the applier (`plannerRunRedrive.ts`) can both
// import them without circling. Pure type declarations; no runtime.

import type { RunFailureCause, RunFailureCode } from "../worker/runFailureClassifier.js";
import type { WanderingHaltVerdict } from "./wanderingHaltDetector.js";

/** Facts a fixed-point read needs: the spec + its org + the failure code + the work signature now seen. */
export interface RedriveHistoryFacts {
  orgId: string;
  specId: string;
  /** The classified failure code of the CURRENT failure. Retained as the FALLBACK
   * fixed-point axis, used for history rows written before `cause` existed. */
  code: RunFailureCode;
  /** The FINE-GRAINED cause of the CURRENT failure — the PRIMARY fixed-point axis. The
   * code alone proved far too coarse (93% of live run failures classified `internal`), so
   * three categorically different causes aliased into ONE repeating state and parked the
   * spec. Optional only so a caller that cannot compute it degrades to the old code-keyed
   * behavior rather than failing. */
  cause?: RunFailureCause;
  /** The run STAGE the CURRENT failure is attributed to. Used by the wandering-halt
   * detector (apex v67 #122) as one progress axis — a later-stage failure than every
   * prior re-drive is deliverable progress. The fixed-point detector ignores this. */
  stage: string;
  /** The produced-work signature of the CURRENT run (the head/commit sha), when observable. */
  workSignature?: string;
}

/** The full convergence facts the authority reasons over: the fixed-point streak (PR #710 —
 * same failure recurring) + the wandering-halt verdict (apex v67 #122 — N re-drives with
 * different failures but no deliverable progress). Coalesced into ONE org-scoped read. */
export interface RedriveConvergenceFacts {
  priorSameFixedPoint: number;
  wandering: WanderingHaltVerdict;
}

/**
 * The reader's read outcome — a discriminated union that DISTINGUISHES a
 * successful read from a DB read FAILURE (audit C2 #3 — silent-fallback
 * hardening). Before this fix the reader's `catch` silently returned facts
 * equivalent to "first attempt of its kind" (priorSameFixedPoint: 0),
 * CONFLATING a genuinely-empty history with a broken read. Under a repeated DB
 * blip a genuinely-stuck spec re-drove FOREVER because the persistent-failure +
 * the wandering-halt escalation branches were SILENTLY DISABLED.
 *
 * With the union, the caller (`readConvergenceFacts`) EXPLICITLY distinguishes:
 *
 *   • `ok` — the read succeeded; use the returned facts to decide re-drive vs
 *     genuine-halt via the standard authority.
 *   • `read_failed` — the read threw; the caller DEFERS escalation for this
 *     tick, forces a RE-DRIVE (never a genuine-halt on unknown facts), and
 *     surfaces the failure LOUDLY. The next tick's read will retry — a
 *     transient DB hiccup does NOT silently disable the escalation semantics.
 */
export type RedriveHistoryReadResult =
  | ({ kind: "ok" } & RedriveConvergenceFacts)
  | { kind: "read_failed"; error: unknown };

/**
 * Read the convergence facts for a spec (the fixed-point streak + the wandering-halt
 * verdict). Computed via the shared `convergenceDetector` and `wanderingHaltDetector`
 * over the spec's `dag.spec.redriven` history + PR/merge markers. A DIFFERENT failure
 * code OR DIFFERENT produced work (PROGRESS) breaks the fixed-point streak, so the loop
 * is UNBOUNDED while it keeps changing; the wandering-halt detector catches the case
 * where every re-drive's failure differs but no deliverable progress is being made.
 *
 * The reader NEVER throws — a DB read failure is surfaced via the `read_failed`
 * discriminant of {@link RedriveHistoryReadResult} so the caller can apply an
 * EXPLICIT policy (defer escalation, log observably) rather than silently
 * degrade to zero-history semantics.
 */
export type RedriveHistoryReader = (facts: RedriveHistoryFacts) => Promise<RedriveHistoryReadResult>;
