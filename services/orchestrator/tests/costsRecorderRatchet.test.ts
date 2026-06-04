// Mutation-ratchet behavior tests for the CostRecorder INSERT shape + the
// token-share apportionment math (`engine/costs/recorder.ts`). Drives a
// recording pool and asserts the persisted column values + the apportioned
// per-row dollars (which must SUM to the run total), so a surviving mutant in
// the param order, the credits multiplication, the share division, the
// finite/positive guards, or the basis stamp flips a value a test reads back.

import { describe, expect, it } from "vitest";
import { CostRecorder } from "../src/engine/costs/index.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import type { TokenUsage } from "../src/engine/providers/types.js";

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

class FakeCostPool {
  readonly inserts: Array<ReadonlyArray<unknown>> = [];
  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: never[]; rowCount: number }> {
    if (sql.trim().startsWith("INSERT INTO cost_records")) {
      this.inserts.push(params);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

// 0-based param positions in the INSERT VALUES list.
const P = {
  taskId: 0,
  runId: 1,
  projectId: 2,
  cli: 3,
  provider: 4,
  model: 5,
  input: 6,
  cached: 7,
  cacheCreation: 8,
  output: 9,
  reasoning: 10,
  total: 11,
  costUsd: 12,
  notionalCostUsd: 13,
  billingMode: 14,
  costBasis: 15,
  sourceRaw: 16,
  userId: 17,
} as const;

describe("CostRecorder.record — exact persisted column shape", () => {
  it("writes every typed token bucket to its own column in order", async () => {
    const pool = new FakeCostPool();
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    await recorder.record(
      { ...context, cli: "codex", model: "gpt-x", authRef: "credential/openai-api/k", userId: "user_7" },
      usage({
        inputTokens: 11,
        cachedInputTokens: 22,
        cacheCreationTokens: 33,
        outputTokens: 44,
        reasoningOutputTokens: 55,
        totalTokens: 165,
      }),
      { foo: "bar" },
    );
    const p = pool.inserts[0]!;
    expect(p[P.taskId]).toBe("task_test");
    expect(p[P.runId]).toBe("run_test");
    expect(p[P.projectId]).toBe("project_test");
    expect(p[P.cli]).toBe("codex");
    expect(p[P.provider]).toBe("openai");
    expect(p[P.model]).toBe("gpt-x");
    expect([p[P.input], p[P.cached], p[P.cacheCreation], p[P.output], p[P.reasoning], p[P.total]]).toEqual([
      11, 22, 33, 44, 55, 165,
    ]);
    expect(p[P.billingMode]).toBe("per_token");
    expect(p[P.costBasis]).toBe("provider_pricing");
    expect(p[P.userId]).toBe("user_7");
  });

  it("serializes cost_source_raw with the authRef, runtimeSeconds, and provenance", async () => {
    const pool = new FakeCostPool();
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    await recorder.record(
      { ...context, cli: "codex", model: "m", authRef: "credential/openai-api/k", runtimeSeconds: 42 },
      usage({ inputTokens: 1, totalTokens: 1 }),
      { stream: "x" },
    );
    const raw = JSON.parse(String(pool.inserts[0]![P.sourceRaw])) as Record<string, unknown>;
    expect(raw.authRef).toBe("credential/openai-api/k");
    expect(raw.runtimeSeconds).toBe(42);
    expect(raw.billingMode).toBe("per_token");
    expect(raw.costBasis).toBe("provider_pricing");
    expect(raw.provider).toBe("openai");
    expect(raw.rawUsage).toEqual({ stream: "x" });
  });

  it("defaults userId and runtimeSeconds to null when absent", async () => {
    const pool = new FakeCostPool();
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    await recorder.record({ ...context, cli: "fake", model: "m", authRef: "credential/self-hosted/q" }, usage({}), {});
    const p = pool.inserts[0]!;
    expect(p[P.userId]).toBeNull();
    const raw = JSON.parse(String(p[P.sourceRaw])) as Record<string, unknown>;
    expect(raw.runtimeSeconds).toBeNull();
  });

  it("routes the cost.resolved event with the resolved provider + basis", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    await recorder.record(
      { ...context, cli: "codex", model: "gpt-x", authRef: "credential/anthropic/k" },
      usage({ outputTokens: 1_000_000, totalTokens: 1_000_000 }),
      {},
    );
    expect(events.events).toHaveLength(1);
    const ev = events.events[0]!;
    expect(ev.eventType).toBe("cost.resolved");
    const payload = ev.payload as { provider: string; costBasis: string; billingMode: string; costUsd: string };
    expect(payload.provider).toBe("anthropic");
    expect(payload.billingMode).toBe("per_token");
    expect(payload.costBasis).toBe("provider_pricing");
    // anthropic output rate 15/M -> $15.00
    expect(payload.costUsd).toBe("15.000000");
  });

  it("delegates to the persist override and does NOT touch the pool when one is wired", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const sentinel = {
      billingMode: "per_token" as const,
      costBasis: "ccusage" as const,
      costUsd: "9.990000",
      notionalCostUsd: "9.990000",
      tokens: usage({ totalTokens: 5 }),
      provider: "openai",
    };
    const recorder = new CostRecorder(pool as never, events, async () => sentinel);
    const result = await recorder.record(
      { ...context, cli: "codex", model: "m", authRef: "credential/openai-api/k" },
      usage({ totalTokens: 5 }),
      {},
    );
    expect(result).toBe(sentinel);
    expect(pool.inserts).toHaveLength(0);
    expect(events.events).toHaveLength(0);
  });
});

