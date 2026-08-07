import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { enumCheck, organizations, projects, runs, specs } from "./schemaCoreFoundation.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

// Durable merge-queue state is kept together so queue-specific constraints and RLS
// declarations can evolve without expanding the identity/project schema module.
export const mergeQueuePartitions = pgTable(
  "merge_queue_partitions",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    targetBranch: text("target_branch").notNull(),
    scopeKey: text("scope_key").notNull(),
    mode: text("mode").notNull(),
    capacity: integer("capacity").notNull(),
    state: text("state").notNull(),
    generation: integer("generation").notNull().default(0),
    pauseReason: text("pause_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "merge_queue_partitions_project_fk",
    }),
    uniqueIndex("merge_queue_partitions_project_target_scope_unique").on(
      table.orgId,
      table.projectId,
      table.targetBranch,
      table.scopeKey,
    ),
    index("merge_queue_partitions_org_id").on(table.orgId),
    check("merge_queue_partitions_mode_check", sql`${table.mode} IN ('serial','scoped','isolated')`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

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
    partitionId: text("partition_id"),
    leaseOwner: text("lease_owner"),
    /** Monotonic fencing generation; incremented for every successful claim. */
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    scopeFingerprint: text("scope_fingerprint"),
    policySnapshot: jsonb("policy_snapshot"),
    routeSnapshot: jsonb("route_snapshot"),
    prioritySnapshot: jsonb("priority_snapshot"),
    targetBranch: text("target_branch"),
    priorityOverride: text("priority_override"),
    policyHoldReason: text("policy_hold_reason"),
    status: text("status").notNull().default("queued"),
    /** The dequeue reason when status = 'dequeued' (conflict | blocked | failed | superseded | needs_attention). */
    dequeueReason: text("dequeue_reason"),
    /**
     * in-18: the integration-grant-blocked park reason (status = 'parked_grant';
     * mirrors `capability_nodes.wait_reason`). NON-terminal — the parked entry is
     * neither merged nor dropped; re-admitted only when its grant covers. NULL otherwise.
     */
    parkReason: text("park_reason"),
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
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "merge_queue_project_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId],
      foreignColumns: [specs.orgId, specs.projectId, specs.specId],
      name: "merge_queue_spec_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId, table.runId],
      foreignColumns: [runs.orgId, runs.projectId, runs.specId, runs.runId],
      name: "merge_queue_run_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.partitionId],
      foreignColumns: [mergeQueuePartitions.orgId, mergeQueuePartitions.id],
      name: "merge_queue_partition_fk",
    }),
    enumCheck("merge_queue_status_check", table.status, [
      "queued",
      "merging",
      "merged",
      "dequeued",
      "parked_grant",
      "held_policy",
    ]),
    check(
      "merge_queue_dequeue_reason_check",
      sql`${table.dequeueReason} IS NULL OR ${table.dequeueReason} IN ('conflict','blocked','failed','superseded','needs_attention')`,
    ),
    check("merge_queue_park_reason_check", sql`${table.parkReason} IS NULL OR ${table.status} = 'parked_grant'`),
    check(
      "merge_queue_policy_hold_reason_check",
      sql`${table.policyHoldReason} IS NULL OR ${table.status} = 'held_policy'`,
    ),
    check(
      "merge_queue_lease_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    index("merge_queue_org_id").on(table.orgId),
    index("merge_queue_org_project").on(table.orgId, table.projectId),
    index("merge_queue_org_project_status").on(table.orgId, table.projectId, table.status),
    uniqueIndex("merge_queue_org_queue_unique").on(table.orgId, table.queueId),
    uniqueIndex("merge_queue_active_run_unique")
      .on(table.runId)
      .where(sql`status IN ('queued', 'merging', 'parked_grant', 'held_policy')`),
  ],
);

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
