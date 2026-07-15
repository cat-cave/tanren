import { z } from "zod";

export function decodeWith<T>(schema: z.ZodType<T>): (value: unknown) => T | undefined {
  return (value) => {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  };
}

const nonempty = z.string().min(1);
const timestamp = z.string().datetime();
const safeInteger = z.number().int().safe();
const specStatus = z.enum(["open", "in_flight", "review", "merged", "halted", "cancelled", "needs_attention"]);
const triageProvenance = z
  .object({
    parentSpecId: nonempty,
    sourceFindingIds: z.array(nonempty),
    originTriageTaskId: nonempty,
    originRunId: nonempty,
  })
  .strict();

const ProjectContractResponseSchema = z
  .object({
    projectId: nonempty,
    orgId: nonempty,
    name: nonempty,
    repoUrl: nonempty,
    defaultBranch: nonempty,
    runnerImage: nonempty,
    allocator: nonempty,
    config: z.object({ version: z.literal(1) }).passthrough(),
  })
  .strict();
export const CreatedProjectSchema = ProjectContractResponseSchema.transform(
  ({ projectId, name, repoUrl, defaultBranch, runnerImage, allocator }) => ({
    projectId,
    name,
    repoUrl,
    defaultBranch,
    runnerImage,
    allocator,
  }),
);

const SpecContractResponseSchema = z
  .object({
    specId: nonempty,
    projectId: nonempty,
    orgId: nonempty,
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()),
    dependsOn: z.array(z.string()),
    status: specStatus,
    priority: z.enum(["P0", "P1", "P2", "tbd"]),
    mode: z.enum(["specialize_seed", "from_scratch"]),
    triageProvenance: triageProvenance.optional(),
  })
  .strict();
export const SpecSummarySchema = SpecContractResponseSchema.transform(
  ({ specId, projectId, title, description, acceptanceCriteria, dependsOn, status, triageProvenance: provenance }) => ({
    specId,
    projectId,
    title,
    description,
    acceptanceCriteria,
    dependsOn,
    status,
    ...(provenance === undefined ? {} : { triageProvenance: provenance }),
  }),
);

export const QueuedRunResponseSchema = z
  .object({
    runId: nonempty,
    specId: nonempty,
    projectId: nonempty,
    orgId: nonempty,
    trigger: nonempty,
    branch: nonempty,
    status: z.literal("queued"),
    plannerTaskId: nonempty,
    plannerJobId: nonempty,
    project: ProjectContractResponseSchema,
    spec: SpecContractResponseSchema,
  })
  .strict()
  .transform(({ runId }) => ({ runId }));

const forgeTool = z.enum([
  "tanren.read_spec",
  "tanren.read_run",
  "tanren.read_events",
  "tanren.read_costs",
  "tanren.read_behaviors",
  "tanren.read_milestones",
  "tanren.read_insights",
  "repo.read_file",
  "repo.grep",
  "repo.read_issue",
  "tanren.create_spec",
  "tanren.trigger_run",
  "tanren.rerun_task",
  "tanren.acknowledge_insight",
]);
const ForgeToolCallSchema = z.object({ tool: forgeTool, args: z.record(z.string(), z.unknown()) }).strict();
const ForgeActionSchema = z.object({ label: nonempty, toolCall: ForgeToolCallSchema }).strict();
const ForgeAnswerWireSchema = z
  .object({
    body: nonempty,
    attentionItems: z.array(
      z
        .object({
          priority: z.enum(["review", "decide", "budget", "blocked", "info"]),
          title: nonempty,
          sub: z.string(),
          action: ForgeActionSchema.nullable(),
        })
        .strict(),
    ),
    insights: z.array(
      z
        .object({
          kind: z.enum(["retry_hotspot", "model_mismatch", "pace_anomaly", "stuck", "review_stall"]),
          title: nonempty,
          body: nonempty,
          actions: z.array(ForgeActionSchema),
        })
        .strict(),
    ),
    prompts: z.array(nonempty),
    proposedActions: z
      .array(z.object({ toolCall: ForgeToolCallSchema, rationale: nonempty }).strict())
      .nullable()
      .optional(),
  })
  .strict();
export const ForgeAnswerSchema = ForgeAnswerWireSchema.transform(({ body, attentionItems, insights, prompts }) => ({
  body,
  attentionItems: attentionItems.map(({ action, ...item }) => (action === null ? item : { ...item, action })),
  insights,
  prompts,
}));

const ForgeTurnSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), eventId: safeInteger }).strict(),
  z.object({ kind: z.literal("cost"), costRecordId: safeInteger }).strict(),
  z.object({ kind: z.literal("insight"), insightId: nonempty }).strict(),
  z.object({ kind: z.literal("prior_turn"), priorTurnId: nonempty }).strict(),
  z.object({ kind: z.literal("operator"), userId: nonempty }).strict(),
]);
const ForgeTurnResponseSchema = z
  .object({
    id: nonempty,
    threadId: nonempty,
    index: safeInteger.nonnegative(),
    source: ForgeTurnSourceSchema,
    audience: z.enum(["project:member", "project:admin", "org:admin", "platform:admin"]),
    authorKind: z.enum(["forge_template", "forge_llm", "operator"]),
    render: ForgeAnswerSchema,
    createdAt: timestamp,
  })
  .strict();
