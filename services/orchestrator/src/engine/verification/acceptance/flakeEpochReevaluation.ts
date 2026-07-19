// mq-7 — EPOCH re-evaluation: the decision that forbids a flake quarantine from silently
// persisting across code generations and masking a real regression.
//
// rv-17 quarantines a behavior when its recorded verdicts show a REAL pass↔fail conflict, but it
// NEVER re-examined an already-quarantined behavior — so a quarantine, once set, would persist
// forever. If a later code generation turned that same behavior into a DETERMINISTIC failure, the
// stale quarantine would keep excluding it from the gate and HIDE the regression. That is the
// gravest failure this node exists to prevent.
//
// The EPOCH is the artifact_digest — a content-addressed generation marker. A quarantine is proven
// in ONE epoch (the generation whose verdicts evidenced the flake). When the behavior is observed
// again in a DIFFERENT (newer) epoch, the quarantine is re-evaluated against THAT generation's own
// classification (re-run outcomes within the new epoch — never a guess, never the old evidence):
//
//   • still `flaky`               → REAFFIRM: the non-determinism reproduces in the new generation;
//                                   the quarantine holds, re-stamped to the new epoch.
//   • `consistent_failure`        → RELEASE (regression): the behavior now deterministically fails —
//                                   what the quarantine was masking is a REAL regression. Release it
//                                   so the failure reaches the gate/bisection. THE anti-masking rule.
//   • `stable`                    → RELEASE (recovered): the flake stopped; the behavior consistently
//                                   passes in the new generation, so the exclusion is lifted.
//   • `insufficient_observation`  → DEFER: no decisive evidence in the new epoch yet. Nothing decisive
//                                   is being masked (no decisive failure exists), so the quarantine is
//                                   held one more generation until a decisive verdict arrives — which
//                                   re-triggers this exact re-evaluation. It CANNOT mask a regression:
//                                   the first decisive failure flips it to `consistent_failure` above.
//
// Within the SAME epoch the quarantine simply holds — the flake was proven in that generation and no
// new generation has appeared to re-evaluate against.
//
// Bias: when the new generation's evidence is anything OTHER than a re-proven `flaky` conflict, the
// quarantine does not extend on the strength of the flaky label — a genuine regression is never
// re-labelled a flake. Insufficient evidence never manufactures a flaky verdict.

import type { FlakeClassification } from "./flakeClassification.js";

/**
 * The re-evaluation outcome for an already-quarantined behavior on a newly-observed epoch.
 *   • `reaffirm`            — re-proven flaky in the new generation; record a fresh quarantine.
 *   • `release_regression`  — the new generation fails deterministically; release to unmask it.
 *   • `release_recovered`   — the new generation is stable; release, the flake is gone.
 *   • `defer`               — no decisive evidence in the new generation yet; hold, do not write.
 *   • `hold_same_epoch`     — the observation is the SAME epoch the quarantine was proven in; hold.
 */
export type QuarantineReevaluation =
  | "reaffirm"
  | "release_regression"
  | "release_recovered"
  | "defer"
  | "hold_same_epoch";

export interface EpochReevaluationInput {
  /** The epoch (artifact_digest) the ACTIVE quarantine was last proven in. */
  readonly quarantinedEpoch: string;
  /** The epoch (artifact_digest) currently being observed. */
  readonly observedEpoch: string;
  /** The classification computed from the OBSERVED epoch's own recorded verdicts. */
  readonly observedClassification: FlakeClassification;
}

/**
 * Decide what to do with an already-quarantined behavior given a fresh observation. Pure: it maps
 * the observed generation's classification to a re-evaluation, encoding the anti-masking doctrine.
 * A same-epoch observation holds the quarantine unchanged (no new generation to re-evaluate).
 */
export function reevaluateQuarantineOnEpoch(input: EpochReevaluationInput): QuarantineReevaluation {
  if (input.observedEpoch === input.quarantinedEpoch) return "hold_same_epoch";
  switch (input.observedClassification) {
    case "flaky":
      return "reaffirm";
    case "consistent_failure":
      // The masked behavior now deterministically fails — a REAL regression. Never keep it hidden.
      return "release_regression";
    case "stable":
      return "release_recovered";
    case "insufficient_observation":
      // No decisive evidence in the new generation; nothing decisive is masked. Hold, do not extend.
      return "defer";
    default: {
      const exhaustive: never = input.observedClassification;
      return exhaustive;
    }
  }
}

/** Whether a re-evaluation lifts the quarantine (records a `release` transition). */
export function isRelease(reevaluation: QuarantineReevaluation): boolean {
  return reevaluation === "release_regression" || reevaluation === "release_recovered";
}
