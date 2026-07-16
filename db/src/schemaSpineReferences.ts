import { pgTable, text } from "drizzle-orm/pg-core";

// Reference-only declarations for spine tables created by migrations 0034-0039.
// They are deliberately not exported from schema.ts, so drizzle-kit does not try
// to create a second authority. Lifecycle tables import them solely to serialize
// the real composite foreign keys into the 0041 snapshot and migration.
export const behaviorRevisionsReference = pgTable("behavior_revisions", {
  orgId: text("org_id").notNull(),
  id: text("id").notNull(),
});

export const authorityDecisionsReference = pgTable("authority_decisions", {
  orgId: text("org_id").notNull(),
  id: text("id").notNull(),
});

export const casArtifactsReference = pgTable("cas_artifacts", {
  orgId: text("org_id").notNull(),
  digest: text("digest").notNull(),
});

export const proofUnitsReference = pgTable("proof_units", {
  orgId: text("org_id").notNull(),
  proofUnitDigest: text("proof_unit_digest").notNull(),
});

export const behaviorVerdictsReference = pgTable("behavior_verdicts", {
  orgId: text("org_id").notNull(),
  id: text("id").notNull(),
});
