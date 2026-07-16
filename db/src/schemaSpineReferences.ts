import { pgTable, text } from "drizzle-orm/pg-core";

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

export const casArtifactsReference = pgTable("cas_artifacts", {
  orgId: text("org_id").notNull(),
  digest: text("digest").notNull(),
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
