/** Runtime decoders for successful orchestrator write responses. */
/* eslint-disable unicorn/no-thenable -- `then` is the domain's BDD Given/When/Then field. */

import { z } from "zod";

const text = z.string();
const nonempty = z.string().min(1);
const nullableText = z.string().nullable();

const forgeAction = z.object({
  label: text,
  toolCall: z.object({ tool: nonempty, args: z.record(z.string(), z.unknown()).optional() }).passthrough(),
});

export const ForgeAnswerSchema = z
  .object({
    body: text,
    attentionItems: z.array(
      z.object({ priority: text, title: text, sub: text, action: forgeAction.optional() }).passthrough(),
    ),
    insights: z
      .array(z.object({ kind: text, title: text, body: text, actions: z.array(forgeAction) }).passthrough())
      .optional(),
    prompts: z.array(text),
  })
  .passthrough();

const forgeProposal = z
  .object({
    id: nonempty,
    orgId: nonempty,
    threadId: nonempty,
    proposingTurnId: nonempty,
    toolName: nonempty,
    args: z.record(z.string(), z.unknown()),
    rationale: text,
    status: z.enum(["pending", "approved", "rejected", "executed", "failed"]),
    proposedAt: nonempty,
    decidedBy: nullableText,
    decidedAt: nullableText,
    result: z.unknown(),
    error: nullableText,
  })
  .passthrough();

export const ForgeAskUpstreamSchema = z
  .object({
    forgeTurn: z.object({ render: ForgeAnswerSchema }).passthrough(),
    toolsUsed: z.array(text),
    proposals: z.array(forgeProposal),
  })
  .passthrough();

export const ForgeAskBrowserSchema = z
  .object({
    threadId: nonempty,
    answer: ForgeAnswerSchema,
    toolsUsed: z.array(text),
    proposals: z.array(forgeProposal),
  })
  .strict();

export const ForgeThreadSchema = z.object({ id: nonempty }).passthrough();
export const ForgeNarrationSchema = z.object({ render: ForgeAnswerSchema }).passthrough();
export const ForgeProposalDecisionSchema = z.object({ proposal: forgeProposal }).strict();
export const ForgeProposalConflictSchema = z
  .object({ error: z.literal("forge_proposal_already_decided"), status: nonempty })
  .strict();

export const ForgeProposalDecisionBrowserSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("decided"), proposal: forgeProposal }).strict(),
  z.object({ outcome: z.literal("already_decided"), currentStatus: nonempty }).strict(),
  z.object({ outcome: z.literal("denied") }).strict(),
  z.object({ outcome: z.literal("not_found") }).strict(),
  z.object({ outcome: z.literal("failed") }).strict(),
]);

export const SpecSummarySchema = z
  .object({
    specId: nonempty,
    projectId: nonempty,
    title: text,
    description: text,
    acceptanceCriteria: z.array(text),
    dependsOn: z.array(text),
    status: text,
  })
  .passthrough();

export const RunSummarySchema = z
  .object({
    runId: nonempty,
    specId: nonempty,
    projectId: nonempty,
    branch: nonempty,
    trigger: nonempty,
    status: z.enum(["queued", "running", "paused", "halted", "completed", "failed", "cancelled"]),
    outcome: z
      .enum([
        "ok",
        "halted",
        "escape_hatch_hit",
        "retry_budget_exhausted",
        "convergence_stalled",
        "window_exhausted",
        "window_paused",
        "awaiting_review",
        "cancelled",
        "failed",
      ])
      .nullable(),
    startedAt: nonempty,
    endedAt: nullableText,
    prUrl: nullableText,
  })
  .passthrough();

export const CreatedProjectSchema = z
  .object({
    projectId: nonempty,
    name: nonempty,
    repoUrl: text,
    defaultBranch: nullableText,
    runnerImage: nullableText,
    allocator: nullableText,
  })
  .passthrough();

export const BrownfieldLinkResultSchema = z
  .object({
    projectId: nonempty,
    repoUrl: nonempty,
    orgId: nonempty,
    detectedFiles: z.array(
      z
        .object({
          path: nonempty,
          present: z.boolean(),
          size: z.number().int().nonnegative().optional(),
          preview: text.optional(),
        })
        .strict(),
    ),
    writesPerformed: z.number().int().nonnegative(),
  })
  .passthrough();

