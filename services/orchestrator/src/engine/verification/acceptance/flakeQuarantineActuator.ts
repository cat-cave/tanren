// rv-17 — the flake-quarantine ACTUATOR: the production hook that runs AFTER a run's behavior
// verdicts are recorded (wired into the rv-16a post-merge production behavior-verdict lane, which
// is driven live by BOTH the resolution walker and the operator-retry route). For one behavior it:
//   1. classifies the flake state from the RECORDED verdicts (same artifact + verification purpose)
//      via the store — a real function of the attempts, never guessed; then
//   2. on a decisive `flaky` classification (a real pass↔fail conflict) that is NOT already
//      quarantined, persists a `quarantine` governance transition (append-only, evidence-bearing).
//
// This is what makes the mechanism LIVE: without it the quarantine table stays empty in production
// and the rv-16 bisection skip reads nothing. It is best-effort at the call site (a classification
// failure must never break verdict recording or the deploy decision) and idempotent (an already-
// quarantined behavior is left alone). It NEVER launders anything: the only write it makes is a
// quarantine record, which the 0085 CHECK forbids from carrying a green effect.

import type { FlakeClassification, FlakeClassificationResult } from "./flakeClassification.js";
import type { QuarantineTransitionRecord } from "./behaviorQuarantineGovernance.js";

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
  isQuarantined(
    scope: { readonly orgId: string; readonly projectId: string },
    behaviorRevisionId: string,
  ): Promise<boolean>;
  recordTransition(record: QuarantineTransitionRecord): Promise<string>;
}

export type FlakeQuarantineAction = "quarantined" | "already_quarantined" | "not_flaky";

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
 * Classify one behavior from its recorded verdicts and, on a decisive `flaky` classification,
 * persist a quarantine transition. Idempotent (already-quarantined ⇒ no write) and never a
 * launderer (the only possible write is a quarantine record).
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
  if (result.classification !== "flaky") {
    return { behaviorRevisionId: input.behaviorRevisionId, action: "not_flaky", classification: result.classification };
  }
  if (await store.isQuarantined({ orgId: input.orgId, projectId: input.projectId }, input.behaviorRevisionId)) {
    return { behaviorRevisionId: input.behaviorRevisionId, action: "already_quarantined", classification: "flaky" };
  }
  const quarantineId = await store.recordTransition({
    orgId: input.orgId,
    projectId: input.projectId,
    behaviorRevisionId: input.behaviorRevisionId,
    transition: "quarantine",
    classification: "flaky",
    reason:
      `auto-quarantine: ${String(result.decisiveCount)} decisive ${input.purpose} verdicts for artifact ` +
      `${input.artifactDigest} show a pass↔fail conflict`,
    actor: input.actor,
    evidence: result.evidence,
    contextHash: input.contextHash,
  });
  return { behaviorRevisionId: input.behaviorRevisionId, action: "quarantined", classification: "flaky", quarantineId };
}

/** The governance actor recorded for an automated rv-17 flake quarantine. */
export const FLAKE_CLASSIFIER_ACTOR = "system:rv-17-flake-classifier";
