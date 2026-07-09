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

import type { GitHubPullRequestChecks } from "../providers/github.js";

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

/**
 * The ANCESTRY relation of a head ref to a base ref — a pure commit-graph fact
 * (NOT a 3-way merge / `mergeable_state`):
 *   - `identical` — the two shas are the same commit.
 *   - `ahead`     — the head CONTAINS the base (the base is an ancestor of the head);
 *                   the head is up-to-date with / ahead of the base.
 *   - `behind`    — the base CONTAINS the head (the base advanced past the head); the
 *                   head needs a rebase onto the advanced base.
 *   - `diverged`  — neither contains the other (both have commits the other lacks);
 *                   a rebase is required (a CONFLICT, if any, is surfaced by the rebase
 *                   itself — never computed here; the host HOSTS, it never DECIDES).
 * This is the FRESHNESS primitive the merge path derives `clean`/`behind` from after
 * the `mergeable_state` coupling was severed (decomposition PR-7 / §5h): the host
 * computes ancestry, the jj rebase owns conflict.
 */
export type RefAncestry = "identical" | "ahead" | "behind" | "diverged";

/** Distinct author + committer logins observed over a sha range (host-neutral). */
export interface CommitAuthors {
  /** Lower-cased distinct logins across the range's commit authors + committers. */
  logins: ReadonlyArray<string>;
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

  /**
   * PROBE whether a repository is at the BARE `auto_init` state — a single "Initial
   * commit" whose tree carries nothing beyond a README — vs already carrying history
   * (any additional commit, or a `tanren compose:` commit, or a non-trivial tree). The
   * greenfield derive uses this before RE-ATTACHING to a repo that already exists (a
   * `RepositoryAlreadyExistsError` on create): a re-attach is legitimate ONLY for a
   * stranded, empty auto_init repo left by a crashed prior attempt; a repo already full
   * of a PRIOR run's compose history must NOT be silently reused (it causes a cross-run
   * base divergence that later fails PR-prep). The host HOSTS — this reads the commit
   * graph, it never DECIDES. A future GitLab/Bitbucket impl maps it from its own
   * commit-list read.
   */
  isRepoBareAutoInit(repo: CodeHostRepoRef): Promise<boolean>;

  /**
   * DELETE a repository on the host (task #78 — derive atomic rollback). The
   * COMPENSATION primitive every host MUST expose: the greenfield derive registers
   * a rollback for each newly-created repo so a partial-create failure later in the
   * derive walks back every external resource it produced. IDEMPOTENT — a repo
   * that no longer exists (404) is a successful no-op (the rollback semantic is
   * "ensure this is gone", not "delete an existing one"); other failures (403,
   * 5xx) propagate LOUD. A future GitLab/Bitbucket impl maps it from its own delete
   * endpoint. NEVER called from the regular run path — repo deletion is irreversible
   * and is ONLY the derive's rollback compensation.
   */
  deleteRepo(repo: CodeHostRepoRef): Promise<void>;

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

  /**
   * Compare two refs/shas and return their ANCESTRY relation — the FRESHNESS
   * primitive the merge path derives `clean`/`behind` from (decomposition PR-7 / §5h).
   * It computes pure commit-graph ancestry (does the head contain the base, or has the
   * base advanced past it?), NEVER a 3-way merge: the host HOSTS, it never DECIDES
   * conflict (the jj rebase owns that). A future GitLab/Bitbucket impl maps it from its
   * own compare semantics.
   */
  compareRefs(repo: CodeHostRepoRef, baseSha: string, headSha: string): Promise<RefAncestry>;

  /**
   * Read the distinct author + committer logins over a sha RANGE (`baseSha..headSha`)
   * — the host-neutral, sha-addressed commit-author read the governance external-change
   * gate uses (decomposition PR-7 / §5g), replacing the forge-PR-shaped `listContributors`.
   * Same `/compare` read `readDiff` uses; a future backend maps it from its own range read.
   */
  readCommitAuthors(repo: CodeHostRepoRef, baseSha: string, headSha: string): Promise<CommitAuthors>;

  /** Read a file's UTF-8 content on `ref`, or `undefined` if it does not exist there. */
  readFile(input: { repo: CodeHostRepoRef; ref: string; path: string }): Promise<string | undefined>;

  /**
   * Read the CI/check status of an arbitrary BRANCH ref (not a PR) — the post-merge
   * watcher reads the host's `default_branch` CI (which, for the built app's repo, may
   * legitimately be GitHub Actions) to decide whether to file a tracking issue
   * (decomposition §5e). Keyed on the branch's HEAD SHA + its own protection required
   * contexts, feeding the SAME `evaluateCiObservation` evaluator the run/queue CI poll
   * uses. This is a genuine HOST read of an EXTERNAL CI signal (a regression the built
   * app's own CI catches) — NOT Tanren's gate, which the `MergeAuthority` owns. A future
   * backend maps it from its own pipeline-for-ref read.
   */
  readBranchChecks(input: { repo: CodeHostRepoRef; branch: string }): Promise<GitHubPullRequestChecks>;

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
