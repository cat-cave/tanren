// The `VcsProvider` seam (autonomy-engine.md §1.1, §2, §2d, §5): the
// provider-agnostic surface over the VCS + CI operations the run + merge
// lifecycle performs directly against a forge today (GitHub now; GitLab/others
// later). This is a PURE EXTRACTION of the operations the PR-open / CI-poll /
// review / merge stages already perform — it adds no behavior. The GitHub impl
// (`engine/providers/githubVcsProvider.ts`) COMPOSES the existing
// `GitHubPullRequestService` / `GitHubStatusService` / `GitHubReviewMergeService`
// + the token resolver + the SSH push, so every current behavior
// (token-via-stdin clone auth, the GraphQL ready mutation, the 401-refresh
// retry, the timed HTTP wrapper, the merge dispatch, the CI-poll semantics) is
// preserved exactly.
//
// Phase 2 EXTENDS this contract WITHOUT reshaping it:
//   - P2a (auto-rebase) adds `updateBranch(...)` to bring a PR branch up to date
//     with its base before merge.
//   - P2b (intent-preserving conflict resolution) adds the conflict-resolution
//     read/write hooks (read both sides, write a resolved tree) the resolver
//     drives — replacing the `noopConflictResolver` default in mergeDispatch.
//   - P2c (speculative execution) adds the integration-branch ops (create a
//     speculative integration ref, push a batched merge, tear it down).
// Those intent points are marked `// Phase 2:` below. They are NOT implemented
// here — the contract is shaped so adding them is purely additive.
//
// The seam is the VCS/ACTIONS provider, NOT the merge QUEUE (§1.1): the queue
// (Mergify today, the native intent-preserving queue later) sits ABOVE the
// provider and drives it through these operations.

import { Buffer } from "node:buffer";
import type { SshTarget } from "./allocator.js";
import type { SecretStore } from "./secretStore.js";
import type { SshSubstrate } from "./sshSubstrate.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { GitHubPullRequestChecks, GitHubRepository } from "../providers/github.js";
import type { MergePullRequestResult, ReviewVerdictResult, SubmitReviewEvent } from "../providers/githubReviewMerge.js";
import type { PullRequestContributors } from "../workflow/reviewMerge/governancePosture.js";

// ---- Neutral identity / payload shapes ------------------------------------

/**
 * A repository on the VCS, identified the provider-neutral way: `owner` +
 * `name`. The GitHub impl maps this 1:1 onto `GitHubRepository`. A future
 * GitLab impl maps it onto namespace/project. The repo `url` callers already
 * carry is parsed into this by the provider (`parseRepository`).
 */
export type RepoRef = GitHubRepository;

/** A pull/merge request, identified by its repo + its forge-local number. */
export interface PullRequestRef {
  repo: RepoRef;
  number: number;
}

/** The result of opening (or re-using an open) draft pull request. */
export interface OpenedPullRequest {
  number: number;
  url: string;
  /** True when an already-open PR was reused rather than freshly created. */
  reused: boolean;
}

// ---- Credentials -----------------------------------------------------------

/**
 * The per-repo credential context the provider resolves a usable access token
 * from. It carries exactly what the run already knows: the secret store, the
 * org App installation (when the org installed the App — the preferred path),
 * and/or a static credential ref (a project/org GitHub credential). The provider
 * owns the resolution policy (App-first, static fallback, hard-throw when
 * neither is configured) — this is the "clone-auth / credential resolution for a
 * repo" operation in provider-neutral terms.
 */
export interface VcsCredentialContext {
  secrets: SecretStore;
  /** Org App installation block, when the org has installed the App. */
  installation?: OrgGithubAppInstallation;
  /** Static fallback credential ref (a project/org credential). */
  staticRef?: string;
  /** Shared installation-token minter (its cache lives here). */
  minter?: GithubAppTokenMinter;
}

