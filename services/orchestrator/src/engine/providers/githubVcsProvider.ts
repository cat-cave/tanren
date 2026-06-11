// The GitHub VcsProvider impl. After the VcsProvider→CodeHost/VisibilityProjection
// decomposition, this is the RESIDUAL seam:
// it COMPOSES the credential resolver + identity helper, the URL parsers, and the
// two genuine-fork forge reads still on the provider (`readBranchChecks` post-merge
// host CI read, `readReviewVerdict` external-approval read) — wrapping GitHub logic,
// never re-implementing it. The HTTP client is injected at construction. PR-9 deletes
// the seam entirely once those two reads are rehomed.

import { resolveVcsActorIdentity, resolveVcsToken } from "../credentials/vcsCredentials.js";
import type {
  ActorIdentity,
  PullRequestRef,
  RepoRef,
  ResolvedVcsToken,
  VcsCredentialContext,
  VcsProvider,
} from "../contracts/vcsProvider.js";
import {
  GitHubStatusService,
  parseGitHubPullRequestUrl,
  parseGitHubRepository,
  type GitHubHttpClient,
  type GitHubPullRequestChecks,
} from "./github.js";
import { GitHubReviewMergeService, type ReviewVerdictResult } from "./githubReviewMerge.js";

/**
 * The GitHub implementation of {@link VcsProvider}. Constructed with the shared
 * (timed) `GitHubHttpClient`; the per-call credential context is supplied by the
 * stage via {@link resolveToken}, as the existing stage probes do.
 */
export class GitHubVcsProvider implements VcsProvider {
  private readonly status: GitHubStatusService;
  private readonly reviewMerge: GitHubReviewMergeService;

  constructor(
    // §5: public-READABLE so the merge stage builds its `CodeHost` over the SAME client.
    readonly http: GitHubHttpClient,
  ) {
    this.status = new GitHubStatusService(http);
    this.reviewMerge = new GitHubReviewMergeService(http);
  }

  // §5a: token + identity resolution is credential PLUMBING (every host seam needs it),
  // not a forge op — the body lives in the standalone `credentials/vcsCredentials.ts`.
  // These two methods DELEGATE so not-yet-migrated `VcsProvider` callers still work.
  async resolveToken(creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    return resolveVcsToken(this.http, creds);
  }

  async resolveActorIdentity(token: ResolvedVcsToken): Promise<ActorIdentity> {
    return resolveVcsActorIdentity(token);
  }

  parseRepository(repoUrl: string): RepoRef {
    return parseGitHubRepository(repoUrl);
  }

  parsePullRequest(prUrl: string): PullRequestRef {
    const parsed = parseGitHubPullRequestUrl(prUrl);
    return { repo: parsed.repo, number: parsed.pullNumber };
  }

  async readBranchChecks(input: {
    repo: RepoRef;
    branch: string;
    token: ResolvedVcsToken;
  }): Promise<GitHubPullRequestChecks> {
    return this.status.fetchBranchChecks({
      repo: input.repo,
      branch: input.branch,
      token: input.token.token,
      refreshToken: input.token.refresh,
    });
  }

  async readReviewVerdict(pr: PullRequestRef, token: ResolvedVcsToken): Promise<ReviewVerdictResult> {
    return this.reviewMerge.fetchReviewVerdict({
      repo: pr.repo,
      pullNumber: pr.number,
      token: token.token,
      refreshToken: token.refresh,
    });
  }
}
