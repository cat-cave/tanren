// up-to-date enforcement + auto-rebase: the merge-stage tests proving the freshness
// gate. Split out of reviewMerge.test.ts to keep each test file under the 500-line
// architecture cap. They drive `mergeForRun` directly with the recording merge probe
// (whose `readFreshness` the freshness scenarios override) and assert the control flow.
//
// §5h SEVER (decomposition PR-7): freshness is now the `CodeHost`-derived ANCESTRY signal
// (`clean`/`behind`/`unknown`) — NOT the GitHub `mergeable_state`, and NEVER `dirty`. A
// `behind` branch rebases through the UNIFIED `baseShiftRebase` hook (jj), which surfaces a
// genuine conflict itself (`outcome: "conflict"`) → routed to the resolver. The legacy
// server-side `updateBranch` fallback is GONE: the hook is REQUIRED on the land path.
//   behind → baseShiftRebase(rebased) → re-gate CI → merge (merge.behind + merge.rebased)
//   baseShiftRebase(conflict) → conflict hook + merge.conflict, NEVER merge
//   re-gated CI fails → merge.failed, NEVER merge
//   clean → merge directly, no rebase / re-gate
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

const BEHIND = { state: "behind" as const, behind: true, baseBranch: "main", headBranch: "tanren/run_1" };
const CLEAN = { state: "clean" as const, behind: false, baseBranch: "main", headBranch: "tanren/run_1" };
const REBASED_PR_HEAD = "d".repeat(40);

describe("P2a up-to-date enforcement (merge stage)", () => {
  it("branch BEHIND → baseShiftRebase → re-gate CI green → merge.behind + merge.rebased + authority land", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    // behind on the freshness read; clean once the rebase advanced it (the read the
    // authority then re-judges — the land only clears on `clean`).
    const probe = recordingMergeProbe({ mergeabilityReads: [BEHIND, CLEAN] });
    const host = authorityHost();
    const landed: string[] = [];
    let reGateCalls = 0;
    const baseShiftCalls: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      baseShiftRebase: async (input) => {
        baseShiftCalls.push(input.baseBranch);
        return { outcome: "rebased", rebasedHeadSha: REBASED_PR_HEAD };
      },
      reGateCi: async () => {
        reGateCalls += 1;
        return { status: "passed" };
      },
    });

    expect(result.outcome).toBe("merged");
    expect(result.mergeSha).toBe(AUTHORITY_HEAD_SHA);
    // Order: detected behind → unified rebase → re-gated CI → landed via the authority.
    expect(baseShiftCalls).toEqual(["main"]);
    expect(reGateCalls).toBe(1);
    expect(landed).toEqual([AUTHORITY_HEAD_SHA]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.behind");
    expect(types).toContain("merge.rebased");
    expect(types).toContain("merge.completed");
    expect(events.events.find((e) => e.eventType === "merge.rebased")?.payload).toMatchObject({ reGatedCi: true });
  });

  it("baseShiftRebase reports a CONFLICT → routed to conflict hook, merge.conflict, NO land", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ mergeability: BEHIND });
    const host = authorityHost();
    const landed: string[] = [];
    let hookCalls = 0;

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      // §5h: a real conflict is surfaced by the jj rebase itself (not a `mergeable_state` read).
      baseShiftRebase: async () => ({ outcome: "conflict", message: "merge conflict" }),
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

  it("a BEHIND branch with NO baseShiftRebase hook wired → fail-closed HOLD, NEVER land", async () => {
    // §5h: the unified base-shift hook is REQUIRED on the land path (the legacy server-side
    // update-branch fallback is GONE). An absent hook is a wiring bug → a recoverable HOLD,
    // never a silent server-side update or a merge of an un-rebased stale branch.
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ mergeability: BEHIND });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      // baseShiftRebase intentionally OMITTED.
    });

    expect(result.outcome).toBe("conflict");
    expect(landed).toEqual([]);
    expect(events.events.map((e) => e.eventType)).not.toContain("merge.completed");
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });

  it("re-gated CI FAILS after rebase → merge.failed, NO land", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ mergeability: BEHIND });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      baseShiftRebase: async () => ({ outcome: "rebased", rebasedHeadSha: REBASED_PR_HEAD }),
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
    // The branch was behind and the unified rebase advanced it, but the required post-rebase
    // CI re-gate hook is absent. The default of a required verification is a HOLD, not "land
    // anyway": the dispatcher emits the recoverable conflict outcome and NEVER lands.
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ mergeability: BEHIND });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      baseShiftRebase: async () => ({ outcome: "rebased", rebasedHeadSha: REBASED_PR_HEAD }),
      // reGateCi intentionally OMITTED.
    });

    expect(result.outcome).toBe("conflict");
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

  it("a CLEAN branch lands directly with no rebase call", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ mergeability: CLEAN });
    const host = authorityHost();
    const landed: string[] = [];
    let baseShiftCalls = 0;

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      baseShiftRebase: async () => {
        baseShiftCalls += 1;
        return { outcome: "up_to_date" };
      },
      reGateCi: async () => {
        throw new Error("reGateCi must NOT be called for a clean branch");
      },
    });

    expect(result.outcome).toBe("merged");
    expect(landed).toEqual([AUTHORITY_HEAD_SHA]);
    // freshness is read TWICE: once by `ensureUpToDate` (no rebase on clean) and once by the
    // authority land (re-judging the clean tree). No rebase on clean.
    expect(probe.mergeabilityCalls).toBe(2);
    expect(baseShiftCalls).toBe(0);
    expect(events.events.map((e) => e.eventType)).not.toContain("merge.behind");
  });
});
