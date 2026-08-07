// Core identity and project lifecycle tables. This module is the dependency root for
// domain-specific schema modules; schemaCore.ts preserves the historic facade.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { issueLoopsReference } from "./schemaIssueLoopReferences.js";
import { stateEnumLists } from "./stateEnums.js";

// Core identity + project/spec/run tables live here so sub-schemas can reference them without importing schema.ts
// (avoids the no-cycle import loop). schema.ts re-exports this module as the single `schema.*` namespace for consumers + kit.

export function enumCheck(name: string, column: AnyPgColumn, values: ReadonlyArray<string>) {
  const literals = sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(","));
  return check(name, sql`${column} IN (${literals})`);
}

// org_id is the tenant-isolation root (P-tenancy). projects.org_id NOT NULL FK →
// organizations; downstream core tables carry derived mandatory indexed org_id.
export const projects = pgTable(
  "projects",
  {
    projectId: text("project_id").primaryKey(),
    name: text("name").notNull(),
    repoUrl: text("repo_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    runnerImage: text("runner_image").notNull().default("ghcr.io/cat-cave/tanren-runner:v0"),
    allocator: text("allocator").notNull().default("local-docker"),
    // Versioned ProjectConfigV1; default is minimal valid `{"version":1}` (not `{}`).
    config: jsonb("config")
      .notNull()
      .default(sql`'{"version":1}'::jsonb`),
    // App CAS gen (never xmin). mode number + CHECK ≤ MAX_SAFE_INTEGER; HTTP uses ::text.
    configRevision: bigint("config_revision", { mode: "number" }).notNull().default(1),
    // Operator lifecycle: 'deriving' (greenfield graph incomplete), 'active'
    // (the autonomous walker drives it), or 'archived' (walker + strand
    // reconciler skip it; in-flight runs/specs are cancelled on archive).
    lifecycle: text("lifecycle").notNull().default("active"),
    // Governance tier visibility predicate (gv-8). NULL preserves the existing
    // project rows until the governance lane supplies an explicit visibility.
    repoVisibility: text("repo_visibility"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
  },
  (table) => [
    check(
      "projects_config_revision_range_check",
      sql`${table.configRevision} >= 1 AND ${table.configRevision} <= 9007199254740991`,
    ),
    uniqueIndex("projects_org_project_unique").on(table.orgId, table.projectId),
    index("projects_org_id").on(table.orgId),
    check("projects_lifecycle_check", sql`${table.lifecycle} IN ('deriving','active','archived')`),
    check("projects_repo_visibility_check", sql`${table.repoVisibility} IN ('public','private')`),
  ],
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
    // jsonb-ARRAY + tolerant reader (`StringArrayOrEmpty`) → not the versioned-object latent-500 case; `text[]` default below is Postgres empty-array syntax, not jsonb.
    acceptanceCriteria: jsonb("acceptance_criteria")
      .notNull()
      .default(sql`'[]'::jsonb`),
    dependsOn: text("depends_on")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status").notNull().default("open"),
    // DagWalker ready-set priority (P0…tbd). Literals mirror SpecPriority.
    priority: text("priority").notNull().default("tbd"),
    // Writer prompt mode: from_scratch | specialize_seed (greenfield scaffold).
    mode: text("mode").notNull().default("from_scratch"),
    // P3-0014 discovery provenance bag; `{}` is honest empty.
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Triage provenance trail (nullable); enables re-drive dedupe.
    parentSpecId: text("parent_spec_id"),
    sourceFindingIds: text("source_finding_ids").array(),
    originTriageTaskId: text("origin_triage_task_id"),
    originRunId: text("origin_run_id"),
    originIssueLoopId: text("origin_issue_loop_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "specs_project_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.originIssueLoopId],
      foreignColumns: [issueLoopsReference.orgId, issueLoopsReference.id],
      name: "specs_origin_issue_loop_fk",
    }),
    uniqueIndex("specs_org_spec_unique").on(table.orgId, table.specId),
    uniqueIndex("specs_org_project_spec_unique").on(table.orgId, table.projectId, table.specId),
    enumCheck("specs_status_check", table.status, stateEnumLists.specs_status),
    enumCheck("specs_priority_check", table.priority, ["P0", "P1", "P2", "tbd"]),
    enumCheck("specs_mode_check", table.mode, ["specialize_seed", "from_scratch"]),
    index("specs_org_id").on(table.orgId),
    index("specs_project_created").on(table.projectId, table.createdAt, table.specId),
    uniqueIndex("specs_triage_provenance_unique")
      .on(table.projectId, table.parentSpecId, table.sourceFindingIds)
      .where(sql`parent_spec_id IS NOT NULL`),
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
    // Versioned OrgConfigV1; default is minimal valid `{"version":1}` (not `{}`).
    config: jsonb("config")
      .notNull()
      .default(sql`'{"version":1}'::jsonb`),
    // App CAS gen (never xmin). mode number + CHECK ≤ MAX_SAFE_INTEGER; HTTP uses ::text.
    configRevision: bigint("config_revision", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("organizations_kind_check", sql`${table.kind} IN ('github_org','github_user','oidc')`),
    check(
      "organizations_config_revision_range_check",
      sql`${table.configRevision} >= 1 AND ${table.configRevision} <= 9007199254740991`,
    ),
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
    // P2c-2: the per-ancestor head SHA map this dependent's work has actually
    // RE-GATED CLEAN against — gate+checker+auditor genuinely re-ran (a real run)
    // and passed with no open P0/P1. This is the ABSORBED / TERMINATION key: the
    // detect compares an ancestor's LIVE head against THIS (not the build-base), so
    // a change is only "absorbed" once the dependent's own governance re-ran clean
    // — never on a bare re-base. NULL until the first clean re-gate.
    verifiedAncestorShas: jsonb("verified_ancestor_shas"),
    // P2c-2: the IN-FLIGHT percolation marker (the loop-termination guard). When an
    // immediate upstream change kicks off a re-execution, this records the exact
    // `{ ancestorSpecId, toSha, reviewVerdict }` being absorbed so a sticky signal
    // (e.g. a `changes_requested` at an unchanged SHA) does NOT re-trigger every
    // walk: a pending marker means "already re-executing this signal — wait." It is
    // cleared (and `verified_ancestor_shas` advanced) when the re-execution settles.
    percolationPending: jsonb("percolation_pending"),
    // §3.7f credit double-count fix: the run's resolved credential identity (the
    // writer adapter's `authRef`). Prepaid-credit balances are GLOBAL to a credential,
    // so two overlapping runs sharing one credential would each capture the SAME
    // drawdown baseline and attribute the WHOLE concurrent drawdown — double-counting.
    // This per-run dedup key lets the run-end reconcile COUNT the runs concurrently
    // active on the same credential and attribute only this run's share (idempotent).
    // NULL until the worker resolves the writer credential (or no credential-priced spend).
    authRef: text("auth_ref"),
    // WS-A PR-1 (walker-jj-local-integration-design.md §2.3): the ORDERED ancestor stack
    // `[{ specId, runId, branch, headSha }]`. The sole jj-local base source.
    ancestorStack: jsonb("ancestor_stack"),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "runs_project_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId],
      foreignColumns: [specs.orgId, specs.projectId, specs.specId],
      name: "runs_spec_lineage_fk",
    }),
    enumCheck("runs_status_check", table.status, stateEnumLists.runs_status),
    check(
      "runs_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN (${sql.raw(
        stateEnumLists.runs_outcome.map((value) => `'${value.replaceAll("'", "''")}'`).join(","),
      )})`,
    ),
    index("runs_org_id").on(table.orgId),
    uniqueIndex("runs_org_run_unique").on(table.orgId, table.runId),
    uniqueIndex("runs_org_spec_run_unique").on(table.orgId, table.specId, table.runId),
    uniqueIndex("runs_org_project_run_unique").on(table.orgId, table.projectId, table.runId),
    uniqueIndex("runs_org_project_spec_run_unique").on(table.orgId, table.projectId, table.specId, table.runId),
    index("runs_org_project").on(table.orgId, table.projectId),
    // The §3.7f concurrency query: count the ACTIVE runs sharing one credential
    // (auth_ref) during a drawdown measurement → org-scoped, by auth_ref + status.
    index("runs_org_auth_ref").on(table.orgId, table.authRef),
  ],
);
