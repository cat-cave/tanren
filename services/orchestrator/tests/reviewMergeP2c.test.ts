// (autonomy-engine.md §2c; walker-jj-local-integration-design.md §3.2/§3.3): the
// SPECULATIVE-MERGE-HOLD at the merge stage — the safety property that a speculative
// dependent's MERGE waits until its ancestors are genuinely merged (no unreviewed ancestor
// code reaches `main` early). Its WORK proceeded against the jj-assembled ancestor stack,
// but `mergeForRun` HOLDS direct/drive merges (emits merge.speculative_held, returns
// `blocked`, never calls the merge API) while any ancestor is unmerged. A native_queue first
// pass still ENTERS the queue; the queue's dependency ordering holds it until ancestors land.
// jj-local: a run is "speculative" iff its `runs.ancestor_stack` is non-empty (there is no
// synthesized integration ref); the stacked-PR RETARGET WALK is covered by
// reviewMergeStackedRetarget.test.ts.

import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { mergeForRun } from "../src/engine/workflow/reviewMerge/index.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import {
  AUTHORITY_HEAD_SHA,
  authorityBundle,
  authorityHost,
  recordingMergeProbe,
  ReviewMergePool,
  unusedHttp,
} from "./reviewMerge.fixtures.js";

// A non-empty ancestor stack on spec_a (its PR-head branch `tanren/spec_a`) — the jj-local
// base source that marks a run speculative.
const STACK_ON_A = [{ specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha_a" }];
// A two-member stack (spec_a + spec_b) — a dependent stacked on both unmerged ancestors.
const STACK_ON_AB = [
  { specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha_a" },
  { specId: "spec_b", runId: "run_b", branch: "tanren/spec_b", headSha: "sha_b" },
];

describe("P2c-1 speculative-merge-hold (merge stage)", () => {
  it("HOLDS a speculative dependent's merge while an ancestor is unmerged (no land)", async () => {
    const pool = new ReviewMergePool("direct_merge");
    // The run is speculative (a non-empty ancestor stack) on spec_a + spec_b; only spec_a merged.
    pool.ancestorStack = STACK_ON_A;
    pool.specDependsOn = ["spec_a", "spec_b"];
    pool.mergedAncestors = ["spec_a"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe();
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
    });

    // The merge is HELD — never landed while an ancestor is unmerged.
    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    const held = events.events.find((e) => e.eventType === "merge.speculative_held");
    // jj-local: the held event names the immediate-ancestor PR-head branch (the stacked base).
    expect(held?.payload).toMatchObject({
      speculativeBase: "tanren/spec_a",
      unmergedAncestors: ["spec_b"],
    });
    expect(events.events.some((e) => e.eventType === "merge.completed")).toBe(false);
    expect(events.events.some((e) => e.eventType === "task.completed")).toBe(true);
    expect(pool.tasks).toEqual([expect.objectContaining({ kind: "merge", status: "done", outcome: "ok" })]);
  });

  it("ENQUEUES a native_queue first-pass speculative dependent while an ancestor is unmerged", async () => {
    const pool = new ReviewMergePool("native_queue");
    // Stacked on spec_a + spec_b; spec_a merged. The stack walk drops spec_a and tracks the
    // immediate still-unmerged ancestor (spec_b) — whose branch already IS the live base, so
    // no actual retarget call fires; only the stack-drop write + the held event.
    pool.ancestorStack = STACK_ON_AB;
    pool.specDependsOn = ["spec_a", "spec_b"];
    pool.mergedAncestors = ["spec_a"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      mergeability: { state: "clean", behind: false, baseBranch: "tanren/spec_b", headBranch: "tanren/run_1" },
    });
    const host = authorityHost();
    const landed: string[] = [];
    const enqueued: Array<{ runId: string; specId: string; prNumber: number }> = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      enqueueNativeQueue: async (entry) => {
        enqueued.push({ runId: entry.runId, specId: entry.specId, prNumber: entry.prNumber });
        return { created: true };
      },
    });

    expect(result.outcome).toBe("queued");
    expect(enqueued).toEqual([{ runId: "run_1", specId: "spec_1", prNumber: 7 }]);
    expect(landed).toEqual([]);
    // The stack walk read mergeability (to decide the base) but the base already matched the
    // immediate ancestor → no retarget call.
    expect(probe.retargetedBases).toEqual([]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.speculative_held");
    expect(types).toContain("merge.queued");
    expect(types).not.toContain("merge.completed");
    expect(types).not.toContain("merge.retargeted");
    expect(events.events.find((e) => e.eventType === "merge.speculative_held")?.payload).toMatchObject({
      integration: "native_queue",
      unmergedAncestors: ["spec_b"],
    });
  });

  it("COMPLETES the queue-drive merge task when a speculative dependent is held", async () => {
    const pool = new ReviewMergePool("native_queue");
    pool.ancestorStack = STACK_ON_A;
    pool.specDependsOn = ["spec_a"];
    const events = new FakeEventStore();
    // The immediate ancestor's branch already IS the live base → the stack walk reads
    // mergeability but issues no retarget (only the held event fires).
    const probe = recordingMergeProbe({
      mergeability: { state: "clean", behind: false, baseBranch: "tanren/spec_a", headBranch: "tanren/run_1" },
    });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      queueDrive: true,
    });

    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    expect(events.events.map((e) => e.eventType)).toEqual(["task.started", "merge.speculative_held", "task.completed"]);
    expect(pool.tasks).toEqual([expect.objectContaining({ kind: "merge", status: "done", outcome: "ok" })]);
  });

  it("HOLDS when an ancestor has an unresolved speculative hold even if its spec row says merged", async () => {
    const pool = new ReviewMergePool("direct_merge");
    pool.ancestorStack = STACK_ON_A;
    pool.specDependsOn = ["spec_a"];
    pool.mergedAncestors = ["spec_a"];
    pool.unresolvedSpeculativeHolds = ["spec_a"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe();
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
    });

    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    expect(events.events.find((e) => e.eventType === "merge.speculative_held")?.payload).toMatchObject({
      unmergedAncestors: ["spec_a"],
    });
    expect(events.events.some((e) => e.eventType === "merge.completed")).toBe(false);
  });

  it("§7 ONE HANDLER: a `behind` freshness routes its rebase through the unified baseShiftRebase hook", async () => {
    // tanren-owns-the-engine.md §7: the two divergent base-shift handlers collapse into
    // ONE. A `behind` branch rebases via the unified `BaseShiftCoordinator.rebaseOnto` (the
    // hook), the SOLE rebase path — the legacy server-side update-branch is GONE (§5h).
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      // behind on the freshness read; clean once the unified rebase advanced it (the read
      // the authority then re-judges — the land only clears on `clean`).
      mergeabilityReads: [
        { state: "behind", behind: true, baseBranch: "main", headBranch: "tanren/run_1" },
        { state: "clean", behind: false, baseBranch: "main", headBranch: "tanren/run_1" },
      ],
    });
    const host = authorityHost();
    const landed: string[] = [];
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
      mergeAuthority: authorityBundle(host, landed, { events }),
      // THE ONE BASE-SHIFT HANDLER: the behind rebase routes here (the sole rebase path).
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
    expect(landed).toEqual([AUTHORITY_HEAD_SHA]);
    // The UNIFIED hook drove the rebase (the sole rebase path; the server-side
    // update-branch fallback is gone — §5h).
    expect(baseShiftCalls).toEqual([{ runId: "run_1", baseBranch: "main" }]);
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
    const probe = recordingMergeProbe({
      mergeabilityReads: [{ state: "behind", behind: true, baseBranch: "main", headBranch: "tanren/run_1" }],
    });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      baseShiftRebase: async () => ({ outcome: "held", message: "base-shift rebase held (fail-closed)" }),
      reGateCi: async () => ({ status: "passed" }),
    });

    // Fail-closed: a held rebase is a recoverable conflict, NEVER a land.
    expect(result.outcome).toBe("conflict");
    expect(landed).toEqual([]);
    expect(events.events.map((e) => e.eventType)).toContain("merge.conflict");
  });

  it("skips retarget when the live PR base is already default_branch and lands normally", async () => {
    const pool = new ReviewMergePool("direct_merge");
    pool.ancestorStack = STACK_ON_A;
    pool.specDependsOn = ["spec_a"];
    pool.mergedAncestors = ["spec_a"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      mergeability: { state: "clean", behind: false, baseBranch: "main", headBranch: "tanren/run_1" },
    });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      resolveConflict: noopConflictResolver,
    });

    expect(result.outcome).toBe("merged");
    expect(probe.retargetedBases).toEqual([]);
    expect(landed).toEqual([AUTHORITY_HEAD_SHA]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.completed");
    expect(types).not.toContain("merge.retargeted");
  });

  it("skips retarget when the live PR base is already default_branch and routes conflicts normally", async () => {
    const pool = new ReviewMergePool("direct_merge");
    pool.ancestorStack = STACK_ON_A;
    pool.specDependsOn = ["spec_a"];
    pool.mergedAncestors = ["spec_a"];
    const events = new FakeEventStore();
    // §5h: freshness reports `behind` (never `dirty`); the unified base-shift hook surfaces
    // the conflict — the resolver then declines → recoverable `conflict`.
    const probe = recordingMergeProbe({
      mergeability: { state: "behind", behind: true, baseBranch: "main", headBranch: "tanren/run_1" },
    });
    const host = authorityHost();
    const landed: string[] = [];
    let conflictResolverCalls = 0;

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      baseShiftRebase: async () => ({ outcome: "conflict", message: "branch conflicts with base" }),
      resolveConflict: async () => {
        conflictResolverCalls += 1;
        return { resolved: false };
      },
    });

    expect(result.outcome).toBe("conflict");
    expect(probe.retargetedBases).toEqual([]);
    expect(landed).toEqual([]);
    expect(conflictResolverCalls).toBe(1);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.conflict");
    expect(types).not.toContain("merge.retargeted");
  });

  it("a NON-speculative run lands normally (the hold is a no-op)", async () => {
    const pool = new ReviewMergePool("direct_merge");
    // ancestorStack stays null (the default) ⇒ not speculative.
    const events = new FakeEventStore();
    const probe = recordingMergeProbe();
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
    });

    expect(result.outcome).toBe("merged");
    expect(landed).toEqual([AUTHORITY_HEAD_SHA]);
    // A normal run never re-targets.
    expect(probe.retargetedBases).toEqual([]);
    expect(events.events.some((e) => e.eventType === "merge.speculative_held")).toBe(false);
    expect(events.events.some((e) => e.eventType === "merge.retargeted")).toBe(false);
  });
});
