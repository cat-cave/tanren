// The §5h FRESHNESS PROBE (decomposition PR-7) — the `CodeHost`-derived replacement for
// the GitHub `mergeable_state` read (`VcsProvider.readMergeability`). It is the load-bearing
// coupling §6 names to sever: post-cutover the AUTHORITY + jj decide freshness/conflict, so
// the merge dispatcher reads freshness as a pure commit-graph ANCESTRY fact over the PR's
// base/head shas (`CodeHost.fetchRef` + `CodeHost.compareRefs`), NOT GitHub's `mergeable_state`.
//
// WHAT IS / IS NOT DERIVED HERE:
//   - `clean`   — the head CONTAINS the base (compareRefs ⇒ `identical`/`ahead`): up-to-date.
//   - `behind`  — the base advanced past the head (`behind`/`diverged`): route to the unified
//                 `baseShiftRebase` (jj), which re-derives the work in place and surfaces a
//                 genuine CONFLICT itself. Conflict is NOT computed here (the host HOSTS; the
//                 jj rebase DECIDES) — so this probe NEVER returns `dirty`.
//   - `unknown` — an unresolvable base/head sha (an absent ref): the authority blocks on it.
//
// The base re-point + the base-branch read for the speculative stacked-PR retarget walk are
// routed through the best-effort `VisibilityProjection` (the forge-UI mirror), not a host
// decision — the §7-deferred speculative-retarget cleanup still owns that PR-shaped read.

import type { CodeHost, CodeHostRepoRef } from "../../contracts/codeHost.js";
import type { SafeVisibilityProjection } from "../../contracts/visibilityProjection.js";
import type { PullRequestMergeability } from "../../contracts/vcsProvider.js";
import type { MergeProbe } from "./mergeDispatchTypes.js";

/** What the freshness probe needs to derive the `clean`/`behind` signal over the host. */
export interface FreshnessProbeInput {
  codeHost: CodeHost;
  /** A best-effort forge-UI mirror for the speculative base re-point (never a gate). */
  visibility: SafeVisibilityProjection;
  repo: CodeHostRepoRef;
  /** The PR's base branch (project default; or the speculative stack target after a walk). */
  baseBranch: string;
  /** The PR's head branch (`runs.branch`) — the ref whose ancestry vs base is the freshness. */
  headBranch: string;
  /** `owner/name` for the projection's repo-full-name input. */
  repoFullName: string;
  /** The PR number the projection retargets (the speculative walk). */
  prNumber: number;
}

/**
 * Map the host ancestry of `baseBranch`/`headBranch` onto the freshness `state` the merge
 * path gates on. Reads BOTH head shas via `CodeHost.fetchRef`; an absent head or base sha is
 * `unknown` (the authority blocks — never assume current). Otherwise `compareRefs` decides:
 * `identical`/`ahead` ⇒ `clean`; `behind`/`diverged` ⇒ `behind` (the jj rebase owns conflict).
 */
export async function deriveFreshness(input: FreshnessProbeInput): Promise<PullRequestMergeability> {
  const headSha = await input.codeHost.fetchRef({ repo: input.repo, remoteBranch: input.headBranch });
  const baseSha = await input.codeHost.fetchRef({ repo: input.repo, remoteBranch: input.baseBranch });
  const fields = { baseBranch: input.baseBranch, headBranch: input.headBranch } as const;
  if (headSha === undefined || baseSha === undefined) {
    // An unresolvable base/head ref: the most-uncertain state (the authority blocks on it,
    // never proceeds). NOT `behind` (which would trigger a rebase against a phantom ref).
    return { state: "unknown", behind: false, ...fields };
  }
  const ancestry = await input.codeHost.compareRefs(input.repo, baseSha, headSha);
  if (ancestry === "identical" || ancestry === "ahead") {
    return { state: "clean", behind: false, ...fields };
  }
  // `behind` / `diverged`: the base advanced past the head → rebase via the unified
  // `baseShiftRebase` (jj). `behind: true` so the dispatcher's `behind` arm drives the rebase.
  return { state: "behind", behind: true, ...fields };
}

/**
 * Build the live merge-stage {@link MergeProbe} over the host seams (decomposition PR-7).
 * `readFreshness` derives the signal from host ancestry (§5h); `readBaseBranch` reads the
 * PR's live base for the speculative walk's `fromBase`; `retargetBase` re-points the PR base
 * through the best-effort projection (a forge-UI mirror, never a gate).
 */
export function buildFreshnessProbe(input: FreshnessProbeInput): MergeProbe {
  return {
    readFreshness: () => deriveFreshness(input),
    // The PR's CURRENT live base — read best-effort through the projection for the
    // speculative retarget walk's `fromBase` (it tracks the live forge base across walks).
    // A `skipped`/`failed` projection read falls back to the run's known base branch (the
    // walk then no-ops if that already equals its target — safe; re-walked on the next merge).
    readBaseBranch: async () => {
      const outcome = await input.visibility.readChangeRequestBase({
        repoFullName: input.repoFullName,
        changeRequestNumber: input.prNumber,
      });
      return outcome.kind === "projected" ? outcome.value : input.baseBranch;
    },
    retargetBase: async (newBase: string) => {
      // Best-effort forge-UI mirror — a projection failure can NEVER propagate (the
      // `SafeVisibilityProjection` returns a `ProjectionOutcome`, never throws).
      await input.visibility.retargetChangeRequest({
        repoFullName: input.repoFullName,
        changeRequestNumber: input.prNumber,
        newBaseBranch: newBase,
      });
    },
  };
}