const ForgeThreadResponseSchema = z
  .object({
    id: nonempty,
    orgId: nonempty,
    projectId: nonempty.nullable(),
    runId: nonempty.nullable(),
    scope: z.enum(["org", "project", "run"]),
    title: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    closedAt: timestamp.nullable(),
  })
  .strict();
export const ForgeThreadIdResponseSchema = ForgeThreadResponseSchema.transform(({ id }) => ({ id }));
export const ForgeRenderResponseSchema = ForgeTurnResponseSchema.transform(({ render }) => ({ render }));

export const ForgeProposalSchema = z
  .object({
    id: nonempty,
    orgId: nonempty,
    threadId: nonempty,
    proposingTurnId: nonempty,
    toolName: nonempty,
    args: z.record(z.string(), z.unknown()),
    rationale: z.string(),
    status: z.enum(["pending", "approved", "rejected", "executed", "failed"]),
    proposedAt: timestamp,
    decidedBy: z.string().nullable(),
    decidedAt: timestamp.nullable(),
    result: z.unknown(),
    error: z.string().nullable(),
  })
  .strict();
export const ForgeAskResponseSchema = z
  .object({
    operatorTurn: ForgeTurnResponseSchema,
    forgeTurn: ForgeTurnResponseSchema,
    toolsUsed: z.array(nonempty),
    proposals: z.array(ForgeProposalSchema),
  })
  .strict()
  .transform(({ forgeTurn, toolsUsed, proposals }) => ({
    forgeTurn: { render: forgeTurn.render },
    toolsUsed,
    proposals,
  }));
export const ForgeDecisionResponseSchema = z.union([
  z
    .object({ proposal: ForgeProposalSchema, turn: ForgeTurnResponseSchema })
    .strict()
    .transform(({ proposal }) => ({ proposal })),
  z
    .object({
      error: z.literal("forge_proposal_already_decided"),
      status: z.enum(["approved", "rejected", "executed", "failed"]),
    })
    .strict()
    .transform(({ status }) => ({ status })),
]);

const AuditKindSchema = z.enum(["security", "deps", "a11y", "mutation", "perf", "license", "stale_specs"]);
const AuditCadenceSchema = z.enum(["nightly", "weekly", "monthly"]);
const AuditJobSchema = z
  .object({
    id: nonempty,
    orgId: nonempty,
    projectId: z.string().nullable(),
    kind: AuditKindSchema,
    name: z.string(),
    cadence: AuditCadenceSchema,
    targetWindow: z.string(),
    answererCli: z.string(),
    enabled: z.boolean(),
    lastRun: z.string().nullable(),
    findings: z
      .object({
        count: z.number().int().nonnegative().safe(),
        severity: z.enum(["ok", "info", "warn", "fail", "off"]),
        note: z.string(),
      })
      .strict(),
  })
  .strict();
export const AuditJobResponseSchema = z.object({ job: AuditJobSchema }).strict();

const ProposedSpecSchema = z
  .object({
    proposalId: nonempty,
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()),
    dependsOn: z.array(z.string()),
    priority: z.enum(["P0", "P1", "P2", "tbd"]),
    estLabel: z.string(),
  })
  .strict();
export const DiscoveryResultSchema = z
  .object({
    variant: z.enum(["feature", "bug", "strategic"]),
    summary: z.string(),
    proposals: z.array(ProposedSpecSchema),
    placements: z.array(
      z
        .object({
          kind: z.enum(["slot_after", "jump_backlog", "interrupt"]),
          label: z.string(),
          eta: z.string(),
          sideEffects: z.string(),
          priority: z.string(),
          recommended: z.boolean(),
          risk: z.boolean(),
        })
        .strict(),
    ),
    deltas: z.array(
      z
        .object({
          title: z.string(),
          kind: z.enum(["add", "mod", "impact"]),
          count: z.string(),
          deltas: z.array(z.string()),
        })
        .strict(),
    ),
    readSummary: z.string(),
  })
  .strict();
export const DiscoveryAcceptSchema = z
  .object({
    accepted: z.array(
      z
        .object({
          proposalId: nonempty,
          spec: SpecSummarySchema,
        })
        .strict(),
    ),
  })
  .strict()
  .transform(({ accepted }) => ({
    accepted: accepted.map(({ proposalId, spec }) => ({
      proposalId,
      spec: { specId: spec.specId, projectId: spec.projectId, title: spec.title, status: spec.status },
    })),
  }));

