import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

export const governanceTiers = pgTable(
  "governance_tiers",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    tierName: text("tier_name").notNull(),
    preset: text("preset").notNull(),
    tierJson: jsonb("tier_json").notNull(),
    canonicalHash: text("canonical_hash").notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "governance_tiers_project_fk",
    }),
    uniqueIndex("governance_tiers_org_project_id_unique").on(table.orgId, table.projectId, table.id),
    uniqueIndex("governance_tiers_project_name_unique").on(table.orgId, table.projectId, table.tierName),
    index("governance_tiers_org_id").on(table.orgId),
    index("governance_tiers_org_project_hash").on(table.orgId, table.projectId, table.canonicalHash),
    check("governance_tiers_canonical_hash_check", sql`${table.canonicalHash} ~ ${digestPattern}`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const policyBindings = pgTable(
  "policy_bindings",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    tierId: text("tier_id").notNull(),
    effectivePolicyHash: text("effective_policy_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "policy_bindings_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.tierId],
      foreignColumns: [governanceTiers.orgId, governanceTiers.projectId, governanceTiers.id],
      name: "policy_bindings_tier_fk",
    }),
    index("policy_bindings_org_id").on(table.orgId),
    index("policy_bindings_org_project").on(table.orgId, table.projectId),
    uniqueIndex("policy_bindings_org_project_tier_unique").on(table.orgId, table.projectId, table.tierId),
    check("policy_bindings_effective_policy_hash_check", sql`${table.effectivePolicyHash} ~ ${digestPattern}`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
