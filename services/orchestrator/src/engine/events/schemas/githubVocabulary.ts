import {
  GithubBranchPushedPayload,
  GithubFailedPayload,
  GithubPrCreatedPayload,
  GithubPrMergedPayload,
  GithubPrNoCommitsPayload,
  GithubPrReadyPayload,
} from "./integrations.js";

export const githubEventRegistry = {
  "github.branch.pushed": GithubBranchPushedPayload,
  "github.pr.created": GithubPrCreatedPayload,
  "github.pr.ready": GithubPrReadyPayload,
  "github.pr.merged": GithubPrMergedPayload,
  "github.pr.no_commits": GithubPrNoCommitsPayload,
  "github.failed": GithubFailedPayload,
} as const;
