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
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { eventTypeNames } from "./eventTypes.js";
import { stateEnumLists } from "./stateEnums.js";

function enumCheck(name: string, column: AnyPgColumn, values: ReadonlyArray<string>) {
  const literals = sql.raw(values.map((value) => `'${value.replace(/'/g, "''")}'`).join(","));
  return check(name, sql`${column} IN (${literals})`);
}

export const projects = pgTable("projects", {
  projectId: text("project_id").primaryKey(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  runnerImage: text("runner_image").notNull().default("ghcr.io/cat-cave/tanren-runner:v0"),
  allocator: text("allocator").notNull().default("local-docker"),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  tenantId: text("tenant_id"),
  orgId: text("org_id")
});

export const specs = pgTable(
  "specs",
  {
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
  },
  (table) => [enumCheck("specs_status_check", table.status, stateEnumLists.specs_status)]
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
    trigger: text("trigger").notNull(),
    branch: text("branch").notNull(),
    status: text("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: text("outcome"),
    prUrl: text("pr_url"),
    tenantId: text("tenant_id"),
    userId: text("user_id")
  },
  (table) => [
    enumCheck("runs_status_check", table.status, stateEnumLists.runs_status),
    check(
      "runs_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN (${sql.raw(
        stateEnumLists.runs_outcome.map((value) => `'${value.replace(/'/g, "''")}'`).join(",")
      )})`
    )
  ]
);

export const tasks = pgTable(
  "tasks",
  {
    taskId: text("task_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.runId),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    parentTaskId: text("parent_task_id").references((): AnyPgColumn => tasks.taskId),
    status: text("status").notNull().default("queued"),
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
  },
  (table) => [
    enumCheck("tasks_kind_check", table.kind, stateEnumLists.tasks_kind),
    enumCheck("tasks_status_check", table.status, stateEnumLists.tasks_status),
    enumCheck("tasks_agent_kind_check", table.agentKind, stateEnumLists.tasks_agent_kind),
    check(
      "tasks_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN (${sql.raw(
        stateEnumLists.tasks_outcome.map((value) => `'${value.replace(/'/g, "''")}'`).join(",")
      )})`
    )
  ]
);

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
    // Disjoint token-type buckets (see providers/types.ts TokenUsage). Token
    // accounting is mandatory and first-class; never fold types together.
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningOutputTokens: integer("reasoning_output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    // Cost is best-effort. NULL is an honest, allowed state when no reliable
    // cost basis exists (subscription/self-hosted/unpriced models).
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }),
    billingMode: text("billing_mode").notNull(),
    costBasis: text("cost_basis").notNull(),
    costSourceRaw: jsonb("cost_source_raw").notNull().default(sql`'{}'::jsonb`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    tenantId: text("tenant_id"),
    userId: text("user_id")
  },
  (table) => [
    check("cost_records_billing_mode_check", sql`${table.billingMode} IN ('per_token','subscription','self_hosted')`),
    check("cost_records_cost_basis_check", sql`${table.costBasis} IN ('ccusage','provider_pricing','credits','unknown')`)
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
  (table) => [
    index("events_run_id_ts").on(table.runId, table.ts),
    index("events_event_type").on(table.eventType),
    enumCheck("events_event_type_check", table.eventType, eventTypeNames)
  ]
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
    taskId: text("task_id").references(() => tasks.taskId),
    taskKind: text("task_kind").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("queued"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    // P3-0028 queue lease recovery. A claimed/running job holds a lease that the
    // worker renews via a heartbeat while it executes. `leasedUntil` is the lease
    // expiry; a reaper requeues any `running` job whose lease has lapsed (crashed
    // worker). `heartbeatAt` records the last renewal for observability.
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    // P3-0028 retry budget: bounded re-claim ceiling. When `attempts` reaches it
    // the reaper dead-letters the job instead of requeueing.
    maxAttempts: integer("max_attempts").notNull().default(5),
    failureKind: text("failure_kind"),
    failureMessage: text("failure_message"),
    tenantId: text("tenant_id"),
    userId: text("user_id")
  },
  (table) => [
    index("job_queue_queued").on(table.taskKind, table.enqueuedAt).where(sql`${table.status} = 'queued'`),
    // P3-0028: reaper scans live (running) jobs by lease expiry.
    index("job_queue_lease").on(table.leasedUntil).where(sql`${table.status} = 'running'`),
    enumCheck("job_queue_status_check", table.status, stateEnumLists.job_queue_status),
    enumCheck("job_queue_task_kind_check", table.taskKind, stateEnumLists.job_queue_task_kind)
  ]
);

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    login: text("login").notNull(),
    displayName: text("display_name").notNull(),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("organizations_kind_check", sql`${table.kind} IN ('github_org','github_user','oidc')`),
    uniqueIndex("organizations_provider_unique").on(table.kind, table.externalId)
  ]
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("users_provider_check", sql`${table.provider} IN ('github_oauth','oidc','local_dev')`),
    uniqueIndex("users_provider_subject_unique").on(table.provider, table.providerSubject)
  ]
);

export const orgMembers = pgTable(
  "org_members",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    check("org_members_role_check", sql`${table.role} IN ('admin','member')`)
  ]
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    check("project_members_role_check", sql`${table.role} IN ('admin','member')`)
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    csrfToken: text("csrf_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent")
  },
  (table) => [index("sessions_user_id").on(table.userId), index("sessions_expires_at").on(table.expiresAt)]
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("api_tokens_user_id").on(table.userId), uniqueIndex("api_tokens_hash_unique").on(table.tokenHash)]
);

// ---------------------------------------------------------------------------
// P2A-0018 product entities: personas, behaviors, milestones, spec links,
// directed spec dependency edges. See docs/architecture/product-entities.md.
// ---------------------------------------------------------------------------

export const personas = pgTable(
  "personas",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.projectId),
    name: text("name").notNull(),
    description: text("description").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("personas_scope_check", sql`${table.scope} IN ('org','project')`),
    check(
      "personas_scope_project_check",
      sql`(${table.scope} = 'org' AND ${table.projectId} IS NULL) OR (${table.scope} = 'project' AND ${table.projectId} IS NOT NULL)`
    ),
    index("personas_org_id").on(table.orgId),
    index("personas_project_id").on(table.projectId)
  ]
);

export const behaviors = pgTable(
  "behaviors",
  {
    id: text("id").primaryKey(),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id),
    title: text("title").notNull(),
    given: text("given").notNull(),
    when: text("when").notNull(),
    // eslint-disable-next-line unicorn/no-thenable
    then: text("then").notNull(),
    description: text("description"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("behaviors_persona_id").on(table.personaId)]
);

export const milestones = pgTable(
  "milestones",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    label: text("label").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    orderIndex: integer("order_index").notNull(),
    eta: timestamp("eta", { withTimezone: true }),
    status: text("status").notNull().default("planned"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("milestones_status_check", sql`${table.status} IN ('planned','in_flight','done','abandoned')`),
    uniqueIndex("milestones_project_label_unique").on(table.projectId, table.label),
    uniqueIndex("milestones_project_order_unique").on(table.projectId, table.orderIndex)
  ]
);

export const specBehaviors = pgTable(
  "spec_behaviors",
  {
    specId: text("spec_id")
      .notNull()
      .references(() => specs.specId),
    behaviorId: text("behavior_id")
      .notNull()
      .references(() => behaviors.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.specId, table.behaviorId] }),
    index("spec_behaviors_behavior_id").on(table.behaviorId)
  ]
);

// spec_milestones is modeled as a join table to keep the schema additive for
// future many-to-many evolution, but a unique index on spec_id enforces the
// current one-milestone-per-spec product rule (documented in
// docs/architecture/product-entities.md).
export const specMilestones = pgTable(
  "spec_milestones",
  {
    specId: text("spec_id")
      .notNull()
      .references(() => specs.specId),
    milestoneId: text("milestone_id")
      .notNull()
      .references(() => milestones.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.specId, table.milestoneId] }),
    uniqueIndex("spec_milestones_spec_unique").on(table.specId),
    index("spec_milestones_milestone_id").on(table.milestoneId)
  ]
);

export const specDependencies = pgTable(
  "spec_dependencies",
  {
    fromSpecId: text("from_spec_id")
      .notNull()
      .references(() => specs.specId),
    toSpecId: text("to_spec_id")
      .notNull()
      .references(() => specs.specId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.fromSpecId, table.toSpecId] }),
    check("spec_dependencies_no_self_loop", sql`${table.fromSpecId} <> ${table.toSpecId}`),
    index("spec_dependencies_to_spec_id").on(table.toSpecId)
  ]
);

// Sub-schema files are kept separate to respect the file-line-max-500
// architecture rule. The migration generator and downstream `schema.*`
// consumers see a single namespace via these re-exports.
// - P2A-0017 notifications matrix → schemaNotifications.ts
// - P2A-0019 Forge conversation substrate → schemaForge.ts
// - P2A-0020 workflow insights cache → schemaInsights.ts
export { notificationTargets, notificationRoutes } from "./schemaNotifications.js";
export { forgeThreads, forgeTurns } from "./schemaForge.js";
export { workflowInsights } from "./schemaInsights.js";
