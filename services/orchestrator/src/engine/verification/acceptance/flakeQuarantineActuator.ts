// rv-17 + mq-7 — the flake-quarantine ACTUATOR: the production hook that runs AFTER a run's behavior
// verdicts are recorded (wired into the rv-16a post-merge production behavior-verdict lane, which
// is driven live by BOTH the resolution walker and the operator-retry route). For one behavior it:
//   1. classifies the flake state from the RECORDED verdicts of the OBSERVED epoch (this
//      artifact_digest + verification purpose) via the store — a real function of the attempts,
//      never guessed; then
//   2. when the behavior is NOT quarantined and the observed epoch is `flaky` (a real pass↔fail
//      conflict), persists a `quarantine` governance transition (append-only, evidence-bearing)
//      stamped with the epoch it was proven in; OTHERWISE
//   3. (mq-7) when the behavior IS already quarantined, RE-EVALUATES the quarantine against the
//      newly-observed epoch ({@link reevaluateQuarantineOnEpoch}): a re-proven flake REAFFIRMS,
//      a now-deterministic failure RELEASES to unmask the regression, a recovered behavior
//      RELEASES, and an as-yet-undecided new epoch DEFERS. The same epoch simply holds.
//
// This is what makes the mechanism LIVE: without step 2 the quarantine table stays empty in
// production; without step 3 a quarantine could persist across code generations and HIDE a real
// regression. It is best-effort at the call site (a classification failure must never break verdict
// recording or the deploy decision). It NEVER launders anything: a quarantine/reaffirm carries only
// 'excluded_from_green', and a release carries only 'restored' — the 0085 shape CHECK forbids any
// green effect on either.

import type { FlakeClassification, FlakeClassificationResult } from "./flakeClassification.js";
import type { QuarantineTransitionRecord } from "./behaviorQuarantineGovernance.js";
import { reevaluateQuarantineOnEpoch } from "./flakeEpochReevaluation.js";

/** The (behavior, artifact, purpose) window the classifier reads its RECORDED verdicts over. */
export interface FlakeClassificationScope {
  readonly orgId: string;
  readonly projectId: string;
  readonly behaviorRevisionId: string;
  readonly artifactDigest: string;
  /** The verification purpose the conflict must occur WITHIN (e.g. `post_merge_production`). */
  readonly purpose: string;
}

/** The narrow store the actuator needs — satisfied by PgBehaviorQuarantineStore. */
export interface FlakeQuarantineActuatorStore {
  classifyBehaviorFlake(scope: FlakeClassificationScope): Promise<FlakeClassificationResult>;
  /** The ACTIVE quarantine's epoch, or undefined when the behavior is not currently quarantined. */
  readActiveQuarantine(
    scope: { readonly orgId: string; readonly projectId: string },
    behaviorRevisionId: string,
  ): Promise<{ readonly epoch: string } | undefined>;
  recordTransition(record: QuarantineTransitionRecord): Promise<string>;
}

/**
 * The action the actuator took for one behavior.
 *   • `quarantined`          — a newly-proven flake was quarantined.
 *   • `not_flaky`            — not quarantined and not flaky in the observed epoch: no action.
 *   • `already_quarantined`  — quarantined, and the observation is the SAME epoch it was proven in.
 *   • `reaffirmed`           — quarantined, and re-proven flaky in a NEW epoch (fresh quarantine row).
 *   • `released_regression`  — quarantined, but the NEW epoch fails deterministically: released to
 *                              unmask the regression (the mq-7 anti-masking guarantee).
 *   • `released_recovered`   — quarantined, but the NEW epoch is stable: released, the flake is gone.
 *   • `deferred`             — quarantined, and the NEW epoch has no decisive evidence yet: held.
 */
export type FlakeQuarantineAction =
  | "quarantined"
  | "already_quarantined"
  | "not_flaky"
  | "reaffirmed"
  | "released_regression"
  | "released_recovered"
  | "deferred";

export interface FlakeQuarantineOutcome {
  readonly behaviorRevisionId: string;
  readonly action: FlakeQuarantineAction;
  readonly classification: FlakeClassification;
  readonly quarantineId?: string;
}

export interface FlakeQuarantineActuationInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly behaviorRevisionId: string;
  readonly artifactDigest: string;
  readonly purpose: string;
  /** The runtime_behavior_context_hash the classification was observed in — stored on the record. */
  readonly contextHash: string;
  /** The governance actor recorded as WHO quarantined (e.g. the automated classifier identity). */
  readonly actor: string;
}

/**
 * Classify one behavior from its recorded verdicts (the OBSERVED epoch = this artifact_digest) and
 * either open a new quarantine on a proven flake, or RE-EVALUATE an existing quarantine against the
 * newly-observed generation. Never a launderer: a quarantine/reaffirm is 'excluded_from_green', a
 * release is 'restored' — neither can carry a green effect (0085 shape CHECK).
 */
