// Metering-export reads — the OSS↔hosting billing READ substrate (the clean
// typed rollup a hosting layer consumes for transparent usage-based billing;
// autonomy-engine.md §1.x: budget is the only run gate, there are no quotas).
// These assert real AGGREGATES against a stateful in-memory store that actually
// holds cost_records rows and executes the metering SQL against them — never "a
// mock was called".

import { describe, expect, it } from "vitest";
import { getOrgUsage, getRunUsage, streamBillableRuns } from "../src/engine/metering/index.js";

interface CostRow {
  run_id: string;
  org_id: string;
  total_tokens: number;
  cost_usd: number | null;
  recorded_at: Date;
}

// A tiny stateful pg substitute covering exactly the SQL the metering module
// emits over cost_records. It stores rows and computes real aggregates so
// assertions are about state, not calls.
class MeteringPool {
  readonly costs: CostRow[] = [];

  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    const trimmed = sql.trim();
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

function seed(pool: MeteringPool): void {
  pool.costs.push(
    { run_id: "run_1", org_id: "org_a", total_tokens: 100, cost_usd: 1.25, recorded_at: new Date("2026-05-01") },
    { run_id: "run_1", org_id: "org_a", total_tokens: 50, cost_usd: null, recorded_at: new Date("2026-05-01") },
    { run_id: "run_2", org_id: "org_a", total_tokens: 200, cost_usd: 4.0, recorded_at: new Date("2026-05-20") },
    { run_id: "run_3", org_id: "org_b", total_tokens: 999, cost_usd: 9.0, recorded_at: new Date("2026-05-10") },
  );
}

describe("metering-export reads (cost_records grouped by org_id)", () => {
  it("getOrgUsage rolls up runs/tokens/dollars for one org (unpriced rows add 0 dollars)", async () => {
    const pool = new MeteringPool();
    seed(pool);
    const usage = await getOrgUsage(pool as never, "org_a");
    expect(usage).toEqual({ orgId: "org_a", runs: 2, tokens: 350, costUsd: 5.25 });
  });

  it("getOrgUsage isolates by org_id (org_b's run does not leak into org_a)", async () => {
    const pool = new MeteringPool();
    seed(pool);
    const usage = await getOrgUsage(pool as never, "org_b");
    expect(usage).toEqual({ orgId: "org_b", runs: 1, tokens: 999, costUsd: 9.0 });
  });

  it("getOrgUsage applies the time window", async () => {
    const pool = new MeteringPool();
    seed(pool);
    // Window excludes run_2 (2026-05-20) → only run_1's 150 tokens / $1.25.
    const usage = await getOrgUsage(pool as never, "org_a", { to: new Date("2026-05-10") });
    expect(usage).toEqual({ orgId: "org_a", runs: 1, tokens: 150, costUsd: 1.25 });
  });

  it("getOrgUsage returns zeros for an org with no cost rows", async () => {
    const pool = new MeteringPool();
    const usage = await getOrgUsage(pool as never, "org_empty");
    expect(usage).toEqual({ orgId: "org_empty", runs: 0, tokens: 0, costUsd: 0 });
  });

  it("streamBillableRuns emits one billable row per run with summed totals", async () => {
    const pool = new MeteringPool();
    seed(pool);
    const runs = await streamBillableRuns(pool as never, "org_a");
    expect(runs).toEqual([
      { runId: "run_1", tokens: 150, costUsd: 1.25 },
      { runId: "run_2", tokens: 200, costUsd: 4.0 },
    ]);
  });

  it("getRunUsage sums a single run's tokens + dollars (per-run billing substrate)", async () => {
    const pool = new MeteringPool();
    seed(pool);
    const usage = await getRunUsage(pool as never, "run_1");
    expect(usage).toEqual({ tokens: 150, costUsd: 1.25 });
  });
});
