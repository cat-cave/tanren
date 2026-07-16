import { createHash } from "node:crypto";
import { z } from "zod";
import { decideFromFindings } from "../contracts/auditPosture.js";
import { severityRank, type Finding } from "../contracts/findings.js";
import type {
  AuthorizeLandInput,
  LandAuthorization,
  LandBindingEnvelope,
  LandBlockReason,
} from "../contracts/mergeAuthority.js";
import {
  MERGE_SIGNAL_VERSION,
  MergeMemberPolicyBlockedPayload,
  MergeSignalClassifiedPayload,
  MQ1_MISSION_NODE_ID,
  type MergeInfrastructureReasonCode,
  type MergeSignalClassificationV1,
  type MergeSignalReasonCode,
} from "../events/schemas/mergeQueueAuthoritySignals.js";

const InfrastructureEvidence = z
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
    /** Opaque typed source identity; hashed into a wake key and never emitted. */
    sourceKey: z.string().min(1),
  })
  .strict();

export type MergeInfrastructureEvidenceV1 = z.input<typeof InfrastructureEvidence>;

export interface MergeAuthorityEvidenceV1 {
  readonly kind: "authority";
  /** The value returned by MergeAuthorityV2 for the exact envelope below. */
  readonly authorization: LandAuthorization;
}

/** Strict producer for a typed infrastructure observation; no identity fields are accepted. */
export function mergeInfrastructureEvidence(input: MergeInfrastructureEvidenceV1): MergeInfrastructureEvidenceV1 {
  return InfrastructureEvidence.parse(input);
}

/** Bind the actual MergeAuthorityV2 result without copying or re-authoring it. */
export function mergeAuthorityEvidence(authorization: LandAuthorization): MergeAuthorityEvidenceV1 {
  return { kind: "authority", authorization };
}

export interface ClassifyMergeSignalInputV1 {
  readonly decisionInput: AuthorizeLandInput;
  readonly envelope: LandBindingEnvelope;
  /** Unknown is intentional: malformed runtime evidence must classify fail-closed. */
  readonly evidence: unknown;
}

type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | CanonicalObject;
interface CanonicalObject {
  readonly [key: string]: CanonicalValue;
}

interface AuthorityInspection {
  readonly kind: "authority";
  readonly authorization: LandAuthorization;
  readonly fingerprint: CanonicalObject;
}

interface InfrastructureInspection {
  readonly kind: "infrastructure";
  readonly reasonCode: MergeInfrastructureReasonCode;
  readonly sourceKey: string;
  readonly fingerprint: CanonicalObject;
}

interface InvalidInspection {
  readonly kind: "invalid";
  readonly reasonCode: Extract<MergeSignalReasonCode, "invalid_binding" | "untyped_evidence">;
  readonly fingerprint: CanonicalObject;
}

type EvidenceInspection = AuthorityInspection | InfrastructureInspection | InvalidInspection;

function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("merge-signal identity cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as CanonicalObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
}

function derivedId(prefix: "mqeval" | "mqgrp" | "mqwake", value: CanonicalValue): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return `${prefix}_${digest}`;
}

function stableUnique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort();
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bindingFingerprint(envelope: LandBindingEnvelope): CanonicalObject {
  return {
    artifactDigest: envelope.artifactDigest,
    expectedMainSha: envelope.expectedMainSha,
    headSha: envelope.headSha,
    memberSetHash: envelope.memberSetHash,
    members: envelope.members.map((member) => ({
      branch: member.branch,
      disposition: member.disposition,
      headSha: member.headSha,
      runId: member.runId,
      specId: member.specId,
    })),
    policyVersion: envelope.policyVersion,
    proofRoot: envelope.proofRoot,
    subject: { id: envelope.subject.id, kind: envelope.subject.kind },
    target: {
      intoMain: envelope.target.intoMain,
      repo: { name: envelope.target.repo.name, owner: envelope.target.repo.owner },
    },
  };
}

function decisionFingerprint(input: AuthorizeLandInput): CanonicalObject {
  return {
    auditPosture: {
      autonomousRemediation: input.auditPosture.autonomousRemediation ?? false,
      blockReviewAt: input.auditPosture.blockReviewAt,
      p2p3Handling: input.auditPosture.p2p3Handling,
    },
    budget:
      input.budget.kind === "resolved"
        ? { ceilingUsd: input.budget.ceilingUsd, kind: input.budget.kind, spentUsd: input.budget.spentUsd }
        : input.budget.kind === "unresolvable"
          ? { kind: input.budget.kind, reason: input.budget.reason }
          : { kind: input.budget.kind },
    conflicts: input.conflicts,
    demo: input.demo,
    findings: [...input.findings]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((finding) => ({
        body: finding.body,
        fixHint: finding.fixHint ?? null,
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
      })),
    gateVerdict: input.gateVerdict,
    hitlSignoff: input.hitlSignoff,
    mergeability: input.mergeability,
    reviewVerdict: input.reviewVerdict,
    subject: { id: input.subject.id, kind: input.subject.kind },
  };
}

