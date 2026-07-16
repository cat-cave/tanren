// gv-2 durable intended-verdict payload (not terminal land authority).
// Cross-field cohere: state ↔ event ↔ marker ↔ body must agree; poison fails loud.

import { z } from "zod";

const forgeHeadSha = z.string().regex(/^[0-9a-fA-F]{40}$/u, "intent headSha must be exactly 40 hex");

/** Marker prefix shared with simulatedReviewPublication (keep string-stable). */
export const REVIEW_SIMULATED_INTENT_MARKER_PREFIX = "tanren-simulated-review:v1:" as const;

export function expectedSimulatedIntentMarker(state: "approved" | "changes_requested"): string {
  return `${REVIEW_SIMULATED_INTENT_MARKER_PREFIX}${state}`;
}

export function expectedSimulatedIntentEvent(state: "approved" | "changes_requested"): "APPROVE" | "REQUEST_CHANGES" {
  return state === "approved" ? "APPROVE" : "REQUEST_CHANGES";
}

function bodyHasExactMarkerLine(body: string, marker: string): boolean {
  return body.split(/\r?\n/u).some((line) => line.trim() === marker);
}

export const ReviewSimulatedIntentPayload = z
  .object({
    headSha: forgeHeadSha,
    state: z.enum(["approved", "changes_requested"]),
    event: z.enum(["APPROVE", "REQUEST_CHANGES"]),
    body: z.string().min(1),
    message: z.string(),
    reviewerLogin: z.string().min(1),
    marker: z.string().min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    const expectedEvent = expectedSimulatedIntentEvent(val.state);
    if (val.event !== expectedEvent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `intent event must be ${expectedEvent} when state is ${val.state}`,
        path: ["event"],
      });
    }
    const expectedMarker = expectedSimulatedIntentMarker(val.state);
    if (val.marker !== expectedMarker) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `intent marker must be exact ${expectedMarker}`,
        path: ["marker"],
      });
    }
    if (!bodyHasExactMarkerLine(val.body, expectedMarker)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `intent body must contain exact marker line ${expectedMarker}`,
        path: ["body"],
      });
    }
  });
