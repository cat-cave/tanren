// P1d autonomous intake barrel (autonomy-engine.md §1d). The webhook receiver
// route + the poller + tests import the typed surface from here.

export { verifyGithubSignature, type SignatureCheck } from "./signature.js";
export { mapGithubIssueWebhook, type WebhookMapResult } from "./webhookMapping.js";
export { intakeItem, type IntakePipelineDeps, type IntakeOutcome } from "./pipeline.js";
export { intakeAutoRouteDeps } from "./systemActor.js";
export {
  IntakePoller,
  pollSourceOnce,
  isPollableSource,
  DEFAULT_POLL_INTERVAL_MS,
  type IntakePollerDeps,
  type PollSourceResult,
} from "./poller.js";
export {
  buildIntakeConnectorMapForOrg,
  isCredentialResolutionError,
  IntakeGithubCredentialMissingError,
  type BuildIntakeConnectorMapDeps,
} from "./issueSourceSeam.js";
