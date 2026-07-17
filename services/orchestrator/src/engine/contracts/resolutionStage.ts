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
