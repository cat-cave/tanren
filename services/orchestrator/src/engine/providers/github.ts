import {
  parseBranchProtected,
  parseCheckRuns,
  parseCommitStatuses,
  parseNoClassicRequiredStatusChecks,
  parseRefObjectSha,
  parseRequiredCheckAppIds,
  parseRequiredContexts,
  parseRulesWithoutRequiredStatusChecks,
} from "./githubChecksParse.js";
import { parseBaseBranch, parsePullRequestHead, repoPath } from "./github/parse.js";
// Re-export the `/contents` base64 decoder (it lives in the contract module) so the
// GitHub provider sources every GitHub value-helper from `github.js` — one fewer dep there.
export { decodeBase64Content } from "../contracts/repoHostErrors.js";
// Re-export the shared App installation-token minter so the worker boot pulls the GitHub
// HTTP client + the minter from one provider module (the dependency-cap-friendly seam the
// retired `buildVcsProvider.js` convenience re-export used to provide).
export { GithubAppTokenMinter } from "./githubAppTokenMinter.js";
import { appendErrorDetail } from "./githubRetry.js";
import {
  DEFAULT_GITHUB_API_ENDPOINT,
  GitHubProtectionProofCache,
  githubProtectionProofCacheKey,
  type GitHubProtectionProofContext,
} from "./githubProtectionProofCache.js";

export {
  asPullArray,
  githubHttpsRemote,
  parseGitHubPullRequestUrl,
  parseGitHubRepository,
  parsePullRequest,
  repoPath,
} from "./github/parse.js";
export { FetchGitHubHttpClient, type FetchGitHubHttpClientOptions } from "./github/httpClient.js";

export interface GitHubRepository {
  owner: string;
  name: string;
}

export interface GitHubPullRequest {
  number: number;
  url: string;
  draft: boolean;
  baseBranch?: string;
}

export interface GitHubPullRequestHead {
  sha: string;
  ref?: string;
}

export interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion?: string;
  /** GitHub App installation id that authored this check, when supplied. */
  appId?: number;
  url?: string;
}

export interface GitHubCommitStatus {
  context: string;
  state: string;
  url?: string;
}

export interface GitHubPullRequestChecks {
  head: GitHubPullRequestHead;
  checkRuns: GitHubCheckRun[];
  statuses: GitHubCommitStatus[];
  /**
   * required-check awareness: the branch-protection required status
   * check contexts for the PR's base branch, or `undefined` only when the
   * documented branch DTO positively reports `protected: false`.
   * Ambiguous/unreadable protection evidence throws before a snapshot exists.
   * A run only passes when every required context is green; an authoritative
   * `undefined` preserves the all-observed fallback.
   */
  requiredContexts?: string[];
  /** Optional exact GitHub App identity for protected contexts. */
  requiredCheckAppIds?: Record<string, number>;
}

export interface EnsureDraftPullRequestInput {
  repo: GitHubRepository;
  token: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
  /** re-mint token + retry once on a 401. */
  refreshToken?: () => Promise<string>;
}

export interface EnsureDraftPullRequestResult extends GitHubPullRequest {
  reused: boolean;
}

export interface GitHubHttpRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  token: string;
  body?: unknown;
  /**
   * optional token-supplier. When provided and the request returns
   * 401 (e.g. an installation token expired/was revoked between mint and use),
   * the client re-mints once via `refreshToken()` and retries the request a
   * single time with the fresh token. Static-token callers omit this.
   */
  refreshToken?: () => Promise<string>;
  /**
   * GitHub-5xx resilience: when `false`, the client does NOT auto-retry a
   * transient gateway failure (502/503/504/408 or a transport error) for THIS
   * request — it surfaces the raw transient response/throw to the caller. The
   * default (omitted ⇒ retry) is safe for idempotent ops (GET / ref-reset /
   * PATCH / PUT-branch). A NON-idempotent write whose retry could double-apply
   * server-side (the `PUT /pulls/{n}/merge` — a 504 may have merged) sets this
   * `false` and re-checks the resource state itself instead. The 401 re-mint and
   * 403/429 rate-limit retries are unaffected (they re-send a request that did
   * not change state).
   */
  retryTransient?: boolean;
  /** Surface classified 403/429 to a durable caller without sleeping/retrying. */
  retryRateLimit?: boolean;
}

