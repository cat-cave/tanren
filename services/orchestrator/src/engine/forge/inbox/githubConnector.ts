import type { SecretStore } from "../../contracts/secretStore.js";
import type { OrgGithubAppInstallation } from "../../config/orgConfig.js";
import { sameQueryMultiset } from "../../integrations/pageScope.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { resolveGithubToken } from "../../credentials/githubTokenResolver.js";
import { z } from "zod";
import { assertIntakeResponseOk, assertSupportedIssuesProvider, IntakeSourceFetchError } from "./connectorErrors.js";
import { ActiveGitHubIssuesConfig, GithubIssueTitle } from "./types.js";
import type { IngestedItem, InboxSource, SourceConnector } from "./types.js";

export interface GitHubConnectorDeps {
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  installation?: OrgGithubAppInstallation;
  minter?: GithubAppTokenMinter;
  defaultStaticRef?: string;
}

const GithubIssuePayload = z
  .object({
    number: z.number().int().positive(),
    title: GithubIssueTitle,
    body: z.string().nullable().optional(),
    comments: z.number().int().nonnegative(),
    // GitHub can legitimately return a redacted/deleted author as null (or
    // omit it); a present non-object is still rejected by the discriminator.
    user: z
      .object({ login: z.string().min(1) })
      .passthrough()
      .nullable()
      .optional(),
    labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).optional(),
    pull_request: z.object({}).passthrough().optional(),
  })
  .passthrough();
type GithubIssuePayload = z.infer<typeof GithubIssuePayload>;
function paginationError(detail: string): never {
  throw new IntakeSourceFetchError("github", 200, detail);
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

function labelNames(issue: GithubIssuePayload): string[] {
  const raw = issue.labels ?? [];
  return raw
    .map((l) => (typeof l === "string" ? l : typeof l?.name === "string" ? l.name : ""))
    .filter((l): l is string => l.length > 0);
}

export function createGitHubIssuesConnector(deps: GitHubConnectorDeps): SourceConnector {
  return {
    kind: "issues",
    async fetch(source: InboxSource): Promise<IngestedItem[]> {
      assertSupportedIssuesProvider(source.config);
      const config = ActiveGitHubIssuesConfig.parse(source.config);
      const resolved = await resolveGithubToken({
        secrets: deps.secrets,
        orgId: source.orgId,
        ...(deps.installation === undefined ? {} : { installation: deps.installation }),
        ...(deps.defaultStaticRef === undefined ? {} : { staticRef: deps.defaultStaticRef }),
        minter: deps.minter ?? new GithubAppTokenMinter({ secrets: deps.secrets }),
      });

      const labelQuery = config.labels.length > 0 ? `&labels=${encodeURIComponent(config.labels.join(","))}` : "";
      const issuesPath =
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}` +
        `/issues?state=open&per_page=50${labelQuery}`;
      const seenPaths = new Set<string>();
      const issues: GithubIssuePayload[] = [];
      let path: string | undefined = issuesPath;
      let page = 1;
      while (path !== undefined) {
        if (seenPaths.has(path)) paginationError("issues pagination repeated a page path");
        seenPaths.add(path);
        const response = await deps.githubHttp.request({
          method: "GET",
          path,
          token: resolved.token,
          refreshToken: resolved.refresh,
          retryRateLimit: false,
        });
        assertIntakeResponseOk("github", response.status, response.errorDetail ?? "", response.retryAfterMs);
        if (!Array.isArray(response.body)) paginationError("200 body was not an issues array");
        issues.push(...z.array(GithubIssuePayload).parse(response.body));
        if (response.nextPagePath !== undefined) {
          const nextPage = configuredIssuesPage(response.nextPagePath, issuesPath);
          if (nextPage === undefined) paginationError("next page changed the configured issues resource scope");
          if (nextPage !== page + 1) paginationError("issues pagination cursor did not advance contiguously");
          page = nextPage;
        }
        path = response.nextPagePath;
      }
      const items: IngestedItem[] = [];
      const seenIssueNumbers = new Set<number>();
      for (const issue of issues) {
        // The Issues API also returns PRs; drop them.
        if (issue.pull_request !== undefined) continue;
        if (seenIssueNumbers.has(issue.number)) paginationError("provider repeated an issue number");
        seenIssueNumbers.add(issue.number);
        const labels = labelNames(issue);
        items.push({
          externalId: `gh-${config.owner}/${config.repo}#${issue.number}`,
          title: issue.title,
          body: issue.body?.slice(0, 8000) ?? "",
          severity: severityFromLabels(labels),
          projectId: source.projectId,
        });
      }
      return items;
    },
  };
}
function configuredIssuesPage(nextPath: string, issuesPath: string): number | undefined {
  if (!nextPath.startsWith("/") || nextPath.startsWith("//")) return undefined;
  let next: URL;
  let configured: URL;
  try {
    next = new URL(nextPath, "https://github.invalid");
    configured = new URL(issuesPath, "https://github.invalid");
  } catch {
    return undefined;
  }
  if (next.pathname !== configured.pathname || next.hash !== "") return undefined;
  const pages = next.searchParams.getAll("page");
  if (pages.length !== 1 || !/^[1-9][0-9]*$/u.test(pages[0]!)) return undefined;
  if (!sameQueryMultiset(configured, next, "page")) return undefined;
  return Number(pages[0]);
}
