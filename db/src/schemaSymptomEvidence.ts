import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { behaviorVerificationRunsReference } from "./schemaSpineReferences.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

// bh-5 consumes the runtime-verification CAS + verification_artifacts substrate
// (0035/0037). This table adds only the missing normalized assertion outcomes.
export const verificationAssertions = pgTable(
  "verification_assertions",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    verificationRunId: text("verification_run_id").notNull(),
    expectedHash: text("expected_hash").notNull(),
    observedHash: text("observed_hash").notNull(),
    outcome: text("outcome").notNull(),
    timingMs: integer("timing_ms").notNull(),
    sampleData: jsonb("sample_data")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.verificationRunId],
      foreignColumns: [behaviorVerificationRunsReference.orgId, behaviorVerificationRunsReference.id],
      name: "verification_assertions_verification_run_fk",
    }),
    index("verification_assertions_org_id").on(table.orgId),
    index("verification_assertions_org_run").on(table.orgId, table.verificationRunId),
    check("verification_assertions_expected_hash_check", sql`${table.expectedHash} ~ ${digestPattern}`),
    check("verification_assertions_observed_hash_check", sql`${table.observedHash} ~ ${digestPattern}`),
    check("verification_assertions_outcome_check", sql`${table.outcome} IN ('passed','failed','inconclusive')`),
    check("verification_assertions_timing_ms_check", sql`${table.timingMs} >= 0`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
