// Recorder-level tests for the `provider_response` (OpenRouter real usage.cost)
// path and the LOUD `estimateOnly` flag. Split out of costsRecorder.test.ts to
// keep that file under the 500-line architecture cap.
import { describe, expect, it } from "vitest";
import { CostRecorder } from "../src/engine/costs/index.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import type { TokenUsage } from "../src/engine/providers/types.js";

interface InsertedRow {
  table: string;
  params: ReadonlyArray<unknown>;
}

// Recording pool that captures cost_records inserts (mirrors costsRecorder.test.ts).
class FakeCostPool {
  readonly inserts: InsertedRow[] = [];
  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    if (sql.trim().startsWith("INSERT INTO cost_records")) {
      this.inserts.push({ table: "cost_records", params });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
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

// Insert param positions (1-based in SQL → 0-based here): 12=cost_usd,
// 13=notional_cost_usd, 14=billing_mode, 15=cost_basis.
const COST_USD = 12;
const NOTIONAL_COST_USD = 13;
const COST_BASIS = 15;

describe("CostRecorder — provider_response (OpenRouter real usage.cost) + estimateOnly", () => {
  it("records OpenRouter's REAL usage.cost as cost_basis 'provider_response' — cost_usd is the real figure (outranks the static table)", async () => {
    // The accurate path: a captured OpenRouter `usage.cost` is the REAL deduction,
    // so it sets cost_usd directly and OUTRANKS the rate table. Notional stays the
    // list-rate value (it may honestly differ from the real charge).
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    const result = await recorder.record(
      {
        ...context,
        cli: "aider",
        model: "deepseek",
        authRef: "credential/openrouter/platform/default",
        realProviderCostUsd: 0.0731,
      },
      // openrouter list rate 5/M input → 1M input = $5.00 notional (≠ the real $0.0731).
      usage({ inputTokens: 1_000_000, totalTokens: 1_000_000 }),
      {},
    );
    expect(result.billingMode).toBe("per_token");
    expect(result.costBasis).toBe("provider_response");
    expect(result.costUsd).toBe("0.073100");
    // Notional is the static list-rate value, deliberately distinct from real spend.
    expect(result.notionalCostUsd).toBe("5.000000");
    const params = pool.inserts[0]?.params ?? [];
    expect(params[COST_BASIS]).toBe("provider_response");
    expect(params[COST_USD]).toBe("0.073100");
    expect(params[NOTIONAL_COST_USD]).toBe("5.000000");
    // The real figure is NOT an estimate — the cost.resolved event says so.
    const resolved = events.events.find((e) => e.eventType === "cost.resolved");
    expect(resolved?.payload).toMatchObject({ costBasis: "provider_response", estimateOnly: false });
  });

  it("LOUD ESTIMATE: an OpenRouter per_token row priced from the static table flags estimateOnly on cost.resolved", async () => {
    // No real usage.cost was captured (the live state today — the CLI surfaces no
    // generation id). The static-table figure is recorded as provider_pricing BUT
    // the cost.resolved event flags estimateOnly so an operator KNOWS the dollar
    // figure is an estimate, not OpenRouter's real deduction. Never silent.
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    const result = await recorder.record(
      { ...context, cli: "aider", model: "deepseek", authRef: "credential/openrouter/platform/default" },
      usage({ inputTokens: 1_000_000, totalTokens: 1_000_000 }),
      {},
    );
    expect(result.costBasis).toBe("provider_pricing");
    const resolved = events.events.find((e) => e.eventType === "cost.resolved");
    expect(resolved?.payload).toMatchObject({ costBasis: "provider_pricing", estimateOnly: true });
  });

  it("does NOT flag estimateOnly on a real provider_pricing call for a provider with no per-call charge (openai)", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    await recorder.record(
      { ...context, cli: "codex", model: "gpt", authRef: "credential/openai-api/prod" },
      usage({ inputTokens: 1_000_000, totalTokens: 1_000_000 }),
      {},
    );
    const resolved = events.events.find((e) => e.eventType === "cost.resolved");
    expect(resolved?.payload).toMatchObject({ costBasis: "provider_pricing", estimateOnly: false });
  });
});
