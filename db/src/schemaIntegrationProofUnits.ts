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
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

// Wave-6 mq-6 reservation: a proof unit and its derivation graph are immutable
// evidence. Invalidating a proof creates a new unit/root instead of rewriting one.
export const integrationProofUnits = pgTable(
  "integration_proof_units",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    proofUnitId: text("proof_unit_id").notNull(),
    kind: text("kind").notNull(),
    subjectId: text("subject_id").notNull(),
    inputHash: text("input_hash"),
    verdict: text("verdict").notNull(),
    artifactHash: text("artifact_hash"),
    sourceNodeId: text("source_node_id"),
    quarantineEpoch: integer("quarantine_epoch").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.proofUnitId] }),
    uniqueIndex("integration_proof_units_org_project_proof_unit_id_unique").on(
      table.orgId,
      table.projectId,
      table.proofUnitId,
    ),
    index("integration_proof_units_org_id").on(table.orgId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "integration_proof_units_project_fk",
    }),
    check("integration_proof_units_input_hash_check", sql`${table.inputHash} ~ ${digestPattern}`),
    check("integration_proof_units_artifact_hash_check", sql`${table.artifactHash} ~ ${digestPattern}`),
    check("integration_proof_units_verdict_check", sql`${table.verdict} IN ('pass','fail','skipped')`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const integrationProofEdges = pgTable(
  "integration_proof_edges",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    parentUnitId: text("parent_unit_id").notNull(),
    childUnitId: text("child_unit_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.parentUnitId, table.childUnitId] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "integration_proof_edges_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.parentUnitId],
      foreignColumns: [integrationProofUnits.orgId, integrationProofUnits.proofUnitId],
      name: "integration_proof_edges_parent_unit_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.childUnitId],
      foreignColumns: [integrationProofUnits.orgId, integrationProofUnits.proofUnitId],
      name: "integration_proof_edges_child_unit_fk",
    }),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const integrationEvaluationProofs = pgTable(
  "integration_evaluation_proofs",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    evaluationId: text("evaluation_id").notNull(),
    proofUnitId: text("proof_unit_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.evaluationId, table.proofUnitId] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "integration_evaluation_proofs_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.proofUnitId],
      foreignColumns: [integrationProofUnits.orgId, integrationProofUnits.proofUnitId],
      name: "integration_evaluation_proofs_proof_unit_fk",
    }),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
