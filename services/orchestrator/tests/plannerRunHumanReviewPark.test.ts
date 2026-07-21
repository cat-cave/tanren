// Codex H3 #11 — plannerRun integration test for the human-review durable
// park path. The core fix: `reviewPolicy: "human"` (the default) on a PENDING
// review verdict now PARKS the run (durable — `paused` + `awaiting_review`)
// and returns `parked` from `pollReviewForRun`. `plannerRun.ts` releases the
// worker back to the pool INSTEAD OF blocking indefinitely in the old for(;;)
// polling loop that pinned the worker forever. The awaiting-review prober
// (extended `pausedRunResumeProber`) resumes on cadence when a verdict lands;
// the walker's successor run reads the terminal verdict and proceeds to merge.
//
// The polling-shape regression is pinned in
// `reviewPollingNoDeadline.test.ts` (fetch ONCE, then park); the prober's
// resume + outcome-preservation is pinned in `pausedRunResumeProber.test.ts`.
// This file pins the PLANNER-STAGE side: the worker's release path takes the
// `parked` sentinel and returns cleanly, no fault-finalize, no merge.
import { describe, expect, it } from "vitest";
import {
  accounting,
  completeCheck,
  nativeQueueConfig,
  fakeProbe,
  healthyWindow,
  noopMerge,
  passingGitHub,
  plannerAuthorityBundle,
  plannerAuthorityHost,
  runPlannerLoopScoped,
  setup,
  twoSubtaskAdapters,
} from "./plannerRun.fixtures.js";

describe("runPlannerLoopWorkflow — Codex H3 #11 human-review durable park", () => {
  it("PARKS the run on a PENDING human review and RELEASES the worker (no more in-process polling loop)", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(nativeQueueConfig());
    let fetchCalls = 0;
    const pendingReview = {
      markReady: async () => {},
      fetchVerdict: async () => {
        fetchCalls += 1;
        return { verdict: "pending" as const };
      },
    };

    const result = await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      timeoutMs: 100,
      sleep: async () => {},
      buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: pendingReview,
      mergeProbe: noopMerge(),
      mergeAuthority: plannerAuthorityBundle(plannerAuthorityHost()),
    });

    // Single fetch, then park — the polling loop is gone.
    expect(fetchCalls).toBe(1);
    expect(result.review?.verdict).toBe("parked");
    // Durable-paused with `awaiting_review` outcome (distinct WHY from
    // `window_paused` on the recovery surface).
    expect(pool.runStatus).toEqual({ status: "paused", outcome: "awaiting_review" });
    // Worker released cleanly; the run is alive on the DB, off this worker.
    expect(allocator.releases).toEqual(["runner_planner"]);
    // Timeline records the pause + the review-requested notification wake.
    const kinds = events.events.map((e) => e.eventType);
    expect(kinds).toContain("review.requested");
    expect(kinds).toContain("run.paused");
    // `review.approved` is intentionally NOT emitted here — the walker's
    // resumed-successor run owns that emit when the operator's verdict lands.
    expect(kinds).not.toContain("review.approved");
    const paused = events.events.find((e) => e.eventType === "run.paused");
    expect(paused?.payload).toMatchObject({
      reason: "awaiting_human_review",
      provider: "human_reviewer",
    });
    // No merge attempted — parked short-circuits before mergeForRun.
    expect(result.merge).toBeUndefined();
  });
});
