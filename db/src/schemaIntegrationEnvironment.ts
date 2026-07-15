import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { integrationBindingEnv } from "./schemaIntegrationLifecycle.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

export const projectAppEnv = pgTable(
  "project_app_env",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    environment: text("environment").notNull(),
    key: text("key").notNull(),
    valueRef: text("value_ref"),
    plainValue: text("plain_value"),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    source: text("source").notNull(),
    bindingId: text("binding_id"),
    bindingGeneration: integer("binding_generation"),
    secretGeneration: integer("secret_generation"),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "project_app_env_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.bindingId, table.key],
      foreignColumns: [integrationBindingEnv.orgId, integrationBindingEnv.bindingId, integrationBindingEnv.key],
      name: "project_app_env_binding_output_fk",
    }),
    uniqueIndex("project_app_env_project_environment_key_unique").on(
      table.orgId,
      table.projectId,
      table.environment,
      table.key,
    ),
    index("project_app_env_org_id").on(table.orgId),
    index("project_app_env_org_project").on(table.orgId, table.projectId),
    check("project_app_env_environment_check", sql`${table.environment} IN ('dev','test','preview','production')`),
    check("project_app_env_source_check", sql`${table.source} IN ('byo','provisioned')`),
    check(
      "project_app_env_value_xor_check",
      sql`(${table.valueRef} IS NOT NULL AND ${table.plainValue} IS NULL) OR (${table.valueRef} IS NULL AND ${table.plainValue} IS NOT NULL)`,
    ),
    check(
      "project_app_env_binding_check",
      sql`(${table.source} = 'byo' AND ${table.bindingId} IS NULL AND ${table.bindingGeneration} IS NULL) OR (${table.source} = 'provisioned' AND ${table.bindingId} IS NOT NULL AND ${table.bindingGeneration} >= 1)`,
    ),
    check(
      "project_app_env_secret_generation_check",
      sql`(${table.valueRef} IS NULL AND ${table.secretGeneration} IS NULL) OR (${table.valueRef} IS NOT NULL AND ${table.secretGeneration} >= 1)`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
