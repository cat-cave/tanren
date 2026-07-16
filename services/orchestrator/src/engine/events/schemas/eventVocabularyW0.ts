import { z } from "zod";

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const MergeEvaluationId = z.string().regex(/^mqeval_[0-9a-f]{64}$/u);
const MergeGroupId = z.string().regex(/^mqgrp_[0-9a-f]{64}$/u);
const MergeWakeKey = z.string().regex(/^mqwake_[0-9a-f]{64}$/u);

function canonicalIdArray(options: { readonly min?: number; readonly length?: number } = {}) {
  let schema = z.array(z.string().min(1));
  if (options.min !== undefined) schema = schema.min(options.min);
  if (options.length !== undefined) schema = schema.length(options.length);
  return schema.superRefine((values, context) => {
    const canonical = [...new Set(values)].sort();
    if (values.length !== canonical.length || values.some((value, index) => value !== canonical[index])) {
      context.addIssue({
        code: "custom",
        message: "identifiers must be sorted and unique",
      });
    }
  });
}

export const IntegrationRequirementValidatedPayload = z
  .object({
    missionNodeId: z.literal("in-2"),
    requirementDigest: Sha256Digest,
    artifact: z
      .object({
        digest: Sha256Digest,
        byteSize: z.number().int().nonnegative(),
        mediaType: z.literal("application/vnd.tanren.integration-requirement.v1+json"),
      })
      .strict(),
    capability: z.string().min(1).max(128),
    plane: z.enum(["control", "product"]),
    direction: z.enum(["inbound", "outbound", "bidirectional"]),
    criticality: z.enum(["merge_required", "release_required", "best_effort"]),
  })
  .strict();

const AffectedTarget = z
  .object({
    kind: z.enum(["spec", "source", "component", "integration", "design"]),
    targetRef: z.string().min(1).max(2_000),
  })
  .strict();

const SelectionReason = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct_edge"), edgeId: z.string().min(1), target: AffectedTarget }).strict(),
  z
    .object({
      kind: z.literal("transitive_dependency"),
      edgeId: z.string().min(1),
      dependencyBehaviorRevisionId: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("unknown_target"), target: AffectedTarget }).strict(),
  z.object({ kind: z.literal("uncovered_behavior") }).strict(),
  z
    .object({
      kind: z.literal("dangling_dependency"),
      edgeId: z.string().min(1),
      targetRef: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("no_changed_targets") }).strict(),
]);

