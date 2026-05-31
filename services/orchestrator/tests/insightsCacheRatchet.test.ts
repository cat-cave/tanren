// Mutation-ratchet behavior tests for the read-through insight cache
// (`engine/insights/cache.ts`). Drives the InsightsMemoryClient and asserts the
// observable read/write decisions — the freshness cutoff boundary, the
// write-only-when-non-empty guard, the acknowledged-row filter, and the
// decodeRow envelope/fallback decoding — so a surviving mutant on the cutoff
// arithmetic, a length comparison, or an envelope default changes a result the
// test reads back.

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeInsight,
  readFreshInsights,
  readFreshOrCompute,
  writeInsights,
  type Insight,
} from "../src/engine/insights/index.js";
import { InsightsMemoryClient } from "./helpers/insightsMemoryClient.js";

function pool(client: InsightsMemoryClient): pg.Pool {
  return client as unknown as pg.Pool;
}

const NOW = new Date("2026-05-27T12:00:00Z");

function synthetic(overrides: Partial<Insight> = {}): Insight {
  return {
    id: "insight_1",
    kind: "retry_hotspot",
    projectId: "project_a",
    severity: "warn",
    title: "Test title",
    body: "Test body",
    payload: {
      kind: "retry_hotspot",
      specId: "spec_a",
      specTitle: "Spec A",
      writerCli: "codex",
      writerModel: "gpt-5",
      retryCount: 2,
      windowDays: 7,
      rejectionSummaries: ["r1"],
    },
    actions: [{ label: "Ack", toolCall: { tool: "tanren.acknowledge_insight", args: { insightId: "insight_1" } } }],
    computedAt: NOW,
    acknowledgedAt: null,
    acknowledgedBy: null,
    ...overrides,
  } as Insight;
}

describe("readFreshInsights — freshness cutoff boundary", () => {
  it("returns a row computed exactly inside the freshness window but drops one outside", async () => {
    const client = new InsightsMemoryClient();
    await writeInsights(pool(client), [
      synthetic({ id: "fresh", computedAt: new Date(NOW.getTime() - 30 * 60 * 1000) }),
    ]);
    await writeInsights(pool(client), [
      synthetic({ id: "stale", computedAt: new Date(NOW.getTime() - 90 * 60 * 1000) }),
    ]);
    // cutoff = now - 60min; fresh(30min old) > cutoff, stale(90min old) < cutoff.
    const rows = await readFreshInsights(pool(client), {
      projectId: "project_a",
      kind: "retry_hotspot",
      now: NOW,
      cacheFreshnessMs: 60 * 60 * 1000,
    });
    expect(rows.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("reconstructs the full Insight from the stored envelope (title/body/severity/actions)", async () => {
    const client = new InsightsMemoryClient();
    await writeInsights(pool(client), [synthetic()]);
    const rows = await readFreshInsights(pool(client), {
      projectId: "project_a",
      kind: "retry_hotspot",
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.title).toBe("Test title");
    expect(r.body).toBe("Test body");
    expect(r.severity).toBe("warn");
    expect(r.actions).toHaveLength(1);
    expect((r.payload as Extract<typeof r.payload, { kind: "retry_hotspot" }>).retryCount).toBe(2);
  });
});

describe("readFreshOrCompute — write guard + source label", () => {
  it("does NOT persist when compute returns an empty list (the > 0 write guard)", async () => {
    const client = new InsightsMemoryClient();
    const compute = vi.fn<() => Promise<Insight[]>>(async () => []);
    const result = await readFreshOrCompute(pool(client), {
      projectId: "project_a",
      kind: "retry_hotspot",
      now: NOW,
      compute,
    });
    expect(result.source).toBe("compute");
    expect(result.insights).toHaveLength(0);
    expect(client.insights).toHaveLength(0);
  });

  it("persists computed rows and labels the source 'compute' on a cold cache", async () => {
    const client = new InsightsMemoryClient();
    const compute = vi.fn<() => Promise<Insight[]>>(async () => [synthetic()]);
    const result = await readFreshOrCompute(pool(client), {
      projectId: "project_a",
      kind: "retry_hotspot",
      now: NOW,
      compute,
    });
    expect(result.source).toBe("compute");
    expect(client.insights).toHaveLength(1);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("serves from cache (source 'cache') without calling compute when a fresh row exists", async () => {
    const client = new InsightsMemoryClient();
    await writeInsights(pool(client), [synthetic()]);
    const compute = vi.fn<() => Promise<Insight[]>>(async () => [synthetic({ id: "other" })]);
    const result = await readFreshOrCompute(pool(client), {
      projectId: "project_a",
      kind: "retry_hotspot",
      now: new Date(NOW.getTime() + 10 * 60 * 1000),
      compute,
    });
    expect(result.source).toBe("cache");
    expect(compute).not.toHaveBeenCalled();
    expect(result.insights[0]!.id).toBe("insight_1");
  });
});

describe("acknowledgeInsight — single-flip semantics", () => {
  it("flips an un-acknowledged row to true once, then false, and hides it from fresh reads", async () => {
    const client = new InsightsMemoryClient();
    await writeInsights(pool(client), [synthetic()]);
    expect(await acknowledgeInsight(pool(client), "insight_1", "user_a", NOW)).toBe(true);
    expect(await acknowledgeInsight(pool(client), "insight_1", "user_a", NOW)).toBe(false);
    const rows = await readFreshInsights(pool(client), {
      projectId: "project_a",
      kind: "retry_hotspot",
      now: NOW,
    });
    expect(rows).toHaveLength(0);
  });

  it("returns false for an unknown insight id", async () => {
    const client = new InsightsMemoryClient();
    expect(await acknowledgeInsight(pool(client), "nope", "user_a", NOW)).toBe(false);
  });
});

describe("writeInsights — idempotent insert", () => {
  it("is a no-op for an empty list", async () => {
    const client = new InsightsMemoryClient();
    await writeInsights(pool(client), []);
    expect(client.insights).toHaveLength(0);
  });

  it("does not duplicate a row on conflicting id (ON CONFLICT DO NOTHING)", async () => {
    const client = new InsightsMemoryClient();
    await writeInsights(pool(client), [synthetic()]);
    await writeInsights(pool(client), [synthetic({ title: "changed" })]);
    expect(client.insights).toHaveLength(1);
  });
});
