import type { NotificationChannel } from "./channels/types.js";
import { GithubChecksChannel, type GithubChecksChannelDeps } from "./channels/githubChecks.js";
import { NtfyChannel, type NtfyChannelDeps } from "./channels/ntfy.js";
import { SlackChannel, type SlackChannelDeps } from "./channels/slack.js";
import { StubChannel } from "./channels/stub.js";
import { ChannelKind } from "./schemas.js";

// Channel registry. Wired kinds (ntfy, slack, github_checks) get real
// adapters; every other ChannelKind is registered as a StubChannel so the
// matrix can be configured against them without crashing the dispatcher.
//
//   - ntfy (P2A-0017): the original v0 reference channel.
//   - slack (P3-0024): incoming-webhook delivery; the webhook URL is resolved
//     from a write-only credential ref via the secret store.
//   - github_checks (P3-0024): posts a commit status to a PR head SHA, authed
//     through the P3-0003 token resolver (auto-rotating App installation token,
//     static fallback otherwise). Only wired when `github` deps are supplied;
//     without a secret store it stays a stub so callers that never configured
//     GitHub don't accidentally construct a half-built adapter.

export interface ChannelRegistryDeps {
  ntfy?: NtfyChannelDeps;
  slack?: SlackChannelDeps;
  github?: GithubChecksChannelDeps;
}

export function buildChannelRegistry(
  deps: ChannelRegistryDeps = {}
): Record<ChannelKind, NotificationChannel> {
  const registry: Partial<Record<ChannelKind, NotificationChannel>> = {};
  for (const kind of ChannelKind.options) {
    registry[kind] = buildChannel(kind, deps);
  }
  return registry as Record<ChannelKind, NotificationChannel>;
}

function buildChannel(kind: ChannelKind, deps: ChannelRegistryDeps): NotificationChannel {
  switch (kind) {
    case "ntfy":
      return new NtfyChannel(deps.ntfy ?? {});
    case "slack":
      return new SlackChannel(deps.slack ?? {});
    case "github_checks":
      // github_checks needs a secret store to resolve tokens; without it we
      // cannot mint/read credentials, so fall back to a stub.
      return deps.github !== undefined ? new GithubChecksChannel(deps.github) : new StubChannel(kind);
    default:
      return new StubChannel(kind);
  }
}
