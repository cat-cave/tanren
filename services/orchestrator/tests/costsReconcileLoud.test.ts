import { describe, expect, it } from "vitest";
import { CostRecorder } from "../src/engine/costs/index.js";
import { ModelPriceSource } from "../src/engine/costs/pricing/modelPriceSource.js";
import type { TokenUsage } from "../src/engine/providers/types.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

// A minimal insert-capturing pool for the record() path. The notional price source
// below knows ONLY `gpt-priced`, so any other model is unpriced.
class InsertPool {
  async query(sql: string): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    return { rows: [], rowCount: sql.trim().startsWith("INSERT INTO cost_records") ? 1 : 0 };
  }
}
const onlyGptPriced = new ModelPriceSource({
  "gpt-priced": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
});
const recordContext = { runId: "run_test", taskId: "task_test", specId: "spec_test", projectId: "project_test" };
function tokens(partial: Partial<TokenUsage>): TokenUsage {
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

describe("CostRecorder.record — loud cost.notional_unpriced (finding 6)", () => {
  it("LOUD when a token-bearing call's model is UNPRICED in the notional source", async () => {
    const events = new FakeEventStore();
    const recorder = new CostRecorder(new InsertPool() as never, events, undefined, undefined, onlyGptPriced);
    const result = await recorder.record(
      { ...recordContext, cli: "codex", model: "unpriced-model", authRef: "credential/openai-api/prod" },
      tokens({ inputTokens: 1_000, totalTokens: 1_000 }),
      {},
    );
    expect(result.notionalCostUsd).toBeNull();
    expect(events.events.find((e) => e.eventType === "cost.notional_unpriced")?.payload).toMatchObject({
      model: "unpriced-model",
      cli: "codex",
    });
  });

  it("QUIET for a ZERO-token row whose model is unpriced (legitimate-empty, no notional event)", async () => {
    const events = new FakeEventStore();
    const recorder = new CostRecorder(new InsertPool() as never, events, undefined, undefined, onlyGptPriced);
    await recorder.record(
      { ...recordContext, cli: "codex", model: "unpriced-model", authRef: "credential/openai-api/prod" },
      tokens({ totalTokens: 0 }),
      {},
    );
    expect(events.events.map((e) => e.eventType)).toEqual(["cost.resolved"]);
  });
});

// Silent-fallback hardening (finding 7): a run-end reconcile that resolves a
// POSITIVE real dollar total but can apply it to NO cost_records row (no rows for
// the run, or a zero total-token denominator) must NOT silently return
// `{ updated: 0 }` — the observed real spend would vanish. It emits the LOUD
// `cost.reconcile_failed` event so the lost attribution is visible.

// A minimal cost_records pool: the reconcile SELECT returns the seeded rows; the
// failure-path `SELECT project_id, spec_id FROM runs` returns nothing (the emitter
// tolerates a missing project id). No UPDATEs are exercised on the failure paths.
class ReconcilePool {
  constructor(private readonly rows: Array<{ id: string; total_tokens: number }>) {}
  async query(sql: string): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    if (sql.startsWith("SELECT id, total_tokens, billing_mode FROM cost_records")) {
      const rows = this.rows.map((row) => ({ ...row, billing_mode: "per_token" }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("CostRecorder reconcile — loud cost.reconcile_failed", () => {
  it("LOUD when a POSITIVE total hits a zero-token denominator (not a silent no-op)", async () => {
    const events = new FakeEventStore();
    const recorder = new CostRecorder(new ReconcilePool([{ id: "1", total_tokens: 0 }]) as never, events);
    expect(await recorder.reconcileRunCostFromCcusage("run_test", 5)).toEqual({ updated: 0 });
    expect(events.events.find((e) => e.eventType === "cost.reconcile_failed")?.payload).toMatchObject({
      basis: "ccusage",
      totalCostUsd: 5,
      reason: "zero_token_denominator",
    });
  });

  it("LOUD when a POSITIVE total can find NO rows (observed spend must not vanish)", async () => {
    const events = new FakeEventStore();
    const recorder = new CostRecorder(new ReconcilePool([]) as never, events);
    expect(await recorder.reconcileRunCostFromCredits("run_test", 10, 0.04)).toEqual({ updated: 0 });
    expect(events.events.find((e) => e.eventType === "cost.reconcile_failed")?.payload).toMatchObject({
      basis: "credits",
      reason: "no_rows",
    });
  });

  it("a ZERO total is a quiet no-op (cost-unknown stays an honest NULL, no loud event)", async () => {
    const events = new FakeEventStore();
    const recorder = new CostRecorder(new ReconcilePool([{ id: "1", total_tokens: 100 }]) as never, events);
    expect(await recorder.reconcileRunCostFromCcusage("run_test", 0)).toEqual({ updated: 0 });
    expect(events.events.find((e) => e.eventType === "cost.reconcile_failed")).toBeUndefined();
  });
});
