// Single import surface for the notifications matrix. Wiring
// (orchestrator startup, route handlers, tests) should import from this
// barrel rather than reaching into individual files.

export {
  ChannelKind,
  Severity,
  TargetScope,
  NotificationDeliveryRow,
  NotificationPayload,
  NotificationRouteCreateInput,
  NotificationRouteRow,
  NotificationTargetCreateInput,
  NotificationTargetRow,
  NotificationTargetUpdateInput,
  severityMeetsFloor,
  severityRank,
} from "./schemas.js";

export { defaultSeverityFor, eventDefaultSeverity } from "./eventDefaultSeverity.js";

export type { NotificationChannel } from "./channels/types.js";
export { NtfyChannel, type NtfyChannelDeps } from "./channels/ntfy.js";
export { SlackChannel, type SlackChannelDeps } from "./channels/slack.js";
export { GithubChecksChannel, type GithubChecksChannelDeps } from "./channels/githubChecks.js";
export { TeamsChannel, type TeamsChannelDeps } from "./channels/teams.js";
export { DiscordChannel, type DiscordChannelDeps } from "./channels/discord.js";
export { WebhookChannel, type WebhookChannelDeps } from "./channels/webhook.js";
export {
  EmailChannel,
  HttpEmailTransport,
  type EmailChannelDeps,
  type EmailTransport,
  type EmailMessage,
} from "./channels/email.js";
export { TwilioChannel, type TwilioChannelDeps } from "./channels/twilio.js";
export { PagerDutyChannel, type PagerDutyChannelDeps } from "./channels/pagerduty.js";
export { StubChannel } from "./channels/stub.js";

export {
  NotificationTargetStore,
  NotificationRouteStore,
  NotificationDispatchLog,
  type DispatchLogInput,
  type DispatchStatus,
  type NotificationDeliveryListFilters,
} from "./store.js";

export {
  evaluateMatrix,
  isWeekendInUtc,
  type MatrixContext,
  type MatrixEvaluationInput,
  type MatrixMatch,
} from "./matrix.js";

export { NotificationDispatcher, type DispatcherDeps, type DefaultRoute } from "./dispatcher.js";

export { effectiveSeverityFor, type EventContext } from "./messageFormat.js";

export {
  buildChannelRegistry,
  wiredChannelKinds,
  ChannelNotConfiguredError,
  type BuildChannelRegistryOptions,
  type ChannelRegistryDeps,
} from "./registry.js";

export {
  buildNotificationDispatcher,
  buildProductionChannelRegistry,
  type BuildNotificationDispatcherDeps,
  type BuiltNotificationDispatcher,
} from "./build.js";

export {
  ensureDefaultNotificationRoute,
  DEFAULT_ROUTE_EVENTS,
  DEFAULT_ROUTE_TARGET_LABEL,
  type EnsureDefaultRouteInput,
  type EnsureDefaultRouteResult,
} from "./seedDefaultRoute.js";

export { NotificationSubscriber, startNotificationSubscriber, type NotificationSubscriberDeps } from "./subscriber.js";
