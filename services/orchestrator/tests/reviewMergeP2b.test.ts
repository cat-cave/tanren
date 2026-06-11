// merge-stage integration: the dispatcher's conflict path with the
// intent-preserving resolver as the (production-default) `resolveConflict` hook.
// Here a fake resolver stands in for the real one (the resolver's own behavior
// is unit-tested in conflictResolver.test.ts); these assert the DISPATCHER's
// contract: a resolved=true conflict re-gates the resolved tree then re-enters the
// authority land (which lands the now-clean tree), while the noop fixture
// (tests-only) resolves nothing.

import { describe, expect, it } from "vitest";
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

describe("P2b merge-stage conflict resolution", () => {
  it("resolver resolves the conflict → resolved-tree re-gate → authority lands the clean tree", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    // The branch is `dirty` on the freshness read (surfacing the conflict); once the
    // intent-preserving resolver returns resolved=true, the dispatcher runs a FRESH
    // pre_merge re-gate on the resolved tree (passing here) and re-enters the authority
    // land, which re-reads the now-`clean` mergeability and lands.
    const probe = recordingMergeProbe({
      mergeabilityReads: [
        { state: "dirty", behind: false, baseBranch: "main", headBranch: "tanren/run_1" },
        { state: "clean", behind: false, baseBranch: "main", headBranch: "tanren/run_1" },
      ],
    });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      // the resolved-tree pre_merge re-gate (REQUIRED on the authority land) passes.
      reGateCi: async () => ({ status: "passed" }),
      // The production default is the REAL intent-preserving resolver; here a
      // fake stands in for it and reports a clean (re-gated) resolution.
      resolveConflict: async () => ({ resolved: true }),
    });

    expect(result.outcome).toBe("merged");
    expect(result.mergeSha).toBe(AUTHORITY_HEAD_SHA);
    expect(landed).toEqual([AUTHORITY_HEAD_SHA]);
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
