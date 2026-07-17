import { IssueOpenedPayload, MergePostMergeFailedPayload } from "./postMerge.js";

export const postMergeEventRegistry = {
  "merge.post_merge_failed": MergePostMergeFailedPayload,
  "issue.opened": IssueOpenedPayload,
} as const;
