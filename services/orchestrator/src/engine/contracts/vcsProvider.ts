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
//   - P2a (auto-rebase) adds `readMergeability(...)` + `updateBranch(...)` to
//     read a PR branch's up-to-date state and bring it current with its base
//     before merge (IMPLEMENTED — additive; the existing signatures are intact).
//   - P2b (intent-preserving conflict resolution) adds the conflict-resolution
//     read/write hooks (read both sides, write a resolved tree) the resolver
//     drives — replacing the `noopConflictResolver` default in mergeDispatch.
//   - P2c (speculative execution) adds the integration-branch ops (create a
//     speculative integration ref, push a batched merge, tear it down).
// Those intent points are marked `// Phase 2:` below. They are NOT implemented
// here — the contract is shaped so adding them is purely additive.
//
// The seam is the VCS/ACTIONS provider, NOT the merge QUEUE (§1.1): the native
// intent-preserving merge queue (P2d) sits ABOVE the provider and drives it
// through these operations.

import { Buffer } from "node:buffer";
// Typed contract errors live in `./vcsProviderErrors.js` (line cap); re-exported
// so callers import them from the contract module unchanged.
export { RepositoryAlreadyExistsError, RepositoryCreationForbiddenError } from "./vcsProviderErrors.js";
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

/**
 * GREENFIELD: input to creating a brand-new repository under `owner` (the GitHub
 * org/user login that will own it). `autoInit: true` MUST create an initial
 * commit (GitHub `auto_init`) so the repo is immediately cloneable + has a
 * `defaultBranch`. `private` chooses visibility; `description` is an optional,
 * non-secret summary.
 */
export interface CreateRepositoryInput {
  owner: string;
  name: string;
  private: boolean;
  description?: string;
  autoInit: boolean;
}

/**
 * GREENFIELD: the just-created repository (provider-neutral). `fullName` is
 * `owner/name`; `repoUrl` is the HTTPS clone URL the project row binds to;
 * `defaultBranch` is the branch `auto_init` seeded. No token ever appears here.
 */
export interface CreatedRepository {
  fullName: string;
  repoUrl: string;
  defaultBranch: string;
}

/** The result of opening (or re-using an open) draft pull request. */
export interface OpenedPullRequest {
  number: number;
  url: string;
  /** True when an already-open PR was reused rather than freshly created. */
  reused: boolean;
}

/**
 * P2a: the up-to-date / mergeability state of a PR branch relative to its base,
 * read in provider-neutral terms. The merge stage uses this BEFORE merging to
 * decide whether a rebase/update is needed (`behind`), whether the branch is a
 * genuine conflict the resolver must handle (`dirty`), or whether it is current
 * and safe to merge (`clean`). It is derived from GitHub's PR `mergeable_state`
 * + the head/base comparison; a GitLab impl maps it from its own divergence
 * signal. `baseBranch` / `headBranch` are surfaced so the rebase + events can
 * name the refs without a second read.
 */
export interface PullRequestMergeability {
  /**
   * `clean`   — up to date with base + mergeable: proceed to merge.
   * `behind`  — out of date with base (no conflict): update/rebase then re-gate.
   * `dirty`   — a real merge conflict with base: route to the conflict resolver.
   * `blocked` — mergeability is gated by something other than freshness (e.g.
   *             failing required checks / pending review) — NOT a freshness issue.
   * `unknown` — GitHub has not computed mergeability yet (transient); the caller
   *             treats it as "do not assume current" and may re-read.
   */
  state: "clean" | "behind" | "dirty" | "blocked" | "unknown";
  /** True when the branch is strictly behind its base (a subset of `behind`/`dirty`). */
  behind: boolean;
  baseBranch: string;
  headBranch: string;
}

/**
 * P2c: one ancestor in a speculative integration branch — its branch ref + the
 * spec it implements (so the coordinator can route an A-vs-B conflict to the P2b
 * intent-preserving resolver with the right intent). DAG order is the order the
 * coordinator passes these in (ancestors before dependents).
 */
export interface IntegrationAncestor {
  specId: string;
  branch: string;
}

/** Input to building/refreshing a speculative integration branch (P2c). */
export interface BuildIntegrationBranchInput {
  repo: RepoRef;
  token: ResolvedVcsToken;
  /** The real base (`projects.default_branch`) the integration starts from. */
  baseBranch: string;
  /** The ephemeral integration ref to create/reset (e.g. `tanren/integ/<dependent>`). */
  integrationBranch: string;
  /** The unmerged ancestors to speculatively merge in, in DAG order. */
  ancestors: ReadonlyArray<IntegrationAncestor>;
}

/**
 * P2c: the outcome of building a speculative integration branch. `integrated`
 * means every ancestor merged cleanly onto the integration ref (the dependent's
 * dynamic base is ready). `conflict` means two ancestors conflict WITH EACH OTHER
 * — surfaced HERE, early, on the integration branch, so the P2b resolver runs
 * against it (not against the innocent dependent); `conflictBetween` names the two
 * conflicting ancestor specs so the resolver gets both intents.
 */