const CaptureSchema = z
  .object({
    identity: z.object({ slug: z.string(), pitch: z.string(), repoHint: z.string() }).strict().nullable(),
    personas: z.array(z.object({ name: z.string(), description: z.string(), surface: z.string() }).strict()),
    behaviors: z.array(
      z
        .object({
          persona: z.string(),
          title: z.string(),
          given: z.string(),
          when: z.string(),
          // eslint-disable-next-line unicorn/no-thenable -- canonical BDD wire field, not a Promise-like object.
          then: z.string(),
        })
        .strict(),
    ),
    interfaces: z.array(z.object({ name: z.string(), note: z.string() }).strict()),
    designContract: z
      .object({
        domain: z.string(),
        identity: z.string(),
        intent: z.string(),
        principles: z.array(z.string()),
        constraints: z.array(z.string()),
        personas: z.array(z.string()),
        behaviors: z.array(z.string()),
        dimensions: z.array(
          z
            .object({
              key: z.string(),
              label: z.string(),
              intent: z.string(),
              guidance: z.string(),
              personas: z.array(z.string()),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    architecture: z.array(z.object({ layer: z.string(), choice: z.string() }).strict()),
    lifecycle: z
      .object({
        stack: z.string(),
        bootstrap: z.string(),
        tier1: z.string(),
        tier2: z.string(),
        tier3: z.string(),
        build: z.string(),
        deploy: z.string(),
        upgrade: z.string(),
        toolchain: z.array(z.object({ name: z.string(), version: z.string() }).strict()),
      })
      .strict()
      .nullable(),
    lifecycleConfirmed: z.boolean(),
    rulesets: z.array(z.string()),
  })
  .strict();
export const InterviewRoundSchema = z
  .object({
    round: z.number().int().nonnegative().safe(),
    totalRounds: z.number().int().positive().safe(),
    say: z.string(),
    suggestions: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
    capture: CaptureSchema,
    complete: z.boolean(),
  })
  .strict();
const ProvisioningResultSchema = z
  .object({
    inboxSource: z.object({ id: nonempty, created: z.boolean() }).strict().optional(),
    notificationRoute: z
      .object({ targetId: nonempty, created: z.boolean(), events: safeInteger.nonnegative() })
      .strict()
      .optional(),
    auditCatalog: z
      .object({
        jobs: safeInteger.nonnegative(),
        created: z.array(z.enum(["security", "deps", "a11y", "mutation", "perf", "license", "stale_specs"])),
      })
      .strict()
      .optional(),
    errors: z.array(
      z.object({ seed: z.enum(["auditCatalog", "notificationRoute", "inbox"]), message: z.string() }).strict(),
    ),
  })
  .strict();
export const DeriveResultSchema = z
  .object({
    projectId: nonempty,
    projectName: z.string(),
    repository: z.object({ fullName: nonempty, repoUrl: nonempty, defaultBranch: nonempty }).strict(),
    specIds: z.array(nonempty),
    personaIds: z.array(nonempty),
    behaviorIds: z.array(nonempty),
    milestoneIds: z.array(nonempty),
    designContractId: nonempty.optional(),
    templateSeed: z.object({ templateRef: nonempty, validatedAt: timestamp }).strict().optional(),
    inboxSource: z.object({ id: nonempty, created: z.boolean() }).strict().optional(),
    bootstrap: ProvisioningResultSchema,
  })
  .strict()
  .transform(({ projectId, projectName, specIds, personaIds, behaviorIds, milestoneIds }) => ({
    projectId,
    projectName,
    specIds,
    personaIds,
    behaviorIds,
    milestoneIds,
  }));

const ReconReportSchema = z
  .object({
    identity: z.object({ slug: z.string(), purpose: z.string(), inferredFrom: z.string() }).strict(),
    personas: z.array(z.object({ name: z.string(), description: z.string(), inferredFrom: z.string() }).strict()),
    behaviors: z.array(z.object({ persona: z.string(), title: z.string(), inferredFrom: z.string() }).strict()),
    architecture: z.array(z.object({ layer: z.string(), detail: z.string() }).strict()),
    risks: z.array(z.object({ severity: z.enum(["info", "warn", "fail"]), note: z.string() }).strict()),
    gaps: z.array(
      z.object({ id: z.string(), chapter: z.string(), question: z.string(), options: z.array(z.string()) }).strict(),
    ),
  })
  .strict();
export const ReconResultSchema = z
  .object({ repoUrl: z.string(), filesIndexed: z.number().int().nonnegative().safe(), report: ReconReportSchema })
  .strict();
export const ConfigInjectionSchema = z
  .object({
    pullRequest: z
      .object({
        number: z.number().int().positive().safe(),
        url: z.string(),
        branch: z.string(),
        filesCommitted: z.array(z.string()),
      })
      .strict(),
    files: z.array(z.object({ path: z.string(), addedLines: z.number().int().nonnegative().safe() }).strict()),
    noRunsUntilMerged: z.boolean(),
  })
  .strict();
export const SeedDagSchema = z
  .object({
    seeded: z.array(
      z
        .object({
          specId: nonempty,
          title: z.string(),
          source: z.enum(["github_issue", "agent_gap"]),
          origin: z.string(),
        })
        .strict(),
    ),
    duplicatesDropped: z.number().int().nonnegative().safe(),
    fromIssues: z.number().int().nonnegative().safe(),
    fromGaps: z.number().int().nonnegative().safe(),
  })
  .strict();
