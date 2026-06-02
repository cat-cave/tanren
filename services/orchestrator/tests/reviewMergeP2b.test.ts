// P2b merge-stage integration: the dispatcher's conflict path with the
// intent-preserving resolver as the (production-default) `resolveConflict` hook.
// Here a fake resolver stands in for the real one (the resolver's own behavior
// is unit-tested in conflictResolver.test.ts); these assert the DISPATCHER's
// contract: a resolved=true conflict retries the merge and proceeds, while the
// noop fixture (tests-only) resolves nothing.

import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { mergeForRun } from "../src/engine/workflow/reviewMerge/index.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import { ReviewMergePool, unusedHttp } from "./reviewMerge.fixtures.js";

describe("P2b merge-stage conflict resolution", () => {
  it("resolver resolves the conflict → merge is retried → merged (merge proceeds only on a clean resolution)", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    // The merge reports a conflict on the FIRST call; once the intent-preserving
    // resolver returns resolved=true (a re-gated resolution), the dispatcher
    // retries the merge and it succeeds.
    let mergeCalls = 0;
    const probe = {
      labels: [] as string[],
      async applyQueueLabel(label: string) {
        this.labels.push(label);
      },
      async merge() {
        mergeCalls += 1;
        return mergeCalls === 1
          ? { merged: false, conflict: true, status: 409, message: "merge conflict" }
          : { merged: true, mergeSha: "deadbeef2", conflict: false, status: 200, message: "merged" };
      },
      async readMergeability() {
        return { state: "clean" as const, behind: false, baseBranch: "main", headBranch: "tanren/run_1" };
      },
      async updateBranch() {
        return { outcome: "up_to_date" as const, message: "up to date" };
      },
    };

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      // The production default is the REAL intent-preserving resolver; here a
      // fake stands in for it and reports a clean (re-gated) resolution.
      resolveConflict: async () => ({ resolved: true }),
    });

    expect(result.outcome).toBe("merged");
    expect(result.mergeSha).toBe("deadbeef2");
    expect(mergeCalls).toBe(2);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.completed");
    expect(types).not.toContain("merge.conflict");
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("done");
  });

  it("the noop test fixture resolves nothing (tests-only; not a production default)", async () => {
    expect(
      await noopConflictResolver({ runId: "r", prUrl: "u", prNumber: 1, baseBranch: "main", message: "x" }),
    ).toEqual({ resolved: false });
  });
});
