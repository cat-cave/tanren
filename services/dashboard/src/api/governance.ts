/**
 * Strict dashboard mirror of the canonical per-project governance response.
 *
 * The dashboard validates the complete GET/PUT success payload at its
 * orchestrator boundary. A malformed response must fail loudly instead of
 * painting invented defaults into a safety-sensitive settings form.
 */

import { z } from "zod";

export const FindingSeveritySchema = z.enum(["P0", "P1", "P2", "P3"]);

export const P2P3HandlingSchema = z.enum(["fix-if-idle", "route-to-dag"]);

export const AuditPostureSchema = z
  .object({
    blockReviewAt: FindingSeveritySchema,
    p2p3Handling: P2P3HandlingSchema,
    autonomousRemediation: z.boolean(),
  })
  .strict();
export type AuditPosture = z.infer<typeof AuditPostureSchema>;

const InsightThresholdsSchema = z
  .object({
    retryHotspotMinAttempts: z.number().int().min(1).optional(),
    retryHotspotWindowDays: z.number().int().min(1).optional(),
    modelMismatchWindowDays: z.number().int().min(1).optional(),
    modelMismatchMinMergedPerModel: z.number().int().min(1).optional(),
    modelMismatchCostRatio: z.number().positive().optional(),
    paceAnomalyMultiplier: z.number().positive().optional(),
    paceAnomalyWindowDays: z.number().int().min(1).optional(),
    paceAnomalyMinSamples: z.number().int().min(1).optional(),
    reviewStallHours: z.number().positive().optional(),
    reviewStallWindowDays: z.number().int().min(1).optional(),
    flakyMinToggledShas: z.number().int().min(1).optional(),
    flakyWindowDays: z.number().int().min(1).optional(),
    ciInsightFlakyMinShas: z.number().int().min(1).optional(),
    ciInsightSlowMinSuiteTests: z.number().int().min(1).optional(),
    cacheFreshnessMs: z.number().int().min(0).optional(),
  })
  .strict();

export const GovernanceViewSchema = z
  .object({
    reviewPolicy: z.enum(["human", "auto", "simulated"]),
    mergeIntegration: z.enum(["native_queue", "direct_merge", "external_reviewer", "not_configured"]),
    governancePosture: z.enum(["strict", "open", "audit_only", "lenient"]),
    auditPosture: AuditPostureSchema,
    insightThresholds: InsightThresholdsSchema,
    revision: z.string().min(1),
  })
  .strict();
export type GovernanceView = z.infer<typeof GovernanceViewSchema>;
