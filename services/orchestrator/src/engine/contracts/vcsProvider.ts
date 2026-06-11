// The `VcsProvider` seam (autonomy-engine.md §1.1, §2, §2d, §5): the residual
// provider-agnostic surface over the few forge operations the run + merge
// lifecycle still performs directly (GitHub now; GitLab/others later). The GitHub
// impl (`engine/providers/githubVcsProvider.ts`) COMPOSES the GitHub services +
// the token resolver behind the seam (token-via-stdin clone auth, the 401-refresh
// retry, the timed HTTP wrapper).
//
// DECOMPOSITION (the VcsProvider→CodeHost decomposition design doc): the
// merge-coordination grain has been migrated onto the minimal `CodeHost` (code reads
// + ref fetch + CAS land + repo-create) and the best-effort `VisibilityProjection`
// (PR/check/comment mirror). PR-3..7 moved every importer onto those seams; PR-8
// removed the now-dead methods (merge / publish-check / mergeability / update-branch
// / draft-PR open / file & head-sha reads / etc.). What remains here are the residual
// non-forge primitives (credential + identity resolution, URL parsing) plus the two
// genuine-fork reads still on the provider pending their §5e/§5f re-home
// (`readBranchChecks` post-merge host CI read, `readReviewVerdict` external-approval
// read). The interface + impls + factory + conformance are deleted in PR-9.

// Errors + base64 decode + the ActorIdentity type live in `./vcsProviderErrors.js`
// (line cap); re-exported so callers import them from the contract module unchanged.
export {
  decodeBase64Content,
  RepositoryAlreadyExistsError,
  RepositoryCreationForbiddenError,
} from "./vcsProviderErrors.js";
export type { ActorIdentity } from "./vcsProviderErrors.js";
// Track B (no-Actions doctrine): the native status PUBLICATION payloads live in
// `./vcsProviderPublish.js` (line cap); re-exported so the live `VisibilityProjection`
// status publisher imports them here.
export type { PublishStatusInput, StatusState } from "./vcsProviderPublish.js";
import type { ActorIdentity } from "./vcsProviderErrors.js";
import type { SecretStore } from "./secretStore.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { GitHubPullRequestChecks, GitHubRepository } from "../providers/github.js";
import type { ReviewVerdictResult } from "../providers/githubReviewMerge.js";

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

/**
 * The residual VcsProvider contract: the non-forge primitives (credential +
 * identity resolution, URL parsing) plus the two genuine-fork forge reads still on
 * the provider pending their re-home (post-merge host CI read, external-approval
 * review read). Each forge read takes a pre-`resolveToken`'d {@link ResolvedVcsToken}
 * so a stage resolves once and performs many operations.
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
   * §5e (DECOMPOSITION fork, pending re-home): read the CI/check status of an
   * arbitrary BRANCH ref (not a PR) — the post-merge watcher reads the host's
   * `default_branch` CI (which, for the built app's repo, may legitimately be
   * GitHub Actions) to decide whether to file a tracking issue. Keyed on the
   * branch's HEAD SHA + its own protection required contexts, reusing the EXACT
   * CI-poll evaluator (`evaluateCiObservation`). A GitLab impl maps it from its
   * pipeline-for-ref read. PR-9 either re-homes this to a `CodeHost` read or
   * re-points the watcher at Tanren's own post-merge gate.
   */
  readBranchChecks(input: { repo: RepoRef; branch: string; token: ResolvedVcsToken }): Promise<GitHubPullRequestChecks>;

  /**
   * §5f (DECOMPOSITION fork, pending re-home): read the PR's reviews, reduced to a
   * single actionable verdict — the EXTERNAL approval read the live review-poll
   * control flow still consults. The doctrine downgrades this to an advisory
   * best-effort projection read once Tanren's internal review record becomes the
   * gate; PR-9 (or its follow-up) makes that flip. Until then it stays on the
   * provider (no behavior change), per §5f's two-step guidance.
   */
  readReviewVerdict(pr: PullRequestRef, token: ResolvedVcsToken): Promise<ReviewVerdictResult>;
}
