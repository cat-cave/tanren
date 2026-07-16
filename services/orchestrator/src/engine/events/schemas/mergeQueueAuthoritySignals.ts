import { z } from "zod";

export const MQ1_MISSION_NODE_ID = "mq-1" as const;
export const MERGE_SIGNAL_VERSION = "merge_signal.v1" as const;

const DerivedEvaluationId = z.string().regex(/^mqeval_[0-9a-f]{64}$/u);
const DerivedGroupId = z.string().regex(/^mqgrp_[0-9a-f]{64}$/u);
const DerivedWakeKey = z.string().regex(/^mqwake_[0-9a-f]{64}$/u);

export const MergeSignalClassificationKind = z.enum([
  "deterministic_policy",
  "transient_infrastructure",
  "needs_product_decision",
  "unknown_fail_closed",
]);
export type MergeSignalClassificationKind = z.infer<typeof MergeSignalClassificationKind>;

export const MergeInfrastructureReasonCode = z.enum([
  "provider_timeout",
  "provider_rate_limit",
  "runner_unavailable",
  "runner_transport",
  "code_host_unavailable",
  "gate_infrastructure",
]);
export type MergeInfrastructureReasonCode = z.infer<typeof MergeInfrastructureReasonCode>;

export const MergeSignalReasonCode = z.union([
  z.literal("audit_policy"),
  MergeInfrastructureReasonCode,
  z.enum([
    "review_changes_requested",
    "hitl_pending",
    "untyped_evidence",
    "unattributed_policy",
    "contradictory_evidence",
    "invalid_binding",
    "unclassified_authority_block",
  ]),
]);
export type MergeSignalReasonCode = z.infer<typeof MergeSignalReasonCode>;

const StableIds = z.array(z.string().min(1)).superRefine((values, context) => {
  const canonical = [...new Set(values)].sort();
  if (canonical.length !== values.length || canonical.some((value, index) => value !== values[index])) {
    context.addIssue({ code: "custom", message: "identities must be sorted and unique" });
  }
});

const Identity = z
  .object({
    missionNodeId: z.literal(MQ1_MISSION_NODE_ID),
    evaluationId: DerivedEvaluationId,
    groupId: DerivedGroupId,
    signalVersion: z.literal(MERGE_SIGNAL_VERSION),
    memberIds: StableIds,
    findingIds: StableIds,
  })
  .strict();

const DeterministicPolicy = Identity.extend({
  classification: z.literal("deterministic_policy"),
  reasonCode: z.literal("audit_policy"),
  retryability: z.literal("non_retryable"),
  wakeKey: z.null(),
  disposition: z.literal("member_repair"),
})
  .refine((value) => value.memberIds.length > 0, "deterministic policy requires an attributed bound member")
  .refine((value) => value.findingIds.length > 0, "deterministic policy requires blocking finding IDs");

const TransientInfrastructure = Identity.extend({
  classification: z.literal("transient_infrastructure"),
  reasonCode: MergeInfrastructureReasonCode,
  retryability: z.literal("retryable"),
  wakeKey: DerivedWakeKey,
  disposition: z.literal("retry_when_ready"),
})
  .refine((value) => value.memberIds.length === 0, "infrastructure cannot blame a member")
  .refine((value) => value.findingIds.length === 0, "infrastructure cannot carry policy findings");

const NeedsProductDecision = Identity.extend({
  classification: z.literal("needs_product_decision"),
  reasonCode: z.enum(["review_changes_requested", "hitl_pending"]),
  retryability: z.literal("non_retryable"),
  wakeKey: DerivedWakeKey,
  disposition: z.literal("await_product_decision"),
})
  .refine((value) => value.memberIds.length === 0, "a product decision is not member blame")
  .refine((value) => value.findingIds.length === 0, "a product decision cannot carry policy findings");

const UnknownFailClosed = Identity.extend({
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
}).refine((value) => value.memberIds.length === 0, "unknown evidence cannot blame a member");

/**
 * Durable, prose-free mq-1 classification. The union makes infrastructure's
 * retryability/member-attribution invariants unrepresentable in valid events.
 */
export const MergeSignalClassifiedPayload = z.union([
  DeterministicPolicy,
  TransientInfrastructure,
  NeedsProductDecision,
  UnknownFailClosed,
]);
export type MergeSignalClassificationV1 = z.infer<typeof MergeSignalClassifiedPayload>;

/** Emitted only for a validated member-local deterministic policy block. */
export const MergeMemberPolicyBlockedPayload = DeterministicPolicy;
export type MergeMemberPolicyBlockedPayload = z.infer<typeof MergeMemberPolicyBlockedPayload>;

const EventId = z.string().regex(/^\d+$/u);
const ObservedAt = z.string().datetime({ offset: true });

export const MergeQueueAuthoritySignalProjection = z
  .object({
    eventId: EventId,
    observedAt: ObservedAt,
    signal: MergeSignalClassifiedPayload,
  })
  .strict();
export type MergeQueueAuthoritySignalProjection = z.infer<typeof MergeQueueAuthoritySignalProjection>;

export const MergeQueueAuthoritySignalsListResponse = z
  .object({
    latestEvaluationId: DerivedEvaluationId.nullable(),
    signals: z.array(MergeQueueAuthoritySignalProjection),
  })
  .strict();
export type MergeQueueAuthoritySignalsListResponse = z.infer<typeof MergeQueueAuthoritySignalsListResponse>;

export const MergeQueueAuthorityEvaluationResponse = z
  .object({
    evaluationId: DerivedEvaluationId,
    signals: z.array(MergeQueueAuthoritySignalProjection).min(1),
  })
  .strict();
export type MergeQueueAuthorityEvaluationResponse = z.infer<typeof MergeQueueAuthorityEvaluationResponse>;

/** Kept exclusive until migration 0045 leases the shared event registry. */
export const mergeQueueAuthoritySignalEventRegistry = {
  "merge.signal.classified": MergeSignalClassifiedPayload,
  "merge.member.policy_blocked": MergeMemberPolicyBlockedPayload,
} as const satisfies Record<string, z.ZodType>;
