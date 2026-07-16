// Review/merge reducer + gv-2 forge-publication tri-state tests. Moved out of
// `runDetail.model.test.ts` so each file stays under the 500-line cap and the
// reducer tests import the reducer module directly. No DOM, no rendering.

import { describe, expect, it } from "vitest";
import { reviewMergeStateFromEvents } from "../src/components/runDetail/reviewMergeState.js";
import type { RunEventRow } from "../src/api/types.js";

function ev(eventType: string, payload: unknown = {}): RunEventRow {
  return {
    id: 1,
    ts: "2026-05-28T10:00:00.000Z",
    runId: "run_1",
    taskId: null,
    specId: null,
    projectId: null,
    eventType,
    payload,
    redactedPaths: [],
  };
}

describe("reviewMergeStateFromEvents — P3-0008 review/merge phase", () => {
  it("defaults to none with no review/merge events", () => {
    expect(reviewMergeStateFromEvents([]).phase).toBe("none");
  });

  it("tracks the review→merge progression to merged with the latest event winning", () => {
    const state = reviewMergeStateFromEvents([
      ev("github.pr.ready", { prUrl: "u", prNumber: 7 }),
      ev("review.requested", { prUrl: "u", prNumber: 7 }),
      ev("review.approved", { prUrl: "u", prNumber: 7 }),
      ev("merge.queued", { prUrl: "u", prNumber: 7, integration: "direct_merge" }),
      ev("merge.completed", {
        prUrl: "u",
        prNumber: 7,
        integration: "direct_merge",
        mergeSha: "abc123",
      }),
    ]);
    expect(state.phase).toBe("merged");
    expect(state.mergeSha).toBe("abc123");
    expect(state.integration).toBe("direct_merge");
  });

  it("surfaces changes_requested with the reviewer message", () => {
    const state = reviewMergeStateFromEvents([
      ev("review.requested", { prUrl: "u", prNumber: 7 }),
      ev("review.changes_requested", { prUrl: "u", prNumber: 7, message: "fix it" }),
    ]);
    expect(state.phase).toBe("changes_requested");
    expect(state.message).toBe("fix it");
  });

  it("gv-2: binds complete forge publication from review.approved", () => {
    const headSha = "a".repeat(40);
    const state = reviewMergeStateFromEvents([
      ev("review.approved", {
        prUrl: "u",
        prNumber: 7,
        reviewer: "reviewer-bot",
        forgeReviewId: "9001",
        forgeReviewState: "approved",
        forgeReviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-9001",
        headSha,
      }),
    ]);
    expect(state.phase).toBe("approved");
    expect(state.forgePublication?.complete).toBe(true);
    expect(state.forgePublication?.forgeReviewId).toBe("9001");
    expect(state.forgePublication?.headSha).toBe(headSha);
  });

  it("gv-2 former-bug: terminal review with ZERO forge fields is unpublished (undefined), not danger-partial", () => {
    // A human/auto terminal review.approved carrying no forge receipt must NOT
    // render as the loud "partial forge fields present" danger — there is no
    // receipt at all, so the neutral unpublished state (undefined) holds.
    const state = reviewMergeStateFromEvents([ev("review.approved", { prUrl: "u", prNumber: 7 })]);
    expect(state.phase).toBe("approved");
    expect(state.forgePublication).toBeUndefined();
  });

  it("gv-2 former-bug: a lone reviewer (no receipt fields) is still unpublished", () => {
    // Only a non-receipt field present — there is still no id/state/url/headSha
    // receipt, so this is unpublished, never the danger partial-receipt state.
    const state = reviewMergeStateFromEvents([
      ev("review.changes_requested", { prUrl: "u", prNumber: 7, reviewer: "human", message: "nits" }),
    ]);
    expect(state.phase).toBe("changes_requested");
    expect(state.forgePublication).toBeUndefined();
  });

  it("gv-2: partial forge fields are never complete (loud UI path)", () => {
    const state = reviewMergeStateFromEvents([
      ev("review.approved", {
        prUrl: "u",
        prNumber: 7,
        forgeReviewId: "9001",
        // missing state/url/head — a strict subset is a malformed receipt
      }),
    ]);
    expect(state.forgePublication?.complete).toBe(false);
    expect(state.forgePublication?.forgeReviewId).toBe("9001");
  });

  it("gv-2 former-bug: full tuple with commented/unknown state is NOT complete success", () => {
    const headSha = "b".repeat(40);
    const commented = reviewMergeStateFromEvents([
      ev("review.approved", {
        prUrl: "u",
        prNumber: 7,
        forgeReviewId: "1",
        forgeReviewState: "commented",
        forgeReviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-1",
        headSha,
      }),
    ]);
    expect(commented.forgePublication?.complete).toBe(false);
    expect(commented.forgePublication?.forgeReviewState).toBe("commented");

    const unknown = reviewMergeStateFromEvents([
      ev("review.changes_requested", {
        prUrl: "u",
        prNumber: 7,
        forgeReviewId: "2",
        forgeReviewState: "pending",
        forgeReviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-2",
        headSha,
      }),
    ]);
    expect(unknown.forgePublication?.complete).toBe(false);
  });

  it("surfaces a merge conflict as a recoverable phase", () => {
    const state = reviewMergeStateFromEvents([
      ev("merge.queued", { prUrl: "u", prNumber: 7, integration: "direct_merge" }),
      ev("merge.conflict", {
        prUrl: "u",
        prNumber: 7,
        integration: "direct_merge",
        baseBranch: "main",
        message: "conflict",
      }),
    ]);
    expect(state.phase).toBe("merge_conflict");
    expect(state.message).toBe("conflict");
  });
});
