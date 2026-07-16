// The default inbox connector map (GitHub/Linear/Jira issues + Sentry errors),
// extracted so BOTH the inbox HTTP route (manual ingest) and the P1d intake
// poller construct the SAME set of source connectors from one builder — the
// poll path and the click path read sources identically.

import type { SecretStore } from "../../contracts/secretStore.js";
import type { OrgGithubAppInstallation } from "../../config/orgConfig.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { createCiInsightsConnector } from "./ciInsightsConnector.js";
import { createGitHubIssuesConnector } from "./githubConnector.js";
import { createIssuesConnector } from "./issuesConnector.js";
import {
  createSentryConnector,
  FetchSentryHttpClient,
  type SentryHttpClient,
  type SentryIntakeAuthority,
} from "./sentryConnector.js";
import { createLinearConnector, FetchLinearHttpClient, type LinearHttpClient } from "./linearConnector.js";
import { createJiraConnector, FetchJiraHttpClient, type JiraHttpClient } from "./jiraConnector.js";
import type { SourceConnector } from "./types.js";

export interface BuildConnectorMapDeps {
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  sentryHttp?: SentryHttpClient;
  sentryAuthority?: SentryIntakeAuthority;
  linearHttp?: LinearHttpClient;
  jiraHttp?: JiraHttpClient;
  // Intake credential resolution (no-silent-fallbacks fix): the org's GitHub App
  // installation + the shared minter, threaded into the GitHub issues connector so
  // the connector mints an INSTALLATION token. The intake poller builds this map
  // PER-ORG with EXPLICIT resolution — App installation when installed, ELSE the
  // org's default static token (`defaultGithubStaticRef`) — exactly how the rest of
  // the engine resolves a GitHub credential. A source pinning its OWN
  // `config.staticRef` overrides this default.
  installation?: OrgGithubAppInstallation;
  minter?: GithubAppTokenMinter;
  // The org-default static GitHub credential ref, used by the GitHub issues
  // connector when no App is installed and the source pins no own `staticRef`.
  defaultGithubStaticRef?: string;
}

/** Build the default `{ issues, errors }` connector map from the shared transports. */
export function buildInboxConnectorMap(deps: BuildConnectorMapDeps): Map<string, SourceConnector> {
  const sentryAuthority: SentryIntakeAuthority =
    deps.sentryAuthority ?? (() => Promise.reject(new Error("sentry intake authority is not configured")));
  return new Map<string, SourceConnector>([
    [
      "issues",
      createIssuesConnector({
        github: createGitHubIssuesConnector({
          secrets: deps.secrets,
          githubHttp: deps.githubHttp,
          ...(deps.installation === undefined ? {} : { installation: deps.installation }),
          ...(deps.minter === undefined ? {} : { minter: deps.minter }),
          ...(deps.defaultGithubStaticRef === undefined ? {} : { defaultStaticRef: deps.defaultGithubStaticRef }),
        }),
        linear: createLinearConnector({
          secrets: deps.secrets,
          linearHttp: deps.linearHttp ?? new FetchLinearHttpClient(),
        }),
        jira: createJiraConnector({ secrets: deps.secrets, jiraHttp: deps.jiraHttp ?? new FetchJiraHttpClient() }),
      }),
    ],
    [
      "errors",
      createSentryConnector({
        secrets: deps.secrets,
        sentryHttp: deps.sentryHttp ?? new FetchSentryHttpClient(),
        authority: sentryAuthority,
      }),
    ],
    // CI-intelligence PR3: the CI-insights source (a `system` source). It pulls
    // nothing — the worker's CiInsightsLoop emits its candidates — so the connector
    // is a registered no-op (a stray ingest over it is safe), keeping the kind a
    // recognized member of the map.
    ["system", createCiInsightsConnector()],
  ]);
}
