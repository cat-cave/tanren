// P2A-0020 workflow-insights table: a compute-on-read cache for typed
// `WorkflowInsight` records. The dispatcher in
// `services/orchestrator/src/engine/insights/computer.ts` is the source of
// truth — this table only stores recently-computed insights for read
// efficiency. Cache freshness is governed by the read path (rows are
// considered fresh when `acknowledged_at IS NULL` and
// `computed_at > NOW() - INTERVAL '1 hour'`); stale rows are recomputed.
//
// See docs/architecture/insights.md for the operator-facing reference.

import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { desc } from "drizzle-orm";
import { projects, users } from "./schemaCore.js";

export const workflowInsights = pgTable(
  "workflow_insights",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    severity: text("severity").notNull(),
    payload: jsonb("payload").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by").references(() => users.id),
  },
  (table) => [
    check(
      "workflow_insights_kind_check",
      sql`${table.kind} IN ('retry_hotspot','model_mismatch','pace_anomaly','stuck','review_stall','ci_flaky')`,
    ),
    check("workflow_insights_severity_check", sql`${table.severity} IN ('info','warn','fail')`),
    index("workflow_insights_project_kind").on(table.projectId, table.kind, desc(table.computedAt)),
  ],
);

// P2e-1 (autonomy-engine.md §2d Mergify parity): the quarantine SURFACE. When
// the flaky detector (engine/insights/ciFlaky.ts) proves a check is
// non-deterministic on UNCHANGED code, it records the check here. This is a
// VISIBILITY + record surface, not a gate override: quarantine ≠
// ignore-all-failures. A consistently-failing (genuinely broken) check is never
// recorded here, so a real failure can never be masked by this table.
//
// One active row per (project, check name). `evidence` carries the
// non-determinism proof (toggled-sha count, observation count, passes-on-retry)
// so an operator can audit WHY the check was quarantined.
export const quarantinedTests = pgTable(
  "quarantined_tests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    checkName: text("check_name").notNull(),
    /** How many distinct head SHAs showed the check both pass AND fail. */
    toggledShaCount: integer("toggled_sha_count").notNull(),
    /** Total CI observations of this check across the detection window. */
    observationCount: integer("observation_count").notNull(),
    /** The non-determinism evidence snapshot (sample SHAs, passes-on-retry). */
    evidence: jsonb("evidence").notNull(),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }).notNull().defaultNow(),
    /** Operator clearance: a non-null value means the quarantine was lifted. */
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearedBy: text("cleared_by").references(() => users.id),
  },
  (table) => [
    check("quarantined_tests_toggled_check", sql`${table.toggledShaCount} >= 1`),
    check("quarantined_tests_observation_check", sql`${table.observationCount} >= 1`),
    // At most one ACTIVE quarantine per (project, check). A partial unique index
    // keyed on the not-yet-cleared rows lets a check be re-quarantined after a
    // prior clearance without colliding with the historical row.
    uniqueIndex("quarantined_tests_active_unique")
      .on(table.projectId, table.checkName)
      .where(sql`${table.clearedAt} IS NULL`),
    index("quarantined_tests_project").on(table.projectId, desc(table.quarantinedAt)),
  ],
);
