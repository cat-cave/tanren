// SaaS Tier-B quota-admission-gate: outcome-level tests for the QuotaPolicy
// implementations + the metering-export read. These assert real DECISIONS and
// real ACCRUAL STATE against a stateful in-memory store — never "a mock was
// called". The fake pg below actually stores org_quotas + cost_records rows and
// executes the policy's SQL against them, so an admit/deny and a counter
// advance are genuine outcomes.

import { describe, expect, it } from "vitest";
import {
  DbQuotaPolicy,
  NoopQuotaPolicy,
  getOrgUsage,
  getRunUsage,
  streamBillableRuns,
} from "../src/engine/quota/index.js";

interface QuotaRow {
  org_id: string;
  window_key: string;
  run_limit: number | null;
  token_limit: number | null;
  credit_limit: number | null;
  runs_used: number;
  tokens_used: number;
  credits_used: number;
}

interface CostRow {
  run_id: string;
  org_id: string;
  total_tokens: number;
  cost_usd: number | null;
  recorded_at: Date;
}

// A tiny stateful pg substitute covering exactly the SQL the quota module
// emits: the DbQuotaPolicy SELECT/UPDATE on org_quotas, and the metering reads
// over cost_records. It stores rows and computes real aggregates so assertions
// are about state, not calls.
class QuotaPool {
  readonly quotas: QuotaRow[] = [];
  readonly costs: CostRow[] = [];

  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("SELECT window_key")) {
      const row = this.quotas.find((q) => q.org_id === params[0] && q.window_key === params[1]);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (trimmed.startsWith("UPDATE org_quotas")) {
      const row = this.quotas.find((q) => q.org_id === params[0] && q.window_key === params[1]);
      if (row === undefined) {
        return { rows: [], rowCount: 0 };
      }
      row.runs_used += Number(params[2]);
      row.tokens_used += Number(params[3]);
      row.credits_used += Number(params[4]);
      return { rows: [], rowCount: 1 };
    }
    if (/FROM cost_records/u.test(trimmed)) {
      return this.aggregateCosts(trimmed, params);
    }
    return { rows: [], rowCount: 0 };
  }

  private aggregateCosts(
    sql: string,
    params: ReadonlyArray<unknown>,
  ): { rows: ReadonlyArray<Record<string, unknown>>; rowCount: number } {
    const byRun = sql.includes("WHERE run_id = $1");
    const filtered = this.costs.filter((c) => (byRun ? c.run_id === params[0] : c.org_id === params[0]));
    const windowed = this.applyWindow(filtered, sql, params, byRun);
    if (sql.includes("GROUP BY run_id")) {
      const runs = [...new Set(windowed.map((c) => c.run_id))].sort();
      return {
        rows: runs.map((runId) => {
          const rows = windowed.filter((c) => c.run_id === runId);
          return {
            run_id: runId,
            tokens: sum(rows.map((r) => r.total_tokens)),
            cost_usd: sum(rows.map((r) => r.cost_usd ?? 0)),
          };
        }),
        rowCount: runs.length,
      };
    }
    const distinctRuns = new Set(windowed.map((c) => c.run_id)).size;
    return {
      rows: [
        {
          runs: byRun ? sum(windowed.map((r) => r.total_tokens)) : distinctRuns,
          tokens: sum(windowed.map((r) => r.total_tokens)),
          cost_usd: sum(windowed.map((r) => r.cost_usd ?? 0)),
        },
      ],
      rowCount: 1,
    };
  }

  private applyWindow(rows: CostRow[], sql: string, params: ReadonlyArray<unknown>, byRun: boolean): CostRow[] {
    if (byRun) {
      return rows;
    }
    let next = rows;
    let index = 1;
    if (sql.includes("recorded_at >=")) {
      const from = params[index] as Date;
      next = next.filter((c) => c.recorded_at >= from);
      index += 1;
    }
    if (sql.includes("recorded_at <")) {
      const to = params[index] as Date;
      next = next.filter((c) => c.recorded_at < to);
    }
    return next;
  }
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

