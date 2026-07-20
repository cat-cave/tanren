// Scripted direct PRODUCT Slack transport — tests only. It drives the real
// SlackProductProvisioner protocol without exposing any test fake to src wiring.

import type {
  SlackProductChannel,
  SlackProductMessageReceipt,
  SlackProductTransport,
} from "../../../src/engine/integrations/product/slackProductProvisioner.js";

export interface ScriptedSlackProductWorkspace {
  readonly channels?: readonly SlackProductChannel[];
  readonly postReceipt?: Partial<SlackProductMessageReceipt>;
}

export class ScriptedSlackProductTransport implements SlackProductTransport {
  private readonly channels: SlackProductChannel[];
  private readonly postReceipt: Partial<SlackProductMessageReceipt>;
  createCount = 0;
  postCount = 0;

  constructor(workspace: ScriptedSlackProductWorkspace = {}) {
    this.channels = (workspace.channels ?? []).map((channel) => ({ ...channel }));
    this.postReceipt = workspace.postReceipt ?? {};
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listChannels(): Promise<readonly SlackProductChannel[]> {
    return this.channels.map((channel) => ({ ...channel }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createChannel(name: string): Promise<SlackProductChannel> {
    if (this.channels.some((channel) => channel.name === name)) {
      throw new Error("slack conversations.create failed: name_taken");
    }
    const created = { id: `C_PRODUCT_${name}`, name, isMember: true };
    this.channels.push(created);
    this.createCount += 1;
    return { ...created };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async joinChannel(channelId: string): Promise<SlackProductChannel> {
    const channel = this.channels.find((candidate) => candidate.id === channelId);
    if (channel === undefined) throw new Error("slack conversations.join failed: channel_not_found");
    const joined = { ...channel, isMember: true };
    this.channels.splice(this.channels.indexOf(channel), 1, joined);
    return { ...joined };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async postMessage(channelId: string, _text: string): Promise<SlackProductMessageReceipt> {
    if (!this.channels.some((channel) => channel.id === channelId)) {
      throw new Error("slack chat.postMessage failed: channel_not_found");
    }
    this.postCount += 1;
    return {
      channelId: this.postReceipt.channelId ?? channelId,
      messageTs: this.postReceipt.messageTs ?? `1700000000.${this.postCount}`,
    };
  }
}
