import { describe, expect, it } from "vitest";
import type { MergeQueueEntry, MergeQueueSnapshot } from "../src/engine/contracts/mergeCoordinator.js";
import {
  decodeFingerprint,
  IntegrationGraphScheduler,
  type ScheduleFactsResolution,
} from "../src/engine/merge/integrationGraphScheduler.js";

const BASE = "a".repeat(40);

function entry(specId: string, orderKey: number, dependsOn: string[] = []): MergeQueueEntry {
  return {
    orgId: "org_test",
    projectId: "project_test",
    queueId: `queue_${specId}`,
    runId: `run_${specId}`,
    specId,
    prUrl: `https://example.test/${specId}`,
    prNumber: orderKey + 1,
    dependsOn,
    priority: "P1",
    orderKey,
  };
}

function snapshot(entries: MergeQueueEntry[], mergedSpecIds: string[] = []): MergeQueueSnapshot {
  return { projectId: "project_test", entries, mergedSpecIds: new Set(mergedSpecIds), mergingInFlight: false };
}

function diff(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}`;
}

function scheduler(
  maximum: number,
  diffs: Record<string, unknown>,
  resolution: "resolved" | "stale" = "resolved",
): IntegrationGraphScheduler {
  return new IntegrationGraphScheduler({
    resolveMaximumBatchSize: async () => maximum,
    facts: {
      resolve: async (_snapshot, candidates): Promise<ScheduleFactsResolution> => {
        if (resolution === "stale") return { kind: "stale", reason: "head_changed" };
        return {
          kind: "resolved",
          baseSha: BASE,
          members: candidates.map((candidate) => ({
            queueId: candidate.queueId,
            runId: candidate.runId,
            specId: candidate.specId,
            branch: `branch-${candidate.specId}`,
            baseSha: BASE,
            headSha: candidate.orderKey.toString(16).padStart(40, "b"),
            diff: diffs[candidate.specId],
            reusableProofNode: candidate.orderKey === 0,
          })),
          activeLeases: [],
        };
      },
    },
  });
}

describe("IntegrationGraphScheduler", () => {
  it("is deterministic and bounds its dynamic batch using queue age and exact proof-node facts", async () => {
    const entries = [entry("spec_a", 0), entry("spec_b", 1), entry("spec_c", 2)];
    const subject = scheduler(3, {
      spec_a: diff("services/a/src/one.ts"),
      spec_b: diff("services/b/src/two.ts"),
      spec_c: diff("services/c/src/three.ts"),
    });

    const first = await subject.schedule(snapshot(entries));
    const second = await subject.schedule(snapshot(entries));

    expect(first.plan).toEqual(second.plan);
    expect(Object.isFrozen(first.plan)).toBe(true);
    expect(first.formation.batch.map((candidate) => candidate.runId)).toEqual([
      "run_spec_a",
      "run_spec_b",
      "run_spec_c",
    ]);
    expect(first.plan.dynamicCapacity).toMatchObject({
      minimum: 1,
      maximum: 3,
      selected: 3,
      reusableProofNodeCount: 1,
    });
  });

  it("makes a real migration diff a serial barrier instead of co-batching it with an unrelated path", async () => {
    const subject = scheduler(4, {
      spec_migration: diff("db/migrations/0101_new_table.sql"),
      spec_independent: diff("services/worker/src/job.ts"),
    });

    const scheduled = await subject.schedule(snapshot([entry("spec_migration", 0), entry("spec_independent", 1)]));

    expect(scheduled.formation.batch.map((candidate) => candidate.specId)).toEqual(["spec_migration"]);
    expect(
      scheduled.plan.semanticPartitions.find((partition) => partition.specId === "spec_migration")?.classes,
    ).toEqual(["migration"]);
    expect(scheduled.plan.blockers).toContain("semantic_conflict:spec_independent");
  });

  it.each([
    ["db/src/schema.ts", "shared"],
    ["services/orchestrator/src/routes/mergeQueue/schedule.ts", "shared"],
  ])("treats %s as a shared serial surface", async (path, expectedClass) => {
    const subject = scheduler(4, {
      spec_shared: diff(path),
      spec_independent: diff("services/worker/src/job.ts"),
    });

    const scheduled = await subject.schedule(snapshot([entry("spec_shared", 0), entry("spec_independent", 1)]));

    expect(scheduled.formation.batch.map((candidate) => candidate.specId)).toEqual(["spec_shared"]);
    expect(scheduled.plan.semanticPartitions.find((partition) => partition.specId === "spec_shared")?.classes).toEqual([
      expectedClass,
    ]);
    expect(scheduled.plan.blockers).toContain("semantic_conflict:spec_independent");
  });

  it("never selects a dependent whose unresolved dependency is not merged or selected", async () => {
    const subject = scheduler(4, { spec_dependent: diff("services/worker/src/job.ts") });

    const scheduled = await subject.schedule(snapshot([entry("spec_dependent", 0, ["spec_missing"])]));

    expect(scheduled.formation.batch).toEqual([]);
    expect(scheduled.plan.proposedRunIds).toEqual([]);
  });

  it("turns an unreadable diff into all_scopes and keeps the resulting proposal serial", async () => {
    const subject = scheduler(4, {
      spec_unknown: undefined,
      spec_other: diff("services/worker/src/job.ts"),
    });

    const scheduled = await subject.schedule(snapshot([entry("spec_unknown", 0), entry("spec_other", 1)]));

    expect(scheduled.formation.batch.map((candidate) => candidate.specId)).toEqual(["spec_unknown"]);
    expect(scheduled.plan.semanticPartitions.find((partition) => partition.specId === "spec_unknown")?.classes).toEqual(
      ["all_scopes"],
    );
    expect(scheduled.plan.conservativeReason).toBe("unreadable_or_ambiguous_diff_is_all_scopes");
  });

  it("rejects a stale external snapshot without proposing a batch", async () => {
    const subject = scheduler(4, { spec_a: diff("services/worker/src/job.ts") }, "stale");

    const scheduled = await subject.schedule(snapshot([entry("spec_a", 0)]));

    expect(scheduled.formation.batch).toEqual([]);
    expect(scheduled.plan.blockers).toEqual(["head_changed"]);
  });

  it("treats a non-canonical persisted fingerprint as all_scopes rather than trusting its scope", () => {
    expect(decodeFingerprint("semantic:v1:path%3Az|path%3Aa").classes).toEqual(["all_scopes"]);
    expect(decodeFingerprint("semantic:v1:path%3Aa|path%3Aa").classes).toEqual(["all_scopes"]);
  });
});
