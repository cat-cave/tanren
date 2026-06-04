// P3-0022 candidate-inbox barrel. The inbox route + tests import the typed
// surface from here.

export {
  SourceKind,
  InboxSource,
  TriageVerdict,
  TriageRoutableSpec,
  CandidateTriage,
  CandidateStatus,
  Candidate,
  type IngestedItem,
  type SourceConnector,
  type TriageAnswerer,
  type TriageAnswererContext,
} from "./types.js";

export { wrapProviderTriageAnswerer, type WrapProviderTriageAnswererOptions } from "./providerAnswerer.js";
export { buildTriagePrompt } from "./prompt.js";

export { GitHubIssuesConfig, createGitHubIssuesConnector, type GitHubConnectorDeps } from "./githubConnector.js";

export {
  SentryConfig,
  createSentryConnector,
  FetchSentryHttpClient,
  type SentryConnectorDeps,
  type SentryHttpClient,
  type SentryHttpRequest,
  type SentryHttpResponse,
} from "./sentryConnector.js";

export {
  LinearConfig,
  createLinearConnector,
  FetchLinearHttpClient,
  type LinearConnectorDeps,
  type LinearHttpClient,
  type LinearHttpRequest,
  type LinearHttpResponse,
} from "./linearConnector.js";

export {
  JiraConfig,
  createJiraConnector,
  FetchJiraHttpClient,
  type JiraConnectorDeps,
  type JiraHttpClient,
  type JiraHttpRequest,
  type JiraHttpResponse,
} from "./jiraConnector.js";

export { createIssuesConnector, type IssuesConnectorDeps } from "./issuesConnector.js";

export { buildInboxConnectorMap, type BuildConnectorMapDeps } from "./connectorMap.js";

export { InboxStore, type CreateSourceInput } from "./store.js";

export { ensureIssuesInboxSource, type EnsureIssuesSourceInput, type EnsureIssuesSourceResult } from "./repoLink.js";

export {
  ingestSource,
  autoRouteCandidate,
  acceptCandidate,
  foldCandidate,
  dismissCandidate,
  closeDuplicateCandidate,
  CandidateNotFoundError,
  CandidateNotPlaceableError,
  TriageAnswererUnconfiguredError,
  type InboxEngineDeps,
  type IngestResult,
  type AutoRouteDeps,
  type AutoRouteResult,
  type AcceptCandidateInput,
  type AcceptCandidateResult,
} from "./engine.js";
