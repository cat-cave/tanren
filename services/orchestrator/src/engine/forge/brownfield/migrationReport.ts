// Brownfield migration-risk report.
//
// Takes the classified `WorkflowIntent[]` (from `workflowIntent.ts`) and
// assembles the operator-facing migration-risk report: a per-item disposition
// (`owner / intent / replacement / confidence / status / blocking /
// dispositionReason`) plus the headline readiness verdict.
//
// The load-bearing RULE (the whole reason this report exists): a repo is NOT
// "Tanren-native-ready" while any security / compliance / production behavior is
// merely DROPPED. Quality and harmless intents may be intentionally dropped and
// the repo is still ready; the moment a secret-scan, an approval gate, or a prod
// deploy is left on the floor (status `intentionally_dropped`), readiness flips
// to false and the item is marked `blocking`.
//
// PURE + transient: this builds an in-memory report object. It is NOT persisted
// as a new entity-shape (no migration) — the route returns it (and may fold it
// into the existing `projects.config` jsonb if the operator wants it kept).

import { z } from "zod";
import { DispositionSeverity, NativeReplacementKind, WorkflowIntentCategory } from "./workflowIntent.js";
import type { WorkflowIntent } from "./workflowIntent.js";

// ── Disposition status ─────────────────────────────────────────────────────

// What actually happened to an intent on the migration.
//   migrated                              — native primitive carries the intent
//                                           1:1 (a lint check → quick_gate).
//   replaced                              — native equivalent with different
//                                           shape (Actions deploy → deploy_plan).
//   intentionally_dropped                 — the operator chose to drop it (only
//                                           SAFE for harmless/quality severity).
//   shadow_only                           — observed/recorded but not enforced
//                                           yet (e.g. mirrored, non-blocking).
//   blocked_by_missing_tanren_primitive   — Tanren has no native home for it.
//   requires_external_integration         — handed to an external system
//                                           (Slack, a SAST vendor, a scanner).
//   requires_policy_decision              — a human must decide how to migrate it
//                                           (a compliance/production call).
export const DispositionStatus = z.enum([
  "migrated",
  "replaced",
  "intentionally_dropped",
  "shadow_only",
  "blocked_by_missing_tanren_primitive",
  "requires_external_integration",
  "requires_policy_decision",
]);
export type DispositionStatus = z.infer<typeof DispositionStatus>;

// One row in the report.
export const MigrationDisposition = z
  .object({
    id: z.string().min(1).max(120),
    owner: z.string().min(1).max(400),
    intent: WorkflowIntentCategory,
    replacement: NativeReplacementKind,
    severity: DispositionSeverity,
    confidence: z.number().min(0).max(1),
    status: DispositionStatus,
    blocking: z.boolean(),
    dispositionReason: z.string().min(1).max(400),
  })
  .strict();
export type MigrationDisposition = z.infer<typeof MigrationDisposition>;

export const MigrationRiskReport = z
  .object({
    repoUrl: z.string().min(1).max(400),
    generatedAt: z.string().min(1).max(40),
    tanrenNativeReady: z.boolean(),
    blockingCount: z.number().int().min(0),
    dispositions: z.array(MigrationDisposition),
    summary: z
      .object({
        byStatus: z.record(DispositionStatus, z.number().int().min(0)),
        bySeverity: z.record(DispositionSeverity, z.number().int().min(0)),
      })
      .strict(),
  })
  .strict();
export type MigrationRiskReport = z.infer<typeof MigrationRiskReport>;

// ── Status derivation ──────────────────────────────────────────────────────

// The default disposition for an intent that is being CARRIED OVER (not dropped
// by the operator). Keyed off the native replacement kind:
//   gates                  → migrated (the gate ladder is a 1:1 native home).
//   deploy_plan/release    → replaced (native lane, different shape).
//   scheduled_operation    → migrated.
//   external_check         → requires_external_integration (scanner/vendor).
//   external_integration   → requires_external_integration (notifications).
//   manual_gate            → requires_policy_decision (compliance/prod call).
//   unsupported_automation → blocked_by_missing_tanren_primitive.
function carriedStatus(replacement: NativeReplacementKind): DispositionStatus {
  switch (replacement) {
    case "quick_gate":
    case "task_gate":
    case "spec_gate":
    case "merge_gate":
    case "scheduled_operation":
      return "migrated";
    case "deploy_plan":
    case "release_plan":
      return "replaced";
    case "external_check":
    case "external_integration":
      return "requires_external_integration";
    case "manual_gate":
      return "requires_policy_decision";
    case "unsupported_automation":
      return "blocked_by_missing_tanren_primitive";
  }
}

