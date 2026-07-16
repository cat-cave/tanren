import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

/** Stable verified principal — no credential coordinates on this row. */
export const orgIntegrationConnections = pgTable(
  "org_integration_connections",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    providerKind: text("provider_kind").notNull(),
    providerPrincipalId: text("provider_principal_id").notNull(),
    principalKind: text("principal_kind").notNull(),
    displayName: text("display_name").notNull(),
    principalMetadata: jsonb("principal_metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    health: text("health").notNull().default("unknown"),
    status: text("status").notNull().default("active"),
    currentAuthGeneration: integer("current_auth_generation"),
    ownerId: text("owner_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("org_integration_connections_principal_unique").on(
      table.orgId,
      table.providerKind,
      table.providerPrincipalId,
    ),
    uniqueIndex("org_integration_connections_provider_id_unique").on(table.orgId, table.providerKind, table.id),
    index("org_integration_connections_org_id").on(table.orgId),
    index("org_integration_connections_org_provider").on(table.orgId, table.providerKind),
    check(
      "org_integration_connections_current_auth_generation_check",
      sql`${table.currentAuthGeneration} IS NULL OR ${table.currentAuthGeneration} >= 1`,
    ),
    check(
      "org_integration_connections_principal_kind_check",
      sql`${table.principalKind} IN ('team','organization','user')`,
    ),
    check(
      "org_integration_connections_health_check",
      sql`${table.health} IN ('unknown','healthy','degraded','invalid')`,
    ),
    check("org_integration_connections_status_check", sql`${table.status} IN ('active','revoked')`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** Immutable auth generation — credential ref lives only here. */
export const orgIntegrationConnectionAuthGenerations = pgTable(
  "org_integration_connection_auth_generations",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    providerKind: text("provider_kind").notNull(),
    connectionId: text("connection_id").notNull(),
    generation: integer("generation").notNull(),
    credentialRef: text("credential_ref").notNull(),
    authKind: text("auth_kind").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.providerKind, table.connectionId, table.generation] }),
    foreignKey({
      columns: [table.orgId, table.providerKind, table.connectionId],
      foreignColumns: [
        orgIntegrationConnections.orgId,
        orgIntegrationConnections.providerKind,
        orgIntegrationConnections.id,
      ],
      name: "org_integration_connection_auth_generations_connection_fk",
    }),
    index("org_integration_connection_auth_generations_org_id").on(table.orgId),
    check("org_integration_connection_auth_generations_generation_check", sql`${table.generation} >= 1`),
    check(
      "org_integration_connection_auth_generations_auth_kind_check",
      sql`${table.authKind} IN ('api_key','oauth2','bot_token','webhook','workload_identity')`,
    ),
    check(
      "org_integration_connection_auth_generations_status_check",
      sql`${table.status} IN ('pending','active','superseded')`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** Durable link/rotation operation — stages, idempotency, compensation. */
export const orgIntegrationConnectionOperations = pgTable(
  "org_integration_connection_operations",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    providerKind: text("provider_kind").notNull(),
    connectionId: text("connection_id"),
    operationKind: text("operation_kind").notNull(),
    stage: text("stage").notNull(),
    status: text("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    actorId: text("actor_id").notNull(),
    targetAuthGeneration: integer("target_auth_generation"),
    stagedSecretHandle: text("staged_secret_handle"),
    candidatePrincipals: jsonb("candidate_principals")
      .notNull()
      .default(sql`'[]'::jsonb`),
    selectedPrincipalId: text("selected_principal_id"),
    failureClassification: text("failure_classification"),
    compensationState: jsonb("compensation_state")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.providerKind, table.connectionId],
      foreignColumns: [
        orgIntegrationConnections.orgId,
        orgIntegrationConnections.providerKind,
        orgIntegrationConnections.id,
      ],
      name: "org_integration_connection_operations_connection_fk",
    }),
    uniqueIndex("org_integration_connection_operations_idempotency_unique").on(table.orgId, table.idempotencyKey),
    index("org_integration_connection_operations_org_id").on(table.orgId),
    index("org_integration_connection_operations_org_provider").on(table.orgId, table.providerKind, table.status),
    check(
      "org_integration_connection_operations_kind_check",
      sql`${table.operationKind} IN ('link','rotate','select_principal')`,
    ),
    check(
      "org_integration_connection_operations_stage_check",
      sql`${table.stage} IN ('created','credential_staged','verifying','awaiting_principal_selection','finalizing','completed','failed','compensated')`,
    ),
    check(
      "org_integration_connection_operations_status_check",
      sql`${table.status} IN ('pending','in_progress','awaiting_principal_selection','completed','failed','compensated')`,
    ),
    check(
      "org_integration_connection_operations_target_generation_check",
      sql`${table.targetAuthGeneration} IS NULL OR ${table.targetAuthGeneration} >= 1`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** Stable grant pointer — capability payload lives on generations. */
export const orgIntegrationGrants = pgTable(
  "org_integration_grants",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    providerKind: text("provider_kind").notNull(),
    connectionId: text("connection_id").notNull(),
    plane: text("plane").notNull(),
    environment: text("environment").notNull(),
    currentGeneration: integer("current_generation"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.providerKind, table.connectionId],
      foreignColumns: [
        orgIntegrationConnections.orgId,
        orgIntegrationConnections.providerKind,
        orgIntegrationConnections.id,
      ],
      name: "org_integration_grants_connection_fk",
    }),
    uniqueIndex("org_integration_grants_connection_id_unique").on(table.orgId, table.connectionId, table.id),
    uniqueIndex("org_integration_grants_provider_connection_id_unique").on(
      table.orgId,
      table.providerKind,
      table.connectionId,
      table.id,
    ),
    uniqueIndex("org_integration_grants_active_unique")
      .on(table.orgId, table.connectionId, table.plane, table.environment)
      .where(sql`status = 'active'`),
    index("org_integration_grants_org_id").on(table.orgId),
    index("org_integration_grants_org_connection").on(table.orgId, table.connectionId),
    check("org_integration_grants_plane_check", sql`${table.plane} IN ('control','product')`),
    check(
      "org_integration_grants_environment_check",
      sql`${table.environment} IN ('control','test','preview','production')`,
    ),
    check(
      "org_integration_grants_plane_environment_check",
      sql`(${table.plane} = 'control' AND ${table.environment} = 'control') OR (${table.plane} = 'product' AND ${table.environment} <> 'control')`,
    ),
    check(
      "org_integration_grants_current_generation_check",
      sql`${table.currentGeneration} IS NULL OR ${table.currentGeneration} >= 1`,
    ),
    check("org_integration_grants_status_check", sql`${table.status} IN ('pending','active','expired','revoked')`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** Immutable grant generation — policy, consent, scopes, constraints. */
export const orgIntegrationGrantGenerations = pgTable(
  "org_integration_grant_generations",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    providerKind: text("provider_kind").notNull(),
    connectionId: text("connection_id").notNull(),
    grantId: text("grant_id").notNull(),
    generation: integer("generation").notNull(),
    capabilities: text("capabilities")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    operations: text("operations")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    providerScopes: text("provider_scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    resourceConstraints: jsonb("resource_constraints")
      .notNull()
      .default(sql`'{}'::jsonb`),
    policyRevision: text("policy_revision").notNull(),
    consentRevision: text("consent_revision").notNull(),
    consentActorId: text("consent_actor_id").notNull(),
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.orgId, table.providerKind, table.connectionId, table.grantId, table.generation],
    }),
    foreignKey({
      columns: [table.orgId, table.providerKind, table.connectionId, table.grantId],
      foreignColumns: [
        orgIntegrationGrants.orgId,
        orgIntegrationGrants.providerKind,
        orgIntegrationGrants.connectionId,
        orgIntegrationGrants.id,
      ],
      name: "org_integration_grant_generations_grant_fk",
    }),
    index("org_integration_grant_generations_org_id").on(table.orgId),
    check("org_integration_grant_generations_generation_check", sql`${table.generation} >= 1`),
    check(
      "org_integration_grant_generations_status_check",
      sql`${table.status} IN ('pending','active','superseded','expired','revoked')`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
