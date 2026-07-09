// Wave-1 GitHub impl of the MINIMAL `CodeHost` seam
// (`engine/contracts/codeHost.ts`, tanren-owns-the-engine.md §6). It HOSTS but
// NEVER DECIDES (no freshness/conflict/gate logic — that is `MergeAuthority` +
// `WorkspaceVcsCore`). It ADAPTS the existing GitHub pieces (`createGitHubRepository`,
// the `decodeBase64Content` contents decoder, the `git/refs` patterns proven in
// `githubRefReset.ts`) into the ~7-method host shape, composing the shared
// `GitHubHttpClient` (injected) so it runs hermetically under a fake transport.
//
// CRITICALLY: `landAuthorizedRef` is a COMPARE-AND-SWAP push of the
// already-authorized commit onto the default branch — read-then-conditional
// update, REJECTED LOUDLY on a CAS mismatch (someone advanced main underneath).
// It is NEVER a force-push and NEVER the host's "merge PR" API: Tanren already
// made the merge decision; the host merely lands what was authorized.
//
// Token: the CodeHost contract methods are token-free (a host swap must not leak
// GitHub credential shape into the engine). The plaintext token is supplied at
// construction via a `CodeHostTokenSupplier` (the caller mints an App
// installation token or reads the static secret, exactly as the VcsProvider
// does) and travels ONLY in the request auth header — never in a body, a log, or
// a thrown message.

import { decodeBase64Content } from "../contracts/repoHostErrors.js";
import { createGitHubRepository, deleteGitHubRepository } from "./githubRepoCreate.js";
import { githubRepoIsBareAutoInit } from "./githubRepoEmptiness.js";
import {
  GitHubStatusService,
  repoPath,
  withErrorDetail,
  type GitHubHttpClient,
  type GitHubPullRequestChecks,
} from "./github.js";
import { mainHeadCacheKey, sharedMainHeadCache, type MainHeadCache } from "./mainHeadCache.js";
// Re-export the pure repo-URL parser so a stage that already imports `GitHubCodeHost`
// (the merge/percolation reads) sources `RepoRef` parsing here too — one fewer dep there.
export { parseGitHubRepository } from "./github.js";
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
} from "../contracts/codeHost.js";

/** The plaintext push/read token + an optional one-shot 401 re-mint (mirrors `ResolvedVcsToken`). */
export interface CodeHostToken {
  token: string;
  /** Re-mint on a 401 (an installation token expired between mint and use). */
  refresh?: () => Promise<string>;
}

/** Resolves the active GitHub credential for a host call. Keeps the seam token-free. */
export type CodeHostTokenSupplier = () => Promise<CodeHostToken>;

/**
 * A LOUD compare-and-swap rejection: `intoMain` no longer points at
 * `expectedMainSha` (main advanced underneath the authorized land). Typed so the
 * `MergeAuthority`'s transactional land can RECONCILE on a mismatch rather than
 * treating it as a generic failure — and never a blind force-overwrite.
 */
export class LandCasRejectedError extends Error {
  constructor(
    readonly branch: string,
    readonly expectedSha: string,
    readonly actualSha: string | undefined,
  ) {
    super(`land rejected (stale compare-and-swap): ${branch} is ${actualSha ?? "absent"}, expected ${expectedSha}`);
    this.name = "LandCasRejectedError";
  }
}

function encodeRepoFilePath(path: string): string {
  return path
    .split("/")
    .map((piece) => encodeURIComponent(piece))
    .join("/");
}

/**
 * GitHub signals a rejected fast-forward-only ref update as a 422 whose body
 * message is "Update is not a fast forward". Belt-and-braces alongside the
 * `update.status === 422` check (a deviating gateway could carry the message at a
 * non-422 status); both routes land on the same typed CAS rejection.
 */
function isNonFastForward(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && /not a fast forward/iu.test(message);
}

/** Lift a `login` from a compare-commit `author`/`committer` user object (`""` if absent). */
function loginOf(user: unknown): string {
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    return "";
  }
  const login = (user as Record<string, unknown>)["login"];
  return typeof login === "string" ? login : "";
}

/** Lift `object.sha` from a `git/ref` / `git/refs` response body, or `undefined`. */
function refObjectSha(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const object = (body as { object?: { sha?: unknown } }).object;
  return object !== undefined && typeof object.sha === "string" ? object.sha : undefined;
}

