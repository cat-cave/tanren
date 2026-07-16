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
import {
  orgIntegrationConnectionAuthGenerations,
  orgIntegrationConnections,
  orgIntegrationGrantGenerations,
  orgIntegrationGrants,
} from "./schemaIntegrationConnections.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { integrationRequirements } from "./schemaIntegrationRequirements.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

/** Stable binding identity; generation payload is immutable. */
export const integrationBindings = pgTable(
  "integration_bindings",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    requirementId: text("requirement_id").notNull(),
    environment: text("environment").notNull(),
    providerKind: text("provider_kind").notNull(),
    connectionId: text("connection_id").notNull(),
    currentGeneration: integer("current_generation"),
    status: text("status").notNull().default("pending"),
    driftState: text("drift_state").notNull().default("unknown"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "integration_bindings_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.requirementId],
      foreignColumns: [integrationRequirements.orgId, integrationRequirements.projectId, integrationRequirements.id],
      name: "integration_bindings_requirement_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.providerKind, table.connectionId],
      foreignColumns: [
        orgIntegrationConnections.orgId,
        orgIntegrationConnections.providerKind,
        orgIntegrationConnections.id,
      ],
      name: "integration_bindings_connection_fk",
    }),
    uniqueIndex("integration_bindings_lineage_unique").on(
      table.orgId,
      table.projectId,
      table.requirementId,
      table.environment,
      table.id,
    ),
    uniqueIndex("integration_bindings_requirement_generation_unique")
      .on(table.orgId, table.requirementId, table.environment)
      .where(sql`status IN ('pending','ready','drifted','needs_attention')`),
    index("integration_bindings_org_id").on(table.orgId),
    index("integration_bindings_org_project").on(table.orgId, table.projectId),
    check("integration_bindings_environment_check", sql`${table.environment} IN ('test','preview','production')`),
    check(
      "integration_bindings_current_generation_check",
      sql`${table.currentGeneration} IS NULL OR ${table.currentGeneration} >= 1`,
    ),
    check(
      "integration_bindings_status_check",
      sql`${table.status} IN ('pending','ready','drifted','needs_attention','retired')`,
    ),
    check("integration_bindings_drift_check", sql`${table.driftState} IN ('unknown','in_sync','drifted')`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const integrationBindingGenerations = pgTable(
  "integration_binding_generations",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    requirementId: text("requirement_id").notNull(),
    environment: text("environment").notNull(),
    bindingId: text("binding_id").notNull(),
    generation: integer("generation").notNull(),
    providerKind: text("provider_kind").notNull(),
    connectionId: text("connection_id").notNull(),
    authGeneration: integer("auth_generation").notNull(),
    grantId: text("grant_id").notNull(),
    grantGeneration: integer("grant_generation").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    externalResourceId: text("external_resource_id").notNull(),
    externalResourceName: text("external_resource_name").notNull(),
    ownership: text("ownership").notNull(),
    teardownPolicy: text("teardown_policy").notNull(),
    desiredStateHash: text("desired_state_hash").notNull(),
    observedStateHash: text("observed_state_hash"),
    observedGeneration: integer("observed_generation"),
    providerEtag: text("provider_etag"),
    status: text("status").notNull().default("pending"),
    driftState: text("drift_state").notNull().default("unknown"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.orgId,
        table.projectId,
        table.requirementId,
        table.environment,
        table.bindingId,
        table.generation,
      ],
    }),
    uniqueIndex("integration_binding_generations_binding_generation_unique").on(
      table.orgId,
      table.bindingId,
      table.generation,
    ),
    foreignKey({
      columns: [table.orgId, table.projectId, table.requirementId, table.environment, table.bindingId],
      foreignColumns: [
        integrationBindings.orgId,
        integrationBindings.projectId,
        integrationBindings.requirementId,
        integrationBindings.environment,
        integrationBindings.id,
      ],
      name: "integration_binding_generations_binding_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.providerKind, table.connectionId, table.authGeneration],
      foreignColumns: [
        orgIntegrationConnectionAuthGenerations.orgId,
        orgIntegrationConnectionAuthGenerations.providerKind,
        orgIntegrationConnectionAuthGenerations.connectionId,
        orgIntegrationConnectionAuthGenerations.generation,
      ],
      name: "integration_binding_generations_auth_generation_fk",
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
      name: "integration_binding_generations_grant_generation_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.providerKind, table.connectionId, table.grantId],
      foreignColumns: [
        orgIntegrationGrants.orgId,
        orgIntegrationGrants.providerKind,
        orgIntegrationGrants.connectionId,
        orgIntegrationGrants.id,
      ],
      name: "integration_binding_generations_grant_fk",
    }),
    index("integration_binding_generations_org_id").on(table.orgId),
    check(
      "integration_binding_generations_environment_check",
      sql`${table.environment} IN ('test','preview','production')`,
    ),
    check("integration_binding_generations_generation_check", sql`${table.generation} >= 1`),
    check("integration_binding_generations_auth_generation_check", sql`${table.authGeneration} >= 1`),
    check("integration_binding_generations_grant_generation_check", sql`${table.grantGeneration} >= 1`),
    check("integration_binding_generations_ownership_check", sql`${table.ownership} IN ('created','adopted','shared')`),
    check("integration_binding_generations_teardown_check", sql`${table.teardownPolicy} IN ('delete','retain')`),
    check("integration_binding_generations_desired_hash_check", sql`${table.desiredStateHash} ~ ${digestPattern}`),
    check(
      "integration_binding_generations_observed_hash_check",
      sql`${table.observedStateHash} IS NULL OR ${table.observedStateHash} ~ ${digestPattern}`,
    ),
    check(
      "integration_binding_generations_observed_generation_check",
      sql`${table.observedGeneration} IS NULL OR ${table.observedGeneration} >= 1`,
    ),
    check(
      "integration_binding_generations_status_check",
      sql`${table.status} IN ('pending','ready','drifted','needs_attention','retired')`,
    ),
    check(
      "integration_binding_generations_ready_resource_check",
      sql`${table.status} <> 'ready' OR (${table.externalResourceId} <> '' AND ${table.externalResourceName} <> '')`,
    ),
    check(
      "integration_binding_generations_ownership_teardown_check",
      sql`(${table.ownership} = 'created' AND ${table.teardownPolicy} IN ('delete','retain')) OR (${table.ownership} IN ('adopted','shared') AND ${table.teardownPolicy} = 'retain')`,
    ),
    check("integration_binding_generations_drift_check", sql`${table.driftState} IN ('unknown','in_sync','drifted')`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const integrationBindingEnv = pgTable(
  "integration_binding_env",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    bindingId: text("binding_id").notNull(),
    bindingGeneration: integer("binding_generation").notNull(),
    key: text("key").notNull(),
    classification: text("classification").notNull(),
    required: integer("required").notNull().default(1),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.bindingId, table.bindingGeneration, table.key] }),
    uniqueIndex("integration_binding_env_output_unique").on(
      table.orgId,
      table.bindingId,
      table.bindingGeneration,
      table.key,
    ),
    foreignKey({
      columns: [table.orgId, table.bindingId, table.bindingGeneration],
      foreignColumns: [
        integrationBindingGenerations.orgId,
        integrationBindingGenerations.bindingId,
        integrationBindingGenerations.generation,
      ],
      name: "integration_binding_env_binding_generation_fk",
    }),
    index("integration_binding_env_org_id").on(table.orgId),
    check("integration_binding_env_generation_check", sql`${table.bindingGeneration} >= 1`),
    check("integration_binding_env_classification_check", sql`${table.classification} IN ('secret','non_secret')`),
    check("integration_binding_env_required_check", sql`${table.required} IN (0,1)`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
