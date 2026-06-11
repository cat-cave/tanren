// The `VcsProvider` seam (autonomy-engine.md §1.1, §2, §2d, §5): the
// provider-agnostic surface over the VCS operations the run + merge lifecycle
// performs against a forge (GitHub now; GitLab/others later). The GitHub impl
// (`engine/providers/githubVcsProvider.ts`) COMPOSES the GitHub services
// (`GitHubPullRequestService`/`GitHubStatusService`/`GitHubReviewMergeService`) +
// the token resolver + the SSH push: token-via-stdin clone auth, the GraphQL
// ready mutation, the 401-refresh retry, the timed HTTP wrapper, and the merge
// dispatch all live behind this one contract.
//
// The surface covers the full merge-coordination grain: auto-rebase
// (`readMergeability`/`updateBranch`) and conflict-resolution hooks. It is the VCS provider, NOT the
// merge QUEUE (§1.1): the native merge queue sits ABOVE it. `publishCheck` /
// `publishStatus` let Tanren PUBLISH its own native gate verdict to the forge so
// the PR UI shows it (the merge decision is already made by the native gate).

// Errors + base64 decode + the ActorIdentity type live in `./vcsProviderErrors.js`
// (line cap); re-exported so callers import them from the contract module unchanged.
export {
  decodeBase64Content,
  RepositoryAlreadyExistsError,
  RepositoryCreationForbiddenError,
} from "./vcsProviderErrors.js";
export type { ActorIdentity } from "./vcsProviderErrors.js";
// Track B (no-Actions doctrine): the native check/status PUBLICATION payloads live
// in `./vcsProviderPublish.js` (line cap); re-exported so callers import them here.
export type {
  CheckAnnotation,
  CheckConclusion,
  PublishCheckInput,
  PublishedCheck,
  PublishStatusInput,
  StatusState,
} from "./vcsProviderPublish.js";
import type { ActorIdentity } from "./vcsProviderErrors.js";
import type { PublishCheckInput, PublishedCheck, PublishStatusInput } from "./vcsProviderPublish.js";
import type { RunnerHandle } from "./allocator.js";
import type { SecretStore } from "./secretStore.js";
import type { CommandSubstrate } from "./commandSubstrate.js";
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
 * the up-to-date / mergeability state of a PR branch relative to its base,
 * read in provider-neutral terms. The merge stage uses this BEFORE merging to
 * decide whether a rebase/update is needed (`behind`), a genuine conflict the
 * resolver must handle (`dirty`), or it is current and safe to merge (`clean`).
 * Derived from GitHub's PR `mergeable_state` + the head/base comparison (a GitLab
 * impl maps its own divergence signal). `baseBranch`/`headBranch` are surfaced so
 * the rebase + events name the refs without a second read.
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
 * one ancestor in an integration node's prospective merged state — its branch
 * ref + the spec it implements (so the coordinator can route an A-vs-B conflict to the
 * intent-preserving resolver with the right intent). DAG order is the order the
 * coordinator passes these in (ancestors before dependents).
 */
export interface IntegrationAncestor {
  specId: string;
  branch: string;
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
  /**
   * MERGE-SAFETY (self-identity): resolve the {@link ActorIdentity} for THIS
   * credential, populated at resolve time (App context in scope), mirroring
   * `refresh()`. `VcsProvider.resolveActorIdentity(token)` invokes it. Absent only
   * on a token built outside the provider's resolver (never on the push path).
   */
  identity?: () => Promise<ActorIdentity>;
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
  ssh: CommandSubstrate;
  target: RunnerHandle;
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

export interface PullRequestState {
  confirmed: boolean;
  merged: boolean;
  open: boolean;
  mergeSha?: string;
}

/**
 * The VcsProvider contract: every VCS/CI operation the run + merge lifecycle
 * performs directly against the forge, behind a provider-neutral seam. Each
 * operation takes a pre-`resolveToken`'d {@link ResolvedVcsToken} so a stage
 * resolves once and performs many operations (unchanged from today's probes).
 * Each method's own doc names the existing call site it extracts (resolveToken ←
 * `githubTokenResolver.resolveGithubToken`, pushBranch ← `githubPush.*`, etc.).
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

  /**
   * MERGE-SAFETY (self-identity): resolve the {@link ActorIdentity} for the given
   * (already-resolved) token — the run's git author + the merge stage's identity
   * set both derive from it. GitHub: static → `GET /user`; App → `<app-slug>[bot]`.
   * A failure is a LOUD throw (no `.invalid`/`<unknown>` fallback).
   */
  resolveActorIdentity(token: ResolvedVcsToken): Promise<ActorIdentity>;

  /** Parse a repository clone URL into the neutral {@link RepoRef}. */
  parseRepository(repoUrl: string): RepoRef;