/**
 * A resolved access token plus the re-mint supplier the 401-refresh retry path
 * uses. Resolved ONCE per stage and threaded into every operation that stage
 * performs, mirroring the existing `buildGitHubProbe` (one resolve, many ops),
 * so the extraction does not change how many times a token is minted/read.
 */
export interface ResolvedVcsToken {
  token: string;
  source: "github_app" | "static";
  /** Re-mint / re-read the token (the 401-refresh retry path). */
  refresh(): Promise<string>;
}

// ---- Operation inputs ------------------------------------------------------

/**
 * Push a workspace branch to the VCS over the runner's SSH session, using the
 * resolved token as the HTTPS credential (token-via-stdin / GIT_ASKPASS — the
 * token never appears in a command string, process args, or an emitted event).
 * `sourceRef` is the operator/code-controlled local ref to push (HEAD or the
 * cleaned PR ref), never user-derived.
 */
export interface PushBranchInput {
  /**
   * The secret store. Carried for parity with the underlying push (which can
   * read a static push token from a ref); on the run/merge path `token` is
   * always pre-resolved, so the ref read never runs — but the field is required
   * so a provider that lacks a pre-resolved token could fall back to it.
   */
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
  repoUrl: string;
  branch: string;
  /** The ledger credential ref (for the auth-prelude label); behavior-neutral. */
  credentialRef: string;
  token: ResolvedVcsToken;
  timeoutMs: number;
  sourceRef?: string;
}

/** Open (or re-use an open) draft pull request from `headBranch` into `baseBranch`. */
export interface OpenDraftPullRequestInput {
  repo: RepoRef;
  token: ResolvedVcsToken;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
}

/**
 * The VcsProvider contract: every VCS/CI operation the run + merge lifecycle
 * performs directly against the forge, behind a provider-neutral seam. Each
 * operation takes a pre-`resolveToken`'d {@link ResolvedVcsToken} so a stage
 * resolves once and performs many operations (unchanged from today's probes).
 *
 * Methods, and the EXISTING call sites they extract:
 *   - resolveToken        ← githubTokenResolver.resolveGithubToken (clone-auth /
 *                            credential resolution for a repo)
 *   - parseRepository /
 *     parsePullRequest    ← github.parseGitHubRepository / parseGitHubPullRequestUrl
 *   - pushBranch          ← githubPush.pushWorkspaceBranchToGitHub
 *   - openDraftPullRequest← github.GitHubPullRequestService.ensureDraftPullRequest
 *   - markReadyForReview  ← githubReviewMerge.markReadyForReview (the GraphQL
 *                            un-draft mutation)
 *   - readPullRequestChecks ← github.GitHubStatusService.fetchPullRequestChecks
 *                            (CI/check status + required contexts)
 *   - readReviewVerdict   ← githubReviewMerge.fetchReviewVerdict
 *   - readPullRequestDiff ← githubReviewMerge.fetchPullRequestDiff
 *   - submitReview        ← githubReviewMerge.submitReview
 *   - listContributors    ← mergeDispatch's PR-commits contributor read
 *   - applyQueueLabel     ← githubReviewMerge.applyQueueLabel (the Mergify trigger)
 *   - mergePullRequest    ← githubReviewMerge.mergePullRequest
 *   - readFileOnBranch    ← the forge `/contents` read on a base/head ref
 *
 * NOTE the GitHub webhooks/auth/forge-recon/config-gate GitHub code is NOT part
 * of this seam — only the run+merge lifecycle path is routed through it.
 */
export interface VcsProvider {
  /**
   * Resolve a usable access token (+ refresh supplier) for the repo from the
   * credential context. App-first, static fallback, hard-throw when neither is
   * configured — the provider owns the policy. This is the clone-auth /
   * credential-resolution operation in neutral terms.
   */
  resolveToken(creds: VcsCredentialContext): Promise<ResolvedVcsToken>;

  /** Parse a repository clone URL into the neutral {@link RepoRef}. */
  parseRepository(repoUrl: string): RepoRef;

