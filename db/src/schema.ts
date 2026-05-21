import { bigint, integer, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  projectId: text("project_id").primaryKey(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  runnerImage: text("runner_image").notNull().default("ghcr.io/cat-cave/tanren-runner:v0"),
  allocator: text("allocator").notNull().default("local-docker"),
  config: jsonb("config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  tenantId: text("tenant_id")
});

export const specs = pgTable("specs", {
  specId: text("spec_id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  acceptanceCriteria: jsonb("acceptance_criteria").notNull().default([]),
  dependsOn: text("depends_on").array().notNull().default([]),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  tenantId: text("tenant_id")
});

export const runs = pgTable("runs", {
  runId: text("run_id").primaryKey(),
  specId: text("spec_id").notNull(),
  projectId: text("project_id").notNull(),
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
  runId: text("run_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("pending"),
  outcome: text("outcome"),
  agentKind: text("agent_kind").notNull(),
  cli: text("cli").notNull(),
  model: text("model"),
  attempt: integer("attempt").notNull().default(1)
});

export const costRecords = pgTable("cost_records", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  taskId: text("task_id").notNull(),
  runId: text("run_id").notNull(),
  projectId: text("project_id").notNull(),
  cli: text("cli").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cachedTokens: integer("cached_tokens").notNull().default(0),
  costUsd: numeric("cost_usd").notNull(),
  pricingMode: text("pricing_mode").notNull(),
  costSource: text("cost_source").notNull(),
  costSourceRaw: jsonb("cost_source_raw").notNull().default({}),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow()
});

export const events = pgTable("events", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  runId: text("run_id"),
  taskId: text("task_id"),
  specId: text("spec_id"),
  projectId: text("project_id"),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull().default({})
});
