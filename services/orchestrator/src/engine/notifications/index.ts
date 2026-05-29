// Single import surface for the P2A-0017 notifications matrix. Wiring
// (orchestrator startup, route handlers, tests) should import from this
// barrel rather than reaching into individual files.

export {
  ChannelKind,
  Severity,
  TargetScope,
  NotificationPayload,
  NotificationRouteCreateInput,
  NotificationRouteRow,
  NotificationTargetCreateInput,
  NotificationTargetRow,
  severityMeetsFloor,
  severityRank
} from "./schemas.js";

export { defaultSeverityFor, eventDefaultSeverity } from "./eventDefaultSeverity.js";

export type { NotificationChannel } from "./channels/types.js";
export { NtfyChannel, type NtfyChannelDeps } from "./channels/ntfy.js";
export { SlackChannel, type SlackChannelDeps } from "./channels/slack.js";
export {
  GithubChecksChannel,
  type GithubChecksChannelDeps
} from "./channels/githubChecks.js";
export { TeamsChannel, type TeamsChannelDeps } from "./channels/teams.js";
export { DiscordChannel, type DiscordChannelDeps } from "./channels/discord.js";
export { WebhookChannel, type WebhookChannelDeps } from "./channels/webhook.js";
export {
  EmailChannel,
  HttpEmailTransport,
  type EmailChannelDeps,
  type EmailTransport,
  type EmailMessage
} from "./channels/email.js";
export { TwilioChannel, type TwilioChannelDeps } from "./channels/twilio.js";
export { PagerDutyChannel, type PagerDutyChannelDeps } from "./channels/pagerduty.js";
export { StubChannel } from "./channels/stub.js";

export {
  NotificationTargetStore,
  NotificationRouteStore,
  NotificationDispatchLog,
  type DispatchLogInput,
  type DispatchStatus
} from "./store.js";

export {
  evaluateMatrix,
  isWeekendInUtc,
  type MatrixContext,
  type MatrixEvaluationInput,
  type MatrixMatch
} from "./matrix.js";

export {
  NotificationDispatcher,
  effectiveSeverityFor,
  type DispatcherDeps,
  type EventContext
} from "./dispatcher.js";

export { buildChannelRegistry, type ChannelRegistryDeps } from "./registry.js";
