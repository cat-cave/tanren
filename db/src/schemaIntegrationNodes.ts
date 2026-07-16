import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";

// Wave 2's unified integration-node read model. It remains observe-only; moving
// it out of schemaCore keeps the shared lineage schema below the architecture cap.
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
    status: text("status").notNull().default("building"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "integration_nodes_purpose_check",
      sql`${table.purpose} IN ('eager_base','merge_batch','stack_head','bisect_prefix')`,
    ),
    check("integration_nodes_status_check", sql`${table.status} IN ('building','ready','landed','stale')`),
    index("integration_nodes_org_id").on(table.orgId),
    index("integration_nodes_org_project").on(table.orgId, table.projectId),
    uniqueIndex("integration_nodes_org_member_key_unique").on(table.orgId, table.memberKey),
  ],
);

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
    index("integration_proofs_org_id").on(table.orgId),
    index("integration_proofs_org_project").on(table.orgId, table.projectId),
    index("integration_proofs_node_id").on(table.nodeId),
    uniqueIndex("integration_proofs_org_reuse_key_unique").on(table.orgId, table.proofReuseKey),
  ],
);