export interface GitHubHttpResponse {
  status: number;
  body: unknown;
  /**
   * rate-limit signal lifted from the response: a `Retry-After` (seconds), an exhausted
   * primary window (`X-RateLimit-Remaining: 0` + `X-RateLimit-Reset`), or a secondary/abuse
   * body (the bounded secondary default).
   */
  retryAfterMs?: number;
  /** Bounded in-request wait; durable callers use the exact `retryAfterMs`. */
  retryBackoffMs?: number;
  /**
   * Enriched non-2xx detail (the GitHub `message` + rate-limit headers) so a thrown `HTTP
   * <status>` carries WHY (the apex-v35 raw-`HTTP 403` diagnosis gap). `undefined` on a 2xx.
   */
  errorDetail?: string;
}

/** Append a response's enriched detail to a caller's `HTTP <status>` error string. */
export function withErrorDetail(base: string, response: GitHubHttpResponse): string {
  return appendErrorDetail(base, response.errorDetail);
}

export interface GitHubHttpClient {
  /** Stable API endpoint identity used to prevent cross-endpoint proof reuse. */
  readonly endpointIdentity?: string;
  request(input: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}

// `GitHubPullRequestService` (find / reuse / rebase the one PR per spec head) lives in
// `githubPullRequestReuse.ts` to keep this module under its 500-line cap. It is NOT
// re-exported here: that would form an import cycle (the reuse module already imports the
// shared helpers/types from this file), so importers pull the service from
// `./githubPullRequestReuse.js` directly.

export interface GitHubStatusServiceOptions {
  /** Fresh cache seam for tests or a separately scoped host. */
  protectionProofCache?: GitHubProtectionProofCache;
  /** Explicit endpoint identity when the transport does not expose one. */
  endpointIdentity?: string;
}

type GitHubStatusInput = {
  repo: GitHubRepository;
  token: string;
  refreshToken?: () => Promise<string>;
} & GitHubProtectionProofContext;
type GitHubPullRequestChecksInput = GitHubStatusInput & { pullNumber: number };
type GitHubBranchChecksInput = GitHubStatusInput & { branch: string };
type GitHubShaChecksInput = GitHubStatusInput & { sha: string; protectedBranch: string };
type GitHubRequiredContextsInput = GitHubStatusInput & { baseBranch: string };

export class GitHubStatusService {
  private readonly protectionProofCache: GitHubProtectionProofCache;
  private readonly endpointIdentity: string;

  constructor(
    private readonly http: GitHubHttpClient,
    options: GitHubStatusServiceOptions = {},
  ) {
    this.protectionProofCache = options.protectionProofCache ?? new GitHubProtectionProofCache();
    this.endpointIdentity = options.endpointIdentity ?? http.endpointIdentity ?? DEFAULT_GITHUB_API_ENDPOINT;
  }

  async fetchPullRequestChecks(input: GitHubPullRequestChecksInput): Promise<GitHubPullRequestChecks> {
    const pull = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (pull.status !== 200) {
      throw new Error(withErrorDetail(`GitHub PR fetch failed: HTTP ${pull.status}`, pull));
    }
    const head = parsePullRequestHead(pull.body);
    const baseBranch = parseBaseBranch((pull.body as Record<string, unknown> | undefined)?.["base"]);
    if (baseBranch === undefined || baseBranch === "") {
      throw new TypeError("GitHub PR response missing base branch");
    }

    return this.fetchChecksForSha({
      repo: input.repo,
      token: input.token,
      sha: head.sha,
      protectedBranch: baseBranch,
      ...(input.authorizationIdentity !== undefined && { authorizationIdentity: input.authorizationIdentity }),
      ...(input.endpointIdentity !== undefined && { endpointIdentity: input.endpointIdentity }),
      ...(input.refreshToken !== undefined && { refreshToken: input.refreshToken }),
    });
  }

