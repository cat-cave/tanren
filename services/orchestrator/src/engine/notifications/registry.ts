import type { NotificationChannel } from "./channels/types.js";
import { DiscordChannel, type DiscordChannelDeps } from "./channels/discord.js";
import { EmailChannel, type EmailChannelDeps } from "./channels/email.js";
import { GithubChecksChannel, type GithubChecksChannelDeps } from "./channels/githubChecks.js";
import { NtfyChannel, type NtfyChannelDeps } from "./channels/ntfy.js";
import { PagerDutyChannel, type PagerDutyChannelDeps } from "./channels/pagerduty.js";
import { SlackChannel, type SlackChannelDeps } from "./channels/slack.js";
import { StubChannel } from "./channels/stub.js";
import { TeamsChannel, type TeamsChannelDeps } from "./channels/teams.js";
import { TwilioChannel, type TwilioChannelDeps } from "./channels/twilio.js";
import { WebhookChannel, type WebhookChannelDeps } from "./channels/webhook.js";
import { ChannelKind } from "./schemas.js";

// Channel registry. Wired kinds get real adapters; any kind whose deps are
// not supplied is registered as a StubChannel so the matrix can be configured
// against it without crashing the dispatcher.
//
//   - ntfy (P2A-0017): the original v0 reference channel.
//   - slack (P3-0024): incoming-webhook delivery; the webhook URL is resolved
//     from a write-only credential ref via the secret store.
//   - github_checks (P3-0024): posts a commit status to a PR head SHA, authed
//     through the P3-0003 token resolver. Only wired when `github` deps are
//     supplied.
//   - teams / discord / webhook: incoming-webhook POSTs (per-platform body
//     shape). Wired when their deps key is supplied.
//   - email: SMTP / HTTP email API behind an injectable EmailTransport port.
//   - twilio: SMS via the Twilio REST API.
//   - pagerduty: Events API v2 trigger.
//
// ntfy / slack are always wired because their adapters degrade safely (ntfy
// has an env-default base URL; slack accepts a verbatim webhook URL). The
// remaining six only construct a real adapter when their deps are present so
// an operator who never configured them keeps the honest "stubbed" audit row.

export interface ChannelRegistryDeps {
  ntfy?: NtfyChannelDeps;
  slack?: SlackChannelDeps;
  github?: GithubChecksChannelDeps;
  teams?: TeamsChannelDeps;
  discord?: DiscordChannelDeps;
  email?: EmailChannelDeps;
  twilio?: TwilioChannelDeps;
  pagerduty?: PagerDutyChannelDeps;
  webhook?: WebhookChannelDeps;
}

export function buildChannelRegistry(deps: ChannelRegistryDeps = {}): Record<ChannelKind, NotificationChannel> {
  const registry: Partial<Record<ChannelKind, NotificationChannel>> = {};
  for (const kind of ChannelKind.options) {
    registry[kind] = buildChannel(kind, deps);
  }
  return registry as Record<ChannelKind, NotificationChannel>;
}

// arch-allow: StubChannel — an unconfigured channel resolves to a StubChannel that records
// the dispatch as 'stubbed' in the notifications log (an honest "not wired" audit record),
// never silently dropping. Absence-is-honest, not a stand-in for a real delivery. See P8a §8a.
function buildChannel(kind: ChannelKind, deps: ChannelRegistryDeps): NotificationChannel {
  switch (kind) {
    case "ntfy":
      return new NtfyChannel(deps.ntfy ?? {});
    case "slack":
      return new SlackChannel(deps.slack ?? {});
    case "github_checks":
      // github_checks needs a secret store to resolve tokens; without it we
      // cannot mint/read credentials, so fall back to a stub.
      return deps.github === undefined ? new StubChannel(kind) : new GithubChecksChannel(deps.github);
    case "teams":
      return deps.teams === undefined ? new StubChannel(kind) : new TeamsChannel(deps.teams);
    case "discord":
      return deps.discord === undefined ? new StubChannel(kind) : new DiscordChannel(deps.discord);
    case "webhook":
      return deps.webhook === undefined ? new StubChannel(kind) : new WebhookChannel(deps.webhook);
    case "email":
      return deps.email === undefined ? new StubChannel(kind) : new EmailChannel(deps.email);
    case "twilio":
      return deps.twilio === undefined ? new StubChannel(kind) : new TwilioChannel(deps.twilio);
    case "pagerduty":
      return deps.pagerduty === undefined ? new StubChannel(kind) : new PagerDutyChannel(deps.pagerduty);
    default:
      return new StubChannel(kind);
  }
}
