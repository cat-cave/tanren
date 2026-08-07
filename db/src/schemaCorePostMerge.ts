import { foreignKey, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { enumCheck, organizations, projects, runs, specs } from "./schemaCoreFoundation.js";

// Post-merge issue claims are a separate write-once lifecycle domain.
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
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "post_merge_issue_claims_project_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId],
      foreignColumns: [specs.orgId, specs.projectId, specs.specId],
      name: "post_merge_issue_claims_spec_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId, table.runId],
      foreignColumns: [runs.orgId, runs.projectId, runs.specId, runs.runId],
      name: "post_merge_issue_claims_run_lineage_fk",
    }),
    enumCheck("post_merge_issue_claims_status_check", table.status, ["claimed", "filed"]),
    index("post_merge_issue_claims_org_id").on(table.orgId),
    index("post_merge_issue_claims_org_project").on(table.orgId, table.projectId),
  ],
);
