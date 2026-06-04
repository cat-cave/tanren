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
import { organizations, projects, runs, users } from "./schemaCore.js";

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

// CI-intelligence ingestion (foundation): PER-TEST CI results, parsed from a
// JUnit report uploaded by the generated repo's CI (`tanren-ci.yml`) to the
// `/webhooks/ci/junit` ingest endpoint. Tanren already records CI at the
// check-run CONCLUSION level (quarantined_tests above derives from that); THIS
// table adds the per-test granularity later phases act on (per-test flakiness,
// duration hotspots, root-cause spec generation).
//
// APPEND-ONLY: each upload inserts one row per `<testcase>` for that
// (run, attempt). Never updated — per-test HISTORY is the asset, so a re-run
// appends a new attempt rather than overwriting. Carries its own org_id (3a-style
// direct RLS), keyed through the run/project it belongs to.
export const ciTestResults = pgTable(
  "ci_test_results",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    /** Stable per-test identity (classname+name) — the cross-run history join key. */
    testId: text("test_id").notNull(),
    /** The test source file, when the runner reported it. */
    file: text("file"),
    /** The owning JUnit `<testsuite name=>`, when present. */
    suite: text("suite"),
    /** The commit SHA the report was produced against (CI `github.sha`). */
    headSha: text("head_sha").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.runId),
    /** The CI re-run attempt this report came from (GitHub `run_attempt`), ≥ 1. */
    attempt: integer("attempt").notNull().default(1),
    /** Normalized outcome: passed / failed / error / skipped. */
    outcome: text("outcome").notNull(),
    /** Wall-clock duration in ms (null when the runner omitted `time`). */
    durationMs: integer("duration_ms"),
    /** Intra-run retries observed for this test in this report (Surefire reruns). */
    retries: integer("retries").notNull().default(0),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("ci_test_results_outcome_check", sql`${table.outcome} IN ('passed','failed','error','skipped')`),
    check("ci_test_results_attempt_check", sql`${table.attempt} >= 1`),
    check("ci_test_results_retries_check", sql`${table.retries} >= 0`),
    index("ci_test_results_org_id").on(table.orgId),
    index("ci_test_results_org_project").on(table.orgId, table.projectId),
    // Per-test history lookups: a single test's results over time within a project.
    index("ci_test_results_project_test").on(table.projectId, table.testId, desc(table.observedAt)),
    index("ci_test_results_run").on(table.runId),
  ],
);
