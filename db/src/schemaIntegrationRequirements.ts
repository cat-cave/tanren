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
      columns: [table.orgId, table.projectId, table.supersededBy],
      foreignColumns: [table.orgId, table.projectId, table.id],
      name: "integration_requirements_superseded_by_fk",
    }),
    uniqueIndex("integration_requirements_project_id_unique").on(table.orgId, table.projectId, table.id),
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
    // One shared child project_id bound to BOTH endpoints: a Project-A behavior
    // revision cannot cite a Project-B requirement (same-org referential
    // integrity is enforced at the FK, not via org RLS).
    projectId: text("project_id").notNull(),
    behaviorRevisionId: text("behavior_revision_id").notNull(),
    requirementId: text("requirement_id").notNull(),
    relationRole: text("relation_role").notNull().default("requires"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.orgId, table.projectId, table.behaviorRevisionId, table.requirementId],
    }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "behavior_integration_requirements_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.requirementId],
      foreignColumns: [integrationRequirements.orgId, integrationRequirements.projectId, integrationRequirements.id],
      name: "behavior_integration_requirements_requirement_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.behaviorRevisionId],
      foreignColumns: [
        behaviorRevisionsReference.orgId,
        behaviorRevisionsReference.projectId,
        behaviorRevisionsReference.id,
      ],
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
      columns: [table.orgId, table.projectId, table.requirementId],
      foreignColumns: [integrationRequirements.orgId, integrationRequirements.projectId, integrationRequirements.id],
      name: "capability_nodes_requirement_lineage_fk",
    }),
    uniqueIndex("capability_nodes_org_project_id_unique").on(table.orgId, table.projectId, table.id),
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
    projectId: text("project_id").notNull(),
    capabilityNodeId: text("capability_node_id").notNull(),
    dependsOnCapabilityNodeId: text("depends_on_capability_node_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.projectId, table.capabilityNodeId, table.dependsOnCapabilityNodeId] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "capability_node_dependencies_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.capabilityNodeId],
      foreignColumns: [capabilityNodes.orgId, capabilityNodes.projectId, capabilityNodes.id],
      name: "capability_node_dependencies_node_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.dependsOnCapabilityNodeId],
      foreignColumns: [capabilityNodes.orgId, capabilityNodes.projectId, capabilityNodes.id],
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
    projectId: text("project_id").notNull(),
    specId: text("spec_id").notNull(),
    capabilityNodeId: text("capability_node_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.projectId, table.specId, table.capabilityNodeId] }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId],
      foreignColumns: [specs.orgId, specs.projectId, specs.specId],
      name: "spec_capability_dependencies_spec_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.capabilityNodeId],
      foreignColumns: [capabilityNodes.orgId, capabilityNodes.projectId, capabilityNodes.id],
      name: "spec_capability_dependencies_node_fk",
    }),
    index("spec_capability_dependencies_org_id").on(table.orgId),
    index("spec_capability_dependencies_org_spec").on(table.orgId, table.specId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