  /**
   * autonomy-engine.md §2d — speculative batch-check: read the CI/check
   * status of an arbitrary BRANCH ref (not a PR) — used to batch-check the prospective
   * merged state on the ephemeral speculative-integration branch. Resolves the
   * branch's HEAD SHA, then reads the SAME check-runs + commit-status endpoints
   * `fetchPullRequestChecks` does, gated by the branch's own protection required
   * contexts. Surfaced host-neutrally via `CodeHost.readBranchChecks` (decomposition §5e).
   */
  async fetchBranchChecks(input: GitHubBranchChecksInput): Promise<GitHubPullRequestChecks> {
    const refResponse = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/git/ref/heads/${encodeURIComponent(input.branch)}`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (refResponse.status !== 200) {
      throw new Error(
        withErrorDetail(`GitHub branch ref fetch failed for ${input.branch}: HTTP ${refResponse.status}`, refResponse),
      );
    }
    const sha = parseRefObjectSha(refResponse.body);
    if (sha === undefined) {
      throw new Error(`GitHub branch ref ${input.branch} had no object SHA`);
    }
    return this.fetchChecksForSha({
      repo: input.repo,
      token: input.token,
      sha,
      protectedBranch: input.branch,
      ...(input.authorizationIdentity !== undefined && { authorizationIdentity: input.authorizationIdentity }),
      ...(input.endpointIdentity !== undefined && { endpointIdentity: input.endpointIdentity }),
      ...(input.refreshToken !== undefined && { refreshToken: input.refreshToken }),
    });
  }

  /**
   * Read the check-runs + commit statuses for a commit SHA (the shared core of the
   * PR-keyed and branch-keyed check reads), gated by `protectedBranch`'s required
   * contexts when supplied. Kept private so both callers parse checks identically.
   */
  private async fetchChecksForSha(input: GitHubShaChecksInput): Promise<GitHubPullRequestChecks> {
    const [checkRuns, statuses] = await Promise.all([
      this.http.request({
        method: "GET",
        path: repoPath(input.repo, `/commits/${encodeURIComponent(input.sha)}/check-runs`),
        token: input.token,
        refreshToken: input.refreshToken,
      }),
      this.http.request({
        method: "GET",
        path: repoPath(input.repo, `/commits/${encodeURIComponent(input.sha)}/status`),
        token: input.token,
        refreshToken: input.refreshToken,
      }),
    ]);
    if (checkRuns.status !== 200) {
      throw new Error(`GitHub check-runs fetch failed: HTTP ${checkRuns.status}`);
    }
    if (statuses.status !== 200) {
      throw new Error(`GitHub commit status fetch failed: HTTP ${statuses.status}`);
    }

    const requiredCheckMetadata = await this.fetchRequiredCheckMetadata({
      repo: input.repo,
      token: input.token,
      baseBranch: input.protectedBranch,
      ...(input.authorizationIdentity !== undefined && { authorizationIdentity: input.authorizationIdentity }),
      ...(input.endpointIdentity !== undefined && { endpointIdentity: input.endpointIdentity }),
      ...(input.refreshToken !== undefined && { refreshToken: input.refreshToken }),
    });

    return {
      head: { sha: input.sha },
      checkRuns: parseCheckRuns(checkRuns.body),
      statuses: parseCommitStatuses(statuses.body),
      requiredContexts: requiredCheckMetadata?.contexts,
      requiredCheckAppIds: requiredCheckMetadata?.appIds,
    };
  }

  /**
   * read the branch-protection required status check contexts for a base
   * branch. The abbreviated required-status-checks endpoint's documented 404 is
   * only "Resource not found"; it can also mean missing Administration:read, a
   * deleted branch, or a race. `undefined` is returned ONLY after separate
   * authoritative proof that the branch is unprotected (its documented
   * `protected` boolean is exactly false); callers then fall back to
   * all-observed-green. A protected branch may legitimately have reviews,
   * restrictions, or rulesets but no classic status checks — that is accepted
   * (as `[]`) only after the full protection and branch-rules documents prove
   * it. Every ambiguous, malformed, or unreadable result THROWS loudly (a 403
   * returned as `undefined` would DISABLE required-check gating; a persistent
   * 5xx survived the transient retry).
   */
  async fetchRequiredContexts(input: GitHubRequiredContextsInput): Promise<string[] | undefined> {
    const proof = await this.fetchRequiredCheckMetadata(input);
    return proof?.contexts;
  }

  private async fetchRequiredCheckMetadata(
    input: GitHubRequiredContextsInput,
  ): Promise<{ contexts: string[] | undefined; appIds: Record<string, number> } | undefined> {
    const key = githubProtectionProofCacheKey({
      owner: input.repo.owner,
      name: input.repo.name,
      baseBranch: input.baseBranch,
      token: input.token,
      authorizationIdentity: input.authorizationIdentity,
      endpointIdentity: input.endpointIdentity ?? this.endpointIdentity,
    });
    return this.protectionProofCache.read(key, () => this.fetchRequiredCheckMetadataUncached(input));
  }

  private async fetchRequiredCheckMetadataUncached(
    input: GitHubRequiredContextsInput,
  ): Promise<{ contexts: string[] | undefined; appIds: Record<string, number> } | undefined> {
    const response = await this.readRequiredStatusChecks(input);
    if (response.status === 200) {
      return { contexts: parseRequiredContexts(response.body), appIds: parseRequiredCheckAppIds(response.body) };
    }
    const contexts = await this.resolveRequiredContextsAfterProtection404(input);
    if (contexts === undefined) return undefined;
    return { contexts, appIds: {} };
  }

  /** Read the abbreviated required-status-checks endpoint; only 200 or 404 are non-errors. */
  private async readRequiredStatusChecks(input: GitHubRequiredContextsInput): Promise<GitHubHttpResponse> {
    const response = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/branches/${encodeURIComponent(input.baseBranch)}/protection/required_status_checks`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (response.status !== 200 && response.status !== 404) {
      throw new Error(
        withErrorDetail(
          `GitHub branch-protection read failed for ${input.baseBranch}: HTTP ${response.status}`,
          response,
        ),
      );
    }
    return response;
  }