export interface BuildIntegrationBranchResult {
  outcome: "integrated" | "conflict";
  /** The integration ref (echoed for the dynamic base). */
  integrationBranch: string;
  /** The ancestor spec ids that merged cleanly, in order. */
  mergedAncestors: string[];
  /**
   * P2c-2 (change-percolation): the head SHA each merged ancestor was integrated
   * AT, keyed by ancestor spec id — recorded on the dependent's run as the
   * divergence key, so a later ancestor advance is detectable. Present for the
   * `mergedAncestors`; an ancestor that conflicted (not merged) is absent.
   */
  ancestorHeadShas: Record<string, string>;
  /** On `conflict`: the two ancestor specs that conflict with each other. */
  conflictBetween?: { specId: string; otherSpecId: string };
  /** Human-readable detail (the forge message), for events/diagnostics. */
  message: string;
}

/** The outcome of attempting to bring a PR branch up to date with its base. */
export interface UpdateBranchResult {
  /** `updated` — the branch was advanced onto the latest base (re-gate + merge). */
  /** `up_to_date` — already current; nothing to do (proceed to merge). */
  /** `conflict` — a real conflict prevents the update; route to the resolver. */
  outcome: "updated" | "up_to_date" | "conflict";
  /** Human-readable detail (the forge message), for events/diagnostics. */
  message: string;
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
 * Open a tracking issue on the repo (GitHub `POST /repos/{o}/{r}/issues`). Used by
 * the post-merge-failure watcher to file ONE tracking issue when the post-merge CI
 * on `default_branch` fails for a merged run. Provider-neutral: a GitLab impl maps
 * it onto its own issue-create. `labels` are applied at create time so the issue is
 * easy to triage (e.g. `tanren:post-merge-failure`).
 */
export interface CreateIssueInput {
  repo: RepoRef;
  token: ResolvedVcsToken;
  title: string;
  body: string;
  labels?: ReadonlyArray<string>;
}

/** The result of opening a tracking issue — its forge-local number + html url. */
export interface CreatedIssue {
  number: number;
  url: string;
}

/**
 * P-APP-ENV-1: set (create or overwrite) a single ACTIONS REPOSITORY SECRET on
 * the target repo, so the project's `tanren-ci.yml` tests that read e.g.
 * `RESEND_API_KEY` find it. The `value` is the PLAINTEXT app-env secret resolved
 * from the App Environment store — it is SECRET and load-bearing: the provider
 * MUST transmit it ONLY inside the forge's encrypted secret payload (GitHub:
 * libsodium sealed-box against the repo's Actions public key) and MUST NOT log
 * it, return it, or place it in an event. `name` is the secret name (an env-var
 * key) and is non-secret. Idempotent: GitHub's PUT creates or replaces (201/204).
 */
export interface SetActionsSecretInput {
  repo: RepoRef;
  token: ResolvedVcsToken;
  /** The secret name (the env-var key); non-secret. */
  name: string;
  /** The PLAINTEXT secret value; transmitted ONLY inside the encrypted payload. */
  value: string;
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

  /**
   * GREENFIELD: create a brand-new repository under `input.owner` so a greenfield
   * project needs no existing repo. On GitHub: `POST /orgs/{owner}/repos` with
   * `{ name, private, description, auto_init }`; returns the real `full_name`,
   * HTTPS clone url, and `default_branch`. Throws {@link RepositoryAlreadyExistsError}
   * on a taken name (422) and {@link RepositoryCreationForbiddenError} when the
   * credential lacks `administration: write` (403) — never leaking the token.
   */
  createRepository(input: CreateRepositoryInput, token: ResolvedVcsToken): Promise<CreatedRepository>;

  /** Push a branch to the repo over SSH using the resolved token as HTTPS auth. */
  pushBranch(input: PushBranchInput): Promise<void>;

  /** Open (or re-use) a draft pull request; idempotent on an open head/base. */
  openDraftPullRequest(input: OpenDraftPullRequestInput): Promise<OpenedPullRequest>;

  /**
   * P-APP-ENV-1: set (create/overwrite) one ACTIONS REPOSITORY SECRET on the
   * target repo. On GitHub: read the repo's Actions public key, encrypt `value`
   * with a libsodium sealed-box against that key, and PUT the encrypted value +
   * its `key_id`. The plaintext `value` NEVER leaves the encrypted payload — it
   * is never logged, returned, or emitted. Idempotent (create or replace).
   */
  setActionsSecret(input: SetActionsSecretInput): Promise<void>;

  /**
   * Open a tracking issue (title/body/labels) on the repo. The post-merge-failure
   * watcher calls this to file ONE tracking issue per merge when the post-merge CI
   * on `default_branch` fails. NOT idempotent at the forge — the caller owns
   * single-issue-per-merge idempotency (it never calls this twice for one merge).
   */
  createIssue(input: CreateIssueInput): Promise<CreatedIssue>;

