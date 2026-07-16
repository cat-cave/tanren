// gv-2 durable intent fence + cross-process publish single-flight.
// Production-composed through pollReviewForRun (not publisher-helper-only).
import { describe, expect, it } from "vitest";

import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { ReviewAnswer } from "../src/engine/answerers/schemas/index.js";
import type { SubmitReviewEvent, SubmittedReviewReceipt } from "../src/engine/providers/githubReviewMerge.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { pollReviewForRun, type ReviewProbe } from "../src/engine/workflow/reviewMerge/reviewPolling.js";
import {
  InMemorySimulatedReviewIntentRepository,
  REVIEW_SIMULATED_INTENT_EVENT,
  simulatedReviewIntentKey,
} from "../src/engine/workflow/reviewMerge/simulatedReviewIntent.js";
import { InMemorySimulatedReviewPublishFence } from "../src/engine/workflow/reviewMerge/simulatedReviewPublishFence.js";
import { reviewBodyFor } from "../src/engine/workflow/reviewMerge/simulatedReviewer.js";
import {
  simulatedReviewIntentFingerprint,
  simulatedReviewIntentMarker,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublication.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { fakeMergeWriter, ReviewMergePool, unusedHttp } from "./reviewMerge.fixtures.js";

const HEAD = "a".repeat(40);
const REVIEWER = "tanren-reviewer[bot]";
const TASK_ID = "task_review";

function bodyForIntent(state: "approved" | "changes_requested", message: string): string {
  const verdict = state === "approved" ? "approve" : "request_changes";
  const marker = simulatedReviewIntentMarker(
    simulatedReviewIntentFingerprint({
      runId: "run_1",
      taskId: TASK_ID,
      headSha: HEAD,
      state,
      reviewerLogin: REVIEWER,
      message,
    }),
  );
  return `${reviewBodyFor({ verdict, reasoning: message })}\n\n${marker}`;
}

function seedReviewTask(pool: ReviewMergePool): void {
  pool.tasks.push({ task_id: TASK_ID, run_id: "run_1", kind: "review", status: "running" });
}

function receiptFor(event: SubmitReviewEvent, headSha: string, id = "9001"): SubmittedReviewReceipt {
  if (event === "COMMENT") throw new Error("no COMMENT receipt");
  return {
    forgeReviewId: id,
    forgeReviewState: event === "APPROVE" ? "approved" : "changes_requested",
    forgeReviewUrl: `https://github.com/o/r/pull/1#pullrequestreview-${id}`,
    headSha,
    reviewerLogin: REVIEWER,
  };
}

function fakeReviewer(
  verdict: ReviewAnswer,
  seen: { prompts: string[]; calls: number },
): AnswererAdapter<ReviewAnswer> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "fake",
    runAnswerer: async (opts) => {
      seen.calls += 1;
      seen.prompts.push(opts.prompt);
      return opts.outputSchema.parse(verdict);
    },
  };
}

type SharedForge = {
  posts: Array<{ event: SubmitReviewEvent; body: string; headSha: string }>;
  listed: number;
  /** In-memory forge reviews (for list-before-POST reclaim). */
  reviews: SubmittedReviewReceipt[];
};

function sharedConvergentProbe(forge: SharedForge, headSha = HEAD): ReviewProbe {
  return {
    markReady: async () => {},
    fetchVerdict: async () => {
      throw new Error("fetchVerdict must not run on simulated path");
    },
    fetchSnapshot: async () => ({
      baseSha: "b".repeat(40),
      headSha,
      authorLogin: "pr-writer",
      diff: "diff --git a/x b/x\n+x",
    }),
    fetchLiveHeadSha: async () => headSha,
    pinSimulatedReviewer: async () => ({
      reviewerLogin: REVIEWER,
      submitReview: async (event, body, sha) => {
        forge.listed += 1;
        const expectedState = event === "APPROVE" ? "approved" : "changes_requested";
        const existing = forge.reviews.find(
          (r) =>
            r.headSha.toLowerCase() === sha.toLowerCase() &&
            r.forgeReviewState === expectedState &&
            (r.reviewerLogin ?? "").toLowerCase() === REVIEWER.toLowerCase(),
        );
        if (existing !== undefined) return existing;
        forge.posts.push({ event, body, headSha: sha });
        const receipt = receiptFor(event, sha, String(9000 + forge.posts.length));
        forge.reviews.push(receipt);
        return receipt;
      },
    }),
  };
}

function baseSpec() {
  return {
    specTitle: "Spec",
    specDescription: "Desc",
    acceptanceCriteria: ["does the thing"],
  };
}

