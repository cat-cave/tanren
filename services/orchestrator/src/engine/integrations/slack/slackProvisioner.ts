// SlackProvisioner — the Plane-A Slack `notify` provisioner: it
// CREATES / FINDS the Tanren notification channel for a project from the org's
// Slack bot grant, so an operator never hand-creates a channel per project. It is
// a WRITER against the Slack Web API (distinct from the runtime send adapter
// `notifications/channels/slack.ts`, which only delivers to an already-wired
// target). The artifact it returns is a `notificationTarget` the notification
// layer then sends through.
//
// PLANE A ONLY. This provisions Tanren's OWN Slack notifications (the Forge
// interaction plane the operator uses to drive Tanren). The apex product's own
// Slack bot is Plane B (the built product's app environment, `project_app_env`)
// and is configured + injected separately — there is NO crossover here.
//
// Delivery model — bot `chat.postMessage` (channel id), NOT an incoming webhook:
// `provision`/`bind` yield a `notificationTarget` carrying the CHANNEL ID, and the
// bot token stays the org grant (its credential ref is surfaced as `secretRefs`,
// never the value). The runtime adapter posts with the bot token + channel id. An
// incoming webhook is not minted here: a webhook URL is itself a write-only secret
// (it would have to be stored as a secret ref, never an artifact value), and the
// bot+channel-id model needs no per-channel webhook. If a future variant uses a
// webhook, its URL MUST be stored via the SecretStore and only its ref surfaced.

import type {
  CapabilityId,
  ExistingResource,
  IntegrationProvisioner,
  OrgGrant,
  ProjectContext,
  ProvisionedArtifact,
} from "../../contracts/integrationProvisioner.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { CreateConversationInput, SlackApiTransport, SlackConversation } from "./slackApiTransport.js";

/**
 * Resolve a Slack transport for an org grant. Production wires a factory that
 * resolves the grant's credential ref against the SecretStore into the bot token
 * and constructs a {@link FetchSlackApiTransport}; tests inject a scripted
 * transport. Injecting the FACTORY (not a single transport) keeps the provisioner
 * grant-scoped — each call runs under the right org's token.
 */
export type SlackTransportFactory = (grant: OrgGrant) => Promise<SlackApiTransport>;

export interface SlackProvisionerOptions {
  /** Resolves the per-grant Slack Web API transport (token-scoped). */
  transportFactory: SlackTransportFactory;
  /**
   * Whether the Tanren notify channel is created private. Public by default so an
   * operator can find it; an org may prefer private notify channels.
   */
  privateChannel?: boolean;
}

const SLACK_NOTIFY_CAPABILITY: CapabilityId = "notify";
// Slack channel names: lowercase, no spaces/periods, ≤ 80 chars, [a-z0-9-_].
const SLACK_NAME_MAX = 80;
const NOTIFY_PREFIX = "tanren-";

/**
 * Derive the stable, convention-based channel name for a Tanren project. This is
 * the IDEMPOTENCY KEY: `provision` finds the channel of this name if it exists and
 * only creates it when absent, so re-running onboarding never makes a second
 * channel. Derived from the project id (stable) rather than the display name
 * (mutable) so a rename never orphans the channel.
 */
export function tanrenNotifyChannelName(projectCtx: ProjectContext): string {
  const slug = projectCtx.projectId
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
  return `${NOTIFY_PREFIX}${slug}`.slice(0, SLACK_NAME_MAX);
}

/**
 * The Plane-A Slack provisioner. `discover` lists the workspace's channels;
 * `provision` is idempotent find-or-create of the project's notify channel +
 * ensures the bot is a member; `bind` links an existing channel by id. Every
 * artifact carries the channel id as the notification target and the org bot
 * token only as a secret REF.
 */
export class SlackProvisioner implements IntegrationProvisioner {
  private readonly transportFactory: SlackTransportFactory;
  private readonly privateChannel: boolean;

  constructor(options: SlackProvisionerOptions) {
    this.transportFactory = options.transportFactory;
    this.privateChannel = options.privateChannel ?? false;
  }

  capability(): CapabilityId[] {
    return [SLACK_NOTIFY_CAPABILITY];
  }

  async discover(grant: OrgGrant): Promise<ExistingResource[]> {
    const transport = await this.transportFactory(grant);
    const channels = await this.listAllChannels(transport);
    return channels.map((channel) => ({
      id: channel.id,
      label: channel.name,
      metadata: { isMember: channel.isMember },
    }));
  }

