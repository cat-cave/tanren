// A TRIVIAL in-memory reference fake of `CodeHost`
// (`engine/contracts/codeHost.ts`) — ONLY to make the `codeHostConformance` suite
// self-runnable in Wave 0. It models JUST the ref/commit/land behaviors the
// contract pins (push/fetch round-trip; compare-and-swap land advances main;
// readDefaultBranch). The Wave-1 GitHub impl drives the SAME suite. Fixtures live
// HERE, never src/.

import type {
  CodeHost,
  CodeHostRepoRef,
  CommitAuthors,
  CreateHostRepoInput,
  CreatedHostRepo,
  HostCommit,
  LandAuthorizedRefInput,
  LandResult,
  RefAncestry,
} from "../../../src/engine/contracts/codeHost.js";
import { LandCasRejectedError } from "../../../src/engine/providers/githubCodeHost.js";

interface RepoState {
  defaultBranch: string;
  /** branch -> head sha */
  branches: Map<string, string>;
  commits: Map<string, HostCommit>;
  /** sha -> the author/committer login attributed to that commit (for readCommitAuthors). */
  authors: Map<string, string>;
}

function key(repo: CodeHostRepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export class InMemoryCodeHost implements CodeHost {
  private readonly repos = new Map<string, RepoState>();

  /** Seed a repo with a default branch at an initial sha (test setup helper). */
  seed(repo: CodeHostRepoRef, defaultBranch: string, initialSha: string): void {
    this.repos.set(key(repo), {
      defaultBranch,
      branches: new Map([[defaultBranch, initialSha]]),
      commits: new Map([
        [initialSha, { sha: initialSha, parents: [], message: "init", treeSha: `tree-${initialSha}` }],
      ]),
      authors: new Map(),
    });
  }

  /** Seed a commit with explicit parents + an attributed author login (test setup helper). */
  seedCommit(repo: CodeHostRepoRef, sha: string, parents: ReadonlyArray<string>, author = "tanren[bot]"): void {
    const st = this.require(repo);
    st.commits.set(sha, { sha, parents: [...parents], message: `commit ${sha}`, treeSha: `tree-${sha}` });
    st.authors.set(sha, author);
  }

  async createRepo(input: CreateHostRepoInput): Promise<CreatedHostRepo> {
    const repo: CodeHostRepoRef = { owner: input.owner, name: input.name };
    const defaultBranch = "main";
    const initialSha = input.autoInit ? `sha-init-${input.name}` : "sha-empty";
    this.seed(repo, defaultBranch, initialSha);
    return { repo, repoUrl: `https://example.com/${key(repo)}.git`, defaultBranch };
  }

  /** Has the test fixture seen this repo (used by tests to assert post-rollback state). */
  has(repo: CodeHostRepoRef): boolean {
    return this.repos.has(key(repo));
  }

  async deleteRepo(repo: CodeHostRepoRef): Promise<void> {
    // IDEMPOTENT: a repo that no longer exists is a successful no-op (mirrors the
    // GitHub impl's 404-treated-as-success contract). The compensation walker
    // relies on this to safely retry rollbacks.
    this.repos.delete(key(repo));
  }

  async readDefaultBranch(repo: CodeHostRepoRef): Promise<string> {
    return this.require(repo).defaultBranch;
  }

  async pushRef(input: { repo: CodeHostRepoRef; localRef: string; remoteBranch: string; sha: string }): Promise<void> {
    const st = this.require(input.repo);
    st.branches.set(input.remoteBranch, input.sha);
    if (!st.commits.has(input.sha)) {
      st.commits.set(input.sha, { sha: input.sha, parents: [], message: input.localRef, treeSha: `tree-${input.sha}` });
    }
  }

  async fetchRef(input: { repo: CodeHostRepoRef; remoteBranch: string }): Promise<string | undefined> {
    return this.require(input.repo).branches.get(input.remoteBranch);
  }

  async readCommit(repo: CodeHostRepoRef, sha: string): Promise<HostCommit> {
    const c = this.require(repo).commits.get(sha);
    if (c === undefined) throw new Error(`no such commit ${sha}`);
    return c;
  }

  async readDiff(_repo: CodeHostRepoRef, baseSha: string, headSha: string): Promise<string> {
    return `diff ${baseSha}..${headSha}`;
  }

  /**
   * Pure commit-graph ANCESTRY over the seeded parent edges (the SAME relation GitHub's
   * `/compare` `status` reports — NOT a 3-way merge): identical ⇒ same sha; ahead ⇒ the
   * head reaches the base (the base is an ancestor of the head); behind ⇒ the base reaches
   * the head; else diverged.
   */
  async compareRefs(repo: CodeHostRepoRef, baseSha: string, headSha: string): Promise<RefAncestry> {
    if (baseSha === headSha) return "identical";
    const st = this.require(repo);
    const headReachesBase = this.reaches(st, headSha, baseSha);
    const baseReachesHead = this.reaches(st, baseSha, headSha);
    if (headReachesBase) return "ahead";
    if (baseReachesHead) return "behind";
    return "diverged";
  }

  async readCommitAuthors(repo: CodeHostRepoRef, baseSha: string, headSha: string): Promise<CommitAuthors> {
    const st = this.require(repo);
    // The range is the commits reachable from head but NOT from base (base-exclusive),
    // mirroring `/compare/:base...:head` `commits`.
    const logins: string[] = [];
    const seen = new Set<string>();
    const stack = [headSha];
    while (stack.length > 0) {
      const sha = stack.pop();
      if (sha === undefined || sha === baseSha || seen.has(sha)) continue;
      seen.add(sha);
      const author = st.authors.get(sha);
      if (author !== undefined) logins.push(author);
      const commit = st.commits.get(sha);
      if (commit !== undefined) stack.push(...commit.parents);
    }
    return { logins };
  }

  /** Does `fromSha` reach `targetSha` by walking parent edges (bounded by the seeded graph)? */
  private reaches(st: RepoState, fromSha: string, targetSha: string): boolean {
    const seen = new Set<string>();
    const stack = [fromSha];
    while (stack.length > 0) {
      const sha = stack.pop();
      if (sha === undefined || seen.has(sha)) continue;
      if (sha === targetSha) return true;
      seen.add(sha);
      const commit = st.commits.get(sha);
      if (commit !== undefined) stack.push(...commit.parents);
    }
    return false;
  }

  async readFile(input: { repo: CodeHostRepoRef; ref: string; path: string }): Promise<string | undefined> {
    this.require(input.repo);
    return `content of ${input.path} @ ${input.ref}`;
  }

  async landAuthorizedRef(input: LandAuthorizedRefInput): Promise<LandResult> {
    const st = this.require(input.repo);
    const current = st.branches.get(input.intoMain);
    // Compare-and-swap: REJECT if main moved underneath (never blind-overwrite). Throws
    // the SAME typed {@link LandCasRejectedError} the GitHub impl does, so the merge
    // authority's TYPED CAS classification (`instanceof`, §3.2) is exercised here too.
    if (current !== input.expectedMainSha) {
      throw new LandCasRejectedError(input.intoMain, input.expectedMainSha, current);
    }
    st.branches.set(input.intoMain, input.authorizedSha);
    return { mainSha: input.authorizedSha };
  }

  private require(repo: CodeHostRepoRef): RepoState {
    const st = this.repos.get(key(repo));
    if (st === undefined) throw new Error(`unknown repo ${key(repo)}`);
    return st;
  }
}
