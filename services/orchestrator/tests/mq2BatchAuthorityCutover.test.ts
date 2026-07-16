// MQ2-A4/A5: pre-embark member authority settlement never drives a failed member.
import { describe, expect, it } from "vitest";
import type { BatchChecker } from "../src/engine/contracts/batchMergeCoordinator.js";
import type { BatchAuthorityEvaluator } from "../src/engine/merge/multiMemberAuthorityTypes.js";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import {
  InMemoryBatchChecker,
  RecordingBatchGateReworkRouter,
  RecordingBatchMergeEventEmitter,
} from "./conformance/fakes/inMemoryBatchChecker.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";
import { InMemoryRecoveryOwnedSettlementWriter } from "./conformance/fakes/inMemoryRecoveryOwnedSettlementWriter.js";
import { allowExactBatchAuthority } from "./helpers/mq2BatchAuthority.js";

const PROJECT = "project_mq2_cutover";

function memberFailureEvaluator(): BatchAuthorityEvaluator {
  return {
    async evaluate(input) {
      const clean = await allowExactBatchAuthority().evaluate(input);
      if (clean.kind !== "authorized_subset") throw new Error("all-admit fixture did not authorize");
      const finding = {
        id: "finding-b",
        severity: "P1" as const,
        title: "B failed policy",
        body: "B alone owns the durable finding.",
      };
      return {
        ...clean,
        kind: "member_failure",
        members: clean.members.map((member) =>
          member.specId === "spec_b"
            ? { ...member, disposition: "exclude" as const, findingIds: [finding.id], reasonCodes: ["audit_policy"] }
            : member.specId === "spec_c"
              ? { ...member, disposition: "hold" as const, reasonCodes: ["dependency_failed"] }
              : member,
        ),
        reasonCodes: ["audit_policy", "findings"],
        failedMemberIds: ["spec_b"],
        heldMemberIds: ["spec_c"],
        eligibleMemberIds: ["spec_a"],
        findingIds: [finding.id],
        authorization: {
          ...clean.authorization,
          decision: "blocked",
          reasons: [{ input: "findings", detail: "P1 blocks under policy" }],
        },
        w0: {
          missionNodeId: "mq-1",
          evaluationId: clean.evaluationId,
          groupId: clean.groupId,
          signalVersion: "merge_signal.v1",
          classification: "deterministic_policy",
          reasonCode: "audit_policy",
          memberIds: ["spec_b"],
          findingIds: [finding.id],
          retryability: "non_retryable",
          wakeKey: null,
          disposition: "member_repair",
        },
      };
    },
  };
}

function coordinator(input: { checker: BatchChecker; authorityEvaluator: BatchAuthorityEvaluator }) {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const events = new RecordingMergeQueueEventEmitter();
  const gateRework = new RecordingBatchGateReworkRouter();
  const instance = new BatchMergeCoordinator({
    queue,
    runner,
    checker: input.checker,
    authorityEvaluator: input.authorityEvaluator,
    events,
    batchEvents: new RecordingBatchMergeEventEmitter(),
    escalator: new RecordingSpecEscalator(queue),
    gateRework,
    recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
    resolveMaxBatchSize: () => Promise.resolve(5),
    sleep: () => Promise.resolve(),
  });
  return { instance, queue, runner, gateRework };
}

function seedChain(queue: InMemoryMergeQueueModel): void {
  queue.seed({ projectId: PROJECT, runId: "run_a", specId: "spec_a", dependsOn: [], priority: "P1" });
  queue.seed({ projectId: PROJECT, runId: "run_b", specId: "spec_b", dependsOn: [], priority: "P1" });
  queue.seed({ projectId: PROJECT, runId: "run_c", specId: "spec_c", dependsOn: ["spec_b"], priority: "P1" });
}

describe("MQ-2 batch authority production cutover", () => {
  it("routes B to writer repair, drives only independent A, and dependency-holds C", async () => {
    const harness = coordinator({ checker: new InMemoryBatchChecker(), authorityEvaluator: memberFailureEvaluator() });
    seedChain(harness.queue);

    const result = await harness.instance.coordinate(PROJECT);

    expect(harness.runner.drives).toEqual([{ runId: "run_a" }]);
    expect(harness.gateRework.routed.map(({ specId }) => specId)).toEqual(["spec_b"]);
    expect(harness.queue.dequeueReasonOf("run_b")).toBe("superseded");
    expect(harness.queue.statusOf("run_c")).toBe("queued");
    expect(result).toMatchObject({ mergedSpecId: "spec_a", dequeuedSpecId: "spec_b" });
  });

  it("fails a multi-member pass with no exact binding closed before every drive", async () => {
    const checker: BatchChecker = {
      async checkBatch() {
        return { result: "pass", integrationBranch: "local-without-node-proof" };
      },
    };
    const harness = coordinator({ checker, authorityEvaluator: allowExactBatchAuthority() });
    seedChain(harness.queue);

    const result = await harness.instance.coordinate(PROJECT);

    expect(result).toMatchObject({ holdReason: "all_blocked" });
    expect(harness.runner.drives).toEqual([]);
    expect(harness.gateRework.routed).toEqual([]);
  });
});
