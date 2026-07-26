// A notification target has one opaque destination. Slack bot delivery needs a
// credential reference and channel id, so encode that non-secret pair strictly.

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
  const [token, channel] = encoded;
  if (encoded.length !== 2 || token === undefined || channel === undefined || token === "" || channel === "") {
    throw new Error("malformed Slack bot notification destination");
  }
  try {
    const botTokenRef = decodeURIComponent(token);
    const channelId = decodeURIComponent(channel);
    if (botTokenRef.trim() === "" || channelId.trim() === "") {
      throw new Error("empty Slack bot notification destination coordinate");
    }
    return { botTokenRef, channelId };
  } catch (error) {
    if (error instanceof URIError) throw new Error("malformed Slack bot notification destination", { cause: error });
    throw error;
  }
}
