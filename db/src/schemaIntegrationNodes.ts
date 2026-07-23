import { sql } from "drizzle-orm";
import {
  boolean,
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
import { organizations, projects, runs, specs } from "./schemaCore.js";
// runs/specs are referenced by base_shift_operations composite FKs only.
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

// Unified integration-node run model (tanren-owns-the-engine.md §3). gv-17 promotes
// the observe-only JSON members vector into authoritative normalized rows plus
// durable base-shift history; JSON remains a dual-written compatibility mirror.
export const integrationNodes = pgTable(
  "integration_nodes",
  {
    nodeId: text("node_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    baseBranch: text("base_branch").notNull(),
    baseSha: text("base_sha").notNull(),
    ref: text("ref").notNull(),
    purpose: text("purpose").notNull(),
    members: jsonb("members")
      .notNull()
      .default(sql`'[]'::jsonb`),
    memberKey: text("member_key").notNull(),
    gateConfigHash: text("gate_config_hash").notNull().default(""),
    policyVersion: text("policy_version").notNull().default(""),
    affectedFingerprint: text("affected_fingerprint").notNull().default(""),
    headSha: text("head_sha"),
    treeHash: text("tree_hash"),
    proofRoot: text("proof_root"),
    quarantineEpoch: integer("quarantine_epoch"),
    toolchainHash: text("toolchain_hash"),
    designContractVersion: text("design_contract_version"),
    behaviorManifestHash: text("behavior_manifest_hash"),
    status: text("status").notNull().default("building"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "integration_nodes_purpose_check",
      sql`${table.purpose} IN ('eager_base','eager_beam','merge_batch','stack_head','bisect_prefix','pre_merge_preview')`,
    ),
    check("integration_nodes_status_check", sql`${table.status} IN ('building','ready','landed','stale')`),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "integration_nodes_project_org_fk",
    }),
    index("integration_nodes_org_id").on(table.orgId),
    index("integration_nodes_org_project").on(table.orgId, table.projectId),
    uniqueIndex("integration_nodes_org_node_unique").on(table.orgId, table.nodeId),
    uniqueIndex("integration_nodes_org_member_key_unique").on(table.orgId, table.memberKey),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

// Gate evidence is reusable only under the complete proof-reuse key.
export const integrationProofs = pgTable(
  "integration_proofs",
  {
    proofId: text("proof_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    nodeId: text("node_id")
      .notNull()
      .references(() => integrationNodes.nodeId),
    proofReuseKey: text("proof_reuse_key").notNull(),
    verdict: text("verdict").notNull(),
    evidence: jsonb("evidence")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "integration_proofs_project_org_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.nodeId],
      foreignColumns: [integrationNodes.orgId, integrationNodes.nodeId],
      name: "integration_proofs_node_org_fk",
    }),
    index("integration_proofs_org_id").on(table.orgId),
    index("integration_proofs_org_project").on(table.orgId, table.projectId),
    index("integration_proofs_node_id").on(table.nodeId),
    uniqueIndex("integration_proofs_org_reuse_key_unique").on(table.orgId, table.proofReuseKey),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** Authoritative ordered member vector for an integration node (gv-17). */
export const integrationNodeMembers = pgTable(
  "integration_node_members",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    nodeId: text("node_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    queueId: text("queue_id"),
    specId: text("spec_id").notNull(),
    runId: text("run_id").notNull(),
    branch: text("branch").notNull(),
    headSha: text("head_sha").notNull(),
    included: boolean("included").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.nodeId, table.ordinal], name: "integration_node_members_pk" }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "integration_node_members_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.nodeId],
      foreignColumns: [integrationNodes.orgId, integrationNodes.nodeId],
      name: "integration_node_members_node_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.specId],
      foreignColumns: [specs.orgId, specs.specId],
      name: "integration_node_members_spec_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.runId],
      foreignColumns: [runs.orgId, runs.runId],
      name: "integration_node_members_run_fk",
    }),
    check("integration_node_members_ordinal_check", sql`${table.ordinal} >= 0`),
    uniqueIndex("integration_node_members_org_node_run_unique").on(table.orgId, table.nodeId, table.runId),
    index("integration_node_members_org_project").on(table.orgId, table.projectId),
    index("integration_node_members_org_node").on(table.orgId, table.nodeId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** Durable before/after member-vector history for every jj restack / base shift. */
export const baseShiftOperations = pgTable(
  "base_shift_operations",
  {
    opId: text("op_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    nodeId: text("node_id"),
    dependentRunId: text("dependent_run_id").notNull(),
    dependentSpecId: text("dependent_spec_id").notNull(),
    ancestorSpecId: text("ancestor_spec_id"),
    fromBaseSha: text("from_base_sha").notNull(),
    toBaseSha: text("to_base_sha").notNull(),
    fromMemberKey: text("from_member_key").notNull(),
    toMemberKey: text("to_member_key").notNull(),
    fromMembers: jsonb("from_members")
      .notNull()
      .default(sql`'[]'::jsonb`),
    toMembers: jsonb("to_members")
      .notNull()
      .default(sql`'[]'::jsonb`),
    decision: text("decision").notNull(),
    invalidationCause: text("invalidation_cause").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.opId], name: "base_shift_operations_pk" }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "base_shift_operations_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.nodeId],
      foreignColumns: [integrationNodes.orgId, integrationNodes.nodeId],
      name: "base_shift_operations_node_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.dependentRunId],
      foreignColumns: [runs.orgId, runs.runId],
      name: "base_shift_operations_dependent_run_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.dependentSpecId],
      foreignColumns: [specs.orgId, specs.specId],
      name: "base_shift_operations_dependent_spec_fk",
    }),
    check(
      "base_shift_operations_decision_check",
      sql`${table.decision} IN ('rebased_clean','rebased_resolved','replanned','held')`,
    ),
    check(
      "base_shift_operations_cause_check",
      sql`${table.invalidationCause} IN ('ancestor_landed','base_moved','member_head_moved','stack_restack','policy_changed','proof_stale')`,
    ),
    index("base_shift_operations_org_project").on(table.orgId, table.projectId),
    index("base_shift_operations_org_dependent_run").on(table.orgId, table.dependentRunId),
    index("base_shift_operations_org_node").on(table.orgId, table.nodeId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
