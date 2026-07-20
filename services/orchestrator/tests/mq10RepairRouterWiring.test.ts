// mq-10 — the router is wired into the REAL production call graph: a member_failure isolated by
// the pre-embark authority evaluator is routed through the AutonomousRepairRouter before the
// member is retired. Drives BatchMergeCoordinator.coordinate() (the real entry point) and proves
// the three routes: repair → writer rework; respec/blocked → NO writer rework, member retired.
import { describe, expect, it } from "vitest";
import type { BatchChecker } from "../src/engine/contracts/batchMergeCoordinator.js";
import type { BatchAuthorityEvaluator } from "../src/engine/merge/multiMemberAuthorityTypes.js";
import type {
  AutonomousRepairRouter,
  RouteMemberFailureInput,
  RouteMemberFailureOutcome,
} from "../src/engine/merge/autonomousRepairRouter.js";
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

const PROJECT = "project_mq10_wiring";

/** A member_failure evaluation isolating spec_b with an attributed deterministic-policy finding. */
function memberFailureEvaluator(): BatchAuthorityEvaluator {
  return {
    async evaluate(input) {
      const clean = await allowExactBatchAuthority().evaluate(input);
      if (clean.kind !== "authorized_subset") throw new Error("all-admit fixture did not authorize");
      const finding = { id: "finding-b", severity: "P1" as const, title: "B failed", body: "B owns the finding." };
      return {
        ...clean,
        kind: "member_failure",
        members: clean.members.map((member) =>
          member.specId === "spec_b"
            ? { ...member, disposition: "exclude" as const, findingIds: [finding.id], reasonCodes: ["audit_policy"] }
            : member,
        ),
        reasonCodes: ["audit_policy"],
        failedMemberIds: ["spec_b"],
        heldMemberIds: [],
        eligibleMemberIds: ["spec_a"],
        findingIds: [finding.id],
        authorization: { ...clean.authorization, decision: "blocked", reasons: [{ input: "findings", detail: "P1" }] },
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

class RecordingRepairRouter implements AutonomousRepairRouter {
  public readonly calls: RouteMemberFailureInput[] = [];
  public constructor(private readonly outcome: RouteMemberFailureOutcome) {}
  public async routeMemberFailure(input: RouteMemberFailureInput): Promise<RouteMemberFailureOutcome> {
    this.calls.push(input);
    return this.outcome;
  }
}

function coordinator(input: { checker: BatchChecker; router: AutonomousRepairRouter }) {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const events = new RecordingMergeQueueEventEmitter();
  const gateRework = new RecordingBatchGateReworkRouter();
  const instance = new BatchMergeCoordinator({
    queue,
    runner,
    checker: input.checker,
    authorityEvaluator: memberFailureEvaluator(),
    events,
    batchEvents: new RecordingBatchMergeEventEmitter(),
    escalator: new RecordingSpecEscalator(queue),
    gateRework,
    repairRouter: input.router,
    recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
    resolveMaxBatchSize: () => Promise.resolve(5),
    sleep: () => Promise.resolve(),
  });
  return { instance, queue, runner, gateRework };
}

function seedChain(queue: InMemoryMergeQueueModel): void {
  queue.seed({ projectId: PROJECT, runId: "run_a", specId: "spec_a", dependsOn: [], priority: "P1" });
  queue.seed({ projectId: PROJECT, runId: "run_b", specId: "spec_b", dependsOn: [], priority: "P1" });
}

describe("mq-10 autonomous-repair router — production call graph", () => {
  it("consults the router with the isolated member's deterministic-policy classification + findings", async () => {
    const router = new RecordingRepairRouter({ kind: "repair_in_place" });
    const harness = coordinator({ checker: new InMemoryBatchChecker(), router });
    seedChain(harness.queue);
    await harness.instance.coordinate(PROJECT);
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]).toMatchObject({
      sourceSpecId: "spec_b",
      runId: "run_b",
      classification: "deterministic_policy",
      findingIds: ["finding-b"],
      reasonCodes: ["audit_policy"],
    });
  });

  it("repair_in_place → the failing member goes to writer rework (existing self-heal)", async () => {
    const harness = coordinator({
      checker: new InMemoryBatchChecker(),
      router: new RecordingRepairRouter({ kind: "repair_in_place" }),
    });
    seedChain(harness.queue);
    const result = await harness.instance.coordinate(PROJECT);
    expect(harness.gateRework.routed.map(({ specId }) => specId)).toEqual(["spec_b"]);
    expect(harness.runner.drives).toEqual([{ runId: "run_a" }]);
    expect(result).toMatchObject({ mergedSpecId: "spec_a", dequeuedSpecId: "spec_b" });
  });

  it("respec → NO writer rework of the stuck spec; it is retired (replacement drives fresh)", async () => {
    const harness = coordinator({
      checker: new InMemoryBatchChecker(),
      router: new RecordingRepairRouter({
        kind: "respec",
        replacementSpecIds: ["spec_respec_1"],
        packetHash: `sha256:${"a".repeat(64)}`,
      }),
    });
    seedChain(harness.queue);
    const result = await harness.instance.coordinate(PROJECT);
    // The stuck spec is NOT re-authored in place (that is exactly the fixed point respec breaks).
    expect(harness.gateRework.routed).toEqual([]);
    expect(harness.runner.drives).toEqual([{ runId: "run_a" }]);
    expect(result).toMatchObject({ mergedSpecId: "spec_a", dequeuedSpecId: "spec_b" });
  });

  it("blocked_needs_attention → fail closed: no writer rework, the member is retired (never dropped)", async () => {
    const harness = coordinator({
      checker: new InMemoryBatchChecker(),
      router: new RecordingRepairRouter({ kind: "blocked_needs_attention", reason: "unknown_fail_closed" }),
    });
    seedChain(harness.queue);
    const result = await harness.instance.coordinate(PROJECT);
    expect(harness.gateRework.routed).toEqual([]);
    expect(result).toMatchObject({ dequeuedSpecId: "spec_b" });
  });
});
