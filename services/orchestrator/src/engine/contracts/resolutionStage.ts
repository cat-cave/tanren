// Frozen bh-6a contract. Stage implementations land after the cluster barrier;
// this module intentionally owns types only.
export type ResolutionStageKind = "baseline" | "production" | "counterfactual" | "soak";

export type ResolutionJob = {
  id: string;
  orgId: string;
  projectId: string;
  issueLoopId: string;
  contractId: string;
  releaseInstanceId?: string;
  stage: ResolutionStageKind;
  state: string;
  leaseOwner: string;
  leaseExpiry: string;
  idempotencyKey: string;
  attempt: number;
  priorAttemptId?: string;
};

export type ResolutionStage = {
  kind: ResolutionStageKind;
  run(job: ResolutionJob, ctx: unknown): Promise<ResolutionStageResult>;
};

type ResolutionStageResultCommon = {
  proofGrade: "active_causal" | "active_plus_soak" | "observational" | "attested";
  verificationRunId: string;
  assertionIds: string[];
  evidenceRefs: string[];
};

/** The frozen baseline-reproduction verdicts retain their established meaning. */
export type BaselineResolutionStageResult = ResolutionStageResultCommon &
  (
    | { outcome: "passed"; classification: "product_failure" }
    | { outcome: "failed"; classification: "stale_contract" }
    | { outcome: "inconclusive"; classification: "infra_failure" | "inconclusive" }
  );

/** Production verification is narrower so its terminal event schemas stay exact. */
export type ProductionResolutionStageResult = ResolutionStageResultCommon &
  (
    | { outcome: "passed"; classification: "product_resolved" }
    | { outcome: "failed"; classification: "product_failure" }
    | { outcome: "inconclusive"; classification: "infra_failure" | "inconclusive" }
  );

export type ResolutionStageResult = BaselineResolutionStageResult | ProductionResolutionStageResult;

/**
 * bh-15 — one EXACT bound behavior revision, loaded whole (Given/When/Then +
 * the immutable content digest + its resolved acceptance plan). The revision is
 * the one BOUND to the release under verification, never the latest lineage head.
 */
export interface LockedBehaviorRevision {
  readonly behaviorRevisionId: string;
  readonly behaviorId: string;
  readonly personaRevisionId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
  readonly contentDigest: string;
  readonly acceptancePlanId: string;
}

/**
 * bh-15 — the single immutable behavior context every resolution stage executes
 * BEFORE it probes, previews, replays, or soaks. It pins the exact
 * behavior/persona revision set bound to the active symptom contract's release,
 * so baseline, production, counterfactual, and soak all prove the SAME frozen
 * behaviors. `contextDigest` is the canonical identity stored in the
 * verification-run facts (`behavior_verification_runs.runtime_behavior_context_hash`).
 */
export interface RuntimeBehaviorContext {
  readonly contractId: string;
  readonly issueLoopId: string;
  readonly releaseInstanceId: string;
  readonly artifactDigest: string;
  readonly behaviors: readonly LockedBehaviorRevision[];
  readonly personaRevisionIds: readonly string[];
  readonly contextDigest: string;
}
