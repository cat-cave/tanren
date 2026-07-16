// Review-stage sensitivity rules (split so sensitivityRules.infra.ts stays under
// the 500-line cap). gv-2 adds durable forge receipt fields on terminal review.*.
import type { SensitivityRule } from "./sensitivity.js";

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}

export const reviewSensitivityRules: SensitivityRule[] = [
  ...rulesFor("review.requested", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reviewers", "public"],
    ["reviewers[]", "public"],
  ]),
  ...rulesFor("review.approved", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reviewer", "public"],
    ["forgeReviewId", "public"],
    ["forgeReviewState", "public"],
    ["forgeReviewUrl", "public"],
    ["headSha", "public"],
  ]),
  ...rulesFor("review.auto_approved", [
    ["prUrl", "public"],
    ["prNumber", "public"],
  ]),
  ...rulesFor("review.changes_requested", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reviewer", "public"],
    ["message", "public"],
    ["forgeReviewId", "public"],
    ["forgeReviewState", "public"],
    ["forgeReviewUrl", "public"],
    ["headSha", "public"],
  ]),
  // gv-2 intent fence — non-secret publication identity (never a token).
  ...rulesFor("review.simulated_intent", [
    ["headSha", "public"],
    ["state", "public"],
    ["event", "public"],
    ["body", "public"],
    ["message", "public"],
    ["reviewerLogin", "public"],
    ["marker", "public"],
  ]),
];
