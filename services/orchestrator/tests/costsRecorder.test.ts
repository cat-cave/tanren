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

  it("BUDGET-SAFETY C1: records an UNRECOGNIZED ref as 'unattributed' and emits a LOUD cost.unattributed (NOT a silent $0)", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt", authRef: "vault/secret/dev/legacy" },
      usage({ inputTokens: 12, outputTokens: 8, totalTokens: 20 }),
      {},
    );
    // cost_usd is still genuinely NULL (we cannot price it), but the row is flagged
    // 'unattributed' (NOT silently 'unknown'/$0) and a loud event names the misconfig.
    expect(result.billingMode).toBe("unattributed");
    expect(result.costBasis).toBe("unattributed");
    expect(result.costUsd).toBeNull();
    expect(pool.inserts).toHaveLength(1);
    const params = pool.inserts[0]?.params ?? [];
    expect(params[COST_USD]).toBeNull();
    expect(params[BILLING_MODE]).toBe("unattributed");
    expect(params[COST_BASIS]).toBe("unattributed");
    // The recorder emits cost.resolved THEN the loud cost.unattributed.
    expect(events.events.map((event) => event.eventType)).toEqual(["cost.resolved", "cost.unattributed"]);
    const unattributed = events.events.find((event) => event.eventType === "cost.unattributed");
    // The event names the ref KIND only — NEVER the secret value ("legacy").
    expect(unattributed?.payload).toMatchObject({ refKind: "vault/secret/dev" });
    expect(JSON.stringify(unattributed?.payload)).not.toContain("legacy");
  });

  it("does NOT emit cost.unattributed for an honestly-unpriceable subscription ref", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    await recorder.record(
      { ...context, cli: "codex", model: "gpt-codex", authRef: "credential/codex/dev" },
      usage({ inputTokens: 5, totalTokens: 5 }),
      {},
    );
    // A recognized subscription credential is a legitimate NULL-dollar row — no loud event.
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

  it("records a ccusage figure as cost_basis 'ccusage' when given a positive per-call ccusageCostUsd (per-token cred)", async () => {
    // ccusage prices ONLY a real-API (per_token) credential — a subscription's
    // ccusage figure is notional and stays NULL (covered by the subscription test).
    const pool = new FakeCostPool();
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    const result = await recorder.record(
      {
        ...context,
        cli: "codex",
        model: "gpt-codex",
        authRef: "credential/openai-api/prod",
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
// Rows carry an optional `billing_mode` so the ccusage reconcile's per-token
// restriction can be exercised: a SELECT that filters `billing_mode = 'per_token'`
// returns ONLY those rows (matching the real SQL), so a subscription row is never
// apportioned a ccusage dollar.
class ReconcilePool {
  readonly updates: Array<{ id: string; costUsd: string }> = [];
  readonly bases: string[] = [];

  constructor(private readonly rows: Array<{ id: string; total_tokens: number; billing_mode?: string }>) {}

  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    if (sql.startsWith("SELECT id, total_tokens FROM cost_records")) {
      // A row with no explicit billing_mode is an ordinary per_token (real-API) row
      // — the default the legacy apportionment cases assume.
      const rows = sql.includes("billing_mode = 'per_token'")
        ? this.rows.filter((row) => (row.billing_mode ?? "per_token") === "per_token")
        : this.rows;
      return { rows, rowCount: rows.length };
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

  it("apportions a ccusage total across PER_TOKEN rows ONLY — subscription rows stay NULL (apex-v19 regression)", async () => {
    // A run mixing a real-API (per_token) row and subscription rows. ccusage is the
    // notional token-value of the subscription work — NOT real spend — so the
    // reconcile must apportion the ccusage total across the per_token row(s) only,
    // leaving the subscription rows untouched (NULL). This is the exact bug that
    // mis-billed apex v19 $58.55 of phantom subscription spend.
    const pool = new ReconcilePool([
      { id: "sub_a", total_tokens: 500, billing_mode: "subscription" },
      { id: "pt", total_tokens: 250, billing_mode: "per_token" },
      { id: "sub_b", total_tokens: 999, billing_mode: "subscription" },
    ]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    const { updated } = await recorder.reconcileRunCostFromCcusage("run_test", 3);
    // Only the per_token row is priced; it absorbs the WHOLE ccusage total (it is
    // the only row in the per-token denominator).
    expect(updated).toBe(1);
    expect(pool.updates).toEqual([{ id: "pt", costUsd: "3.000000" }]);
    expect(pool.bases).toEqual(["ccusage"]);
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

// Plane-split P3c: with a remote-reconcile delegate wired (the worker's de-privileged
// data-plane mode), the run-end reconcile/apportion must route the cost_records
// SELECT+UPDATEs through the delegate (the control-plane endpoint) instead of
// writing via this.pool — the data plane can no longer UPDATE cost_records (0031).
describe("CostRecorder reconcile remote-delegate routing (plane-split P3c)", () => {
  it("routes reconcileRunCostFromCcusage through the delegate and NEVER touches the pool", async () => {
    const pool = new ReconcilePool([{ id: "1", total_tokens: 100 }]);
    const calls: Array<{ runId: string; totalCostUsd: number; basis: string }> = [];
    const recorder = new CostRecorder(pool as never, new FakeEventStore(), undefined, async (rec) => {
      calls.push(rec);
      return { updated: 7 };
    });
    const result = await recorder.reconcileRunCostFromCcusage("run_test", 4);
    expect(result).toEqual({ updated: 7 });
    expect(calls).toEqual([{ runId: "run_test", totalCostUsd: 4, basis: "ccusage" }]);
    // The whole point: the de-privileged data plane issued NO direct cost_records write.
    expect(pool.updates).toHaveLength(0);
  });

  it("routes reconcileRunCostFromCredits through the delegate with the priced total + 'credits' basis", async () => {
    const pool = new ReconcilePool([{ id: "1", total_tokens: 100 }]);
    const calls: Array<{ runId: string; totalCostUsd: number; basis: string }> = [];
    const recorder = new CostRecorder(pool as never, new FakeEventStore(), undefined, async (rec) => {
      calls.push(rec);
      return { updated: 1 };
    });
    // 10 credits × $0.04 = $0.40 — the recorder resolves the dollar total before delegating.
    await recorder.reconcileRunCostFromCredits("run_test", 10, 0.04);
    expect(calls).toEqual([{ runId: "run_test", totalCostUsd: 0.4, basis: "credits" }]);
    expect(pool.updates).toHaveLength(0);
  });

  it("does NOT delegate (and is a no-op) when the resolved total is zero", async () => {
    const pool = new ReconcilePool([{ id: "1", total_tokens: 100 }]);
    let delegated = false;
    const recorder = new CostRecorder(pool as never, new FakeEventStore(), undefined, async () => {
      delegated = true;
      return { updated: 0 };
    });
    expect(await recorder.reconcileRunCostFromCcusage("run_test", 0)).toEqual({ updated: 0 });
    expect(delegated).toBe(false);
    expect(pool.updates).toHaveLength(0);
  });
});
