import type pg from "pg";
import type { SecretStore } from "../contracts/secretStore.js";
import { GithubIssueSourceAdapter } from "../forge/githubIssueSourceAdapter.js";
import { ManualIssueSourceAdapter, type IssueSourceAdapter } from "../forge/issueSourceAdapter.js";
import { SourceSyncWorker } from "../forge/sourceSyncWorker.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { GitHubHttpClient } from "../providers/github.js";

export function buildSourceSyncWorker(input: {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
}): SourceSyncWorker {
  return new SourceSyncWorker({
    pool: input.pool,
    adapters: new Map<string, IssueSourceAdapter>([
      [
        "issues",
        new GithubIssueSourceAdapter({
          pool: input.pool,
          secrets: input.secrets,
          githubHttp: input.githubHttp,
          ...(input.githubAppMinter === undefined ? {} : { githubAppMinter: input.githubAppMinter }),
        }),
      ],
      ["manual", new ManualIssueSourceAdapter()],
    ]),
  });
}