function isReason(value: unknown): value is LandBlockReason {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { input?: unknown; detail?: unknown };
  return typeof candidate.input === "string" && typeof candidate.detail === "string";
}

function inspectEvidence(raw: unknown, envelope: LandBindingEnvelope): EvidenceInspection {
  const infrastructure = InfrastructureEvidence.safeParse(raw);
  if (infrastructure.success) {
    return {
      kind: "infrastructure",
      reasonCode: infrastructure.data.reasonCode,
      sourceKey: infrastructure.data.sourceKey,
      fingerprint: {
        kind: "infrastructure",
        reasonCode: infrastructure.data.reasonCode,
        sourceKey: infrastructure.data.sourceKey,
      },
    };
  }

  if (typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "authority") {
    const authorization = (raw as { authorization?: unknown }).authorization;
    if (typeof authorization !== "object" || authorization === null) {
      return { kind: "invalid", reasonCode: "untyped_evidence", fingerprint: { kind: "untyped" } };
    }
    const candidate = authorization as Partial<LandAuthorization>;
    if (
      candidate.envelope !== envelope ||
      !["authorized", "blocked", "needs_attention"].includes(candidate.decision ?? "") ||
      !Array.isArray(candidate.reasons) ||
      !candidate.reasons.every((reason) => isReason(reason)) ||
      candidate.subject?.kind !== "integration_node" ||
      typeof candidate.subject.id !== "string"
    ) {
      return { kind: "invalid", reasonCode: "invalid_binding", fingerprint: { kind: "invalid_authority" } };
    }
    const typed = candidate as LandAuthorization;
    return {
      kind: "authority",
      authorization: typed,
      fingerprint: {
        decision: typed.decision,
        kind: "authority",
        reasonInputs: stableUnique(typed.reasons.map((reason) => reason.input)),
      },
    };
  }

  return { kind: "invalid", reasonCode: "untyped_evidence", fingerprint: { kind: "untyped" } };
}

function hasValidBinding(input: AuthorizeLandInput, envelope: LandBindingEnvelope): boolean {
  if (input.subject.kind !== "integration_node" || envelope.subject.kind !== "integration_node") return false;
  if (input.subject.id === "" || input.subject.id !== envelope.subject.id || envelope.members.length === 0)
    return false;
  if (
    envelope.headSha === "" ||
    envelope.expectedMainSha === "" ||
    envelope.memberSetHash === "" ||
    envelope.policyVersion === ""
  ) {
    return false;
  }
  const memberKeys = envelope.members.map((member) => `${member.specId}\u0000${member.runId}`);
  return (
    envelope.members.every(
      (member) => member.specId !== "" && member.runId !== "" && member.branch !== "" && member.headSha !== "",
    ) && new Set(memberKeys).size === memberKeys.length
  );
}

function identity(
  input: AuthorizeLandInput,
  envelope: LandBindingEnvelope,
  evidence: EvidenceInspection,
): { evaluationId: string; groupId: string } {
  const binding = bindingFingerprint(envelope);
  const groupId = derivedId("mqgrp", {
    memberSetHash: envelope.memberSetHash,
    members: envelope.members.map((member) => ({ runId: member.runId, specId: member.specId })),
    subject: { id: envelope.subject.id, kind: envelope.subject.kind },
  });
  const evaluationId = derivedId("mqeval", {
    binding,
    decision: decisionFingerprint(input),
    evidence: evidence.fingerprint,
    signalVersion: MERGE_SIGNAL_VERSION,
  });
  return { evaluationId, groupId };
}

function commonIdentity(evaluationId: string, groupId: string) {
  return { missionNodeId: MQ1_MISSION_NODE_ID, evaluationId, groupId, signalVersion: MERGE_SIGNAL_VERSION } as const;
}

function unknownClassification(
  evaluationId: string,
  groupId: string,
  reasonCode: Extract<
    MergeSignalReasonCode,
    | "untyped_evidence"
    | "unattributed_policy"
    | "contradictory_evidence"
    | "invalid_binding"
    | "unclassified_authority_block"
  >,
  findingIds: ReadonlyArray<string> = [],
): MergeSignalClassificationV1 {
  return MergeSignalClassifiedPayload.parse({
    ...commonIdentity(evaluationId, groupId),
    classification: "unknown_fail_closed",
    reasonCode,
    memberIds: [],
    findingIds: stableUnique(findingIds),
    retryability: "unknown",
    wakeKey: null,
    disposition: "hold_fail_closed",
  });
}

function blockingFindings(input: AuthorizeLandInput): Finding[] {
  if (!decideFromFindings(input.findings, input.auditPosture).block) return [];
  return input.findings.filter(
    (finding) => severityRank(finding.severity) <= severityRank(input.auditPosture.blockReviewAt),
  );
}

