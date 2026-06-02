// A SCRIPTED Slack Web API transport — a TEST FIXTURE (tests/ only) that backs the
// real SlackProvisioner with an in-memory workspace so the conformance suite (and
// the unit tests) drive the genuine provisioner logic WITHOUT any real Slack call
// in CI. It models a workspace's channel set, honors create (with name_taken on a
// duplicate), join (membership), and cursor-paged list. This is the shape a real
// Slack workspace's behavior is held to — it never reaches a production src/ path.

import type {
  CreateConversationInput,
  ListConversationsInput,
  ListConversationsResult,
  SlackApiTransport,
  SlackConversation,
} from "../../../src/engine/integrations/slack/slackApiTransport.js";

export interface ScriptedSlackWorkspace {
  /** Pre-existing channels (brownfield discovery). */
  channels?: SlackConversation[];
  /** The bot's own user id `auth.test` returns. */
  botUserId?: string;
  /** Page size for the cursor-paged list (default: all in one page). */
  pageSize?: number;
}

/**
 * An in-memory Slack workspace implementing {@link SlackApiTransport}. `create`
 * adds a channel and throws `name_taken` if the name already exists (the real
 * Slack error the provisioner's race path keys on); `join` flips membership;
 * `list` pages through the channel set with a cursor.
 */
export class ScriptedSlackTransport implements SlackApiTransport {
  private readonly channels: SlackConversation[];
  private readonly botUserId: string;
  private readonly pageSize: number;
  /** Observability for tests: how many channels the fake has ever created. */
  createCount = 0;

  constructor(workspace: ScriptedSlackWorkspace = {}) {
    this.channels = (workspace.channels ?? []).map((channel) => ({ ...channel }));
    this.botUserId = workspace.botUserId ?? "U_BOT";
    this.pageSize = workspace.pageSize ?? Number.MAX_SAFE_INTEGER;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async authTest(): Promise<{ botUserId: string }> {
    return { botUserId: this.botUserId };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listConversations(input: ListConversationsInput): Promise<ListConversationsResult> {
    const start = input.cursor === undefined || input.cursor.length === 0 ? 0 : Number(input.cursor);
    const page = this.channels.slice(start, start + this.pageSize).map((channel) => ({ ...channel }));
    const next = start + this.pageSize;
    return {
      channels: page,
      nextCursor: next < this.channels.length ? String(next) : undefined,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createConversation(input: CreateConversationInput): Promise<SlackConversation> {
    if (this.channels.some((channel) => channel.name === input.name)) {
      // Mirror the real Slack envelope error the FetchSlackApiTransport surfaces.
      throw new Error(`slack conversations.create failed: name_taken`);
    }
    const created: SlackConversation = {
      id: `C_${input.name}`,
      name: input.name,
      // A bot that creates a channel is its creator → already a member.
      isMember: true,
    };
    this.channels.push(created);
    this.createCount += 1;
    return { ...created };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async joinConversation(channelId: string): Promise<void> {
    const channel = this.channels.find((candidate) => candidate.id === channelId);
    if (channel === undefined) {
      throw new Error(`slack conversations.join failed: channel_not_found`);
    }
    channel.isMember = true;
  }
}
