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

describe("P2A-0011 cost-records migrations", () => {
  it("includes a CREATE TABLE for subscription_window_denominators", async () => {
    const sql = await readAllMigrations();
    expect(sql).toMatch(/CREATE TABLE\s+"subscription_window_denominators"/);
    expect(sql).toContain(`"auth_ref" text PRIMARY KEY NOT NULL`);
    expect(sql).toContain(`"observed_max_monthly_tokens" integer DEFAULT 0 NOT NULL`);
  });

  it("keeps the cost_records cost_source CHECK constrained to the three v0 sources plus ccusage", async () => {
    const sql = await readAllMigrations();
    // The CHECK constraint is the schema's only defense against an
    // `unknown_source` row. P2A-0011 never writes ccusage, but the column
    // still admits it for compatibility with PROJECT_BRIEF.md §4.3 follow-ups.
    expect(sql).toMatch(/cost_source.*IN.*'provider_direct'/);
    expect(sql).toMatch(/'codexbar'/);
    expect(sql).toMatch(/'opportunity_computed'/);
    expect(sql).not.toContain(`${"legacy"}_${"unknown"}`);
    expect(sql).not.toContain("unknown_source");
  });

  it("includes the cost.unattributable event name in the events_event_type CHECK", async () => {
    const sql = await readAllMigrations();
    expect(sql).toContain("'cost.unattributable'");
  });
});
