// gv-2: forge publication fields are ALL-OR-NOTHING at the event-schema boundary.
// Complete receipt and fully-absent are valid; partial tuples are rejected.
import { describe, expect, it } from "vitest";
import { ReviewApprovedPayload, ReviewChangesRequestedPayload } from "../src/engine/events/schemas/integrations.js";

const HEAD = "a".repeat(40);
const COMPLETE = {
  forgeReviewId: "9001",
  forgeReviewState: "approved" as const,
  forgeReviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-9001",
  headSha: HEAD,
};

describe("ReviewApprovedPayload forge publication all-or-nothing", () => {
  it("accepts absent forge fields (human/auto path)", () => {
    expect(ReviewApprovedPayload.safeParse({ prUrl: "https://x", prNumber: 1 }).success).toBe(true);
  });

  it("accepts a complete forge receipt tuple", () => {
    const parsed = ReviewApprovedPayload.safeParse({
      prUrl: "https://x",
      prNumber: 1,
      reviewer: "bot",
      ...COMPLETE,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects partial forge tuples (former independent-optionals hole)", () => {
    expect(
      ReviewApprovedPayload.safeParse({
        prUrl: "https://x",
        prNumber: 1,
        forgeReviewId: "9001",
      }).success,
    ).toBe(false);
    expect(
      ReviewApprovedPayload.safeParse({
        prUrl: "https://x",
        prNumber: 1,
        forgeReviewId: "9001",
        forgeReviewState: "approved",
        forgeReviewUrl: "https://x",
        // headSha missing
      }).success,
    ).toBe(false);
    expect(
      ReviewApprovedPayload.safeParse({
        prUrl: "https://x",
        prNumber: 1,
        headSha: HEAD,
      }).success,
    ).toBe(false);
  });

  it("rejects non-40-hex durable receipt headSha at the schema boundary", () => {
    expect(
      ReviewApprovedPayload.safeParse({
        prUrl: "https://x",
        prNumber: 1,
        ...COMPLETE,
        headSha: "not-a-sha",
      }).success,
    ).toBe(false);
    expect(
      ReviewApprovedPayload.safeParse({
        prUrl: "https://x",
        prNumber: 1,
        ...COMPLETE,
        headSha: "abc",
      }).success,
    ).toBe(false);
    expect(
      ReviewApprovedPayload.safeParse({
        prUrl: "https://x",
        prNumber: 1,
        ...COMPLETE,
        headSha: "g".repeat(40),
      }).success,
    ).toBe(false);
  });
});

describe("ReviewChangesRequestedPayload forge publication all-or-nothing", () => {
  it("accepts absent and complete; rejects partial", () => {
    expect(
      ReviewChangesRequestedPayload.safeParse({
        prUrl: "https://x",
        prNumber: 1,
        message: "fix",
      }).success,
    ).toBe(true);
    expect(
      ReviewChangesRequestedPayload.safeParse({
        prUrl: "https://x",
        prNumber: 1,
        message: "fix",
        ...COMPLETE,
        forgeReviewState: "changes_requested",
      }).success,
    ).toBe(true);
    expect(
      ReviewChangesRequestedPayload.safeParse({
        prUrl: "https://x",
        prNumber: 1,
        forgeReviewId: "1",
        forgeReviewState: "changes_requested",
      }).success,
    ).toBe(false);
  });
});