function quota(partial: Partial<QuotaRow> & { org_id: string }): QuotaRow {
  return {
    window_key: "default",
    run_limit: null,
    token_limit: null,
    credit_limit: null,
    runs_used: 0,
    tokens_used: 0,
    credits_used: 0,
    ...partial,
  };
}

describe("NoopQuotaPolicy (the unlimited self-host default)", () => {
  it("always admits and accrues nothing — self-host is unrestricted", async () => {
    const policy = new NoopQuotaPolicy();
    const decision = await policy.checkAdmission("org_any", { runs: 1 });
    expect(decision.admit).toBe(true);
    // Accrual is a genuine no-op: it returns without touching any store.
    await expect(policy.accrueUsage("org_any", { runs: 1, tokens: 999, costUsd: 12.5 })).resolves.toBeUndefined();
  });
});

describe("DbQuotaPolicy.checkAdmission (reads org_quotas)", () => {
  it("admits when the org has no quota row configured (unlimited)", async () => {
    const pool = new QuotaPool();
    const decision = await new DbQuotaPolicy(pool as never).checkAdmission("org_unconfigured", { runs: 1 });
    expect(decision.admit).toBe(true);
  });

  it("admits when every present limit has headroom", async () => {
    const pool = new QuotaPool();
    pool.quotas.push(quota({ org_id: "org_a", run_limit: 10, runs_used: 3 }));
    const decision = await new DbQuotaPolicy(pool as never).checkAdmission("org_a", { runs: 1 });
    expect(decision).toEqual({ admit: true, windowKey: "default" });
  });

  it("denies when the requested run would exceed the run limit", async () => {
    const pool = new QuotaPool();
    pool.quotas.push(quota({ org_id: "org_a", run_limit: 5, runs_used: 5 }));
    const decision = await new DbQuotaPolicy(pool as never).checkAdmission("org_a", { runs: 1 });
    expect(decision.admit).toBe(false);
    expect(decision.reason).toContain("run quota exhausted");
    expect(decision.windowKey).toBe("default");
  });

  it("denies when the token budget is already exhausted", async () => {
    const pool = new QuotaPool();
    pool.quotas.push(quota({ org_id: "org_a", token_limit: 1000, tokens_used: 1000 }));
    const decision = await new DbQuotaPolicy(pool as never).checkAdmission("org_a", { runs: 1 });
    expect(decision.admit).toBe(false);
    expect(decision.reason).toContain("token budget exhausted");
  });

  it("denies when the credit budget is already exhausted", async () => {
    const pool = new QuotaPool();
    pool.quotas.push(quota({ org_id: "org_a", credit_limit: 50, credits_used: 60 }));
    const decision = await new DbQuotaPolicy(pool as never).checkAdmission("org_a", { runs: 1 });
    expect(decision.admit).toBe(false);
    expect(decision.reason).toContain("credit budget exhausted");
  });

  it("treats a NULL dimension as uncapped (only a present limit gates)", async () => {
    const pool = new QuotaPool();
    // run_limit NULL, only tokens capped with headroom → admit.
    pool.quotas.push(quota({ org_id: "org_a", token_limit: 1000, tokens_used: 10, runs_used: 9_999 }));
    const decision = await new DbQuotaPolicy(pool as never).checkAdmission("org_a", { runs: 1 });
    expect(decision.admit).toBe(true);
  });
});

