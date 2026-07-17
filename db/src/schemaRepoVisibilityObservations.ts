import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

// Wave-6 gv-11 reservation: a forge visibility attestation is append-only
// evidence; a changed repository visibility is a separate observation.
export const repositoryVisibilityObservations = pgTable(
  "repository_visibility_observations",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    observationId: text("observation_id").notNull(),
    observedVisibility: text("observed_visibility").notNull(),
    forgeRef: text("forge_ref").notNull(),
    sha: text("sha").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.observationId] }),
    uniqueIndex("repository_visibility_observations_org_project_observation_id_unique").on(
      table.orgId,
      table.projectId,
      table.observationId,
    ),
    index("repository_visibility_observations_org_id").on(table.orgId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "repository_visibility_observations_project_fk",
    }),
    check(
      "repository_visibility_observations_observed_visibility_check",
      sql`${table.observedVisibility} IN ('public','private')`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
