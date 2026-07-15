import { describe, expect, it } from "vitest";
import type { AppendEventInput, EventStore } from "../src/engine/eventStore.js";
import {
  appendMergeSignalClassification,
  classifyMergeSignal,
  type MergeSignalIdentityV1,
  type MergeSignalSourceV1,
} from "../src/engine/merge/authoritySignalClassification.js";

const IDENTITY: MergeSignalIdentityV1 = {
  evaluationId: "evaluation-17",
  groupId: "group-9",
  sourceEventId: "event-41",
};

function policySource(memberIds: string[] = ["C"]): MergeSignalSourceV1 {
  return {
    kind: "audit_policy",
    findings: [
      {
        finding: {
          id: "finding-p1",
          severity: "P1",
          title: "Merge regression",
          body: "The candidate violates the merge contract.",
        },
        memberIds,
      },
    ],
    posture: {
      blockReviewAt: "P1",
      p2p3Handling: "route-to-dag",
      autonomousRemediation: true,
    },
    repairRoute: "respec",
  };
}

describe("mq-1 merge authority signal classification", () => {
  it("attributes a policy P1 to member C without treating it as retryable infrastructure", () => {
    expect(classifyMergeSignal(IDENTITY, policySource())).toEqual({
      missionNodeId: "mq-1",
      evaluationId: "evaluation-17",
      groupId: "group-9",
      sourceEventId: "event-41",
      signalVersion: "merge_signal.v1",
      classification: "deterministic_policy",
      reasonCode: "audit_policy",
      memberIds: ["C"],
      findingIds: ["finding-p1"],
      retryability: "non_retryable",
      wakeKey: null,
      repairRoute: "respec",
    });
  });

  it("classifies a typed provider timeout as infrastructure with no member blame", () => {
    const classified = classifyMergeSignal(IDENTITY, {
      kind: "infrastructure",
      reasonCode: "provider_timeout",
      retryability: "retryable",
      wakeKey: "provider:openai:available",
    });

    expect(classified.classification).toBe("transient_infrastructure");
    expect(classified.reasonCode).toBe("provider_timeout");
    expect(classified.memberIds).toEqual([]);
    expect(classified.findingIds).toEqual([]);
    expect(classified.retryability).toBe("retryable");
  });

  it("fails an untyped runtime Error closed instead of laundering it into infrastructure", () => {
    const classified = classifyMergeSignal(IDENTITY, new Error("provider timed out"));

    expect(classified.classification).toBe("unknown_fail_closed");
    expect(classified.reasonCode).toBe("untyped_error");
    expect(classified.retryability).toBe("unknown");
  });

  it("fails a policy finding with no member attribution closed", () => {
    const classified = classifyMergeSignal(IDENTITY, policySource([]));

    expect(classified.classification).toBe("unknown_fail_closed");
    expect(classified.reasonCode).toBe("unattributed_policy");
    expect(classified.findingIds).toEqual(["finding-p1"]);
  });

  it("appends the projection and the policy-only proof through EventStore in order", async () => {
    const appended: AppendEventInput[] = [];
    const eventStore: EventStore = {
      async append(input) {
        appended.push(input);
      },
    };
    const classification = classifyMergeSignal(IDENTITY, policySource());

    await appendMergeSignalClassification({
      eventStore,
      orgId: "org-acme",
      projectId: "project-tanren",
      runId: "run-v97",
      specId: "spec-merge",
      classification,
    });

    expect(appended.map(({ eventType }) => eventType)).toEqual([
      "merge.signal.classified",
      "merge.member.policy_blocked",
    ]);
    expect(appended[1]?.payload).toMatchObject({
      missionNodeId: "mq-1",
      classification: "deterministic_policy",
      memberIds: ["C"],
      findingIds: ["finding-p1"],
    });
  });

  it("never emits member-policy-blocked for an infrastructure signal", async () => {
    const appended: AppendEventInput[] = [];
    const eventStore: EventStore = {
      async append(input) {
        appended.push(input);
      },
    };
    const classification = classifyMergeSignal(IDENTITY, {
      kind: "infrastructure",
      reasonCode: "runner_unavailable",
      retryability: "retryable",
      wakeKey: "runner:pool:capacity",
    });

    await appendMergeSignalClassification({
      eventStore,
      orgId: "org-acme",
      projectId: "project-tanren",
      runId: "run-v97",
      specId: "spec-merge",
      classification,
    });

    expect(appended.map(({ eventType }) => eventType)).toEqual(["merge.signal.classified"]);
  });
});
