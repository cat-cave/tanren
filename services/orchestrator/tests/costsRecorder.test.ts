import { describe, expect, it } from "vitest";
import { CostRecorder } from "../src/engine/costs/index.js";
import { ModelPriceSource, type ModelPriceMap } from "../src/engine/costs/pricing/modelPriceSource.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import type { TokenUsage } from "../src/engine/providers/types.js";

// Deterministic INJECTED model-price source so NOTIONAL is computed against known
// rates (not the vendored file). The recorder test models below are keyed into it.
// `gpt-test`/`gpt-codex`/`gpt`: 2.5/M in, 10/M out (openai-shaped, cost PER TOKEN).
const fixturePriceMap: ModelPriceMap = {
  "gpt-test": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
  "gpt-codex": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
  gpt: { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
};
const priceSource = new ModelPriceSource(fixturePriceMap);

// Build a recorder whose NOTIONAL estimate resolves against the fixture price map.
function makeRecorder(pool: unknown, events: FakeEventStore = new FakeEventStore()): CostRecorder {
  return new CostRecorder(pool as never, events, undefined, undefined, priceSource);
}

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
//   11=total, 12=cost_usd, 13=notional_cost_usd, 14=billing_mode, 15=cost_basis.
const COST_USD = 12;
const NOTIONAL_COST_USD = 13;
const BILLING_MODE = 14;
const COST_BASIS = 15;

describe("CostRecorder", () => {
  it("persists a per_token API-key call with cost_usd NULL (no captured fact) but a NOTIONAL value", async () => {
    // REAL SPEND IS A FACT: a per_token credential with no captured fact records
    // cost_usd = NULL / cost_basis = 'unknown' (no static table). NOTIONAL is still
    // computed from the model price.
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = makeRecorder(pool, events);
    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt-test", authRef: "credential/openai-api/prod" },
      usage({ inputTokens: 1_000_000, totalTokens: 1_000_000 }),
      { foo: "bar" },
    );
    expect(result.billingMode).toBe("per_token");
    expect(result.costBasis).toBe("unknown");
    expect(result.costUsd).toBeNull();
    // gpt-test list rate: 1M input @2.5/M = $2.50 notional.
    expect(result.notionalCostUsd).toBe("2.500000");
    expect(pool.inserts).toHaveLength(1);
    const insertParams = pool.inserts[0]?.params ?? [];
    expect(insertParams[BILLING_MODE]).toBe("per_token");
    expect(insertParams[COST_BASIS]).toBe("unknown");
    expect(insertParams[COST_USD]).toBeNull();
    expect(insertParams[NOTIONAL_COST_USD]).toBe("2.500000");
    expect(events.events.map((event) => event.eventType)).toEqual(["cost.resolved"]);
  });

  it("records a subscription-billed call with cost_usd NULL, cost_basis 'unknown', and a full token breakdown — and does NOT fail", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = makeRecorder(pool, events);
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
    // NOTIONAL value IS computed for the subscription call (model price) even
    // though REAL spend is NULL — the comparable, forecastable figure.
    expect(result.notionalCostUsd).not.toBeNull();
    expect(pool.inserts).toHaveLength(1);
    const params = pool.inserts[0]?.params ?? [];
    expect(params[COST_USD]).toBeNull();
    expect(params[NOTIONAL_COST_USD]).not.toBeNull();
    expect(params[BILLING_MODE]).toBe("subscription");
    expect(params[COST_BASIS]).toBe("unknown");
    // Full disjoint token breakdown lands even though cost is unknown.
    expect(params.slice(6, 12)).toEqual([6980, 4480, 0, 145, 316, 11921]);
    expect(events.events.map((event) => event.eventType)).toEqual(["cost.resolved"]);
  });

  it("records a self-hosted call with cost_usd NULL without failing", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = makeRecorder(pool, events);
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
    const recorder = makeRecorder(pool, events);
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
    const recorder = makeRecorder(pool, events);
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
    const recorder = makeRecorder(pool, events);
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
    const recorder = makeRecorder(pool);
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
    // For a per_token ccusage call REAL == NOTIONAL — both columns carry the figure.
    expect(result.notionalCostUsd).toBe("0.750000");
    expect(pool.inserts[0]?.params[COST_BASIS]).toBe("ccusage");
    expect(pool.inserts[0]?.params[COST_USD]).toBe("0.750000");
    expect(pool.inserts[0]?.params[NOTIONAL_COST_USD]).toBe("0.750000");
  });

  it("records a subscription call with notional_cost_usd populated (tokens × model price) AND cost_usd NULL", async () => {
    // The headline of the notional-vs-real split: a flat-fee subscription has $0
    // REAL marginal spend (cost_usd NULL), but its tokens DO have a comparable
    // NOTIONAL list value (model price) — recorded in notional_cost_usd.
    const pool = new FakeCostPool();
    const recorder = makeRecorder(pool);
    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt-codex", authRef: "credential/codex/dev" },
      // openai: input 2.5/M → 1M input = $2.50; output 10/M → 0.5M = $5.00 → $7.50.
      usage({ inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 }),
      {},
    );
    expect(result.billingMode).toBe("subscription");
    expect(result.costUsd).toBeNull();
    expect(result.notionalCostUsd).toBe("7.500000");
    const params = pool.inserts[0]?.params ?? [];
    expect(params[COST_USD]).toBeNull();
    expect(params[NOTIONAL_COST_USD]).toBe("7.500000");
  });

  it("records a per_token call with NO captured fact as cost_usd NULL but notional from the model price", async () => {
    // REAL SPEND IS A FACT: no captured fact → cost_usd NULL (no static table). The
    // NOTIONAL value IS computed (gpt list rate: 1M in @2.5 + 0.5M out @10 = $7.50).
    const pool = new FakeCostPool();
    const recorder = makeRecorder(pool);
    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt", authRef: "credential/openai-api/prod" },
      usage({ inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 }),
      {},
    );
    expect(result.costBasis).toBe("unknown");
    expect(result.costUsd).toBeNull();
    expect(result.notionalCostUsd).toBe("7.500000");
    const params = pool.inserts[0]?.params ?? [];
    expect(params[COST_USD]).toBeNull();
    expect(params[NOTIONAL_COST_USD]).toBe("7.500000");
  });

  it("records an UNRECOGNIZED ref with BOTH cost_usd AND notional_cost_usd NULL (unpriced on both axes)", async () => {
    const pool = new FakeCostPool();
    const recorder = makeRecorder(pool);
    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt", authRef: "vault/secret/dev/legacy" },
      usage({ inputTokens: 12, outputTokens: 8, totalTokens: 20 }),
      {},
    );
    expect(result.costUsd).toBeNull();
    expect(result.notionalCostUsd).toBeNull();
    const params = pool.inserts[0]?.params ?? [];
    expect(params[COST_USD]).toBeNull();
    expect(params[NOTIONAL_COST_USD]).toBeNull();
  });

  it("prefers a positive ccusage figure as notional on a subscription call (more accurate than the model rate)", async () => {
    const pool = new FakeCostPool();
    const recorder = makeRecorder(pool);
    const result = await recorder.record(
      // A subscription cred WITH a ccusage figure: real spend stays NULL (subscription
      // ccusage is dropped from real spend), but notional prefers the ccusage value.
      { ...context, cli: "codex", model: "gpt-codex", authRef: "credential/codex/dev", ccusageCostUsd: 1.5 },
      usage({ inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 }),
      {},
    );
    expect(result.billingMode).toBe("subscription");
    expect(result.costUsd).toBeNull();
    // ccusage 1.5 preferred over the $7.50 model-price notional.
    expect(result.notionalCostUsd).toBe("1.500000");
    expect(pool.inserts[0]?.params[NOTIONAL_COST_USD]).toBe("1.500000");
  });
});

