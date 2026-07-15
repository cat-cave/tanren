import { z } from "zod";
import { decideFromFindings } from "../contracts/auditPosture.js";
import { severityRank, type Finding } from "../contracts/findings.js";
import type { EventStore } from "../eventStore.js";
import {
  MERGE_SIGNAL_VERSION,
  MQ1_MISSION_NODE_ID,
  type MergeSignalClassificationV1,
  type MergeSignalReasonCode,
  type MergeSignalRepairRoute,
} from "../events/schemas/mergeQueueAuthoritySignals.js";

const FindingSchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum(["P0", "P1", "P2", "P3"]),
    title: z.string().min(1),
    body: z.string().min(1),
    fixHint: z.string().min(1).optional(),
  })
  .strict();

const AuditPolicySource = z
  .object({
    kind: z.literal("audit_policy"),
    findings: z.array(
      z
        .object({
          finding: FindingSchema,
          memberIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    posture: z
      .object({
        blockReviewAt: z.enum(["P0", "P1", "P2", "P3"]),
        p2p3Handling: z.enum(["fix-if-idle", "route-to-dag"]),
        autonomousRemediation: z.boolean().optional(),
      })
      .strict(),
    repairRoute: z.enum(["writer_repair", "respec"]),
  })
  .strict();

const InfrastructureSource = z
  .object({
    kind: z.literal("infrastructure"),
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
  })
  .strict();

const ProductDecisionSource = z
  .object({
    kind: z.literal("product_decision"),
    reasonCode: z.enum(["review_changes_requested", "hitl_pending"]),
    memberIds: z.array(z.string().min(1)).default([]),
    wakeKey: z.string().min(1),
  })
  .strict();

const UnknownSource = z
  .object({
    kind: z.literal("unknown"),
    reasonCode: z.enum(["untyped_error", "unattributed_policy", "contradictory_evidence"]),
    memberIds: z.array(z.string().min(1)).default([]),
    findingIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

const MergeSignalSource = z.discriminatedUnion("kind", [
  AuditPolicySource,
  InfrastructureSource,
  ProductDecisionSource,
  UnknownSource,
]);

export type MergeSignalSourceV1 = z.input<typeof MergeSignalSource>;

export interface MergeSignalIdentityV1 {
  readonly evaluationId: string;
  readonly groupId: string;
  readonly sourceEventId?: string;
}

function stableUnique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function identityFields(identity: MergeSignalIdentityV1) {
  return {
    missionNodeId: MQ1_MISSION_NODE_ID,
    evaluationId: identity.evaluationId,
    groupId: identity.groupId,
    signalVersion: MERGE_SIGNAL_VERSION,
    ...(identity.sourceEventId === undefined ? {} : { sourceEventId: identity.sourceEventId }),
  } as const;
}

function unknownClassification(
  identity: MergeSignalIdentityV1,
  reasonCode: Extract<MergeSignalReasonCode, "untyped_error" | "unattributed_policy" | "contradictory_evidence">,
  memberIds: ReadonlyArray<string> = [],
  findingIds: ReadonlyArray<string> = [],
): MergeSignalClassificationV1 {
  return {
    ...identityFields(identity),
    classification: "unknown_fail_closed",
    reasonCode,
    memberIds: stableUnique(memberIds),
    findingIds: stableUnique(findingIds),
    retryability: "unknown",
    wakeKey: null,
    repairRoute: null,
  };
}

/**
 * Classify one authority-adjacent signal without message matching. Unknown runtime
 * input fails closed and can never enter the infrastructure arm by default.
 */
export function classifyMergeSignal(identity: MergeSignalIdentityV1, rawSource: unknown): MergeSignalClassificationV1 {
  const parsed = MergeSignalSource.safeParse(rawSource);
  if (!parsed.success) {
    return unknownClassification(identity, "untyped_error");
  }
  const source = parsed.data;
  switch (source.kind) {
    case "infrastructure":
      return {
        ...identityFields(identity),
        classification: "transient_infrastructure",
        reasonCode: source.reasonCode,
        memberIds: [],
        findingIds: [],
        retryability: source.retryability,
        wakeKey: source.wakeKey,
        repairRoute: null,
      };
    case "product_decision":
      return {
        ...identityFields(identity),
        classification: "needs_product_decision",
        reasonCode: source.reasonCode,
        memberIds: stableUnique(source.memberIds),
        findingIds: [],
        retryability: "non_retryable",
        wakeKey: source.wakeKey,
        repairRoute: null,
      };
    case "unknown":
      return unknownClassification(identity, source.reasonCode, source.memberIds, source.findingIds);
    case "audit_policy":
      return classifyAuditPolicy(identity, source);
  }
  return unknownClassification(identity, "untyped_error");
}

function classifyAuditPolicy(
  identity: MergeSignalIdentityV1,
  source: z.output<typeof AuditPolicySource>,
): MergeSignalClassificationV1 {
  const findings: Finding[] = source.findings.map(({ finding }) => finding);
  const postureDecision = decideFromFindings(findings, source.posture);
  if (!postureDecision.block) {
    return unknownClassification(
      identity,
      "contradictory_evidence",
      [],
      findings.map((finding) => finding.id),
    );
  }
  const blocking = source.findings.filter(
    ({ finding }) => severityRank(finding.severity) <= severityRank(source.posture.blockReviewAt),
  );
  if (blocking.some(({ memberIds }) => memberIds.length === 0)) {
    return unknownClassification(
      identity,
      "unattributed_policy",
      blocking.flatMap(({ memberIds }) => memberIds),
      blocking.map(({ finding }) => finding.id),
    );
  }
  return {
    ...identityFields(identity),
    classification: "deterministic_policy",
    reasonCode: "audit_policy",
    memberIds: stableUnique(blocking.flatMap(({ memberIds }) => memberIds)),
    findingIds: stableUnique(blocking.map(({ finding }) => finding.id)),
    retryability: "non_retryable",
    wakeKey: null,
    repairRoute: source.repairRoute satisfies MergeSignalRepairRoute,
  };
}

/** Append the durable projection through the sole EventStore authority, in order. */
export async function appendMergeSignalClassification(input: {
  readonly eventStore: EventStore;
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly specId: string;
  readonly classification: MergeSignalClassificationV1;
}): Promise<void> {
  const envelope = {
    orgId: input.orgId,
    projectId: input.projectId,
    runId: input.runId,
    specId: input.specId,
  } as const;
  await input.eventStore.append({
    ...envelope,
    eventType: "merge.signal.classified",
    payload: input.classification,
  });
  if (input.classification.classification === "deterministic_policy") {
    await input.eventStore.append({
      ...envelope,
      eventType: "merge.member.policy_blocked",
      payload: input.classification,
    });
  }
}
