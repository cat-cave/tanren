import { sql } from "drizzle-orm";
import {
  boolean,
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
import { integrationNodes } from "./schemaIntegrationNodes.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { organizations, projects } from "./schemaCore.js";
import { proofBundlesReference, proofBundleUnitsReference } from "./schemaSpineReferences.js";

/** Thin SP-7 projection over a sealed SP-3 bundle, decisive only for one integration node. */
export const gateProofBundles = pgTable(
  "gate_proof_bundles",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    integrationNodeId: text("integration_node_id").notNull(),
    /** Exact native-gate configuration coordinate, never inferred from a mutable node at land time. */
    gateConfigHash: text("gate_config_hash").notNull(),
    /** Exact governance policy coordinate, likewise sealed with the V2 projection. */
    policyVersion: text("policy_version").notNull(),
    /** Read index only; authority also requires this value in the signed SP-3 binding. */
    quarantineVersion: text("quarantine_version").notNull(),
    proofBundleId: text("proof_bundle_id").notNull(),
    gateVerdict: text("gate_verdict").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("gate_proof_bundles_org_proof_bundle_id_unique").on(table.orgId, table.proofBundleId),
    uniqueIndex("gate_proof_bundles_org_integration_node_id_unique").on(table.orgId, table.integrationNodeId),
    uniqueIndex("gate_proof_bundles_org_id_proof_bundle_id_unique").on(table.orgId, table.id, table.proofBundleId),
    index("gate_proof_bundles_org_id").on(table.orgId),
    index("gate_proof_bundles_org_project").on(table.orgId, table.projectId),
    check("gate_proof_bundles_gate_verdict_check", sql`${table.gateVerdict} IN ('passed', 'failed', 'unknown')`),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "gate_proof_bundles_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.integrationNodeId],
      foreignColumns: [integrationNodes.orgId, integrationNodes.nodeId],
      name: "gate_proof_bundles_integration_node_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.proofBundleId],
      foreignColumns: [proofBundlesReference.orgId, proofBundlesReference.id],
      name: "gate_proof_bundles_proof_bundle_fk",
    }),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** Required V2 section membership; all bytes, roots, and signatures remain in SP-3. */
export const gateProofBundleSections = pgTable(
  "gate_proof_bundle_sections",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    gateProofBundleId: text("gate_proof_bundle_id").notNull(),
    proofBundleId: text("proof_bundle_id").notNull(),
    proofUnitDigest: text("proof_unit_digest").notNull(),
    sectionKind: text("section_kind").notNull(),
    ordinal: integer("ordinal").notNull(),
    required: boolean("required").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.gateProofBundleId, table.proofUnitDigest] }),
    uniqueIndex("gate_proof_bundle_sections_org_bundle_ordinal_unique").on(
      table.orgId,
      table.gateProofBundleId,
      table.ordinal,
    ),
    index("gate_proof_bundle_sections_org_id").on(table.orgId),
    index("gate_proof_bundle_sections_org_project").on(table.orgId, table.projectId),
    check(
      "gate_proof_bundle_sections_section_kind_check",
      sql`${table.sectionKind} IN ('native_ci', 'runtime_behavior', 'design_render', 'artifact_provenance')`,
    ),
    check(
      "gate_proof_bundle_sections_proof_unit_digest_check",
      sql`${table.proofUnitDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "gate_proof_bundle_sections_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.gateProofBundleId, table.proofBundleId],
      foreignColumns: [gateProofBundles.orgId, gateProofBundles.id, gateProofBundles.proofBundleId],
      name: "gate_proof_bundle_sections_gate_bundle_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.proofBundleId, table.proofUnitDigest],
      foreignColumns: [
        proofBundleUnitsReference.orgId,
        proofBundleUnitsReference.bundleId,
        proofBundleUnitsReference.proofUnitDigest,
      ],
      name: "gate_proof_bundle_sections_bundle_unit_fk",
    }),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
