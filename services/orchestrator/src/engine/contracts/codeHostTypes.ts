// Neutral run/merge SHAPES — the provider-neutral payloads the run + merge
// lifecycle reasons over (repo/PR refs, greenfield repo-create, freshness, the
// per-credential token + context). They outlived the `VcsProvider` interface
// (deleted in the VcsProvider→CodeHost decomposition, PR-9): the host seam itself
// is `CodeHost` (`codeHost.ts`) + `VisibilityProjection` (`visibilityProjection.ts`),
// but these durable value shapes — and the credential plumbing types the standalone
// `credentials/vcsCredentials.ts` resolver returns — needed a contract home of their
// own. The GitHub mappings live in the providers (`github.ts` parses a URL into a
// `RepoRef`; `githubCodeHost.ts` maps `CreateRepositoryInput`).

// Errors + base64 decode + the ActorIdentity type live in `./repoHostErrors.js`
// (line cap); re-exported so callers import them from one contract module unchanged.
export {
  decodeBase64Content,
  GreenfieldRepoNotEmptyError,
  RepositoryAlreadyExistsError,
  RepositoryCreationForbiddenError,
} from "./repoHostErrors.js";
export type { ActorIdentity } from "./repoHostErrors.js";
// Track B (no-Actions doctrine): the native status PUBLICATION payloads live in
// `./statusPublish.js` (line cap); re-exported so the live `VisibilityProjection`
// status publisher imports them here.
export type { PublishStatusInput, StatusState } from "./statusPublish.js";
import type { ActorIdentity } from "./repoHostErrors.js";
import type { SecretStore } from "./secretStore.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { GitHubRepository } from "../providers/github.js";

// ---- Neutral identity / payload shapes ------------------------------------

/**
 * A repository on the VCS, identified the provider-neutral way: `owner` +
 * `name`. The GitHub impl maps this 1:1 onto `GitHubRepository`. A future
 * GitLab impl maps it onto namespace/project. The repo `url` callers already
 * carry is parsed into this by `parseGitHubRepository` (`providers/github.ts`).
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
  /** Durable derivation identity stored atomically with repo creation for response-loss reconciliation. */
  ownershipMarker?: string;
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
 * Derived from the head/base `compareRefs` ancestry (PR-7 severed `mergeable_state`).
 * `baseBranch`/`headBranch` are surfaced so the rebase + events name the refs
 * without a second read.
 */
export interface PullRequestMergeability {
  /**
   * `clean`   — up to date with base + mergeable: proceed to merge.
   * `behind`  — out of date with base (no conflict): update/rebase then re-gate.
   * `dirty`   — a real merge conflict with base: route to the conflict resolver.
   * `blocked` — mergeability is gated by something other than freshness (e.g.
   *             failing required checks / pending review) — NOT a freshness issue.
   * `unknown` — the host has not computed mergeability yet (transient); the caller
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
 * The per-repo credential context the standalone resolver
 * (`credentials/vcsCredentials.ts:resolveVcsToken`) resolves a usable access token
 * from. It carries exactly what the run already knows: the secret store, the org App
 * installation (when the org installed the App — the preferred path), and/or a static
 * credential ref (a project/org GitHub credential). The resolver owns the policy
 * (App-first, static fallback, hard-throw when neither is configured) — this is the
 * "clone-auth / credential resolution for a repo" operation in provider-neutral terms.
 */
export interface VcsCredentialContext {
  secrets: SecretStore;
  /** Authenticated organization that owns every credential coordinate. */
  orgId: string;
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
 * performs (one resolve, many ops), so a stage never re-mints a token per op.
 */
export interface ResolvedVcsToken {
  token: string;
  source: "github_app" | "static";
  /** Re-mint / re-read the token (the 401-refresh retry path). */
  refresh(): Promise<string>;
  /**
   * MERGE-SAFETY (self-identity): resolve the {@link ActorIdentity} for THIS
   * credential, populated at resolve time (App context in scope), mirroring
   * `refresh()`. `resolveVcsActorIdentity(token)` invokes it. Absent only on a token
   * built outside the standalone resolver (never on the push path).
   */
  identity?: () => Promise<ActorIdentity>;
}