/**
 * Classify one exact authority evaluation. No caller supplies durable identity,
 * attribution IDs, retryability, wake keys, or repair disposition.
 */
export function classifyMergeSignal(input: ClassifyMergeSignalInputV1): MergeSignalClassificationV1 {
  const evidence = inspectEvidence(input.evidence, input.envelope);
  const { evaluationId, groupId } = identity(input.decisionInput, input.envelope, evidence);
  if (!hasValidBinding(input.decisionInput, input.envelope)) {
    return unknownClassification(evaluationId, groupId, "invalid_binding");
  }
  if (evidence.kind === "invalid") {
    return unknownClassification(evaluationId, groupId, evidence.reasonCode);
  }
  if (evidence.kind === "infrastructure") {
    return MergeSignalClassifiedPayload.parse({
      ...commonIdentity(evaluationId, groupId),
      classification: "transient_infrastructure",
      reasonCode: evidence.reasonCode,
      memberIds: [],
      findingIds: [],
      retryability: "retryable",
      wakeKey: derivedId("mqwake", { reasonCode: evidence.reasonCode, sourceKey: evidence.sourceKey }),
      disposition: "retry_when_ready",
    });
  }

  const authorization = evidence.authorization;
  if (authorization.subject.id !== input.decisionInput.subject.id) {
    return unknownClassification(evaluationId, groupId, "invalid_binding");
  }
  const reasonInputs = new Set(authorization.reasons.map((reason) => reason.input));
  const blocking = blockingFindings(input.decisionInput);
  if (blocking.length > 0 || reasonInputs.has("findings")) {
    if (blocking.length === 0 || !reasonInputs.has("findings") || authorization.decision === "authorized") {
      return unknownClassification(
        evaluationId,
        groupId,
        "contradictory_evidence",
        blocking.map((finding) => finding.id),
      );
    }
    if (input.envelope.members.length !== 1) {
      return unknownClassification(
        evaluationId,
        groupId,
        "unattributed_policy",
        blocking.map((finding) => finding.id),
      );
    }
    return MergeSignalClassifiedPayload.parse({
      ...commonIdentity(evaluationId, groupId),
      classification: "deterministic_policy",
      reasonCode: "audit_policy",
      memberIds: [input.envelope.members[0]!.specId],
      findingIds: stableUnique(blocking.map((finding) => finding.id)),
      retryability: "non_retryable",
      wakeKey: null,
      disposition: "member_repair",
    });
  }

  if (authorization.decision === "needs_attention") {
    const reasonCode =
      input.decisionInput.reviewVerdict === "changes_requested" && reasonInputs.has("reviewVerdict")
        ? "review_changes_requested"
        : input.decisionInput.hitlSignoff === "pending" && reasonInputs.has("hitlSignoff")
          ? "hitl_pending"
          : undefined;
    if (reasonCode !== undefined) {
      return MergeSignalClassifiedPayload.parse({
        ...commonIdentity(evaluationId, groupId),
        classification: "needs_product_decision",
        reasonCode,
        memberIds: [],
        findingIds: [],
        retryability: "non_retryable",
        wakeKey: derivedId("mqwake", { evaluationId, reasonCode }),
        disposition: "await_product_decision",
      });
    }
    return unknownClassification(evaluationId, groupId, "contradictory_evidence");
  }

  return unknownClassification(
    evaluationId,
    groupId,
    authorization.decision === "authorized" || authorization.reasons.length === 0
      ? "contradictory_evidence"
      : "unclassified_authority_block",
  );
}

export type MergeSignalEventName = "merge.signal.classified" | "merge.member.policy_blocked";
export interface MergeSignalEventDraftV1 {
  readonly eventType: MergeSignalEventName;
  readonly payload: MergeSignalClassificationV1;
  readonly idempotencyKey: string;
}

/**
 * Prepare stable prior-event shapes for the future atomic writer cutover. This
 * module never appends: migration 0045 and the canonical writer lease come first.
 */
export function buildMergeSignalEventDrafts(
  classification: MergeSignalClassificationV1,
): ReadonlyArray<MergeSignalEventDraftV1> {
  const classified = MergeSignalClassifiedPayload.parse(classification);
  const drafts: MergeSignalEventDraftV1[] = [
    {
      eventType: "merge.signal.classified",
      payload: classified,
      idempotencyKey: `mq1:${classified.evaluationId}:merge.signal.classified`,
    },
  ];
  if (classified.classification === "deterministic_policy") {
    drafts.push({
      eventType: "merge.member.policy_blocked",
      payload: MergeMemberPolicyBlockedPayload.parse(classified),
      idempotencyKey: `mq1:${classified.evaluationId}:merge.member.policy_blocked`,
    });
  }
  return drafts;
}
