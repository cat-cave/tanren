// cspell:ignore mqeval mqgrp mqwake
import { describe, expect, it } from "vitest";
import { parseDigest } from "../src/engine/contracts/cas.js";
import type { CodeHost } from "../src/engine/contracts/codeHost.js";
import type {
  AuthorizeLandInput,
  LandAuthorization,
  LandBindingEnvelope,
} from "../src/engine/contracts/mergeAuthority.js";
import { MergeSignalClassifiedPayload } from "../src/engine/events/schemas/eventVocabularyW0.js";
import {
  appendMergeSignalClassification,
  buildMergeSignalEventDrafts,
  classifyMergeSignal,
  mergeAuthorityEvidence,
  mergeInfrastructureEvidence,
  MQ1_POLICY_MEMBER_REPAIR_MARKER,
} from "../src/engine/merge/authoritySignalClassification.js";
import type { EventStore } from "../src/engine/eventStore.js";
import {
  type AuthorityLandStore,
  MergeAuthorityV2Impl,
  SubjectEqualityRevalidator,
} from "../src/engine/merge/mergeAuthorityV2Impl.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

function binding(memberIds: ReadonlyArray<string> = ["C"], headSha = "head-exact"): LandBindingEnvelope {
  return {
    subject: { kind: "integration_node", id: "integration-17" },
    members: memberIds.map((specId, index) => ({
      specId,
      runId: `run-${index + 1}`,
      branch: `tanren/${specId}`,
      headSha: `member-${index + 1}`,
      disposition: "admit",
    })),
    headSha,
    expectedMainSha: "main-before",
    artifactDigest: parseDigest(`sha256:${HEX_A}`),
    proofRoot: parseDigest(`sha256:${HEX_B}`),
    memberSetHash: "member-set-c",
    policyVersion: "policy-11",
    target: { repo: { owner: "cat-cave", name: "tanren" }, intoMain: "main" },
  };
}

function decisionInput(envelope: LandBindingEnvelope, overrides: Partial<AuthorizeLandInput> = {}): AuthorizeLandInput {
  return {
    subject: envelope.subject,
    gateVerdict: "passed",
    findings: [
      {
        id: "finding-p1",
        severity: "P1",
        title: "Product regression",
        body: "The built behavior violates the acceptance contract.",
      },
    ],
    auditPosture: {
      blockReviewAt: "P1",
      p2p3Handling: "route-to-dag",
      autonomousRemediation: true,
    },
    reviewVerdict: "approved",
    mergeability: "clean",
    budget: { kind: "not_required" },
    demo: "verified",
    hitlSignoff: "not_required",
    conflicts: "resolved",
    ...overrides,
  };
}

function authority(): MergeAuthorityV2Impl {
  return new MergeAuthorityV2Impl({} as CodeHost, new SubjectEqualityRevalidator(), {} as AuthorityLandStore);
}

async function classifyAuthority(
  input: AuthorizeLandInput,
  envelope: LandBindingEnvelope,
): Promise<{ authorization: LandAuthorization; classification: ReturnType<typeof classifyMergeSignal> }> {
  const authorization = await authority().authorizeLand(input, envelope);
  return {
    authorization,
    classification: classifyMergeSignal({
      decisionInput: input,
      envelope,
      evidence: mergeAuthorityEvidence(authorization),
    }),
  };
}

