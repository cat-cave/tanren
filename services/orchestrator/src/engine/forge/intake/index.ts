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
  classifyPermanentInboxSourceError,
  IntakeGithubCredentialMissingError,
  type BuildIntakeConnectorMapDeps,
  type PermanentInboxSourceFailure,
} from "./issueSourceSeam.js";
// The durable `webhook_events` store lives on the `Repositories` seam
// (engine/repositories/webhookEvents.ts); re-exported here so the intake-internal
// callers keep their by-name import.
export {
  WebhookEventStore,
  type WebhookEvent,
  type WebhookEventStatus,
  type PersistWebhookEventInput,
} from "../../repositories/webhookEvents.js";
export {
  processWebhookEvent,
  sweepWebhookEvents,
  sweepStuckCandidates,
  type WebhookProcessorDeps,
} from "./webhookProcessor.js";
