// P3-0021 scheduled audits: typed contracts for the recurring read-only
// Answerer-pass library.
//
// An AUDIT JOB is a persisted recurring pass (kind / cadence / target-window /
// Answerer CLI / enabled / last-run / findings). When a job RUNS, an injectable
// `AuditPassRunner` executes a read-only Answerer pass (over the SSH substrate
// in prod; a fake in tests) and returns FINDINGS. The scheduler emits those
// findings into the candidate inbox (P3-0022) through a SYSTEM source that
// auto-routes — so audit findings become candidates with no manual triage.
//
// The pass runner is a seam (mirrors P3-0010 / P3-0014 / the inbox triage
// answerer) so nothing here couples to a provider and the whole flow is
// mockable end-to-end.

import { z } from "zod";

// The audit kinds — mirror the hi-fi `AUDIT_KIND_GLYPH` keys plus the deferred
// stale-specs sweep called out in PROJECT_BRIEF §2.2.
export const AuditKind = z.enum(["security", "deps", "a11y", "mutation", "perf", "license", "stale_specs"]);
export type AuditKind = z.infer<typeof AuditKind>;

// How often the pass runs; the surface renders the human cadence label.
export const AuditCadence = z.enum(["nightly", "weekly", "monthly"]);
export type AuditCadence = z.infer<typeof AuditCadence>;

// Severity of a job's last-pass roll-up (drives the row tone in the surface).
export const AuditFindingSeverity = z.enum(["ok", "info", "warn", "fail", "off"]);
export type AuditFindingSeverity = z.infer<typeof AuditFindingSeverity>;

// The last-pass findings summary persisted on the job row.
export const AuditFindingsSummary = z
  .object({
    count: z.number().int().min(0).default(0),
    severity: AuditFindingSeverity.default("ok"),
    note: z.string().max(300).default("")
  })
  .strict();
export type AuditFindingsSummary = z.infer<typeof AuditFindingsSummary>;

// A persisted audit job.
export const AuditJob = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    kind: AuditKind,
    name: z.string().min(1).max(120),
    cadence: AuditCadence,
    targetWindow: z.string().max(120).default(""),
    answererCli: z.string().max(120).default(""),
    enabled: z.boolean().default(true),
    // ISO timestamp of the last successful pass, or null until first run.
    lastRun: z.string().nullable().default(null),
    findings: AuditFindingsSummary.default({ count: 0, severity: "ok", note: "" })
  })
  .strict();
export type AuditJob = z.infer<typeof AuditJob>;

// One finding a pass produces — the unit that becomes a candidate. `externalId`
// is the pass's own stable key so re-running a job is idempotent in the inbox
// (it upserts on (source_id, external_id), never duplicates).
export interface AuditFinding {
  externalId: string;
  title: string;
  body: string;
  severity: "info" | "warn" | "fail";
}

// The result of running a job's read-only pass.
export interface AuditPassResult {
  findings: AuditFinding[];
}

// The injectable pass seam: a kind's read-only Answerer pass. The real impl
// runs the Answerer over the SSH substrate for the job's repo; tests inject a
// fake; the scheduler treats it as opaque.
export interface AuditPassRunner {
  run(job: AuditJob): Promise<AuditPassResult>;
}
