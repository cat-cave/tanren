// workflow_insights + quarantine surface migration shape test.
//
// The migration chain was collapsed to a single baseline
// (`0000_collapsed_baseline.sql`). The old per-step migrations (0012 create,
// 0020 + 0047 kind-CHECK widening, 0047 quarantine surface) folded into the
// baseline with their FINAL-state shape: the kind CHECK already carries every widened
// value, so the intermediate DROP/re-ADD dances are gone and only the end state
// is asserted here.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL("../../../db/migrations/0000_collapsed_baseline.sql", import.meta.url));

async function readMigration(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

describe("workflow_insights baseline shape", () => {
  it("creates the workflow_insights table with kind + severity CHECKs", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "workflow_insights"');
    expect(sql).toContain("workflow_insights_kind_check");
    expect(sql).toContain("workflow_insights_severity_check");
    expect(sql).toMatch(/severity.*IN \('info','warn','fail'\)/u);
  });

  it("ships the final kind CHECK vocab (every widening folded in)", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /kind.*IN \('retry_hotspot','model_mismatch','pace_anomaly','stuck','review_stall','ci_flaky'\)/u,
    );
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

describe("quarantine surface + ci_flaky baseline shape", () => {
  it("creates quarantined_tests with the toggle/observation safety CHECKs", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "quarantined_tests"');
    expect(sql).toContain("quarantined_tests_toggled_check");
    expect(sql).toContain("quarantined_tests_observation_check");
    // one ACTIVE quarantine per (project, check) — partial unique on cleared_at.
    expect(sql).toContain("quarantined_tests_active_unique");
    expect(sql).toMatch(/WHERE\s+"quarantined_tests"\."cleared_at"\s+IS\s+NULL/iu);
  });

  it("registers the ci.flaky.* events in the events CHECK", async () => {
    const sql = await readMigration();
    expect(sql).toContain("'ci.flaky.detected'");
    expect(sql).toContain("'ci.test.quarantined'");
  });

  it("enables deny-by-default RLS on quarantined_tests via the project chain", async () => {
    const sql = await readMigration();
    expect(sql).toContain("ALTER TABLE quarantined_tests ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY rls_org_isolation ON quarantined_tests");
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM projects p WHERE p\.project_id = quarantined_tests\.project_id\)/u);
  });
});
