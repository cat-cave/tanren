// P3-0022 candidate-inbox barrel. The inbox route + tests import the typed
// surface from here.

export {
  SourceKind,
  InboxSource,
  TriageVerdict,
  CandidateTriage,
  CandidateStatus,
  Candidate,
  type IngestedItem,
  type SourceConnector,
  type TriageAnswerer,
  type TriageAnswererContext
} from "./types.js";

export { createDeterministicTriageAnswerer } from "./defaultAnswerer.js";

export {
  GitHubIssuesConfig,
  createGitHubIssuesConnector,
  type GitHubConnectorDeps
} from "./githubConnector.js";

export {
  SentryConfig,
  createSentryConnector,
  FetchSentryHttpClient,
  type SentryConnectorDeps,
  type SentryHttpClient,
  type SentryHttpRequest,
  type SentryHttpResponse
} from "./sentryConnector.js";

export {
  createSource,
  listSources,
  getSource,
  listCandidates,
  getCandidate,
  upsertCandidate,
  resolveCandidate,
  type CreateSourceInput
} from "./store.js";

export {
  ingestSource,
  acceptCandidate,
  foldCandidate,
  dismissCandidate,
  closeDuplicateCandidate,
  CandidateNotFoundError,
  CandidateNotPlaceableError,
  type InboxEngineDeps,
  type IngestResult,
  type AcceptCandidateInput,
  type AcceptCandidateResult
} from "./engine.js";
