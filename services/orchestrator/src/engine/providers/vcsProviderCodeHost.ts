// A `CodeHost` (tanren-owns-the-engine.md §1, §6) READ-seam adapter backed by the
// EXISTING `VcsProvider` rather than a bare `GitHubHttpClient`. WHY this exists
// alongside `GitHubCodeHost`: the live engine read call-sites that reason over forge
// read semantics (e.g. the percolation ancestor head-sha read) already hold a
// `VcsProvider` + a resolved token — NOT the raw http client. This adapter lets such
// a site route its READ through the `CodeHost` seam (so the engine reasons over the
// host-neutral contract, not GitHub-shaped provider calls) WITHOUT threading a second
// http client / credential plumbing through the percolation/autonomy chain. It reuses
// the provider's `readBranchHeadSha` / `readFileOnBranch` — byte-identical to today.
//
// SCOPE (this slice = READS + the best-effort UI mirror; the LAND write is DEFERRED
// to S1 where it composes with MergeAuthority): the WRITE/LAND/repo-create/commit/diff
// methods are NOT part of this read-seam adapter — they FAIL LOUDLY (never a silent
// no-op), mirroring the codebase's `UnconfiguredVcsProvider` fail-loud discipline.
// The full sha-addressed read set + the CAS land live on the real `GitHubCodeHost`
// (driven by `codeHostConformance`); this adapter backs only what the `VcsProvider`
// genuinely exposes today.

import type {
  CodeHost,
  CodeHostRepoRef,
  CreateHostRepoInput,
  CreatedHostRepo,
  HostCommit,
  LandAuthorizedRefInput,
  LandResult,
} from "../contracts/codeHost.js";
import type { ResolvedVcsToken, VcsProvider } from "../contracts/vcsProvider.js";

/**
 * A `CodeHost` whose READ + ref-fetch methods are served by an existing
 * {@link VcsProvider}. Constructed at a call site that already resolved its token;
 * the supplier is invoked per call so a long-lived instance never holds a stale
 * credential. The methods this slice does not own (create/push/land/commit/diff)
 * throw — the read-seam adapter does not silently stand in for them.
 */
export class VcsProviderCodeHost implements CodeHost {
  constructor(
    private readonly provider: VcsProvider,
    private readonly resolveToken: () => Promise<ResolvedVcsToken>,
  ) {}

  /** Fetch a remote branch ref's head sha (or `undefined`) — the provider's `readBranchHeadSha`. */
  async fetchRef(input: { repo: CodeHostRepoRef; remoteBranch: string }): Promise<string | undefined> {
    const token = await this.resolveToken();
    return this.provider.readBranchHeadSha({ repo: input.repo, branch: input.remoteBranch, token });
  }

  /** Read a file's content on a ref (or `undefined`) — the provider's `readFileOnBranch`. */
  async readFile(input: { repo: CodeHostRepoRef; ref: string; path: string }): Promise<string | undefined> {
    const token = await this.resolveToken();
    return this.provider.readFileOnBranch({ repo: input.repo, ref: input.ref, path: input.path, token });
  }

  // --- Methods outside this read-seam adapter (deferred / served by GitHubCodeHost). ---

  async createRepo(_input: CreateHostRepoInput): Promise<CreatedHostRepo> {
    return this.unsupported("createRepo");
  }

  async readDefaultBranch(_repo: CodeHostRepoRef): Promise<string> {
    return this.unsupported("readDefaultBranch");
  }

  async pushRef(_input: { repo: CodeHostRepoRef; localRef: string; remoteBranch: string; sha: string }): Promise<void> {
    return this.unsupported("pushRef");
  }

  async readCommit(_repo: CodeHostRepoRef, _sha: string): Promise<HostCommit> {
    return this.unsupported("readCommit");
  }

  async readDiff(_repo: CodeHostRepoRef, _baseSha: string, _headSha: string): Promise<string> {
    return this.unsupported("readDiff");
  }

  async landAuthorizedRef(_input: LandAuthorizedRefInput): Promise<LandResult> {
    return this.unsupported("landAuthorizedRef");
  }

  private unsupported(method: string): never {
    throw new Error(
      `VcsProviderCodeHost is a READ-seam adapter; '${method}' is served by GitHubCodeHost (the land write is deferred to S1). ` +
        "Construct a GitHubCodeHost (providers/hostFactory.ts) for the full host surface.",
    );
  }
}