class ReconcilePool {
  // Captures REAL `cost_usd` writes (per_token ccusage + all credits rows). Rows with
  // no explicit billing_mode default to per_token, so the legacy apportionment ratchets
  // (which read `updates`) read the same per-row cost_usd dollars unchanged.
  readonly updates: Array<{ id: string; costUsd: string; basis: string }> = [];
  constructor(private readonly rows: Array<{ id: string; total_tokens: number; billing_mode?: string }>) {}
  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    if (sql.startsWith("SELECT id, total_tokens, billing_mode FROM cost_records")) {
      const rows = this.rows.map((row) => ({ ...row, billing_mode: row.billing_mode ?? "per_token" }));
      return { rows, rowCount: rows.length };
    }
    // Capture only the REAL cost_usd writes (per_token ccusage rows write
    // `SET cost_usd = $2, notional_cost_usd = $2`; credits rows write
    // `SET cost_usd = $2`). Anchor on the `SET ` prefix — `notional_cost_usd = $2`
    // CONTAINS the substring `cost_usd = $2`, so a bare includes() would over-match.
    if (sql.startsWith("UPDATE cost_records SET") && sql.includes("SET cost_usd = $2")) {
      this.updates.push({ id: String(params[0]), costUsd: String(params[1]), basis: String(params[2]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE cost_records SET")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("CostRecorder apportionment — token-share split sums to the total", () => {
  it("splits ccusage dollars by exact token share across three rows", async () => {
    const pool = new ReconcilePool([
      { id: "a", total_tokens: 500 },
      { id: "b", total_tokens: 300 },
      { id: "c", total_tokens: 200 },
    ]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    const { updated } = await recorder.reconcileRunCostFromCcusage("run_test", 10);
    expect(updated).toBe(3);
    expect(pool.updates).toEqual([
      { id: "a", costUsd: "5.000000", basis: "ccusage" },
      { id: "b", costUsd: "3.000000", basis: "ccusage" },
      { id: "c", costUsd: "2.000000", basis: "ccusage" },
    ]);
    const summed = pool.updates.reduce((s, u) => s + Number(u.costUsd), 0);
    expect(summed).toBeCloseTo(10, 6);
  });

  it("prices credits as creditsConsumed × rate before apportioning, basis 'credits'", async () => {
    const pool = new ReconcilePool([
      { id: "a", total_tokens: 1 },
      { id: "b", total_tokens: 1 },
    ]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    // 25 credits × $0.04 = $1.00, split 50/50.
    await recorder.reconcileRunCostFromCredits("run_test", 25, 0.04);
    expect(pool.updates).toEqual([
      { id: "a", costUsd: "0.500000", basis: "credits" },
      { id: "b", costUsd: "0.500000", basis: "credits" },
    ]);
  });

  it("is a no-op for a non-positive ccusage total (the > 0 guard)", async () => {
    const pool = new ReconcilePool([{ id: "a", total_tokens: 100 }]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    expect(await recorder.reconcileRunCostFromCcusage("run_test", -1)).toEqual({ updated: 0 });
    expect(pool.updates).toHaveLength(0);
  });

  it("is a no-op for a non-finite credits total", async () => {
    const pool = new ReconcilePool([{ id: "a", total_tokens: 100 }]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    expect(await recorder.reconcileRunCostFromCredits("run_test", Number.POSITIVE_INFINITY, 0.04)).toEqual({
      updated: 0,
    });
    expect(await recorder.reconcileRunCostFromCredits("run_test", 5, Number.NaN)).toEqual({ updated: 0 });
  });

  it("is a no-op when total tokens are zero (cannot divide a share)", async () => {
    const pool = new ReconcilePool([
      { id: "a", total_tokens: 0 },
      { id: "b", total_tokens: 0 },
    ]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    expect(await recorder.reconcileRunCostFromCcusage("run_test", 5)).toEqual({ updated: 0 });
    expect(pool.updates).toHaveLength(0);
  });

  it("requires a STRICTLY positive credit rate (the rate > 0 boundary)", async () => {
    const pool = new ReconcilePool([{ id: "a", total_tokens: 100 }]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    expect(await recorder.reconcileRunCostFromCredits("run_test", 10, 0)).toEqual({ updated: 0 });
    expect(await recorder.reconcileRunCostFromCredits("run_test", 10, -0.04)).toEqual({ updated: 0 });
  });
});
