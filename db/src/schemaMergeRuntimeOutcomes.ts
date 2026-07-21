import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { gateProofBundles } from "./schemaGateProofBundles.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { authorityDecisionsReference, authorityEffectIntentsReference } from "./schemaSpineReferences.js";

/** The immutable proof≡effect receipt for every terminal V2 authority outcome. */
export const mergeRuntimeOutcomes = pgTable(
  "merge_runtime_outcomes",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    authorityDecisionId: text("authority_decision_id"),
    effectIntentId: text("effect_intent_id"),
    gateProofBundleId: text("gate_proof_bundle_id").notNull(),
    proofBundleDigest: text("proof_bundle_digest").notNull(),
    proofRoot: text("proof_root").notNull(),
    quarantineVersion: text("quarantine_version").notNull(),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    treeHash: text("tree_hash").notNull(),
    memberSetHash: text("member_set_hash").notNull(),
    decision: text("decision").notNull(),
    result: text("result").notNull(),
    mainSha: text("main_sha"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "merge_runtime_outcomes_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.authorityDecisionId],
      foreignColumns: [authorityDecisionsReference.orgId, authorityDecisionsReference.id],
      name: "merge_runtime_outcomes_authority_decision_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.effectIntentId],
      foreignColumns: [authorityEffectIntentsReference.orgId, authorityEffectIntentsReference.id],
      name: "merge_runtime_outcomes_effect_intent_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.gateProofBundleId],
      foreignColumns: [gateProofBundles.orgId, gateProofBundles.id],
      name: "merge_runtime_outcomes_gate_proof_bundle_fk",
    }),
    uniqueIndex("merge_runtime_outcomes_effect_intent_unique").on(table.orgId, table.effectIntentId),
    index("merge_runtime_outcomes_org_id").on(table.orgId),
    index("merge_runtime_outcomes_org_project").on(table.orgId, table.projectId),
    check(
      "merge_runtime_outcomes_decision_check",
      sql`${table.decision} IN ('authorized','blocked','needs_attention')`,
    ),
    check("merge_runtime_outcomes_result_check", sql`${table.result} IN ('landed','declined','quarantined')`),
    check(
      "merge_runtime_outcomes_effect_shape_check",
      sql`(${table.result} = 'landed' AND ${table.decision} = 'authorized' AND ${table.authorityDecisionId} IS NOT NULL AND ${table.effectIntentId} IS NOT NULL AND ${table.mainSha} IS NOT NULL) OR (${table.result} <> 'landed' AND ${table.authorityDecisionId} IS NULL AND ${table.effectIntentId} IS NULL AND ${table.mainSha} IS NULL)`,
    ),
    check("merge_runtime_outcomes_digest_check", sql`${table.proofBundleDigest} ~ '^sha256:[0-9a-f]{64}$'`),
    check("merge_runtime_outcomes_proof_root_check", sql`${table.proofRoot} ~ '^sha256:[0-9a-f]{64}$'`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