  async provision(grant: OrgGrant, projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    const transport = await this.transportFactory(grant);
    const channelName = tanrenNotifyChannelName(projectCtx);
    const channel = await this.findOrCreateChannel(transport, channelName);
    await this.ensureBotMember(transport, channel);
    return this.artifactFor(grant, channel);
  }

  async bind(grant: OrgGrant, existingResourceId: string, _projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    const transport = await this.transportFactory(grant);
    const channels = await this.listAllChannels(transport);
    const channel = channels.find((candidate) => candidate.id === existingResourceId);
    if (channel === undefined) {
      throw new Error(`cannot bind unknown Slack channel '${existingResourceId}'`);
    }
    await this.ensureBotMember(transport, channel);
    return this.artifactFor(grant, channel);
  }

  // Find-or-create keyed on the stable channel name. A name collision (Slack's
  // `name_taken`) means the channel already exists — we re-list and reuse it, so
  // a racing second provision converges to the SAME channel rather than failing.
  private async findOrCreateChannel(transport: SlackApiTransport, name: string): Promise<SlackConversation> {
    const existing = await this.findChannelByName(transport, name);
    if (existing !== undefined) {
      return existing;
    }
    const input: CreateConversationInput = { name, isPrivate: this.privateChannel };
    try {
      return await transport.createConversation(input);
    } catch (error) {
      if (isNameTaken(error)) {
        const raced = await this.findChannelByName(transport, name);
        if (raced !== undefined) {
          return raced;
        }
      }
      throw error;
    }
  }

  private async findChannelByName(transport: SlackApiTransport, name: string): Promise<SlackConversation | undefined> {
    const channels = await this.listAllChannels(transport);
    return channels.find((channel) => channel.name === name);
  }

  private async ensureBotMember(transport: SlackApiTransport, channel: SlackConversation): Promise<void> {
    if (channel.isMember) {
      return;
    }
    await transport.joinConversation(channel.id);
    channel.isMember = true;
  }

  // Page through `conversations.list` until the cursor is exhausted. A bounded
  // page cap guards against an unterminated cursor loop.
  private async listAllChannels(transport: SlackApiTransport): Promise<SlackConversation[]> {
    const out: SlackConversation[] = [];
    let cursor: string | undefined;
    const maxPages = 50;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await transport.listConversations({ cursor });
      out.push(...result.channels);
      cursor = result.nextCursor;
      if (cursor === undefined || cursor.length === 0) {
        break;
      }
    }
    return out;
  }

  // The bot-token model: the notification target is the CHANNEL ID; the org bot
  // token is surfaced only as a secret REF (the grant's credential ref), never as
  // a value. No webhook URL is minted, so no webhook secret to store here.
  private artifactFor(grant: OrgGrant, channel: SlackConversation): ProvisionedArtifact {
    return {
      projectConfig: {
        slackChannelId: channel.id,
        slackChannelName: channel.name,
      },
      secretRefs: { botToken: grant.credentialRef },
      notificationTarget: {
        kind: "slack",
        config: {
          channelId: channel.id,
          channelName: channel.name,
          // The send adapter resolves the bot token from this ref to post via
          // `chat.postMessage`. A ref, never the value.
          botTokenRef: grant.credentialRef,
        },
      },
    };
  }
}

function isNameTaken(error: unknown): boolean {
  return error instanceof Error && error.message.includes("name_taken");
}

/**
 * Build the production transport factory: resolve the grant's bot-token credential
 * ref against the SecretStore and construct a fetch-backed transport for it. This
 * is where the grant's secret REF becomes a live token, held only inside the
 * transport for the duration of the call. Lives apart from the provisioner so the
 * provisioner stays transport-agnostic (and unit-testable against a scripted fake).
 */
export function secretStoreSlackTransportFactory(
  secrets: SecretStore,
  makeTransport: (botToken: string) => SlackApiTransport,
): SlackTransportFactory {
  return async (grant: OrgGrant): Promise<SlackApiTransport> => {
    const secret = await secrets.get(grant.credentialRef);
    if (secret === undefined) {
      throw new Error(`missing Slack bot-token credential ref: ${grant.credentialRef}`);
    }
    return makeTransport(secret.value);
  };
}