  /** Parse a pull-request URL into its {@link PullRequestRef}. */
  parsePullRequest(prUrl: string): PullRequestRef;

  /** Push a branch to the repo over SSH using the resolved token as HTTPS auth. */
  pushBranch(input: PushBranchInput): Promise<void>;

  /** Open (or re-use) a draft pull request; idempotent on an open head/base. */
  openDraftPullRequest(input: OpenDraftPullRequestInput): Promise<OpenedPullRequest>;

  /** Mark a draft PR ready for review (genuinely un-draft it); idempotent. */
  markReadyForReview(pr: PullRequestRef, token: ResolvedVcsToken): Promise<void>;

  /**
   * Read the PR's CI/check status (check-runs + commit statuses + the
   * branch-protection required contexts) — the input to the CI-poll evaluator.
   */
  readPullRequestChecks(pr: PullRequestRef, token: ResolvedVcsToken): Promise<GitHubPullRequestChecks>;

  /** Read the PR's reviews, reduced to a single actionable verdict. */
  readReviewVerdict(pr: PullRequestRef, token: ResolvedVcsToken): Promise<ReviewVerdictResult>;

  /** Read the PR's unified diff (the reviewer Answerer judges this). */
  readPullRequestDiff(pr: PullRequestRef, token: ResolvedVcsToken): Promise<string>;

  /** Submit a review on the PR (the simulated-reviewer COMMENT audit artifact). */
  submitReview(pr: PullRequestRef, event: SubmitReviewEvent, body: string, token: ResolvedVcsToken): Promise<void>;

  /**
   * List the PR's distinct contributor logins (author + committer) for the
   * governance-posture external-change gate.
   */
  listContributors(pr: PullRequestRef, token: ResolvedVcsToken): Promise<PullRequestContributors>;

  /** Apply the merge-queue label to the PR (the Mergify trigger). */
  applyQueueLabel(pr: PullRequestRef, label: string, token: ResolvedVcsToken): Promise<void>;

  /**
   * Merge the PR. A 200 merges; a non-mergeable (405/409) is reported as a
   * `conflict` (recoverable), distinct from a hard failure, so the merge
   * dispatcher routes a conflict to the (Phase-2b) resolver scaffolding.
   */
  mergePullRequest(
    pr: PullRequestRef,
    token: ResolvedVcsToken,
    mergeMethod?: "merge" | "squash" | "rebase",
  ): Promise<MergePullRequestResult>;

  /**
   * Read a file's UTF-8 content on `ref` (a branch/sha), or `undefined` when it
   * does not exist on that ref. Phase 2 (P2b conflict resolution / P2c
   * speculative integration) reads base-branch state through this.
   */
  readFileOnBranch(input: {
    repo: RepoRef;
    ref: string;
    path: string;
    token: ResolvedVcsToken;
  }): Promise<string | undefined>;

  // Phase 2 (P2a auto-rebase): `updateBranch(pr, token)` — bring the PR branch
  // up to date with its base before merge (GitHub's update-branch endpoint).
  //
  // Phase 2 (P2b intent-preserving conflict resolution): conflict read/write
  // hooks — read both sides of a conflicted path + write a resolved tree —
  // replacing the `noopConflictResolver` default.
  //
  // Phase 2 (P2c speculative execution): integration-branch ops — create a
  // speculative integration ref, push a batched merge onto it, tear it down.
  //
  // All three are PURELY ADDITIVE methods on this interface; the existing run +
  // merge path above does not change when they land.
}

/**
 * Decode a forge `/contents` response body's base64 content to a UTF-8 string.
 * Shared by the GitHub impl (and any future provider whose contents read is
 * base64-encoded) — kept on the contract module so the decode policy lives with
 * the seam, not duplicated per impl.
 */
export function decodeBase64Content(content: string): string {
  return Buffer.from(content.replaceAll("\n", ""), "base64").toString("utf8");
}
