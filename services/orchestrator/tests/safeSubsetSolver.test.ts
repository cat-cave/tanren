// cspell:ignore mqeval mqgrp

import { describe, expect, it } from "vitest";
import type { LandAuthorization } from "../src/engine/contracts/mergeAuthority.js";
import type {
  MultiMemberAuthorityEvaluation,
  MultiMemberAuthorityMemberOutcome,
} from "../src/engine/merge/multiMemberAuthorityTypes.js";
import { ddmin } from "../src/engine/merge/ddmin.js";
import { quickXPlain } from "../src/engine/merge/quickXplain.js";
import {
  solveSafeSubset,
  type SafeSubsetEvaluation,
  type SafeSubsetMember,
} from "../src/engine/merge/safeSubsetSolver.js";

const MEMBERS = ["A", "B", "C", "D", "E", "F"] as const;
const memberSpecs: ReadonlyArray<SafeSubsetMember> = [
  { specId: "A", dependsOn: [], weight: 10 },
  { specId: "B", dependsOn: ["A"], weight: 9 },
  { specId: "C", dependsOn: [], weight: 8 },
  { specId: "D", dependsOn: ["A"], weight: 7 },
  { specId: "E", dependsOn: ["B"], weight: 6 },
  { specId: "F", dependsOn: ["D"], weight: 5 },
];

function memberOutcomes(
  excluded: ReadonlyArray<string> = [],
  eligible: ReadonlyArray<string> = MEMBERS,
): MultiMemberAuthorityMemberOutcome[] {
  const eligibleIds = new Set(eligible);
  const excludedIds = new Set(excluded);
  return MEMBERS.map((specId) => ({
    specId,
    runId: `run-${specId.toLowerCase()}`,
    branch: `tanren/${specId.toLowerCase()}`,
    headSha: `head-${specId.toLowerCase()}`,
    disposition: excludedIds.has(specId) ? "exclude" : eligibleIds.has(specId) ? "admit" : "hold",
    findingIds: excludedIds.has(specId) ? [`finding-${specId.toLowerCase()}`] : [],
    reasonCodes: excludedIds.has(specId) ? ["audit_policy"] : [],
  }));
}

function authorized(ids: ReadonlyArray<string>): MultiMemberAuthorityEvaluation {
  return {
    evaluationId: "mqeval_authorized",
    groupId: "mqgrp_authorized",
    version: "multi_member_authority.v1",
    nodeId: "inode-v96",
    memberSetHash: "member-set",
    proofReuseKey: "proof-key",
    members: memberOutcomes([], ids).filter((member) => ids.includes(member.specId)),
    reasonCodes: [],
    kind: "authorized_subset",
    authorizedMemberIds: [...ids],
    eligibleMemberIds: [...ids],
    authorization: {
      decision: "authorized",
      subject: { kind: "integration_node", id: "inode-v96" },
      envelope: {} as LandAuthorization["envelope"],
      reasons: [],
    },
  };
}

function memberFailure(failed: string): MultiMemberAuthorityEvaluation {
  return {
    evaluationId: "mqeval_v96",
    groupId: "mqgrp_v96",
    version: "multi_member_authority.v1",
    nodeId: "inode-v96",
    memberSetHash: "member-set",
    proofReuseKey: "proof-key",
    members: memberOutcomes(
      [failed],
      MEMBERS.filter((id) => id !== failed),
    ),
    reasonCodes: ["audit_policy"],
    kind: "member_failure",
    failedMemberIds: [failed],
    heldMemberIds: [],
    eligibleMemberIds: MEMBERS.filter((id) => id !== failed),
    findingIds: [`finding-${failed.toLowerCase()}`],
    authorization: {
      decision: "blocked",
      subject: { kind: "integration_node", id: "inode-v96" },
      envelope: {} as LandAuthorization["envelope"],
      reasons: [{ input: "findings", detail: "P1 member-local policy failure" }],
    },
    w0: {
      missionNodeId: "mq-1",
      evaluationId: "mqeval_v96",
      groupId: "mqgrp_v96",
      signalVersion: "merge_signal.v1",
      classification: "deterministic_policy",
      reasonCode: "audit_policy",
      memberIds: [failed],
      findingIds: [`finding-${failed.toLowerCase()}`],
      retryability: "non_retryable",
      wakeKey: null,
      disposition: "member_repair",
    },
  };
}

