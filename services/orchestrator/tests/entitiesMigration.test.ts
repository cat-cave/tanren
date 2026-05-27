import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Verifies the 0005 migration ships the P2A-0018 product entity tables with
// the constraints and default seed block the spec requires.

const migrationPath = fileURLToPath(
  new URL("../../../db/migrations/0005_wise_molly_hayes.sql", import.meta.url)
);

async function readMigration(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

describe("0005 product-entities migration", () => {
  it("creates the personas table with scope and scope/project consistency CHECKs", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "personas"');
    expect(sql).toContain("personas_scope_check");
    expect(sql).toContain("personas_scope_project_check");
    expect(sql).toMatch(/scope.*IN \('org','project'\)/);
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
    expect(sql).toMatch(/status.*IN \('planned','in_flight','done','abandoned'\)/);
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

  it("ships a default-seed DO block that fails the migration if any spec lacks milestone or behavior", async () => {
    const sql = await readMigration();
    expect(sql).toContain("DO $$");
    expect(sql).toContain("P2A-0018 seed left");
    expect(sql).toContain("Developer · fixture operator");
    expect(sql).toContain("'runs the fixture'");
    expect(sql).toContain("M1");
  });

  it("seeds the default org sentinel only when projects lack an org_id", async () => {
    const sql = await readMigration();
    expect(sql).toContain("org_default_p2a_0018");
  });
});
