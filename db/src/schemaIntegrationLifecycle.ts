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
import { organizations, projects, specs } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { behaviorRevisionsReference } from "./schemaSpineReferences.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

export const orgIntegrationConnections = pgTable(
  "org_integration_connections",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    providerKind: text("provider_kind").notNull(),
    upstreamAccountId: text("upstream_account_id").notNull(),
    authKind: text("auth_kind").notNull(),
    credentialRef: text("credential_ref").notNull(),
    authGeneration: integer("auth_generation").notNull().default(1),
    ownerId: text("owner_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    health: text("health").notNull().default("unknown"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("org_integration_connections_account_unique").on(
      table.orgId,
      table.providerKind,
      table.upstreamAccountId,
    ),
    uniqueIndex("org_integration_connections_provider_id_unique").on(table.orgId, table.providerKind, table.id),
    index("org_integration_connections_org_id").on(table.orgId),
    index("org_integration_connections_org_provider").on(table.orgId, table.providerKind),
    check("org_integration_connections_auth_generation_check", sql`${table.authGeneration} >= 1`),
    check(
      "org_integration_connections_auth_kind_check",
      sql`${table.authKind} IN ('api_key','oauth2','bot_token','webhook','workload_identity')`,
    ),
    check(
      "org_integration_connections_health_check",
      sql`${table.health} IN ('unknown','healthy','degraded','invalid')`,
    ),
    check("org_integration_connections_status_check", sql`${table.status} IN ('active','revoked')`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const orgIntegrationGrants = pgTable(
  "org_integration_grants",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    connectionId: text("connection_id").notNull(),
    plane: text("plane").notNull(),
    environment: text("environment").notNull(),
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
    generation: integer("generation").notNull().default(1),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.connectionId],
      foreignColumns: [orgIntegrationConnections.orgId, orgIntegrationConnections.id],
      name: "org_integration_grants_connection_fk",
    }),
    uniqueIndex("org_integration_grants_generation_unique").on(
      table.orgId,
      table.connectionId,
      table.plane,
      table.environment,
      table.generation,
    ),
    uniqueIndex("org_integration_grants_connection_id_unique").on(table.orgId, table.connectionId, table.id),
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
    check("org_integration_grants_generation_check", sql`${table.generation} >= 1`),
    check("org_integration_grants_status_check", sql`${table.status} IN ('pending','active','expired','revoked')`),
    check(
      "org_integration_grants_revoked_check",
      sql`(${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL) OR (${table.status} <> 'revoked' AND ${table.revokedAt} IS NULL)`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const integrationRequirements = pgTable(
  "integration_requirements",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    capability: text("capability").notNull(),
    plane: text("plane").notNull(),
    direction: text("direction").notNull(),
    desiredState: jsonb("desired_state").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceRevisionId: text("source_revision_id").notNull(),
    sourceDigest: text("source_digest").notNull(),
    policyVersion: text("policy_version").notNull(),
    criticality: text("criticality").notNull(),
    status: text("status").notNull().default("active"),
    supersededBy: text("superseded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "integration_requirements_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.supersededBy],
      foreignColumns: [table.orgId, table.id],
      name: "integration_requirements_superseded_by_fk",
    }),
    uniqueIndex("integration_requirements_active_source_unique")
      .on(table.orgId, table.projectId, table.sourceKind, table.sourceRevisionId, table.sourceDigest)
      .where(sql`status = 'active'`),
    index("integration_requirements_org_id").on(table.orgId),
    index("integration_requirements_org_project").on(table.orgId, table.projectId),
    check("integration_requirements_plane_check", sql`${table.plane} IN ('control','product')`),
    check(
      "integration_requirements_direction_check",
      sql`${table.direction} IN ('inbound','outbound','bidirectional')`,
    ),
    check(
      "integration_requirements_source_kind_check",
      sql`${table.sourceKind} IN ('behavior_revision','design_contract')`,
    ),
    check("integration_requirements_source_digest_check", sql`${table.sourceDigest} ~ ${digestPattern}`),
    check(
      "integration_requirements_criticality_check",
      sql`${table.criticality} IN ('merge_required','release_required','best_effort')`,
    ),
    check("integration_requirements_status_check", sql`${table.status} IN ('active','superseded','needs_attention')`),
    check(
      "integration_requirements_superseded_check",
      sql`(${table.status} = 'superseded' AND ${table.supersededBy} IS NOT NULL) OR (${table.status} <> 'superseded' AND ${table.supersededBy} IS NULL)`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const behaviorIntegrationRequirements = pgTable(
  "behavior_integration_requirements",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    behaviorRevisionId: text("behavior_revision_id").notNull(),
    requirementId: text("requirement_id").notNull(),
    relationRole: text("relation_role").notNull().default("requires"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.behaviorRevisionId, table.requirementId] }),
    foreignKey({
      columns: [table.orgId, table.requirementId],
      foreignColumns: [integrationRequirements.orgId, integrationRequirements.id],
      name: "behavior_integration_requirements_requirement_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.behaviorRevisionId],
      foreignColumns: [behaviorRevisionsReference.orgId, behaviorRevisionsReference.id],
      name: "behavior_integration_requirements_behavior_revision_fk",
    }),
    index("behavior_integration_requirements_org_id").on(table.orgId),
    index("behavior_integration_requirements_org_behavior").on(table.orgId, table.behaviorRevisionId),
    check(
      "behavior_integration_requirements_role_check",
      sql`${table.relationRole} IN ('requires','triggers','observes')`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const capabilityNodes = pgTable(
  "capability_nodes",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    requirementId: text("requirement_id").notNull(),
    environment: text("environment").notNull(),
    executorKind: text("executor_kind").notNull().default("provider_operation"),
    desiredStateHash: text("desired_state_hash").notNull(),
    status: text("status").notNull().default("pending"),
    waitReason: text("wait_reason"),
    priority: integer("priority").notNull().default(0),
    generation: integer("generation").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "capability_nodes_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.requirementId],
      foreignColumns: [integrationRequirements.orgId, integrationRequirements.id],
      name: "capability_nodes_requirement_fk",
    }),
    uniqueIndex("capability_nodes_requirement_generation_unique").on(
      table.orgId,
      table.requirementId,
      table.environment,
      table.generation,
    ),
    index("capability_nodes_org_id").on(table.orgId),
    index("capability_nodes_ready_order").on(table.orgId, table.projectId, table.status, table.priority, table.id),
    check("capability_nodes_environment_check", sql`${table.environment} IN ('test','preview','production')`),
    check("capability_nodes_executor_check", sql`${table.executorKind} IN ('provider_operation')`),
    check("capability_nodes_desired_hash_check", sql`${table.desiredStateHash} ~ ${digestPattern}`),
    check(
      "capability_nodes_status_check",
      sql`${table.status} IN ('pending','enqueued','awaiting_grant','ready','needs_attention')`,
    ),
    check("capability_nodes_wait_reason_check", sql`${table.status} = 'awaiting_grant' OR ${table.waitReason} IS NULL`),
    check("capability_nodes_priority_check", sql`${table.priority} >= 0`),
    check("capability_nodes_generation_check", sql`${table.generation} >= 1`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const capabilityNodeDependencies = pgTable(
  "capability_node_dependencies",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    capabilityNodeId: text("capability_node_id").notNull(),
    dependsOnCapabilityNodeId: text("depends_on_capability_node_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.capabilityNodeId, table.dependsOnCapabilityNodeId] }),
    foreignKey({
      columns: [table.orgId, table.capabilityNodeId],
      foreignColumns: [capabilityNodes.orgId, capabilityNodes.id],
      name: "capability_node_dependencies_node_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.dependsOnCapabilityNodeId],
      foreignColumns: [capabilityNodes.orgId, capabilityNodes.id],
      name: "capability_node_dependencies_parent_fk",
    }),
    index("capability_node_dependencies_org_id").on(table.orgId),
    check(
      "capability_node_dependencies_no_self_check",
      sql`${table.capabilityNodeId} <> ${table.dependsOnCapabilityNodeId}`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const specCapabilityDependencies = pgTable(
  "spec_capability_dependencies",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    specId: text("spec_id").notNull(),
    capabilityNodeId: text("capability_node_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.specId, table.capabilityNodeId] }),
    foreignKey({
      columns: [table.orgId, table.specId],
      foreignColumns: [specs.orgId, specs.specId],
      name: "spec_capability_dependencies_spec_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.capabilityNodeId],
      foreignColumns: [capabilityNodes.orgId, capabilityNodes.id],
      name: "spec_capability_dependencies_node_fk",
    }),
    index("spec_capability_dependencies_org_id").on(table.orgId),
    index("spec_capability_dependencies_org_spec").on(table.orgId, table.specId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const integrationBindings = pgTable(
  "integration_bindings",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    requirementId: text("requirement_id").notNull(),
    grantId: text("grant_id").notNull(),
    environment: text("environment").notNull(),
    providerKind: text("provider_kind").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    externalResourceId: text("external_resource_id").notNull(),
    externalResourceName: text("external_resource_name").notNull(),
    ownership: text("ownership").notNull(),
    teardownPolicy: text("teardown_policy").notNull(),
    desiredStateHash: text("desired_state_hash").notNull(),
    observedStateHash: text("observed_state_hash"),
    generation: integer("generation").notNull().default(1),
    observedGeneration: integer("observed_generation"),
    providerEtag: text("provider_etag"),
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
      columns: [table.orgId, table.requirementId],
      foreignColumns: [integrationRequirements.orgId, integrationRequirements.id],
      name: "integration_bindings_requirement_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.grantId],
      foreignColumns: [orgIntegrationGrants.orgId, orgIntegrationGrants.id],
      name: "integration_bindings_grant_fk",
    }),
    uniqueIndex("integration_bindings_requirement_generation_unique").on(
      table.orgId,
      table.requirementId,
      table.environment,
      table.generation,
    ),
    index("integration_bindings_org_id").on(table.orgId),
    index("integration_bindings_org_project").on(table.orgId, table.projectId),
    check("integration_bindings_environment_check", sql`${table.environment} IN ('test','preview','production')`),
    check("integration_bindings_ownership_check", sql`${table.ownership} IN ('created','adopted','shared')`),
    check("integration_bindings_teardown_check", sql`${table.teardownPolicy} IN ('delete','retain')`),
    check("integration_bindings_desired_hash_check", sql`${table.desiredStateHash} ~ ${digestPattern}`),
    check(
      "integration_bindings_observed_hash_check",
      sql`${table.observedStateHash} IS NULL OR ${table.observedStateHash} ~ ${digestPattern}`,
    ),
    check("integration_bindings_generation_check", sql`${table.generation} >= 1`),
    check(
      "integration_bindings_observed_generation_check",
      sql`${table.observedGeneration} IS NULL OR ${table.observedGeneration} >= 1`,
    ),
    check(
      "integration_bindings_status_check",
      sql`${table.status} IN ('pending','ready','drifted','needs_attention','retired')`,
    ),
    check("integration_bindings_drift_check", sql`${table.driftState} IN ('unknown','in_sync','drifted')`),
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
    primaryKey({ columns: [table.orgId, table.bindingId, table.key] }),
    foreignKey({
      columns: [table.orgId, table.bindingId],
      foreignColumns: [integrationBindings.orgId, integrationBindings.id],
      name: "integration_binding_env_binding_fk",
    }),
    index("integration_binding_env_org_id").on(table.orgId),
    check("integration_binding_env_classification_check", sql`${table.classification} IN ('secret','non_secret')`),
    check("integration_binding_env_required_check", sql`${table.required} IN (0,1)`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
