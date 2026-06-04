/**
 * NATIVE CHECK/STATUS PUBLICATION (Track B — the no-Actions doctrine,
 * `docs/roadmap/tanren-direction.md`): the provider-neutral inputs for PUBLISHING
 * Tanren's OWN verdict to the VCS. Today Tanren's in-loop gate runs natively but
 * its result is never published to the forge — the forge only carries Actions'
 * check-runs, which Tanren READS. These types are the additive seam by which
 * Tanren publishes a native check-run (the Checks API) and/or a commit status, so
 * a later cutover can make Tanren's own verdict the merge-gating signal.
 *
 * Extracted from `vcsProvider.ts` so that module stays the contract surface (and
 * under the per-file line cap). Re-exported from `vcsProvider.ts` so callers
 * import them from the contract module unchanged. These payloads carry only
 * non-secret, operator/code-controlled values — never a token.
 */

import type { RepoRef, ResolvedVcsToken } from "./vcsProvider.js";

/**
 * The terminal verdict of a published check-run, in provider-neutral terms. Maps
 * 1:1 onto the GitHub Checks API `conclusion` enum:
 *   - `success`        — the gate passed.
 *   - `failure`        — the gate failed (a hard red).
 *   - `neutral`        — ran, no pass/fail opinion (informational).
 *   - `cancelled`      — the run was cancelled before a verdict.
 *   - `timed_out`      — the run exceeded its time budget.
 *   - `action_required`— a human action is required to proceed.
 * A GitLab impl maps these onto its own pipeline/commit-status states.
 */
export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required";

/**
 * One annotation on a published check-run — a file+line-scoped finding the gate
 * wants rendered inline in the PR diff (e.g. a failing assertion's location).
 * `path` is repo-relative; `startLine`/`endLine` are 1-based; `annotationLevel`
 * is the GitHub Checks annotation severity. All values are non-secret diagnostics.
 */
export interface CheckAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  annotationLevel: "notice" | "warning" | "failure";
  message: string;
  title?: string;
}

/**
 * Input to publishing a Tanren-native CHECK-RUN against a head commit (GitHub
 * `POST /repos/{o}/{r}/check-runs`). `name` is the check's display name (the
 * context the PR UI shows, e.g. `tanren/gate`); `headSha` is the commit the
 * verdict is about; `conclusion` is the terminal verdict (a published check-run
 * is always `completed`). `title`/`summary` render in the check's detail view;
 * `detailsUrl` optionally links out (e.g. to the run); `annotations` attach
 * inline file findings. Every field is non-secret.
 */
export interface PublishCheckInput {
  repo: RepoRef;
  token: ResolvedVcsToken;
  name: string;
  headSha: string;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  detailsUrl?: string;
  annotations?: ReadonlyArray<CheckAnnotation>;
}

/** The result of publishing a check-run — its forge-local id + html url, for diagnostics/idempotency. */
export interface PublishedCheck {
  id: number;
  url: string;
}

/**
 * The state of a published COMMIT STATUS, in provider-neutral terms. Maps onto the
 * GitHub commit-status `state` enum (`error`/`failure`/`pending`/`success`). The
 * commit status is the lower-friction signal (no `checks:write` scope required) —
 * the same primitive the `github_checks` notification channel already posts.
 */
export type StatusState = "success" | "failure" | "pending" | "error";

/**
 * Input to publishing a Tanren-native COMMIT STATUS on a head commit (GitHub
 * `POST /repos/{o}/{r}/statuses/{sha}`). `context` is the status' label (the PR
 * UI groups by it, e.g. `tanren`); `state` is its outcome; `description` is a
 * short human summary; `targetUrl` optionally links out. Every field is non-secret.
 */
export interface PublishStatusInput {
  repo: RepoRef;
  token: ResolvedVcsToken;
  headSha: string;
  context: string;
  state: StatusState;
  description: string;
  targetUrl?: string;
}
