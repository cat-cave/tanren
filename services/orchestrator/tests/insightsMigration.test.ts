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
    expect(sql).toMatch(/kind.*IN \('retry_hotspot','model_mismatch','pace_anomaly'\)/u);
    expect(sql).toMatch(/severity.*IN \('info','warn','fail'\)/u);
  });

  it("creates a (project_id, kind, computed_at desc) read index", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE INDEX "workflow_insights_project_kind"');
    expect(sql).toMatch(/computed_at"?\s+desc/iu);
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
    expect(sql).toMatch(/IN \('retry_hotspot','model_mismatch','pace_anomaly','stuck','review_stall'\)/u);
  });
});

// P2e-1: the quarantine surface + the kind widening for `ci_flaky` + the
// quarantined_tests RLS policy.
const p2e1MigrationPath = fileURLToPath(new URL("../../../db/migrations/0047_rich_boom_boom.sql", import.meta.url));

describe("0047 quarantine surface + ci_flaky migration", () => {
  it("creates quarantined_tests with the toggle/observation safety CHECKs", async () => {
    const sql = await readFile(p2e1MigrationPath, "utf8");
    expect(sql).toContain('CREATE TABLE "quarantined_tests"');
    expect(sql).toContain("quarantined_tests_toggled_check");
    expect(sql).toContain("quarantined_tests_observation_check");
    // one ACTIVE quarantine per (project, check) — partial unique on cleared_at.
    expect(sql).toContain("quarantined_tests_active_unique");
    expect(sql).toMatch(/WHERE\s+"quarantined_tests"\."cleared_at"\s+IS\s+NULL/iu);
  });

  it("widens the insight kind CHECK to add ci_flaky", async () => {
    const sql = await readFile(p2e1MigrationPath, "utf8");
    expect(sql).toMatch(/IN \('retry_hotspot','model_mismatch','pace_anomaly','stuck','review_stall','ci_flaky'\)/u);
  });

  it("registers the new ci.flaky.* events in the events CHECK", async () => {
    const sql = await readFile(p2e1MigrationPath, "utf8");
    expect(sql).toContain("'ci.flaky.detected'");
    expect(sql).toContain("'ci.test.quarantined'");
  });

  it("enables deny-by-default RLS on quarantined_tests via the project chain", async () => {
    const sql = await readFile(p2e1MigrationPath, "utf8");
    expect(sql).toContain("ALTER TABLE quarantined_tests ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY rls_org_isolation ON quarantined_tests");
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM projects p WHERE p\.project_id = quarantined_tests\.project_id\)/u);
  });
});
