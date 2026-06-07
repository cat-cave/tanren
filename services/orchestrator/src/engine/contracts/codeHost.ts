// The `CodeHost` seam (tanren-owns-the-engine.md §1, §6) — the MINIMAL hosting half
// of the GitHub-shaped `VcsProvider` decomposition (~5-7 host-bound methods, down
// from 25). GitHub becomes "a code source, maybe an OAuth surface, maybe an issue
// source — fundamentally NOT the engine."
//
// WHY this seam (the audit it addresses): §6 + §7. The 25-method `VcsProvider`
// embedded forge SEMANTICS into engine control flow — `mergeable_state`/
// `update-branch` decided freshness, the GitHub PR-merge endpoint WAS the merge
// authority, review state drove control flow. The refactor SEVERS that: `CodeHost`
// may HOST but must NEVER DECIDE freshness/conflict/gate (the §7 guardrail).
// CRITICALLY, since Tanren is now the merge authority, `landAuthorizedRef` is a
// PLAIN PUSH-TO-`main` of the already-authorized commit — NOT the host's "merge PR"
// API. The host just LANDS WHAT TANREN AUTHORIZED. This is the concept that makes
// the host swappable: GitHub/GitLab/Bitbucket/self-host differ only in CodeHost
// mechanics. A Wave-1 GitHub impl is validated against `codeHostConformance`.

/** A repository on the host, provider-neutral (`owner` + `name`). */
export interface CodeHostRepoRef {
  owner: string;
  name: string;
}

/** Input to creating a brand-new repository on the host. */
export interface CreateHostRepoInput {
  owner: string;
  name: string;
  private: boolean;
  description?: string;
  /** Seed an initial commit so the repo is immediately cloneable + has a default branch. */
  autoInit: boolean;
}

/** The just-created repository (provider-neutral). No credential ever appears here. */
export interface CreatedHostRepo {
  repo: CodeHostRepoRef;
  /** The HTTPS clone url the project row binds to. */
  repoUrl: string;
  defaultBranch: string;
}

/** A commit read from the host, reduced to what the engine reasons over. */
export interface HostCommit {
  sha: string;
  parents: ReadonlyArray<string>;
  message: string;
  treeSha: string;
}

/** Input to landing an AUTHORIZED ref into `main` — a plain push, not a merge API. */
export interface LandAuthorizedRefInput {
  repo: CodeHostRepoRef;
  /** The default branch to advance (e.g. `main`). */
  intoMain: string;
  /** The authorized, conflict-free commit sha to land (exported by WorkspaceVcsCore). */
  authorizedSha: string;
  /**
   * The sha `intoMain` is EXPECTED to currently point at — a compare-and-swap guard
   * so the land is REJECTED if main advanced underneath (never a blind force-push).
   * The MergeAuthority's transactional land reconciles on a mismatch.
   */
  expectedMainSha: string;
}

/** The result of a land: the new `main` sha after the authorized ref advanced it. */
export interface LandResult {
  mainSha: string;
}

/**
 * The `CodeHost` contract — the minimal, host-bound surface. It HOSTS; it never
 * DECIDES (no freshness/conflict/gate logic lives here — that is `MergeAuthority` +
 * `WorkspaceVcsCore`). Refs are git refs; commits are read-only. A future GitLab /
 * Bitbucket / self-host impl satisfies the SAME contract.
 */
export interface CodeHost {
  /** Create a brand-new repository (greenfield) on the host. */
  createRepo(input: CreateHostRepoInput): Promise<CreatedHostRepo>;

  /** Read the repo's default branch name (e.g. `main`). */
  readDefaultBranch(repo: CodeHostRepoRef): Promise<string>;

  /** Push a local ref to the host (a branch ref — NOT a land into main). */
  pushRef(input: { repo: CodeHostRepoRef; localRef: string; remoteBranch: string; sha: string }): Promise<void>;

  /** Fetch a remote branch ref's current head sha (or `undefined` if absent). */
  fetchRef(input: { repo: CodeHostRepoRef; remoteBranch: string }): Promise<string | undefined>;

  /** Read a commit by sha (parents/message/tree) — read-only. */
  readCommit(repo: CodeHostRepoRef, sha: string): Promise<HostCommit>;

  /** Read the unified diff between two refs/shas (the reviewer Answerer judges this). */
  readDiff(repo: CodeHostRepoRef, baseSha: string, headSha: string): Promise<string>;

  /** Read a file's UTF-8 content on `ref`, or `undefined` if it does not exist there. */
  readFile(input: { repo: CodeHostRepoRef; ref: string; path: string }): Promise<string | undefined>;

  /**
   * LAND an authorized ref into `main`: a compare-and-swap PUSH of the authorized
   * commit onto `intoMain` (advance the default branch ref from `expectedMainSha`
   * to `authorizedSha`). This is NOT the host's "merge PR" API — Tanren already
   * made the merge decision (`MergeAuthority.authorizeLand`); the host merely lands
   * what was authorized. REJECTS (does not blind-overwrite) if `intoMain` no longer
   * points at `expectedMainSha`, so the transactional land can reconcile.
   */
  landAuthorizedRef(input: LandAuthorizedRefInput): Promise<LandResult>;
}