  /**
   * The abbreviated required-status-checks endpoint 404'd. Separately read the
   * branch DTO and return `undefined` ONLY when its documented `protected`
   * boolean is exactly false. A protected branch's status-check subresource can
   * legitimately 404 when protection is review/restriction/ruleset-only, so a
   * `protected: true` result is only accepted as an empty requirement after the
   * full protection and branch-rules documents prove no unrepresented rule.
   */
  private async resolveRequiredContextsAfterProtection404(
    input: GitHubRequiredContextsInput,
  ): Promise<string[] | undefined> {
    const branch = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/branches/${encodeURIComponent(input.baseBranch)}`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (branch.status !== 200) {
      throw new Error(
        withErrorDetail(
          `GitHub branch-protection read for ${input.baseBranch} was ambiguous: required-status-checks HTTP 404; branch proof HTTP ${branch.status}`,
          branch,
        ),
      );
    }
    if (parseBranchProtected(branch.body, input.baseBranch)) {
      return this.proveNoRequiredStatusChecksAfter404(input);
    }
    return undefined;
  }

  /**
   * A protected branch's abbreviated status-check endpoint can be absent simply
   * because its protection is review/restriction/ruleset-only. Read both
   * authoritative documents and return an explicit empty requirement only when
   * neither carries an unrepresented required-status rule.
   */
  private async proveNoRequiredStatusChecksAfter404(input: GitHubRequiredContextsInput): Promise<string[]> {
    const protection = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/branches/${encodeURIComponent(input.baseBranch)}/protection`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (protection.status !== 200 && protection.status !== 404) {
      throw new Error(
        withErrorDetail(
          `GitHub full branch-protection read failed for ${input.baseBranch}: HTTP ${protection.status}`,
          protection,
        ),
      );
    }
    const hasRulesetProof = await this.proveRulesWithoutRequiredStatusChecks(input);
    if (protection.status === 200) {
      parseNoClassicRequiredStatusChecks(protection.body);
      return [];
    }
    if (hasRulesetProof) {
      return [];
    }
    throw new Error(
      `GitHub branch-protection read for ${input.baseBranch} was ambiguous: required-status-checks HTTP 404; no full protection or ruleset proof`,
    );
  }

  /**
   * GitHub paginates branch rules. An empty first page (or a short final page)
   * is the only proof of exhaustion: stopping after page one could overlook a
   * later required-status or workflow rule and falsely publish an empty gate.
   */
  private async proveRulesWithoutRequiredStatusChecks(input: GitHubRequiredContextsInput): Promise<boolean> {
    const pageSize = 100;
    let page = 1;
    let hasRulesetProof = false;
    const seenPages = new Set<string>();
    for (;;) {
      const rules = await this.http.request({
        method: "GET",
        path: repoPath(
          input.repo,
          `/rules/branches/${encodeURIComponent(input.baseBranch)}?per_page=${pageSize}&page=${page}`,
        ),
        token: input.token,
        refreshToken: input.refreshToken,
      });
      if (rules.status !== 200) {
        throw new Error(
          withErrorDetail(`GitHub branch rules read failed for ${input.baseBranch}: HTTP ${rules.status}`, rules),
        );
      }
      const pageHasRules = parseRulesWithoutRequiredStatusChecks(rules.body);
      hasRulesetProof ||= pageHasRules;
      const rows = rules.body as unknown[];
      const pageFingerprint = JSON.stringify(rows);
      if (seenPages.has(pageFingerprint)) {
        throw new Error(`GitHub branch rules pagination made no progress for ${input.baseBranch}`);
      }
      seenPages.add(pageFingerprint);
      if (rows.length < pageSize) return hasRulesetProof;
      page += 1;
    }
  }
}
