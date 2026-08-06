import { sql } from "drizzle-orm";
import { bigserial, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects, runs, specs } from "./schemaCore.js";
import { eventTypes } from "./schemaEventTypes.js";

// Events permit org-, project-, spec-, and run-scoped shapes. MATCH SIMPLE on
// each composite FK validates every ownership coordinate that is present while
// retaining NULLs for legitimate system events; no sentinel authority is needed.
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    runId: text("run_id"),
    taskId: text("task_id"),
    specId: text("spec_id"),
    projectId: text("project_id"),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    eventType: text("event_type")
      .notNull()
      .references(() => eventTypes.name),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    userId: text("user_id"),
    idempotencyKey: text("idempotency_key"),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.runId],
      foreignColumns: [runs.orgId, runs.runId],
      name: "events_run_tenant_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.specId],
      foreignColumns: [specs.orgId, specs.specId],
      name: "events_spec_tenant_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "events_project_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.specId, table.runId],
      foreignColumns: [runs.orgId, runs.specId, runs.runId],
      name: "events_run_spec_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.runId],
      foreignColumns: [runs.orgId, runs.projectId, runs.runId],
      name: "events_run_project_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId],
      foreignColumns: [specs.orgId, specs.projectId, specs.specId],
      name: "events_spec_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId, table.runId],
      foreignColumns: [runs.orgId, runs.projectId, runs.specId, runs.runId],
      name: "events_run_lineage_fk",
    }),
    index("events_run_id_ts").on(table.runId, table.ts),
    index("events_event_type").on(table.eventType),
    index("events_org_id").on(table.orgId),
    index("events_org_run_ts").on(table.orgId, table.runId, table.ts),
    index("events_org_project_ts").on(table.orgId, table.projectId, table.ts),
    // Convergence-history reads (`workflow/attentionResolutionBoundary.ts` and its two
    // readers) filter `spec_id = $1 AND event_type = '…'` and take `MAX(id)`. NO other index
    // starts with `spec_id`, and `events_event_type` alone does not help: `dag.spec.redriven`
    // is one of the highest-volume event types, so the planner would sift every re-drive in
    // the install to answer a question about ONE spec. Trailing `id` makes the
    // resolution-boundary subquery an index-only backwards scan.
    index("events_spec_type_id").on(table.specId, table.eventType, table.id),
    uniqueIndex("events_task_terminal_unique")
      .on(table.taskId, table.eventType)
      .where(sql`${table.eventType} IN ('task.completed', 'task.failed', 'task.cancelled')`),
    uniqueIndex("events_run_terminal_unique")
      .on(table.runId, table.eventType)
      .where(sql`${table.eventType} IN ('run.completed', 'run.failed', 'run.cancelled', 'run.resumed')`),
    uniqueIndex("events_prior_idempotency_unique")
      .on(table.runId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
);
