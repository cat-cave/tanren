import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const migrationPath = fileURLToPath(new URL("db/migrations/0041_integration_lifecycle.sql", root));
const snapshotPath = fileURLToPath(new URL("db/migrations/meta/0041_snapshot.json", root));
const schemaPaths = [
  "db/src/schemaIntegrationLifecycle.ts",
  "db/src/schemaIntegrationOperations.ts",
  "db/src/schemaIntegrationEnvironment.ts",
  "db/src/schemaIntegrationSelection.ts",
].map((path) => fileURLToPath(new URL(path, root)));

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
  "project_integration_grant_selections",
  "spec_capability_dependencies",
] as const;

interface SnapshotTable {
  columns: Record<string, { notNull: boolean }>;
  indexes: Record<string, unknown>;
  foreignKeys: Record<string, unknown>;
  policies: Record<string, { name: string; as: string; for: string; to: string[]; using: string; withCheck: string }>;
  isRLSEnabled: boolean;
}

describe("IN-1 integration lifecycle schema contract", () => {
  let migration = "";
  let tables: Record<string, SnapshotTable> = {};
  let schemas = "";

  beforeAll(async () => {
    const [migrationSql, snapshotJson, ...schemaSources] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(snapshotPath, "utf8"),
      ...schemaPaths.map((path) => readFile(path, "utf8")),
    ]);
    migration = migrationSql;
    const parsed = JSON.parse(snapshotJson) as { tables: Record<string, SnapshotTable> };
    tables = parsed.tables;
    schemas = schemaSources.join("\n");
  });

  it("clean-replaces both legacy authorities without a compatibility path", () => {
    expect(migration).toContain('DROP TABLE "project_app_env" CASCADE');
    expect(migration).toContain('DROP TABLE "org_integrations" CASCADE');
    expect(migration).not.toMatch(/CREATE (?:OR REPLACE )?VIEW/u);
    expect(migration).not.toMatch(/INSERT INTO "org_integration_connections"[\s\S]*SELECT[\s\S]*org_integrations/u);
    expect(migration).not.toContain('CREATE TABLE "org_integrations"');
    expect(tables).not.toHaveProperty("public.org_integrations");
  });

  it("owns the complete 16-table model with direct indexed tenant roots", () => {
    expect(TABLES).toHaveLength(16);
    for (const tableName of TABLES) {
      expect(migration).toContain(`CREATE TABLE "${tableName}"`);
      const table = tables[`public.${tableName}`];
      if (table === undefined) throw new Error(`snapshot missing lifecycle table ${tableName}`);
      expect(table.columns["org_id"]).toMatchObject({ notNull: true });
      expect(Object.values(table.indexes).some((index) => JSON.stringify(index).includes('"org_id"'))).toBe(true);
    }
  });

  it("records one exact deny-by-default policy per table in Drizzle metadata and FORCE SQL", () => {
    for (const tableName of TABLES) {
      const table = tables[`public.${tableName}`]!;
      expect(table.isRLSEnabled).toBe(true);
      expect(Object.keys(table.policies)).toEqual(["rls_org_isolation"]);
      const policy = table.policies["rls_org_isolation"]!;
      const predicate = `"${tableName}"."org_id" = current_setting('app.current_org_id', true)`;
      expect(policy).toMatchObject({
        name: "rls_org_isolation",
        as: "PERMISSIVE",
        for: "ALL",
        to: ["public"],
        using: predicate,
        withCheck: predicate,
      });
      expect(migration).toContain(`ALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE "${tableName}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY "rls_org_isolation" ON "${tableName}"`);
    }
    expect(migration.match(/ FORCE ROW LEVEL SECURITY/gu)).toHaveLength(TABLES.length);
  });

  it("serializes every spine and project-selection foreign key into SQL and snapshot", () => {
    const requiredConstraints = [
      "behavior_integration_requirements_behavior_revision_fk",
      "delivery_runs_authority_decision_fk",
      "integration_validation_proofs_behavior_revision_fk",
      "integration_validation_proofs_behavior_verdict_fk",
      "integration_validation_proofs_proof_unit_fk",
      "integration_validation_proofs_evidence_cas_fk",
      "project_integration_grant_selections_project_fk",
      "project_integration_grant_selections_connection_fk",
      "project_integration_grant_selections_grant_fk",
      "project_app_env_binding_output_fk",
      "spec_capability_dependencies_spec_fk",
    ];
    const snapshotForeignKeys = Object.values(tables).flatMap((table) => Object.keys(table.foreignKeys));
    for (const constraint of requiredConstraints) {
      expect(migration).toContain(`CONSTRAINT "${constraint}" FOREIGN KEY`);
      expect(snapshotForeignKeys).toContain(constraint);
    }
    expect(migration).toContain('CREATE UNIQUE INDEX "projects_org_project_unique"');
    expect(migration).toContain('CREATE UNIQUE INDEX "specs_org_spec_unique"');
  });

  it("pins digest, generation, account, and secret/binding invariants in SQL", () => {
    expect(migration).toContain("^sha256:[0-9a-f]{64}$");
    expect(migration).toContain('CONSTRAINT "project_app_env_value_xor_check"');
    expect(migration).toContain('CONSTRAINT "project_app_env_binding_check"');
    expect(migration).toContain('CONSTRAINT "project_app_env_secret_generation_check"');
    expect(migration).toContain('CREATE UNIQUE INDEX "org_integration_connections_account_unique"');
    expect(migration).toContain('CREATE UNIQUE INDEX "org_integration_grants_connection_id_unique"');
    expect(migration).toContain('CONSTRAINT "integration_validation_proofs_verdict_check"');
  });

  it("keeps all schema exports aligned and under the architecture line cap", async () => {
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
      "projectIntegrationGrantSelections",
      "integrationReconciliations",
      "integrationResourceSnapshots",
      "deliveryRuns",
      "deliveryStageAttempts",
      "integrationValidationProofs",
    ];
    for (const name of exports) expect(schemas).toContain(`export const ${name} = pgTable(`);
    for (const path of schemaPaths) {
      expect((await readFile(path, "utf8")).split("\n").length).toBeLessThanOrEqual(500);
    }
  });
});
