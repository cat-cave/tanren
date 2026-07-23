import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects, runs } from "./schemaCore.js";

// The orchestrator-side mirror of allocated runners. RLS is ENABLEd + FORCEd with
// the org-isolation policy by hand SQL in the migrations (baseline + 0112), not via
// drizzle's `.enableRLS()`, matching the repo convention for RLS-managed tables.
export const runners = pgTable(
  "runners",
  {
    runnerId: text("runner_id").primaryKey(),
    runId: text("run_id").references(() => runs.runId),
    projectId: text("project_id").references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    allocator: text("allocator").notNull(),
    status: text("status").notNull(),
    sshHost: text("ssh_host").notNull(),
    sshPort: integer("ssh_port").notNull(),
    hostKeyFingerprint: text("host_key_fingerprint").notNull(),
    imageSha: text("image_sha").notNull(),
    containerId: text("container_id"),
    hcloudServerId: text("hcloud_server_id"),
    providerMetadata: jsonb("provider_metadata"),
    // CROSS-PROCESS FIXED-POOL LEASE (#1254 / hazard C). The manual_ssh (and any
    // future fixed_pool) allocator used to track the busy host + `maxConcurrent`
    // cap IN-MEMORY per process, so two orchestrator processes on one host
    // double-booked a runner / overran the cap. These columns move that
    // bookkeeping onto the shared table so it coordinates across processes. All
    // four are NULL for a provisioning/cloud allocation (a fresh resource, not a
    // pooled lease). `pool_key` = the cap bucket (allocator kind); `lease_key` =
    // the leased host id (the partial unique index makes one LIVE lease per host a
    // DB invariant); `lease_owner` + `fencing_token` (from
    // `runner_lease_fencing_token_seq`) are the fencing pair release must match.
    poolKey: text("pool_key"),
    leaseKey: text("lease_key"),
    leaseOwner: text("lease_owner"),
    fencingToken: bigint("fencing_token", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    index("runners_org_id").on(table.orgId),
    // At most ONE live lease per (org, host): a concurrent second claim of the same
    // `lease_key` violates this (23505) even across processes — the DB backstop to
    // the advisory-lock in `reservePoolLease`.
    uniqueIndex("runners_live_lease_key_uniq")
      .on(table.orgId, table.leaseKey)
      .where(sql`${table.leaseKey} IS NOT NULL AND ${table.releasedAt} IS NULL`),
    // The `maxConcurrent` count index: live rows per pool bucket.
    index("runners_pool_live")
      .on(table.orgId, table.poolKey)
      .where(sql`${table.releasedAt} IS NULL`),
  ],
);