// Pool that serves a SELECT of run rows (now carrying billing_mode) and captures
// BOTH apportioning columns the two-axis reconcile writes:
//   - a per_token ccusage row → `UPDATE ... SET cost_usd = $2, notional_cost_usd = $2`
//     (real == notional);
//   - a non-per_token ccusage row → `UPDATE ... SET notional_cost_usd = $2` (notional
//     ONLY; real stays NULL);
//   - a credits row → `UPDATE ... SET cost_usd = $2` (real spend; notional untouched).
// The capture distinguishes which column(s) each row got so a test can prove the
// per-mode rule (notional on ALL, real on per_token ONLY).
class ReconcilePool {
  // Backwards-compatible `updates` = rows that received a REAL `cost_usd` write
  // (so the existing per-token/credits assertions read unchanged).
  readonly updates: Array<{ id: string; costUsd: string }> = [];
  // Rows that received a NOTIONAL `notional_cost_usd` write (the ALL-rows axis).
  readonly notionalUpdates: Array<{ id: string; notionalCostUsd: string }> = [];
  readonly bases: string[] = [];

  constructor(private readonly rows: Array<{ id: string; total_tokens: number; billing_mode?: string }>) {}

  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    if (sql.startsWith("SELECT id, total_tokens, billing_mode FROM cost_records")) {
      // A row with no explicit billing_mode is an ordinary per_token (real-API) row
      // — the default the legacy apportionment cases assume.
      const rows = this.rows.map((row) => ({ ...row, billing_mode: row.billing_mode ?? "per_token" }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE cost_records SET")) {
      const id = String(params[0]);
      const value = String(params[1]);
      this.bases.push(String(params[2]));
      // Match `SET cost_usd = $2` precisely — note `notional_cost_usd = $2` also
      // CONTAINS the substring `cost_usd = $2`, so anchor on the `SET ` prefix.
      if (sql.includes("SET cost_usd = $2")) {
        this.updates.push({ id, costUsd: value });
      }
      if (sql.includes("notional_cost_usd = $2")) {
        this.notionalUpdates.push({ id, notionalCostUsd: value });
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

  it("is a no-op when the run recorded zero tokens (cannot apportion) — see costsReconcileLoud for the loud event", async () => {
    const pool = new ReconcilePool([{ id: "1", total_tokens: 0 }]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    expect(await recorder.reconcileRunCostFromCcusage("run_test", 5)).toEqual({ updated: 0 });
    expect(pool.updates).toHaveLength(0);
  });

  it("ccusage sets notional on ALL rows but real (cost_usd) on per_token rows ONLY (apex-v19 regression, two-axis)", async () => {
    // A run mixing a real-API (per_token) row and subscription rows. The ccusage total
    // is the NOTIONAL value of ALL the run's tokens, so it apportions across EVERY row
    // by token share into notional_cost_usd. But REAL spend (cost_usd) lands ONLY on
    // the per_token row — the subscription rows keep their NULL real spend (the exact
    // bug that mis-billed apex v19 $58.55 of phantom subscription real-spend).
    const pool = new ReconcilePool([
      { id: "sub_a", total_tokens: 500, billing_mode: "subscription" },
      { id: "pt", total_tokens: 250, billing_mode: "per_token" },
      { id: "sub_b", total_tokens: 1250, billing_mode: "subscription" },
    ]);
    const recorder = new CostRecorder(pool as never, new FakeEventStore());
    // Denominator is the WHOLE run: 2000 tokens. $4 total → shares 0.25/0.125/0.625.
    const { updated } = await recorder.reconcileRunCostFromCcusage("run_test", 4);
    // All three rows are written (notional on every one).
    expect(updated).toBe(3);
    expect(pool.notionalUpdates).toEqual([
      { id: "sub_a", notionalCostUsd: "1.000000" },
      { id: "pt", notionalCostUsd: "0.500000" },
      { id: "sub_b", notionalCostUsd: "2.500000" },
    ]);
    // REAL spend lands ONLY on the per_token row — its OWN token share, not the whole.
    expect(pool.updates).toEqual([{ id: "pt", costUsd: "0.500000" }]);
    // Every repriced row is stamped basis 'ccusage'.
    expect(pool.bases).toEqual(["ccusage", "ccusage", "ccusage"]);
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
    // A credits reconcile is REAL subscription-overage spend → it writes cost_usd
    // ONLY. The notional_cost_usd each row already carries from write time is left
    // untouched (no notional writes here).
    expect(pool.notionalUpdates).toHaveLength(0);
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

// with a remote-reconcile delegate wired (the worker's de-privileged
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
