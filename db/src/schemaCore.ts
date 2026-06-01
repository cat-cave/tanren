import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { stateEnumLists } from "./stateEnums.js";

// `runs` lives here (not in schema.ts) so the benchmark sub-schema —
// `experiment_trials.run_id` FK → runs — can reference it from a core module
// WITHOUT importing schema.ts (schema.ts re-exports the sub-schemas, so a
// sub-schema importing schema.ts closes an import cycle the lint `no-cycle`
// rule rejects). It is part of the core run-execution chain anyway. schema.ts
// re-exports it so `schema.runs` is unchanged for every consumer.

// Core identity + project/spec tables. These are referenced by the split
// sub-schema files (schemaForge, schemaInbox, …). Keeping them here — rather
// than in schema.ts — lets those sub-schemas reference the base tables without
// importing schema.ts, which re-exports the sub-schemas (that re-export edge
// would otherwise close an import cycle). schema.ts re-exports everything here
// so consumers + the migration generator still see one `schema.*` namespace.

export function enumCheck(name: string, column: AnyPgColumn, values: ReadonlyArray<string>) {
  const literals = sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(","));
  return check(name, sql`${column} IN (${literals})`);
}

// org_id is the tenant-isolation root of the run-execution chain (P-tenancy:
// mandatory-org-id). projects.org_id is NOT NULL and FK → organizations.id; the
// migration backfills legacy rows from a placeholder org before tightening. All
// downstream core tables (specs/runs/tasks/events/cost_records/runners) carry a
// derived, mandatory, indexed org_id so isolation no longer relies on a nullable
// project_id → projects.org_id hop or a route-layer gate alone.
export const projects = pgTable(
  "projects",
  {
    projectId: text("project_id").primaryKey(),
    name: text("name").notNull(),
    repoUrl: text("repo_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    runnerImage: text("runner_image").notNull().default("ghcr.io/cat-cave/tanren-runner:v0"),
    allocator: text("allocator").notNull().default("local-docker"),
    config: jsonb("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
  },
  (table) => [index("projects_org_id").on(table.orgId)],
);

export const specs = pgTable(
  "specs",
  {
    specId: text("spec_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    title: text("title").notNull(),
    description: text("description").notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria")
      .notNull()
      .default(sql`'[]'::jsonb`),
    dependsOn: text("depends_on")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status").notNull().default("pending"),
    // Execution priority (autonomy-engine.md §1b): the DagWalker orders the ready
    // set by this (P0 first … `tbd` last) before the deterministic tiebreak. It
    // originates on a discovery/triage `ProposedSpec` and is persisted at create
    // time. NOT a state-machine value — these literals mirror the `SpecPriority`
    // Zod enum in services/orchestrator/src/engine/state/spec.ts.
    priority: text("priority").notNull().default("tbd"),
    metadata: jsonb("metadata")
      .notNull()
      // P3-0014: discovery provenance under `discovery` key
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    enumCheck("specs_status_check", table.status, stateEnumLists.specs_status),
    enumCheck("specs_priority_check", table.priority, ["P0", "P1", "P2", "tbd"]),
    index("specs_org_id").on(table.orgId),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    login: text("login").notNull(),
    displayName: text("display_name").notNull(),
    config: jsonb("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("organizations_kind_check", sql`${table.kind} IN ('github_org','github_user','oidc')`),
    uniqueIndex("organizations_provider_unique").on(table.kind, table.externalId),
  ],
);

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    login: text("login"),
    email: text("email"),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("users_provider_check", sql`${table.provider} IN ('github_oauth','oidc','local_dev')`),
    uniqueIndex("users_provider_subject_unique").on(table.provider, table.providerSubject),
  ],
);

export const runs = pgTable(
  "runs",
  {
    runId: text("run_id").primaryKey(),
    specId: text("spec_id")
      .notNull()
      .references(() => specs.specId),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    trigger: text("trigger").notNull(),
    branch: text("branch").notNull(),
    status: text("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: text("outcome"),
    prUrl: text("pr_url"),
    userId: text("user_id"),
  },
  (table) => [
    enumCheck("runs_status_check", table.status, stateEnumLists.runs_status),
    check(
      "runs_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN (${sql.raw(
        stateEnumLists.runs_outcome.map((value) => `'${value.replaceAll("'", "''")}'`).join(","),
      )})`,
    ),
    index("runs_org_id").on(table.orgId),
    index("runs_org_run").on(table.orgId, table.runId),
    index("runs_org_project").on(table.orgId, table.projectId),
  ],
);
