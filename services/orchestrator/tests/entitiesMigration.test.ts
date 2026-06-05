import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Verifies the collapsed baseline ships the product entity tables with
// the constraints the spec requires. The migration chain was collapsed to a
// single baseline (`0000_collapsed_baseline.sql`); the old 0005 migration's
// seed/backfill DO blocks are gone — a zero-user, zero-DB collapse never
// traverses a backfill — so only the final table + constraint shape is asserted.

const migrationPath = fileURLToPath(new URL("../../../db/migrations/0000_collapsed_baseline.sql", import.meta.url));

async function readMigration(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

describe("product-entities baseline shape", () => {
  it("creates the personas table with scope and scope/project consistency CHECKs", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "personas"');
    expect(sql).toContain("personas_scope_check");
    expect(sql).toContain("personas_scope_project_check");
    expect(sql).toMatch(/scope.*IN \('org','project'\)/u);
  });

  it("creates the behaviors table with given/when/then columns", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "behaviors"');
    expect(sql).toContain('"given" text NOT NULL');
    expect(sql).toContain('"when" text NOT NULL');
    expect(sql).toContain('"then" text NOT NULL');
  });

  it("creates the milestones table with status CHECK and uniqueness on (project,label) and (project,order_index)", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "milestones"');
    expect(sql).toContain("milestones_status_check");
    expect(sql).toMatch(/status.*IN \('planned','in_flight','done','abandoned'\)/u);
    expect(sql).toContain('CREATE UNIQUE INDEX "milestones_project_label_unique"');
    expect(sql).toContain('CREATE UNIQUE INDEX "milestones_project_order_unique"');
  });

  it("creates the spec_milestones join table with the spec_id unique index enforcing one milestone per spec", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "spec_milestones"');
    expect(sql).toContain('CREATE UNIQUE INDEX "spec_milestones_spec_unique"');
  });

  it("creates the spec_dependencies table with a no-self-loop CHECK and (from,to) primary key", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "spec_dependencies"');
    expect(sql).toContain("spec_dependencies_no_self_loop");
    expect(sql).toContain("spec_dependencies_from_spec_id_to_spec_id_pk");
  });
});
