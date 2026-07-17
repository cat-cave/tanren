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
  proofGrade: "active_causal" | "active_plus_soak" | "observational" | "attested";
  verificationRunId: string;
  assertionIds: string[];
  evidenceRefs: string[];
} & (
  | { outcome: "passed"; classification: "product_resolved" }
  | { outcome: "failed"; classification: "product_failure" }
  | { outcome: "inconclusive"; classification: "infra_failure" | "stale_contract" | "inconclusive" }
);
