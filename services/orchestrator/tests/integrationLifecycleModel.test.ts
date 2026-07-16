import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

const root = new URL("../../../", import.meta.url);
const migrationPath = fileURLToPath(new URL("db/migrations/0041_integration_lifecycle.sql", root));
const snapshotPath = fileURLToPath(new URL("db/migrations/meta/0041_snapshot.json", root));
const schemaPaths = [
  "db/src/schemaIntegrationConnections.ts",
  "db/src/schemaIntegrationRequirements.ts",
  "db/src/schemaIntegrationBindings.ts",
  "db/src/schemaIntegrationOperations.ts",
  "db/src/schemaIntegrationEnvironment.ts",
  "db/src/schemaIntegrationSelection.ts",
  "db/src/schemaProjectDerivations.ts",
].map((path) => fileURLToPath(new URL(path, root)));

const TABLES = [
  "behavior_integration_requirements",
  "capability_node_dependencies",
  "capability_nodes",
  "delivery_run_bindings",
  "delivery_runs",
  "delivery_stage_attempts",
  "integration_binding_env",
  "integration_binding_generations",
  "integration_bindings",
  "integration_reconciliations",
  "integration_requirements",
  "integration_resource_snapshots",
  "integration_validation_proofs",
  "org_integration_connection_auth_generations",
  "org_integration_connection_operations",
  "org_integration_connections",
  "org_integration_grant_generations",
  "org_integration_grants",
  "project_app_env",
  "project_derivations",
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

const derivingProjectAdmin: ActorContext = {
  userId: "user_deriving_admin",
  orgId: "org_deriving",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function derivingProjectRouteHarness(lifecycle: string) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_deriving" });
  pool.seedMembership("org_deriving", derivingProjectAdmin.userId, "admin");
  pool.seedProject({ project_id: "project_deriving", org_id: "org_deriving", lifecycle });

  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return derivingProjectAdmin;
        },
      } as never,
      localDevActor: derivingProjectAdmin,
    }),
  );
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets: {} as never, githubHttp: {} as never }));
  return app;
}

