// bh-11 — the resolution sibling of MergeAuthority. This contract deliberately
// owns no CodeHost capability: it decides whether immutable production evidence
// is sufficient to declare a symptom resolved, never whether code may land.

export const RESOLUTION_DECISIONS = ["authorized", "blocked", "needs_attention", "waived"] as const;
export type ResolutionDecision = (typeof RESOLUTION_DECISIONS)[number];
export const RESOLUTION_AUTHORITY_VERSION = "tanren-resolution-authority.v1";

export const RESOLUTION_PROOF_GRADES = ["active_causal", "active_plus_soak", "observational", "attested"] as const;
export type ResolutionProofGrade = (typeof RESOLUTION_PROOF_GRADES)[number];

export type ResolutionEvidenceRun = {
  readonly verificationRunId: string;
  readonly artifactDigest: string;
  readonly mergeSha: string;
};

export type ResolutionProductionEvidence = Omit<ResolutionEvidenceRun, "verificationRunId"> & {
  readonly verificationRunId: string | null;
  readonly outcome: "passed" | "failed" | "inconclusive";
  readonly classification: "product_resolved" | "product_failure" | "infra_failure" | "inconclusive" | "unknown";
  readonly assertionOutcomes: ReadonlyArray<{
    readonly id: string;
    readonly outcome: "passed" | "failed" | "inconclusive";
  }>;
};

/**
 * The entire authority input is immutable evidence: no caller-supplied boolean
 * can stand in for a production observation. Optional evidence is intentional —
 * its absence is a first-class fail-closed state, not an inferred pass.
 */
export type ResolutionEvidenceSnapshot = {
  readonly version: "tanren-resolution-evidence.v1";
  readonly orgId: string;
  readonly projectId: string;
  readonly resolutionJobId: string;
  readonly issueLoopId: string;
  readonly contract: { readonly id: string; readonly hash: string | null; readonly sourceRevision: string | null };
  readonly baseline: ResolutionEvidenceRun | null;
  readonly counterfactual: ResolutionEvidenceRun | null;
  readonly soak: ResolutionEvidenceRun | null;
  readonly merge: { readonly authorityAuditId: string | null; readonly sha: string | null };
  /** The exact release binding that production verification must match. */
  readonly deployment: {
    readonly releaseInstanceId: string | null;
    readonly artifactDigest: string | null;
    readonly mergeSha: string | null;
  };
  readonly production: ResolutionProductionEvidence;
  readonly proofGrade: ResolutionProofGrade | "unknown";
  readonly resolutionPolicy: ResolutionProofGrade | "unknown";
  /** Present only when the authenticated operator deliberately invokes waive(). */
  readonly waiver?: { readonly operatorId: string; readonly reasonHash: string };
};

export type ResolutionAuthorization = {
  readonly id: string;
  readonly decision: ResolutionDecision;
  readonly inputSnapshotHash: string;
  readonly reasons: ReadonlyArray<string>;
  readonly created: boolean;
};

/** The sole internal decision surface; `waive` is deliberately separate from authorize. */
export interface ResolutionAuthority {
  authorize(input: { readonly orgId: string; readonly resolutionJobId: string }): Promise<ResolutionAuthorization>;
  waive(input: {
    readonly orgId: string;
    readonly resolutionJobId: string;
    readonly operatorId: string;
    readonly reason: string;
  }): Promise<ResolutionAuthorization>;
}
