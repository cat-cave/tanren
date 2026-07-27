/** Fail-closed direct Slack history transport for A3's independent observer. */

import { z } from "zod";

export interface SlackHistoryMessage {
  readonly ts: string;
  readonly text: string;
}

export interface SlackHistoryBinding {
  readonly orgId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly channelId: string;
}

export interface SlackHistorySnapshot {
  readonly messages: readonly SlackHistoryMessage[];
  /** True only when the provider confirmed that the returned set is complete. */
  readonly complete: boolean;
  readonly binding: SlackHistoryBinding;
}

export interface SlackHistoryTransport {
  history(input: {
    readonly token: string;
    readonly channelId: string;
    readonly binding: SlackHistoryBinding;
    readonly oldest?: string;
  }): Promise<SlackHistorySnapshot>;
}

/** Fetches every page and rejects an ambiguous, partial, cyclic, or malformed history. */
export class FetchSlackHistoryTransport implements SlackHistoryTransport {
  public async history(input: {
    readonly token: string;
    readonly channelId: string;
    readonly binding: SlackHistoryBinding;
    readonly oldest?: string;
  }): Promise<SlackHistorySnapshot> {
    const messages: SlackHistoryMessage[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const query = new URLSearchParams({
        channel: input.channelId,
        limit: "999",
        ...(input.oldest === undefined ? {} : { oldest: input.oldest, inclusive: "true" }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      const response = await globalThis.fetch(`https://slack.com/api/conversations.history?${query.toString()}`, {
        headers: { authorization: `Bearer ${input.token}` },
      });
      if (!response.ok) throw new Error(`Slack conversations.history returned ${String(response.status)}`);
      const body = SlackHistoryResponse.safeParse(await response.json());
      if (!body.success || !body.data.ok) throw new Error("Slack conversations.history returned an invalid response");
      if (body.data.is_limited === true) throw new Error("Slack conversations.history is limited");
      messages.push(...body.data.messages);
      const nextCursor = normalizedCursor(body.data.response_metadata?.next_cursor);
      if (body.data.has_more === false) {
        if (nextCursor !== undefined)
          throw new Error("Slack conversations.history returned a contradictory final page");
        return { messages: distinctSlackHistoryMessages(messages), complete: true, binding: input.binding };
      }
      // Missing `has_more` is ambiguous, even when no cursor is present: accepting
      // it would allow a truncated first page to prove exact counts or absence.
      if (body.data.has_more !== true) {
        throw new Error("Slack conversations.history did not positively confirm snapshot completeness");
      }
      if (nextCursor === undefined || seenCursors.has(nextCursor)) {
        throw new Error("Slack conversations.history pagination is incomplete or cyclic");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
}

const SlackHistoryResponse = z
  .object({
    ok: z.literal(true),
    has_more: z.boolean().optional(),
    is_limited: z.boolean().optional(),
    messages: z.array(z.object({ ts: z.string().min(1), text: z.string() }).passthrough()),
    response_metadata: z.object({ next_cursor: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

function normalizedCursor(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.trim() !== value) throw new Error("Slack conversations.history returned a malformed cursor");
  return value;
}

/** Slack `ts` is channel-local identity; repeated provider page rows are corruption. */
export function distinctSlackHistoryMessages(messages: readonly SlackHistoryMessage[]): readonly SlackHistoryMessage[] {
  const byTimestamp = new Map<string, SlackHistoryMessage>();
  for (const message of messages) {
    const prior = byTimestamp.get(message.ts);
    if (prior !== undefined) throw new Error("Slack conversations.history returned duplicate message timestamp");
    byTimestamp.set(message.ts, message);
  }
  return [...byTimestamp.values()];
}
