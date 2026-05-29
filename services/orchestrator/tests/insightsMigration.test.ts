// P2A-0020: workflow_insights migration shape test.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL("../../../db/migrations/0012_cheerful_sleepwalker.sql", import.meta.url));

async function readMigration(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

describe("0012 workflow_insights migration", () => {
  it("creates the workflow_insights table with kind + severity CHECKs", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "workflow_insights"');
    expect(sql).toContain("workflow_insights_kind_check");
    expect(sql).toContain("workflow_insights_severity_check");
    expect(sql).toMatch(/kind.*IN \('retry_hotspot','model_mismatch','pace_anomaly'\)/);
    expect(sql).toMatch(/severity.*IN \('info','warn','fail'\)/);
  });

  it("creates a (project_id, kind, computed_at desc) read index", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE INDEX "workflow_insights_project_kind"');
    expect(sql).toMatch(/computed_at"?\s+desc/i);
  });

  it("foreign-keys project_id and acknowledged_by", async () => {
    const sql = await readMigration();
    expect(sql).toContain("workflow_insights_project_id_projects_project_id_fk");
    expect(sql).toContain("workflow_insights_acknowledged_by_users_id_fk");
  });
});

// P3-0020: the single migration widens the kind CHECK to add `stuck` and
// `review_stall`. No source-data migration — insights stay derived rows.
const p3MigrationPath = fileURLToPath(
  new URL("../../../db/migrations/0020_smiling_albert_cleary.sql", import.meta.url),
);

describe("0020 workflow_insights kind widening migration", () => {
  it("re-adds the kind CHECK with the two P3-0020 kinds", async () => {
    const sql = await readFile(p3MigrationPath, "utf8");
    expect(sql).toContain('DROP CONSTRAINT "workflow_insights_kind_check"');
    expect(sql).toContain("workflow_insights_kind_check");
    expect(sql).toMatch(/IN \('retry_hotspot','model_mismatch','pace_anomaly','stuck','review_stall'\)/);
  });
});
