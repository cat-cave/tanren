import { foreignKey, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { orgIntegrationConnections, orgIntegrationGrants } from "./schemaIntegrationLifecycle.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

/** Exact project/provider account choice. Ambiguity is persisted, never guessed. */
export const projectIntegrationGrantSelections = pgTable(
  "project_integration_grant_selections",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    providerKind: text("provider_kind").notNull(),
    connectionId: text("connection_id").notNull(),
    grantId: text("grant_id").notNull(),
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
      columns: [table.orgId, table.connectionId, table.grantId],
      foreignColumns: [orgIntegrationGrants.orgId, orgIntegrationGrants.connectionId, orgIntegrationGrants.id],
      name: "project_integration_grant_selections_grant_fk",
    }),
    index("project_integration_grant_selections_org_id").on(table.orgId),
    index("project_integration_grant_selections_org_project").on(table.orgId, table.projectId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
