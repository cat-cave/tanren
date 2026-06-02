// P2·0: the VcsProvider registry/selector. Mirrors `buildAllocator` /
// `buildSecretStore`: a pluggable seam selected by KIND, with the REAL GitHub
// impl as the production default and a HARD-THROW (`UnconfiguredVcsProvider`,
// like `UnconfiguredAllocator`) for kinds that are not yet implemented — never a
// stub/no-op stand-in (P8a §8a). The kind defaults to `github` (the only forge
// the run+merge lifecycle supports today); `TANREN_VCS_PROVIDER` can name it
// explicitly so a future `gitlab` impl slots in as a new case, not a refactor.
//
// The seam is the VCS/ACTIONS provider, NOT the merge QUEUE (§1.1): the queue
// drives the provider through its operations.

import { FetchGitHubHttpClient, type GitHubHttpClient } from "./github.js";
import { GitHubVcsProvider } from "./githubVcsProvider.js";
import { GithubAppTokenMinter } from "./githubAppTokenMinter.js";

// Re-exported so a single import site (the worker boot) can pull the concrete
// GitHub HTTP client, the provider builder, AND the shared App-token minter from
// one module, keeping that file under the per-file dependency cap. The HTTP
// client is the transport the provider composes; the minter caches the App
// installation token the App-first clone/CI/merge stages reuse.
export { FetchGitHubHttpClient, GithubAppTokenMinter };
import type { MergePullRequestResult, ReviewVerdictResult, SubmitReviewEvent } from "./githubReviewMerge.js";
import type { GitHubPullRequestChecks } from "./github.js";
import type { PullRequestContributors } from "../workflow/reviewMerge/governancePosture.js";
import type {
  BuildIntegrationBranchInput,
  BuildIntegrationBranchResult,
  CreatedIssue,
  CreateIssueInput,
  OpenDraftPullRequestInput,
  OpenedPullRequest,
  PullRequestMergeability,
  PullRequestRef,
  PushBranchInput,
  RepoRef,
  ResolvedVcsToken,
  UpdateBranchResult,
  VcsCredentialContext,
  VcsProvider,
} from "../contracts/vcsProvider.js";

/** Selectable VcsProvider backends. `github` is the real, default forge. */
export type VcsProviderKind = "github" | "gitlab";

/** Process-environment view; defaults to `process.env`, injectable in tests. */
export type VcsProviderEnv = Record<string, string | undefined>;

/**
 * A HARD-THROW provider for a kind that is named but not yet implemented (e.g.
 * `gitlab`). Selecting it constructs this, and any operation throws loudly — the
 * correct "unconfigured" default (failing loud is not a stand-in), exactly like
 * `UnconfiguredAllocator`. No method silently no-ops.
 */
export class UnconfiguredVcsProvider implements VcsProvider {
  constructor(private readonly kind: string) {}

  private fail(): never {
    throw new Error(
      `VCS provider kind '${this.kind}' was selected but is not implemented. ` +
        `Set TANREN_VCS_PROVIDER=github (the only supported forge today).`,
    );
  }

  async resolveToken(_creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    return this.fail();
  }
  parseRepository(_repoUrl: string): RepoRef {
    return this.fail();
  }
  parsePullRequest(_prUrl: string): PullRequestRef {
    return this.fail();
  }
  async pushBranch(_input: PushBranchInput): Promise<void> {
    return this.fail();
  }
  async openDraftPullRequest(_input: OpenDraftPullRequestInput): Promise<OpenedPullRequest> {
    return this.fail();
  }
  async createIssue(_input: CreateIssueInput): Promise<CreatedIssue> {
    return this.fail();
  }
  async markReadyForReview(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<void> {
    return this.fail();
  }
  async readPullRequestChecks(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<GitHubPullRequestChecks> {
    return this.fail();
  }
  async readBranchChecks(_input: {
    repo: RepoRef;
    branch: string;
    token: ResolvedVcsToken;
  }): Promise<GitHubPullRequestChecks> {
    return this.fail();
  }
  async readReviewVerdict(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<ReviewVerdictResult> {
    return this.fail();
  }
  async readPullRequestDiff(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<string> {
    return this.fail();
  }
  async submitReview(
    _pr: PullRequestRef,
    _event: SubmitReviewEvent,
    _body: string,
    _token: ResolvedVcsToken,
  ): Promise<void> {
    return this.fail();
  }
  async listContributors(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<PullRequestContributors> {
    return this.fail();
  }
  async mergePullRequest(
    _pr: PullRequestRef,
    _token: ResolvedVcsToken,
    _mergeMethod?: "merge" | "squash" | "rebase",
  ): Promise<MergePullRequestResult> {
    return this.fail();
  }
  async readFileOnBranch(_input: {
    repo: RepoRef;
    ref: string;
    path: string;
    token: ResolvedVcsToken;
  }): Promise<string | undefined> {
    return this.fail();
  }
  async readBranchHeadSha(_input: {
    repo: RepoRef;
    branch: string;
    token: ResolvedVcsToken;
  }): Promise<string | undefined> {
    return this.fail();
  }
  async readMergeability(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<PullRequestMergeability> {
    return this.fail();
  }
  async updateBranch(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<UpdateBranchResult> {
    return this.fail();
  }
  async buildIntegrationBranch(_input: BuildIntegrationBranchInput): Promise<BuildIntegrationBranchResult> {
    return this.fail();
  }
  async retargetPullRequestBase(_pr: PullRequestRef, _newBase: string, _token: ResolvedVcsToken): Promise<void> {
    return this.fail();
  }
  async deleteBranch(_repo: RepoRef, _branch: string, _token: ResolvedVcsToken): Promise<void> {
    return this.fail();
  }
}

/**
 * Select + construct the VcsProvider for the run+merge lifecycle. The `http`
 * client is the (timed) GitHub HTTP client the server/worker already builds —
 * threaded in so the observability decorator stays in force. Defaults to
 * `github`; an unknown/unimplemented kind throws when used via
 * {@link UnconfiguredVcsProvider}.
 */
export function buildVcsProvider(http: GitHubHttpClient, env: VcsProviderEnv = process.env): VcsProvider {
  const raw = env["TANREN_VCS_PROVIDER"];
  const kind = (raw === undefined || raw === "" ? "github" : raw.toLowerCase()) as VcsProviderKind;
  switch (kind) {
    case "github":
      return new GitHubVcsProvider(http);
    case "gitlab":
      return new UnconfiguredVcsProvider("gitlab");
    default:
      throw new Error(`unknown TANREN_VCS_PROVIDER='${kind}' (expected github|gitlab)`);
  }
}
