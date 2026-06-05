import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The migration chain was collapsed to a single baseline
// (`0000_collapsed_baseline.sql`): the cost_records token-type + nullable-cost +
// CHECK-vocab evolution (old 0013 …) folded into the baseline with its
// FINAL-state shape. The intermediate DROP TABLE / ALTER COLUMN / UPDATE-backfill
// / ADD-CONSTRAINT-re-add dances are gone (a zero-user, zero-DB collapse never
// traverses them); the live shape is asserted directly off the baseline, where
// every CHECK is an inline CREATE TABLE constraint on its own line.

const migrationPath = fileURLToPath(new URL("../../../db/migrations/0000_collapsed_baseline.sql", import.meta.url));

async function readBaseline(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

// The single line carrying the named inline `CONSTRAINT "<name>" CHECK (...)` —
// the live CHECK the DB enforces.
async function checkClause(constraint: string): Promise<string> {
  const sql = await readBaseline();
  return sql.split("\n").find((line) => line.includes(`CONSTRAINT "${constraint}" CHECK`)) ?? "";
}

describe("cost-records token-type + nullable-cost baseline shape", () => {
  it("does NOT carry the dropped fake subscription_window_denominators table", async () => {
    const sql = await readBaseline();
    expect(sql).not.toContain("subscription_window_denominators");
  });

  it("constrains cost_basis to the accepted values (incl. provider_response — OpenRouter's real charge)", async () => {
    const check = await checkClause("cost_records_cost_basis_check");
    expect(check).toContain("'ccusage'");
    // The authoritative real-charge basis (OpenRouter's usage.cost).
    expect(check).toContain("'provider_response'");
    expect(check).toContain("'unknown'");
    // provider_pricing was the static list-rate estimate basis — NEVER produced
    // (real spend is a metered FACT) and pruned from the live CHECK (v21 cleanup).
    expect(check).not.toContain("'provider_pricing'");
    expect(check).not.toContain(`${"legacy"}_${"unknown"}`);
    expect(check).not.toContain("unknown_source");
  });

  it("constrains billing_mode to the accepted values", async () => {
    const check = await checkClause("cost_records_billing_mode_check");
    expect(check).toContain("'per_token'");
    expect(check).toContain("'subscription'");
    expect(check).toContain("'self_hosted'");
  });

  it("makes cost_usd nullable (cost-unknown is an allowed state)", async () => {
    const sql = await readBaseline();
    // The column is created nullable — the cost_usd line carries no NOT NULL.
    const costUsdLine = sql.split("\n").find((line) => line.includes('"cost_usd" numeric')) ?? "";
    expect(costUsdLine).not.toContain("NOT NULL");
  });

  it("carries the disjoint token-type columns", async () => {
    const sql = await readBaseline();
    for (const column of ["cached_input_tokens", "cache_creation_tokens", "reasoning_output_tokens", "total_tokens"]) {
      expect(sql).toContain(`"${column}"`);
    }
  });

  it("prunes the retired cost.unattributable event name from the live events_event_type CHECK", async () => {
    // cost.unattributable was retained-for-compat but never thrown (cost-unknown
    // is an allowed NULL state); pruned in the v21 cleanup. The live cost-misconfig
    // event is cost.unattributed (BUDGET-SAFETY C1), which remains.
    const check = await checkClause("events_event_type_check");
    expect(check).not.toContain("'cost.unattributable'");
    expect(check).toContain("'cost.unattributed'");
  });
});
