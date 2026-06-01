// The default inbox connector map (GitHub/Linear/Jira issues + Sentry errors),
// extracted so BOTH the inbox HTTP route (manual ingest) and the P1d intake
// poller construct the SAME set of source connectors from one builder — the
// poll path and the click path read sources identically.

import type { SecretStore } from "../../contracts/secretStore.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import { createGitHubIssuesConnector } from "./githubConnector.js";
import { createIssuesConnector } from "./issuesConnector.js";
import { createSentryConnector, FetchSentryHttpClient, type SentryHttpClient } from "./sentryConnector.js";
import { createLinearConnector, FetchLinearHttpClient, type LinearHttpClient } from "./linearConnector.js";
import { createJiraConnector, FetchJiraHttpClient, type JiraHttpClient } from "./jiraConnector.js";
import type { SourceConnector } from "./types.js";

export interface BuildConnectorMapDeps {
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  sentryHttp?: SentryHttpClient;
  linearHttp?: LinearHttpClient;
  jiraHttp?: JiraHttpClient;
}

/** Build the default `{ issues, errors }` connector map from the shared transports. */
export function buildInboxConnectorMap(deps: BuildConnectorMapDeps): Map<string, SourceConnector> {
  return new Map<string, SourceConnector>([
    [
      "issues",
      createIssuesConnector({
        github: createGitHubIssuesConnector({ secrets: deps.secrets, githubHttp: deps.githubHttp }),
        linear: createLinearConnector({
          secrets: deps.secrets,
          linearHttp: deps.linearHttp ?? new FetchLinearHttpClient(),
        }),
        jira: createJiraConnector({ secrets: deps.secrets, jiraHttp: deps.jiraHttp ?? new FetchJiraHttpClient() }),
      }),
    ],
    [
      "errors",
      createSentryConnector({ secrets: deps.secrets, sentryHttp: deps.sentryHttp ?? new FetchSentryHttpClient() }),
    ],
  ]);
}
