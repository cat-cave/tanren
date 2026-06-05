// (autonomy-engine.md §2c): the SPECULATIVE-MERGE-HOLD at the merge stage —
// the safety property that a speculative dependent's MERGE waits until its
// ancestors are genuinely merged (no unreviewed ancestor code reaches `main`
// early). Its WORK proceeded against the integration branch, but `mergeForRun`
// HOLDS the merge (emits merge.speculative_held, returns a `blocked` outcome,
// never calls the merge API) while any ancestor is unmerged — and proceeds to a
// real merge once the ancestors have all merged.

import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { mergeForRun } from "../src/engine/workflow/reviewMerge/index.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import { recordingMergeProbe, ReviewMergePool, unusedHttp } from "./reviewMerge.fixtures.js";

describe("P2c-1 speculative-merge-hold (merge stage)", () => {
  it("HOLDS a speculative dependent's merge while an ancestor is unmerged (no merge API call)", async () => {
    const pool = new ReviewMergePool("direct_merge");
    // The run is speculative on spec_a + spec_b; only spec_a has merged.
    pool.speculativeBase = "tanren/integ/spec_1";
    pool.specDependsOn = ["spec_a", "spec_b"];
    pool.mergedAncestors = ["spec_a"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, mergeSha: "x", conflict: false, status: 200, message: "merged" });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
    });

    // The merge is HELD — never merged against the integration base.
    expect(result.outcome).toBe("blocked");
    expect(probe.mergeCalls).toBe(0);
    const held = events.events.find((e) => e.eventType === "merge.speculative_held");
    expect(held?.payload).toMatchObject({
      speculativeBase: "tanren/integ/spec_1",
      unmergedAncestors: ["spec_b"],
    });
    expect(events.events.some((e) => e.eventType === "merge.completed")).toBe(false);
  });

  it("RE-TARGETS to default_branch + merges on real main once ALL ancestors merged, then cleans the integ ref", async () => {
    const pool = new ReviewMergePool("direct_merge");
    // Still flagged speculative (PR is based on the integration ref), but every
    // ancestor has now merged — the hold clears.
    pool.speculativeBase = "tanren/integ/spec_1";
    pool.specDependsOn = ["spec_a", "spec_b"];
    pool.mergedAncestors = ["spec_a", "spec_b"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      merged: true,
      mergeSha: "merge-sha",
      conflict: false,
      status: 200,
      message: "merged",
    });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
    });

    expect(result.outcome).toBe("merged");
    // CRITICAL: the PR base was re-pointed to `default_branch` (main) BEFORE the
    // merge — so the dependent lands on real main, never the integration ref.
    expect(probe.retargetedBases).toEqual(["main"]);
    expect(probe.mergeCalls).toBe(1);
    // The integration ref was cleaned up after the merge.
    expect(probe.deletedIntegrationBranches).toEqual(["tanren/integ/spec_1"]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.retargeted");
    expect(types).toContain("merge.completed");
    expect(types).toContain("merge.integration_cleaned");
    expect(types).not.toContain("merge.speculative_held");
    // The retarget event names the integ ref → default_branch transition.
    expect(events.events.find((e) => e.eventType === "merge.retargeted")?.payload).toMatchObject({
      fromBase: "tanren/integ/spec_1",
      toBase: "main",
    });
  });

  it("a cleared-hold dependent merges via the P2a rebase-onto-main path (behind → updateBranch → merge on main)", async () => {
    const pool = new ReviewMergePool("direct_merge");
    pool.speculativeBase = "tanren/integ/spec_1";
    pool.specDependsOn = ["spec_a"];
    pool.mergedAncestors = ["spec_a"];
    const events = new FakeEventStore();
    // After the retarget to `main`, the branch is BEHIND the new base → rebases.
    const probe = recordingMergeProbe(
      { merged: true, mergeSha: "rebased-sha", conflict: false, status: 200, message: "merged" },
      {
        mergeability: { state: "behind", behind: true, baseBranch: "main", headBranch: "tanren/run_1" },
        updateBranch: { outcome: "updated", message: "updated onto main" },
      },
    );
    let reGateCalls = 0;

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      reGateCi: async () => {
        reGateCalls += 1;
        return { status: "passed" };
      },
    });

    expect(result.outcome).toBe("merged");
    // Re-target THEN rebase onto the new (real) base THEN merge.
    expect(probe.retargetedBases).toEqual(["main"]);
    expect(probe.updateBranchCalls).toBe(1);
    expect(reGateCalls).toBe(1);
    expect(probe.mergeCalls).toBe(1);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.retargeted");
    expect(types).toContain("merge.behind");
    expect(types).toContain("merge.rebased");
    expect(types).toContain("merge.completed");
  });

  it("a NON-speculative run merges normally (the hold is a no-op)", async () => {
    const pool = new ReviewMergePool("direct_merge");
    // speculativeBase stays null (the default) ⇒ not speculative.
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      merged: true,
      mergeSha: "merge-sha",
      conflict: false,
      status: 200,
      message: "merged",
    });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
    });

    expect(result.outcome).toBe("merged");
    expect(probe.mergeCalls).toBe(1);
    // A normal run never re-targets and never cleans an integ ref.
    expect(probe.retargetedBases).toEqual([]);
    expect(probe.deletedIntegrationBranches).toEqual([]);
    expect(events.events.some((e) => e.eventType === "merge.speculative_held")).toBe(false);
    expect(events.events.some((e) => e.eventType === "merge.retargeted")).toBe(false);
  });
});
