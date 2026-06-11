// (autonomy-engine.md §2c): the SPECULATIVE-MERGE-HOLD at the merge stage —
// the safety property that a speculative dependent's MERGE waits until its
// ancestors are genuinely merged (no unreviewed ancestor code reaches `main`
// early). Its WORK proceeded against the integration branch, but `mergeForRun`
// HOLDS direct/drive merges (emits merge.speculative_held, returns `blocked`,
// never calls the merge API) while any ancestor is unmerged. A native_queue
// first pass still ENTERS the queue; the queue's dependency ordering holds it
// until ancestors land. Once ancestors have all merged, the dependent proceeds.

import { afterEach, describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { mergeForRun } from "../src/engine/workflow/reviewMerge/index.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import { recordingMergeProbe, ReviewMergePool, unusedHttp } from "./reviewMerge.fixtures.js";

describe("P2c-1 speculative-merge-hold (merge stage)", () => {
  // WS-A PR-7: `WALKER_JJ_LOCAL_BASE` now defaults ON. The merge HOLD gating is flag-agnostic
  // (it waits on genuinely-merged ancestors regardless of base path), so the hold tests below
  // need no flag. The LEGACY single-ref integ→default retarget + integ-ref cleanup (the three
  // tests that set `=0` below) is the break-glass path; its stack-walk replacement is covered
  // by reviewMergeStackedRetarget.test.ts. The legacy path stays until WS-B/PR-9 deletes it.
  afterEach(() => {
    delete process.env["WALKER_JJ_LOCAL_BASE"];
  });

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
    expect(events.events.some((e) => e.eventType === "task.completed")).toBe(true);
    expect(pool.tasks).toEqual([expect.objectContaining({ kind: "merge", status: "done", outcome: "ok" })]);
  });

  it("ENQUEUES a native_queue first-pass speculative dependent while an ancestor is unmerged", async () => {
    const pool = new ReviewMergePool("native_queue");
    pool.speculativeBase = "tanren/integ/spec_1";
    pool.specDependsOn = ["spec_a", "spec_b"];
    pool.mergedAncestors = ["spec_a"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, mergeSha: "x", conflict: false, status: 200, message: "merged" });
    const enqueued: Array<{ runId: string; specId: string; prNumber: number }> = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      enqueueNativeQueue: async (entry) => {
        enqueued.push({ runId: entry.runId, specId: entry.specId, prNumber: entry.prNumber });
        return { created: true };
      },
    });

    expect(result.outcome).toBe("queued");
    expect(enqueued).toEqual([{ runId: "run_1", specId: "spec_1", prNumber: 7 }]);
    expect(probe.mergeCalls).toBe(0);
    expect(probe.mergeabilityCalls).toBe(0);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.speculative_held");
    expect(types).toContain("merge.queued");
    expect(types).not.toContain("merge.completed");
    expect(events.events.find((e) => e.eventType === "merge.speculative_held")?.payload).toMatchObject({
      integration: "native_queue",
      unmergedAncestors: ["spec_b"],
    });
  });

  it("COMPLETES the queue-drive merge task when a speculative dependent is held", async () => {
    const pool = new ReviewMergePool("native_queue");
    pool.speculativeBase = "tanren/integ/spec_1";
    pool.specDependsOn = ["spec_a"];
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
      queueDrive: true,
    });

    expect(result.outcome).toBe("blocked");
    expect(probe.mergeCalls).toBe(0);
    expect(events.events.map((e) => e.eventType)).toEqual(["task.started", "merge.speculative_held", "task.completed"]);
    expect(pool.tasks).toEqual([expect.objectContaining({ kind: "merge", status: "done", outcome: "ok" })]);
  });

  it("HOLDS when an ancestor has an unresolved speculative hold even if its spec row says merged", async () => {
    const pool = new ReviewMergePool("direct_merge");
    pool.speculativeBase = "tanren/integ/spec_1";
    pool.specDependsOn = ["spec_a"];
    pool.mergedAncestors = ["spec_a"];
    pool.unresolvedSpeculativeHolds = ["spec_a"];
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

    expect(result.outcome).toBe("blocked");
    expect(probe.mergeCalls).toBe(0);
    expect(events.events.find((e) => e.eventType === "merge.speculative_held")?.payload).toMatchObject({
      unmergedAncestors: ["spec_a"],
    });
    expect(events.events.some((e) => e.eventType === "merge.completed")).toBe(false);
  });

  it("a held speculative dependent resumes autonomously once the ancestor really merges", async () => {
    // Legacy single-ref retarget path (no ancestor_stack) — the `=0` break-glass.
    process.env["WALKER_JJ_LOCAL_BASE"] = "0";
    const pool = new ReviewMergePool("direct_merge");
    pool.speculativeBase = "tanren/integ/spec_1";
    pool.specDependsOn = ["spec_a"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe(
      {
        merged: true,
        mergeSha: "merge-sha",
        conflict: false,
        status: 200,
        message: "merged",
      },
      {
        mergeabilityReads: [
          { state: "clean", behind: false, baseBranch: "tanren/integ/spec_1", headBranch: "tanren/run_1" },
          { state: "clean", behind: false, baseBranch: "main", headBranch: "tanren/run_1" },
        ],
      },
    );

    const held = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
    });

    expect(held.outcome).toBe("blocked");
    expect(probe.mergeCalls).toBe(0);
    expect(events.events.some((e) => e.eventType === "merge.completed")).toBe(false);
    expect(pool.tasks).toEqual([expect.objectContaining({ kind: "merge", status: "done", outcome: "ok" })]);

    pool.mergedAncestors = ["spec_a"];
    const resumed = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
    });

    expect(resumed.outcome).toBe("merged");
    expect(probe.retargetedBases).toEqual(["main"]);
    expect(probe.mergeCalls).toBe(1);
    expect(probe.deletedIntegrationBranches).toEqual(["tanren/integ/spec_1"]);
    expect(events.events.map((e) => e.eventType)).toEqual([
      "task.started",
      "merge.speculative_held",
      "task.completed",
      "task.started",
      "merge.retargeted",
      "merge.queued",
      "merge.completed",
      "merge.integration_cleaned",
      "task.completed",
    ]);
    expect(pool.tasks).toEqual([expect.objectContaining({ kind: "merge", status: "done", outcome: "ok" })]);
  });

  it("RE-TARGETS to default_branch + merges on real main once ALL ancestors merged, then cleans the integ ref", async () => {
    // Legacy single-ref retarget path (no ancestor_stack) — the `=0` break-glass.
    process.env["WALKER_JJ_LOCAL_BASE"] = "0";
    const pool = new ReviewMergePool("direct_merge");
    // Still flagged speculative (PR is based on the integration ref), but every
    // ancestor has now merged — the hold clears.
    pool.speculativeBase = "tanren/integ/spec_1";
    pool.specDependsOn = ["spec_a", "spec_b"];
    pool.mergedAncestors = ["spec_a", "spec_b"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe(
      {
        merged: true,
        mergeSha: "merge-sha",
        conflict: false,
        status: 200,
        message: "merged",
      },
      {
        mergeabilityReads: [
          { state: "clean", behind: false, baseBranch: "tanren/integ/spec_1", headBranch: "tanren/run_1" },
          { state: "clean", behind: false, baseBranch: "main", headBranch: "tanren/run_1" },
        ],
      },
    );

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
    // Legacy single-ref retarget path (no ancestor_stack) — the `=0` break-glass.
    process.env["WALKER_JJ_LOCAL_BASE"] = "0";
    const pool = new ReviewMergePool("direct_merge");
    pool.speculativeBase = "tanren/integ/spec_1";
    pool.specDependsOn = ["spec_a"];
    pool.mergedAncestors = ["spec_a"];
    const events = new FakeEventStore();
    // After the retarget to `main`, the branch is BEHIND the new base → rebases.
    const probe = recordingMergeProbe(
      { merged: true, mergeSha: "rebased-sha", conflict: false, status: 200, message: "merged" },
      {
        mergeabilityReads: [
          { state: "clean", behind: false, baseBranch: "tanren/integ/spec_1", headBranch: "tanren/run_1" },
          { state: "behind", behind: true, baseBranch: "main", headBranch: "tanren/run_1" },
        ],
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

  it("§7 ONE HANDLER: a `behind` mergeability routes its rebase through the unified baseShiftRebase hook (NOT probe.updateBranch)", async () => {
    // tanren-owns-the-engine.md §7: the two divergent base-shift handlers collapse into
    // ONE. When the `baseShiftRebase` hook is wired, a `behind` branch rebases via the
    // unified `BaseShiftCoordinator.rebaseOnto`, NOT the separate server-side update-branch.
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe(
      { merged: true, mergeSha: "rebased-sha", conflict: false, status: 200, message: "merged" },
      {
        mergeabilityReads: [{ state: "behind", behind: true, baseBranch: "main", headBranch: "tanren/run_1" }],
        // Wire updateBranch too — to PROVE the unified hook is used INSTEAD (it stays 0).
        updateBranch: { outcome: "updated", message: "server-side update (must NOT be used)" },
      },
    );
    const baseShiftCalls: Array<{ runId: string; baseBranch: string }> = [];
    // RESIDUAL #4 (§5 commit-binding): capture the head sha the dispatcher threads into
    // the re-gate so we can assert it is the rebased PR head, not the workspace HEAD.
    const reGateCalls: Array<{ rebasedHeadSha?: string }> = [];
    const REBASED_PR_HEAD = "d".repeat(40);

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      // THE ONE BASE-SHIFT HANDLER: the behind rebase routes here, not to updateBranch.
      // It surfaces the EXACT rebased PR head sha for the re-gate to bind to.
      baseShiftRebase: async (input) => {
        baseShiftCalls.push({ runId: input.runId, baseBranch: input.baseBranch });
        return { outcome: "rebased", rebasedHeadSha: REBASED_PR_HEAD };
      },
      reGateCi: async (hook) => {
        reGateCalls.push({ ...(hook?.rebasedHeadSha !== undefined && { rebasedHeadSha: hook.rebasedHeadSha }) });
        return { status: "passed" };
      },
    });

    expect(result.outcome).toBe("merged");
    // The UNIFIED hook drove the rebase…
    expect(baseShiftCalls).toEqual([{ runId: "run_1", baseBranch: "main" }]);
    // …and the separate server-side update-branch was NEVER called (one path).
    expect(probe.updateBranchCalls).toBe(0);
    // §5 COMMIT-BINDING: the dispatcher threaded the rebased PR-head sha into the re-gate
    // (so the re-gate verdict binds to the landed commit, not the stale workspace HEAD).
    expect(reGateCalls).toEqual([{ rebasedHeadSha: REBASED_PR_HEAD }]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.behind");
    expect(types).toContain("merge.rebased");
    expect(types).toContain("merge.completed");
  });

  it("§7 ONE HANDLER: a `held` outcome from the unified baseShiftRebase is a fail-closed recoverable conflict (no merge)", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe(
      { merged: true, mergeSha: "x", conflict: false, status: 200, message: "merged" },
      { mergeabilityReads: [{ state: "behind", behind: true, baseBranch: "main", headBranch: "tanren/run_1" }] },
    );

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      baseShiftRebase: async () => ({ outcome: "held", message: "base-shift rebase held (fail-closed)" }),
      reGateCi: async () => ({ status: "passed" }),
    });

    // Fail-closed: a held rebase is a recoverable conflict, NEVER a merge.
    expect(result.outcome).toBe("conflict");
    expect(probe.mergeCalls).toBe(0);
    expect(events.events.map((e) => e.eventType)).toContain("merge.conflict");
  });

  it("skips retarget when the live PR base is already default_branch and merges normally", async () => {
    const pool = new ReviewMergePool("direct_merge");
    pool.speculativeBase = "tanren/integ/spec_1";
    pool.specDependsOn = ["spec_a"];
    pool.mergedAncestors = ["spec_a"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe(
      { merged: true, mergeSha: "merge-sha", conflict: false, status: 200, message: "merged" },
      {
        mergeability: { state: "clean", behind: false, baseBranch: "main", headBranch: "tanren/run_1" },
      },
    );

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      resolveConflict: noopConflictResolver,
    });

    expect(result.outcome).toBe("merged");
    expect(probe.retargetedBases).toEqual([]);
    expect(probe.mergeCalls).toBe(1);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.completed");
    expect(types).not.toContain("merge.retargeted");
  });

  it("skips retarget when the live PR base is already default_branch and routes conflicts normally", async () => {
    const pool = new ReviewMergePool("direct_merge");
    pool.speculativeBase = "tanren/integ/spec_1";
    pool.specDependsOn = ["spec_a"];
    pool.mergedAncestors = ["spec_a"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe(
      { merged: true, mergeSha: "merge-sha", conflict: false, status: 200, message: "merged" },
      {
        mergeability: { state: "dirty", behind: false, baseBranch: "main", headBranch: "tanren/run_1" },
      },
    );
    let conflictResolverCalls = 0;

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      resolveConflict: async () => {
        conflictResolverCalls += 1;
        return { resolved: false };
      },
    });

    expect(result.outcome).toBe("conflict");
    expect(probe.retargetedBases).toEqual([]);
    expect(probe.mergeCalls).toBe(0);
    expect(conflictResolverCalls).toBe(1);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.conflict");
    expect(types).not.toContain("merge.retargeted");
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
