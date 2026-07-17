import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

// Wave-6 rv-7 reservation: fixture ownership is stateful because leases progress
// from leased to released or expired. Cleanup evidence, when present, is immutable.
export const fixtureLeases = pgTable(
  "fixture_leases",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    leaseId: text("lease_id").notNull(),
    kind: text("kind").notNull(),
    resourceRef: text("resource_ref").notNull(),
    correlationNamespace: text("correlation_namespace").notNull(),
    state: text("state").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    cleanupEvidenceHash: text("cleanup_evidence_hash"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.leaseId] }),
    uniqueIndex("fixture_leases_org_project_lease_id_unique").on(table.orgId, table.projectId, table.leaseId),
    index("fixture_leases_org_id").on(table.orgId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "fixture_leases_project_fk",
    }),
    check("fixture_leases_kind_check", sql`${table.kind} IN ('org','account','channel','dataset')`),
    check("fixture_leases_state_check", sql`${table.state} IN ('leased','released','expired')`),
    check("fixture_leases_cleanup_evidence_hash_check", sql`${table.cleanupEvidenceHash} ~ ${digestPattern}`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