  /** Mark a draft PR ready for review (genuinely un-draft it); idempotent. */
  markReadyForReview(pr: PullRequestRef, token: ResolvedVcsToken): Promise<void>;

  /**
   * Read the PR's CI/check status (check-runs + commit statuses + the
   * branch-protection required contexts) — the input to the CI-poll evaluator.
   */
  readPullRequestChecks(pr: PullRequestRef, token: ResolvedVcsToken): Promise<GitHubPullRequestChecks>;

  /**
   * P2d-2 (speculative batch-check): read the CI/check status of an arbitrary
   * BRANCH ref (not a PR) — the prospective merged state on an ephemeral
   * speculative-integration branch. Same check-runs + commit-status semantics as
   * `readPullRequestChecks`, keyed on the branch's HEAD SHA + gated by the branch's
   * own protection required contexts, so the batch-check reuses the EXACT CI-poll
   * evaluator (`evaluateCiObservation`). Provider-neutral: a GitLab impl maps it from
   * its own pipeline-for-ref read.
   */
  readBranchChecks(input: { repo: RepoRef; branch: string; token: ResolvedVcsToken }): Promise<GitHubPullRequestChecks>;

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

  /**
   * P2c-2 (change-percolation detect): read a branch's current HEAD SHA (or
   * `undefined` when the ref does not exist). The change-percolation detect
   * compares an ancestor branch's current head against the SHA the dependent
   * INTEGRATED against — a divergence is an upstream change to percolate. On
   * GitHub this reads `GET /git/ref/heads/{branch}`'s `object.sha`. Provider-
   * neutral: a GitLab impl maps it from its own ref read.
   */
  readBranchHeadSha(input: { repo: RepoRef; branch: string; token: ResolvedVcsToken }): Promise<string | undefined>;

  /**
   * P2a: read the PR branch's up-to-date / mergeability state relative to its
   * base — the signal the merge stage gates on (behind → update; dirty →
   * conflict resolver; clean → merge). On GitHub this reads the PR's
   * `mergeable` / `mergeable_state` fields + the base/head refs.
   */
  readMergeability(pr: PullRequestRef, token: ResolvedVcsToken): Promise<PullRequestMergeability>;

  /**
   * P2a: bring the PR branch up to date with its base (the server-side fast
   * path: GitHub `PUT /repos/{o}/{r}/pulls/{n}/update-branch`). Returns
   * `updated` when the branch was advanced (the caller must then re-poll CI to
   * green before merging), `up_to_date` when nothing was needed, and `conflict`
   * when GitHub reports the update cannot be performed because of a real merge
   * conflict (422) — the caller routes that to the conflict-resolution hook
   * rather than merging broken work. It NEVER merges and NEVER silently
   * swallows a conflict.
   */
  updateBranch(pr: PullRequestRef, token: ResolvedVcsToken): Promise<UpdateBranchResult>;

  /**
   * P2c (speculative execution): build (or reset + rebuild) the ephemeral
   * SPECULATIVE INTEGRATION BRANCH for a dependent — `baseBranch` + each unmerged
   * ancestor's branch merged in DAG order (server-side merges via the forge merge
   * API). It NEVER touches `default_branch`/`main`; it writes only the ephemeral
   * integration ref. When two ancestors conflict WITH EACH OTHER it returns
   * `conflict` (naming the pair) rather than forcing the conflict — the caller
   * routes that pair to the P2b resolver and rebuilds. The dependent's PR then
   * bases on this ref (the dynamic base). Idempotent: re-running resets the ref to
   * `baseBranch` first, so a stale integration is never additive.
   */
  buildIntegrationBranch(input: BuildIntegrationBranchInput): Promise<BuildIntegrationBranchResult>;

  /**
   * P2c (speculative execution — land-on-real-main): re-point an open PR's BASE
   * to a new branch (GitHub `PATCH /repos/{o}/{r}/pulls/{n}` with `{ base }`).
   * When a speculative dependent's ancestors all genuinely merge, the merge stage
   * re-targets the dependent's PR from its ephemeral integration ref to
   * `default_branch` BEFORE merging, so the dependent lands on real `main` (never
   * the integration ref). After the re-target the caller runs the P2a
   * up-to-date/auto-rebase + re-gate flow so the branch lands cleanly. Idempotent:
   * re-targeting to the branch the PR is already based on is a no-op on GitHub's
   * side (the PATCH returns the unchanged PR).
   */
  retargetPullRequestBase(pr: PullRequestRef, newBase: string, token: ResolvedVcsToken): Promise<void>;

  /**
   * P2c (speculative execution — cleanup): delete an ephemeral branch ref (the
   * `tanren/integ/<dep>` integration branch) after the dependent has merged. A
   * missing ref (already deleted) is treated as success — the cleanup is
   * best-effort and idempotent, never a hard failure that blocks the merge result.
   */
  deleteBranch(repo: RepoRef, branch: string, token: ResolvedVcsToken): Promise<void>;
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
