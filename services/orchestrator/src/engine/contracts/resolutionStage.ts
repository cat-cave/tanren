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

export type ResolutionStageResult = {
  outcome: "passed" | "failed" | "inconclusive";
  classification: "product_failure" | "infra_failure" | "stale_contract" | "inconclusive";
  proofGrade: "active_causal" | "active_plus_soak" | "observational" | "attested";
  verificationRunId: string;
  assertionIds: string[];
  evidenceRefs: string[];
};
