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
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
      sql`${table.kind} IN ('retry_hotspot','model_mismatch','pace_anomaly','stuck','review_stall')`,
    ),
    check("workflow_insights_severity_check", sql`${table.severity} IN ('info','warn','fail')`),
    index("workflow_insights_project_kind").on(table.projectId, table.kind, desc(table.computedAt)),
  ],
);
