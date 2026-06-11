// A purely in-memory VcsProvider for the conformance suite — a TEST FIXTURE
// (lives under tests/, never src/). It implements the residual contract directly
// off an in-memory model rather than any HTTP transport, proving the suite pins the
// contract itself (not a GitHub-shaped transport). It mirrors the scenario the
// conformance suite primes: a GREEN base ref, a FAILING base ref, and an approved
// review verdict.
import {
  CONFORMANCE_ACTOR_ID,
  CONFORMANCE_ACTOR_LOGIN,
  CONFORMANCE_ACTOR_NOREPLY_EMAIL,
  CONFORMANCE_FAILING_BRANCH,
} from "../vcsProviderConformance.js";
import type { ReviewVerdictResult } from "../../../src/engine/providers/githubReviewMerge.js";
import type { GitHubPullRequestChecks } from "../../../src/engine/providers/github.js";
import type {
  ActorIdentity,
  PullRequestRef,
  RepoRef,
  ResolvedVcsToken,
  VcsCredentialContext,
  VcsProvider,
} from "../../../src/engine/contracts/vcsProvider.js";

function parseRepo(url: string): RepoRef {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(url);
  if (m === null) throw new Error(`unsupported repository URL: ${url}`);
  return { owner: m[1] ?? "", name: m[2] ?? "" };
}

function parsePr(url: string): PullRequestRef {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]*)\/?$/u.exec(url);
  if (m === null) throw new Error(`unsupported pull request URL: ${url}`);
  return { repo: { owner: m[1] ?? "", name: m[2] ?? "" }, number: Number(m[3]) };
}

/** In-memory contract impl. Records nothing the suite asserts beyond the contract surface. */
export class InMemoryVcsProvider implements VcsProvider {
  async resolveToken(_creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    return { token: "in-memory-token", source: "static", refresh: async () => "in-memory-token-refreshed" };
  }
  async resolveActorIdentity(_token: ResolvedVcsToken): Promise<ActorIdentity> {
    return {
      login: CONFORMANCE_ACTOR_LOGIN,
      id: CONFORMANCE_ACTOR_ID,
      noreplyEmail: CONFORMANCE_ACTOR_NOREPLY_EMAIL,
    };
  }
  parseRepository(repoUrl: string): RepoRef {
    return parseRepo(repoUrl);
  }
  parsePullRequest(prUrl: string): PullRequestRef {
    return parsePr(prUrl);
  }
  async readBranchChecks(input: {
    repo: RepoRef;
    branch: string;
    token: ResolvedVcsToken;
  }): Promise<GitHubPullRequestChecks> {
    // The well-known FAILING base ref reports a failed check (a post-merge
    // regression); every other ref is green.
    if (input.branch === CONFORMANCE_FAILING_BRANCH) {
      return {
        head: { sha: `sha-${input.branch}` },
        checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
        statuses: [],
      };
    }
    return {
      head: { sha: `sha-${input.branch}` },
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      statuses: [],
    };
  }
  async readReviewVerdict(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<ReviewVerdictResult> {
    return { verdict: "approved", latest: { state: "approved", reviewer: "bot" } };
  }
}