describe("DbQuotaPolicy.accrueUsage (advances consumed counters)", () => {
  it("advances runs/tokens/credits on the active window row", async () => {
    const pool = new QuotaPool();
    pool.quotas.push(quota({ org_id: "org_a", run_limit: 10, runs_used: 2, tokens_used: 100, credits_used: 5 }));
    await new DbQuotaPolicy(pool as never).accrueUsage("org_a", { runs: 1, tokens: 250, costUsd: 1.5 });
    const row = pool.quotas[0];
    expect(row?.runs_used).toBe(3);
    expect(row?.tokens_used).toBe(350);
    expect(row?.credits_used).toBe(6.5);
  });

  it("crosses the run limit after accrual so the NEXT admission is denied", async () => {
    const pool = new QuotaPool();
    pool.quotas.push(quota({ org_id: "org_a", run_limit: 3, runs_used: 2 }));
    const policy = new DbQuotaPolicy(pool as never);
    await policy.accrueUsage("org_a", { runs: 1, tokens: 0, costUsd: 0 });
    // runs_used is now 3 == limit; the next single-run admission is denied.
    const decision = await policy.checkAdmission("org_a", { runs: 1 });
    expect(decision.admit).toBe(false);
  });

  it("is a no-op for an org with no quota row (nothing to accrue)", async () => {
    const pool = new QuotaPool();
    await new DbQuotaPolicy(pool as never).accrueUsage("org_none", { runs: 1, tokens: 10, costUsd: 1 });
    expect(pool.quotas).toHaveLength(0);
  });
});

function seed(pool: QuotaPool): void {
  pool.costs.push(
    { run_id: "run_1", org_id: "org_a", total_tokens: 100, cost_usd: 1.25, recorded_at: new Date("2026-05-01") },
    { run_id: "run_1", org_id: "org_a", total_tokens: 50, cost_usd: null, recorded_at: new Date("2026-05-01") },
    { run_id: "run_2", org_id: "org_a", total_tokens: 200, cost_usd: 4.0, recorded_at: new Date("2026-05-20") },
    { run_id: "run_3", org_id: "org_b", total_tokens: 999, cost_usd: 9.0, recorded_at: new Date("2026-05-10") },
  );
}

describe("metering-export reads (cost_records grouped by org_id)", () => {
  it("getOrgUsage rolls up runs/tokens/dollars for one org (unpriced rows add 0 dollars)", async () => {
    const pool = new QuotaPool();
    seed(pool);
    const usage = await getOrgUsage(pool as never, "org_a");
    expect(usage).toEqual({ orgId: "org_a", runs: 2, tokens: 350, costUsd: 5.25 });
  });

  it("getOrgUsage isolates by org_id (org_b's run does not leak into org_a)", async () => {
    const pool = new QuotaPool();
    seed(pool);
    const usage = await getOrgUsage(pool as never, "org_b");
    expect(usage).toEqual({ orgId: "org_b", runs: 1, tokens: 999, costUsd: 9.0 });
  });

  it("getOrgUsage applies the time window", async () => {
    const pool = new QuotaPool();
    seed(pool);
    // Window excludes run_2 (2026-05-20) → only run_1's 150 tokens / $1.25.
    const usage = await getOrgUsage(pool as never, "org_a", { to: new Date("2026-05-10") });
    expect(usage).toEqual({ orgId: "org_a", runs: 1, tokens: 150, costUsd: 1.25 });
  });

  it("getOrgUsage returns zeros for an org with no cost rows", async () => {
    const pool = new QuotaPool();
    const usage = await getOrgUsage(pool as never, "org_empty");
    expect(usage).toEqual({ orgId: "org_empty", runs: 0, tokens: 0, costUsd: 0 });
  });

  it("streamBillableRuns emits one billable row per run with summed totals", async () => {
    const pool = new QuotaPool();
    seed(pool);
    const runs = await streamBillableRuns(pool as never, "org_a");
    expect(runs).toEqual([
      { runId: "run_1", tokens: 150, costUsd: 1.25 },
      { runId: "run_2", tokens: 200, costUsd: 4.0 },
    ]);
  });

  it("getRunUsage sums a single run's tokens + dollars (accrual ground truth)", async () => {
    const pool = new QuotaPool();
    seed(pool);
    const usage = await getRunUsage(pool as never, "run_1");
    expect(usage).toEqual({ tokens: 150, costUsd: 1.25 });
  });
});