  /** Parse a pull-request URL into its {@link PullRequestRef}. */
  parsePullRequest(prUrl: string): PullRequestRef;

  /**
   * Read the forge-authoritative PR terminal state. Used by autonomous recovery
   * paths before correcting local queue/read-model state; an unconfirmed read is
   * not proof and must not be used to mutate durable state.
   */
  readPullRequestState(pr: PullRequestRef, token: ResolvedVcsToken): Promise<PullRequestState>;

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
   * Track B (no-Actions doctrine): publish a Tanren-NATIVE check-run for `headSha`
   * (GitHub `POST .../check-runs`, a `completed` run carrying the `conclusion` +
   * title/summary + optional inline annotations) — how Tanren's own gate verdict
   * reaches the forge instead of only READING Actions' check-runs. ADDITIVE:
   * nothing gates on it yet (the shadow-check/cutover step wires it); token never logged.
   */
  publishCheck(input: PublishCheckInput): Promise<PublishedCheck>;

  /**
   * Track B (no-Actions doctrine): publish a Tanren-NATIVE commit STATUS for
   * `headSha` (GitHub `POST .../statuses/{sha}`) — the lower-friction signal (no
   * `checks:write` scope) the `github_checks` channel already proves. ADDITIVE:
   * nothing gates on it yet; token never logged.
   */
  publishStatus(input: PublishStatusInput): Promise<void>;

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
   * speculative batch-check: read the CI/check status of an arbitrary
   * BRANCH ref (not a PR) — the prospective merged state on an ephemeral
   * speculative-integration branch. Same check-runs + commit-status semantics as
   * `readPullRequestChecks`, keyed on the branch's HEAD SHA + its own protection
   * required contexts, so the batch-check reuses the EXACT CI-poll evaluator
   * (`evaluateCiObservation`). A GitLab impl maps it from its pipeline-for-ref read.
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
   * does not exist on that ref. Conflict resolution and speculative
   * integration read base-branch state through this.
   */
  readFileOnBranch(input: {
    repo: RepoRef;
    ref: string;
    path: string;
    token: ResolvedVcsToken;
  }): Promise<string | undefined>;

  /**
   * change-percolation detect: read a branch's current HEAD SHA (or
   * `undefined` when the ref does not exist). The change-percolation detect
   * compares an ancestor branch's current head against the SHA the dependent
   * INTEGRATED against — a divergence is an upstream change to percolate. On
   * GitHub this reads `GET /git/ref/heads/{branch}`'s `object.sha`. Provider-
   * neutral: a GitLab impl maps it from its own ref read.
   */
  readBranchHeadSha(input: { repo: RepoRef; branch: string; token: ResolvedVcsToken }): Promise<string | undefined>;

  /**
   * read the PR branch's up-to-date / mergeability state relative to its
   * base — the signal the merge stage gates on (behind → update; dirty →
   * conflict resolver; clean → merge). On GitHub this reads the PR's
   * `mergeable` / `mergeable_state` fields + the base/head refs.
   */
  readMergeability(pr: PullRequestRef, token: ResolvedVcsToken): Promise<PullRequestMergeability>;

  /**
   * bring the PR branch up to date with its base (the server-side fast path:
   * GitHub `PUT .../pulls/{n}/update-branch`). Returns `updated` when the branch
   * was advanced (the caller then re-polls CI to green before merging), `up_to_date`
   * when nothing was needed, and `conflict` when GitHub reports a real merge
   * conflict (422) — routed to the conflict-resolution hook rather than merging
   * broken work. It NEVER merges and NEVER silently swallows a conflict.
   */
  updateBranch(pr: PullRequestRef, token: ResolvedVcsToken): Promise<UpdateBranchResult>;

  /**
   * speculative execution — land-on-real-main: re-point an open PR's BASE to
   * a new branch (GitHub `PATCH .../pulls/{n}` with `{ base }`). When a speculative
   * dependent's ancestors all genuinely merge, the merge stage re-targets the PR
   * from its ephemeral integration ref to `default_branch` BEFORE merging, so it
   * lands on real `main`; the caller then runs the up-to-date/re-gate flow.
   * Idempotent: re-targeting to the current base is a no-op (PATCH returns the PR).
   */
  retargetPullRequestBase(pr: PullRequestRef, newBase: string, token: ResolvedVcsToken): Promise<void>;

  /**
   * speculative execution — cleanup: delete an ephemeral branch ref (the
   * `tanren/integ/<dep>` integration branch) after the dependent has merged. A
   * missing ref (already deleted) is treated as success — the cleanup is
   * best-effort and idempotent, never a hard failure that blocks the merge result.
   */
  deleteBranch(repo: RepoRef, branch: string, token: ResolvedVcsToken): Promise<void>;
}
