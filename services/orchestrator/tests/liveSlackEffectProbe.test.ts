import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { EffectObservation } from "../src/engine/contracts/sideEffectObserverAdapter.js";
import type { AppendEventInput, EventStore } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import {
  LiveSlackEffectProbe,
  FetchSlackHistoryTransport,
  type SlackHistoryBinding,
  type LiveSlackEffectBindingCoordinate,
  type SlackHistorySnapshot,
} from "../src/engine/verification/effectObserver/liveSlackEffectProbe.js";
import { distinctSlackHistoryMessages } from "../src/engine/verification/effectObserver/slackHistoryTransport.js";

const CORRELATION = `sha256:${"a".repeat(64)}`;
const COORDINATE: LiveSlackEffectBindingCoordinate = {
  bindingId: "binding-a3",
  bindingGeneration: 3,
  connectionId: "connection-a3",
  authGeneration: 5,
  grantId: "grant-a3",
  grantGeneration: 7,
  channelId: "channel-a3",
};
const BINDING: SlackHistoryBinding = {
  orgId: "org-a3",
  projectId: "project-a3",
  bindingId: "binding-a3",
  bindingGeneration: 3,
  channelId: "channel-a3",
};

class RecordingEvents implements EventStore {
  public readonly appended: AppendEventInput<EventName>[] = [];
  public async append<N extends EventName>(event: AppendEventInput<N>): Promise<void> {
    this.appended.push(event);
  }
}

