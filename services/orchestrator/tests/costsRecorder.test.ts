import { describe, expect, it } from "vitest";
import { CostRecorder } from "../src/engine/costs/index.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import type { TokenUsage } from "../src/engine/providers/types.js";

interface InsertedRow {
  table: string;
  params: ReadonlyArray<unknown>;
}

// Recording pool that captures cost_records inserts. No denominator machinery
// exists anymore — subscription windows are percent-of-window limits, not
// token budgets, so there is nothing to refine.
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

const context = {
  runId: "run_test",
  taskId: "task_test",
  specId: "spec_test",
  projectId: "project_test",
};

// Insert param positions (1-based in SQL → 0-based here):
//   6=input, 7=cached_input, 8=cache_creation, 9=output, 10=reasoning,
//   11=total, 12=cost_usd, 13=billing_mode, 14=cost_basis.
const COST_USD = 12;
const BILLING_MODE = 13;
const COST_BASIS = 14;

describe("CostRecorder", () => {
  it("persists a provider_pricing cost row when given a per-token API-key ref", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt-test", authRef: "credential/openai-api/prod" },
      usage({ inputTokens: 1_000_000, totalTokens: 1_000_000 }),
      { foo: "bar" },
    );
    expect(result.billingMode).toBe("per_token");
    expect(result.costBasis).toBe("provider_pricing");
    expect(result.costUsd).not.toBeNull();
    expect(pool.inserts).toHaveLength(1);
    const insertParams = pool.inserts[0]?.params ?? [];
    expect(insertParams[BILLING_MODE]).toBe("per_token");
    expect(insertParams[COST_BASIS]).toBe("provider_pricing");
    expect(events.events.map((event) => event.eventType)).toEqual(["cost.resolved"]);
  });

  it("records a subscription-billed call with cost_usd NULL, cost_basis 'unknown', and a full token breakdown — and does NOT fail", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    const tokens = usage({
      inputTokens: 6980,
      cachedInputTokens: 4480,
      outputTokens: 145,
      reasoningOutputTokens: 316,
      totalTokens: 11921,
    });
    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt-codex", authRef: "credential/codex/dev" },
      tokens,
      { stream: "test" },
    );
    expect(result.billingMode).toBe("subscription");
    expect(result.costBasis).toBe("unknown");
    expect(result.costUsd).toBeNull();
    expect(pool.inserts).toHaveLength(1);
    const params = pool.inserts[0]?.params ?? [];
    expect(params[COST_USD]).toBeNull();
    expect(params[BILLING_MODE]).toBe("subscription");
    expect(params[COST_BASIS]).toBe("unknown");
    // Full disjoint token breakdown lands even though cost is unknown.
    expect(params.slice(6, 12)).toEqual([6980, 4480, 0, 145, 316, 11921]);
    expect(events.events.map((event) => event.eventType)).toEqual(["cost.resolved"]);
  });

  it("records a self-hosted call with cost_usd NULL without failing", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    const result = await recorder.record(
      {
        ...context,
        cli: "fake",
        model: "qwen",
        authRef: "credential/self-hosted/qwen",
        runtimeSeconds: 60,
      },
      usage({}),
      {},
    );
    expect(result.billingMode).toBe("self_hosted");
    expect(result.costBasis).toBe("unknown");
    expect(result.costUsd).toBeNull();
  });

  it("records an unattributable ref as cost_basis 'unknown' without throwing", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt", authRef: "vault/secret/dev/legacy" },
      usage({ inputTokens: 12, outputTokens: 8, totalTokens: 20 }),
      {},
    );
    expect(result.costBasis).toBe("unknown");
    expect(result.costUsd).toBeNull();
    expect(pool.inserts).toHaveLength(1);
    expect(events.events.map((event) => event.eventType)).toEqual(["cost.resolved"]);
  });

  it("never writes a placeholder cost basis to cost_records", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    await recorder.record(
      { ...context, cli: "codex", model: "gpt-codex", authRef: "credential/codex/dev" },
      usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      {},
    );
    const serialized = pool.inserts.flatMap((insert) =>
      insert.params.map((param) => (typeof param === "string" ? param : JSON.stringify(param))),
    );
    expect(serialized.join("\n")).not.toContain(`${"legacy"}_${"unknown"}`);
    expect(serialized.join("\n")).not.toContain("unknown_source");
  });

  it("records a ccusage figure as cost_basis 'ccusage' when given a positive per-call ccusageCostUsd", async () => {
    const pool = new FakeCostPool();
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    const result = await recorder.record(
      {
        ...context,
        cli: "codex",
        model: "gpt-codex",
        authRef: "credential/codex/dev",
        ccusageCostUsd: 0.75,
      },
      usage({ inputTokens: 100, totalTokens: 100 }),
      {},
    );
    expect(result.costBasis).toBe("ccusage");
    expect(result.costUsd).toBe("0.750000");
    expect(pool.inserts[0]?.params[COST_BASIS]).toBe("ccusage");
    expect(pool.inserts[0]?.params[COST_USD]).toBe("0.750000");
  });
});