/**
 * The GitHub implementation of {@link CodeHost}. Constructed with the shared
 * (timed) `GitHubHttpClient` + a token supplier; every method resolves the token
 * fresh so a long-lived host instance never holds a stale credential.
 */
export class GitHubCodeHost implements CodeHost {
  private readonly status: GitHubStatusService;
  /**
   * apex-v35 VOLUME guard: the SHARED short-TTL/single-flight cache for the default-branch
   * head read (`fetchRef`). Defaults to the process-shared instance so the batch /
   * percolation / post-merge readers in one process collapse their redundant `main`-head
   * reads; a fresh instance can be injected for test isolation. NOT consulted by the
   * `landAuthorizedRef` CAS read (that stays fresh); BUSTED whenever this host moves the ref.
   */
  private readonly mainHeadCache: MainHeadCache;

  constructor(
    private readonly http: GitHubHttpClient,
    private readonly resolveToken: CodeHostTokenSupplier,
    mainHeadCache: MainHeadCache = sharedMainHeadCache,
  ) {
    this.status = new GitHubStatusService(http);
    this.mainHeadCache = mainHeadCache;
  }

  async createRepo(input: CreateHostRepoInput): Promise<CreatedHostRepo> {
    const token = await this.resolveToken();
    // Reuse the proven greenfield create (422 ⇒ already-exists, 403 ⇒ forbidden, both typed).
    const created = await createGitHubRepository(
      this.http,
      {
        owner: input.owner,
        name: input.name,
        private: input.private,
        autoInit: input.autoInit,
        ...(input.description !== undefined && { description: input.description }),
      },
      { token: token.token, ...(token.refresh !== undefined && { refresh: token.refresh }) },
    );
    return {
      repo: { owner: input.owner, name: input.name },
      repoUrl: created.repoUrl,
      defaultBranch: created.defaultBranch,
    };
  }

  /** PROBE bare `auto_init` seed vs prior-history (greenfield re-attach guard, apex v84). */
  async isRepoBareAutoInit(repo: CodeHostRepoRef): Promise<boolean> {
    return githubRepoIsBareAutoInit(this.http, repo, await this.resolveToken(), (r, sha) => this.readCommit(r, sha));
  }

  /** DELETE a repo — derive-rollback compensation (task #78). See `deleteGitHubRepository`. */
  async deleteRepo(repo: CodeHostRepoRef): Promise<void> {
    const token = await this.resolveToken();
    await deleteGitHubRepository(
      this.http,
      { owner: repo.owner, name: repo.name },
      { token: token.token, ...(token.refresh !== undefined && { refresh: token.refresh }) },
    );
    this.mainHeadCache.invalidate(mainHeadCacheKey(repo.owner, repo.name, "main"));
  }

