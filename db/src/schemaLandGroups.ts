import { foreignKey, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { authorityDecisionsReference } from "./schemaSpineReferences.js";

export const landGroups = pgTable(
  "land_groups",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    decisionId: text("decision_id").notNull(),
    expectedMainSha: text("expected_main_sha").notNull(),
    authorizedSha: text("authorized_sha").notNull(),
    state: text("state").notNull(),
    mainSha: text("main_sha"),
    reconcileToken: text("reconcile_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.decisionId],
      foreignColumns: [authorityDecisionsReference.orgId, authorityDecisionsReference.id],
      name: "land_groups_decision_fk",
    }),
    index("land_groups_org_id").on(table.orgId),
    index("land_groups_org_decision").on(table.orgId, table.decisionId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const landGroupMembers = pgTable(
  "land_group_members",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    landGroupId: text("land_group_id").notNull(),
    memberKey: text("member_key").notNull(),
    prNumber: text("pr_number"),
    runId: text("run_id"),
    specId: text("spec_id"),
    outcome: text("outcome"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.landGroupId, table.memberKey] }),
    foreignKey({
      columns: [table.orgId, table.landGroupId],
      foreignColumns: [landGroups.orgId, landGroups.id],
      name: "land_group_members_land_group_fk",
    }),
    index("land_group_members_org_id").on(table.orgId),
    index("land_group_members_org_group").on(table.orgId, table.landGroupId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
