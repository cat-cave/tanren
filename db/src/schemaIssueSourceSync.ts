import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";
import { inboxSources } from "./schemaInbox.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { issueLoops } from "./schemaIssueLoops.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

// bh-7 reuses source_findings (0049) and webhook_events claim columns (0052).
// The durable source-sync intent is its own org-scoped outbox surface.
export const sourceSyncOutbox = pgTable(
  "source_sync_outbox",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    issueLoopId: text("issue_loop_id").notNull(),
    sourceId: text("source_id").notNull(),
    operation: text("operation").notNull(),
    state: text("state").notNull().default("pending"),
    payloadHash: text("payload_hash").notNull(),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.issueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.id],
      name: "source_sync_outbox_issue_loop_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.sourceId],
      foreignColumns: [inboxSources.orgId, inboxSources.id],
      name: "source_sync_outbox_source_fk",
    }),
    index("source_sync_outbox_org_id").on(table.orgId),
    index("source_sync_outbox_org_loop").on(table.orgId, table.issueLoopId),
    index("source_sync_outbox_org_source_state").on(table.orgId, table.sourceId, table.state),
    check(
      "source_sync_outbox_state_check",
      sql`${table.state} IN ('pending','sent','verified','externally_closed_unverified')`,
    ),
    check("source_sync_outbox_payload_hash_check", sql`${table.payloadHash} ~ ${digestPattern}`),
    check(
      "source_sync_outbox_claim_check",
      sql`(${table.claimOwner} IS NULL AND ${table.claimExpiresAt} IS NULL) OR (${table.claimOwner} IS NOT NULL AND ${table.claimExpiresAt} IS NOT NULL)`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
