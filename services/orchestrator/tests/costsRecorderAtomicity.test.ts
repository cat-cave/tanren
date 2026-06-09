// ATOMICITY SEAM (audit RC-4 #1): the cost_records row INSERT and its `cost.resolved`
// event append are two separate awaits — a crash/failure between them must NEVER lose
// the committed spend row, and a missing event must be LOUD, not silent. The recorder
// keeps the ROW authoritative (the budget gate's `sumSpend` reads `cost_records.cost_usd`
// DIRECTLY — row-is-truth) and treats a post-row event append failure as loud-but-non-
// fatal (a console.error `cost.event_append_failed` signal, never a post-commit throw).

import { describe, expect, it, vi } from "vitest";
import { CostRecorder } from "../src/engine/costs/index.js";
import { ModelPriceSource, type ModelPriceMap } from "../src/engine/costs/pricing/modelPriceSource.js";
import type { AppendEventInput, EventStore } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import type { TokenUsage } from "../src/engine/providers/types.js";

const fixturePriceMap: ModelPriceMap = {
  "gpt-codex": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
  gpt: { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
};
const priceSource = new ModelPriceSource(fixturePriceMap);

interface InsertedRow {
  params: ReadonlyArray<unknown>;
}

// Recording pool that captures cost_records inserts (same shape as costsRecorder.test.ts).
class FakeCostPool {
  readonly inserts: InsertedRow[] = [];
  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    if (sql.trim().startsWith("INSERT INTO cost_records")) {
      this.inserts.push({ params });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

// An EventStore whose append() THROWS — models the event write failing AFTER the
// authoritative cost_records row has already committed.
class ThrowingEventStore implements EventStore {
  appendCalls = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(_input: AppendEventInput<N>): Promise<void> {
    this.appendCalls += 1;
    throw new Error("event store unavailable");
  }
}

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    ...partial,
  };
}

const context = { runId: "run_test", taskId: "task_test", specId: "spec_test", projectId: "project_test" };

// cost_usd is the 13th INSERT value (index 12) — see costsRecorder.test.ts.
const COST_USD = 12;

// A faithful in-memory model of the budget gate's ROW-IS-TRUTH sum: sum the cost_usd
// column of the INSERTed rows, exactly as budgetGate.sumSpend reads cost_records.cost_usd
// DIRECTLY (NEVER the cost.resolved event).
function rowSumSpend(pool: FakeCostPool): number {
  return pool.inserts.reduce((sum, row) => sum + (row.params[COST_USD] === null ? 0 : Number(row.params[COST_USD])), 0);
}

function makeRecorder(pool: FakeCostPool, events: EventStore): CostRecorder {
  return new CostRecorder(pool as never, events, undefined, undefined, priceSource);
}

describe("CostRecorder atomicity (audit RC-4 #1): committed spend row is never lost; missing event is LOUD not silent", () => {
  it("when eventStore.append THROWS after the cost_records INSERT, the row IS present + record resolves + a loud signal is logged", async () => {
    const pool = new FakeCostPool();
    const events = new ThrowingEventStore();
    const recorder = makeRecorder(pool, events);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // record() MUST NOT throw for a post-commit event failure — the spend row committed.
    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt-codex", authRef: "credential/openai-api/prod", ccusageCostUsd: 0.5 },
      usage({ inputTokens: 100, totalTokens: 100 }),
      {},
    );

    // The committed row is present with its real spend — row-is-truth survives.
    expect(pool.inserts).toHaveLength(1);
    expect(pool.inserts[0]?.params[COST_USD]).toBe("0.500000");
    expect(result.costUsd).toBe("0.500000");
    // The event append WAS attempted (then failed).
    expect(events.appendCalls).toBe(1);
    // The failure is LOUD (console.error), never silent.
    expect(consoleSpy).toHaveBeenCalled();
    const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("cost.event_append_failed");
    // The budget gate's ROW-BASED sum is UNAFFECTED by the missing event.
    expect(rowSumSpend(pool)).toBeCloseTo(0.5, 6);

    consoleSpy.mockRestore();
  });

  it("a row with a captured fact still commits + budget-gate-sums even when EVERY cost event append fails", async () => {
    // An UNRECOGNIZED ref would normally emit BOTH cost.resolved AND cost.unattributed;
    // every append throws, yet the row commits and record resolves (no post-commit throw).
    const pool = new FakeCostPool();
    const events = new ThrowingEventStore();
    const recorder = makeRecorder(pool, events);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt", authRef: "vault/secret/dev/legacy" },
      usage({ inputTokens: 12, outputTokens: 8, totalTokens: 20 }),
      {},
    );

    expect(result.billingMode).toBe("unattributed");
    expect(pool.inserts).toHaveLength(1);
    // The cost.resolved append was attempted (and the loud cost.unattributed too — each non-fatal).
    expect(events.appendCalls).toBeGreaterThanOrEqual(1);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
