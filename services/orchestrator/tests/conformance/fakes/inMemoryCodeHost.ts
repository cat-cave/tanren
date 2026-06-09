// A TRIVIAL in-memory reference fake of `CodeHost`
// (`engine/contracts/codeHost.ts`) — ONLY to make the `codeHostConformance` suite
// self-runnable in Wave 0. It models JUST the ref/commit/land behaviors the
// contract pins (push/fetch round-trip; compare-and-swap land advances main;
// readDefaultBranch). The Wave-1 GitHub impl drives the SAME suite. Fixtures live
// HERE, never src/.

import type {
  CodeHost,
  CodeHostRepoRef,
  CreateHostRepoInput,
  CreatedHostRepo,
  HostCommit,
  LandAuthorizedRefInput,
  LandResult,
} from "../../../src/engine/contracts/codeHost.js";
import { LandCasRejectedError } from "../../../src/engine/providers/githubCodeHost.js";

interface RepoState {
  defaultBranch: string;
  /** branch -> head sha */
  branches: Map<string, string>;
  commits: Map<string, HostCommit>;
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
    });
  }

  async createRepo(input: CreateHostRepoInput): Promise<CreatedHostRepo> {
    const repo: CodeHostRepoRef = { owner: input.owner, name: input.name };
    const defaultBranch = "main";
    const initialSha = input.autoInit ? `sha-init-${input.name}` : "sha-empty";
    this.seed(repo, defaultBranch, initialSha);
    return { repo, repoUrl: `https://example.com/${key(repo)}.git`, defaultBranch };
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
