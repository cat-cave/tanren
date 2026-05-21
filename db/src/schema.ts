import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  projectId: text("project_id").primaryKey(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  runnerImage: text("runner_image").notNull().default("ghcr.io/cat-cave/tanren-runner:v0"),
  allocator: text("allocator").notNull().default("local-docker"),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  tenantId: text("tenant_id")
});

export const specs = pgTable("specs", {
  specId: text("spec_id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.projectId),
  title: text("title").notNull(),
  description: text("description").notNull(),
  acceptanceCriteria: jsonb("acceptance_criteria").notNull().default(sql`'[]'::jsonb`),
  dependsOn: text("depends_on").array().notNull().default(sql`'{}'::text[]`),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  tenantId: text("tenant_id")
});

export const runs = pgTable("runs", {
  runId: text("run_id").primaryKey(),
  specId: text("spec_id")
    .notNull()
    .references(() => specs.specId),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.projectId),
  trigger: text("trigger").notNull(),
  branch: text("branch").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  outcome: text("outcome"),
  prUrl: text("pr_url"),
  tenantId: text("tenant_id"),
  userId: text("user_id")
});

export const tasks = pgTable("tasks", {
  taskId: text("task_id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.runId),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  parentTaskId: text("parent_task_id").references((): AnyPgColumn => tasks.taskId),
  status: text("status").notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  outcome: text("outcome"),
  failureKind: text("failure_kind"),
  agentKind: text("agent_kind").notNull(),
  cli: text("cli").notNull(),
  model: text("model"),
  attempt: integer("attempt").notNull().default(1),
  tenantId: text("tenant_id"),
  userId: text("user_id")
});

export const costRecords = pgTable(
  "cost_records",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.taskId),
    runId: text("run_id").notNull(),
    projectId: text("project_id").notNull(),
    cli: text("cli").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }).notNull(),
    pricingMode: text("pricing_mode").notNull(),
    costSource: text("cost_source").notNull(),
    costSourceRaw: jsonb("cost_source_raw").notNull().default(sql`'{}'::jsonb`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    tenantId: text("tenant_id"),
    userId: text("user_id")
  },
  (table) => [
    check("cost_records_pricing_mode_check", sql`${table.pricingMode} IN ('per_token','opportunity_cost','subscription_window')`),
    check(
      "cost_records_cost_source_check",
      sql`${table.costSource} IN ('provider_direct','ccusage','codexbar','opportunity_computed')`
    )
  ]
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    runId: text("run_id"),
    taskId: text("task_id"),
    specId: text("spec_id"),
    projectId: text("project_id"),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    tenantId: text("tenant_id"),
    userId: text("user_id")
  },
  (table) => [index("events_run_id_ts").on(table.runId, table.ts), index("events_event_type").on(table.eventType)]
);

export const runners = pgTable("runners", {
  runnerId: text("runner_id").primaryKey(),
  runId: text("run_id").references(() => runs.runId),
  projectId: text("project_id").references(() => projects.projectId),
  allocator: text("allocator").notNull(),
  status: text("status").notNull(),
  sshHost: text("ssh_host").notNull(),
  sshPort: integer("ssh_port").notNull(),
  hostKeyFingerprint: text("host_key_fingerprint").notNull(),
  imageSha: text("image_sha").notNull(),
  containerId: text("container_id"),
  hcloudServerId: text("hcloud_server_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  tenantId: text("tenant_id")
});

export const rateLimitObservations = pgTable("rate_limit_observations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  taskId: text("task_id").references(() => tasks.taskId),
  callSite: text("call_site").notNull(),
  provider: text("provider").notNull(),
  observation: text("observation").notNull(),
  detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
  retryAfterS: integer("retry_after_s"),
  tenantId: text("tenant_id"),
  userId: text("user_id")
});

export const notifications = pgTable("notifications", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  channel: text("channel").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull(),
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  tenantId: text("tenant_id"),
  userId: text("user_id")
});

export const jobQueue = pgTable(
  "job_queue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id"),
    taskKind: text("task_kind").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    tenantId: text("tenant_id"),
    userId: text("user_id")
  },
  (table) => [index("job_queue_pending").on(table.taskKind, table.enqueuedAt).where(sql`${table.status} = 'pending'`)]
);