describe("gv-2 durable intent fence via pollReviewForRun composition", () => {
  it("two lease-overlap workers, same decision: exactly one GitHub POST", async () => {
    const forge: SharedForge = { posts: [], listed: 0, reviews: [] };
    const intentRepository = new InMemorySimulatedReviewIntentRepository();
    const publishFence = new InMemorySimulatedReviewPublishFence();
    const probe = sharedConvergentProbe(forge);

    async function worker(
      runPool: ReviewMergePool,
      events: FakeEventStore,
      seen: { calls: number; prompts: string[] },
    ) {
      return pollReviewForRun({
        pool: runPool.asPgPool(),
        eventStore: events,
        runStateWriter: fakeMergeWriter(runPool, events),
        secrets: new FakeSecretStore(),
        githubHttp: unusedHttp(),
        runId: "run_1",
        reviewProbe: probe,
        simulatedReviewer: () => fakeReviewer({ verdict: "approve", reasoning: "ok" }, seen),
        simulatedReviewContext: baseSpec(),
        intentRepository,
        publishFence,
      });
    }

    const poolA = new ReviewMergePool("direct_merge", "open", "simulated");
    const poolB = new ReviewMergePool("direct_merge", "open", "simulated");
    seedReviewTask(poolA);
    seedReviewTask(poolB);
    const eventsA = new FakeEventStore();
    const eventsB = new FakeEventStore();
    const seenA = { calls: 0, prompts: [] as string[] };
    const seenB = { calls: 0, prompts: [] as string[] };

    const [a, b] = await Promise.all([worker(poolA, eventsA, seenA), worker(poolB, eventsB, seenB)]);
    expect(a.verdict).toBe("approved");
    expect(b.verdict).toBe("approved");
    expect(forge.posts).toHaveLength(1);
    expect(forge.posts[0]!.event).toBe("APPROVE");
  });

  it("two workers, opposite decisions: first intent wins; both publish only that intent", async () => {
    const forge: SharedForge = { posts: [], listed: 0, reviews: [] };
    const intentRepository = new InMemorySimulatedReviewIntentRepository();
    const publishFence = new InMemorySimulatedReviewPublishFence();
    const probe = sharedConvergentProbe(forge);

    // Concurrent first-wins on the repository itself (A's candidate recorded first).
    const approveCandidate = {
      headSha: HEAD,
      state: "approved" as const,
      event: "APPROVE" as const,
      body: bodyForIntent("approved", "A-wins"),
      message: "A-wins",
      reviewerLogin: REVIEWER,
      marker: "tanren-simulated-review:v1:approved",
    };
    const changesCandidate = {
      ...approveCandidate,
      state: "changes_requested" as const,
      event: "REQUEST_CHANGES" as const,
      body: bodyForIntent("changes_requested", "B-loses"),
      message: "B-loses",
      marker: "tanren-simulated-review:v1:changes_requested",
    };
    const base = { runId: "run_1", orgId: "org_1", projectId: "project_1" };
    const [w1, w2] = await Promise.all([
      intentRepository.adoptOrRecord({ ...base, candidate: approveCandidate }),
      intentRepository.adoptOrRecord({ ...base, candidate: changesCandidate }),
    ]);
    expect(w1).toEqual(w2);
    // first-wins (in-memory Map: first set sticks)
    expect(w1.state).toBe("approved");

    // Composition: both workers publish only the durable winner (no opposite POST).
    const poolA = new ReviewMergePool("direct_merge", "open", "simulated");
    const poolB = new ReviewMergePool("direct_merge", "open", "simulated");
    seedReviewTask(poolA);
    seedReviewTask(poolB);
    const eventsA = new FakeEventStore();
    const eventsB = new FakeEventStore();
    const seenA = { calls: 0, prompts: [] as string[] };
    const seenB = { calls: 0, prompts: [] as string[] };

    const [a, b] = await Promise.all([
      pollReviewForRun({
        pool: poolA.asPgPool(),
        eventStore: eventsA,
        runStateWriter: fakeMergeWriter(poolA, eventsA),
        secrets: new FakeSecretStore(),
        githubHttp: unusedHttp(),
        runId: "run_1",
        reviewProbe: probe,
        simulatedReviewer: () => fakeReviewer({ verdict: "request_changes", reasoning: "B-loses" }, seenA),
        simulatedReviewContext: baseSpec(),
        intentRepository,
        publishFence,
      }),
      pollReviewForRun({
        pool: poolB.asPgPool(),
        eventStore: eventsB,
        runStateWriter: fakeMergeWriter(poolB, eventsB),
        secrets: new FakeSecretStore(),
        githubHttp: unusedHttp(),
        runId: "run_1",
        reviewProbe: probe,
        simulatedReviewer: () => fakeReviewer({ verdict: "request_changes", reasoning: "B-loses" }, seenB),
        simulatedReviewContext: baseSpec(),
        intentRepository,
        publishFence,
      }),
    ]);

    expect(a.verdict).toBe("approved");
    expect(b.verdict).toBe("approved");
    expect(seenA.calls).toBe(0);
    expect(seenB.calls).toBe(0);
    expect(forge.posts).toHaveLength(1);
    expect(forge.posts[0]!.event).toBe("APPROVE");
    expect(forge.posts[0]!.body).toContain("A-wins");
  });

  it("accepted POST then death before terminal: retry skips Answerer and reclaims", async () => {
    const forge: SharedForge = { posts: [], listed: 0, reviews: [] };
    const intentRepository = new InMemorySimulatedReviewIntentRepository();
    const publishFence = new InMemorySimulatedReviewPublishFence();
    const probe = sharedConvergentProbe(forge);
    const pool1 = new ReviewMergePool("direct_merge", "open", "simulated");
    seedReviewTask(pool1);
    const events1 = new FakeEventStore();
    const seen1 = { calls: 0, prompts: [] as string[] };

    // First attempt publishes but "dies" before finalize (we only run stage via full poll —
    // simulate by completing first run, then re-driving with pre-seeded intent + forge review
    // as if terminal was lost: second run with fresh pool tasks but shared intent+forge).
    await pollReviewForRun({
      pool: pool1.asPgPool(),
      eventStore: events1,
      runStateWriter: fakeMergeWriter(pool1, events1),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe,
      simulatedReviewer: () => fakeReviewer({ verdict: "approve", reasoning: "ok" }, seen1),
      simulatedReviewContext: baseSpec(),
      intentRepository,
      publishFence,
    });
    expect(forge.posts).toHaveLength(1);
    expect(seen1.calls).toBe(1);

    // Crash-after-POST / before terminal: intent + forge review exist; redrive.
    const pool2 = new ReviewMergePool("direct_merge", "open", "simulated");
    seedReviewTask(pool2);
    const events2 = new FakeEventStore();
    const seen2 = { calls: 0, prompts: [] as string[] };
    const result = await pollReviewForRun({
      pool: pool2.asPgPool(),
      eventStore: events2,
      runStateWriter: fakeMergeWriter(pool2, events2),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe,
      simulatedReviewer: () => fakeReviewer({ verdict: "request_changes", reasoning: "must-not-run" }, seen2),
      simulatedReviewContext: baseSpec(),
      intentRepository,
      publishFence,
    });
    // Answerer skipped; durable intent; no second POST
    expect(seen2.calls).toBe(0);
    expect(result.verdict).toBe("approved");
    expect(forge.posts).toHaveLength(1);
    expect(result.forgePublication?.forgeReviewId).toBe(forge.reviews[0]!.forgeReviewId);
  });

  it("intent append response loss / readback: second worker adopts first intent", async () => {
    const intentRepository = new InMemorySimulatedReviewIntentRepository();
    const seeded = {
      headSha: HEAD,
      state: "approved" as const,
      event: "APPROVE" as const,
      body: bodyForIntent("approved", "seeded"),
      message: "seeded",
      reviewerLogin: REVIEWER,
      marker: "tanren-simulated-review:v1:approved",
    };
    intentRepository.seed("run_1", seeded);

    const forge: SharedForge = { posts: [], listed: 0, reviews: [] };
    const pool = new ReviewMergePool("direct_merge", "open", "simulated");
    seedReviewTask(pool);
    const events = new FakeEventStore();
    const seen = { calls: 0, prompts: [] as string[] };
    const result = await pollReviewForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: sharedConvergentProbe(forge),
      simulatedReviewer: () => fakeReviewer({ verdict: "request_changes", reasoning: "must-not-run" }, seen),
      simulatedReviewContext: baseSpec(),
      intentRepository,
      publishFence: new InMemorySimulatedReviewPublishFence(),
    });
    expect(seen.calls).toBe(0);
    expect(result.verdict).toBe("approved");
    expect(result.feedback).toBe("seeded");
    expect(forge.posts[0]!.body).toContain("seeded");
  });

  it("task reopen / worker redrive cannot bypass intent lookup", async () => {
    const intentRepository = new InMemorySimulatedReviewIntentRepository();
    intentRepository.seed("run_1", {
      headSha: HEAD,
      state: "changes_requested",
      event: "REQUEST_CHANGES",
      body: bodyForIntent("changes_requested", "blocking"),
      message: "blocking",
      reviewerLogin: REVIEWER,
      marker: "tanren-simulated-review:v1:changes_requested",
    });
    const forge: SharedForge = { posts: [], listed: 0, reviews: [] };
    const pool = new ReviewMergePool("direct_merge", "open", "simulated");
    seedReviewTask(pool);
    const events = new FakeEventStore();
    const seen = { calls: 0, prompts: [] as string[] };
    const result = await pollReviewForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: sharedConvergentProbe(forge),
      simulatedReviewer: () => fakeReviewer({ verdict: "approve", reasoning: "bypass?" }, seen),
      simulatedReviewContext: baseSpec(),
      intentRepository,
      publishFence: new InMemorySimulatedReviewPublishFence(),
    });
    expect(seen.calls).toBe(0);
    expect(result.verdict).toBe("changes_requested");
    expect(forge.posts[0]!.event).toBe("REQUEST_CHANGES");
  });

  it("intent event never lands as terminal review.approved / changes_requested authority", async () => {
    const events = new FakeEventStore();
    const intentRepository = new InMemorySimulatedReviewIntentRepository({
      append: async (entry) => {
        await events.append({
          runId: entry.runId,
          orgId: entry.orgId,
          projectId: entry.projectId,
          eventType: entry.eventType,
          payload: entry.payload,
        });
      },
    });
    // Seed only intent — do not publish/terminalize.
    await intentRepository.adoptOrRecord({
      runId: "run_1",
      orgId: "org_1",
      projectId: "project_1",
      candidate: {
        headSha: HEAD,
        state: "approved",
        event: "APPROVE",
        body: bodyForIntent("approved", "x"),
        message: "x",
        reviewerLogin: REVIEWER,
        marker: "tanren-simulated-review:v1:approved",
      },
    });
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain(REVIEW_SIMULATED_INTENT_EVENT);
    expect(types).not.toContain("review.approved");
    expect(types).not.toContain("review.changes_requested");
    // landSignals query set excludes simulated_intent by construction.
    expect(simulatedReviewIntentKey("run_1", HEAD)).toBe(`run_1:simulated-review-intent:${HEAD}`);
  });

  it("crash after list / before POST: second worker re-lists and posts once total", async () => {
    const forge: SharedForge = { posts: [], listed: 0, reviews: [] };
    let failFirstPost = true;
    const probe: ReviewProbe = {
      markReady: async () => {},
      fetchVerdict: async () => ({ verdict: "pending" }),
      fetchSnapshot: async () => ({
        baseSha: "b".repeat(40),
        headSha: HEAD,
        authorLogin: "pr-writer",
        diff: "diff",
      }),
      fetchLiveHeadSha: async () => HEAD,
      pinSimulatedReviewer: async () => ({
        reviewerLogin: REVIEWER,
        submitReview: async (event, body, sha) => {
          forge.listed += 1;
          if (failFirstPost) {
            failFirstPost = false;
            throw new Error("worker died before POST");
          }
          forge.posts.push({ event, body, headSha: sha });
          const receipt = receiptFor(event, sha);
          forge.reviews.push(receipt);
          return receipt;
        },
      }),
    };
    const intentRepository = new InMemorySimulatedReviewIntentRepository();
    const publishFence = new InMemorySimulatedReviewPublishFence();
    const pool1 = new ReviewMergePool("direct_merge", "open", "simulated");
    seedReviewTask(pool1);
    const events1 = new FakeEventStore();
    const seen1 = { calls: 0, prompts: [] as string[] };
    await expect(
      pollReviewForRun({
        pool: pool1.asPgPool(),
        eventStore: events1,
        runStateWriter: fakeMergeWriter(pool1, events1),
        secrets: new FakeSecretStore(),
        githubHttp: unusedHttp(),
        runId: "run_1",
        reviewProbe: probe,
        simulatedReviewer: () => fakeReviewer({ verdict: "approve", reasoning: "ok" }, seen1),
        simulatedReviewContext: baseSpec(),
        intentRepository,
        publishFence,
      }),
    ).rejects.toThrow(/died before POST|publication failed/iu);

    const existing = await intentRepository.lookup("org_1", "run_1", HEAD);
    expect(existing?.state).toBe("approved");

    const pool2 = new ReviewMergePool("direct_merge", "open", "simulated");
    seedReviewTask(pool2);
    const events2 = new FakeEventStore();
    const seen2 = { calls: 0, prompts: [] as string[] };
    const result = await pollReviewForRun({
      pool: pool2.asPgPool(),
      eventStore: events2,
      runStateWriter: fakeMergeWriter(pool2, events2),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe,
      simulatedReviewer: () => fakeReviewer({ verdict: "request_changes", reasoning: "nope" }, seen2),
      simulatedReviewContext: baseSpec(),
      intentRepository,
      publishFence,
    });
    expect(seen2.calls).toBe(0);
    expect(result.verdict).toBe("approved");
    expect(forge.posts).toHaveLength(1);
  });
});
