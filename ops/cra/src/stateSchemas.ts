import { z } from "zod";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const isoDateSchema = z.iso.datetime({ offset: true });

export const retryStateSchema = z.strictObject({
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: isoDateSchema.nullable(),
  lastError: z.string().nullable(),
});

export const prStateSchema = z.strictObject({
  pr: z.number().int().positive(),
  lastSeenHeadSha: shaSchema,
  lastReviewedHeadSha: shaSchema.nullable(),
  lastReviewedBaseSha: shaSchema.nullable(),
  auditedIssueNumber: z.number().int().positive().nullable().default(null),
  rubricVersion: z.string().min(1),
  reviewId: z.number().int().positive().nullable(),
  findingIds: z.array(z.string().min(1)).refine((values) => values.length === new Set(values).size),
  disposition: z.enum(["pending", "auditing", "approved", "changes_requested", "merged", "abandoned", "error"]),
  firstAuthorActivityAt: isoDateSchema,
  lastAuthorActivityAt: isoDateSchema,
  awaitingAuthorSince: isoDateSchema.nullable(),
  retry: retryStateSchema,
  followUpIssues: z.array(z.number().int().positive()).refine((values) => values.length === new Set(values).size),
  reminderDaysSent: z
    .array(z.number().int().positive())
    .refine((values) => values.length === new Set(values).size)
    .default([]),
  abandonmentReason: z.enum(["findings", "inactivity"]).nullable().default(null),
  auditStatus: z.enum(["idle", "in_progress", "completed", "failed"]),
});

export type PrState = z.infer<typeof prStateSchema>;

export const auditArtifactSchema = z.strictObject({
  pr: z.number().int().positive(),
  headSha: shaSchema,
  baseSha: shaSchema,
  auditedIssueNumber: z.number().int().positive(),
  rubricVersion: z.string().min(1),
  createdAt: isoDateSchema,
  report: z.unknown(),
});

export type AuditArtifact = z.infer<typeof auditArtifactSchema>;

export const eventSchema = z.strictObject({
  timestamp: isoDateSchema,
  type: z.enum([
    "poll",
    "selection",
    "audit_start",
    "audit_end",
    "review",
    "finding",
    "merge_authorization",
    "merge_denial",
    "security_anomaly",
    "issue_routing",
    "abandonment",
    "cleanup",
    "error",
  ]),
  pr: z.number().int().positive().nullable(),
  headSha: shaSchema.nullable(),
  rubricVersion: z.string().min(1),
  actor: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  correlationId: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).default({}),
});

export type CraEvent = z.infer<typeof eventSchema>;
