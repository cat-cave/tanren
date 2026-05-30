// P2A-0019: forge_threads + forge_turns migration shape test.
// P3-0010: forge_action_proposals migration shape test.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL("../../../db/migrations/0011_faulty_norman_osborn.sql", import.meta.url));
const proposalsMigrationPath = fileURLToPath(
  new URL("../../../db/migrations/0028_massive_callisto.sql", import.meta.url),
);

async function readMigration(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

async function readProposalsMigration(): Promise<string> {
  return readFile(proposalsMigrationPath, "utf8");
}

describe("0011 forge substrate migration", () => {
  it("creates the forge_threads table with the scope CHECK and consistency CHECK", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "forge_threads"');
    expect(sql).toContain("forge_threads_scope_check");
    expect(sql).toContain("forge_threads_scope_consistency_check");
    expect(sql).toMatch(/scope.*IN \('org','project','run'\)/);
  });

  it("creates the forge_turns table with audience and author CHECKs", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "forge_turns"');
    expect(sql).toContain("forge_turns_audience_check");
    expect(sql).toContain("forge_turns_author_kind_check");
    expect(sql).toMatch(/audience.*IN \('project:member','project:admin','org:admin','platform:admin'\)/);
    expect(sql).toMatch(/author_kind.*IN \('forge_template','forge_llm','operator'\)/);
  });

  it("creates a unique index enforcing one turn per (thread_id, turn_index)", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE UNIQUE INDEX "forge_turns_thread_index_unique"');
  });

  it("foreign-keys forge_threads to organizations + projects", async () => {
    const sql = await readMigration();
    expect(sql).toContain("forge_threads_org_id_organizations_id_fk");
    expect(sql).toContain("forge_threads_project_id_projects_project_id_fk");
  });

  it("foreign-keys forge_turns.thread_id to forge_threads.id", async () => {
    const sql = await readMigration();
    expect(sql).toContain("forge_turns_thread_id_forge_threads_id_fk");
  });
});

describe("0028 forge_action_proposals migration (P3-0010 write-action approval)", () => {
  it("creates the forge_action_proposals table with tool + status CHECKs", async () => {
    const sql = await readProposalsMigration();
    expect(sql).toContain('CREATE TABLE "forge_action_proposals"');
    expect(sql).toContain("forge_action_proposals_tool_check");
    expect(sql).toContain("forge_action_proposals_status_check");
    expect(sql).toMatch(
      /tool_name.*IN \('tanren\.create_spec','tanren\.trigger_run','tanren\.rerun_task','tanren\.acknowledge_insight'\)/,
    );
    expect(sql).toMatch(/status.*IN \('pending','approved','rejected','executed','failed'\)/);
  });

  it("makes org_id NOT NULL + indexed (the migration-0026 tenancy pattern)", async () => {
    const sql = await readProposalsMigration();
    expect(sql).toMatch(/"org_id" text NOT NULL/);
    expect(sql).toContain("forge_action_proposals_org_id_organizations_id_fk");
    expect(sql).toContain('CREATE INDEX "forge_action_proposals_org_id"');
  });

  it("foreign-keys the proposal to its thread + proposing turn", async () => {
    const sql = await readProposalsMigration();
    expect(sql).toContain("forge_action_proposals_thread_id_forge_threads_id_fk");
    expect(sql).toContain("forge_action_proposals_proposing_turn_id_forge_turns_id_fk");
  });
});
