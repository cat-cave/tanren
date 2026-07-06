import { z } from "zod";

// Demos-as-evidence payloads live in their own module (schemas/demo.ts) but are
// re-exported through this post-merge barrel — the demo-on-deploy watcher is itself a
// post-merge subscriber — so the EventRegistry pulls them off one barrel it already
// imports (keeps the registry under its dependency cap).
export { DemoEvidenceRecordedPayload, DemoCompletedPayload, DemoFailedPayload } from "./demo.js";

// Post-merge auto-issue creation (tempering.md dimension A, the last core
// run-loop item). After a run's PR merges onto `default_branch`, the post-merge
// watcher reads the post-merge CI on the base branch (the SAME readBranchChecks
// path the speculative batch-check uses) for the merge commit. When that CI
// FAILS, the watcher files ONE tracking issue so the regression is tracked, and
// narrates it through these two events:
//   - merge.post_merge_failed → the post-merge CI on default_branch failed for a
//                               merged run; carries the failing checks + the
//                               merge identity so the timeline shows the
//                               regression and the auto-filed issue is auditable.
//   - issue.opened            → a tracking issue was auto-opened (its number/url),
//                               keyed to the run — this is ALSO the idempotency
//                               marker: the watcher opens at most one issue per
//                               merge, checking for a prior issue.opened on the run
//                               before filing, so repeated checks never spam.

// One failing check on the base-branch post-merge CI (same shape as the CI-poll
// `failingChecks` refs, so the issue body + timeline read consistently).
const PostMergeCheckRef = z
  .object({
    kind: z.enum(["check_run", "commit_status"]),
    name: z.string(),
    state: z.string(),
    url: z.string().optional(),
  })
  .strict();

export const MergePostMergeFailedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    /** The spec whose merged PR regressed the base branch. */
    specId: z.string(),
    /** The base branch the post-merge CI ran on (`default_branch`). */
    baseBranch: z.string(),
    /** The merge commit sha the post-merge CI is keyed on, when known. */
    mergeSha: z.string().optional(),
    /** The failing post-merge checks (the regression signal). */
    failingChecks: z.array(PostMergeCheckRef),
  })
  .strict();

// The reason an issue was opened. Only `post_merge_failure` today; the enum keeps
// the auto-issue surface extensible (a future auto-issue source adds a case here)
// without reshaping the payload.
const IssueOpenedReason = z.enum(["post_merge_failure"]);

export const IssueOpenedPayload = z
  .object({
    reason: IssueOpenedReason,
    /** The opened issue's forge-local number. */
    issueNumber: z.number().int(),
    /** The opened issue's html url. */
    issueUrl: z.string(),
    /** The merged PR the regression issue tracks. */
    prUrl: z.string(),
    /** The label the issue was filed under (e.g. `tanren:post-merge-failure`). */
    label: z.string(),
  })
  .strict();
