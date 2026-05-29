import type { OrgGithubAppInstallation } from "../../config/orgConfig.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import {
  FetchGitHubHttpClient,
  parseGitHubPullRequestUrl,
  type GitHubHttpClient,
  type GitHubRepository,
} from "../../providers/github.js";
import { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { resolveGithubToken, type ResolvedGithubToken } from "../../credentials/githubTokenResolver.js";
import type { NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";

// P3-0024 GitHub Checks channel — third wired channel.
//
// Target shape:
//   - `destination` is the PR URL the notification should annotate
//     (`https://github.com/owner/repo/pull/42`). The channel resolves the PR's
//     head SHA and posts a *commit status* to it (the lowest-friction signal
//     that renders in the PR "checks" UI; it works under both an App
//     installation token and a static fallback token without the extra
//     `checks:write` permission a full check-run requires).
//
// Auth (P3-0003): the channel NEVER reads a static token directly. It calls
// `resolveGithubToken({ secrets, installation })`, which mints an auto-rotating
// App installation token when the org has installed the App, and falls back to
// the static ref otherwise. The resolver also hands back a `refresh()` supplier
// which we thread into `FetchGitHubHttpClient` so a token that expired between
// mint and use is re-minted once on a 401 and the request retried.

export interface GithubChecksChannelDeps {
  // Secret store the resolver reads the App private key (or static token) from.
  secrets: SecretStore;
  // The org's GitHub App installation block, when installed. When present the
  // resolver mints an auto-rotating installation token (preferred). When
  // omitted the resolver uses the static fallback ref.
  installation?: OrgGithubAppInstallation;
  // Shared App-token minter (its cache lives here). Created per-call if omitted.
  minter?: GithubAppTokenMinter;
  // HTTP client used to talk to the GitHub REST API. Injected so tests can
  // assert request shape without a real network. Defaults to the fetch client.
  http?: GitHubHttpClient;
  // Static fallback credential ref (when no App is installed). Optional; the
  // resolver has its own env/default fallback.
  staticRef?: string;
}

const STATUS_CONTEXT = "tanren";

// GitHub commit-status `state` is one of error/failure/pending/success.
const STATE_BY_SEVERITY: Record<NotificationPayload["severity"], string> = {
  ok: "success",
  info: "success",
  warn: "failure",
  fail: "error",
};

export class GithubChecksChannel implements NotificationChannel {
  readonly kind = "github_checks" as const;
  readonly wired = true;
  private readonly secrets: SecretStore;
  private readonly installation: OrgGithubAppInstallation | undefined;
  private readonly minter: GithubAppTokenMinter;
  private readonly http: GitHubHttpClient;
  private readonly staticRef: string | undefined;

  constructor(deps: GithubChecksChannelDeps) {
    this.secrets = deps.secrets;
    this.installation = deps.installation;
    this.minter = deps.minter ?? new GithubAppTokenMinter({ secrets: deps.secrets });
    this.http = deps.http ?? new FetchGitHubHttpClient();
    this.staticRef = deps.staticRef;
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    const { repo, pullNumber } = parseGitHubPullRequestUrl(target.destination);
    const resolved = await this.resolveToken();
    const headSha = await this.fetchHeadSha(repo, pullNumber, resolved);
    const state = STATE_BY_SEVERITY[payload.severity];
    const response = await this.http.request({
      method: "POST",
      path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/statuses/${encodeURIComponent(headSha)}`,
      token: resolved.token,
      refreshToken: resolved.refresh,
      body: {
        state,
        context: STATUS_CONTEXT,
        description: truncate(payload.title, 140),
        ...(payload.url !== undefined ? { target_url: payload.url } : {}),
      },
    });
    if (response.status !== 201) {
      throw new Error(`github_checks publish failed: HTTP ${response.status}`);
    }
  }

  private async resolveToken(): Promise<ResolvedGithubToken> {
    return resolveGithubToken({
      secrets: this.secrets,
      minter: this.minter,
      ...(this.installation !== undefined ? { installation: this.installation } : {}),
      ...(this.staticRef !== undefined ? { staticRef: this.staticRef } : {}),
    });
  }

  private async fetchHeadSha(
    repo: GitHubRepository,
    pullNumber: number,
    resolved: ResolvedGithubToken,
  ): Promise<string> {
    const response = await this.http.request({
      method: "GET",
      path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${pullNumber}`,
      token: resolved.token,
      refreshToken: resolved.refresh,
    });
    if (response.status !== 200) {
      throw new Error(`github_checks PR fetch failed: HTTP ${response.status}`);
    }
    const sha = extractHeadSha(response.body);
    if (sha === undefined) {
      throw new Error("github_checks PR response missing head sha");
    }
    return sha;
  }
}

function extractHeadSha(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const head = (body as Record<string, unknown>)["head"];
  if (typeof head !== "object" || head === null || Array.isArray(head)) {
    return undefined;
  }
  const sha = (head as Record<string, unknown>)["sha"];
  return typeof sha === "string" && sha !== "" ? sha : undefined;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
