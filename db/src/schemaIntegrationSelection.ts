import { foreignKey, index, integer, pgTable, primaryKey, text, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, projects } from "./schemaCore.js";
import {
  orgIntegrationConnectionAuthGenerations,
  orgIntegrationConnections,
  orgIntegrationGrantGenerations,
  orgIntegrationGrants,
} from "./schemaIntegrationConnections.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

/** Exact project/provider generation pin. Currentness is eligibility, not storage. */
export const projectIntegrationGrantSelections = pgTable(
  "project_integration_grant_selections",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    providerKind: text("provider_kind").notNull(),
    connectionId: text("connection_id").notNull(),
    authGeneration: integer("auth_generation").notNull(),
    grantId: text("grant_id").notNull(),
    grantGeneration: integer("grant_generation").notNull(),
    selectedBy: text("selected_by").notNull(),
    selectedAt: timestamp("selected_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.projectId, table.providerKind] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "project_integration_grant_selections_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.providerKind, table.connectionId],
      foreignColumns: [
        orgIntegrationConnections.orgId,
        orgIntegrationConnections.providerKind,
        orgIntegrationConnections.id,
      ],
      name: "project_integration_grant_selections_connection_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.providerKind, table.connectionId, table.authGeneration],
      foreignColumns: [
        orgIntegrationConnectionAuthGenerations.orgId,
        orgIntegrationConnectionAuthGenerations.providerKind,
        orgIntegrationConnectionAuthGenerations.connectionId,
        orgIntegrationConnectionAuthGenerations.generation,
      ],
      name: "project_integration_grant_selections_auth_generation_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.connectionId, table.grantId],
      foreignColumns: [orgIntegrationGrants.orgId, orgIntegrationGrants.connectionId, orgIntegrationGrants.id],
      name: "project_integration_grant_selections_grant_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.providerKind, table.connectionId, table.grantId, table.grantGeneration],
      foreignColumns: [
        orgIntegrationGrantGenerations.orgId,
        orgIntegrationGrantGenerations.providerKind,
        orgIntegrationGrantGenerations.connectionId,
        orgIntegrationGrantGenerations.grantId,
        orgIntegrationGrantGenerations.generation,
      ],
      name: "project_integration_grant_selections_grant_generation_fk",
    }),
    index("project_integration_grant_selections_org_id").on(table.orgId),
    index("project_integration_grant_selections_org_project").on(table.orgId, table.projectId),
    check("project_integration_grant_selections_auth_generation_check", sql`${table.authGeneration} >= 1`),
    check("project_integration_grant_selections_grant_generation_check", sql`${table.grantGeneration} >= 1`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