  async readDefaultBranch(repo: CodeHostRepoRef): Promise<string> {
    const token = await this.resolveToken();
    const response = await this.http.request({
      method: "GET",
      path: repoPath(repo, ""),
      token: token.token,
      ...(token.refresh !== undefined && { refreshToken: token.refresh }),
    });
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      throw new Error(`GitHub repo read failed for ${repo.owner}/${repo.name}: HTTP ${response.status}`);
    }
    const branch = (response.body as { default_branch?: unknown }).default_branch;
    if (typeof branch !== "string" || branch === "") {
      throw new TypeError(`GitHub repo read for ${repo.owner}/${repo.name} returned no default_branch`);
    }
    return branch;
  }

  /**
   * Push a FEATURE/INTEGRATION branch ref to its head sha via the git-refs API:
   * create (`POST /git/refs`), or update (`PATCH .../git/refs/heads/:b`) if the ref
   * already exists. A non-default branch is allowed to move freely (force-update).
   *
   * SAFETY: `pushRef` NEVER FORCE-updates the default branch. `main` is mutated by
   * exactly ONE path — `landAuthorizedRef` (read-checked + fast-forward-only) — so
   * a force-update of the default branch here would be a silent bypass of the merge
   * authority. When the target IS the default branch and already exists, we attempt
   * a FAST-FORWARD-ONLY (`force: false`) update; a non-fast-forward (which only a
   * force could push through) throws LOUDLY rather than clobbering main. We pay the
   * default-branch read only on the already-exists path.
   */
  async pushRef(input: { repo: CodeHostRepoRef; localRef: string; remoteBranch: string; sha: string }): Promise<void> {
    const token = await this.resolveToken();
    const refresh = token.refresh;
    const create = await this.http.request({
      method: "POST",
      path: repoPath(input.repo, "/git/refs"),
      token: token.token,
      ...(refresh !== undefined && { refreshToken: refresh }),
      body: { ref: `refs/heads/${input.remoteBranch}`, sha: input.sha },
    });
    if (create.status === 201) {
      this.mainHeadCache.invalidate(mainHeadCacheKey(input.repo.owner, input.repo.name, input.remoteBranch));
      return;
    }
    if (create.status !== 422) {
      throw new Error(`GitHub ref create for ${input.remoteBranch} failed: HTTP ${create.status}`);
    }
    // 422 ⇒ the ref already exists; update it. The DEFAULT branch is fast-forward-only
    // (never force-clobbered — main is advanced only by landAuthorizedRef); a feature
    // branch may force freely.
    const isDefaultBranch = input.remoteBranch === (await this.readDefaultBranch(input.repo));
    const update = await this.http.request({
      method: "PATCH",
      path: repoPath(input.repo, `/git/refs/heads/${encodeURIComponent(input.remoteBranch)}`),
      token: token.token,
      ...(refresh !== undefined && { refreshToken: refresh }),
      body: { sha: input.sha, force: !isDefaultBranch },
    });
    if (isDefaultBranch && (update.status === 422 || isNonFastForward(update.body))) {
      // A force WOULD have pushed this through; we refuse. Loud — a non-ff update of
      // the default branch must go through landAuthorizedRef, never pushRef.
      throw new Error(
        `pushRef refused to force-update the default branch ${input.remoteBranch}: a non-fast-forward of main must go through landAuthorizedRef`,
      );
    }
    if (update.status !== 200) {
      throw new Error(`GitHub ref update for ${input.remoteBranch} failed: HTTP ${update.status}`);
    }
    this.mainHeadCache.invalidate(mainHeadCacheKey(input.repo.owner, input.repo.name, input.remoteBranch));
  }

  async fetchRef(input: { repo: CodeHostRepoRef; remoteBranch: string }): Promise<string | undefined> {
    // apex-v35 VOLUME guard: collapse the redundant `main`-head reads (batch/percolation/
    // post-merge each re-read it every cycle) behind the short-TTL single-flight cache. A
    // throw (403/transient) is NOT cached and propagates; a merge to this branch busts it.
    const key = mainHeadCacheKey(input.repo.owner, input.repo.name, input.remoteBranch);
    return this.mainHeadCache.read(key, () => this.readBranchSha(input.repo, input.remoteBranch));
  }

  async readCommit(repo: CodeHostRepoRef, sha: string): Promise<HostCommit> {
    const token = await this.resolveToken();
    const response = await this.http.request({
      method: "GET",
      path: repoPath(repo, `/git/commits/${encodeURIComponent(sha)}`),
      token: token.token,
      ...(token.refresh !== undefined && { refreshToken: token.refresh }),
    });
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      throw new Error(`GitHub commit read failed for ${sha}: HTTP ${response.status}`);
    }
    const body = response.body as {
      sha?: unknown;
      message?: unknown;
      tree?: { sha?: unknown };
      parents?: unknown;
    };
    const treeSha = body.tree?.sha;
    if (typeof body.sha !== "string" || typeof body.message !== "string" || typeof treeSha !== "string") {
      throw new TypeError(`GitHub commit read for ${sha} returned a malformed commit`);
    }
    const parents = Array.isArray(body.parents)
      ? body.parents.flatMap((p) =>
          typeof (p as { sha?: unknown }).sha === "string" ? [(p as { sha: string }).sha] : [],
        )
      : [];
    return { sha: body.sha, message: body.message, treeSha, parents };
  }

  /**
   * Read the unified diff between two refs/shas via `GET /compare/:base...:head`
   * (JSON, page-bounded), rendering each file's `patch` so it flows through the
   * shared JSON HTTP client unchanged (no raw-diff media type). Mirrors the PR
   * files-diff render so a reviewer Answerer reads an identical shape.
   */
  async readDiff(repo: CodeHostRepoRef, baseSha: string, headSha: string): Promise<string> {
    const token = await this.resolveToken();
    const response = await this.http.request({
      method: "GET",
      path: repoPath(repo, `/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`),
      token: token.token,
      ...(token.refresh !== undefined && { refreshToken: token.refresh }),
    });
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      throw new Error(`GitHub compare ${baseSha}...${headSha} failed: HTTP ${response.status}`);
    }
    const files = (response.body as { files?: unknown }).files;
    if (!Array.isArray(files)) {
      return "";
    }
    const sections: string[] = [];
    for (const entry of files) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        continue;
      }
      const object = entry as Record<string, unknown>;
      const filename = typeof object["filename"] === "string" ? object["filename"] : "(unknown)";
      const patch = typeof object["patch"] === "string" ? object["patch"] : undefined;
      sections.push(patch === undefined ? `diff --git ${filename}` : `diff --git ${filename}\n${patch}`);
    }
    return sections.join("\n");
  }

  /**
   * Compare two shas via `GET /compare/:base...:head` and map GitHub's `status`
   * (`identical`/`ahead`/`behind`/`diverged`) onto {@link RefAncestry}. This is GitHub
   * computing pure commit-graph ANCESTRY (NOT `mergeable_state` / a 3-way merge) — the
   * freshness primitive the merge path derives `clean`/`behind` from (decomposition
   * PR-7 / §5h). An unrecognized status is the most-uncertain `diverged` (a rebase is
   * required; never silently read as up-to-date).
   */
  async compareRefs(repo: CodeHostRepoRef, baseSha: string, headSha: string): Promise<RefAncestry> {
    const status = (await this.readCompare(repo, baseSha, headSha)).status;
    switch (status) {
      case "identical":
        return "identical";
      case "ahead":
        return "ahead";
      case "behind":
        return "behind";
      default:
        // `diverged` and any unrecognized/missing status: the head is NOT a fast-forward
        // of the base → a rebase is required (fail-closed toward "not fresh").
        return "diverged";
    }
  }

  /**
   * Read the distinct author + committer logins over `baseSha..headSha` via the SAME
   * `GET /compare` endpoint (decomposition PR-7 / §5g): the host-neutral, sha-addressed
   * commit-author read for the governance external-change gate, replacing the
   * forge-PR-shaped `listContributors`.
   */
  async readCommitAuthors(repo: CodeHostRepoRef, baseSha: string, headSha: string): Promise<CommitAuthors> {
    const commits = (await this.readCompare(repo, baseSha, headSha)).commits;
    const logins: string[] = [];
    for (const commit of commits) {
      if (typeof commit !== "object" || commit === null || Array.isArray(commit)) {
        continue;
      }
      const record = commit as Record<string, unknown>;
      logins.push(loginOf(record["author"]), loginOf(record["committer"]));
    }
    return { logins };
  }

  /** Read the raw `/compare/:base...:head` body once (status + commits), JSON-shaped. */
  private async readCompare(
    repo: CodeHostRepoRef,
    baseSha: string,
    headSha: string,
  ): Promise<{ status: string; commits: ReadonlyArray<unknown> }> {
    const token = await this.resolveToken();
    const response = await this.http.request({
      method: "GET",
      path: repoPath(repo, `/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`),
      token: token.token,
      ...(token.refresh !== undefined && { refreshToken: token.refresh }),
    });
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      throw new Error(`GitHub compare ${baseSha}...${headSha} failed: HTTP ${response.status}`);
    }
    const body = response.body as { status?: unknown; commits?: unknown };
    return {
      status: typeof body.status === "string" ? body.status : "",
      commits: Array.isArray(body.commits) ? body.commits : [],
    };
  }

  async readFile(input: { repo: CodeHostRepoRef; ref: string; path: string }): Promise<string | undefined> {
    const token = await this.resolveToken();
    const response = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/contents/${encodeRepoFilePath(input.path)}?ref=${encodeURIComponent(input.ref)}`),
      token: token.token,
      ...(token.refresh !== undefined && { refreshToken: token.refresh }),
    });
    if (response.status === 404) {
      return undefined;
    }
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      throw new Error(`GitHub contents fetch failed: HTTP ${response.status}`);
    }
    const body = response.body as { content?: unknown; encoding?: unknown };
    if (typeof body.content !== "string") {
      return undefined;
    }
    return body.encoding === "base64" ? decodeBase64Content(body.content) : body.content;
  }

  /**
   * Read the CI/check status of a BRANCH ref (decomposition §5e) — the post-merge
   * watcher's host CI read on the default branch. Delegates to the SAME
   * `GitHubStatusService.fetchBranchChecks` the run/queue CI poll uses (the branch's
   * HEAD SHA + its protection required contexts), so `evaluateCiObservation` reads an
   * identical shape. The host HOSTS — this is an external CI read, not Tanren's gate.
   */
  async readBranchChecks(input: { repo: CodeHostRepoRef; branch: string }): Promise<GitHubPullRequestChecks> {
    const token = await this.resolveToken();
    return this.status.fetchBranchChecks({
      repo: input.repo,
      branch: input.branch,
      token: token.token,
      ...(token.refresh !== undefined && { refreshToken: token.refresh }),
    });
  }

  /**
   * LAND an authorized ref into `main` as a COMPARE-AND-SWAP advance of the
   * default branch. GitHub's ref-update API offers NO native compare-and-swap
   * (no `If-Match` on the head sha), so the CAS is built from a read-check PLUS a
   * FAST-FORWARD-ONLY write, and the write is what actually closes the race:
   *
   *   (a) read `intoMain`'s current head; if it is not `expectedMainSha` (or the
   *       ref is absent) → throw {@link LandCasRejectedError} (fail-closed, cheap
   *       early-out; this alone is NOT the guard — main can still move after it);
   *   (b) PATCH `/git/refs/heads/:intoMain` with `{ sha: authorizedSha, force:
   *       false }`. `authorizedSha` was BUILT ON `expectedMainSha`, so it is a
   *       fast-forward of `intoMain` ONLY while main still points at
   *       `expectedMainSha`. If main moved off it between (a) and (b), the
   *       ff-only update is REJECTED by GitHub (422 "Update is not a fast
   *       forward"). The ff-only WRITE — not the read — is the atomic guard;
   *   (c) treat ANY 422 / non-fast-forward on that PATCH as the AUTHORITATIVE CAS
   *       rejection → throw {@link LandCasRejectedError}. NEVER retry, NEVER set
   *       `force: true` (that would clobber the racing commit). The transactional
   *       land reconciles on the typed rejection.
   *
   * NEVER a force-push; NEVER the host's "merge PR" API (Tanren already authorized
   * the commit). The land target is `authorizedSha` exactly — no host merge commit.
   */
  async landAuthorizedRef(input: LandAuthorizedRefInput): Promise<LandResult> {
    const token = await this.resolveToken();
    const refresh = token.refresh;

    // (a) Read-check: a cheap fail-closed early-out. NOT the race guard — main can
    // still advance between this read and the write below; the ff-only write closes
    // that window.
    const current = await this.readBranchSha(input.repo, input.intoMain);
    if (current !== input.expectedMainSha) {
      throw new LandCasRejectedError(input.intoMain, input.expectedMainSha, current);
    }

    // (b) Fast-forward-only advance. This is the ATOMIC CAS guard: GitHub accepts it
    // ONLY if `authorizedSha` is still a fast-forward of `intoMain` — i.e. main has
    // not moved off `expectedMainSha` since (a).
    const update = await this.http.request({
      method: "PATCH",
      path: repoPath(input.repo, `/git/refs/heads/${encodeURIComponent(input.intoMain)}`),
      token: token.token,
      ...(refresh !== undefined && { refreshToken: refresh }),
      body: { sha: input.authorizedSha, force: false },
    });
    // (c) A 422 / non-fast-forward is the AUTHORITATIVE CAS rejection (main raced
    // ahead). Surfaced typed; never retried, never forced.
    if (update.status === 422 || isNonFastForward(update.body)) {
      throw new LandCasRejectedError(input.intoMain, input.expectedMainSha, current);
    }
    if (update.status !== 200) {
      throw new Error(`GitHub land of ${input.authorizedSha} onto ${input.intoMain} failed: HTTP ${update.status}`);
    }
    const landedSha = refObjectSha(update.body) ?? input.authorizedSha;
    // The default-branch head MOVED — bust the cached head so the next batch/post-merge
    // read sees the new base immediately (never a stale-base merge decision).
    this.mainHeadCache.invalidate(mainHeadCacheKey(input.repo.owner, input.repo.name, input.intoMain));
    return { mainSha: landedSha };
  }

  /** Read a branch ref's current head sha, or `undefined` for a 404 (absent ref). */
  private async readBranchSha(repo: CodeHostRepoRef, branch: string): Promise<string | undefined> {
    const token = await this.resolveToken();
    const response = await this.http.request({
      method: "GET",
      path: repoPath(repo, `/git/ref/heads/${encodeURIComponent(branch)}`),
      token: token.token,
      ...(token.refresh !== undefined && { refreshToken: token.refresh }),
    });
    if (response.status === 404) {
      return undefined;
    }
    if (response.status !== 200) {
      throw new Error(withErrorDetail(`GitHub ref read for ${branch} failed: HTTP ${response.status}`, response));
    }
    return refObjectSha(response.body);
  }
}