describe("IN-1 P1 integration lifecycle schema contract", () => {
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

  it("clean-replaces legacy authorities without a compatibility path", () => {
    expect(migration).toContain('DROP TABLE IF EXISTS "project_app_env" CASCADE');
    expect(migration).toContain('DROP TABLE IF EXISTS "org_integrations" CASCADE');
    expect(migration).not.toMatch(/CREATE (?:OR REPLACE )?VIEW/u);
    expect(migration).not.toContain('CREATE TABLE "org_integrations"');
    expect(migration).not.toContain('"binding_generations"');
    expect(tables).not.toHaveProperty("public.org_integrations");
  });

  it("owns the complete P1 table model with direct indexed tenant roots", () => {
    expect(TABLES).toHaveLength(22);
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

  it("creates every composite FK target unique index before the first dependent FK", () => {
    const requiredBefore = [
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "projects_org_project_unique"',
        firstFk: 'CONSTRAINT "capability_nodes_project_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "specs_org_spec_unique"',
        firstFk: 'CONSTRAINT "spec_capability_dependencies_spec_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "specs_org_project_spec_unique"',
        firstFk: 'CONSTRAINT "spec_capability_dependencies_spec_fk" FOREIGN KEY ("org_id","project_id","spec_id")',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "org_integration_connections_provider_id_unique"',
        firstFk: 'CONSTRAINT "project_integration_grant_selections_connection_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "org_integration_grants_connection_id_unique"',
        firstFk: 'CONSTRAINT "project_integration_grant_selections_grant_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "integration_requirements_project_id_unique"',
        firstFk: 'CONSTRAINT "capability_nodes_requirement_lineage_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "capability_nodes_org_project_id_unique"',
        firstFk:
          'CONSTRAINT "capability_node_dependencies_node_fk" FOREIGN KEY ("org_id","project_id","capability_node_id")',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "integration_binding_generations_binding_generation_unique"',
        firstFk: 'CONSTRAINT "integration_binding_env_binding_generation_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "integration_binding_env_output_unique"',
        firstFk:
          'CONSTRAINT "project_app_env_binding_output_fk" FOREIGN KEY ("org_id","project_id","binding_id","binding_generation","key")',
      },
      // Frozen-spine (0034/0035/0037/0039) parent targets are not drizzle-managed,
      // so they are added as raw SQL here in 0041 before the composite FKs that
      // reference them. Org RLS is not same-org referential integrity.
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "behavior_revisions_org_project_id_unique"',
        firstFk:
          'CONSTRAINT "behavior_integration_requirements_behavior_revision_fk" FOREIGN KEY ("org_id","project_id","behavior_revision_id")',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "behavior_verdicts_org_project_id_unique"',
        firstFk:
          'CONSTRAINT "integration_validation_proofs_behavior_verdict_fk" FOREIGN KEY ("org_id","project_id","behavior_verdict_id")',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "proof_units_org_project_digest_unique"',
        firstFk:
          'CONSTRAINT "integration_validation_proofs_proof_unit_fk" FOREIGN KEY ("org_id","project_id","proof_unit_digest")',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "authority_decisions_org_project_id_unique"',
        firstFk:
          'CONSTRAINT "delivery_runs_authority_decision_fk" FOREIGN KEY ("org_id","project_id","authority_decision_id")',
      },
    ] as const;
    for (const { uniqueIndex, firstFk } of requiredBefore) {
      const indexAt = migration.indexOf(uniqueIndex);
      const fkAt = migration.indexOf(firstFk);
      expect(indexAt, `${uniqueIndex} missing`).toBeGreaterThanOrEqual(0);
      expect(fkAt, `${firstFk} missing`).toBeGreaterThanOrEqual(0);
      expect(indexAt).toBeLessThan(fkAt);
    }
  });

  it("binds every project-bearing endpoint with a shared child project_id (same-org referential integrity)", () => {
    // Governing rule: for every relationship whose endpoints have project identity,
    // the child row has one shared project_id and every endpoint FK includes that
    // same column. Two independent project columns are not sufficient unless
    // equality is database-enforced; org RLS is not same-org referential integrity.
    const compositeFkColumns: Record<string, string> = {
      // requirement supersession
      integration_requirements_superseded_by_fk: '("org_id","project_id","superseded_by")',
      // behavior↔requirement (both endpoints bound to shared project_id)
      behavior_integration_requirements_requirement_fk: '("org_id","project_id","requirement_id")',
      behavior_integration_requirements_behavior_revision_fk: '("org_id","project_id","behavior_revision_id")',
      // capability node↔node dependency (both node endpoints composite + project FK)
      capability_node_dependencies_node_fk: '("org_id","project_id","capability_node_id")',
      capability_node_dependencies_parent_fk: '("org_id","project_id","depends_on_capability_node_id")',
      // spec↔capability node (both endpoints composite)
      spec_capability_dependencies_spec_fk: '("org_id","project_id","spec_id")',
      spec_capability_dependencies_node_fk: '("org_id","project_id","capability_node_id")',
      // binding generation lineage (reconciliation / snapshot / proof / run-binding / env)
      integration_binding_env_binding_generation_fk: '("org_id","project_id","binding_id","binding_generation")',
      delivery_run_bindings_binding_generation_fk: '("org_id","project_id","binding_id","binding_generation")',
      integration_reconciliations_binding_generation_fk: '("org_id","project_id","binding_id","binding_generation")',
      integration_resource_snapshots_binding_generation_fk: '("org_id","project_id","binding_id","binding_generation")',
      integration_validation_proofs_binding_generation_fk: '("org_id","project_id","binding_id","binding_generation")',
      // delivery run↔authority decision
      delivery_runs_authority_decision_fk: '("org_id","project_id","authority_decision_id")',
      // proof spine (spec / revision / verdict / proof unit)
      integration_validation_proofs_spec_fk: '("org_id","project_id","spec_id")',
      integration_validation_proofs_behavior_revision_fk: '("org_id","project_id","behavior_revision_id")',
      integration_validation_proofs_behavior_verdict_fk: '("org_id","project_id","behavior_verdict_id")',
      integration_validation_proofs_proof_unit_fk: '("org_id","project_id","proof_unit_digest")',
      // project app env↔binding output (five-column common-project FK)
      project_app_env_binding_output_fk: '("org_id","project_id","binding_id","binding_generation","key")',
    };
    for (const [fk, columns] of Object.entries(compositeFkColumns)) {
      const needle = `CONSTRAINT "${fk}" FOREIGN KEY ${columns}`;
      expect(migration, `${fk} must bind exactly ${columns}`).toContain(needle);
    }
    // The parallel weaker org-only delivery_run_bindings_binding_fk must be gone.
    expect(migration).not.toContain('"delivery_run_bindings_binding_fk"');
  });

  it("pins principal/generation authority and no fake dev provisioned bypass", () => {
    expect(migration).toContain("provider_principal_id");
    expect(migration).toContain("org_integration_connection_auth_generations");
    expect(migration).toContain("org_integration_grant_generations");
    expect(migration).toContain("delivery_run_bindings");
    expect(migration).toContain("project_derivations");
    expect(migration).toContain("projects_lifecycle_check");
    expect(migration).toContain("deriving");
    expect(migration).toContain('CONSTRAINT "project_app_env_binding_check"');
    expect(migration).not.toContain("manual-link.v1");
  });

  it("round-trips the migration-valid deriving lifecycle through the real repository and project route", async () => {
    const response = await derivingProjectRouteHarness("deriving").request(
      "/orgs/org_deriving/projects/project_deriving",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ projectId: "project_deriving", lifecycle: "deriving" });
  });

  it("fails closed when the repository reads a lifecycle outside the database contract", async () => {
    const response = await derivingProjectRouteHarness("provisioning").request(
      "/orgs/org_deriving/projects/project_deriving",
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });

  it("keeps all schema exports aligned and under the architecture line cap", async () => {
    const exports = [
      "orgIntegrationConnections",
      "orgIntegrationConnectionAuthGenerations",
      "orgIntegrationConnectionOperations",
      "orgIntegrationGrants",
      "orgIntegrationGrantGenerations",
      "integrationRequirements",
      "behaviorIntegrationRequirements",
      "capabilityNodes",
      "capabilityNodeDependencies",
      "specCapabilityDependencies",
      "integrationBindings",
      "integrationBindingGenerations",
      "integrationBindingEnv",
      "projectAppEnv",
      "projectIntegrationGrantSelections",
      "integrationReconciliations",
      "integrationResourceSnapshots",
      "deliveryRuns",
      "deliveryRunBindings",
      "deliveryStageAttempts",
      "integrationValidationProofs",
      "projectDerivations",
    ];
    for (const name of exports) expect(schemas).toContain(`export const ${name} = pgTable(`);
    for (const path of schemaPaths) {
      expect((await readFile(path, "utf8")).split("\n").length).toBeLessThanOrEqual(500);
    }
    expect(schemas).not.toContain("schemaIntegrationLifecycle");
  });
});
