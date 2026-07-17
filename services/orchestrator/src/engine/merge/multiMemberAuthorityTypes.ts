// cspell:ignore rederive
// MQ-2 consumer vocabulary over the unchanged SP-4 MergeAuthorityV2. These seven
// primary kinds describe what the merge queue may do with one exact persisted batch
// node; they are not a second LandDecision and confer no host-land capability.

import { createHash } from "node:crypto";
import { parseDigest, type Digest } from "../contracts/cas.js";
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { Finding } from "../contracts/findings.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type {
  AuthorizeLandInput,
  LandAuthorization,
  LandBindingEnvelope,
  LandMemberDisposition,
  MergeAuthorityV2,
} from "../contracts/mergeAuthority.js";
import type { MergeInfrastructureReasonCode, MergeSignalClassificationV1 } from "./authoritySignalClassification.js";

export const MULTI_MEMBER_AUTHORITY_VERSION = "multi_member_authority.v1" as const;

export interface MultiMemberAuthorityMemberOutcome {
  readonly specId: string;
  readonly runId: string;
  readonly branch: string;
  readonly headSha: string;
  readonly disposition: LandMemberDisposition;
  readonly findingIds: ReadonlyArray<string>;
  readonly reasonCodes: ReadonlyArray<string>;
}

interface EvaluationBase {
  readonly evaluationId: string;
  readonly groupId: string;
  readonly version: typeof MULTI_MEMBER_AUTHORITY_VERSION;
  readonly nodeId: string;
  readonly memberSetHash: string;
  readonly proofReuseKey: string;
  readonly members: ReadonlyArray<MultiMemberAuthorityMemberOutcome>;
  readonly reasonCodes: ReadonlyArray<string>;
  /** Present only for the four outcomes represented by the frozen W0 vocabulary. */
  readonly w0?: MergeSignalClassificationV1;
}

export interface AuthorizedSubsetEvaluation extends EvaluationBase {
  readonly kind: "authorized_subset";
  readonly authorizedMemberIds: ReadonlyArray<string>;
  readonly eligibleMemberIds: ReadonlyArray<string>;
  readonly authorization: LandAuthorization;
}

export interface MemberFailureEvaluation extends EvaluationBase {
  readonly kind: "member_failure";
  readonly failedMemberIds: ReadonlyArray<string>;
  readonly heldMemberIds: ReadonlyArray<string>;
  readonly eligibleMemberIds: ReadonlyArray<string>;
  readonly findingIds: ReadonlyArray<string>;
  readonly authorization: LandAuthorization;
  readonly w0: Extract<MergeSignalClassificationV1, { classification: "deterministic_policy" }>;
}

export interface InfrastructureEvaluation extends EvaluationBase {
  readonly kind: "transient_infrastructure";
  readonly eligibleMemberIds: readonly [];
  readonly w0: Extract<MergeSignalClassificationV1, { classification: "transient_infrastructure" }>;
}

export interface ProductDecisionEvaluation extends EvaluationBase {
  readonly kind: "needs_product_decision";
  readonly eligibleMemberIds: readonly [];
  readonly authorization: LandAuthorization;
  readonly w0: Extract<MergeSignalClassificationV1, { classification: "needs_product_decision" }>;
}

export interface UnknownEvaluation extends EvaluationBase {
  readonly kind: "unknown_fail_closed";
  readonly eligibleMemberIds: readonly [];
  readonly authorization?: LandAuthorization;
  readonly w0?: Extract<MergeSignalClassificationV1, { classification: "unknown_fail_closed" }>;
}

