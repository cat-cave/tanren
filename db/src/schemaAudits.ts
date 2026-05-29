// P3-0021 scheduled audits: the recurring read-only Answerer-pass library.
//
// One table, split from schema.ts to respect the file-line-max-500
// architecture rule (re-exported into the single `schema.*` namespace at the
// bottom of schema.ts so the migration generator + consumers see one space):
//
//   audit_jobs  — a PERSISTED recurring audit. Each job carries a `kind`
//                 (security / deps / a11y / mutation / perf / license /
//                 stale_specs), a `cadence` (nightly / weekly / monthly), the
//                 target subscription `window` it fills (ties to the P3-0018
//                 idle-cost windows), the Answerer `cli` that runs the pass, an
//                 `enabled` toggle, the `last_run` timestamp, and the
//                 last-pass `findings` summary (count + severity + note) as
//                 JSONB. A job RUNS a read-only Answerer pass over the SSH
//                 substrate; its findings are emitted into the candidate inbox
//                 (P3-0022) through a SYSTEM source that auto-routes — see the
//                 scheduler in services/orchestrator/src/engine/forge/audits/**.
//
// The audit pass itself runs over the same injectable Answerer seam used across
// P3 (the `AuditPassRunner` in the audits engine), so the LLM/SSH call is
// mockable and nothing here couples to a provider.

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";

// The audit kinds — mirror the hi-fi `AUDIT_KIND_GLYPH` keys plus the deferred
// stale-specs sweep called out in PROJECT_BRIEF §2.2.
const AUDIT_KINDS = ["security", "deps", "a11y", "mutation", "perf", "license", "stale_specs"] as const;

// How often the pass runs; the surface renders the human cadence label.
const AUDIT_CADENCES = ["nightly", "weekly", "monthly"] as const;

export const auditJobs = pgTable(
  "audit_jobs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // A job may be org-wide (e.g. a cross-repo license sweep) or pinned to one
    // project (e.g. an a11y pass on a marketing site). Null = org-wide.
    projectId: text("project_id").references(() => projects.projectId),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    cadence: text("cadence").notNull(),
    // The target subscription window this job fills (free text label so it can
    // carry the P3-0018 window framing, e.g. "chatgpt · night (00–05)").
    targetWindow: text("target_window").notNull().default(""),
    // The Answerer CLI/model that runs the read-only pass (e.g. "claude · haiku-4.5").
    answererCli: text("answerer_cli").notNull().default(""),
    enabled: text("enabled").notNull().default("true"),
    // Last successful pass; null until the job has run once.
    lastRun: timestamp("last_run", { withTimezone: true }),
    // Last-pass findings summary: { count, severity, note }. Default = clean.
    findings: jsonb("findings").notNull().default(sql`'{"count":0,"severity":"ok","note":""}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check(
      "audit_jobs_kind_check",
      sql`${table.kind} IN ('security','deps','a11y','mutation','perf','license','stale_specs')`
    ),
    check("audit_jobs_cadence_check", sql`${table.cadence} IN ('nightly','weekly','monthly')`),
    check("audit_jobs_enabled_check", sql`${table.enabled} IN ('true','false')`),
    index("audit_jobs_org_id").on(table.orgId),
    index("audit_jobs_project_id").on(table.projectId)
  ]
);

// Runtime literal lists, exported for the orchestrator engine to validate
// against without re-declaring the unions.
export const auditKinds = AUDIT_KINDS;
export const auditCadences = AUDIT_CADENCES;
