// GitHub Issues source connector.
//
// Reads open issues for a repo through the SAME GitHub plumbing as the rest of
// The `resolveGithubToken` (App installation token, static
// fallback) + the injectable `GitHubHttpClient`. It maps each issue to a raw
// `IngestedItem` the engine persists as a candidate. Pull requests (which the
// Issues API also returns) are filtered out.
//
// Everything the connector needs to hit GitHub is injected, so tests drive it
// with a fake `GitHubHttpClient` (no network) — see candidateInbox.test.ts.

import type { SecretStore } from "../../contracts/secretStore.js";
import type { OrgGithubAppInstallation } from "../../config/orgConfig.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { resolveGithubToken } from "../../credentials/githubTokenResolver.js";
import { z } from "zod";
import type { IngestedItem, InboxSource, SourceConnector } from "./types.js";

// The `config` shape a GitHub Issues source carries. `owner`/`repo` name the
// repository; `labels` (optional) filters to `spec-candidate`-style labels;
// `staticRef`/`installation` pick the auth path (mirrors the resolver inputs).
// `provider` is optional (the `issues` dispatcher keyed on it); absent on
// existing GitHub sources, so they keep parsing unchanged.
export const GitHubIssuesConfig = z
  .object({
    provider: z.literal("github").optional(),
    owner: z.string().min(1),
    repo: z.string().min(1),
    labels: z.array(z.string().min(1)).default([]),
    staticRef: z.string().min(1).optional(),
  })
  .strict();
export type GitHubIssuesConfig = z.infer<typeof GitHubIssuesConfig>;

export interface GitHubConnectorDeps {
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  // Optional org App installation; when present the resolver mints an App token.
  installation?: OrgGithubAppInstallation;
  minter?: GithubAppTokenMinter;
  // The org-default static credential ref, used when no App is installed and the
  // source pins no own `config.staticRef`. The intake poller threads the org's
  // resolved default here (App-installation-OR-org-default-static, the engine's
  // standard GitHub resolution); the source's own `staticRef` takes precedence.
  defaultStaticRef?: string;
}

// A GitHub issue as the Issues API returns it (the fields we map). `pull_request`
// is present only on PRs, which we drop.
interface RawIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  labels?: Array<{ name?: unknown } | string> | undefined;
  pull_request?: unknown;
}

function severityFromLabels(labels: ReadonlyArray<string>): IngestedItem["severity"] {
  const lowered = labels.map((l) => l.toLowerCase());
  if (lowered.some((l) => l.includes("bug") || l.includes("regression") || l.includes("critical"))) {
    return "fail";
  }
  if (lowered.some((l) => l.includes("warn") || l.includes("perf"))) {
    return "warn";
  }
  return "info";
}

function labelNames(issue: RawIssue): string[] {
  const raw = issue.labels ?? [];
  return raw
    .map((l) => (typeof l === "string" ? l : typeof l?.name === "string" ? l.name : ""))
    .filter((l): l is string => l.length > 0);
}

export function createGitHubIssuesConnector(deps: GitHubConnectorDeps): SourceConnector {
  return {
    kind: "issues",
    async fetch(source: InboxSource): Promise<IngestedItem[]> {
      const config = GitHubIssuesConfig.parse(source.config);
      // The source's own `staticRef` takes precedence; else the org-default static
      // ref the poller resolved (App-installation-OR-org-default-static). When
      // neither is present and no App is installed, `resolveGithubToken` raises a
      // LOUD `NoGithubCredentialConfiguredError` — never a silent empty fetch.
      const staticRef = config.staticRef ?? deps.defaultStaticRef;
      const resolved = await resolveGithubToken({
        secrets: deps.secrets,
        ...(deps.installation === undefined ? {} : { installation: deps.installation }),
        ...(staticRef === undefined ? {} : { staticRef }),
        minter: deps.minter ?? new GithubAppTokenMinter({ secrets: deps.secrets }),
      });

      const labelQuery = config.labels.length > 0 ? `&labels=${encodeURIComponent(config.labels.join(","))}` : "";
      const path =
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}` +
        `/issues?state=open&per_page=50${labelQuery}`;

      const response = await deps.githubHttp.request({
        method: "GET",
        path,
        token: resolved.token,
        refreshToken: resolved.refresh,
      });
      if (response.status !== 200 || !Array.isArray(response.body)) {
        return [];
      }

      const issues = response.body as RawIssue[];
      const items: IngestedItem[] = [];
      for (const issue of issues) {
        // The Issues API also returns PRs; drop them.
        if (issue.pull_request !== undefined) continue;
        if (typeof issue.number !== "number" || typeof issue.title !== "string") continue;
        const labels = labelNames(issue);
        items.push({
          externalId: `gh-${config.owner}/${config.repo}#${issue.number}`,
          title: issue.title,
          body: typeof issue.body === "string" ? issue.body.slice(0, 8000) : "",
          severity: severityFromLabels(labels),
          projectId: source.projectId,
        });
      }
      return items;
    },
  };
}
