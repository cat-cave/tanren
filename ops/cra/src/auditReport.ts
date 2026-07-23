import { z } from "zod";

// Strict schema for the cross-model audit worker's report. A malformed, truncated,
// contradictory, or head-mismatched report is a fail-closed AUDIT FAILURE — never an
// empty finding set, never a silent approval. Missing acceptance traces, deletion
// accounting, or executed negative controls are rejected outright.

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export const findingSeveritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const findingCategorySchema = z.enum([
  "completion",
  "regression_deletion",
  "correctness",
  "security",
  "standards",
  "operability",
  "betterment",
]);
export type FindingCategory = z.infer<typeof findingCategorySchema>;

const evidenceSchema = z.strictObject({
  // A locatable finding carries a changed-file path plus a line; general findings
  // set path/line null and are summarized in the review body with exact evidence.
  path: z.string().min(1).nullable(),
  line: z.number().int().positive().nullable(),
  side: z.enum(["LEFT", "RIGHT"]).nullable(),
  commandRef: z.string().min(1).nullable(),
  detail: z.string().min(1),
});

export const auditFindingSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  category: findingCategorySchema,
  // Whether the finding concerns the ORIGINAL acceptance (a completion gap, always
  // forced P0 by the supervisor) or newly surfaced separable work.
  concerns: z.enum(["acceptance", "new_work"]),
  suggestedSeverity: findingSeveritySchema,
  fixDirection: z.string().min(1).nullable(),
  evidence: evidenceSchema,
});
export type AuditFinding = z.infer<typeof auditFindingSchema>;

const acceptanceTraceSchema = z.strictObject({
  statement: z.string().min(1),
  satisfied: z.boolean(),
  evidence: z.string().min(1),
});

const deletionEntrySchema = z.strictObject({
  path: z.string().min(1),
  deletedLines: z.number().int().nonnegative(),
  isTest: z.boolean(),
  // The worker's judgement that the deletion is accounted for by replacement
  // coverage. `false` is the mq-16 class: live code/tests removed to fake green.
  justified: z.boolean(),
  justification: z.string().min(1),
});

export const negativeControlSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  mandatory: z.boolean(),
  // "executed" controls carry a command re-run in the isolated runner to confirm
  // the bad input is actually rejected; "inspected" controls cite static evidence.
  kind: z.enum(["executed", "inspected"]),
  command: z.strictObject({ executable: z.string().min(1), args: z.array(z.string()) }).nullable(),
  expectedRejection: z.string().min(1),
  observedResult: z.string().min(1),
  rejected: z.boolean(),
  evidenceRef: z.string().min(1),
});
export type NegativeControl = z.infer<typeof negativeControlSchema>;

const unresolvedCheckSchema = z.strictObject({
  name: z.string().min(1),
  status: z.string().min(1),
  reason: z.string().min(1),
});

export const auditReportSchema = z.strictObject({
  rubricVersion: z.string().min(1),
  headSha: shaSchema,
  baseSha: shaSchema,
  examinedFiles: z.array(z.string().min(1)),
  // Acceptance traces are mandatory and non-empty: a report that traces nothing is
  // not a completion audit.
  acceptanceTraces: z.array(acceptanceTraceSchema).min(1),
  // The key is mandatory; an empty array is a positive assertion of "no deletions".
  deletionAccounting: z.array(deletionEntrySchema),
  // At least one EXECUTED negative control is required: every node issue in this
  // repository carries a required negative control, and green CI is not one.
  negativeControls: z
    .array(negativeControlSchema)
    .refine((controls) => controls.some((control) => control.kind === "executed"), {
      message: "audit report has no executed negative control",
    }),
  unresolvedChecks: z.array(unresolvedCheckSchema),
  findings: z.array(auditFindingSchema),
});
export type AuditReport = z.infer<typeof auditReportSchema>;

export class AuditFailure extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

// The worker returned output that is not a valid strict report.
export class AuditReportInvalidError extends AuditFailure {}

// The worker's report is well-formed but describes a different head/base/rubric
// than the audit requested — a stale or substituted report, treated as a failure.
export class AuditReportMismatchError extends AuditFailure {}

export interface ExpectedAudit {
  readonly headSha: string;
  readonly baseSha: string;
  readonly rubricVersion: string;
}

// Parse and fail-close. Never returns an empty finding set as a substitute for a
// broken audit: a rejection throws so the pipeline blocks and posts no approval.
export function parseAuditReport(raw: unknown, expected: ExpectedAudit): AuditReport {
  const parsed = auditReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AuditReportInvalidError(`audit report failed strict validation: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  const report = parsed.data;
  if (report.headSha !== expected.headSha) {
    throw new AuditReportMismatchError(
      `audit report head ${report.headSha} does not match audited head ${expected.headSha}`,
    );
  }
  if (report.baseSha !== expected.baseSha) {
    throw new AuditReportMismatchError(
      `audit report base ${report.baseSha} does not match audited base ${expected.baseSha}`,
    );
  }
  if (report.rubricVersion !== expected.rubricVersion) {
    throw new AuditReportMismatchError(
      `audit report rubric ${report.rubricVersion} does not match rubric ${expected.rubricVersion}`,
    );
  }
  return report;
}
