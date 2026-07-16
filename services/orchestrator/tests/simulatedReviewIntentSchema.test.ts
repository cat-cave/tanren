import { describe, expect, it } from "vitest";

import { ReviewSimulatedIntentPayload } from "../src/engine/events/schemas/eventVocabularyW0.js";
import { reviewBodyFor } from "../src/engine/workflow/reviewMerge/simulatedReviewer.js";

const HEAD = "a".repeat(40);
const REVIEWER = "tanren-reviewer[bot]";

describe("gv-2 frozen W0 simulated-review intent schema", () => {
  it("rejects a non-40-hex intent head", () => {
    expect(
      ReviewSimulatedIntentPayload.safeParse({
        headSha: "short",
        state: "approved",
        event: "APPROVE",
        body: "b",
        message: "m",
        reviewerLogin: "r",
        marker: "tanren-simulated-review:v1:approved",
      }).success,
    ).toBe(false);
  });

  it("requires state, event, marker, and body to cohere", () => {
    const goodBody = reviewBodyFor({ verdict: "approve", reasoning: "ok" });
    const base = {
      headSha: HEAD,
      state: "approved" as const,
      event: "APPROVE" as const,
      body: goodBody,
      message: "ok",
      reviewerLogin: REVIEWER,
      marker: "tanren-simulated-review:v1:approved",
    };

    expect(ReviewSimulatedIntentPayload.safeParse({ ...base, event: "REQUEST_CHANGES" }).success).toBe(false);
    expect(
      ReviewSimulatedIntentPayload.safeParse({
        ...base,
        marker: "tanren-simulated-review:v1:changes_requested",
      }).success,
    ).toBe(false);
    expect(ReviewSimulatedIntentPayload.safeParse({ ...base, body: "free text without marker line" }).success).toBe(
      false,
    );
    expect(ReviewSimulatedIntentPayload.safeParse(base).success).toBe(true);
  });
});
