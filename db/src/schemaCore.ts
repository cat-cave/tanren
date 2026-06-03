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
    // P2c-1 (autonomy-engine.md §2c): the SPECULATIVE INTEGRATION BRANCH this run's
    // PR bases on (the dynamic base), when the DagWalker started it speculatively
    // on one or more unmerged ancestors. NULL ⇒ a non-speculative run whose PR
    // bases on `projects.default_branch` (the normal path). The merge stage never
    // merges against this ref — it is the WORK base; the dependent's MERGE waits
    // for the real ancestor merges, then re-gates against `default_branch`.
    speculativeBase: text("speculative_base"),
    // P2c-2 (autonomy-engine.md §2c CHANGE-PERCOLATION): the per-ancestor head SHA
    // map this speculative run is BUILT ON (its current base) —
    // `{ "<ancestorSpecId>": "<sha>" }`. Set at speculative start, and re-pointed
    // (with `speculative_base`) when a percolation re-bases the dependent onto an
    // ancestor's new head. NULL ⇒ a non-speculative run (nothing to percolate).
    integratedAncestorShas: jsonb("integrated_ancestor_shas"),
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

// P2d (autonomy-engine.md §2d): the native intelligent merge queue. One row per
// ready-to-merge run under `native_queue` — the persisted, RLS-scoped queue state
// the MergeCoordinator orders + serializes. DAG state is the source of truth
// (§1.7), so this table holds ONLY the queue membership + serialization claim, not
// duplicated DAG/lifecycle state: ordering (DAG-order + priority) is DERIVED fresh
// each pass from `specs` + `runs`. The table exists so the queue SURVIVES A
// RESTART (a process crash mid-coordinate leaves the queued/merging rows
// recoverable) and so the serialization claim (`status = 'merging'`) is durable —
// at most one entry per project is `merging` at a time (one merge in flight).
//
//   status:
//     - `queued`   — ready-to-merge, awaiting its turn in DAG order.
//     - `merging`  — the coordinator CLAIMED this entry and is driving its merge
//                    (the serialization lock — at most one per project).
//     - `merged`   — its merge landed (terminal; kept for queue statistics).
//     - `dequeued` — left the queue WITHOUT merging (conflict → recoverable hold,
//                    or removed for liveness so independent items proceed); the
//                    `dequeue_reason` records which. A re-ready run re-enqueues a
//                    NEW row, so a dequeued row is terminal.
//
// org_id is the tenant root (RLS deny-by-default); a `queued` unique index per run
// is the IDEMPOTENCY boundary — a run already queued/merging is never re-queued.
export const mergeQueue = pgTable(
  "merge_queue",
  {
    queueId: text("queue_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.runId),
    specId: text("spec_id")
      .notNull()
      .references(() => specs.specId),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    status: text("status").notNull().default("queued"),
    /** The dequeue reason when status = 'dequeued' (conflict | blocked | failed | superseded). */
    dequeueReason: text("dequeue_reason"),
    /** The PR url + number captured at enqueue (the coordinator drives by run id). */
    prUrl: text("pr_url").notNull(),
    prNumber: text("pr_number").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    // The NO-CHECKS SETTLE anchor (the no-CI-repo merge-queue hang fix). Set the FIRST
    // time the speculative batch check observes GENUINELY-zero checks on the rebuilt
    // integration ref keyed on this (tail) entry, and CLEARED the moment any real
    // verdict (checks_pending/passed/failed/conflict) is seen — so a repo whose workflow
    // registers a check within seconds never accrues a continuous no-checks window and
    // never settle-merges unverified. The settle grace measures `now - no_checks_since`
    // (NOT `now - enqueued_at`, which would wrongly count queue-backlog time), so a
    // genuinely-no-CI repo settles to pass only after the grace of CONTINUOUS no-checks.
    noChecksSince: timestamp("no_checks_since", { withTimezone: true }),
    /** Set when the coordinator CLAIMED the entry (status → merging). */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Set when the entry reached a terminal status (merged / dequeued). */
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    enumCheck("merge_queue_status_check", table.status, ["queued", "merging", "merged", "dequeued"]),
    check(
      "merge_queue_dequeue_reason_check",
      sql`${table.dequeueReason} IS NULL OR ${table.dequeueReason} IN ('conflict','blocked','failed','superseded')`,
    ),
    index("merge_queue_org_id").on(table.orgId),
    index("merge_queue_org_project").on(table.orgId, table.projectId),
    index("merge_queue_org_project_status").on(table.orgId, table.projectId, table.status),
    // The idempotency boundary: a run may have at most ONE active (queued/merging)
    // entry. A partial unique index keyed on run_id where status is non-terminal.
    uniqueIndex("merge_queue_active_run_unique")
      .on(table.runId)
      .where(sql`status IN ('queued', 'merging')`),
  ],
);

// Post-merge auto-issue claim (tempering.md dim A). The CROSS-PROCESS atomic
// "file once per merge" guard for the post-merge-failure watcher: the run_id
// PRIMARY KEY makes the claim INSERT (`ON CONFLICT (run_id) DO NOTHING RETURNING`)
// the single serialization point across an N-process worker fleet — only the
// process whose INSERT created the row wins and calls `createIssue`; every other
// LISTENing worker's INSERT returns 0 rows and skips. `status` carries the claim
// lifecycle: `claimed` (a winner is filing) → `filed` (the issue was opened, the
// durable terminal idempotency marker). A `claimed` row whose driver crashed
// before filing is reclaimable past a lease (mirrors merge_queue's stale-claim
// recovery); the watcher itself DELETEs its claim on a `createIssue` FAILURE so a
// transient GitHub error never permanently suppresses the issue.
//
// org_id is the tenant root (RLS deny-by-default, 3a-style direct org match like
// merge_queue). One row per merged run = one issue per merge.
export const postMergeIssueClaims = pgTable(
  "post_merge_issue_claims",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.runId),
    specId: text("spec_id")
      .notNull()
      .references(() => specs.specId),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    status: text("status").notNull().default("claimed"),
    /** The opened issue's url/number — set when status flips to `filed`. */
    issueUrl: text("issue_url"),
    issueNumber: text("issue_number"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the issue was opened (status → filed). */
    filedAt: timestamp("filed_at", { withTimezone: true }),
  },
  (table) => [
    enumCheck("post_merge_issue_claims_status_check", table.status, ["claimed", "filed"]),
    index("post_merge_issue_claims_org_id").on(table.orgId),
    index("post_merge_issue_claims_org_project").on(table.orgId, table.projectId),
  ],
);