function unknownEvaluation(): MultiMemberAuthorityEvaluation {
  return {
    evaluationId: "mqeval_interaction",
    groupId: "mqgrp_interaction",
    version: "multi_member_authority.v1",
    nodeId: "inode-interaction",
    memberSetHash: "member-set",
    proofReuseKey: "proof-key",
    members: memberOutcomes([], []),
    reasonCodes: ["integrated_gate_failure_under_bisect"],
    kind: "unknown_fail_closed",
    eligibleMemberIds: [],
  };
}

function transientEvaluation(): MultiMemberAuthorityEvaluation {
  return {
    ...unknownEvaluation(),
    evaluationId: "mqeval_transient",
    kind: "transient_infrastructure",
    reasonCodes: ["runner_transport"],
    w0: {
      missionNodeId: "mq-1",
      evaluationId: "mqeval_transient",
      groupId: "mqgrp_interaction",
      signalVersion: "merge_signal.v1",
      classification: "transient_infrastructure",
      reasonCode: "runner_transport",
      memberIds: [],
      findingIds: [],
      retryability: "retryable",
      wakeKey: "runner:batch",
      disposition: "retry_when_ready",
    },
  };
}

function isPairFailure(ids: ReadonlyArray<string>): boolean {
  const selected = new Set(ids);
  return selected.has("A") && selected.has("B");
}

describe("MQ-3 pure safe-subset algorithms", () => {
  it("ddmin isolates a real two-member interaction instead of bisecting a prefix", () => {
    const result = ddmin(["A", "B", "C", "D"], isPairFailure, { initialGranularity: 4 });

    expect(result.minimalFailingSet).toEqual(["A", "B"]);
    expect(result.startedFromFailure).toBe(true);
    expect(result.probes).toBeGreaterThan(1);
  });

  it("QuickXPlain returns the minimal conflict relative to an exact consistency oracle", () => {
    const result = quickXPlain([], ["A", "B", "C", "D"], (subset) => !isPairFailure(subset));

    expect(result.minimalConflictSet).toEqual(["A", "B"]);
    expect(result.backgroundWasInconsistent).toBe(false);
  });

  it("v96: directly isolates C and proposes the exact five-member maximum-weight DAG-closed set", () => {
    const evaluation = memberFailure("C");
    const safeFive = MEMBERS.filter((id) => id !== "C");
    const result = solveSafeSubset({
      evaluation,
      members: memberSpecs,
      probe: (ids) =>
        ids.length === safeFive.length && ids.every((id) => safeFive.includes(id))
          ? authorized(ids)
          : memberFailure("C"),
    });

    expect(result.proposedMemberIds).toEqual(safeFive);
    expect(result.excludedMemberIds).toEqual(["C"]);
    expect(result.heldMemberIds).toEqual([]);
    expect(result.failureConstraints).toEqual([
      { kind: "direct_member", memberIds: ["C"], source: "mq2_direct_attribution" },
    ]);
    expect(result.dependencyClosed).toBe(true);
    expect(result.provenByExactProbe).toBe(true);
    expect(result.status).toBe("maximal_safe");
    expect(result.exactEvaluation?.kind).toBe("authorized_subset");
  });

  it("flake and transient infrastructure signals never become member failure constraints", () => {
    const transient = solveSafeSubset({ evaluation: transientEvaluation(), members: memberSpecs });
    const flake = solveSafeSubset({
      evaluation: unknownEvaluation(),
      members: memberSpecs,
      signalKind: "flake_observation",
    });

    for (const result of [transient, flake]) {
      expect(result.proposedMemberIds).toEqual([...MEMBERS]);
      expect(result.excludedMemberIds).toEqual([]);
      expect(result.failureConstraints).toEqual([]);
      expect(result.interactionSets).toEqual([]);
      expect(result.status).toBe("deferred_no_constraint");
    }
  });

  it("does not reuse a failing subset against a passing superset in a non-monotone case", () => {
    const calls: string[] = [];
    const result = solveSafeSubset({
      evaluation: unknownEvaluation(),
      members: memberSpecs.slice(0, 2),
      signalKind: "interaction_failure",
      probe: (ids): SafeSubsetEvaluation => {
        calls.push(ids.join(","));
        return ids.length === 1 && ids[0] === "A" ? unknownEvaluation() : authorized(ids);
      },
    });

    expect(result.proposedMemberIds).toEqual(["A", "B"]);
    expect(result.failureConstraints).toEqual([]);
    expect(calls).toContain("A");
    expect(calls).toContain("A,B");
  });
});
