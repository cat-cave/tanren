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
    // Versioned `ProjectConfigV1` blob. Column default is the MINIMAL VALID versioned config
    // (`{"version":1}`), NOT bare `{}`: reads parse through `migrateProjectConfig` (fail-HARD on
    // unversioned rows), so `{}` would poison a column-omitting insert into a latent runtime 500.
    // `{"version":1}` parses to the fully-defaulted V1 (identical to `defaultProjectConfigV1()`).
    // Application inserts (`createProject`) still supply a full default explicitly; this only
    // backstops a column-omitting insert with a valid-and-versioned value.
    config: jsonb("config")
      .notNull()
      .default(sql`'{"version":1}'::jsonb`),
    // Operator lifecycle: 'active' (the default — the autonomous walker drives it)
    // or 'archived' (the walker + strand reconciler skip it; in-flight runs/specs
    // are cancelled on archive). Flipped only through the dedicated archive surface.
    lifecycle: text("lifecycle").notNull().default("active"),
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
    // jsonb-ARRAY + tolerant reader (`StringArrayOrEmpty`) → not the versioned-object latent-500 case; `text[]` default below is Postgres empty-array syntax, not jsonb.
    acceptanceCriteria: jsonb("acceptance_criteria")
      .notNull()
      .default(sql`'[]'::jsonb`),
    dependsOn: text("depends_on")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status").notNull().default("open"),
    // Execution priority (autonomy-engine.md §1b): DagWalker orders the ready set (P0
    // first … `tbd` last) before the deterministic tiebreak. Originates on a
    // discovery/triage `ProposedSpec`, persisted at create time. Literals mirror
    // `SpecPriority` in engine/state/spec.ts.
    priority: text("priority").notNull().default("tbd"),
    // WRITER-PROMPT MODE (task #86 — v64 root cause): selects `writerPromptFor()` standing
    // instructions. `from_scratch` (default) → brownfield/legacy authoring; the greenfield
    // SCAFFOLD spec sets `specialize_seed` (writer told the composed seed is in place +
    // proven green; only product-identity surfaces should change). Literals mirror `SpecMode`.
    mode: text("mode").notNull().default("from_scratch"),
    // P3-0014: discovery provenance under `discovery` key. Open bag, tolerant reader — `{}` honest empty.
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Triage-routing PROVENANCE (Claude RA2 — apex GAP 1): nullable trail; enables re-drive DEDUPE.
    parentSpecId: text("parent_spec_id"),
    sourceFindingIds: text("source_finding_ids").array(),
    originTriageTaskId: text("origin_triage_task_id"),
    originRunId: text("origin_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
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
    // The org's versioned `OrgConfigV1` blob. As with `projects.config`, the column
    // default is the MINIMAL VALID versioned config (`{"version":1}`), NOT a bare
    // `{}`: `migrateOrgConfig` fail-HARD rejects an unversioned row, so a bare `{}`
    // default would poison a column-omitting insert into a latent 500 on the next
    // org-config read (the App-installation / provider-mode / default-credentials
    // reads in `resolveCredentials.ts`). `{"version":1}` parses to the fully-defaulted
    // V1 shape (identical to `defaultOrgConfigV1()`). The bootstrap insert
    // (`identityStore.upsertOrg`) still supplies a full `defaultOrgConfigV1()`
    // explicitly; this default only backstops a column-omitting insert.
    config: jsonb("config")
      .notNull()
      .default(sql`'{"version":1}'::jsonb`),
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
    // The §3.7f concurrency query: count the ACTIVE runs sharing one credential
    // (auth_ref) during a drawdown measurement → org-scoped, by auth_ref + status.
    index("runs_org_auth_ref").on(table.orgId, table.authRef),
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
    /** The dequeue reason when status = 'dequeued' (conflict | blocked | failed | superseded | needs_attention). */
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
      sql`${table.dequeueReason} IS NULL OR ${table.dequeueReason} IN ('conflict','blocked','failed','superseded','needs_attention')`,
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

// Merge hold ceilings (audit RC-7: in-memory hold-ceiling durability gap). The
// two runaway-guard counters that bound a flapping merge candidate — the per-entry
// recoverable-drive retry count and the per-project consecutive-infra-hold count —
// used to live in process-local `Map`s. A rolling deploy / crash-loop LOST them, so
// a flapping candidate re-earned its full attempt budget every restart and the loud
// `needs_attention` escalation never fired (dangerous given the prior ssh2 crash-loop
// history). This table PERSISTS them so the ceiling survives a restart.
//
// Keyed by (org_id, scope_id, kind): `kind = 'recoverable_drive'` keys `scope_id` on
// the merge_queue queue_id (the per-entry retry count); `kind = 'batch_infra'` keys
// `scope_id` on the project_id (the per-project consecutive infra-hold count). A held
// candidate is OFF the hot path, so the extra org-scoped round-trip to read/write the
// counter is cheap. org_id is the tenant root (RLS deny-by-default).
export const mergeQueueHolds = pgTable(
  "merge_queue_holds",
  {
    /** The scope this counter belongs to: a queue_id (recoverable_drive) or a project_id (batch_infra). */
    scopeId: text("scope_id").notNull(),
    /** Which ceiling: 'recoverable_drive' (per-entry) | 'batch_infra' (per-project). */
    kind: text("kind").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    /** The persisted consecutive-hold/attempt count — TELEMETRY ONLY (the emitted `attempts` diagnostic), NOT a control-flow trigger. The non-recovery alert keys off the SIGNATURE history below (the fixed-point read), never this count — see `infraNonRecovery.ts`. */
    attempts: text("attempts").notNull().default("0"),
    /** The trailing infra-failure SIGNATURE history (oldest→newest JSON of stable error-identity strings), bounded to the cycle window. The sustained-non-recovery read (`assessStructuralProgress`) reasons over THIS — the alert fires when the SAME signature persists with no progress across the backoff-spaced re-drives, never on a count. `'[]'` keeps it NOT NULL for a fresh scope. */
    signatures: text("signatures").notNull().default("[]"),
    /** When the counter was last incremented (observability + a future lease/expiry). */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    enumCheck("merge_queue_holds_kind_check", table.kind, ["recoverable_drive", "batch_infra"]),
    // The (org, scope, kind) identity — the upsert conflict target (one counter per scope+kind).
    uniqueIndex("merge_queue_holds_identity").on(table.orgId, table.scopeId, table.kind),
    index("merge_queue_holds_org_id").on(table.orgId),
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

// tanren-owns-the-engine.md §3: the ONE unified run model — `integration_nodes`.
// A node IS work on a base branch that may shift: `main + an ordered set of
// not-yet-landed ancestor branches`. The SAME object is an eager dependent build,
// a merge-queue batch, and a stacked/chain PR — the speculative-vs-real and
// eager-vs-unrelated divergence collapsed into one row.
//
// Wave 2 / Slice S0 is OBSERVE-ONLY: this table is WRITTEN ALONGSIDE the jj-native
// `runs.ancestor_stack` + percolation columns (additive, try/catch-wrapped), and
// drives NO control flow. The §8 guardrail — migrate the speculative/percolation
// state through an EXPLICIT compatibility read-model, never silent abandonment —
// lives in `engine/dag/integrationNodesPg.ts` (the read-model projects existing run
// rows into this shape). The columns mirror the FROZEN `IntegrationNode` typed
// shape (engine/contracts/integrationNodes.ts).
//
// `member_key` = hash(base_sha + ordered member shas) — the identity of the
// integrated CONTENT (the proof-reuse cache's primary key). The pure `memberKey`
// computes it; a unique index on (org_id, member_key) is the idempotency boundary
// (the same integrated content is one node per org — observe-only UPSERTs onto it).
//
// org_id is the tenant root (RLS deny-by-default, 3a-style direct org match like
// merge_queue / post_merge_issue_claims): a query off the org-scoped client sees
// ZERO rows. NO empty-on-missing-org fallback (the fail-closed RLS doctrine).
export const integrationNodes = pgTable(
  "integration_nodes",
  {
    nodeId: text("node_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    /** The real base branch the node is built ON (`main` / the project default). */
    baseBranch: text("base_branch").notNull(),
    /** The base branch's SHA the node bases on (the `memberKey` base component). */
    baseSha: text("base_sha").notNull(),
    /** The ephemeral git ref the node materializes as (the integration branch). */
    ref: text("ref").notNull(),
    /** The intent label — NEVER branches control flow (all four are one object). */
    purpose: text("purpose").notNull(),
    /** The ordered members merged into the base (`IntegrationNodeMember[]`, jsonb). */
    members: jsonb("members")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** `hash(base_sha + ordered member shas)` — identity of the integrated content. */
    memberKey: text("member_key").notNull(),
    /** The gate config the proof a node carries was produced under. */
    gateConfigHash: text("gate_config_hash").notNull().default(""),
    /** The posture/policy version the proof was produced under. */
    policyVersion: text("policy_version").notNull().default(""),
    /** The affected-tier fingerprint (Wave-3 affected-tier gate skipping). */
    affectedFingerprint: text("affected_fingerprint").notNull().default(""),
    /** The materialized node's head SHA (when built); NULL while `building`. */
    headSha: text("head_sha"),
    /** The materialized node's tree hash (when built); NULL while `building`. */
    treeHash: text("tree_hash"),
    /** The node lifecycle: building → ready → landed → stale. */
    status: text("status").notNull().default("building"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "integration_nodes_purpose_check",
      sql`${table.purpose} IN ('eager_base','merge_batch','stack_head','bisect_prefix')`,
    ),
    check("integration_nodes_status_check", sql`${table.status} IN ('building','ready','landed','stale')`),
    index("integration_nodes_org_id").on(table.orgId),
    index("integration_nodes_org_project").on(table.orgId, table.projectId),
    // The idempotency boundary: one node per (org, integrated content). The
    // observe-only hook UPSERTs onto this key so a re-walk of the same base +
    // ordered members refreshes the existing node rather than duplicating it.
    uniqueIndex("integration_nodes_org_member_key_unique").on(table.orgId, table.memberKey),
  ],
);

// tanren-owns-the-engine.md §3 proof reuse: a gate/CI verdict on a node is reused
// ONLY when EVERY component of the `proofReuseKey` matches (member_key +
// gate_config_hash + policy_version + runner image + app-env + quarantine). This
// table records the proof keyed by that full key — so a batch proof carries into
// the real merge, a bisection reads a prefix node's proof, and a no-op rebase skips
// unaffected gate tiers (all Wave-3 leverage; OBSERVE-ONLY now). `proof_reuse_key`
// is the natural identity (the same six inputs → one proof per org).
//
// org_id is the tenant root (RLS deny-by-default, 3a-style direct org match).
export const integrationProofs = pgTable(
  "integration_proofs",
  {
    proofId: text("proof_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    /** The node the proof was produced on (FK → integration_nodes). */
    nodeId: text("node_id")
      .notNull()
      .references(() => integrationNodes.nodeId),
    /** The full proof-reuse key (the six inputs hashed) — the reuse-cache identity. */
    proofReuseKey: text("proof_reuse_key").notNull(),
    /** The verdict the proof carries (the gate/CI outcome). */
    verdict: text("verdict").notNull(),
    /** Free-form evidence (tier results, CI run ref, …) — jsonb. */
    evidence: jsonb("evidence")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("integration_proofs_org_id").on(table.orgId),
    index("integration_proofs_org_project").on(table.orgId, table.projectId),
    index("integration_proofs_node_id").on(table.nodeId),
    // The reuse boundary: one proof per (org, full reuse key). A reuse lookup keys
    // on this; any drift in the six inputs yields a different key → a recompute.
    uniqueIndex("integration_proofs_org_reuse_key_unique").on(table.orgId, table.proofReuseKey),
  ],
);
