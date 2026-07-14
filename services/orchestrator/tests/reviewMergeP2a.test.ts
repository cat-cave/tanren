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
//   re-gated CI FAILS (clean rebase, gate-tier fail) → WRITER REWORK + recoverable conflict,
//     NEVER a terminal merge.failed (the #594 principle extended to the auto-rebase path)
//   re-gated CI PENDING (gate not yet terminal) → re_gate_pending RECOVERABLE re-drive,
//     NEVER the old dequeue-and-abandon conflict that bricked the live run
//   clean → merge directly, no rebase / re-gate
import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { mergeForRun } from "../src/engine/workflow/reviewMerge/index.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import {
  AUTHORITY_HEAD_SHA,
  ReviewMergePool,
  authorityBundle,
  authorityHost,
  fakeMergeWriter,
  recordingMergeProbe,
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
      runStateWriter: fakeMergeWriter(pool, events),
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
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      // §5h: a real conflict is surfaced by the jj rebase itself (not a `mergeable_state` read).
      baseShiftRebase: async () => ({ outcome: "conflict", message: "merge conflict" }),
      resolveConflict: async () => {
        hookCalls += 1;
        return {
          resolved: false,
          recovery: {
            kind: "owned",
            receipt: { kind: "planner_replan", specId: "spec_1", run: { kind: "already_running" } },
          },
        };
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
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      // baseShiftRebase intentionally OMITTED.
    });

    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    expect(events.events.map((e) => e.eventType)).not.toContain("merge.completed");
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });

  it("re-gated CI FAILS after a CLEAN rebase → WRITER REWORK + recoverable conflict, NO terminal merge.failed", async () => {
    // #594 EXTENDED to the auto-rebase path: a clean rebase whose pre_merge gate fails a TIER
    // is the WRITER's to fix on the new base — route to rework carrying the gate error, then
    // emit the RECOVERABLE conflict so the reworked spec re-enters the queue. NEVER the old
    // terminal merge.failed that stranded a fixable spec.
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ mergeability: BEHIND });
    const host = authorityHost();
    const landed: string[] = [];
    const reworked: Array<{ specId: string; gateError: string }> = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      baseShiftRebase: async () => ({ outcome: "rebased", rebasedHeadSha: REBASED_PR_HEAD }),
      reGateCi: async () => ({ status: "failed", gateError: "tier 'tier2' step 'test' exited 1" }),
      reGateGateRework: {
        routeGateFailToRework: async (input) => {
          reworked.push(input);
          return {
            kind: "owned",
            receipt: { kind: "writer_rework", specId: input.specId, run: { kind: "already_running" } },
          };
        },
      },
    });

    // Routed to writer rework with the gate error, then a RECOVERABLE conflict (not a terminal failure).
    expect(reworked).toEqual([{ specId: "spec_1", gateError: "tier 'tier2' step 'test' exited 1" }]);
    expect(result.outcome).toBe("conflict");
    expect(landed).toEqual([]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.rebased");
    expect(types).toContain("merge.conflict");
    expect(types).not.toContain("merge.failed");
    expect(types).not.toContain("merge.completed");
    // Recoverable: the merge task stays running so the reworked spec re-enters the queue.
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });

  it("re-gated CI FAILS with NO rework router wired → loud needs_attention", async () => {
    // An out-of-band / test caller with no rework router: still RECOVERABLE (the recovery
    // surface re-drives), NEVER the old terminal merge.failed — never a silent merge either.
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ mergeability: BEHIND });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      baseShiftRebase: async () => ({ outcome: "rebased", rebasedHeadSha: REBASED_PR_HEAD }),
      reGateCi: async () => ({ status: "failed" }),
      // reGateGateRework intentionally OMITTED.
    });

    expect(result.outcome).toBe("needs_attention");
    expect(landed).toEqual([]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.rebased");
    expect(types).toContain("merge.conflict");
    expect(types).not.toContain("merge.failed");
    expect(types).not.toContain("merge.completed");
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });

  it("re-gated CI PENDING after rebase → re_gate_pending RECOVERABLE re-drive, NEVER dequeue-and-abandon", async () => {
    // The live brick: a not-yet-terminal native re-gate (gate still running / infra blip) was
    // emitted as a TERMINAL conflict and DEQUEUED, stranding the PR forever. The fix: a distinct
    // re_gate_pending RECOVERABLE outcome (the task stays running) the coordinator re-drives
    // until the gate finishes — never dequeued, never a fixed attempt cap.
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ mergeability: BEHIND });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      baseShiftRebase: async () => ({ outcome: "rebased", rebasedHeadSha: REBASED_PR_HEAD }),
      reGateCi: async () => ({ status: "pending" }),
    });

    expect(result.outcome).toBe("re_gate_pending");
    expect(landed).toEqual([]);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.rebased");
    expect(types).toContain("merge.regate_pending");
    // NOT a terminal conflict/failure: the entry must stay re-drivable, not be dequeued.
    expect(types).not.toContain("merge.conflict");
    expect(types).not.toContain("merge.failed");
    expect(types).not.toContain("merge.completed");
    // Recoverable: the merge task stays running so the coordinator re-drives until the gate finishes.
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });

  it("branch REBASED but NO reGateCi hook → recoverable blocked hold, NEVER land on unverified CI", async () => {
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
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      baseShiftRebase: async () => ({ outcome: "rebased", rebasedHeadSha: REBASED_PR_HEAD }),
      // reGateCi intentionally OMITTED.
    });

    expect(result.outcome).toBe("blocked");
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
      runStateWriter: fakeMergeWriter(pool, events),
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
