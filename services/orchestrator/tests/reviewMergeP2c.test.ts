// P2c-1 (autonomy-engine.md §2c): the SPECULATIVE-MERGE-HOLD at the merge stage —
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

  it("PROCEEDS to a real merge once ALL ancestors have merged", async () => {
    const pool = new ReviewMergePool("direct_merge");
    // Still flagged speculative, but every ancestor has now merged.
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
    expect(probe.mergeCalls).toBe(1);
    expect(events.events.some((e) => e.eventType === "merge.speculative_held")).toBe(false);
    expect(events.events.some((e) => e.eventType === "merge.completed")).toBe(true);
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
    expect(events.events.some((e) => e.eventType === "merge.speculative_held")).toBe(false);
  });
});
