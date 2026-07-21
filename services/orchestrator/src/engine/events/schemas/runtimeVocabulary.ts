import { z } from "zod";

// Mission-complete WAVE-1 runtime behavior-proof event vocabulary FREEZE (rv-25).
//
// The registered event schemas the Runtime Behavior Proof Graph emits, frozen
// here EXACTLY from the runtime spec's "Required events" list
// (docs/roadmap/mission-complete/nodes/runtime-ui-apex-phasing-risks.md §7).
// Names already present in the live EventRegistry — `gate.verdict`,
// `integration.proof.reused`, `merge.batch.bisecting`, `demo.evidence.recorded`
// — are NOT redeclared here; only the genuinely new rv-25 names are frozen.
// Downstream consumer nodes build against these frozen names + strict payloads.
//
// Payload discipline (spec §7): payloads carry stable IDs, hashes, counts and
// classifications — no rendered bytes, secrets, or provider bodies. Every field
// is therefore `public` (see sensitivityRules.runtimeVocabulary.ts). Envelope
// columns (org_id / project_id / spec_id / run_id) are stamped by the EventStore
// and never duplicated in the payload.

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const GitSha = z.string().regex(/^[0-9a-fA-F]{40}$/u);
const Id = z.string().min(1).max(256);
const Count = z.number().int().min(0);
const Attempt = z.number().int().min(0);

const FragmentCapability = z.enum([
  "fixture",
  "driver",
  "action",
  "assertion",
  "observer",
  "visual_checkpoint",
  "cleanup",
  "artifact_capture",
]);
const Surface = z.enum(["browser", "api", "cli", "package", "app_channel", "external_integration", "mobile"]);
const VerdictOutcome = z.enum([
  "passed",
  "failed_product",
  "failed_verification_contract",
  "failed_visual",
  "inconclusive_infrastructure",
  "inconclusive_external",
  "cancelled_superseded",
]);
const FlakeState = z.enum(["stable", "suspected", "confirmed", "quarantined_fragment"]);
const RenderVerdict = z.enum(["passed", "failed", "unknown"]);
const ProofVerdict = z.enum(["passed", "failed", "unknown"]);
const DeployEnvironment = z.enum(["preview", "staging", "production"]);

// ---------------------------------------------------------------------------
// behavior.contract.* — deterministic executable-plan compilation.
// ---------------------------------------------------------------------------

export const BehaviorContractCompilationStartedPayload = z
  .object({
    behaviorRevisionId: Id,
    behaviorRevisionHash: Sha256Digest,
  })
  .strict();

export const BehaviorContractCompiledPayload = z
  .object({
    behaviorRevisionId: Id,
    behaviorRevisionHash: Sha256Digest,
    planHash: Sha256Digest,
    assertionCount: Count,
    surfaceKinds: z.array(Surface).max(16),
  })
  .strict();

export const BehaviorContractRejectedPayload = z
  .object({
    behaviorRevisionId: Id,
    behaviorRevisionHash: Sha256Digest,
    reason: z.string().min(1).max(200),
  })
  .strict();

// ---------------------------------------------------------------------------
// behavior.fragment.* — per-capability fragment resolution + F2 authoring.
// ---------------------------------------------------------------------------

export const BehaviorFragmentMissingPayload = z
  .object({
    behaviorRevisionId: Id,
    capability: FragmentCapability,
  })
  .strict();

export const BehaviorFragmentAuthoringStartedPayload = z
  .object({
    behaviorRevisionId: Id,
    capability: FragmentCapability,
    fragmentId: Id,
  })
  .strict();

