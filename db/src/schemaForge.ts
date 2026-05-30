// P2A-0019 Forge conversation substrate: long-lived threads scoped to org
// (and optionally project / run), with append-only ordered turns. v0 emits
// templated narration turns; Phase 3 swaps the template for an LLM author
// reading prior turns + tool results from the same tables with no
// migration. See docs/architecture/forge.md.

import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";

export const forgeThreads = pgTable(
  "forge_threads",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.projectId),
    runId: text("run_id"),
    scope: text("scope").notNull(),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    check("forge_threads_scope_check", sql`${table.scope} IN ('org','project','run')`),
    check(
      "forge_threads_scope_consistency_check",
      sql`(${table.scope} = 'org' AND ${table.projectId} IS NULL AND ${table.runId} IS NULL)
        OR (${table.scope} = 'project' AND ${table.projectId} IS NOT NULL AND ${table.runId} IS NULL)
        OR (${table.scope} = 'run' AND ${table.projectId} IS NOT NULL AND ${table.runId} IS NOT NULL)`,
    ),
    index("forge_threads_org_id").on(table.orgId),
    index("forge_threads_project_id").on(table.projectId),
    index("forge_threads_run_id").on(table.runId),
  ],
);

export const forgeTurns = pgTable(
  "forge_turns",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => forgeThreads.id),
    turnIndex: integer("turn_index").notNull(),
    source: jsonb("source").notNull(),
    audience: text("audience").notNull(),
    authorKind: text("author_kind").notNull(),
    render: jsonb("render").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "forge_turns_audience_check",
      sql`${table.audience} IN ('project:member','project:admin','org:admin','platform:admin')`,
    ),
    check("forge_turns_author_kind_check", sql`${table.authorKind} IN ('forge_template','forge_llm','operator')`),
    uniqueIndex("forge_turns_thread_index_unique").on(table.threadId, table.turnIndex),
    index("forge_turns_thread_id").on(table.threadId),
  ],
);

// P3-0010 (write-action approval): a write the Forge answerer PROPOSED on a
// final turn, awaiting a human decision. The model never executes a write;
// the engine persists each proposed action here as `pending`. An operator
// approves/rejects via the approve/reject routes, which re-validate + authz
// the APPROVING operator against the underlying write, execute it, and update
// the row's status. Status transitions are in-place updates (append-friendly:
// a row is only ever advanced through pending → approved/rejected →
// executed/failed, never rewritten). org_id is mandatory + indexed (the
// migration-0026 tenancy pattern).
export const forgeActionProposals = pgTable(
  "forge_action_proposals",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    threadId: text("thread_id")
      .notNull()
      .references(() => forgeThreads.id),
    // The forge turn whose final answer carried this proposal.
    proposingTurnId: text("proposing_turn_id")
      .notNull()
      .references(() => forgeTurns.id),
    toolName: text("tool_name").notNull(),
    // The validated ForgeWriteToolCall args (jsonb) the write executes with.
    args: jsonb("args").notNull(),
    rationale: text("rationale").notNull(),
    status: text("status").notNull().default("pending"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when an operator approves/rejects. decided_by is the operator userId.
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // The write's return value on success, or the error message on failure.
    result: jsonb("result"),
    error: text("error"),
  },
  (table) => [
    check(
      "forge_action_proposals_tool_check",
      sql`${table.toolName} IN ('tanren.create_spec','tanren.trigger_run','tanren.rerun_task','tanren.acknowledge_insight')`,
    ),
    check(
      "forge_action_proposals_status_check",
      sql`${table.status} IN ('pending','approved','rejected','executed','failed')`,
    ),
    index("forge_action_proposals_org_id").on(table.orgId),
    index("forge_action_proposals_thread_id").on(table.threadId),
    index("forge_action_proposals_status").on(table.status),
  ],
);
