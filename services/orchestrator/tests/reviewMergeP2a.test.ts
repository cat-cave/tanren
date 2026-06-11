// up-to-date enforcement + auto-rebase: the merge-stage tests proving the
// freshness gate. Split out of reviewMerge.test.ts to keep each test file under
// the 500-line architecture cap. They drive `mergeForRun` directly with the
// recording merge probe (whose readMergeability / updateBranch the freshness
// scenarios override) and assert the control flow:
//   behind → updateBranch → re-gate CI → merge (merge.behind + merge.rebased)
//   update-branch 422/dirty → conflict hook + merge.conflict, NEVER merge
//   re-gated CI fails → merge.failed, NEVER merge
//   clean → merge directly, no update-branch / re-gate
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

const BEHIND = { state: "behind" as const, behind: true, baseBranch: "main", headBranch: "tanren/run_1" };
const CLEAN = { state: "clean" as const, behind: false, baseBranch: "main", headBranch: "tanren/run_1" };
const DIRTY = { state: "dirty" as const, behind: false, baseBranch: "main", headBranch: "tanren/run_1" };

describe("P2a up-to-date enforcement (merge stage)", () => {
  it("branch BEHIND → updateBranch → re-gate CI green → merge.behind + merge.rebased + authority land", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    // behind on the freshness read; clean once the rebase advanced it (the read the
    // authority then re-judges — the land only clears on `clean`).
    const probe = recordingMergeProbe({
      mergeabilityReads: [BEHIND, CLEAN],
      updateBranch: { outcome: "updated", message: "updating" },
    });
    const host = authorityHost();
    const landed: string[] = [];
    let reGateCalls = 0;

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      reGateCi: async () => {
        reGateCalls += 1;
        return { status: "passed" };
      },
    });

    expect(result.outcome).toBe("merged");
    expect(result.mergeSha).toBe(AUTHORITY_HEAD_SHA);
    // Order: detected behind → updated → re-gated CI → landed via the authority.
    expect(probe.updateBranchCalls).toBe(1);
    expect(reGateCalls).toBe(1);
    expect(landed).toEqual([AUTHORITY_HEAD_SHA]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.behind");
    expect(types).toContain("merge.rebased");
    expect(types).toContain("merge.completed");
    expect(events.events.find((e) => e.eventType === "merge.rebased")?.payload).toMatchObject({ reGatedCi: true });
  });

  it("update-branch reports a CONFLICT (422/dirty) → routed to conflict hook, merge.conflict, NO land", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      mergeability: BEHIND,
      updateBranch: { outcome: "conflict", message: "merge conflict" },
    });
    const host = authorityHost();
    const landed: string[] = [];
    let hookCalls = 0;

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      resolveConflict: async () => {
        hookCalls += 1;
        return { resolved: false };
      },
    });

    expect(result.outcome).toBe("conflict");
    expect(hookCalls).toBe(1);
    // CRUCIAL: the authority NEVER landed the conflicting branch.
    expect(landed).toEqual([]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.behind");
    expect(types).toContain("merge.conflict");
    expect(types).not.toContain("merge.completed");
    // recoverable: the merge task stays running for the recovery surface.
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });

  it("branch DIRTY (real conflict with base) → routed to hook BEFORE any land", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ mergeability: DIRTY });
    const host = authorityHost();
    const landed: string[] = [];
    let hookCalls = 0;

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      resolveConflict: async () => {
        hookCalls += 1;
        return { resolved: false };
      },
    });

    expect(result.outcome).toBe("conflict");
    expect(hookCalls).toBe(1);
    expect(landed).toEqual([]);
    // dirty: no point trying update-branch.
    expect(probe.updateBranchCalls).toBe(0);
    expect(events.events.map((e) => e.eventType)).toContain("merge.conflict");
  });

  it("re-gated CI FAILS after rebase → merge.failed, NO land", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      mergeability: BEHIND,
      updateBranch: { outcome: "updated", message: "updating" },
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
      reGateCi: async () => ({ status: "failed" }),
    });

    expect(result.outcome).toBe("failed");
    expect(landed).toEqual([]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.rebased");
    expect(types).toContain("merge.failed");
    expect(types).not.toContain("merge.completed");
  });

  it("branch REBASED but NO reGateCi hook → HARD-HOLD (merge.conflict), NEVER land on unverified CI", async () => {
    // The branch was behind and update-branch advanced it, but the required
    // post-rebase CI re-gate hook is absent. The default of a required
    // verification is a HOLD, not "land anyway": the dispatcher must emit the
    // recoverable conflict outcome and NEVER land on the unverified rebase.
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      mergeability: BEHIND,
      updateBranch: { outcome: "updated", message: "updating" },
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
      // reGateCi intentionally OMITTED.
    });

    expect(result.outcome).toBe("conflict");
    // CRUCIAL: the branch WAS rebased, but the authority NEVER landed.
    expect(probe.updateBranchCalls).toBe(1);
    expect(landed).toEqual([]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.behind");
    expect(types).toContain("merge.rebased");
    expect(types).toContain("merge.conflict");
    expect(types).not.toContain("merge.completed");
    // The rebased event records that CI was NOT re-gated.
    expect(events.events.find((e) => e.eventType === "merge.rebased")?.payload).toMatchObject({ reGatedCi: false });
    // Recoverable: the merge task stays running for the recovery surface.
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });

  it("a CLEAN branch lands directly with no update-branch call", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ mergeability: CLEAN });
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
      reGateCi: async () => {
        throw new Error("reGateCi must NOT be called for a clean branch");
      },
    });

    expect(result.outcome).toBe("merged");
    expect(landed).toEqual([AUTHORITY_HEAD_SHA]);
    // mergeability is read TWICE: once by `ensureUpToDate` (no rebase on clean) and once
    // by the authority land (re-judging the clean tree). No update-branch on clean.
    expect(probe.mergeabilityCalls).toBe(2);
    expect(probe.updateBranchCalls).toBe(0);
    expect(events.events.map((e) => e.eventType)).not.toContain("merge.behind");
  });
});
