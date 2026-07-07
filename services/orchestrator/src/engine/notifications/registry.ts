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
//   - ntfy: the original v0 reference channel.
//   - slack: incoming-webhook delivery; the webhook URL is resolved
//     from a write-only credential ref via the secret store. Only wired when
//     `slack` deps (carrying the secret store) are supplied.
//   - github_checks: posts a commit status to a PR head SHA, authed
//     through the token resolver. Only wired when `github` deps are
//     supplied.
//   - teams / discord / webhook: incoming-webhook POSTs (per-platform body
//     shape). Wired when their deps key is supplied.
//   - email: SMTP / HTTP email API behind an injectable EmailTransport port.
//   - twilio: SMS via the Twilio REST API.
//   - pagerduty: Events API v2 trigger.
//
// ntfy is always wired because its adapter degrades safely (it has an
// env-default base URL). Every credential-resolving channel (slack / teams /
// discord / webhook / email / twilio / pagerduty / github_checks) only
// constructs a real adapter when its deps key — carrying the secret store it
// needs to resolve its write-only credential ref — is present.
//
// Notification-integrity doctrine (Codex H3 Surface 6 #17): production callers
// pass `requiredChannels` naming every kind that MUST be wired (e.g. every
// ChannelKind, so a future misconfig of a specific channel dep is loud rather
// than silent). `buildChannelRegistry` throws `ChannelNotConfiguredError` when
// any required kind's dep is missing — never silently returns a StubChannel
// for a kind the operator expected to be wired. Test callers that want the
// legacy "unwired → stub" audit path simply omit `requiredChannels`.

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

export interface BuildChannelRegistryOptions {
  /**
   * The set of channel kinds that MUST be wired. `buildChannelRegistry` throws
   * `ChannelNotConfiguredError` for any required kind whose dep is missing,
   * instead of silently returning a `StubChannel`. Production callers pass the
   * full `ChannelKind.options` set so a routed channel with no dep can never
   * silently drop a fail-severity escalation. Omitted → the legacy
   * "unwired → stub audit" behaviour (tests only).
   */
  requiredChannels?: ReadonlySet<ChannelKind>;
}

/**
 * Thrown at boot when a REGISTERED channel (per `requiredChannels`) is missing
 * its dep. The dispatcher's channel matrix must never silently substitute a
 * stub for a kind an operator (or the notification_routes seed) expects to be
 * wired — a stubbed publish is a no-op, and the dispatcher records it as a
 * benign `stubbed` audit row, which for a fail-severity route is a silent
 * escalation loss. Fail loud at boot rather than at first fail-severity event.
 */
export class ChannelNotConfiguredError extends Error {
  readonly kind: ChannelKind;
  constructor(kind: ChannelKind, detail?: string) {
    super(
      detail === undefined
        ? `notification channel "${kind}" is required but its dep is not configured (would silently stub a fail-severity route)`
        : `notification channel "${kind}" is required but its dep is not configured: ${detail}`,
    );
    this.name = "ChannelNotConfiguredError";
    this.kind = kind;
  }
}

export function buildChannelRegistry(
  deps: ChannelRegistryDeps = {},
  options: BuildChannelRegistryOptions = {},
): Record<ChannelKind, NotificationChannel> {
  const required = options.requiredChannels;
  const registry: Partial<Record<ChannelKind, NotificationChannel>> = {};
  for (const kind of ChannelKind.options) {
    const channel = buildChannel(kind, deps);
    if (required !== undefined && required.has(kind) && !channel.wired) {
      // Boot-time missing-dep check: a routed/required kind whose dep is
      // unwired would fall to a StubChannel, whose publish() is a no-op —
      // silently dropping the fail-severity escalation. Fail loud at boot.
      throw new ChannelNotConfiguredError(kind);
    }
    registry[kind] = channel;
  }
  return registry as Record<ChannelKind, NotificationChannel>;
}

/**
 * The kinds in `registry` that are actually wired (i.e. would NOT publish as a
 * StubChannel no-op). Route-write endpoints consult this to reject creating a
 * route to an unwired channel — the runtime companion to the boot-time
 * `requiredChannels` guard.
 */
export function wiredChannelKinds(registry: Record<ChannelKind, NotificationChannel>): Set<ChannelKind> {
  const set = new Set<ChannelKind>();
  for (const kind of ChannelKind.options) {
    if (registry[kind]?.wired) set.add(kind);
  }
  return set;
}

// arch-allow: StubChannel — a not-required unconfigured channel resolves to a
// StubChannel that records the dispatch as 'stubbed' in the notifications log
// (an honest "not wired" audit record for the test path). Production paths
// pass `requiredChannels` so this branch is unreachable at boot — a stub can
// never back a routed production channel. See P8a §8a and the notification-
// integrity doctrine (Codex H3 Surface 6 #17).
function buildChannel(kind: ChannelKind, deps: ChannelRegistryDeps): NotificationChannel {
  switch (kind) {
    case "ntfy":
      return new NtfyChannel(deps.ntfy ?? {});
    case "slack":
      // slack needs a secret store to resolve its webhook credential ref;
      // without it we cannot deliver, so fall back to a stub.
      return deps.slack === undefined ? new StubChannel(kind) : new SlackChannel(deps.slack);
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
