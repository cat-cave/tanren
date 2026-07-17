import { sql } from "drizzle-orm";
import { check, foreignKey, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { governancePolicyRevisions } from "./schemaGovernance.js";
import { policyBindings } from "./schemaGovernanceTiers.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

// gv-9 — append-only receipts of the effective policy used for a concrete subject.
// The receipt preserves the compiled body and all identifiers needed to prove that
// a later binding change cannot rewrite a historical policy decision.
export const effectivePolicySnapshots = pgTable(
  "effective_policy_snapshots",
  {
    orgId: text("org_id").notNull(),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    bindingId: text("binding_id").notNull(),
    tierId: text("tier_id").notNull(),
    policyRevisionId: text("policy_revision_id").notNull(),
    effectivePolicyHash: text("effective_policy_hash").notNull(),
    compiledBody: jsonb("compiled_body").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    inputsDigest: text("inputs_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.bindingId],
      foreignColumns: [policyBindings.orgId, policyBindings.id],
      name: "effective_policy_snapshots_binding_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.policyRevisionId],
      foreignColumns: [governancePolicyRevisions.orgId, governancePolicyRevisions.id],
      name: "effective_policy_snapshots_policy_revision_fk",
    }),
    check(
      "effective_policy_snapshots_effective_policy_hash_check",
      sql`${table.effectivePolicyHash} ~ ${digestPattern}`,
    ),
    check("effective_policy_snapshots_subject_kind_check", sql`${table.subjectKind} IN ('run','change','activation')`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
