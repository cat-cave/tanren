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
import { organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

// rv-16b: behavior-aware merge-queue regression bisection. When rv-16a persists a
// post-merge PRODUCTION behavior verdict that regressed (a behavior that previously
// `passed` now records `failed_product`), this append-only ledger records the
// localization of WHICH deployed candidate release introduced it — the culprit +
// the real probe trail, OR a fail-closed `inconclusive` + why. The DB CHECK is the
// anti-scapegoat guard (mirrors the 0079 verdict CHECKs): a `localized` row MUST
// carry a culprit and NO reason; an `inconclusive` row MUST carry a reason and NO
// culprit — so a bisection that could not re-prove the flip can never name a scapegoat.
export const regressionBisections = pgTable(
  "behavior_regression_bisections",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    behaviorRevisionId: text("behavior_revision_id").notNull(),
    failingReleaseInstanceId: text("failing_release_instance_id").notNull(),
    failingVerdictId: text("failing_verdict_id").notNull(),
    baselineReleaseInstanceId: text("baseline_release_instance_id"),
    artifactDigest: text("artifact_digest").notNull(),
    integrationNodeId: text("integration_node_id").notNull(),
    status: text("status").notNull(),
    culpritReleaseInstanceId: text("culprit_release_instance_id"),
    culpritIntegrationNodeId: text("culprit_integration_node_id"),
    inconclusiveReason: text("inconclusive_reason"),
    candidateCount: integer("candidate_count").notNull(),
    probeCount: integer("probe_count").notNull(),
    probeTrail: jsonb("probe_trail")
      .$type<
        readonly {
          readonly releaseInstanceId: string;
          readonly integrationNodeId: string;
          readonly artifactDigest: string;
          readonly role: string;
          readonly outcome: string;
          readonly classification: string;
          readonly reachable: boolean;
        }[]
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    index("behavior_regression_bisections_org_id").on(table.orgId),
    uniqueIndex("behavior_regression_bisections_verdict_unique").on(table.orgId, table.failingVerdictId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "behavior_regression_bisections_project_fk",
    }),
    check("behavior_regression_bisections_status_check", sql`${table.status} IN ('localized','inconclusive')`),
    check("behavior_regression_bisections_artifact_digest_check", sql`${table.artifactDigest} ~ ${digestPattern}`),
    check(
      "behavior_regression_bisections_counts_check",
      sql`${table.candidateCount} >= 0 AND ${table.probeCount} >= 0`,
    ),
    // Anti-scapegoat: a culprit is nameable ONLY on a localized bisection; an
    // inconclusive bisection MUST carry a reason and can NEVER carry a culprit.
    check(
      "behavior_regression_bisections_outcome_shape_check",
      sql`(
        ${table.status} = 'localized'
          AND ${table.culpritReleaseInstanceId} IS NOT NULL
          AND ${table.culpritIntegrationNodeId} IS NOT NULL
          AND ${table.inconclusiveReason} IS NULL
      ) OR (
        ${table.status} = 'inconclusive'
          AND ${table.culpritReleaseInstanceId} IS NULL
          AND ${table.culpritIntegrationNodeId} IS NULL
          AND ${table.inconclusiveReason} IS NOT NULL
      )`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
