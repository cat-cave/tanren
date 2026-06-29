// Timeout-eradication (feedback_no_timeouts_progress_based, BINDING): the review
// stage awaits its verdict INDEFINITELY — there is NO poll-count cap (the old
// `maxPolls`/`DEFAULT_MAX_CI_POLLS` give-up is gone). A review legitimately takes
// a long time, so a verdict that stays `pending` far past the eradicated 12-poll
// cap must keep polling on its cadence and resolve on the REAL terminal verdict,
// never surface a `pending` give-up. This drives `pollReviewForRun` with a probe
// that stays pending for many polls, then approves, over fake stores (no GitHub).
import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { pollReviewForRun, type ReviewProbe } from "../src/engine/workflow/reviewMerge/reviewPolling.js";
import { fakeMergeWriter, ReviewMergePool, unusedHttp } from "./reviewMerge.fixtures.js";

describe("review polling — no poll-count cap (awaits indefinitely)", () => {
  it("a review pending well past the old 12-poll cap resolves when approval finally arrives", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const pendingPolls = 30;
    let calls = 0;
    let slept = 0;
    const probe: ReviewProbe = {
      markReady: async () => {},
      fetchVerdict: async () => {
        calls += 1;
        return calls > pendingPolls
          ? { verdict: "approved", latest: { state: "approved", reviewer: "dana" } }
          : { verdict: "pending" };
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
      // A no-op sleep so the test does not wait out the real poll cadence.
      sleep: async () => {
        slept += 1;
      },
    });

    expect(result.verdict).toBe("approved");
    // It polled well past the old 12-poll cap and spaced each pending poll (no give-up).
    expect(calls).toBe(pendingPolls + 1);
    expect(slept).toBe(pendingPolls);
    expect(events.events.map((e) => e.eventType)).toContain("review.approved");
  });
});