const interviewCapture = z
  .object({
    identity: z.object({ slug: text, pitch: text, repoHint: text }).passthrough().nullable(),
    personas: z.array(z.object({ name: text, description: text, surface: text }).passthrough()),
    behaviors: z.array(z.object({ persona: text, title: text, given: text, when: text, then: text }).passthrough()),
    interfaces: z.array(z.object({ name: text, note: text }).passthrough()),
    designContract: z
      .object({
        domain: text,
        identity: text,
        intent: text,
        principles: z.array(text),
        constraints: z.array(text),
        personas: z.array(text),
        behaviors: z.array(text),
        dimensions: z.array(
          z.object({ key: text, label: text, intent: text, guidance: text, personas: z.array(text) }).passthrough(),
        ),
      })
      .passthrough()
      .nullable(),
    architecture: z.array(z.object({ layer: text, choice: text }).passthrough()),
    lifecycle: z
      .object({
        stack: text,
        bootstrap: text,
        tier1: text,
        tier2: text,
        tier3: text,
        build: text,
        deploy: text,
      })
      .passthrough()
      .nullable(),
    rulesets: z.array(text),
  })
  .passthrough();

export const InterviewRoundSchema = z
  .object({
    round: z.number().int().nonnegative(),
    totalRounds: z.number().int().positive(),
    say: text,
    suggestions: z.array(z.object({ label: text, value: text }).passthrough()),
    capture: interviewCapture,
    complete: z.boolean(),
  })
  .passthrough();

export const DeriveResultSchema = z
  .object({
    projectId: nonempty,
    projectName: nonempty,
    specIds: z.array(nonempty),
    personaIds: z.array(nonempty),
    behaviorIds: z.array(nonempty),
    milestoneIds: z.array(nonempty),
  })
  .passthrough();

const auditJob = z
  .object({
    id: nonempty,
    orgId: nonempty,
    projectId: nullableText,
    kind: z.enum(["security", "deps", "a11y", "mutation", "perf", "license", "stale_specs"]),
    name: text,
    cadence: z.enum(["nightly", "weekly", "monthly"]),
    targetWindow: text,
    answererCli: text,
    enabled: z.boolean(),
    lastRun: nullableText,
    findings: z.object({ count: z.number(), severity: z.enum(["ok", "info", "warn", "fail", "off"]), note: text }),
  })
  .passthrough();
export const AuditJobResponseSchema = z.object({ job: auditJob }).passthrough();

const proposedSpec = z
  .object({
    proposalId: nonempty,
    title: text,
    description: text,
    acceptanceCriteria: z.array(text),
    dependsOn: z.array(text),
    priority: z.enum(["P0", "P1", "P2", "tbd"]),
    estLabel: text,
  })
  .passthrough();
export const DiscoveryResultSchema = z
  .object({
    variant: z.enum(["feature", "bug", "strategic"]),
    summary: text,
    proposals: z.array(proposedSpec),
    placements: z.array(
      z
        .object({
          kind: z.enum(["slot_after", "jump_backlog", "interrupt"]),
          label: text,
          eta: text,
          sideEffects: text,
          priority: text,
          recommended: z.boolean(),
          risk: z.boolean(),
        })
        .passthrough(),
    ),
    deltas: z.array(
      z
        .object({ title: text, kind: z.enum(["add", "mod", "impact"]), count: text, deltas: z.array(text) })
        .passthrough(),
    ),
    readSummary: text,
  })
  .passthrough();
