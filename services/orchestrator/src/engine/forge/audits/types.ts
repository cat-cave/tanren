// scheduled audits: typed contracts for the recurring read-only
// Answerer-pass library.
//
// An AUDIT JOB is a persisted recurring pass (kind / cadence / target-window /
// Answerer CLI / enabled / last-run / findings). When a job RUNS, an injectable
// `AuditPassRunner` executes a read-only Answerer pass (over the SSH substrate
// in prod; a fake in tests) and returns FINDINGS. The scheduler emits those
// findings into the candidate inbox through a SYSTEM source that
// auto-routes — so audit findings become candidates with no manual triage.
//
// The pass runner is a seam (mirrors the conversation / discovery / inbox triage
// answerer) so nothing here couples to a provider and the whole flow is
// mockable end-to-end.

import { z } from "zod";
import type { ReconIndex } from "../brownfield/types.js";
import type { FindingSeverity } from "../../contracts/findings.js";

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
    note: z.string().max(300).default(""),
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
    findings: AuditFindingsSummary.default({ count: 0, severity: "ok", note: "" }),
  })
  .strict();
export type AuditJob = z.infer<typeof AuditJob>;

// One finding a pass produces — the unit that becomes a candidate. `externalId`
// is the pass's own stable key so re-running a job is idempotent in the inbox
// (it upserts on (source_id, external_id), never duplicates). `severity` is the
// SHARED P0–P3 `FindingSeverity` ladder (`contracts/findings.ts`) — the SAME scale
// inline audits emit — so a scheduled audit's findings route through the SAME
// `auditPosture` severity path (`decideFromFindings`): a finding at-or-above the
// project's `blockReviewAt` is escalated to needs_attention, the residual is routed
// into the DAG. The inbox candidate's display severity is derived from this via
// `findingToInboxSeverity`.
export interface AuditFinding {
  externalId: string;
  title: string;
  body: string;
  severity: FindingSeverity;
}

// Map a P0–P3 finding severity to the inbox candidate's `info|warn|fail` display
// scale (the candidate store / surface vocabulary, which the parallel inbox wave
// owns — unchanged here). DELIBERATELY total: P0/P1 (the block-worthy tier) ⇒ `fail`,
// P2 ⇒ `warn`, P3 ⇒ `info`. The ROUTING decision is made on the P0–P3 severity via
// `auditPosture`; this projection is only the candidate row's display tone.
export function findingToInboxSeverity(severity: FindingSeverity): "info" | "warn" | "fail" {
  switch (severity) {
    case "P0":
    case "P1":
      return "fail";
    case "P2":
      return "warn";
    case "P3":
      return "info";
    default: {
      const exhaustive: never = severity;
      throw new Error(`findingToInboxSeverity: unhandled severity ${String(exhaustive)}`);
    }
  }
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

// ── The audit Answerer: the read-only model pass over the project's repo ─────
//
// The structured output a read-only audit Answerer returns for one job: the
// findings it surfaced inspecting the indexed repo. `externalId` is the model's
// stable handle for the finding (a slug it picks deterministically from the
// issue, e.g. `unbounded-loop-userService`) so re-running the same audit upserts
// the SAME candidate rather than duplicating — the per-job idempotency key.
export const AuditReportFinding = z
  .object({
    externalId: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    // Enough context to become a routableSpec: what the issue is, where it
    // lives, why it matters, and what fixing it would entail.
    body: z.string().min(1).max(6000),
    // The SHARED P0–P3 severity ladder (`contracts/findings.ts:FindingSeverity`) — the
    // SAME scale inline audits emit, so the scheduler's auditPosture routing applies
    // identically. Default P2 (mid: the residual/route tier under the default posture).
    severity: z.enum(["P0", "P1", "P2", "P3"]).default("P2"),
  })
  .strict();
export type AuditReportFinding = z.infer<typeof AuditReportFinding>;

export const AuditPassReport = z
  .object({
    findings: z.array(AuditReportFinding).default([]),
  })
  .strict();
export type AuditPassReport = z.infer<typeof AuditPassReport>;

// The injectable audit-Answerer seam (mirrors the recon/triage answerers). The
// real impl wraps a provider `AnswererAdapter`; tests inject a fake. Given the
// read-only repo index + the job's kind/target-window, it returns the findings.
export interface AuditAnswererContext {
  job: AuditJob;
  index: ReconIndex;
  // §7.7 audit dedup: the stable externalIds the PRIOR pass of this job emitted, fed
  // forward so the model REUSES the same id for the same underlying issue (the inbox
  // upserts on (source_id, external_id), so a reused id is idempotent) instead of
  // re-minting via byte-identical free-text regeneration. Omitted on a first pass.
  priorExternalIds?: ReadonlyArray<string>;
}

export interface AuditAnswerer {
  audit(context: AuditAnswererContext): Promise<AuditPassReport>;
}
