// Drives the MergeCoordinator conformance suite against the REAL
// BatchMergeCoordinator wired to in-memory queue/runner/event fakes (TEST
// FIXTURES, tests/ only). Proves the production coordinator satisfies the §2d
// contract — DAG-order + priority + serialization + recoverable dequeue + liveness
// + idempotency — with no DB or VCS.

import { BatchMergeCoordinator } from "../../src/engine/merge/batchCoordinator.js";
import { expect, it } from "vitest";
import type { MergeDriveOutcome } from "../../src/engine/contracts/mergeCoordinator.js";
import { memberKey } from "../../src/engine/contracts/integrationNodes.js";
import { IntegrationNodeMaterializer } from "../../src/engine/merge/integrationNodeMaterializer.js";
import type { SpecPriority } from "../../src/engine/state/spec.js";
import {
  createInMemoryIntegrationNodeMaterializationStore,
  InMemoryMergeQueueModel,
  RecordingLandGroupReconciler,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./fakes/inMemoryMergeQueue.js";
import { InMemoryWorkspaceVcsCore } from "./fakes/inMemoryWorkspaceVcsCore.js";
import { InMemoryRecoveryOwnedSettlementWriter } from "./fakes/inMemoryRecoveryOwnedSettlementWriter.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./fakes/inMemoryBatchChecker.js";
import {
  describeMergeCoordinatorConformance,
  type MergeCoordinatorConformanceHarness,
} from "./mergeCoordinatorConformance.js";
import { allowExactBatchAuthority } from "../helpers/mq2BatchAuthority.js";

describeMergeCoordinatorConformance("BatchMergeCoordinator (in-memory)", {
  make(): MergeCoordinatorConformanceHarness {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    const coordinator = new BatchMergeCoordinator({
      authorityEvaluator: allowExactBatchAuthority(),
      queue,
      runner,
      checker: new InMemoryBatchChecker(),
      events,
      batchEvents: new RecordingBatchMergeEventEmitter(),
      escalator,
      recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
      // Conformance suite asserts one-at-a-time selection; batch size 1 preserves that.
      resolveMaxBatchSize: async () => 1,
    });
    return {
      coordinator,
      projectId: "project_conf",
      seed(entry): void {
        queue.seed({
          runId: entry.runId,
          specId: entry.specId,
          dependsOn: entry.dependsOn,
          priority: (entry.priority ?? "tbd") as SpecPriority,
        });
      },
      seedLegacyDequeued(entry): void {
        queue.seedLegacyDequeued({
          runId: entry.runId,
          specId: entry.specId,
          reason: entry.reason,
          dependsOn: entry.dependsOn,
          priority: (entry.priority ?? "tbd") as SpecPriority,
        });
      },
      setMerged(specId: string): void {
        queue.markSpecMerged(specId);
      },
      scriptDrive(runId: string, outcome: MergeDriveOutcome): void {
        runner.script(runId, outcome);
      },
      statusOf(runId) {
        return queue.statusOf(runId);
      },
      drives: runner.drives,
      events: events.events,
      escalations: escalator.escalations,
    };
  },
});

it("routes an authorized two-member batch through the synced atomic land-group fake", async () => {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const landGroups = new RecordingLandGroupReconciler();
  const authority = allowExactBatchAuthority();
  const coordinator = new BatchMergeCoordinator({
    authorityEvaluator: { ...authority, landAuthorizedGroup: (input) => landGroups.land(input) },
    queue,
    runner,
    checker: new InMemoryBatchChecker(),
    events: new RecordingMergeQueueEventEmitter(),
    batchEvents: new RecordingBatchMergeEventEmitter(),
    escalator: new RecordingSpecEscalator(queue),
    recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, new RecordingMergeQueueEventEmitter()),
    resolveMaxBatchSize: async () => 2,
  });
  queue.seed({ runId: "run_group_a", specId: "spec_group_a", dependsOn: [], priority: "P1" });
  queue.seed({ runId: "run_group_b", specId: "spec_group_b", dependsOn: [], priority: "P1" });

  await expect(coordinator.coordinate("project_conf")).resolves.toMatchObject({ mergedSpecId: "spec_group_b" });
  expect(landGroups.lands).toHaveLength(1);
  expect(landGroups.lands[0]?.specIds).toEqual(["spec_group_a", "spec_group_b"]);
  expect(runner.drives).toEqual([]);
  expect(queue.statusOf("run_group_a")).toBe("merged");
  expect(queue.statusOf("run_group_b")).toBe("merged");
});

it("EXERCISES the synced fake: jj-assembles and materializes an authorized two-member subset", async () => {
  const baseSha = "a".repeat(40);
  const memberA = "b".repeat(40);
  const memberB = "c".repeat(40);
  const workspace = new InMemoryWorkspaceVcsCore();
  workspace.seedRemoteRef("main", baseSha);
  workspace.seedRemoteRef("feature/a", memberA);
  workspace.seedRemoteRef("feature/b", memberB);
  const nodes = createInMemoryIntegrationNodeMaterializationStore();
  const materializer = new IntegrationNodeMaterializer(workspace, nodes);
  const members = [
    { specId: "spec_subset_a", runId: "run_subset_a", branch: "feature/a", headSha: memberA },
    { specId: "spec_subset_b", runId: "run_subset_b", branch: "feature/b", headSha: memberB },
  ];

  const result = await materializer.materialize({
    orgId: "org_test",
    projectId: "project_conf",
    repoUrl: "https://github.test/example/repo.git",
    baseBranch: "main",
    baseSha,
    members,
    localRef: "tanren-local-authorized-subset",
    workspacePath: "/scratch/authorized-subset",
    gateConfigHash: "gate-v1",
    policyVersion: "policy-v1",
  });

  expect(result).toMatchObject({ kind: "materialized", baseSha });
  if (result.kind !== "materialized") return;
  const expectedKey = memberKey(baseSha, [memberA, memberB]);
  expect(workspace.assemblies).toEqual([
    {
      baseSha,
      localRef: "tanren-local-authorized-subset",
      memberHeadShas: { spec_subset_a: memberA, spec_subset_b: memberB },
    },
  ]);
  expect(nodes.nodes).toEqual([
    expect.objectContaining({
      nodeId: result.nodeId,
      orgId: "org_test",
      projectId: "project_conf",
      baseSha,
      memberKey: expectedKey,
      members,
      status: "building",
    }),
  ]);
  expect(nodes.events).toEqual([
    expect.objectContaining({
      type: "integration.node.materialized",
      nodeId: result.nodeId,
      memberKey: expectedKey,
      baseSha,
      headSha: result.headSha,
      treeHash: result.treeHash,
    }),
  ]);
});