export const BehaviorFragmentValidatedPayload = z
  .object({
    behaviorRevisionId: Id,
    capability: FragmentCapability,
    fragmentId: Id,
    fragmentVersion: z.string().min(1).max(128),
    // F2 validation currently returns only a valid/rejected verdict. Until it
    // also returns a measured negative-control result, its absence is honest;
    // a successful validation is not evidence that a negative control passed.
    negativeControlPassed: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// behavior.verification / shard / attempt / action / assertion / effect.
// ---------------------------------------------------------------------------

export const BehaviorVerificationStartedPayload = z
  .object({
    behaviorRevisionId: Id,
    integrationNodeId: Id,
    artifactDigest: Sha256Digest,
  })
  .strict();

export const BehaviorShardStartedPayload = z
  .object({
    behaviorRevisionId: Id,
    shardId: Id,
    matrixKey: z.string().min(1).max(256),
  })
  .strict();

export const BehaviorAttemptStartedPayload = z
  .object({
    behaviorRevisionId: Id,
    shardId: Id,
    attempt: Attempt,
  })
  .strict();

export const BehaviorActionObservedPayload = z
  .object({
    behaviorRevisionId: Id,
    shardId: Id,
    actionId: Id,
    surface: Surface,
  })
  .strict();

export const BehaviorAssertionObservedPayload = z
  .object({
    behaviorRevisionId: Id,
    shardId: Id,
    assertionId: Id,
    satisfied: z.boolean(),
  })
  .strict();

export const BehaviorEffectObservedPayload = z
  .object({
    behaviorRevisionId: Id,
    shardId: Id,
    correlationId: Id,
    providerReceiptId: Id,
    // Present only for the live A3 path. Legacy observer events remain valid but
    // cannot satisfy the delivery gate, which requires this exact cause binding.
    deliveryRunId: Id.optional(),
    causeOrdinal: z.number().int().nonnegative().optional(),
    occurrenceCount: z.number().int().positive().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// design.render.* — rendered DesignContract checkpoint capture + verdict.
// ---------------------------------------------------------------------------

export const DesignRenderCapturedPayload = z
  .object({
    renderId: Sha256Digest,
    artifactDigest: Sha256Digest,
    scenarioKey: Id,
    designContractVersion: z.string().min(1).max(256),
    a11yViolationCount: Count,
  })
  .strict();

export const DesignRenderVerdictRecordedPayload = z
  .object({
    renderVerificationId: Id,
    artifactDigest: Sha256Digest,
    pixelOutcome: RenderVerdict,
    semanticOutcome: RenderVerdict,
    a11yOutcome: RenderVerdict,
    contractClauseRefs: z.array(Sha256Digest).min(1).max(256),
  })
  .strict();

// ---------------------------------------------------------------------------
// behavior.verdict / verification.completed — per-behavior verdict + roll-up.
// ---------------------------------------------------------------------------

export const BehaviorVerdictRecordedPayload = z
  .object({
    behaviorRevisionId: Id,
    verdictId: Id,
    outcome: VerdictOutcome,
    executedAssertionCount: Count,
    flakeState: FlakeState,
  })
  .strict();

export const BehaviorVerificationCompletedPayload = z
  .object({
    integrationNodeId: Id,
    requiredVerdictCount: Count,
    passedVerdictCount: Count,
  })
  .strict();

// ---------------------------------------------------------------------------
// gate.behavior_proof.bound + integration.proof.recorded — proof binding.
// ---------------------------------------------------------------------------

export const GateBehaviorProofBoundPayload = z
  .object({
    integrationNodeId: Id,
    gateProofBundleDigest: Sha256Digest,
    requiredBehaviorRevisionCount: Count,
    planSetHash: Sha256Digest,
  })
  .strict();

export const IntegrationProofRecordedPayload = z
  .object({
    nodeId: Id,
    memberKey: Id,
    proofReuseKey: Id,
    verdict: ProofVerdict,
  })
  .strict();

// ---------------------------------------------------------------------------
// merge.batch.* (behavior-aware bisection) + behavior.respec.requested.
// ---------------------------------------------------------------------------

export const MergeBatchBehaviorFailedPayload = z
  .object({
    groupId: Id,
    behaviorRevisionId: Id,
    verdictId: Id,
    outcome: VerdictOutcome,
  })
  .strict();

export const MergeBatchCulpritSetIdentifiedPayload = z
  .object({
    groupId: Id,
    culpritMemberIds: z.array(Id).min(1).max(256),
  })
  .strict();

export const BehaviorRespecRequestedPayload = z
  .object({
    behaviorRevisionId: Id,
    reason: z.string().min(1).max(200),
  })
  .strict();

// ---------------------------------------------------------------------------
// post_merge.behavior.* — production re-proof.
// ---------------------------------------------------------------------------

export const PostMergeBehaviorVerifiedPayload = z
  .object({
    behaviorRevisionId: Id,
    verdictId: Id,
    deploySha: GitSha,
    artifactDigest: Sha256Digest,
  })
  .strict();

export const PostMergeBehaviorFailedPayload = z
  .object({
    behaviorRevisionId: Id,
    verdictId: Id,
    deploySha: GitSha,
    outcome: VerdictOutcome,
  })
  .strict();

// ---------------------------------------------------------------------------
// deployment.* — promote-the-proven-artifact + rollback.
// ---------------------------------------------------------------------------

export const DeploymentPromotedPayload = z
  .object({
    deploymentId: Id,
    artifactDigest: Sha256Digest,
    deploySha: GitSha,
    environment: DeployEnvironment,
  })
  .strict();

export const DeploymentRolledBackPayload = z
  .object({
    deploymentId: Id,
    artifactDigest: Sha256Digest,
    reason: z.string().min(1).max(200),
  })
  .strict();

export const runtimeVocabularyRegistry = {
  "behavior.contract.compilation_started": BehaviorContractCompilationStartedPayload,
  "behavior.contract.compiled": BehaviorContractCompiledPayload,
  "behavior.contract.rejected": BehaviorContractRejectedPayload,
  "behavior.fragment.missing": BehaviorFragmentMissingPayload,
  "behavior.fragment.authoring_started": BehaviorFragmentAuthoringStartedPayload,
  "behavior.fragment.validated": BehaviorFragmentValidatedPayload,
  "behavior.verification.started": BehaviorVerificationStartedPayload,
  "behavior.shard.started": BehaviorShardStartedPayload,
  "behavior.attempt.started": BehaviorAttemptStartedPayload,
  "behavior.action.observed": BehaviorActionObservedPayload,
  "behavior.assertion.observed": BehaviorAssertionObservedPayload,
  "behavior.effect.observed": BehaviorEffectObservedPayload,
  "design.render.captured": DesignRenderCapturedPayload,
  "design.render.verdict_recorded": DesignRenderVerdictRecordedPayload,
  "behavior.verdict.recorded": BehaviorVerdictRecordedPayload,
  "behavior.verification.completed": BehaviorVerificationCompletedPayload,
  "gate.behavior_proof.bound": GateBehaviorProofBoundPayload,
  "integration.proof.recorded": IntegrationProofRecordedPayload,
  "merge.batch.behavior_failed": MergeBatchBehaviorFailedPayload,
  "merge.batch.culprit_set_identified": MergeBatchCulpritSetIdentifiedPayload,
  "behavior.respec.requested": BehaviorRespecRequestedPayload,
  "post_merge.behavior.verified": PostMergeBehaviorVerifiedPayload,
  "post_merge.behavior.failed": PostMergeBehaviorFailedPayload,
  "deployment.promoted": DeploymentPromotedPayload,
  "deployment.rolled_back": DeploymentRolledBackPayload,
} as const satisfies Record<string, z.ZodTypeAny>;
