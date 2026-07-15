import { z } from "zod";

/** Mission-complete node identity stamped on every mq-1 proof event. */
export const MQ1_MISSION_NODE_ID = "mq-1" as const;

/** Version of the closed classification vocabulary. */
export const MERGE_SIGNAL_VERSION = "merge_signal.v1" as const;

export const MergeSignalClassificationKind = z.enum([
  "deterministic_policy",
  "transient_infrastructure",
  "needs_product_decision",
  "unknown_fail_closed",
]);
export type MergeSignalClassificationKind = z.infer<typeof MergeSignalClassificationKind>;

export const MergeSignalRetryability = z.enum(["retryable", "non_retryable", "unknown"]);
export type MergeSignalRetryability = z.infer<typeof MergeSignalRetryability>;

export const MergeSignalRepairRoute = z.enum(["writer_repair", "respec"]);
export type MergeSignalRepairRoute = z.infer<typeof MergeSignalRepairRoute>;

export const MergeSignalReasonCode = z.enum([
  "audit_policy",
  "provider_timeout",
  "provider_rate_limit",
  "runner_unavailable",
  "runner_transport",
  "code_host_unavailable",
  "gate_infrastructure",
  "review_changes_requested",
  "hitl_pending",
  "untyped_error",
  "unattributed_policy",
  "contradictory_evidence",
]);
export type MergeSignalReasonCode = z.infer<typeof MergeSignalReasonCode>;

const Identity = z
  .object({
    missionNodeId: z.literal(MQ1_MISSION_NODE_ID),
    evaluationId: z.string().min(1),
    groupId: z.string().min(1),
    memberIds: z.array(z.string().min(1)),
    findingIds: z.array(z.string().min(1)),
    signalVersion: z.literal(MERGE_SIGNAL_VERSION),
    sourceEventId: z.string().min(1).optional(),
  })
  .strict();

const DeterministicPolicy = Identity.extend({
  classification: z.literal("deterministic_policy"),
  reasonCode: z.literal("audit_policy"),
  retryability: z.literal("non_retryable"),
  wakeKey: z.null(),
  repairRoute: MergeSignalRepairRoute,
})
  .refine((value) => value.memberIds.length > 0, "deterministic policy requires attributed members")
  .refine((value) => value.findingIds.length > 0, "deterministic policy requires finding IDs");

const TransientInfrastructure = Identity.extend({
  classification: z.literal("transient_infrastructure"),
  reasonCode: z.enum([
    "provider_timeout",
    "provider_rate_limit",
    "runner_unavailable",
    "runner_transport",
    "code_host_unavailable",
    "gate_infrastructure",
  ]),
  retryability: z.enum(["retryable", "non_retryable"]),
  wakeKey: z.string().min(1),
  repairRoute: z.null(),
})
  .refine((value) => value.memberIds.length === 0, "infrastructure cannot blame a member")
  .refine((value) => value.findingIds.length === 0, "infrastructure cannot carry policy findings");

const NeedsProductDecision = Identity.extend({
  classification: z.literal("needs_product_decision"),
  reasonCode: z.enum(["review_changes_requested", "hitl_pending"]),
  retryability: z.literal("non_retryable"),
  wakeKey: z.string().min(1),
  repairRoute: z.null(),
});

const UnknownFailClosed = Identity.extend({
  classification: z.literal("unknown_fail_closed"),
  reasonCode: z.enum(["untyped_error", "unattributed_policy", "contradictory_evidence"]),
  retryability: z.literal("unknown"),
  wakeKey: z.null(),
  repairRoute: z.null(),
});

/** Durable classified-signal event. Raw errors and finding prose are deliberately absent. */
export const MergeSignalClassifiedPayload = z.union([
  DeterministicPolicy,
  TransientInfrastructure,
  NeedsProductDecision,
  UnknownFailClosed,
]);
export type MergeSignalClassifiedPayload = z.infer<typeof MergeSignalClassifiedPayload>;
export type MergeSignalClassificationV1 = MergeSignalClassifiedPayload;

/** Extra event emitted only for an attributed deterministic policy block. */
export const MergeMemberPolicyBlockedPayload = DeterministicPolicy;
export type MergeMemberPolicyBlockedPayload = z.infer<typeof MergeMemberPolicyBlockedPayload>;

/** Registry fragment kept with the schemas so the 500-line root stays bounded. */
export const mergeQueueAuthoritySignalEventRegistry = {
  "merge.signal.classified": MergeSignalClassifiedPayload,
  "merge.member.policy_blocked": MergeMemberPolicyBlockedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;
