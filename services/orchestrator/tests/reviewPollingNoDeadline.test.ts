// Codex H3 #11: the human-review tier is now a DURABLE PARK, not an in-process
// polling loop. `pollReviewForRun` under `reviewPolicy: "human"` fetches the
// review verdict ONCE:
//   - a TERMINAL verdict (approved / changes_requested) is applied directly;
//   - a PENDING verdict PARKS the run (status `paused`, outcome
//     `awaiting_review`, `run.paused` emitted) and returns the `parked`
//     sentinel — the caller (`plannerRun.ts`) releases the worker back to the
//     pool. The awaiting-review prober (or a webhook / dashboard action once
//     wired) resumes the run when a verdict lands.
//
// The prior polling-loop test (which asserted "polls indefinitely") was the
// SOURCE of the worker-pinning bug: the worker sat in an in-process for(;;)
// loop indefinitely, defeating the timeout-eradication doctrine's "return to
// the pool on progress" invariant. The durable-park replacement below asserts
// the FIX — no polling loop, single fetch, park on pending.
import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { pollReviewForRun, type ReviewProbe } from "../src/engine/workflow/reviewMerge/reviewPolling.js";
import { fakeMergeWriter, ReviewMergePool, unusedHttp } from "./reviewMerge.fixtures.js";

describe("review polling — Codex H3 #11 durable park (no more worker-pinning loop)", () => {
  it("PARKS the run on a pending human verdict + returns `parked` (worker releases to the pool)", async () => {
    const pool = new ReviewMergePool("native_queue");
    const events = new FakeEventStore();
    let calls = 0;
    const probe: ReviewProbe = {
      markReady: async () => {},
      // Every fetch stays pending — the prior in-process loop would poll forever;
      // the fix returns `parked` after the FIRST pending fetch.
      fetchVerdict: async () => {
        calls += 1;
        return { verdict: "pending" };
      },
    };

    const result = await pollReviewForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe,
      // The park path does NOT use `sleep` — assert the fix by NOT wiring one.
    });

    // Single fetch, then park — the polling loop is gone.
    expect(calls).toBe(1);
    expect(result.verdict).toBe("parked");
    // The run row lands `paused` + `awaiting_review` (durable — a restart
    // between park and approval preserves the state, unlike the in-process
    // loop the fix replaces).
    expect(pool.runStatus).toEqual({ status: "paused", outcome: "awaiting_review" });
    // `run.paused` records WHY on the timeline (the notification dispatcher's
    // operator wake); the `review.approved` finalize is INTENTIONALLY NOT
    // emitted — the prober's resumed successor run owns that emit.
    const kinds = events.events.map((e) => e.eventType);
    expect(kinds).toContain("review.requested");
    expect(kinds).toContain("run.paused");
    expect(kinds).not.toContain("review.approved");
    // The `run.paused` payload carries the distinguishing `reason` for the
    // recovery surface (window pressure vs operator approval).
    const paused = events.events.find((e) => e.eventType === "run.paused");
    expect(paused?.payload).toMatchObject({ reason: "awaiting_human_review", provider: "human_reviewer" });
  });

  it("PROCEEDS to merge when the verdict is ALREADY terminal on the first fetch (resumed run's happy path)", async () => {
    // The awaiting-review prober's resume brings the successor run through the
    // walker — the successor's first `pollReviewForRun` fetch reads the now-terminal
    // verdict and proceeds to merge. NO polling loop, no park.
    const pool = new ReviewMergePool("native_queue");
    const events = new FakeEventStore();
    let calls = 0;
    const probe: ReviewProbe = {
      markReady: async () => {},
      fetchVerdict: async () => {
        calls += 1;
        return { verdict: "approved", latest: { state: "approved", reviewer: "dana" } };
      },
    };

    const result = await pollReviewForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe,
    });

    expect(calls).toBe(1);
    expect(result.verdict).toBe("approved");
    // Never parked — the row status stays as-is (test starts with no runStatus).
    expect(pool.runStatus).toBeNull();
    expect(events.events.map((e) => e.eventType)).toContain("review.approved");
  });

  it("PROCEEDS to rework on a `changes_requested` verdict without parking", async () => {
    const pool = new ReviewMergePool("native_queue");
    const events = new FakeEventStore();
    const probe: ReviewProbe = {
      markReady: async () => {},
      fetchVerdict: async () => ({
        verdict: "changes_requested",
        latest: { state: "changes_requested", reviewer: "erin", body: "please add a test" },
      }),
    };

    const result = await pollReviewForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe,
    });

    expect(result.verdict).toBe("changes_requested");
    expect(result.feedback).toBe("please add a test");
    expect(pool.runStatus).toBeNull();
    expect(events.events.map((e) => e.eventType)).toContain("review.changes_requested");
  });
});
