import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { stateEnumLists } from "./stateEnums.js";

// Core identity + project/spec tables. These are referenced by the split
// sub-schema files (schemaForge, schemaInbox, …). Keeping them here — rather
// than in schema.ts — lets those sub-schemas reference the base tables without
// importing schema.ts, which re-exports the sub-schemas (that re-export edge
// would otherwise close an import cycle). schema.ts re-exports everything here
// so consumers + the migration generator still see one `schema.*` namespace.

export function enumCheck(name: string, column: AnyPgColumn, values: ReadonlyArray<string>) {
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
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`), // P3-0014: discovery provenance under `discovery` key
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    tenantId: text("tenant_id")
  },
  (table) => [enumCheck("specs_status_check", table.status, stateEnumLists.specs_status)]
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