function reasonFor(status: DispositionStatus, intent: WorkflowIntent): string {
  switch (status) {
    case "migrated":
      return `native ${intent.replacement} carries the ${intent.category} intent`;
    case "replaced":
      return `mapped onto the native ${intent.replacement} (shape differs from the source automation)`;
    case "intentionally_dropped":
      return `operator dropped this ${intent.severity} ${intent.category} intent`;
    case "shadow_only":
      return `observed and recorded via ${intent.replacement} but not yet enforced`;
    case "blocked_by_missing_tanren_primitive":
      return `no native Tanren primitive for ${intent.category} yet (surfaced as ${intent.replacement})`;
    case "requires_external_integration":
      return `${intent.category} runs in an external system; wire the ${intent.replacement} integration`;
    case "requires_policy_decision":
      return `${intent.category} is a ${intent.severity} control; a human must decide how to migrate it`;
  }
}

// ── The not-ready rule ─────────────────────────────────────────────────────

// A dropped intent is BLOCKING when its severity is security/compliance/
// production — those may not be merely dropped. (Quality/harmless drops are
// fine.) An unsupported / policy-required intent at one of those severities is
// also blocking: the repo can't be called ready while a prod deploy has no home.
function severityIsLoadBearing(severity: DispositionSeverity): boolean {
  return severity === "security" || severity === "compliance" || severity === "production";
}

function isBlocking(status: DispositionStatus, severity: DispositionSeverity): boolean {
  if (!severityIsLoadBearing(severity)) return false;
  return (
    status === "intentionally_dropped" ||
    status === "blocked_by_missing_tanren_primitive" ||
    status === "requires_policy_decision" ||
    status === "requires_external_integration"
  );
}

// ── Builder ────────────────────────────────────────────────────────────────

export interface BuildMigrationReportInput {
  repoUrl: string;
  intents: WorkflowIntent[];
  // Intent ids the operator explicitly chose to drop. Dropping a load-bearing
  // (security/compliance/production) intent is what flips readiness to false.
  droppedIds?: string[];
  generatedAt?: string;
}

function emptyStatusTally(): Record<DispositionStatus, number> {
  return {
    migrated: 0,
    replaced: 0,
    intentionally_dropped: 0,
    shadow_only: 0,
    blocked_by_missing_tanren_primitive: 0,
    requires_external_integration: 0,
    requires_policy_decision: 0,
  };
}

function emptySeverityTally(): Record<DispositionSeverity, number> {
  return { harmless: 0, quality: 0, security: 0, compliance: 0, production: 0 };
}

/**
 * Assemble the migration-risk report. Enforces the not-ready-while-load-bearing-
 * dropped rule: `tanrenNativeReady` is false iff any disposition is `blocking`.
 */
export function buildMigrationReport(input: BuildMigrationReportInput): MigrationRiskReport {
  const dropped = new Set(input.droppedIds ?? []);
  const dispositions: MigrationDisposition[] = [];
  const byStatus = emptyStatusTally();
  const bySeverity = emptySeverityTally();
  let blockingCount = 0;

  for (const intent of input.intents) {
    const status: DispositionStatus = dropped.has(intent.id)
      ? "intentionally_dropped"
      : carriedStatus(intent.replacement);
    const blocking = isBlocking(status, intent.severity);
    if (blocking) blockingCount += 1;
    byStatus[status] += 1;
    bySeverity[intent.severity] += 1;
    dispositions.push(
      MigrationDisposition.parse({
        id: intent.id,
        owner: `${intent.source}:${intent.sourcePath}`,
        intent: intent.category,
        replacement: intent.replacement,
        severity: intent.severity,
        confidence: intent.confidence,
        status,
        blocking,
        dispositionReason: reasonFor(status, intent),
      }),
    );
  }

  return MigrationRiskReport.parse({
    repoUrl: input.repoUrl,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    tanrenNativeReady: blockingCount === 0,
    blockingCount,
    dispositions,
    summary: { byStatus, bySeverity },
  });
}
