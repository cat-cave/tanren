// P2A-0019 Forge conversation substrate: long-lived threads scoped to org
// (and optionally project / run), with append-only ordered turns. v0 emits
// templated narration turns; Phase 3 swaps the template for an LLM author
// reading prior turns + tool results from the same tables with no
// migration. See docs/architecture/forge.md.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
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
    closedAt: timestamp("closed_at", { withTimezone: true })
  },
  (table) => [
    check("forge_threads_scope_check", sql`${table.scope} IN ('org','project','run')`),
    check(
      "forge_threads_scope_consistency_check",
      sql`(${table.scope} = 'org' AND ${table.projectId} IS NULL AND ${table.runId} IS NULL)
        OR (${table.scope} = 'project' AND ${table.projectId} IS NOT NULL AND ${table.runId} IS NULL)
        OR (${table.scope} = 'run' AND ${table.projectId} IS NOT NULL AND ${table.runId} IS NOT NULL)`
    ),
    index("forge_threads_org_id").on(table.orgId),
    index("forge_threads_project_id").on(table.projectId),
    index("forge_threads_run_id").on(table.runId)
  ]
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check(
      "forge_turns_audience_check",
      sql`${table.audience} IN ('project:member','project:admin','org:admin','platform:admin')`
    ),
    check(
      "forge_turns_author_kind_check",
      sql`${table.authorKind} IN ('forge_template','forge_llm','operator')`
    ),
    uniqueIndex("forge_turns_thread_index_unique").on(table.threadId, table.turnIndex),
    index("forge_turns_thread_id").on(table.threadId)
  ]
);
