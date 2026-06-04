// Recorder-level tests for the `provider_response` (OpenRouter real usage.cost)
// real-spend FACT path. Split out of costsRecorder.test.ts to keep that file
// under the 500-line architecture cap. REAL SPEND IS A FACT: cost_usd is set ONLY
// from a captured real figure; with NO fact it is NULL (no list-rate estimate, no
// estimateOnly flag — that path is gone). NOTIONAL is a SEPARATE figure computed
// from the maintained LiteLLM model price.
import { describe, expect, it } from "vitest";
import { CostRecorder } from "../src/engine/costs/index.js";
import { ModelPriceSource, type ModelPriceMap } from "../src/engine/costs/pricing/modelPriceSource.js";
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

// Injected price source: `deepseek` priced at 5/M input so NOTIONAL is deterministic
// and deliberately distinct from a captured real figure.
const fixturePriceMap: ModelPriceMap = {
  deepseek: { litellm_provider: "openrouter", mode: "chat", input_cost_per_token: 5e-6, output_cost_per_token: 1.5e-5 },
  gpt: { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
};
const priceSource = new ModelPriceSource(fixturePriceMap);
function makeRecorder(pool: FakeCostPool, events: FakeEventStore): CostRecorder {
  return new CostRecorder(pool as never, events, undefined, undefined, priceSource);
}

const context = { runId: "run_test", taskId: "task_test", specId: "spec_test", projectId: "project_test" };

// Insert param positions (1-based in SQL → 0-based here): 12=cost_usd,
// 13=notional_cost_usd, 14=billing_mode, 15=cost_basis.
const COST_USD = 12;
const NOTIONAL_COST_USD = 13;
const COST_BASIS = 15;

describe("CostRecorder — provider_response (OpenRouter real usage.cost) is a metered FACT", () => {
  it("records OpenRouter's REAL usage.cost as cost_basis 'provider_response' — cost_usd is the real figure", async () => {
    // The accurate path: a captured OpenRouter `usage.cost` IS the REAL deduction, so
    // it sets cost_usd directly. NOTIONAL stays the model-price value (honestly
    // distinct from the real charge).
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = makeRecorder(pool, events);
    const result = await recorder.record(
      {
        ...context,
        cli: "aider",
        model: "deepseek",
        authRef: "credential/openrouter/platform/default",
        realProviderCostUsd: 0.0731,
      },
      // deepseek list rate 5/M input → 1M input = $5.00 notional (≠ the real $0.0731).
      usage({ inputTokens: 1_000_000, totalTokens: 1_000_000 }),
      {},
    );
    expect(result.billingMode).toBe("per_token");
    expect(result.costBasis).toBe("provider_response");
    expect(result.costUsd).toBe("0.073100");
    // Notional is the model-price value, deliberately distinct from real spend.
    expect(result.notionalCostUsd).toBe("5.000000");
    const params = pool.inserts[0]?.params ?? [];
    expect(params[COST_BASIS]).toBe("provider_response");
    expect(params[COST_USD]).toBe("0.073100");
    expect(params[NOTIONAL_COST_USD]).toBe("5.000000");
    const resolved = events.events.find((e) => e.eventType === "cost.resolved");
    expect(resolved?.payload).toMatchObject({ costBasis: "provider_response" });
  });

  it("an OpenRouter per_token row with NO captured cost records cost_usd NULL (no estimate, no estimateOnly)", async () => {
    // No real usage.cost was captured. REAL SPEND IS A FACT: cost_usd is NULL with
    // cost_basis 'unknown' — there is NO static-table estimate and NO estimateOnly
    // flag (that path is gone). NOTIONAL is still computed from the model price.
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = makeRecorder(pool, events);
    const result = await recorder.record(
      { ...context, cli: "aider", model: "deepseek", authRef: "credential/openrouter/platform/default" },
      usage({ inputTokens: 1_000_000, totalTokens: 1_000_000 }),
      {},
    );
    expect(result.costBasis).toBe("unknown");
    expect(result.costUsd).toBeNull();
    expect(result.notionalCostUsd).toBe("5.000000");
    const params = pool.inserts[0]?.params ?? [];
    expect(params[COST_USD]).toBeNull();
    expect(params[NOTIONAL_COST_USD]).toBe("5.000000");
    const resolved = events.events.find((e) => e.eventType === "cost.resolved");
    expect(resolved?.payload).toMatchObject({ costBasis: "unknown" });
    // The estimateOnly field is no longer emitted at all.
    expect(resolved?.payload).not.toHaveProperty("estimateOnly");
  });

  it("a BYOK openai per_token call with no fact records cost_usd NULL but a model-priced notional", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = makeRecorder(pool, events);
    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt", authRef: "credential/openai-api/prod" },
      usage({ inputTokens: 1_000_000, totalTokens: 1_000_000 }),
      {},
    );
    expect(result.costBasis).toBe("unknown");
    expect(result.costUsd).toBeNull();
    // gpt list rate 2.5/M input → 1M input = $2.50 notional.
    expect(result.notionalCostUsd).toBe("2.500000");
  });
});
