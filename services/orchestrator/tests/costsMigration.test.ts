import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));

async function readAllMigrations(): Promise<string> {
  const entries = (await readdir(migrationsDir)).filter((entry) => entry.endsWith(".sql")).sort();
  const contents: string[] = [];
  for (const entry of entries) {
    contents.push(await readFile(new URL(entry, `file://${migrationsDir}`), "utf8"));
  }
  return contents.join("\n");
}

// The single LATEST `ADD CONSTRAINT ... CHECK` statement re-adding the named
// constraint — i.e. the live CHECK the DB currently enforces (later migrations
// supersede earlier ones). Used to assert a dead value was pruned from the
// constraint even though the historical migration that first introduced it is
// still on disk.
async function latestCheckClause(constraint: string): Promise<string> {
  const entries = (await readdir(migrationsDir)).filter((entry) => entry.endsWith(".sql")).sort();
  let latest = "";
  for (const entry of entries) {
    const sql = await readFile(new URL(entry, `file://${migrationsDir}`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.includes(`ADD CONSTRAINT "${constraint}"`) && statement.includes("CHECK")) {
        latest = statement;
      }
    }
  }
  return latest;
}

describe("cost-records token-type + nullable-cost migration", () => {
  it("drops the fake subscription_window_denominators table", async () => {
    const sql = await readAllMigrations();
    expect(sql).toMatch(/DROP TABLE "subscription_window_denominators"/u);
  });

  it("constrains cost_basis to the accepted values (incl. provider_response — OpenRouter's real charge)", async () => {
    // The LIVE cost_basis CHECK (latest ADD CONSTRAINT), not the concatenated
    // history — so a pruned value is asserted GONE even though the migration that
    // first introduced it stays on disk.
    const check = await latestCheckClause("cost_records_cost_basis_check");
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

  it("constrains billing_mode to the three accepted values", async () => {
    const sql = await readAllMigrations();
    expect(sql).toMatch(/billing_mode.*IN.*'per_token'/u);
    expect(sql).toMatch(/'subscription'/u);
    expect(sql).toMatch(/'self_hosted'/u);
  });

  it("makes cost_usd nullable (cost-unknown is an allowed state)", async () => {
    const sql = await readAllMigrations();
    expect(sql).toMatch(/ALTER COLUMN "cost_usd" DROP NOT NULL/u);
  });

  it("adds the disjoint token-type columns", async () => {
    const sql = await readAllMigrations();
    for (const column of ["cached_input_tokens", "cache_creation_tokens", "reasoning_output_tokens", "total_tokens"]) {
      expect(sql).toContain(`"${column}"`);
    }
  });

  it("converts existing rows' pricing_mode and cost_source into billing_mode and cost_basis", async () => {
    const sql = await readAllMigrations();
    expect(sql).toMatch(/UPDATE "cost_records" SET "billing_mode"/u);
    expect(sql).toMatch(/UPDATE "cost_records" SET "cost_basis"/u);
    // codexbar was the fake estimate — it drops to 'unknown'.
    expect(sql).toMatch(/'codexbar' THEN 'unknown'/u);
  });

  it("prunes the retired cost.unattributable event name from the live events_event_type CHECK", async () => {
    // cost.unattributable was retained-for-compat but never thrown (cost-unknown
    // is an allowed NULL state); pruned in the v21 cleanup. The live cost-misconfig
    // event is cost.unattributed (BUDGET-SAFETY C1), which remains.
    const check = await latestCheckClause("events_event_type_check");
    expect(check).not.toContain("'cost.unattributable'");
    expect(check).toContain("'cost.unattributed'");
  });
});