export async function actuateFlakeQuarantine(
  store: FlakeQuarantineActuatorStore,
  input: FlakeQuarantineActuationInput,
): Promise<FlakeQuarantineOutcome> {
  const scope: FlakeClassificationScope = {
    orgId: input.orgId,
    projectId: input.projectId,
    behaviorRevisionId: input.behaviorRevisionId,
    artifactDigest: input.artifactDigest,
    purpose: input.purpose,
  };
  const result = await store.classifyBehaviorFlake(scope);
  const active = await store.readActiveQuarantine(
    { orgId: input.orgId, projectId: input.projectId },
    input.behaviorRevisionId,
  );

  if (active === undefined) {
    // Not currently quarantined: open a quarantine ONLY on a decisive flaky conflict; otherwise
    // there is nothing to do (a plain regression is handled by the ordinary gate, not by us).
    if (result.classification !== "flaky") {
      return {
        behaviorRevisionId: input.behaviorRevisionId,
        action: "not_flaky",
        classification: result.classification,
      };
    }
    const quarantineId = await store.recordTransition(quarantineRecord(input, result, "auto-quarantine"));
    return {
      behaviorRevisionId: input.behaviorRevisionId,
      action: "quarantined",
      classification: "flaky",
      quarantineId,
    };
  }

  // mq-7 — already quarantined: re-evaluate against the epoch we just observed.
  const reevaluation = reevaluateQuarantineOnEpoch({
    quarantinedEpoch: active.epoch,
    observedEpoch: input.artifactDigest,
    observedClassification: result.classification,
  });
  switch (reevaluation) {
    case "hold_same_epoch":
      return {
        behaviorRevisionId: input.behaviorRevisionId,
        action: "already_quarantined",
        classification: result.classification,
      };
    case "defer":
      return {
        behaviorRevisionId: input.behaviorRevisionId,
        action: "deferred",
        classification: result.classification,
      };
    case "reaffirm": {
      const quarantineId = await store.recordTransition(
        quarantineRecord(input, result, `reaffirm-quarantine (re-proven flaky in epoch ${input.artifactDigest})`),
      );
      return {
        behaviorRevisionId: input.behaviorRevisionId,
        action: "reaffirmed",
        classification: "flaky",
        quarantineId,
      };
    }
    case "release_regression": {
      const quarantineId = await store.recordTransition(
        releaseRecord(
          input,
          result,
          `release-regression: behavior deterministically FAILS in epoch ${input.artifactDigest} — ` +
            `the quarantine was masking a real regression; unmasking it for the gate`,
        ),
      );
      return {
        behaviorRevisionId: input.behaviorRevisionId,
        action: "released_regression",
        classification: result.classification,
        quarantineId,
      };
    }
    case "release_recovered": {
      const quarantineId = await store.recordTransition(
        releaseRecord(
          input,
          result,
          `release-recovered: behavior is stable in epoch ${input.artifactDigest} — the flake is gone`,
        ),
      );
      return {
        behaviorRevisionId: input.behaviorRevisionId,
        action: "released_recovered",
        classification: result.classification,
        quarantineId,
      };
    }
    default: {
      const exhaustive: never = reevaluation;
      return exhaustive;
    }
  }
}

/** Build a `quarantine` transition record (flaky, excluded_from_green) for the observed epoch. */
function quarantineRecord(
  input: FlakeQuarantineActuationInput,
  result: FlakeClassificationResult,
  prefix: string,
): QuarantineTransitionRecord {
  return {
    orgId: input.orgId,
    projectId: input.projectId,
    behaviorRevisionId: input.behaviorRevisionId,
    transition: "quarantine",
    classification: "flaky",
    reason:
      `${prefix}: ${String(result.decisiveCount)} decisive ${input.purpose} verdicts for artifact ` +
      `${input.artifactDigest} show a pass↔fail conflict`,
    actor: input.actor,
    evidence: result.evidence,
    contextHash: input.contextHash,
    epoch: input.artifactDigest,
  };
}

/** Build a `release` transition record (restored) carrying the re-evaluation's classification + evidence. */
function releaseRecord(
  input: FlakeQuarantineActuationInput,
  result: FlakeClassificationResult,
  reason: string,
): QuarantineTransitionRecord {
  return {
    orgId: input.orgId,
    projectId: input.projectId,
    behaviorRevisionId: input.behaviorRevisionId,
    transition: "release",
    classification: result.classification,
    reason,
    actor: input.actor,
    evidence: result.evidence,
    contextHash: input.contextHash,
    epoch: input.artifactDigest,
  };
}

/** The governance actor recorded for an automated rv-17 flake quarantine. */
export const FLAKE_CLASSIFIER_ACTOR = "system:rv-17-flake-classifier";
