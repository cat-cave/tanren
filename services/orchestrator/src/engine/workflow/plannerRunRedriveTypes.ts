// Shared TYPES for the re-drive convergence-facts contract — extracted so the Pg-backed
// reader (`redriveHistoryReader.ts`) and the applier (`plannerRunRedrive.ts`) can both
// import them without circling. Pure type declarations; no runtime.

import type { RunFailureCode } from "../worker/runFailureClassifier.js";
import type { WanderingHaltVerdict } from "./wanderingHaltDetector.js";

/** Facts a fixed-point read needs: the spec + its org + the failure code + the work signature now seen. */
export interface RedriveHistoryFacts {
  orgId: string;
  specId: string;
  /** The classified failure code of the CURRENT failure (one fixed-point axis). */
  code: RunFailureCode;
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
 * Read the convergence facts for a spec (the fixed-point streak + the wandering-halt
 * verdict). Computed via the shared `convergenceDetector` and `wanderingHaltDetector`
 * over the spec's `dag.spec.redriven` history + PR/merge markers. A DIFFERENT failure
 * code OR DIFFERENT produced work (PROGRESS) breaks the fixed-point streak, so the loop
 * is UNBOUNDED while it keeps changing; the wandering-halt detector catches the case
 * where every re-drive's failure differs but no deliverable progress is being made.
 */
export type RedriveHistoryReader = (facts: RedriveHistoryFacts) => Promise<RedriveConvergenceFacts>;
