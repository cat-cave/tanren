import { pgTable, text } from "drizzle-orm/pg-core";

// A cycle-free reference for core-table foreign keys that target the bh-1
// issue-loop aggregate. The real table remains exported by schemaIssueLoops.ts.
export const issueLoopsReference = pgTable("issue_loops", {
  orgId: text("org_id").notNull(),
  id: text("id").notNull(),
});