// Pool that serves a SELECT of run rows and captures the apportioning UPDATEs.
class ReconcilePool {
  readonly updates: Array<{ id: string; costUsd: string }> = [];
  readonly bases: string[] = [];

  constructor(private readonly rows: Array<{ id: string; total_tokens: number }>) {}

  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    if (sql.startsWith("SELECT id, total_tokens FROM cost_records")) {
      return { rows: this.rows, rowCount: this.rows.length };
    }
    if (sql.startsWith("UPDATE cost_records SET cost_usd")) {
      this.updates.push({ id: String(params[0]), costUsd: String(params[1]) });
      if (params[2] !== undefined) {
        this.bases.push(String(params[2]));
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("CostRecorder.reconcileRunCostFromCcusage", () => {
  it("apportions the real ccusage cost across rows by token share so they sum to the total", async () => {
    const pool = new ReconcilePool([
      { id: "1", total_tokens: 750 },
      { id: "2", total_tokens: 250 },
    ]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    const { updated } = await recorder.reconcileRunCostFromCcusage("run_test", 4);
    expect(updated).toBe(2);
    expect(pool.updates).toEqual([
      { id: "1", costUsd: "3.000000" },
      { id: "2", costUsd: "1.000000" },
    ]);
    const summed = pool.updates.reduce((sum, update) => sum + Number(update.costUsd), 0);
    expect(summed).toBeCloseTo(4, 6);
  });

  it("is a no-op for a zero/absent ccusage cost (cost-unknown stays an honest NULL)", async () => {
    const pool = new ReconcilePool([{ id: "1", total_tokens: 100 }]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    expect(await recorder.reconcileRunCostFromCcusage("run_test", 0)).toEqual({ updated: 0 });
    expect(pool.updates).toHaveLength(0);
  });

  it("is a no-op when the run recorded zero tokens (cannot apportion)", async () => {
    const pool = new ReconcilePool([{ id: "1", total_tokens: 0 }]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    expect(await recorder.reconcileRunCostFromCcusage("run_test", 5)).toEqual({ updated: 0 });
    expect(pool.updates).toHaveLength(0);
  });
});

describe("CostRecorder.reconcileRunCostFromCredits", () => {
  it("prices consumed credits at the rate and apportions across rows as cost_basis 'credits'", async () => {
    const pool = new ReconcilePool([
      { id: "1", total_tokens: 750 },
      { id: "2", total_tokens: 250 },
    ]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    // 10 credits × $0.04 = $0.40, split 75/25.
    const { updated } = await recorder.reconcileRunCostFromCredits("run_test", 10, 0.04);
    expect(updated).toBe(2);
    expect(pool.updates).toEqual([
      { id: "1", costUsd: "0.300000" },
      { id: "2", costUsd: "0.100000" },
    ]);
  });

  it("stamps cost_basis 'credits' on the repriced rows", async () => {
    const pool = new ReconcilePool([{ id: "1", total_tokens: 100 }]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    await recorder.reconcileRunCostFromCredits("run_test", 5, 0.04);
    expect(pool.bases).toEqual(["credits"]);
  });

  it("is a no-op for zero credits consumed or a non-positive rate", async () => {
    const pool = new ReconcilePool([{ id: "1", total_tokens: 100 }]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    expect(await recorder.reconcileRunCostFromCredits("run_test", 0, 0.04)).toEqual({ updated: 0 });
    expect(await recorder.reconcileRunCostFromCredits("run_test", 10, 0)).toEqual({ updated: 0 });
    expect(pool.updates).toHaveLength(0);
  });
});