describe("mq-1 typed authority-signal classification", () => {
  it("attributes a blocking P1 to the sole bound member without infrastructure cosplay", async () => {
    const envelope = binding();
    const { classification } = await classifyAuthority(decisionInput(envelope), envelope);

    expect(classification).toMatchObject({
      missionNodeId: "mq-1",
      signalVersion: "merge_signal.v1",
      classification: "deterministic_policy",
      reasonCode: "audit_policy",
      memberIds: ["C"],
      findingIds: ["finding-p1"],
      retryability: "non_retryable",
      wakeKey: null,
      disposition: "member_repair",
    });
    expect(classification.evaluationId).toMatch(/^mqeval_[0-9a-f]{64}$/u);
    expect(classification.groupId).toMatch(/^mqgrp_[0-9a-f]{64}$/u);
  });

  it("derives stable identities and idempotency keys from exact typed inputs", async () => {
    const firstEnvelope = binding();
    const secondEnvelope = binding();
    const first = (await classifyAuthority(decisionInput(firstEnvelope), firstEnvelope)).classification;
    const second = (await classifyAuthority(decisionInput(secondEnvelope), secondEnvelope)).classification;

    expect(second.evaluationId).toBe(first.evaluationId);
    expect(second.groupId).toBe(first.groupId);
    expect(buildMergeSignalEventDrafts(second)).toEqual(buildMergeSignalEventDrafts(first));
    expect(buildMergeSignalEventDrafts(first).map((draft) => draft.idempotencyKey)).toEqual([
      `mq1:${first.evaluationId}:merge.signal.classified`,
      `mq1:${first.evaluationId}:merge.member.policy_blocked`,
    ]);

    const shiftedEnvelope = binding(["C"], "head-after-rebase");
    const shifted = (await classifyAuthority(decisionInput(shiftedEnvelope), shiftedEnvelope)).classification;
    expect(shifted.groupId).toBe(first.groupId);
    expect(shifted.evaluationId).not.toBe(first.evaluationId);
  });

  it("makes typed infrastructure retryable while emitting no member or policy blame", () => {
    const envelope = binding();
    const classification = classifyMergeSignal({
      decisionInput: decisionInput(envelope),
      envelope,
      evidence: mergeInfrastructureEvidence({
        kind: "infrastructure",
        reasonCode: "provider_timeout",
        sourceKey: "provider:codex",
      }),
    });

    expect(classification).toMatchObject({
      classification: "transient_infrastructure",
      reasonCode: "provider_timeout",
      memberIds: [],
      findingIds: [],
      retryability: "retryable",
      disposition: "retry_when_ready",
    });
    expect(classification.wakeKey).toMatch(/^mqwake_[0-9a-f]{64}$/u);
    expect(JSON.stringify(classification)).not.toContain("provider:codex");
    expect(buildMergeSignalEventDrafts(classification).map((draft) => draft.eventType)).toEqual([
      "merge.signal.classified",
    ]);
  });

  it("derives product-decision routing from a real authority result", async () => {
    const envelope = binding();
    const input = decisionInput(envelope, { findings: [], reviewVerdict: "changes_requested" });
    const { classification } = await classifyAuthority(input, envelope);

    expect(classification).toMatchObject({
      classification: "needs_product_decision",
      reasonCode: "review_changes_requested",
      memberIds: [],
      findingIds: [],
      retryability: "non_retryable",
      disposition: "await_product_decision",
    });
  });

  it("derives HITL product routing without member blame", async () => {
    const envelope = binding();
    const input = decisionInput(envelope, { findings: [], hitlSignoff: "pending" });
    const { classification } = await classifyAuthority(input, envelope);

    expect(classification).toMatchObject({
      classification: "needs_product_decision",
      reasonCode: "hitl_pending",
      memberIds: [],
      findingIds: [],
      disposition: "await_product_decision",
    });
  });

  it.each([
    "provider_timeout",
    "provider_rate_limit",
    "runner_unavailable",
    "runner_transport",
    "code_host_unavailable",
    "gate_infrastructure",
  ] as const)("keeps typed infrastructure reason %s inside the retryable no-blame arm", (reasonCode) => {
    const envelope = binding();
    const classification = classifyMergeSignal({
      decisionInput: decisionInput(envelope),
      envelope,
      evidence: mergeInfrastructureEvidence({ kind: "infrastructure", reasonCode, sourceKey: `source:${reasonCode}` }),
    });

    expect(classification).toMatchObject({
      classification: "transient_infrastructure",
      reasonCode,
      memberIds: [],
      findingIds: [],
      retryability: "retryable",
      disposition: "retry_when_ready",
    });
    expect(buildMergeSignalEventDrafts(classification)).toHaveLength(1);
  });

  it("fails an untyped Error closed; this is the unknown-to-infrastructure mutation lock", () => {
    const envelope = binding();
    const classification = classifyMergeSignal({
      decisionInput: decisionInput(envelope),
      envelope,
      evidence: new Error("provider timed out"),
    });

    expect(classification).toMatchObject({
      classification: "unknown_fail_closed",
      reasonCode: "untyped_evidence",
      memberIds: [],
      retryability: "unknown",
      disposition: "hold_fail_closed",
    });
  });

  it("rejects caller-supplied identity and disposition fields instead of laundering them", () => {
    const envelope = binding();
    const classification = classifyMergeSignal({
      decisionInput: decisionInput(envelope),
      envelope,
      evidence: {
        kind: "infrastructure",
        reasonCode: "provider_timeout",
        sourceKey: "provider:codex",
        evaluationId: "caller-evaluation",
        repairRoute: "respec",
      },
    });

    expect(classification.classification).toBe("unknown_fail_closed");
    expect(classification.reasonCode).toBe("untyped_evidence");
    expect(classification.evaluationId).not.toContain("caller-evaluation");
  });

  it("fails a multi-member policy block closed until real member attribution exists", async () => {
    const envelope = binding(["A", "C"]);
    const { classification } = await classifyAuthority(decisionInput(envelope), envelope);

    expect(classification).toMatchObject({
      classification: "unknown_fail_closed",
      reasonCode: "unattributed_policy",
      memberIds: [],
      findingIds: ["finding-p1"],
    });
  });

  it("accepts only explicit bound multi-member attribution and retains frozen W0 identity", async () => {
    const envelope = binding(["A", "C"]);
    const input = decisionInput(envelope);
    const authorization = await authority().authorizeLand(input, envelope);
    const classification = classifyMergeSignal({
      decisionInput: input,
      envelope,
      evidence: mergeAuthorityEvidence(authorization),
      attributedMemberIds: ["C"],
    });

    expect(classification).toMatchObject({
      missionNodeId: "mq-1",
      classification: "deterministic_policy",
      reasonCode: "audit_policy",
      memberIds: ["C"],
      findingIds: ["finding-p1"],
    });
  });

  it("rejects attribution to a member outside the exact envelope", async () => {
    const envelope = binding(["A", "C"]);
    const input = decisionInput(envelope);
    const authorization = await authority().authorizeLand(input, envelope);
    const classification = classifyMergeSignal({
      decisionInput: input,
      envelope,
      evidence: mergeAuthorityEvidence(authorization),
      attributedMemberIds: ["not-bound"],
    });

    expect(classification).toMatchObject({
      classification: "unknown_fail_closed",
      reasonCode: "unattributed_policy",
      memberIds: [],
    });
  });

  it("fails contradictory authority evidence closed", async () => {
    const envelope = binding();
    const input = decisionInput(envelope);
    const authorization = await authority().authorizeLand(input, envelope);
    const classification = classifyMergeSignal({
      decisionInput: input,
      envelope,
      evidence: mergeAuthorityEvidence({
        ...authorization,
        reasons: authorization.reasons.filter((reason) => reason.input !== "findings"),
      }),
    });

    expect(classification).toMatchObject({
      classification: "unknown_fail_closed",
      reasonCode: "contradictory_evidence",
      memberIds: [],
      findingIds: ["finding-p1"],
    });
  });

  it("fails a typed but unclassified gate-only authority block closed", async () => {
    const envelope = binding();
    const input = decisionInput(envelope, { findings: [], gateVerdict: "failed" });
    const { classification } = await classifyAuthority(input, envelope);

    expect(classification).toMatchObject({
      classification: "unknown_fail_closed",
      reasonCode: "unclassified_authority_block",
      memberIds: [],
      findingIds: [],
    });
  });

  it("rejects an empty binding before typed infrastructure can enter a retry arm", () => {
    const envelope = binding([]);
    const classification = classifyMergeSignal({
      decisionInput: decisionInput(envelope, { findings: [] }),
      envelope,
      evidence: mergeInfrastructureEvidence({
        kind: "infrastructure",
        reasonCode: "runner_unavailable",
        sourceKey: "runner:pool-a",
      }),
    });

    expect(classification).toMatchObject({
      classification: "unknown_fail_closed",
      reasonCode: "invalid_binding",
      memberIds: [],
      retryability: "unknown",
    });
  });

  it("uses code-unit ordering for content identities independent of process locale", async () => {
    const firstEnvelope = binding();
    const findings = [
      { id: "é", severity: "P1" as const, title: "accented", body: "accented id" },
      { id: "z", severity: "P1" as const, title: "ascii", body: "ascii id" },
    ];
    const first = (await classifyAuthority(decisionInput(firstEnvelope, { findings }), firstEnvelope)).classification;
    const secondEnvelope = binding();
    const second = (
      await classifyAuthority(decisionInput(secondEnvelope, { findings: findings.toReversed() }), secondEnvelope)
    ).classification;

    expect(first.findingIds).toEqual(["z", "é"]);
    expect(second.evaluationId).toBe(first.evaluationId);
    expect(second.findingIds).toEqual(first.findingIds);
  });

  it("rejects an authorization copied onto a different binding object", async () => {
    const actualEnvelope = binding();
    const input = decisionInput(actualEnvelope);
    const authorization = await authority().authorizeLand(input, actualEnvelope);
    const copiedEnvelope = { ...actualEnvelope };
    const classification = classifyMergeSignal({
      decisionInput: { ...input, subject: copiedEnvelope.subject },
      envelope: copiedEnvelope,
      evidence: mergeAuthorityEvidence(authorization),
    });

    expect(classification.classification).toBe("unknown_fail_closed");
    expect(classification.reasonCode).toBe("invalid_binding");
  });

  it("schema-rejects infrastructure mutants that blame members or claim non-retryability", () => {
    const envelope = binding();
    const infrastructure = classifyMergeSignal({
      decisionInput: decisionInput(envelope),
      envelope,
      evidence: mergeInfrastructureEvidence({
        kind: "infrastructure",
        reasonCode: "runner_unavailable",
        sourceKey: "runner:pool-a",
      }),
    });

    expect(MergeSignalClassifiedPayload.safeParse({ ...infrastructure, memberIds: ["C"] }).success).toBe(false);
    expect(MergeSignalClassifiedPayload.safeParse({ ...infrastructure, retryability: "non_retryable" }).success).toBe(
      false,
    );
  });

  it("appends classified then policy_blocked only for deterministic policy", async () => {
    const envelope = binding();
    const policy = (await classifyAuthority(decisionInput(envelope), envelope)).classification;
    const events: Array<{ eventType: string }> = [];
    const eventStore: EventStore = {
      async append(input) {
        events.push({ eventType: input.eventType });
      },
    };
    await appendMergeSignalClassification({
      eventStore,
      orgId: "org_a",
      projectId: "project_a",
      runId: "run-1",
      specId: "C",
      classification: policy,
    });
    expect(events.map((e) => e.eventType)).toEqual(["merge.signal.classified", "merge.member.policy_blocked"]);

    const infra = classifyMergeSignal({
      decisionInput: decisionInput(envelope),
      envelope,
      evidence: mergeInfrastructureEvidence({
        kind: "infrastructure",
        reasonCode: "provider_timeout",
        sourceKey: "provider:codex",
      }),
    });
    events.length = 0;
    await appendMergeSignalClassification({
      eventStore,
      orgId: "org_a",
      projectId: "project_a",
      classification: infra,
    });
    expect(events.map((e) => e.eventType)).toEqual(["merge.signal.classified"]);
    expect(policy.disposition).toBe("member_repair");
    expect(MQ1_POLICY_MEMBER_REPAIR_MARKER).toMatch(/^mq1:/u);
  });
});
