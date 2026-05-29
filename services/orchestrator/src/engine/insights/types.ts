// P2A-0020 workflow-insights type definitions.
//
// Each insight kind has a strongly-typed payload. The discriminated union on
// `kind` is the single source of truth shared by the compute functions, the
// cache writer/reader, the HTTP route, and any consumer (the Forge narration
// generator from P2A-0019 is the first).
//
// The `actions` array carries operator-actionable CTAs. Each action holds a
// `toolCall` shaped like the P2A-0008 `ForgeToolCall` discriminated union.
// We intentionally type `toolCall` as `unknown` here so this module stays
// loosely coupled to the Forge tool schema — callers re-parse the field
// through `ForgeToolCall` when they need typed access. (The hi-fi only
// surfaces existing tools: `tanren.acknowledge_insight`, `tanren.create_spec`,
// `tanren.read_run`, `tanren.read_costs` — no new tool variant is required
// for v0.)
//
// Thresholds (retry counts, lookback windows, cost-ratio bar) live in
// `thresholds.ts` so the compute functions stay declarative. Phase 3 will
// make these per-org configurable; see `docs/architecture/insights.md`.

import { z } from "zod";

export const InsightKind = z.enum([
  "retry_hotspot",
  "model_mismatch",
  "pace_anomaly",
  // P3-0020 additions, both derived from existing rows (no migration to the
  // source data; see schemaInsights.ts for the cache `kind` CHECK widening):
  // `stuck` from spec-dependency-chain analysis (P2A-0018), `review_stall`
  // from review.* events (P3-0008).
  "stuck",
  "review_stall",
]);
export type InsightKind = z.infer<typeof InsightKind>;

export const InsightSeverity = z.enum(["info", "warn", "fail"]);
export type InsightSeverity = z.infer<typeof InsightSeverity>;

export const InsightAction = z
  .object({
    label: z.string().min(1),
    // ForgeToolCall shape from P2A-0008. Typed as unknown here to avoid a
    // module-level coupling between insights and the Forge tool schema; the
    // route layer re-parses through the discriminated union before dispatch.
    toolCall: z.unknown(),
  })
  .strict();
export type InsightAction = z.infer<typeof InsightAction>;

// ---------------------------------------------------------------------------
// Kind-specific payloads.
// ---------------------------------------------------------------------------

export const RetryHotspotPayload = z
  .object({
    kind: z.literal("retry_hotspot"),
    specId: z.string().min(1),
    specTitle: z.string().min(1),
    writerCli: z.string().min(1),
    writerModel: z.string().min(1),
    retryCount: z.number().int().nonnegative(),
    windowDays: z.number().int().positive(),
    rejectionSummaries: z.array(z.string()),
  })
  .strict();
export type RetryHotspotPayload = z.infer<typeof RetryHotspotPayload>;

export const ModelMismatchPayload = z
  .object({
    kind: z.literal("model_mismatch"),
    specClass: z.string().min(1),
    currentModel: z.string().min(1),
    currentCli: z.string().min(1),
    currentCostPerMergedSpec: z.number().nonnegative(),
    alternativeModel: z.string().min(1),
    alternativeCli: z.string().min(1),
    alternativeCostPerMergedSpec: z.number().nonnegative(),
    monthlySavings: z.number(),
    comparisonWindowDays: z.number().int().positive(),
  })
  .strict();
export type ModelMismatchPayload = z.infer<typeof ModelMismatchPayload>;

export const PaceAnomalyPayload = z
  .object({
    kind: z.literal("pace_anomaly"),
    runId: z.string().min(1),
    taskId: z.string().min(1),
    subtaskIndex: z.number().int().nonnegative(),
    elapsedSeconds: z.number().nonnegative(),
    classAverageSeconds: z.number().nonnegative(),
    multiplier: z.number().positive(),
    specClass: z.string().min(1),
  })
  .strict();
export type PaceAnomalyPayload = z.infer<typeof PaceAnomalyPayload>;

// P3-0020 `stuck`: a spec that cannot progress because one or more of its
// declared dependencies (P2A-0018 spec_dependencies edges) are not yet done.
// `blockedSpecId` is waiting on the specs in `blockingSpecs`.
export const StuckPayload = z
  .object({
    kind: z.literal("stuck"),
    blockedSpecId: z.string().min(1),
    blockedSpecTitle: z.string().min(1),
    blockingSpecs: z
      .array(
        z
          .object({
            specId: z.string().min(1),
            title: z.string().min(1),
            status: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    chainDepth: z.number().int().positive(),
  })
  .strict();
export type StuckPayload = z.infer<typeof StuckPayload>;

// P3-0020 `review_stall`: a spec whose PR has been in review (a
// `review.requested` or `review.changes_requested` is the latest review/merge
// signal) for longer than the configured threshold with no subsequent
// approval or merge. `phase` distinguishes a fresh review awaiting a verdict
// from a changes-requested round that has gone quiet.
export const ReviewStallPayload = z
  .object({
    kind: z.literal("review_stall"),
    specId: z.string().min(1),
    specTitle: z.string().min(1),
    prNumber: z.number().int().nonnegative(),
    prUrl: z.string().min(1),
    phase: z.enum(["awaiting_review", "changes_requested"]),
    stalledHours: z.number().nonnegative(),
    thresholdHours: z.number().positive(),
  })
  .strict();
export type ReviewStallPayload = z.infer<typeof ReviewStallPayload>;

export const InsightPayload = z.discriminatedUnion("kind", [
  RetryHotspotPayload,
  ModelMismatchPayload,
  PaceAnomalyPayload,
  StuckPayload,
  ReviewStallPayload,
]);
export type InsightPayload = z.infer<typeof InsightPayload>;

export const Insight = z
  .object({
    id: z.string().min(1),
    kind: InsightKind,
    projectId: z.string().min(1),
    severity: InsightSeverity,
    title: z.string().min(1),
    body: z.string().min(1),
    payload: InsightPayload,
    actions: z.array(InsightAction),
    computedAt: z.date(),
    acknowledgedAt: z.date().nullable(),
    acknowledgedBy: z.string().nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.kind !== row.payload.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "kind"],
        message: `insight.kind (${row.kind}) must match payload.kind (${row.payload.kind})`,
      });
    }
  });
export type Insight = z.infer<typeof Insight>;
