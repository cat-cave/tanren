// A persisted notification target has one opaque destination string. Slack bot
// delivery needs two non-secret coordinates: the channel id and the SecretStore
// ref for the org bot token. Keep their encoding strict and versioned so bot
// targets cannot be mistaken for incoming-webhook targets.

const PREFIX = "slack-bot-v1:";

export interface SlackBotDestination {
  botTokenRef: string;
  channelId: string;
}

export function encodeSlackBotDestination(input: SlackBotDestination): string {
  if (input.botTokenRef.trim() === "" || input.channelId.trim() === "") {
    throw new Error("slack bot notification target requires a non-empty botTokenRef and channelId");
  }
  return `${PREFIX}${encodeURIComponent(input.botTokenRef)}:${encodeURIComponent(input.channelId)}`;
}

export function decodeSlackBotDestination(destination: string): SlackBotDestination | undefined {
  if (!destination.startsWith(PREFIX)) return undefined;
  const encoded = destination.slice(PREFIX.length).split(":");
  const [encodedTokenRef, encodedChannelId] = encoded;
  if (
    encoded.length !== 2 ||
    encodedTokenRef === undefined ||
    encodedChannelId === undefined ||
    encodedTokenRef === "" ||
    encodedChannelId === ""
  ) {
    throw new Error("malformed Slack bot notification destination");
  }
  try {
    const botTokenRef = decodeURIComponent(encodedTokenRef);
    const channelId = decodeURIComponent(encodedChannelId);
    if (botTokenRef.trim() === "" || channelId.trim() === "") {
      throw new Error("empty Slack bot notification destination coordinate");
    }
    return { botTokenRef, channelId };
  } catch (error) {
    if (error instanceof URIError) throw new Error("malformed Slack bot notification destination", { cause: error });
    throw error;
  }
}