function fakePool(): pg.Pool {
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

function input(overrides: Partial<Parameters<LiveSlackEffectProbe["effectsForProvider"]>[0]> = {}) {
  return {
    orgId: "org-a3",
    projectId: "project-a3",
    behaviorRevisionId: "behavior-a3",
    runId: "run-a3",
    deliveryRunId: "delivery-a3",
    observer: "slack",
    provider: "slack",
    correlationIds: [CORRELATION],
    triggers: [{ correlationId: CORRELATION, causeOrdinal: 0 }],
    afterWatermark: "10",
    ...overrides,
  };
}

function probe(snapshot: SlackHistorySnapshot) {
  const events = new RecordingEvents();
  const observations: EffectObservation[] = [];
  const effectProbe = new LiveSlackEffectProbe(fakePool(), new InMemorySecretStore(), {
    transport: { history: async () => snapshot },
    coordinateResolver: { resolve: async () => COORDINATE },
    tokenResolver: { resolve: async () => "xoxb-token" },
    repository: {
      lockTrigger: async () => {},
      append: async (_client, raw) => {
        const observation: EffectObservation = { ...raw, createdAt: new Date("2026-07-21T00:00:00.000Z") };
        observations.push(observation);
        return observation;
      },
    },
    eventsForClient: () => events,
    observationId: () => "observation-a3",
  });
  return { effectProbe, events, observations };
}

function historySnapshot(
  messages: SlackHistorySnapshot["messages"],
  overrides: Partial<SlackHistorySnapshot> = {},
): SlackHistorySnapshot {
  return { complete: true, messages, binding: BINDING, ...overrides };
}

describe("LiveSlackEffectProbe — independent A3 effect observation", () => {
  it("records a provider-confirmed effect at the exact sealed binding coordinate", async () => {
    const { effectProbe, events, observations } = probe(historySnapshot([{ ts: "11", text: `sent ${CORRELATION}` }]));

    const result = await effectProbe.effectsForProvider(input());

    expect(result).toHaveLength(1);
    expect(observations[0]).toMatchObject({ classification: "ok", cursor: "11", triggerIdHash: CORRELATION });
    expect(events.appended).toHaveLength(1);
    expect(events.appended[0]).toMatchObject({
      eventType: "behavior.effect.observed",
      runId: "run-a3",
      payload: {
        behaviorRevisionId: "behavior-a3",
        shardId: "a3:binding-a3:3",
        correlationId: CORRELATION,
        deliveryRunId: "delivery-a3",
        causeOrdinal: 0,
        occurrenceCount: 1,
      },
    });
  });

  it("uses the sealed channel/generation coordinate rather than an unbound provider resource", async () => {
    const channels: string[] = [];
    const coordinate = { ...COORDINATE, bindingGeneration: 9, channelId: "sealed-channel-9" };
    const effectProbe = new LiveSlackEffectProbe(fakePool(), new InMemorySecretStore(), {
      transport: {
        history: async ({ channelId }) => {
          channels.push(channelId);
          return historySnapshot([{ ts: "11", text: `sent ${CORRELATION}` }], {
            binding: { ...BINDING, bindingGeneration: 9, channelId: "sealed-channel-9" },
          });
        },
      },
      coordinateResolver: { resolve: async () => coordinate },
      tokenResolver: { resolve: async () => "xoxb-token" },
      repository: { lockTrigger: async () => {}, append: async (_client, raw) => ({ ...raw, createdAt: new Date() }) },
      eventsForClient: () => new RecordingEvents(),
    });

    await effectProbe.effectsForProvider(input());

    expect(channels).toEqual(["sealed-channel-9"]);
  });

  it("DECISIVE negative control: a complete provider snapshot with no match records observed absence", async () => {
    const { effectProbe, events, observations } = probe(historySnapshot([{ ts: "11", text: "unrelated" }]));

    const result = await effectProbe.effectsForProvider(input());

    expect(result).toHaveLength(1);
    expect(observations[0]).toMatchObject({ classification: "missing", occurrenceCount: 0, cursor: "10" });
    expect(events.appended[0]).toMatchObject({
      eventType: "behavior.effect.missing",
      payload: { triggerIdHash: CORRELATION },
    });
  });

  it("FAIL-CLOSED: a paginated or otherwise incomplete provider snapshot cannot prove absence", async () => {
    const { effectProbe, events, observations } = probe(historySnapshot([], { complete: false }));

    await expect(effectProbe.effectsForProvider(input())).rejects.toThrow("snapshot is incomplete or malformed");

    expect(observations).toHaveLength(0);
    expect(events.appended).toHaveLength(0);
  });

  it("FAIL-CLOSED: limited or cross-tenant history cannot certify an effect", async () => {
    const { effectProbe, events, observations } = probe(
      historySnapshot([{ ts: "11", text: `sent ${CORRELATION}` }], {
        binding: { ...BINDING, orgId: "other-org" },
      }),
    );

    await expect(effectProbe.effectsForProvider(input())).rejects.toThrow("snapshot is incomplete or malformed");
    expect(observations).toHaveLength(0);
    expect(events.appended).toHaveLength(0);
  });

  it("FAIL-CLOSED: a Slack first page without explicit has_more=false is inconclusive, never complete", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        messages: Array.from({ length: 1000 }, (_, index) => ({ ts: String(index), text: "x" })),
      }),
    });
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(
        new FetchSlackHistoryTransport().history({ token: "xoxb", channelId: "channel-a3", binding: BINDING }),
      ).rejects.toThrow("did not positively confirm snapshot completeness");
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetches every Slack page and only returns a snapshot after an explicit final page", async () => {
    const fetch = vi
      .fn<(url: string, init?: RequestInit) => Promise<unknown>>()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          has_more: true,
          messages: [{ ts: "12", text: "new" }],
          response_metadata: { next_cursor: "next-page" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, has_more: false, messages: [{ ts: "11", text: "old" }] }),
      });
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(
        new FetchSlackHistoryTransport().history({ token: "xoxb", channelId: "channel-a3", binding: BINDING }),
      ).resolves.toEqual({
        complete: true,
        messages: [
          { ts: "12", text: "new" },
          { ts: "11", text: "old" },
        ],
        binding: BINDING,
      });
      expect(fetch.mock.calls[1]?.[0]).toContain("cursor=next-page");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects is_limited and duplicate message timestamps instead of certifying them", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, has_more: false, is_limited: true, messages: [] }),
    });
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(
        new FetchSlackHistoryTransport().history({ token: "xoxb", channelId: "channel-a3", binding: BINDING }),
      ).rejects.toThrow("is limited");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(() =>
      distinctSlackHistoryMessages([
        { ts: "11", text: "same" },
        { ts: "11", text: "same" },
      ]),
    ).toThrow("duplicate message timestamp");
  });

  it("captures the latest complete provider cursor before a live trigger", async () => {
    const { effectProbe } = probe(
      historySnapshot([
        { ts: "20", text: "new" },
        { ts: "11", text: "old" },
      ]),
    );

    await expect(
      effectProbe.captureWatermark({
        orgId: "org-a3",
        projectId: "project-a3",
        behaviorRevisionId: "behavior-a3",
        deliveryRunId: "delivery-a3",
        observer: "slack",
        provider: "slack",
      }),
    ).resolves.toMatchObject({ cursor: "20", bindingId: "binding-a3", bindingGeneration: 3 });
  });
});