export const BehaviorCoverageSelectionAnalyzedPayload = z
  .object({
    version: z.literal("v1"),
    analysisId: z.string().min(1),
    mode: z.enum(["targeted", "expanded_unknown", "no_active_behaviors"]),
    changedTargets: z.array(AffectedTarget).max(500),
    unknownTargets: z.array(AffectedTarget).max(500),
    selected: z.array(
      z
        .object({
          behaviorRevisionId: z.string().min(1),
          reasons: z.array(SelectionReason).min(1),
        })
        .strict(),
    ),
    excluded: z.array(
      z
        .object({
          behaviorRevisionId: z.string().min(1),
          reason: z.literal("no_reachable_changed_target"),
          inspectedEdgeIds: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
  })
  .strict();

const AuditPosture = z
  .object({
    blockReviewAt: z.enum(["P0", "P1", "P2", "P3"]),
    p2p3Handling: z.enum(["fix-if-idle", "route-to-dag"]),
    autonomousRemediation: z.boolean(),
  })
  .strict();

export const GovernanceAuditPostureUpdatedPayload = z
  .object({
    actorUserId: z.string().min(1),
    previous: AuditPosture,
    current: AuditPosture,
  })
  .strict();

export const ReviewSimulatedIntentPayload = z
  .object({
    headSha: z.string().regex(/^[0-9a-fA-F]{40}$/u),
    state: z.enum(["approved", "changes_requested"]),
    event: z.enum(["APPROVE", "REQUEST_CHANGES"]),
    body: z.string().min(1),
    message: z.string(),
    reviewerLogin: z.string().min(1),
    marker: z.string(),
  })
  .strict()
  .superRefine((intent, context) => {
    const expectedEvent = intent.state === "approved" ? "APPROVE" : "REQUEST_CHANGES";
    const expectedMarker = `tanren-simulated-review:v1:${intent.state}`;
    if (intent.event !== expectedEvent) {
      context.addIssue({ code: "custom", path: ["event"], message: "event must match state" });
    }
    if (intent.marker !== expectedMarker) {
      context.addIssue({ code: "custom", path: ["marker"], message: "marker must match state" });
    }
    if (!intent.body.split(/\r?\n/u).includes(expectedMarker)) {
      context.addIssue({ code: "custom", path: ["body"], message: "body must contain the exact marker line" });
    }
  });

const MergeSignalIdentity = z.object({
  missionNodeId: z.literal("mq-1"),
  evaluationId: MergeEvaluationId,
  groupId: MergeGroupId,
  signalVersion: z.literal("merge_signal.v1"),
});

const DeterministicPolicySignal = MergeSignalIdentity.extend({
  memberIds: canonicalIdArray({ min: 1 }),
  findingIds: canonicalIdArray({ min: 1 }),
  classification: z.literal("deterministic_policy"),
  reasonCode: z.literal("audit_policy"),
  retryability: z.literal("non_retryable"),
  wakeKey: z.null(),
  disposition: z.literal("member_repair"),
}).strict();

const TransientInfrastructureSignal = MergeSignalIdentity.extend({
  memberIds: canonicalIdArray({ length: 0 }),
  findingIds: canonicalIdArray({ length: 0 }),
  classification: z.literal("transient_infrastructure"),
  reasonCode: z.enum([
    "provider_timeout",
    "provider_rate_limit",
    "runner_unavailable",
    "runner_transport",
    "code_host_unavailable",
    "gate_infrastructure",
  ]),
  retryability: z.literal("retryable"),
  wakeKey: MergeWakeKey,
  disposition: z.literal("retry_when_ready"),
}).strict();

const NeedsProductDecisionSignal = MergeSignalIdentity.extend({
  memberIds: canonicalIdArray({ length: 0 }),
  findingIds: canonicalIdArray({ length: 0 }),
  classification: z.literal("needs_product_decision"),
  reasonCode: z.enum(["review_changes_requested", "hitl_pending"]),
  retryability: z.literal("non_retryable"),
  wakeKey: MergeWakeKey,
  disposition: z.literal("await_product_decision"),
}).strict();

const UnknownFailClosedSignal = MergeSignalIdentity.extend({
  memberIds: canonicalIdArray({ length: 0 }),
  findingIds: canonicalIdArray(),
  classification: z.literal("unknown_fail_closed"),
  reasonCode: z.enum([
    "untyped_evidence",
    "unattributed_policy",
    "contradictory_evidence",
    "invalid_binding",
    "unclassified_authority_block",
  ]),
  retryability: z.literal("unknown"),
  wakeKey: z.null(),
  disposition: z.literal("hold_fail_closed"),
}).strict();

export const MergeSignalClassifiedPayload = z.discriminatedUnion("classification", [
  DeterministicPolicySignal,
  TransientInfrastructureSignal,
  NeedsProductDecisionSignal,
  UnknownFailClosedSignal,
]);

export const MergeMemberPolicyBlockedPayload = MergeSignalIdentity.extend({
  memberIds: canonicalIdArray({ min: 1 }),
  findingIds: canonicalIdArray({ min: 1 }),
  classification: z.literal("deterministic_policy"),
  reasonCode: z.literal("audit_policy"),
  retryability: z.literal("non_retryable"),
  wakeKey: z.null(),
  disposition: z.literal("member_repair"),
}).strict();

export const w0EventRegistry = {
  "integration.requirement.validated": IntegrationRequirementValidatedPayload,
  "behavior.coverage.selection_analyzed": BehaviorCoverageSelectionAnalyzedPayload,
  "governance.audit_posture.updated": GovernanceAuditPostureUpdatedPayload,
  "review.simulated_intent": ReviewSimulatedIntentPayload,
  "merge.signal.classified": MergeSignalClassifiedPayload,
  "merge.member.policy_blocked": MergeMemberPolicyBlockedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;
