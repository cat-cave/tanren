import type { IntegrationNodeMember } from "./integrationNodes.js";

/**
 * The immutable V2 proof/effect coordinate. A runtime outcome is useful only when every
 * value below is the same coordinate the authority gave to the host CAS.
 */
export interface RuntimeOutcomeProofCoordinate {
  readonly gateProofBundleId: string;
  readonly proofBundleDigest: string;
  readonly proofRoot: string;
  readonly quarantineVersion: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly memberSetHash: string;
  readonly members: readonly IntegrationNodeMember[];
  readonly gateConfigHash: string;
  readonly policyVersion: string;
  readonly runnerImage: string;
  readonly appEnvHash: string;
}

export type RuntimeOutcomeDecision = "authorized" | "blocked" | "needs_attention";
export type RuntimeOutcomeResult = "landed" | "declined" | "quarantined";

/** A terminal runtime outcome; `landed` is tied to the exact authority effect intent. */
export interface RuntimeOutcomeRecord extends RuntimeOutcomeProofCoordinate {
  readonly id: string;
  readonly decision: RuntimeOutcomeDecision;
  readonly result: RuntimeOutcomeResult;
  readonly projectId: string;
  readonly orgId: string;
  readonly authorityDecisionId?: string;
  readonly effectIntentId?: string;
  readonly mainSha?: string;
}
