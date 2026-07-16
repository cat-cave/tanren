import { z } from "zod";

export const SourceKind = z.enum(["issues", "errors", "system", "manual", "scheduled_audit"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const InboxSourceAttention = z
  .object({
    code: z.enum([
      "unsupported_provider",
      "invalid_config",
      "credential_unavailable",
      "authority_unavailable",
      "resource_unavailable",
    ]),
    message: z.string().min(1).max(300),
    observedAt: z.string().datetime(),
  })
  .strict();
export type InboxSourceAttention = z.infer<typeof InboxSourceAttention>;

export const RecoverableInboxSourceAttentionCode = z.enum([
  "credential_unavailable",
  "authority_unavailable",
  "resource_unavailable",
]);

export function inboxSourceIsRecoverable(source: { attention: InboxSourceAttention | null; config: unknown }): boolean {
  return (
    source.config !== null &&
    source.attention !== null &&
    RecoverableInboxSourceAttentionCode.safeParse(source.attention.code).success
  );
}

const GithubConfig = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    labels: z.array(z.string().min(1)),
    pollIntervalMs: z.number().int().positive().optional(),
  })
  .strict();

const SentryConfig = z
  .object({
    org: z.string().min(1),
    project: z.string().min(1),
    baseUrl: z.string().url(),
    query: z.string().min(1).optional(),
    level: z.enum(["debug", "info", "warning", "error", "fatal", "sample"]).optional(),
    pollIntervalMs: z.number().int().positive().optional(),
    managedBy: z.literal("integration-provisioner").optional(),
  })
  .strict();

const SourceBase = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    name: z.string().min(1).max(120),
    detail: z.string().max(200),
    enabled: z.boolean(),
    autoRoute: z.boolean(),
    state: z.enum(["active", "needs_attention"]),
    attention: InboxSourceAttention.nullable(),
    retryNotBefore: z.string().datetime().nullable(),
    webhookConfigured: z.boolean(),
  })
  .strict();

export const InboxSource = z
  .discriminatedUnion("kind", [
    SourceBase.extend({ kind: z.literal("issues"), config: GithubConfig.nullable() }),
    SourceBase.extend({ kind: z.literal("errors"), config: SentryConfig.nullable() }),
    SourceBase.extend({
      kind: z.literal("system"),
      config: z
        .object({ ciInsights: z.literal(true) })
        .strict()
        .nullable(),
    }),
    SourceBase.extend({ kind: z.literal("manual"), config: z.object({}).strict().nullable() }),
    SourceBase.extend({ kind: z.literal("scheduled_audit"), config: z.object({}).strict().nullable() }),
  ])
  .superRefine((source, ctx) => {
    if ((source.state === "needs_attention") !== (source.attention !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attention"], message: "attention must match source state" });
    }
    if (source.state === "needs_attention" && source.enabled) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["enabled"], message: "terminal source must be disabled" });
    }
    if (source.state === "active" && source.config === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["config"], message: "active source config is required" });
    }
  });
export type InboxSource = z.infer<typeof InboxSource>;

export const TriageVerdict = z.enum(["auto_routable", "needs_call", "dedupe_close"]);
export type TriageVerdict = z.infer<typeof TriageVerdict>;

export const CandidateStatus = z.enum([
  "new",
  "triaged",
  "auto_routed",
  "accepted",
  "folded",
  "dismissed",
  "closed_duplicate",
]);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

const RoutableSpec = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    dependsOn: z.array(z.string().min(1)),
    priority: z.enum(["P0", "P1", "P2", "P3", "tbd"]),
  })
  .strict();

const EntityAnchor = z
  .object({
    entityId: z.string().min(1).max(400),
    kind: z.string().min(1).max(80),
    name: z.string().max(200),
    path: z.string().max(400),
  })
  .strict();

export const CandidateTriage = z
  .object({
    dedupe: z.string().min(1).max(400),
    match: z.string().min(1).max(400),
    placement: z.string().min(1).max(400),
    verdict: TriageVerdict,
    duplicateOfSpecId: z.string().min(1).nullable(),
    discoveryVariant: z.enum(["feature", "bug", "strategic"]),
    routableSpec: RoutableSpec.nullable(),
    entityAnchor: EntityAnchor.nullable(),
  })
  .strict();
export type CandidateTriage = z.infer<typeof CandidateTriage>;

export const Candidate = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    externalId: z.string().min(1),
    title: z.string().min(1).max(300),
    body: z.string().max(8000),
    severity: z.enum(["info", "warn", "fail"]),
    status: CandidateStatus,
    triage: CandidateTriage.nullable(),
    resolvedSpecId: z.string().min(1).nullable(),
    sourceName: z.string().max(120),
    sourceKind: SourceKind,
  })
  .strict();
export type Candidate = z.infer<typeof Candidate>;

export const InboxSnapshot = z.object({ sources: z.array(InboxSource), candidates: z.array(Candidate) }).strict();
export type InboxSnapshot = z.infer<typeof InboxSnapshot>;

export const InboxSourceResponse = z.object({ source: InboxSource }).strict();

export const InboxRecoveryErrorResponse = z
  .object({
    error: z.string().min(1),
    message: z.string().min(1).optional(),
  })
  .passthrough();
