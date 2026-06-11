/**
 * NATIVE STATUS PUBLICATION (Track B — the no-Actions doctrine): the
 * provider-neutral input for PUBLISHING Tanren's OWN gate verdict to the VCS as a
 * commit status (the `tanren/gate` status the live `VisibilityProjection` publisher
 * posts). The native check-run publish path it once also carried was removed by the
 * VcsProvider→CodeHost decomposition (the live verdict reaches the forge as STATUS).
 *
 * Extracted from `vcsProvider.ts` so that module stays the contract surface (and
 * under the per-file line cap). Re-exported from `vcsProvider.ts` so callers
 * import them from the contract module unchanged. These payloads carry only
 * non-secret, operator/code-controlled values — never a token.
 */

import type { RepoRef, ResolvedVcsToken } from "./vcsProvider.js";

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
