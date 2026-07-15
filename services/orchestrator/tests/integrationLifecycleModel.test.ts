import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL("../../../db/migrations/0041_integration_lifecycle.sql", import.meta.url));
const snapshotPath = fileURLToPath(new URL("../../../db/migrations/meta/0041_snapshot.json", import.meta.url));
const lifecycleSchemaPath = fileURLToPath(new URL("../../../db/src/schemaIntegrationLifecycle.ts", import.meta.url));
const operationsSchemaPath = fileURLToPath(new URL("../../../db/src/schemaIntegrationOperations.ts", import.meta.url));

const TABLES = [
  "behavior_integration_requirements",
  "capability_node_dependencies",
  "capability_nodes",
  "delivery_runs",
  "delivery_stage_attempts",
  "integration_binding_env",
  "integration_bindings",
  "integration_reconciliations",
  "integration_requirements",
  "integration_resource_snapshots",
  "integration_validation_proofs",
  "org_integration_connections",
  "org_integration_grants",
  "project_app_env",
  "spec_capability_dependencies",
] as const;

describe("IN-1 integration lifecycle schema contract", () => {
  let migration = "";
  let snapshot: { tables: Record<string, unknown> };
  let schemas = "";

  beforeAll(async () => {
    const [migrationSql, snapshotJson, lifecycle, operations] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(snapshotPath, "utf8"),
      readFile(lifecycleSchemaPath, "utf8"),
      readFile(operationsSchemaPath, "utf8"),
    ]);
    migration = migrationSql;
    snapshot = JSON.parse(snapshotJson) as { tables: Record<string, unknown> };
    schemas = `${lifecycle}\n${operations}`;
  });

  it("clean-replaces both legacy authorities without a compatibility path", () => {
    expect(migration).toMatch(/DROP TABLE "org_integrations";[\s\S]*DROP TABLE "project_app_env";/u);
    expect(migration).not.toMatch(/CREATE (?:OR REPLACE )?VIEW/u);
    expect(migration).not.toMatch(/INSERT INTO "org_integration_connections"[\s\S]*SELECT[\s\S]*org_integrations/u);
    expect(migration).not.toContain('CREATE TABLE "org_integrations"');
    expect(snapshot.tables).not.toHaveProperty("public.org_integrations");
  });

  it("creates the complete closed 15-table model with direct tenant roots", () => {
    expect(TABLES).toHaveLength(15);
    for (const table of TABLES) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(migration).toMatch(new RegExp(`CREATE TABLE "${table}" \\([\\s\\S]*?"org_id" text NOT NULL`, "u"));
      expect(snapshot.tables).toHaveProperty(`public.${table}`);
    }
  });

  it("forces one deny-by-default org policy over the same closed table list", () => {
    expect(migration).toContain("ALTER TABLE %I ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("CREATE POLICY rls_org_isolation ON %I FOR ALL");
    expect(migration).toContain("org_id = current_setting(''app.current_org_id'', true)");
    for (const table of TABLES) {
      expect(migration).toContain(`'${table}'`);
    }
  });

  it("uses composite tenant foreign keys across every authority boundary", () => {
    const requiredConstraints = [
      "behavior_integration_requirements_behavior_revision_fk",
      "capability_nodes_project_fk",
      "capability_nodes_requirement_fk",
      "delivery_runs_authority_decision_fk",
      "integration_bindings_grant_fk",
      "integration_reconciliations_binding_fk",
      "integration_validation_proofs_behavior_revision_fk",
      "integration_validation_proofs_evidence_cas_fk",
      "org_integration_grants_connection_fk",
      "project_app_env_binding_output_fk",
      "project_app_env_project_fk",
      "spec_capability_dependencies_spec_fk",
    ];
    for (const constraint of requiredConstraints) {
      expect(migration).toContain(`CONSTRAINT "${constraint}" FOREIGN KEY ("org_id",`);
    }
    expect(migration).toContain('CREATE UNIQUE INDEX "projects_org_project_unique"');
    expect(migration).toContain('CREATE UNIQUE INDEX "specs_org_spec_unique"');
  });

  it("pins digest, enum, generation, and secret/binding invariants in SQL", () => {
    expect(migration).toContain("^sha256:[0-9a-f]{64}$");
    expect(migration).not.toMatch(/CHECK \([^)]*\$\d/u);
    expect(migration).toContain('CONSTRAINT "project_app_env_value_xor_check"');
    expect(migration).toContain('CONSTRAINT "project_app_env_binding_check"');
    expect(migration).toContain('CONSTRAINT "project_app_env_secret_generation_check"');
    expect(migration).toContain('CONSTRAINT "org_integration_grants_plane_environment_check"');
    expect(migration).toContain('CONSTRAINT "integration_validation_proofs_verdict_check"');
  });

  it("keeps the generated schema modules aligned with the migration", () => {
    const exports = [
      "orgIntegrationConnections",
      "orgIntegrationGrants",
      "integrationRequirements",
      "behaviorIntegrationRequirements",
      "capabilityNodes",
      "capabilityNodeDependencies",
      "specCapabilityDependencies",
      "integrationBindings",
      "integrationBindingEnv",
      "projectAppEnv",
      "integrationReconciliations",
      "integrationResourceSnapshots",
      "deliveryRuns",
      "deliveryStageAttempts",
      "integrationValidationProofs",
    ];
    for (const name of exports) {
      expect(schemas).toContain(`export const ${name} = pgTable(`);
    }
  });
});
