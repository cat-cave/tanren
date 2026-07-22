import { sql } from "drizzle-orm";
import { check, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

// Reference-only declarations for spine tables created by migrations 0034-0039.
// They are deliberately not exported from schema.ts, so drizzle-kit does not try
// to create a second authority. Lifecycle tables import them solely to serialize
// the real composite foreign keys into the 0043 snapshot and migration.
//
// IN1 same-org cross-project lineage repair: the spine tables are frozen in
// 0034-0039 and not managed by drizzle-kit, so the project-bearing unique
// targets they need (`(org_id, project_id, id)` / `(org_id, project_id,
// proof_unit_digest)`) are added directly in the 0043 migration SQL before the
// dependent FKs. The `projectId` columns below are part of each reference so the
// project-bearing composite FKs serialize with the correct column list. They
// remain unexported from schema.ts so Drizzle never creates a second table
// authority. `behavior_revisions.project_id` is nullable for org-scoped
// revisions (migration 0034); project-bound lifecycle edges intentionally
// cannot cite an org-scoped revision through the composite FK.
export const behaviorRevisionsReference = pgTable("behavior_revisions", {
  orgId: text("org_id").notNull(),
  projectId: text("project_id"),
  id: text("id").notNull(),
});

export const authorityDecisionsReference = pgTable("authority_decisions", {
  orgId: text("org_id").notNull(),
  projectId: text("project_id").notNull(),
  id: text("id").notNull(),
});

/** Reference-only host-CAS intent identity (migration 0039). */
export const authorityEffectIntentsReference = pgTable("authority_effect_intents", {
  orgId: text("org_id").notNull(),
  id: text("id").notNull(),
});

export const casArtifactsReference = pgTable("cas_artifacts", {
  orgId: text("org_id").notNull(),
  digest: text("digest").notNull(),
});

/** Reference-only sealed proof-bundle identity (migration 0035). */
export const proofBundlesReference = pgTable("proof_bundles", {
  orgId: text("org_id").notNull(),
  id: text("id").notNull(),
});

/** Reference-only proof-bundle member identity for SP-7's thin section projection. */
export const proofBundleUnitsReference = pgTable("proof_bundle_units", {
  orgId: text("org_id").notNull(),
  bundleId: text("bundle_id").notNull(),
  proofUnitDigest: text("proof_unit_digest").notNull(),
});

export const proofUnitsReference = pgTable("proof_units", {
  orgId: text("org_id").notNull(),
  projectId: text("project_id").notNull(),
  proofUnitDigest: text("proof_unit_digest").notNull(),
});

export const behaviorVerdictsReference = pgTable("behavior_verdicts", {
  orgId: text("org_id").notNull(),
  projectId: text("project_id").notNull(),
  id: text("id").notNull(),
});

/** Reference-only runtime-verification run identity (migration 0037). */
export const behaviorVerificationRunsReference = pgTable(
  "behavior_verification_runs",
  {
    orgId: text("org_id").notNull(),
    id: text("id").notNull(),
    stage: text("stage"),
    resolutionJobId: text("resolution_job_id"),
    classification: text("classification"),
  },
  (table) => [
    check(
      "behavior_verification_runs_resolution_stage_check",
      sql`${table.stage} IS NULL OR ${table.stage} IN ('baseline','production','counterfactual','soak')`,
    ),
    check(
      "behavior_verification_runs_resolution_classification_check",
      sql`${table.classification} IS NULL OR ${table.classification} IN ('product_resolved','product_failure','infra_failure','stale_contract','inconclusive')`,
    ),
    uniqueIndex("behavior_verification_runs_resolution_job_stage_unique").on(table.resolutionJobId, table.stage),
  ],
);

/** Reference-only runtime-verification attempt identity (migration 0037). */
export const behaviorVerificationAttemptsReference = pgTable("behavior_verification_attempts", {
  orgId: text("org_id").notNull(),
  id: text("id").notNull(),
});

/** Reference-only deployed release identity (migration 0036). */
export const releaseInstancesReference = pgTable("release_instances", {
  orgId: text("org_id").notNull(),
  id: text("id").notNull(),
});