// The engine post-pass evaluator produces these FIVE embark/W0 dispositions. The two
// durable read-side dispositions — `interaction_failure` (a durable FAILED batch proof)
// and `flake_observation` (a durable ci-flaky quarantine row proving same-tree
// non-determinism for the exact proven head) — are reconstructed by the HTTP read side
// (`readDurableBatchEvidence`), never by this post-pass evaluator: the evaluator only runs
// AFTER an integrated PASS, so it can neither observe a failed proof nor honestly witness
// two opposite-verdict same-tree observations. A residual, non-member-attributable
// authority block at the post-pass site is `unknown_fail_closed`, not `interaction_failure`.
export type MultiMemberAuthorityEvaluation =
  | AuthorizedSubsetEvaluation
  | MemberFailureEvaluation
  | InfrastructureEvaluation
  | ProductDecisionEvaluation
  | UnknownEvaluation;

/** Exact member-local audit attribution read from each member's durable run record. */
export interface MemberFindingAttribution {
  readonly specId: string;
  readonly runId: string;
  readonly findings: ReadonlyArray<Finding>;
}

/** Typed infrastructure evidence accepted by the frozen W0 classifier. */
export interface MultiMemberInfrastructureEvidence {
  readonly kind: "infrastructure";
  readonly reasonCode: MergeInfrastructureReasonCode;
  readonly sourceKey: string;
}

// Pre-authority evidence the post-pass evaluator may short-circuit on. Only typed
// infrastructure qualifies: it is the sole pre-authority signal a passing batch can carry
// without inventing a durable observation the store does not hold. (Same-tree flake is a
// read-side reconstruction from the durable ci-flaky quarantine surface — never a
// synthesized pre-authority input; see `MultiMemberAuthorityEvaluation`.)
export type MultiMemberPreAuthorityEvidence = MultiMemberInfrastructureEvidence;

export interface EvaluateMultiMemberAuthorityInput {
  readonly binding: BatchAuthorityBinding;
  readonly entries: ReadonlyArray<Pick<MergeQueueEntry, "specId" | "runId" | "dependsOn">>;
  readonly decisionInput: AuthorizeLandInput;
  readonly envelope: LandBindingEnvelope;
  /** The real SP-4 decision seam, deliberately narrowed so evaluation cannot land. */
  readonly authority: Pick<MergeAuthorityV2, "authorizeLand">;
  readonly memberFindings: ReadonlyArray<MemberFindingAttribution>;
  readonly evidence?: MultiMemberPreAuthorityEvidence;
}

/** Production coordinator seam: evaluate one passing exact node before any drive. */
export interface BatchAuthorityEvaluator {
  evaluate(input: {
    readonly projectId: string;
    readonly entries: ReadonlyArray<MergeQueueEntry>;
    readonly binding: BatchAuthorityBinding;
  }): Promise<MultiMemberAuthorityEvaluation>;
  /**
   * Production-only atomic land seam. Test/read-only evaluators omit it and keep
   * their existing decision-only behavior; a live multi-member pass never falls
   * back to sequential per-member lands when this is present.
   */
  landAuthorizedGroup?(input: {
    readonly projectId: string;
    readonly entries: ReadonlyArray<MergeQueueEntry>;
    readonly binding: BatchAuthorityBinding;
    readonly evaluation: AuthorizedSubsetEvaluation;
  }): Promise<LandGroupLandOutcome>;
}

/** The only outcomes of the group land handoff after an exact authorization. */
export type LandGroupLandOutcome =
  | { readonly kind: "landed"; readonly mainSha: string }
  | { readonly kind: "rederive" }
  | { readonly kind: "reconcile_pending" };

/** Artifact identity for the exact materialized head/tree, never a member branch. */
export function batchArtifactDigest(binding: BatchAuthorityBinding): Digest {
  const hex = createHash("sha256")
    .update("tanren:merge-batch-artifact:v1\0")
    .update(binding.headSha)
    .update("\0")
    .update(binding.treeHash)
    .digest("hex");
  return parseDigest(`sha256:${hex}`);
}

/** Until SP-7 seals a richer bundle, the full six-component proof key is its root. */
export function batchProofRoot(binding: BatchAuthorityBinding): Digest {
  return parseDigest(`sha256:${binding.proof.proofReuseKey}`);
}
