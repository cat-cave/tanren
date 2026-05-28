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

describe("cost-records token-type + nullable-cost migration", () => {
  it("drops the fake subscription_window_denominators table", async () => {
    const sql = await readAllMigrations();
    expect(sql).toMatch(/DROP TABLE "subscription_window_denominators"/);
  });

  it("constrains cost_basis to the three accepted values", async () => {
    const sql = await readAllMigrations();
    expect(sql).toMatch(/cost_basis.*IN.*'ccusage'/);
    expect(sql).toMatch(/'provider_pricing'/);
    expect(sql).toMatch(/cost_basis.*'unknown'/s);
    expect(sql).not.toContain(`${"legacy"}_${"unknown"}`);
    expect(sql).not.toContain("unknown_source");
  });

  it("constrains billing_mode to the three accepted values", async () => {
    const sql = await readAllMigrations();
    expect(sql).toMatch(/billing_mode.*IN.*'per_token'/);
    expect(sql).toMatch(/'subscription'/);
    expect(sql).toMatch(/'self_hosted'/);
  });

  it("makes cost_usd nullable (cost-unknown is an allowed state)", async () => {
    const sql = await readAllMigrations();
    expect(sql).toMatch(/ALTER COLUMN "cost_usd" DROP NOT NULL/);
  });

  it("adds the disjoint token-type columns", async () => {
    const sql = await readAllMigrations();
    for (const column of ["cached_input_tokens", "cache_creation_tokens", "reasoning_output_tokens", "total_tokens"]) {
      expect(sql).toContain(`"${column}"`);
    }
  });

  it("converts existing rows' pricing_mode and cost_source into billing_mode and cost_basis", async () => {
    const sql = await readAllMigrations();
    expect(sql).toMatch(/UPDATE "cost_records" SET "billing_mode"/);
    expect(sql).toMatch(/UPDATE "cost_records" SET "cost_basis"/);
    // codexbar was the fake estimate — it drops to 'unknown'.
    expect(sql).toMatch(/'codexbar' THEN 'unknown'/);
  });

  it("keeps the cost.unattributable event name in the events_event_type CHECK", async () => {
    const sql = await readAllMigrations();
    expect(sql).toContain("'cost.unattributable'");
  });
});