export const AcceptResultSchema = z
  .object({
    accepted: z.array(
      z
        .object({
          proposalId: nonempty,
          spec: z.object({ specId: nonempty, projectId: nonempty, title: text, status: text }).passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const reconReport = z
  .object({
    identity: z.object({ slug: text, purpose: text, inferredFrom: text }).passthrough(),
    personas: z.array(z.object({ name: text, description: text, inferredFrom: text }).passthrough()),
    behaviors: z.array(z.object({ persona: text, title: text, inferredFrom: text }).passthrough()),
    architecture: z.array(z.object({ layer: text, detail: text }).passthrough()),
    risks: z.array(z.object({ severity: z.enum(["info", "warn", "fail"]), note: text }).passthrough()),
    gaps: z.array(z.object({ id: nonempty, chapter: text, question: text, options: z.array(text) }).passthrough()),
  })
  .passthrough();
export const ReconResultSchema = z
  .object({ repoUrl: text, filesIndexed: z.number().int().nonnegative(), report: reconReport })
  .passthrough();
export const ConfigInjectionResultSchema = z
  .object({
    pullRequest: z
      .object({ number: z.number().int().positive(), url: nonempty, branch: nonempty, filesCommitted: z.array(text) })
      .passthrough(),
    files: z.array(z.object({ path: text, addedLines: z.number().int().nonnegative() }).passthrough()),
    noRunsUntilMerged: z.boolean(),
  })
  .passthrough();
export const SeedDagResultSchema = z
  .object({
    seeded: z.array(
      z
        .object({ specId: nonempty, title: text, source: z.enum(["github_issue", "agent_gap"]), origin: text })
        .passthrough(),
    ),
    duplicatesDropped: z.number().int().nonnegative(),
    fromIssues: z.number().int().nonnegative(),
    fromGaps: z.number().int().nonnegative(),
  })
  .passthrough();

export const GovernanceResultSchema = z
  .object({
    projectId: nonempty,
    governancePosture: z.enum(["strict", "open", "audit_only", "lenient"]),
    externalPushPolicy: text,
  })
  .passthrough();

export const ProjectBudgetViewSchema = z
  .object({
    ceilingUsd: z.number().nullable(),
    period: z.enum(["monthly", "quarterly", "annual", "total"]),
    spentUsd: z.number(),
    notionalUsd: z.number(),
    remainingUsd: z.number().nullable(),
    paused: z.boolean(),
    failClosed: z.enum(["unpriced_spend", "unparseable_config", "unresolvable_project_org"]).nullable().optional(),
  })
  .strict();

export const IntegrationLinkOutcomeSchema = z
  .object({
    status: nonempty,
    providerKind: nonempty,
    credentialRef: nonempty,
    capabilities: z.array(text),
    metadataKeys: z.array(text),
  })
  .strict();

export const IntegrationProvisionOutcomeSchema = z
  .object({
    status: nonempty,
    capability: text.optional(),
    providerKind: text.optional(),
    message: text.optional(),
    linkAffordance: z.object({ kind: nonempty, providerKind: nonempty, orgId: nonempty }).strict().optional(),
  })
  .passthrough();

const inboxCandidate = z
  .object({
    id: nonempty,
    sourceId: nonempty,
    orgId: nonempty,
    projectId: nullableText,
    externalId: text,
    title: text,
    body: text,
    severity: z.enum(["info", "warn", "fail"]),
    status: z.enum(["new", "triaged", "auto_routed", "accepted", "folded", "dismissed", "closed_duplicate"]),
    triage: z
      .object({
        dedupe: text,
        match: text,
        placement: text,
        verdict: z.enum(["auto_routable", "needs_call", "dedupe_close"]),
        duplicateOfSpecId: nullableText,
        discoveryVariant: z.enum(["feature", "bug", "strategic"]),
      })
      .strict()
      .nullable(),
    resolvedSpecId: nullableText,
    sourceName: text,
    sourceKind: z.enum(["issues", "errors", "system", "manual", "scheduled_audit"]),
  })
  .strict();
export const InboxCandidateResponseSchema = z.object({ candidate: inboxCandidate }).strict();

export const RecoveryActionResultSchema = z
  .object({
    ok: z.boolean(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: text.optional(),
    message: text.optional(),
  })
  .strict();

export const PatchOrgConfigResponseSchema = z
  .object({
    gated: z.boolean().optional(),
    pr: z.object({ number: z.number().int().positive(), url: nonempty }).strict().optional(),
  })
  .strict();

export function decodeWith<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
